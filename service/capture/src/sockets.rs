// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    address::{Address, DivertAddress},
    attribution::merge,
    packet::Flow,
    process::{Decision, Kind},
    Error, Result,
};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketEvent {
    pub event: u8,
    pub timestamp: i64,
    pub endpoint: u64,
    pub pid: u32,
    pub flow: Flow,
}
impl SocketEvent {
    pub fn from_address(address: DivertAddress) -> Result<Self> {
        if address.process_id() > i32::MAX as u32 {
            return Err(Error::invalid("Socket process ID overflow."));
        }
        Ok(Self {
            event: address.event(),
            timestamp: address.timestamp,
            endpoint: address.endpoint(),
            pid: address.process_id(),
            flow: Flow {
                protocol: address.protocol(),
                local: address.socket_address(false),
                remote: address.socket_address(true),
                local_port: address.local_port(),
                remote_port: address.remote_port(),
            },
        })
    }
}
#[derive(Debug, Clone)]
pub struct Entry {
    pub open: SocketEvent,
    pub closed: Option<i64>,
    pub missing_since: Option<i64>,
}
pub struct SocketHistory {
    endpoints: HashMap<u64, Vec<Entry>>,
    retention: i64,
}
impl SocketHistory {
    pub fn new(retention: i64) -> Self {
        Self {
            endpoints: HashMap::new(),
            retention,
        }
    }
    pub fn count(&self) -> usize {
        self.endpoints.values().map(Vec::len).sum()
    }
    pub fn update(
        &mut self,
        mut events: Vec<SocketEvent>,
        now: i64,
        process_exit: &dyn Fn(u32, i64) -> Option<i64>,
        is_present: Option<&dyn Fn(&SocketEvent) -> bool>,
    ) -> Result<()> {
        events.sort_by_key(|e| e.timestamp);
        for item in events {
            let entries = self.endpoints.entry(item.endpoint).or_default();
            if item.event == 7 {
                let timestamp = item.timestamp;
                entries.push(Entry {
                    open: item,
                    closed: Some(timestamp),
                    missing_since: None,
                });
                for entry in entries {
                    if entry.open.timestamp <= timestamp
                        && entry.closed.is_none_or(|closed| closed > timestamp)
                    {
                        entry.closed = Some(timestamp);
                    }
                }
            } else {
                if entries.iter().any(|e| covers(e, &item, process_exit)) {
                    continue;
                }
                let closed = entries
                    .iter()
                    .filter_map(|e| e.closed)
                    .filter(|closed| *closed >= item.timestamp)
                    .min();
                entries.push(Entry {
                    open: item,
                    closed,
                    missing_since: None,
                });
            }
        }
        for entries in self.endpoints.values_mut() {
            for entry in entries.iter_mut() {
                if let Some(exited) = process_exit(entry.open.pid, entry.open.timestamp) {
                    if entry.closed.is_none_or(|closed| exited < closed) {
                        entry.closed = Some(exited);
                    }
                }
                if entry.closed.is_none() {
                    if let Some(present) = is_present {
                        entry.missing_since = if present(&entry.open) {
                            None
                        } else {
                            Some(entry.missing_since.unwrap_or(now))
                        };
                        if entry
                            .missing_since
                            .is_some_and(|since| now.saturating_sub(since) > self.retention)
                        {
                            entry.closed = entry.missing_since;
                        }
                    }
                }
            }
            let oldest = now.saturating_sub(self.retention);
            entries.retain(|e| e.closed.is_none_or(|closed| closed >= oldest));
        }
        self.endpoints.retain(|_, entries| !entries.is_empty());
        if self.count() > 65536 {
            return Err(Error::invalid(format!("Application-routing socket history exceeded its capacity ({} records in {} endpoints).",self.count(),self.endpoints.len())));
        }
        Ok(())
    }
    pub fn snapshot(
        &self,
        decide: impl FnMut(u32, i64) -> Result<Decision>,
    ) -> Result<SocketSnapshot> {
        SocketSnapshot::new(self.endpoints.values().flatten().cloned(), decide)
    }
}
fn covers(
    entry: &Entry,
    item: &SocketEvent,
    process_exit: &dyn Fn(u32, i64) -> Option<i64>,
) -> bool {
    let open = &entry.open;
    if open.pid != item.pid
        || open.timestamp > item.timestamp
        || entry.closed.is_some_and(|closed| closed < item.timestamp)
        || process_exit(open.pid, open.timestamp).is_some_and(|exit| exit < item.timestamp)
    {
        return false;
    }
    open.event == item.event && open.flow == item.flow
        || open.event == 3
            && open.flow.protocol == 17
            && item.flow.protocol == 17
            && open.flow.remote_port == 0
            && open.flow.local_port == item.flow.local_port
            && matches_address(open.flow.local, item.flow.local)
}
pub fn matches_address(socket: Address, packet: Address) -> bool {
    socket.ip.is_ipv6() == packet.ip.is_ipv6()
        && (socket.ip.is_unspecified() && socket.scope == 0
            || socket == packet
            || packet.ip.is_ipv6() && packet.scope != 0 && socket.ip == packet.ip)
}
struct Owner {
    entry: Entry,
    decision: Decision,
}
pub struct SocketSnapshot {
    ports: HashMap<(u8, u16), Vec<Owner>>,
}
impl SocketSnapshot {
    pub fn new(
        entries: impl IntoIterator<Item = Entry>,
        mut decide: impl FnMut(u32, i64) -> Result<Decision>,
    ) -> Result<Self> {
        let mut ports: HashMap<(u8, u16), Vec<Owner>> = HashMap::new();
        for entry in entries.into_iter().filter(|e| {
            e.open.flow.local_port != 0
                && (e.open.flow.protocol == 17 || matches!(e.open.event, 4 | 6 | 7))
        }) {
            let mut decision = decide(entry.open.pid, entry.open.timestamp)?;
            decision.endpoint = entry.open.endpoint;
            ports
                .entry((entry.open.flow.protocol, entry.open.flow.local_port))
                .or_default()
                .push(Owner { entry, decision });
        }
        Ok(Self { ports })
    }
    pub fn find(&self, flow: Flow, timestamp: i64) -> Option<Decision> {
        let owners = self.ports.get(&(flow.protocol, flow.local_port))?;
        let (mut result, mut known) = (None, false);
        for owner in owners {
            let entry = &owner.entry;
            let socket = entry.open.flow;
            if !matches_address(socket.local, flow.local)
                || socket.remote_port != 0
                    && (socket.remote_port != flow.remote_port
                        || !matches_address(socket.remote, flow.remote))
            {
                continue;
            }
            known = true;
            if entry.open.event == 7
                || if timestamp == 0 {
                    entry.closed.is_some()
                } else {
                    timestamp < entry.open.timestamp
                        || entry.closed.is_some_and(|closed| closed < timestamp)
                }
            {
                continue;
            }
            let decision = if entry.open.event == 6 {
                let mut result = Decision::new(Kind::Unselected);
                result.process = owner.decision.process;
                result.endpoint = entry.open.endpoint;
                result.accepted = true;
                result
            } else {
                owner.decision.for_flow(flow)
            };
            result = Some(match result {
                None => decision,
                Some(previous) => merge(previous, decision),
            });
        }
        result.or_else(|| known.then(|| Decision::new(Kind::Unresolved)))
    }
}
