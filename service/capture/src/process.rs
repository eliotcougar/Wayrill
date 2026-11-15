// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    policy::{Identity, SharedPolicy, Target},
    text, Error, Result,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
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
#[derive(Debug, Serialize)]
struct ProcessLabel {
    name: String,
    pid: u32,
}
impl From<&ProcessInfo> for ProcessLabel {
    fn from(info: &ProcessInfo) -> Self {
        let name = text::filename(&info.name);
        Self {
            name: name
                .char_indices()
                .take_while(|(offset, c)| offset + c.len_utf8() <= 128)
                .filter_map(|(_, c)| (!c.is_control()).then_some(c))
                .collect(),
            pid: info.key.pid,
        }
    }
}
#[derive(Debug, Serialize)]
struct Witness {
    process: ProcessLabel,
    predicates: Vec<usize>,
}
#[derive(Debug, Serialize)]
pub struct ApplicationProof {
    owner: ProcessLabel,
    matches: Vec<Witness>,
}
impl ApplicationProof {
    fn new(lineage: &[&ProcessInfo], witnesses: Vec<(usize, usize)>) -> Option<Arc<Self>> {
        if witnesses.is_empty() {
            return None;
        }
        let mut matches = BTreeMap::<usize, Vec<usize>>::new();
        for (predicate, index) in witnesses {
            matches.entry(index).or_default().push(predicate);
        }
        Some(Arc::new(Self {
            owner: lineage[0].into(),
            matches: matches
                .into_iter()
                .map(|(index, predicates)| Witness {
                    process: lineage[index].into(),
                    predicates,
                })
                .collect(),
        }))
    }
}
#[derive(Debug, Clone)]
pub struct Decision {
    pub kind: Kind,
    pub process: Option<ProcessKey>,
    pub rule: Option<Arc<Target>>,
    pub endpoint: u64,
    pub service_pending: bool,
    pub accepted: bool,
    pub application_proof: Option<Arc<ApplicationProof>>,
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
            application_proof: None,
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
pub enum Presence {
    Present,
    Absent,
    Unknown,
}

struct Node {
    info: ProcessInfo,
    parent: Option<ProcessKey>,
    confirmed_alive_at: Option<i64>,
    // Native absence bounds retention without fabricating an ETW exit time.
    absent_since: Option<i64>,
}
impl Node {
    fn observe_alive(&mut self, observed_at: i64) {
        self.confirmed_alive_at = self.confirmed_alive_at.max(Some(observed_at));
        self.absent_since = None;
    }

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
        mut presence: impl FnMut(ProcessKey) -> Presence,
    ) {
        for node in self.nodes.values_mut() {
            if node.info.key.started >= observed_at || node.info.exited.is_some() {
                continue;
            }
            match presence(node.info.key) {
                Presence::Present => node.observe_alive(observed_at),
                Presence::Absent => {
                    node.absent_since.get_or_insert(observed_at);
                }
                Presence::Unknown => {}
            }
        }
    }
    pub fn confirm_alive(&mut self, key: ProcessKey, observed_at: i64) {
        if let Some(node) = self.nodes.get_mut(&key).filter(|n| n.info.exited.is_none()) {
            node.observe_alive(observed_at);
        }
    }

    /// Merge observations before native presence is reconciled. Parent links
    /// must be rebuilt only after that complete inventory has established absence.
    pub fn ingest(&mut self, snapshot: impl IntoIterator<Item = ProcessInfo>) {
        for mut info in snapshot {
            if let Some(node) = self.nodes.get_mut(&info.key) {
                let previous = &node.info;
                // Keep the parent recorded by the kernel start event when a
                // later inventory sample or exit reports the same generation.
                if info.started_at == 0 && (previous.started_at != 0 || info.name.is_empty()) {
                    info.parent_pid = previous.parent_pid;
                    info.parent_sequence = previous.parent_sequence;
                }
                if info.name.is_empty() {
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
                        confirmed_alive_at: None,
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
            let expected = node.info.parent_sequence;
            let exact = |p: &Node| expected != 0 && p.info.sequence == expected;
            let parent = by_pid
                .get(&node.info.parent_pid)
                .into_iter()
                .flatten()
                .copied()
                .filter(|p| {
                    let candidate = self.nodes[p].info.sequence;
                    *p != key
                        && if candidate != 0 && node.info.sequence != 0 {
                            // Process sequence order is independent of system-clock changes.
                            candidate < node.info.sequence
                        } else {
                            p.started <= key.started
                        }
                })
                // An exact ETW generation outranks a PID-only candidate. If
                // the newest candidate contradicts the child's evidence, an
                // older use of the same PID cannot fill the gap.
                .max_by_key(|p| (exact(&self.nodes[p]), p.started))
                .filter(|p| {
                    let parent = &self.nodes[p];
                    parent.parent_at(key.started)
                        && (exact(parent)
                            || (expected == 0 || parent.info.sequence == 0)
                                && (parent.info.exited.is_some()
                                    || parent
                                        .confirmed_alive_at
                                        .is_some_and(|at| at >= key.started)))
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
            lineage.push(info);
            match node.parent.and_then(|key| self.nodes.get(&key)) {
                Some(parent) => node = parent,
                None => break,
            }
        }
        if incomplete {
            return Ok(Decision::new(Kind::Unresolved));
        }
        let mut witnesses = Vec::new();
        let rule = self
            .rules
            .as_ref()
            .map(|r| {
                let identities = lineage
                    .iter()
                    .map(|info| info.identity())
                    .collect::<Vec<_>>();
                r.select_with_witnesses(&identities, service, &mut witnesses)
            })
            .transpose()?
            .flatten();
        let mut decision = Decision::new(if rule.is_some() {
            Kind::Selected
        } else {
            Kind::Unselected
        });
        decision.process = Some(key);
        decision.rule = rule;
        decision.application_proof = ApplicationProof::new(&lineage, witnesses);
        Ok(decision)
    }
}
