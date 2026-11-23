//! Windows settings from explicitly selected Pool layers. Routing acceptance
//! precedes reconciliation of these independently managed native settings.
use crate::{app_protection, capture, storage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
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
#[serde(untagged)]
enum Receipt {
    Changes { changes: Vec<Change> },
    Legacy { after: String, owned: Vec<String> },
}

#[derive(Deserialize, Serialize)]
struct Change {
    family: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct Plan {
    before: String,
    changes: Vec<Change>,
    owned: Vec<String>,
    observed: BTreeMap<String, Option<u32>>,
}

impl Journal {
    fn save(&self, path: &Path) -> Result<()> {
        if self.owned.is_empty() && self.pending.is_none() {
            storage::remove(path)
        } else {
            storage::write(path, self)
        }
    }

    fn recover(&mut self, receipt: Receipt, plan: &Plan) -> Result<Option<ApiError>> {
        match receipt {
            Receipt::Legacy { after, owned } => {
                if plan.before == after {
                    self.owned = owned;
                } else {
                    return Ok(Some(ApiError::new("LOOPBACK_CONFLICT", "An interrupted older Pool update could not verify its Loopback changes. Unverified exceptions were preserved.")));
                }
            }
            Receipt::Changes { changes } => {
                let mut conflicts = Vec::new();
                for change in changes {
                    let current = plan.observed.get(&change.family).ok_or_else(|| {
                        ApiError::new("POOL", "Missing Windows Loopback recovery observation.")
                    })?;
                    // Pool adds absent SIDs with attributes zero and removes
                    // only its own zero-attribute SIDs. Other values are external.
                    if *current == Some(0) {
                        if change.enabled && !self.owns(&change.family) {
                            self.owned.push(change.family);
                        }
                    } else {
                        self.owned
                            .retain(|family| !family.eq_ignore_ascii_case(&change.family));
                        if current.is_some() {
                            conflicts.push(change.family);
                        }
                    }
                }
                if !conflicts.is_empty() {
                    return Ok(Some(ApiError::new(
                        "LOOPBACK_CONFLICT",
                        format!("Windows changed Loopback permissions for {} during a Pool update. Those exceptions were preserved.", conflicts.join(", ")),
                    )));
                }
            }
        }
        Ok(None)
    }

    fn owns(&self, family: &str) -> bool {
        self.owned
            .iter()
            .any(|owned| owned.eq_ignore_ascii_case(family))
    }
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
        let mut plan = |owned: &[String], observe: &[&str]| -> Result<Plan> {
            serde_json::from_value(worker.call(
                "loopback.poolPlan",
                json!({
                    "ownerSid":owner, "owned":owned, "desired":desired, "observe":observe,
                }),
            )?)
            .map_err(|_| ApiError::new("POOL", "Invalid Windows Loopback plan."))
        };
        let mut conflict = None;
        if let Some(pending) = journal.pending.take() {
            let observe = match &pending {
                Receipt::Changes { changes } => changes.iter().map(|c| c.family.as_str()).collect(),
                Receipt::Legacy { .. } => Vec::new(),
            };
            let current = plan(&journal.owned, &observe)?;
            conflict = journal.recover(pending, &current)?;
            journal.save(path)?;
        }
        let change = plan(&journal.owned, &[])?;
        if !change.changes.is_empty() {
            let input = json!({
                "ownerSid":owner, "owned":journal.owned, "before":change.before,
                "changes":change.changes,
            });
            journal.pending = Some(Receipt::Changes {
                changes: change.changes,
            });
            journal.save(path)?;
            let applied = worker.call("loopback.poolApply", input)?;
            match applied.as_bool() {
                Some(true) => {}
                Some(false) => {
                    // The worker proved it never wrote. Do not adopt somebody
                    // else's change just because it matches our planned value.
                    journal.pending = None;
                    journal.save(path)?;
                    return Err(ApiError::new("LOOPBACK_CONFLICT", "Windows Loopback permissions changed before the Pool update. Wayrill will retry."));
                }
                None => {
                    return Err(ApiError::new(
                        "POOL",
                        "Invalid Windows Loopback write result.",
                    ))
                }
            }
        } else if journal.owned == change.owned {
            if journal.owned.is_empty() {
                journal.save(path)?;
            }
            return conflict.map_or(Ok(()), Err);
        }
        journal.owned = change.owned;
        journal.pending = None;
        journal.save(path)?;
        conflict.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_affected_packages_after_a_partial_or_interrupted_write() {
        let mut journal = Journal {
            owned: ["removed", "still-owned", "changed-externally"]
                .map(str::to_owned)
                .to_vec(),
            pending: None,
        };
        let changes = [
            ("added", true),
            ("not-added", true),
            ("removed", false),
            ("still-owned", false),
            ("changed-externally", false),
        ]
        .map(|(family, enabled)| Change {
            family: family.into(),
            enabled,
        });
        let plan = Plan {
            before: "unrelated-exception-changed-the-global-version".into(),
            changes: Vec::new(),
            owned: Vec::new(),
            observed: BTreeMap::from([
                ("added".into(), Some(0)),
                ("not-added".into(), None),
                ("removed".into(), None),
                ("still-owned".into(), Some(0)),
                ("changed-externally".into(), Some(1)),
            ]),
        };
        let conflict = journal
            .recover(
                Receipt::Changes {
                    changes: changes.into(),
                },
                &plan,
            )
            .unwrap()
            .unwrap();
        assert_eq!(journal.owned, ["still-owned", "added"]);
        assert_eq!(conflict.code, "LOOPBACK_CONFLICT");
        assert!(conflict.message.contains("changed-externally"));
    }
}
