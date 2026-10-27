// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    policy::{Identity, SharedPolicy, Target},
    text, Error, Result,
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ProcessKey {
    pub pid: u32,
    pub started: i64,
}
#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub key: ProcessKey,
    pub parent_pid: u32,
    pub name: String,
    pub path: Option<String>,
    pub exited: Option<i64>,
    pub sequence: u64,
    pub parent_sequence: u64,
    pub started_at: i64,
    pub exited_at: Option<i64>,
    pub package: Option<String>,
}
impl ProcessInfo {
    pub(crate) fn resident_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.name.capacity()
            + self.path.as_ref().map_or(0, String::capacity)
            + self.package.as_ref().map_or(0, String::capacity)
    }
    pub fn identity(&self) -> Identity {
        Identity::new(&self.name, self.path.as_deref(), self.package.as_deref())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Selected,
    Unselected,
    Unresolved,
    Ambiguous,
}
#[derive(Debug, Clone)]
pub struct Decision {
    pub kind: Kind,
    pub process: Option<ProcessKey>,
    pub rule: Option<Arc<Target>>,
    pub endpoint: u64,
    pub service_pending: bool,
    pub accepted: bool,
}
impl Decision {
    pub fn new(kind: Kind) -> Self {
        Self {
            kind,
            process: None,
            rule: None,
            endpoint: 0,
            service_pending: false,
            accepted: false,
        }
    }
    pub fn for_flow(&self, flow: crate::packet::Flow) -> Self {
        if self.kind != Kind::Selected {
            return self.clone();
        }
        let Some(rule) = self.rule.as_ref() else {
            return self.clone();
        };
        let mut result = self.clone();
        result.rule = rule.for_flow(flow);
        if result.rule.is_none() {
            result.kind = Kind::Unselected;
            result.service_pending = false;
            result.accepted = false;
        }
        result
    }
}
impl PartialEq for Decision {
    fn eq(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.process == other.process
            && self.endpoint == other.endpoint
            && self.service_pending == other.service_pending
            && self.accepted == other.accepted
            && match (&self.rule, &other.rule) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                _ => false,
            }
    }
}
impl Eq for Decision {}
struct Node {
    info: ProcessInfo,
    parent: Option<ProcessKey>,
    // Native absence bounds retention without fabricating an ETW exit time.
    absent_since: Option<i64>,
}
impl Node {
    fn parent_at(&self, started: i64) -> bool {
        self.info.exited.is_none_or(|exit| exit >= started)
            && self.absent_since.is_none_or(|absent| absent >= started)
    }
}
pub struct ProcessTree {
    nodes: HashMap<ProcessKey, Node>,
    excluded: HashSet<ProcessKey>,
    rules: Option<Arc<SharedPolicy>>,
}
impl ProcessTree {
    pub fn new(
        rules: Option<Arc<SharedPolicy>>,
        excluded: impl IntoIterator<Item = ProcessKey>,
    ) -> Self {
        Self {
            nodes: HashMap::new(),
            excluded: excluded.into_iter().collect(),
            rules,
        }
    }
    pub fn contains(&self, key: ProcessKey) -> bool {
        self.nodes.contains_key(&key)
    }
    pub fn is_current(&self, key: ProcessKey) -> bool {
        self.nodes
            .get(&key)
            .is_some_and(|n| n.info.exited.is_none() && n.absent_since.is_none())
    }
    pub fn processes(&self) -> impl Iterator<Item = &ProcessInfo> {
        self.nodes.values().map(|n| &n.info)
    }
    pub fn set_rules(
        &mut self,
        rules: Option<Arc<SharedPolicy>>,
        excluded: impl IntoIterator<Item = ProcessKey>,
    ) {
        self.rules = rules;
        self.excluded = excluded.into_iter().collect();
    }
    /// A complete native inventory can prove that an ETW-only process ended,
    /// even if its exit event was lost before the first polling sample. Keep
    /// recent history and ancestors of live children; do not invent exact exits
    /// or discard identities that were born during/after the native snapshot.
    pub fn reconcile_presence(
        &mut self,
        observed_at: i64,
        mut present: impl FnMut(ProcessKey) -> bool,
    ) {
        for node in self.nodes.values_mut() {
            if node.info.key.started >= observed_at {
                continue;
            }
            if present(node.info.key) {
                node.absent_since = None;
            } else if node.info.exited.is_none() {
                node.absent_since.get_or_insert(observed_at);
            }
        }
    }
    pub fn update(
        &mut self,
        snapshot: impl IntoIterator<Item = ProcessInfo>,
        now_filetime: i64,
    ) -> Result<()> {
        self.ingest(snapshot);
        self.refresh(now_filetime)
    }
    /// Merge observations before native presence is reconciled. Parent links
    /// must be rebuilt only after that complete inventory has established absence.
    pub fn ingest(&mut self, snapshot: impl IntoIterator<Item = ProcessInfo>) {
        for mut info in snapshot {
            if let Some(node) = self.nodes.get_mut(&info.key) {
                let previous = &node.info;
                if info.name.is_empty() {
                    info.parent_pid = previous.parent_pid;
                    info.name.clone_from(&previous.name);
                }
                if info.path.is_none() {
                    info.path.clone_from(&previous.path);
                }
                if info.package.as_deref().is_none_or(str::is_empty) && previous.package.is_some() {
                    info.package.clone_from(&previous.package);
                }
                info.exited = previous.exited.or(info.exited);
                if info.sequence == 0 {
                    info.sequence = previous.sequence;
                }
                if info.parent_sequence == 0 {
                    info.parent_sequence = previous.parent_sequence;
                }
                if info.started_at == 0 {
                    info.started_at = previous.started_at;
                }
                info.exited_at = match (previous.exited_at, info.exited_at) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                node.info = info;
            } else {
                self.nodes.insert(
                    info.key,
                    Node {
                        info,
                        parent: None,
                        absent_since: None,
                    },
                );
            }
        }
    }
    pub fn refresh(&mut self, now_filetime: i64) -> Result<()> {
        let mut by_pid: HashMap<u32, Vec<ProcessKey>> = HashMap::new();
        for key in self.nodes.keys() {
            by_pid.entry(key.pid).or_default().push(*key);
        }
        let keys: Vec<_> = self.nodes.keys().copied().collect();
        for key in keys {
            let node = &self.nodes[&key];
            let valid_parent = node.parent.filter(|parent| {
                self.nodes.get(parent).is_some_and(|p| {
                    parent.pid == node.info.parent_pid
                        && *parent != key
                        && parent.started <= key.started
                        && p.parent_at(key.started)
                        && (node.info.parent_sequence == 0
                            || p.info.sequence == 0
                            || p.info.sequence == node.info.parent_sequence)
                })
            });
            let parent = valid_parent.or_else(|| {
                by_pid
                    .get(&node.info.parent_pid)
                    .into_iter()
                    .flatten()
                    .copied()
                    .filter(|p| {
                        *p != key
                            && p.started <= key.started
                            && self.nodes[p].parent_at(key.started)
                            // An unknown exit is not proof of availability at a
                            // newly discovered child's birth. Preserve established
                            // edges, but never guess a new edge across PID reuse.
                            && (self.nodes[p].absent_since.is_none()
                                || self.nodes[p].info.exited.is_some()
                                || node.info.parent_sequence != 0
                                    && self.nodes[p].info.sequence == node.info.parent_sequence)
                            && (node.info.parent_sequence == 0
                                || self.nodes[p].info.sequence == 0
                                || self.nodes[p].info.sequence == node.info.parent_sequence)
                    })
                    .max_by_key(|p| p.started)
            });
            self.nodes.get_mut(&key).unwrap().parent = parent;
        }
        let mut exits: Vec<_> = self
            .nodes
            .values()
            .filter_map(|n| n.info.exited.map(|exit| (exit, n.info.key)))
            .collect();
        exits.sort_unstable_by_key(|a| std::cmp::Reverse(a.0));
        let recent = now_filetime.saturating_sub(100_000_000);
        let seeds = self
            .nodes
            .values()
            .filter(|n| {
                n.info
                    .exited
                    .or(n.absent_since)
                    .is_none_or(|exit| exit >= recent)
            })
            .map(|n| n.info.key)
            .chain(exits.iter().take(2048).map(|p| p.1));
        let mut retained = HashSet::new();
        for key in seeds {
            let mut ancestor = Some(key);
            while let Some(key) = ancestor {
                if !retained.insert(key) {
                    break;
                }
                ancestor = self.nodes.get(&key).and_then(|n| n.parent);
            }
        }
        self.nodes.retain(|key, _| retained.contains(key));
        if self.nodes.len() > 65536
            || self
                .nodes
                .values()
                .map(|node| node.info.resident_bytes())
                .sum::<usize>()
                > 64 * 1024 * 1024
        {
            return Err(Error::invalid(
                "Application-routing process history exceeded its capacity.",
            ));
        }
        Ok(())
    }
    pub fn decide(
        &self,
        key: ProcessKey,
        observed_since: i64,
        service: Option<&str>,
    ) -> Result<Decision> {
        let Some(mut node) = self.nodes.get(&key) else {
            return Ok(Decision::new(Kind::Unresolved));
        };
        let mut seen = HashSet::new();
        let mut incomplete = false;
        let mut lineage = Vec::new();
        loop {
            if !seen.insert(node.info.key) {
                return Ok(Decision::new(Kind::Unresolved));
            }
            let info = &node.info;
            if self.excluded.contains(&info.key) || text::protected(&info.name) {
                let mut decision = Decision::new(Kind::Unselected);
                decision.process = Some(key);
                return Ok(decision);
            }
            incomplete |= info.name.is_empty()
                || info.path.is_none()
                    && self
                        .rules
                        .as_ref()
                        .is_some_and(|r| r.needs_path(&info.name, info.key != key));
            if observed_since != 0 && info.key.started >= observed_since {
                // Current ownership comes from an exact native process generation.
                // A lost ETW start must not poison that identity permanently;
                // historical socket lookups separately require its QPC lifetime.
                // Missing ancestors still prevent a safe child-process decision.
                incomplete |= node.parent.is_none() && info.parent_pid > 4;
            }
            incomplete |= info.package.is_none()
                && self.rules.as_ref().is_some_and(|r| {
                    if info.key == key {
                        r.has_packages
                    } else {
                        r.packages_include_children
                    }
                });
            lineage.push(info.identity());
            match node.parent.and_then(|key| self.nodes.get(&key)) {
                Some(parent) => node = parent,
                None => break,
            }
        }
        if incomplete {
            return Ok(Decision::new(Kind::Unresolved));
        }
        let rule = self
            .rules
            .as_ref()
            .map(|r| r.select(&lineage, service))
            .transpose()?
            .flatten();
        let mut decision = Decision::new(if rule.is_some() {
            Kind::Selected
        } else {
            Kind::Unselected
        });
        decision.process = Some(key);
        decision.rule = rule;
        Ok(decision)
    }
}
