//! Bounded receipts for desktop mutations and diagnostic admission. They belong
//! to one service instance and can be inspected even while the kernel is busy.
use crate::routing_diagnostics::Cancellation;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use wayrill_protocol::{params, ApiError, Result};

const DIAGNOSTIC: &str = "routing.diagnosticStart";
const CAPACITY: usize = 64;

fn preparation_lifetime(method: &str) -> Duration {
    // The editor can wait up to five minutes for required DAT files before dispatch.
    Duration::from_secs(
        if matches!(
            method,
            "config.apply" | "config.applyAndStart" | "config.refreshOutbounds"
        ) {
            600
        } else {
            120
        },
    )
}

pub fn tracks_routing(method: &str) -> bool {
    matches!(
        method,
        "core.start"
            | "core.restart"
            | "core.stop"
            | "config.apply"
            | "config.applyAndStart"
            | "config.refreshOutbounds"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    method: String,
    instance_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    ticket: String,
}

enum Phase {
    Prepared(Instant),
    Queued,
    Running,
    Finished(Result<()>),
    NotSubmitted,
    Cancelled,
    Indeterminate,
}

struct Entry {
    ticket: String,
    method: String,
    phase: Phase,
    cancel: Option<Arc<Cancellation>>,
}

#[derive(Default)]
struct Book {
    entries: VecDeque<Entry>,
    current_diagnostic: Option<String>,
}

#[derive(Clone, Default)]
pub struct Receipts(Arc<Mutex<Book>>);

impl Receipts {
    pub fn prepare_routing(&self, input: Value, instance: &str) -> Result<Value> {
        let input: Prepare = params(input)?;
        if !tracks_routing(&input.method) {
            return Err(ApiError::new(
                "INVALID_PARAMS",
                "This command does not use a routing receipt.",
            ));
        }
        if input.instance_id != instance {
            return Err(ApiError::new(
                "SERVICE_INSTANCE_CHANGED",
                "The service restarted. Refresh the applied graph before trying again.",
            ));
        }
        self.prepare(&input.method)
    }

    pub fn prepare_diagnostic(&self, input: Value) -> Result<Value> {
        if input != json!({}) {
            return Err(ApiError::new(
                "INVALID_PARAMS",
                "Diagnostic preparation takes no parameters.",
            ));
        }
        self.prepare(DIAGNOSTIC)
    }

    fn prepare(&self, method: &str) -> Result<Value> {
        let ticket = crate::tun::random_id()?;
        let mut book = self.0.lock().unwrap();
        book.entries.retain(|entry| !matches!(entry.phase, Phase::Prepared(at) if at.elapsed() > preparation_lifetime(&entry.method)));
        if book.entries.len() >= CAPACITY {
            let index = book
                .entries
                .iter()
                .position(|entry| {
                    matches!(
                        entry.phase,
                        Phase::Finished(_)
                            | Phase::NotSubmitted
                            | Phase::Cancelled
                            | Phase::Indeterminate
                    ) && book.current_diagnostic.as_ref() != Some(&entry.ticket)
                })
                .ok_or_else(|| ApiError::new("BUSY", "Too many service operations are pending."))?;
            book.entries.remove(index);
        }
        book.entries.push_back(Entry {
            ticket: ticket.clone(),
            method: method.into(),
            phase: Phase::Prepared(Instant::now()),
            cancel: (method == DIAGNOSTIC).then(Arc::default),
        });
        Ok(json!({ "ticket": ticket }))
    }

    pub fn admit(&self, method: &str, input: &mut Value) -> Result<Option<Admission>> {
        if !tracks_routing(method) && method != DIAGNOSTIC {
            return Ok(None);
        }
        let Some(ticket) = input.get("ticket") else {
            return Ok(None);
        };
        let ticket = ticket
            .as_str()
            .filter(|id| valid(id))
            .ok_or_else(unavailable)?;
        let mut book = self.0.lock().unwrap();
        let entry = book
            .entries
            .iter_mut()
            .find(|entry| entry.ticket == ticket && entry.method == method)
            .ok_or_else(unavailable)?;
        match &entry.phase {
            Phase::Prepared(at) if at.elapsed() <= preparation_lifetime(method) => {
                entry.phase = Phase::Queued
            }
            Phase::Finished(Err(error)) => return Err(error.clone()),
            Phase::Cancelled => return Err(cancelled()),
            _ => return Err(unavailable()),
        }
        let ticket = ticket.to_owned();
        if method != DIAGNOSTIC {
            input.as_object_mut().unwrap().remove("ticket");
        }
        Ok(Some(Admission {
            receipts: self.clone(),
            ticket,
        }))
    }

    pub fn check_prepared_routing(&self, ticket: &str) -> Result<()> {
        let book = self.0.lock().unwrap();
        let entry = book
            .entries
            .iter()
            .find(|entry| entry.ticket == ticket && tracks_routing(&entry.method))
            .ok_or_else(unavailable)?;
        match &entry.phase {
            Phase::Prepared(at) if at.elapsed() <= preparation_lifetime(&entry.method) => Ok(()),
            Phase::Finished(Err(error)) => Err(error.clone()),
            _ => Err(unavailable()),
        }
    }

    pub fn get_routing(&self, input: Value) -> Result<Value> {
        let query: Query = params(input)?;
        let mut book = self.0.lock().unwrap();
        let entry = book
            .entries
            .iter_mut()
            .find(|entry| entry.ticket == query.ticket && tracks_routing(&entry.method));
        Ok(match entry {
            Some(entry) => match &entry.phase {
                Phase::Prepared(_) => {
                    // Close the ticket before reporting that it was never used.
                    // A late pipe request with this ID cannot run afterwards.
                    entry.phase = Phase::NotSubmitted;
                    json!({"state":"notSubmitted"})
                }
                Phase::NotSubmitted | Phase::Cancelled => json!({"state":"notSubmitted"}),
                Phase::Queued | Phase::Running => json!({"state":"pending"}),
                Phase::Finished(Ok(())) => json!({"state":"succeeded"}),
                Phase::Finished(Err(error)) => json!({"state":"failed","error":error}),
                Phase::Indeterminate => json!({"state":"unavailable"}),
            },
            None => json!({"state":"unavailable"}),
        })
    }

    /// A diagnostic with an acknowledged start is read from its worker. Before
    /// that, its ticket is enough to check or cancel admission without the kernel.
    pub fn diagnostic(&self, method: &str, input: &Value) -> Result<Option<Value>> {
        if input.get("ticket").is_none() {
            return Ok(None);
        }
        let query: Query = params(input.clone())?;
        let mut book = self.0.lock().unwrap();
        let entry = book
            .entries
            .iter_mut()
            .find(|entry| entry.ticket == query.ticket && entry.method == DIAGNOSTIC)
            .ok_or_else(unavailable)?;
        if method == "routing.diagnosticCancel" {
            if matches!(entry.phase, Phase::Prepared(_) | Phase::Queued) {
                entry.phase = Phase::Cancelled;
            } else if matches!(entry.phase, Phase::Running | Phase::Finished(Ok(()))) {
                entry.cancel.as_ref().unwrap().cancel();
            }
            return Ok(Some(Value::Null));
        }
        match &entry.phase {
            Phase::Prepared(_) => {
                entry.phase = Phase::NotSubmitted;
                Err(diagnostic_not_started())
            }
            Phase::NotSubmitted => Err(diagnostic_not_started()),
            Phase::Cancelled => Ok(Some(json!({"busy":false,"cancelled":true}))),
            Phase::Queued | Phase::Running => Ok(Some(json!({"busy":true}))),
            Phase::Finished(Err(error)) => Err(error.clone()),
            Phase::Finished(Ok(())) => Ok(None),
            Phase::Indeterminate => Err(unavailable()),
        }
    }

    pub fn diagnostic_stop(&self, ticket: &str) -> Result<Arc<Cancellation>> {
        self.0
            .lock()
            .unwrap()
            .entries
            .iter()
            .find(|entry| entry.ticket == ticket && matches!(entry.phase, Phase::Running))
            .and_then(|entry| entry.cancel.clone())
            .ok_or_else(unavailable)
    }

    /// Called under the routing lock immediately before an explicit Stop.
    /// Earlier commands that never acquired that lock must not restart routing.
    pub fn stop_pending_routing(&self) {
        for entry in &mut self.0.lock().unwrap().entries {
            if tracks_routing(&entry.method)
                && matches!(entry.phase, Phase::Prepared(_) | Phase::Queued)
            {
                entry.phase = Phase::Finished(Err(ApiError::new(
                    "COMMAND_SUPERSEDED",
                    "Stop superseded this routing command.",
                )));
            }
        }
    }
}

fn valid(ticket: &str) -> bool {
    ticket.len() == 32 && ticket.bytes().all(|b| b.is_ascii_hexdigit())
}

fn unavailable() -> ApiError {
    ApiError::new(
        "OPERATION_TICKET_UNAVAILABLE",
        "This service operation ticket is unavailable.",
    )
}

fn cancelled() -> ApiError {
    ApiError::new("CANCELLED", "The diagnostic was cancelled.")
}

fn diagnostic_not_started() -> ApiError {
    ApiError::new(
        "DIAGNOSTIC_NOT_STARTED",
        "The diagnostic did not reach the service. Run it again.",
    )
}

pub struct Admission {
    receipts: Receipts,
    ticket: String,
}

impl Admission {
    pub fn begin(&self) -> Result<()> {
        let mut book = self.receipts.0.lock().unwrap();
        let entry = book
            .entries
            .iter_mut()
            .find(|entry| entry.ticket == self.ticket)
            .ok_or_else(unavailable)?;
        match &entry.phase {
            Phase::Queued => {
                entry.phase = Phase::Running;
                Ok(())
            }
            Phase::Finished(Err(error)) => Err(error.clone()),
            Phase::Cancelled => Err(cancelled()),
            _ => Err(unavailable()),
        }
    }

    pub fn finish(&self, result: Result<()>) {
        let mut book = self.receipts.0.lock().unwrap();
        if let Some(entry) = book
            .entries
            .iter_mut()
            .find(|entry| entry.ticket == self.ticket)
        {
            if matches!(entry.phase, Phase::Queued | Phase::Running) {
                let accepted_diagnostic = entry.method == DIAGNOSTIC && result.is_ok();
                entry.phase = Phase::Finished(result);
                if accepted_diagnostic {
                    book.current_diagnostic = Some(self.ticket.clone());
                }
            }
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut book = self.receipts.0.lock().unwrap();
        if let Some(entry) = book
            .entries
            .iter_mut()
            .find(|entry| entry.ticket == self.ticket)
        {
            if matches!(entry.phase, Phase::Queued | Phase::Running) {
                entry.phase = Phase::Indeterminate;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_proves_completion_and_closes_unused_tickets_before_reporting() {
        let receipts = Receipts::default();
        let method = "core.restart";
        let input = receipts.prepare(method).unwrap();
        let mut payload = input.clone();
        let admission = receipts.admit(method, &mut payload).unwrap().unwrap();
        assert_eq!(payload, json!({}));
        assert_eq!(
            receipts.get_routing(input.clone()).unwrap()["state"],
            "pending"
        );
        admission.begin().unwrap();
        admission.finish(Ok(()));
        drop(admission);
        assert_eq!(
            receipts.get_routing(input.clone()).unwrap()["state"],
            "succeeded"
        );
        assert!(receipts.admit(method, &mut input.clone()).is_err());

        let unused = receipts.prepare(method).unwrap();
        assert_eq!(
            receipts.get_routing(unused.clone()).unwrap()["state"],
            "notSubmitted"
        );
        assert!(receipts.admit(method, &mut unused.clone()).is_err());
        assert_eq!(
            Receipts::default().get_routing(input).unwrap()["state"],
            "unavailable"
        );
    }

    #[test]
    fn explicit_stop_prevents_queued_restart_but_does_not_cancel_a_diagnostic() {
        let receipts = Receipts::default();
        let mut preparing_apply = receipts.prepare("config.applyAndStart").unwrap();
        let apply_ticket = preparing_apply["ticket"].as_str().unwrap();
        receipts.check_prepared_routing(apply_ticket).unwrap();
        let mut restart = receipts.prepare("core.restart").unwrap();
        let work = receipts
            .admit("core.restart", &mut restart)
            .unwrap()
            .unwrap();
        let mut diagnostic = receipts.prepare(DIAGNOSTIC).unwrap();
        let probe = receipts
            .admit(DIAGNOSTIC, &mut diagnostic)
            .unwrap()
            .unwrap();
        receipts.stop_pending_routing();
        assert_eq!(
            receipts
                .check_prepared_routing(apply_ticket)
                .unwrap_err()
                .code,
            "COMMAND_SUPERSEDED"
        );
        assert!(matches!(
            receipts.admit("config.applyAndStart", &mut preparing_apply),
            Err(error) if error.code == "COMMAND_SUPERSEDED"
        ));
        assert_eq!(work.begin().unwrap_err().code, "COMMAND_SUPERSEDED");
        probe.begin().unwrap();
    }

    #[test]
    fn diagnostics_cancel_before_admission_and_after_start_without_the_start_reply() {
        let receipts = Receipts::default();
        let mut not_admitted = receipts.prepare(DIAGNOSTIC).unwrap();
        receipts
            .diagnostic("routing.diagnosticCancel", &not_admitted)
            .unwrap();
        assert!(
            matches!(receipts.admit(DIAGNOSTIC, &mut not_admitted), Err(error) if error.code == "CANCELLED")
        );

        let mut delayed = receipts.prepare(DIAGNOSTIC).unwrap();
        let queued = receipts.admit(DIAGNOSTIC, &mut delayed).unwrap().unwrap();
        receipts
            .diagnostic("routing.diagnosticCancel", &delayed)
            .unwrap();
        assert_eq!(queued.begin().unwrap_err().code, "CANCELLED");

        let mut started = receipts.prepare(DIAGNOSTIC).unwrap();
        let admitted = receipts.admit(DIAGNOSTIC, &mut started).unwrap().unwrap();
        admitted.begin().unwrap();
        let stop = receipts
            .diagnostic_stop(started["ticket"].as_str().unwrap())
            .unwrap();
        admitted.finish(Ok(()));
        drop(admitted);
        assert!(receipts
            .diagnostic("routing.diagnosticGet", &started)
            .unwrap()
            .is_none());
        receipts
            .diagnostic("routing.diagnosticCancel", &started)
            .unwrap();
        assert_eq!(stop.check().unwrap_err().code, "CANCELLED");
    }
}
