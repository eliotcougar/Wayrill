// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    process::{ProcessInfo, ProcessKey},
    text,
};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct ServiceInfo {
    pub name: String,
    pub display_name: String,
    pub pid: u32,
}
struct Host {
    key: ProcessKey,
    names: Vec<String>,
    contains_selected: bool,
}
pub struct ServiceSnapshot {
    hosts: HashMap<u32, Host>,
}
impl ServiceSnapshot {
    pub fn new<'a>(
        services: &[ServiceInfo],
        processes: impl IntoIterator<Item = &'a ProcessInfo>,
        selected: &[String],
    ) -> Self {
        let mut current: HashMap<u32, ProcessKey> = HashMap::new();
        for process in processes.into_iter().filter(|p| p.exited.is_none()) {
            let key = current.entry(process.key.pid).or_insert(process.key);
            if process.key.started > key.started {
                *key = process.key;
            }
        }
        let mut hosts: HashMap<u32, Host> = HashMap::new();
        for service in services.iter().filter(|s| s.pid > 4) {
            if let Some(key) = current.get(&service.pid) {
                let host = hosts.entry(service.pid).or_insert_with(|| Host {
                    key: *key,
                    names: Vec::new(),
                    contains_selected: false,
                });
                if !host.names.iter().any(|n| text::equal(n, &service.name)) {
                    host.names.push(service.name.clone());
                }
                host.contains_selected |= selected.iter().any(|n| text::equal(n, &service.name));
            }
        }
        Self { hosts }
    }
    pub fn has_selected_hosts(&self) -> bool {
        self.hosts.values().any(|h| h.contains_selected)
    }
    pub fn contains_selected(&self, key: ProcessKey) -> bool {
        self.hosts
            .get(&key.pid)
            .is_some_and(|h| h.key == key && h.contains_selected)
    }
    /// A cached selected-service PID must not attach its identity to a reused
    /// process ID while waiting for the next SCM inventory.
    pub fn generation_changed(&self, key: ProcessKey) -> bool {
        self.hosts
            .get(&key.pid)
            .is_some_and(|h| h.key != key && h.contains_selected)
    }
    pub fn needs_module(&self, pid: u32) -> bool {
        self.hosts
            .get(&pid)
            .is_some_and(|h| h.contains_selected && h.names.len() > 1)
    }
    pub fn resolve(&self, key: ProcessKey, module: Option<&str>) -> Option<&str> {
        let host = self.hosts.get(&key.pid).filter(|h| h.key == key)?;
        if host.names.len() == 1 {
            return Some(&host.names[0]);
        }
        host.names
            .iter()
            .find(|n| module.is_some_and(|m| text::equal(n, m)))
            .map(String::as_str)
    }
}
