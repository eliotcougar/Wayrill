// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    process::{Decision, Kind, ProcessInfo, ProcessKey, ProcessTree},
    services::ServiceSnapshot,
    Result,
};
use std::collections::HashMap;
/// Generation-aware decisions are computed while building immutable ownership
/// snapshots. Packet lookups never read process images or enumerate services.
pub struct ProcessDecisions<'a> {
    tree: &'a ProcessTree,
    services: Option<&'a ServiceSnapshot>,
    by_pid: HashMap<u32, Vec<&'a ProcessInfo>>,
    cache: HashMap<(ProcessKey, Option<&'a str>), Decision>,
    observed_since: i64,
}
impl<'a> ProcessDecisions<'a> {
    pub fn new(
        tree: &'a ProcessTree,
        observed_since: i64,
        services: Option<&'a ServiceSnapshot>,
    ) -> Self {
        let mut by_pid: HashMap<u32, Vec<_>> = HashMap::new();
        for process in tree.processes() {
            by_pid.entry(process.key.pid).or_default().push(process);
        }
        for owners in by_pid.values_mut() {
            owners.sort_by_key(|p| std::cmp::Reverse(p.key.started));
        }
        Self {
            tree,
            services,
            by_pid,
            cache: HashMap::new(),
            observed_since,
        }
    }
    pub fn owner_at(&self, pid: u32, timestamp: i64) -> Option<&'a ProcessInfo> {
        let candidates = self.by_pid.get(&pid)?;
        if self.observed_since != 0
            && candidates
                .iter()
                .any(|p| p.key.started >= self.observed_since && p.started_at == 0)
        {
            return None;
        }
        candidates
            .iter()
            .copied()
            .find(|p| p.started_at <= timestamp && p.exited_at.is_none_or(|end| end >= timestamp))
    }
    fn decide(&mut self, owner: &ProcessInfo, module: Option<&str>) -> Result<Decision> {
        let selected = self
            .services
            .is_some_and(|s| s.contains_selected(owner.key));
        let service = if selected {
            self.services.and_then(|s| s.resolve(owner.key, module))
        } else {
            None
        };
        let key = (owner.key, service);
        if let Some(decision) = self.cache.get(&key) {
            return Ok(decision.clone());
        }
        let decision = if selected && service.is_none()
            || self
                .services
                .is_some_and(|s| s.generation_changed(owner.key))
        {
            let mut decision = Decision::new(Kind::Unresolved);
            decision.process = Some(owner.key);
            decision.service_pending = true;
            decision
        } else {
            self.tree.decide(owner.key, self.observed_since, service)?
        };
        self.cache.insert(key, decision.clone());
        Ok(decision)
    }
    pub fn at(&mut self, pid: u32, timestamp: i64, module: Option<&str>) -> Result<Decision> {
        match self.owner_at(pid, timestamp) {
            Some(owner) => self.decide(owner, module),
            None => Ok(Decision::new(Kind::Unresolved)),
        }
    }
    pub fn current(&mut self, pid: u32, module: Option<&str>) -> Result<Decision> {
        match self
            .by_pid
            .get(&pid)
            .and_then(|owners| owners.first())
            .copied()
            .filter(|p| self.tree.is_current(p.key))
        {
            Some(owner) => self.decide(owner, module),
            None => Ok(Decision::new(Kind::Unresolved)),
        }
    }
}
