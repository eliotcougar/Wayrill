// SPDX-License-Identifier: GPL-3.0-only
//! ICS checkpoint validation is pure; the service's protected journal remains
//! authoritative. Native COM operations must validate immediately before/after
//! changing one fixed adapter's sharing role.
use crate::{text, Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Role {
    pub id: String,
    pub role: i32,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Address {
    pub address: String,
    pub prefix: i32,
}
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mapping {
    pub name: String,
    pub protocol: i32,
    pub external_port: i32,
    pub internal_port: i32,
    pub target: String,
    pub target_name: String,
}
impl Mapping {
    pub fn is_private_service(&self) -> bool {
        self.external_port == self.internal_port
            && matches!(
                (self.protocol, self.external_port),
                (17, 53 | 67 | 68 | 1900) | (6, 2869)
            )
            && text::equal(&self.target_name, "localhost")
            && matches!(self.target.as_str(), "" | "0.0.0.0" | "127.0.0.1")
    }
    pub fn validate_size(&self) -> Result<()> {
        if self.name.encode_utf16().count() > 1024
            || self.target.encode_utf16().count() > 256
            || self.target_name.encode_utf16().count() > 1024
        {
            Err(Error::invalid("Sharing mapping exceeds capacity."))
        } else {
            Ok(())
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub role: Option<i32>,
    pub ipv4: Vec<Address>,
    pub dns: Vec<String>,
    pub dhcp: bool,
    #[serde(default)]
    pub has_port_mappings: bool,
    #[serde(default)]
    pub port_mappings: Vec<Mapping>,
    #[serde(default)]
    pub private_services: Vec<Mapping>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub connections: Vec<Connection>,
}
impl Snapshot {
    pub fn roles(&self) -> Vec<Role> {
        let mut roles = self
            .connections
            .iter()
            .filter_map(|c| {
                c.role.map(|role| Role {
                    id: c.id.clone(),
                    role,
                })
            })
            .collect::<Vec<_>>();
        roles.sort();
        roles
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub id: String,
    pub role: Option<i32>,
    pub expected: Vec<Role>,
    pub private: Connection,
    #[serde(default)]
    pub restore_private_services: Vec<Mapping>,
}
pub fn canonical_id(value: &str) -> Option<String> {
    let value = value
        .strip_prefix('{')
        .and_then(|v| v.strip_suffix('}'))
        .unwrap_or(value);
    crate::interfaces::guid(value)?;
    Some(value.to_ascii_lowercase())
}
impl Change {
    pub fn validate(&self) -> Result<()> {
        if canonical_id(&self.id).is_none()
            || !matches!(self.role, None | Some(0 | 1))
            || self.expected.len() > 64
            || self.expected.iter().any(|r| {
                !matches!(r.role, 0 | 1) || canonical_id(&r.id).as_deref() != Some(r.id.as_str())
            })
            || self
                .expected
                .iter()
                .enumerate()
                .any(|(i, r)| self.expected[..i].iter().any(|other| other.id == r.id))
        {
            return Err(Error::invalid("Invalid sharing transaction."));
        }
        if self.restore_private_services.len() > 64
            || self
                .restore_private_services
                .iter()
                .enumerate()
                .any(|(i, m)| {
                    !m.is_private_service() || self.restore_private_services[..i].contains(m)
                })
            || !self.restore_private_services.is_empty()
                && (self.role != Some(1)
                    || canonical_id(&self.id).as_deref() != Some(self.private.id.as_str()))
        {
            return Err(Error::invalid(
                "Invalid private sharing service restoration.",
            ));
        }
        Ok(())
    }
    fn next_roles(&self) -> Vec<Role> {
        let id = canonical_id(&self.id).unwrap_or_default();
        let mut next = self
            .expected
            .iter()
            .filter(|r| r.id != id)
            .cloned()
            .collect::<Vec<_>>();
        if let Some(role) = self.role {
            next.push(Role { id, role });
        }
        next.sort();
        next
    }
    pub fn validate_expected(&self, before: &Snapshot) -> Result<()> {
        let mut expected = self.expected.clone();
        expected.sort();
        if before.roles() != expected {
            return Err(Error::invalid("Internet sharing roles no longer match the handoff checkpoint; they were left unchanged."));
        }
        let adapter = before
            .connections
            .iter()
            .find(|c| c.id == self.private.id)
            .ok_or_else(|| Error::invalid("The private sharing adapter is unavailable."))?;
        let mut differences = Vec::new();
        if adapter.dhcp != self.private.dhcp {
            differences.push("DHCP");
        }
        if adapter.ipv4 != self.private.ipv4 {
            differences.push("IPv4 addresses");
        }
        if adapter.dns != self.private.dns {
            differences.push("DNS servers");
        }
        if adapter.private_services != self.private.private_services {
            differences.push("Windows gateway services");
        }
        if before
            .connections
            .iter()
            .any(|c| c.role.is_some() && c.has_port_mappings)
        {
            differences.push("custom port forwarding");
        }
        if !differences.is_empty() {
            return Err(Error::invalid(format!("Private sharing settings no longer match the handoff checkpoint ({}); they were left unchanged.",differences.join(", "))));
        }
        Ok(())
    }
    pub fn validate_result(&self, after: &Snapshot, check_private_services: bool) -> Result<()> {
        if after.roles() != self.next_roles() {
            return Err(Error::invalid(
                "Windows did not apply the requested sharing role.",
            ));
        }
        let id =
            canonical_id(&self.id).ok_or_else(|| Error::invalid("Invalid sharing adapter."))?;
        if id != self.private.id {
            let mut next = self.clone();
            next.expected = self.next_roles();
            next.validate_expected(after)?;
        }
        if check_private_services
            && id == self.private.id
            && self.role == Some(1)
            && after
                .connections
                .iter()
                .find(|c| c.id == id)
                .is_none_or(|c| c.private_services != self.restore_private_services)
        {
            return Err(Error::invalid(
                "Windows did not restore the private sharing services.",
            ));
        }
        Ok(())
    }
    pub fn private_transition_ready(&self, snapshot: &Snapshot) -> bool {
        let Some(adapter) = snapshot
            .connections
            .iter()
            .find(|c| c.id == self.private.id)
        else {
            return false;
        };
        if adapter.role != self.role || adapter.has_port_mappings || !adapter.dns.is_empty() {
            return false;
        }
        match self.role {
            None => adapter.dhcp && adapter.ipv4.is_empty() && adapter.private_services.is_empty(),
            Some(1) => {
                !adapter.dhcp
                    && adapter.ipv4
                        == [Address {
                            address: "192.168.137.1".into(),
                            prefix: 24,
                        }]
                    && adapter.private_services == self.restore_private_services
            }
            _ => false,
        }
    }
}
pub fn keep_address(address: std::net::Ipv4Addr, manual: bool) -> bool {
    manual || address.octets()[..2] != [169, 254]
}

/// Observe only the settling after a completed COM mutation. A COM call that is
/// still in flight has no cancellation deadline and must always be drained.
#[derive(Default)]
pub struct PrivateSettling {
    last: Option<(Connection, u64)>,
    ready_since: Option<u64>,
}
impl PrivateSettling {
    pub fn observe(&mut self, request: &Change, snapshot: &Snapshot, now: u64) -> Result<bool> {
        request.validate_result(snapshot, false)?;
        let private = snapshot
            .connections
            .iter()
            .find(|c| c.id == request.private.id)
            .ok_or_else(|| Error::invalid("The private sharing adapter is unavailable."))?;
        if self.last.as_ref().map(|(previous, _)| previous) != Some(private) {
            self.last = Some((private.clone(), now));
        }
        if request.private_transition_ready(snapshot) {
            Ok(now.saturating_sub(*self.ready_since.get_or_insert(now)) >= 250)
        } else {
            self.ready_since = None;
            if self
                .last
                .as_ref()
                .is_some_and(|(_, changed)| now.saturating_sub(*changed) >= 30_000)
            {
                return Err(Error::invalid("Windows applied the sharing role, but the private adapter's DHCP, address, DNS or gateway services stopped progressing. The sharing recovery checkpoint was retained."));
            }
            Ok(false)
        }
    }
}

/// The native COM call has no percentage or cancellation API. Track the owned
/// thread and report its actual phase while it runs, rather than inventing a
/// completion deadline. No COM interface or borrowed request crosses the STA.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    CheckSharing,
    EnablePublic,
    EnablePrivate,
    DisableSharing,
    RestoreServices,
    WaitAdapter,
    VerifySharing,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: Phase,
    pub elapsed_ms: u64,
}
pub type Report<'a> = dyn FnMut(&Progress) -> Result<()> + 'a;
pub fn track<T: Send + 'static>(
    operation: impl FnOnce(&dyn Fn(Phase)) -> Result<T> + Send + 'static,
    report: &mut Report<'_>,
) -> Result<T> {
    track_every(operation, report, std::time::Duration::from_secs(1))
}
fn track_every<T: Send + 'static>(
    operation: impl FnOnce(&dyn Fn(Phase)) -> Result<T> + Send + 'static,
    report: &mut Report<'_>,
    interval: std::time::Duration,
) -> Result<T> {
    use std::{sync::mpsc, time::Instant};
    let started = Instant::now();
    let (send, phases) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("capture-ics".into())
        .spawn(move || {
            operation(&|phase| {
                let _ = send.send(phase);
            })
        })?;
    let mut phase = Phase::CheckSharing;
    let mut reporting_error = None;
    loop {
        match phases.recv_timeout(interval) {
            Ok(next) => phase = next,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if reporting_error.is_none() {
            reporting_error = report(&Progress {
                phase,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
            .err();
        }
    }
    // Losing the observer does not authorize overlapping rollback while COM is
    // still changing Windows. Drain this operation before returning its outcome.
    let result = thread
        .join()
        .map_err(|_| Error::invalid("Internet sharing worker panicked."))?;
    if let Some(error) = reporting_error {
        return Err(error);
    }
    result
}
#[cfg(test)]
mod progress_tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };
    #[test]
    fn pending_native_work_reports_repeated_phases_until_completion() {
        let (release, wait) = std::sync::mpsc::sync_channel(1);
        let mut enabling_reports = 0;
        let mut phases = Vec::new();
        let result = track_every(
            move |report| {
                report(Phase::EnablePublic);
                wait.recv_timeout(Duration::from_secs(2))
                    .map_err(|_| Error::invalid("Sharing progress did not repeat."))?;
                report(Phase::VerifySharing);
                Ok(42)
            },
            &mut |p| {
                phases.push((p.phase, p.elapsed_ms));
                if matches!(p.phase, Phase::EnablePublic) {
                    enabling_reports += 1;
                    if enabling_reports == 2 {
                        release
                            .send(())
                            .map_err(|_| Error::invalid("Native fixture ended before progress."))?;
                    }
                }
                Ok(())
            },
            Duration::from_millis(2),
        )
        .unwrap();
        assert_eq!(result, 42);
        assert!(phases.len() > 2);
        assert!(phases.windows(2).all(|p| p[0].1 <= p[1].1));
        assert!(matches!(phases.last().unwrap().0, Phase::VerifySharing));
    }
    #[test]
    fn lost_progress_consumer_waits_for_mutation_to_finish() {
        let ended = Arc::new(AtomicBool::new(false));
        let observed = ended.clone();
        let error = track_every(
            move |report| {
                report(Phase::DisableSharing);
                std::thread::sleep(Duration::from_millis(15));
                observed.store(true, Ordering::SeqCst);
                Ok(())
            },
            &mut |_| Err(Error::invalid("observer lost")),
            Duration::from_millis(1),
        )
        .unwrap_err();
        assert!(ended.load(Ordering::SeqCst));
        assert_eq!(error.0, "observer lost");
    }
    #[test]
    fn native_error_and_panic_are_terminal_not_successful_progress() {
        let error = track(
            |_| Err::<(), _>(Error::invalid("native failed")),
            &mut |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error.0, "native failed");
        assert!(track::<()>(|_| panic!("STA fault"), &mut |_| Ok(())).is_err());
    }
}
