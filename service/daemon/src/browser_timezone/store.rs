//! Durable timezone intent. Reconciliation reads immutable snapshots; failed
//! writes never publish an activation revision. The manager serializes access.
use super::{identity, off};
use crate::storage;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use wayrill_protocol::{companion::Policy, ApiError, Result};

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Record {
    pub path: String,
    pub revision: u64,
    pub policy: Policy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(default)]
    pub startup: bool,
    #[serde(default)]
    pub hidden: bool,
}
impl Record {
    pub fn new(path: String, package: Option<String>) -> Self {
        Self {
            path,
            revision: 0,
            policy: off(),
            package,
            startup: false,
            hidden: false,
        }
    }
}
pub(super) type Records = BTreeMap<String, Record>;
pub(super) struct Store {
    path: PathBuf,
    records: Option<Arc<Records>>,
}
impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            records: None,
        }
    }
    pub fn snapshot(&mut self) -> Result<Arc<Records>> {
        if let Some(records) = &self.records {
            return Ok(records.clone());
        }
        let saved: Records = storage::read(&self.path)?.unwrap_or_default();
        let mut records: Records = BTreeMap::new();
        for record in saved.into_values() {
            // Normalize older version-specific keys without losing their saved
            // intent or revision. If versions had separate settings, latest wins.
            let id = record.package.as_ref().map_or_else(
                || identity(&record.path),
                |family| format!("package:{family}"),
            );
            if records
                .get(&id)
                .is_none_or(|r| r.revision < record.revision)
            {
                records.insert(id, record);
            }
        }
        let records = Arc::new(records);
        self.records = Some(records.clone());
        Ok(records)
    }
    pub fn change(
        &mut self,
        id: String,
        expected: Option<u64>,
        initial: Option<Record>,
        edit: impl FnOnce(&mut Record) -> bool,
    ) -> Result<Arc<Records>> {
        let current = self.snapshot()?;
        let existing = current.get(&id);
        if expected.is_some_and(|r| r != existing.map_or(0, |r| r.revision)) {
            return Err(ApiError::new(
                "CONFIG_CHANGED",
                "Application timezone changed. Refresh and try again.",
            ));
        }
        let mut record = existing.cloned().or(initial).ok_or_else(|| {
            ApiError::new(
                "CONFIG_CHANGED",
                "This application is no longer configured.",
            )
        })?;
        if existing.is_none() && current.len() >= 256 {
            return Err(ApiError::new("LIMIT", "Too many configured applications."));
        }
        if !edit(&mut record) && existing.is_some() {
            return Ok(current);
        }
        record.revision = current
            .values()
            .map(|r| r.revision)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| ApiError::new("LIMIT", "Timezone revision exhausted."))?;
        let mut next = (*current).clone();
        next.insert(id, record);
        storage::write(&self.path, &next)?;
        let next = Arc::new(next);
        self.records = Some(next.clone());
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_commit_keeps_the_last_durable_snapshot_and_revision() {
        let folder = std::env::temp_dir().join(format!(
            "wayrill-timezone-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("policies.json");
        let mut store = Store::new(path.clone());
        let id = identity(r"C:\Apps\Reader.exe");
        store
            .change(
                id.clone(),
                Some(0),
                Some(Record::new(r"C:\Apps\Reader.exe".into(), None)),
                |_| true,
            )
            .unwrap();
        let before = store.snapshot().unwrap();
        // An ordinary filesystem failure, without modifying host settings or
        // relying on the test account's Administrator permissions.
        std::fs::create_dir(path.with_extension("tmp")).unwrap();
        let enable = |r: &mut Record| {
            r.policy = Policy {
                mode: "manual".into(),
                zone: "Asia/Tokyo".into(),
                ..Policy::default()
            };
            true
        };
        assert!(store.change(id.clone(), Some(1), None, enable).is_err());
        assert_eq!(store.snapshot().unwrap()[&id].revision, 1);
        assert_eq!(store.snapshot().unwrap()[&id].policy.mode, "off");
        let disk: Records = storage::read(&path).unwrap().unwrap();
        assert_eq!(disk[&id].revision, 1);
        // Re-adding an unchanged item does not depend on another disk write.
        store.change(id.clone(), None, None, |_| false).unwrap();
        std::fs::remove_dir(path.with_extension("tmp")).unwrap();
        let committed = store.change(id.clone(), Some(1), None, enable).unwrap();
        let recovered = Store::new(path.clone()).snapshot().unwrap();
        assert_eq!(recovered[&id].revision, 2);
        assert_eq!(recovered[&id].policy.zone, "Asia/Tokyo");
        assert_eq!(before[&id].policy.mode, "off");
        store
            .change(id.clone(), Some(2), None, |record| {
                record.policy = off();
                true
            })
            .unwrap();
        assert_eq!(committed[&id].revision, 2);
        assert_eq!(committed[&id].policy.zone, "Asia/Tokyo");
        assert_eq!(
            store.change(id, Some(1), None, enable).err().unwrap().code,
            "CONFIG_CHANGED"
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(folder).unwrap();
    }
}
