//! Windows settings from explicitly selected Pool layers. Routing acceptance
//! precedes reconciliation of these independently managed native settings.
use crate::{app_protection, capture, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};

#[derive(Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub loopback: Vec<String>,
    pub protection: app_protection::Config,
}

impl Settings {
    pub fn is_empty(&self) -> bool {
        !self.protection.enabled && self.loopback.is_empty()
    }

    pub fn validate(&mut self) -> Result<()> {
        if self.loopback.len() > 256 || !self.loopback.iter().all(|family| package_family(family)) {
            return Err(ApiError::new("POOL", "Invalid Loopback package families."));
        }
        self.loopback
            .iter_mut()
            .for_each(|family| family.make_ascii_lowercase());
        self.loopback.sort_unstable();
        self.loopback.dedup();
        self.protection.validate()
    }
}

fn package_family(family: &str) -> bool {
    family.split_once('_').is_some_and(|(name, publisher)| {
        (3..=50).contains(&name.len())
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
            && publisher.len() == 13
            && publisher.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

#[derive(Default, Deserialize, Serialize)]
struct Journal {
    owned: Vec<String>,
    pending: Option<Receipt>,
}

#[derive(Deserialize, Serialize)]
struct Receipt {
    after: String,
    owned: Vec<String>,
}

#[derive(Deserialize)]
struct Plan {
    before: String,
    after: String,
    changes: Vec<Value>,
    owned: Vec<String>,
}

pub struct Loopback {
    path: PathBuf,
    attribution: PathBuf,
    desired: Vec<String>,
    next_check: Option<Instant>,
    active: Option<JoinHandle<Result<()>>>,
    idle: bool,
}

impl Loopback {
    pub fn new(path: PathBuf, attribution: PathBuf) -> Self {
        Self {
            path,
            attribution,
            desired: Vec::new(),
            next_check: None,
            active: None,
            idle: false,
        }
    }

    pub fn busy(&self) -> bool {
        self.active.as_ref().is_some_and(|job| !job.is_finished())
    }

    pub fn reconcile(
        &mut self,
        desired: Vec<String>,
        owner: &str,
        now: Instant,
    ) -> Option<Result<()>> {
        if self.busy() {
            return None;
        }
        if let Some(job) = self.active.take() {
            let result = job.join().unwrap_or_else(|_| {
                Err(ApiError::new(
                    "POOL",
                    "The Loopback settings job ended unexpectedly.",
                ))
            });
            self.idle = result.is_ok() && self.desired.is_empty();
            return Some(result);
        }
        let changed = self.desired != desired;
        if !changed && (self.idle || self.next_check.is_some_and(|time| now < time)) {
            return None;
        }
        self.desired = desired;
        self.idle = false;
        self.next_check = Some(now + Duration::from_secs(60));
        let (path, attribution, desired, owner) = (
            self.path.clone(),
            self.attribution.clone(),
            self.desired.clone(),
            owner.to_owned(),
        );
        match thread::Builder::new()
            .name("pool-loopback".into())
            .spawn(move || Self::apply(&path, &attribution, &desired, &owner))
        {
            Ok(job) => {
                self.active = Some(job);
                None
            }
            Err(error) => Some(Err(ApiError::io("Start Pool Loopback job", error))),
        }
    }

    fn apply(path: &Path, attribution: &Path, desired: &[String], owner: &str) -> Result<()> {
        let saved = storage::read::<Journal>(path)?;
        if saved.is_none() && desired.is_empty() {
            return Ok(());
        }
        let mut journal = saved.unwrap_or_default();
        let mut worker = capture::Worker::spawn_attribution(attribution)?;
        let mut plan = |owned: &[String]| -> Result<Plan> {
            serde_json::from_value(worker.call(
                "loopback.poolPlan",
                json!({
                    "ownerSid":owner, "owned":owned, "desired":desired,
                }),
            )?)
            .map_err(|_| ApiError::new("POOL", "Invalid Windows Loopback plan."))
        };
        let mut change = plan(&journal.owned)?;
        if let Some(pending) = journal.pending.take() {
            // Only adopt newly introduced exceptions when the native state
            // confirms the interrupted write. Preserve unrelated permissions.
            if change.before == pending.after {
                journal.owned = pending.owned;
                change = plan(&journal.owned)?;
            }
            storage::write(path, &journal)?;
        }
        if !change.changes.is_empty() {
            journal.pending = Some(Receipt {
                after: change.after,
                owned: change.owned.clone(),
            });
            storage::write(path, &journal)?;
            worker.call(
                "loopback.poolApply",
                json!({
                    "ownerSid":owner, "owned":journal.owned, "before":change.before,
                    "changes":change.changes,
                }),
            )?;
        } else if journal.owned == change.owned {
            if journal.owned.is_empty() {
                storage::remove(path)?;
            }
            return Ok(());
        }
        journal.owned = change.owned;
        journal.pending = None;
        if journal.owned.is_empty() {
            storage::remove(path)?;
        } else {
            storage::write(path, &journal)?;
        }
        Ok(())
    }
}
