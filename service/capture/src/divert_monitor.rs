// SPDX-License-Identifier: GPL-3.0-only
use crate::{address::DivertAddress, Error, Result};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandleInfo {
    pub timestamp: i64,
    pub pid: u32,
    pub layer: i32,
    pub flags: u64,
    pub priority: i16,
}
impl HandleInfo {
    pub fn from_address(address: DivertAddress) -> Self {
        Self {
            timestamp: address.reflect_timestamp(),
            pid: address.reflect_pid(),
            layer: address.reflect_layer(),
            flags: address.reflect_flags(),
            priority: address.reflect_priority(),
        }
    }
    pub fn is_foreign(
        &self,
        own_pid: u32,
        owned_capture_pid: Option<u32>,
        service_pid: Option<u32>,
    ) -> bool {
        self.pid != own_pid
            && Some(self.pid) != owned_capture_pid
            && Some(self.pid) != service_pid
            && self.layer != 4
    }
}
/// A close observed by the live reader cannot be undone by an older initial
/// snapshot. Limits are fatal observation failures, never truncated inventories.
pub struct HandleSnapshot {
    pub handles: HashMap<(i64, u32), HandleInfo>,
    initial_changes: Option<HashSet<(i64, u32)>>,
}
impl Default for HandleSnapshot {
    fn default() -> Self {
        Self {
            handles: HashMap::new(),
            initial_changes: Some(HashSet::new()),
        }
    }
}
impl HandleSnapshot {
    pub fn observe(&mut self, handle: HandleInfo, opened: bool) -> Result<()> {
        let key = (handle.timestamp, handle.pid);
        if let Some(changes) = self.initial_changes.as_mut() {
            if changes.len() >= 8192 && !changes.contains(&key) {
                return Err(Error::invalid(
                    "WinDivert initial observation limit exceeded.",
                ));
            }
            changes.insert(key);
        }
        if !opened {
            self.handles.remove(&key);
            return Ok(());
        }
        self.add(handle)
    }
    fn add(&mut self, handle: HandleInfo) -> Result<()> {
        let key = (handle.timestamp, handle.pid);
        if self.handles.len() >= 4096 && !self.handles.contains_key(&key) {
            return Err(Error::invalid(
                "WinDivert handle observation limit exceeded.",
            ));
        }
        self.handles.insert(key, handle);
        Ok(())
    }
    pub fn merge_initial(&mut self, snapshot: impl IntoIterator<Item = HandleInfo>) -> Result<()> {
        for handle in snapshot {
            if !self
                .initial_changes
                .as_ref()
                .is_some_and(|changes| changes.contains(&(handle.timestamp, handle.pid)))
            {
                self.add(handle)?;
            }
        }
        self.initial_changes = None;
        Ok(())
    }
    pub fn foreign(
        &self,
        own_pid: u32,
        owned_capture_pid: Option<u32>,
        service_pid: Option<u32>,
    ) -> Option<&HandleInfo> {
        self.handles
            .values()
            .filter(|h| h.is_foreign(own_pid, owned_capture_pid, service_pid))
            .min_by_key(|h| (h.pid, h.timestamp))
    }
}
