// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    address::Address,
    packet::Flow,
    process::{Decision, Kind},
    sockets::{self, SocketSnapshot},
    Error, Result,
};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Mutex,
};

pub fn merge(first: Decision, second: Decision) -> Decision {
    if first == second {
        return first;
    }
    Decision::new(
        if matches!(first.kind, Kind::Selected | Kind::Ambiguous)
            || matches!(second.kind, Kind::Selected | Kind::Ambiguous)
        {
            Kind::Ambiguous
        } else if first.kind == Kind::Unresolved || second.kind == Kind::Unresolved {
            Kind::Unresolved
        } else {
            Kind::Unselected
        },
    )
}
#[derive(Clone, Debug)]
pub struct OwnerRow {
    pub local: Address,
    pub port: u16,
    pub remote: Option<Address>,
    pub remote_port: u16,
    pub pid: u32,
    pub module: Option<String>,
    pub state: u32,
}
pub struct AttributionSnapshot {
    tcp: HashMap<Flow, Decision>,
    udp: HashMap<(Address, u16), Vec<Decision>>,
    events: Option<SocketSnapshot>,
    pub read_at: u64,
}
impl AttributionSnapshot {
    pub fn new(
        tcp: &[OwnerRow],
        udp: &[OwnerRow],
        mut decide: impl FnMut(u32, Option<&str>) -> Result<Decision>,
        read_at: u64,
        events: Option<SocketSnapshot>,
    ) -> Result<Self> {
        let listeners: Vec<_> = tcp.iter().filter(|r| r.state == 2).collect();
        let mut tcp_index: HashMap<Flow, Decision> = HashMap::new();
        for row in tcp.iter().filter(|r| r.state != 2) {
            let flow = Flow {
                protocol: 6,
                local: row.local,
                local_port: row.port,
                remote: row
                    .remote
                    .ok_or_else(|| Error::invalid("Missing TCP owner remote address."))?,
                remote_port: row.remote_port,
            };
            let decision = if matches!(row.state, 4 | 5 | 8)
                && listeners.iter().any(|l| {
                    l.pid == row.pid
                        && l.port == row.port
                        && sockets::matches_address(l.local, row.local)
                }) {
                let mut decision = Decision::new(Kind::Unselected);
                decision.accepted = true;
                decision
            } else {
                decide(row.pid, row.module.as_deref())?.for_flow(flow)
            };
            tcp_index
                .entry(flow)
                .and_modify(|old| *old = merge(old.clone(), decision.clone()))
                .or_insert(decision);
        }
        let mut udp_index: HashMap<(Address, u16), Vec<Decision>> = HashMap::new();
        for row in udp {
            let decision = decide(row.pid, row.module.as_deref())?;
            let owners = udp_index.entry((row.local, row.port)).or_default();
            if !owners.contains(&decision) {
                owners.push(decision);
            }
        }
        Ok(Self {
            tcp: tcp_index,
            udp: udp_index,
            events,
            read_at,
        })
    }
    pub fn find_fresh(
        &self,
        flow: Flow,
        now: u64,
        arrived: u64,
        timestamp: i64,
    ) -> Option<Decision> {
        if now.saturating_sub(self.read_at) > 500 || self.read_at < arrived {
            None
        } else {
            Some(self.find(flow, timestamp))
        }
    }
    /// Presence is separate from identity: an unresolved real socket must never
    /// be relabeled as forwarded traffic just because its process is unavailable.
    pub fn has_local_record(&self, flow: Flow) -> bool {
        self.find_table(flow).is_some()
            || self
                .events
                .as_ref()
                .is_some_and(|events| events.find(flow, 0).is_some())
    }
    pub fn find(&self, flow: Flow, timestamp: i64) -> Decision {
        let observed = self.events.as_ref().and_then(|e| e.find(flow, timestamp));
        let sampled = self.find_table(flow);
        if observed.as_ref().is_some_and(|d| d.accepted) {
            return observed.unwrap();
        }
        if sampled.as_ref().is_some_and(|d| d.accepted) {
            return observed.or(sampled).unwrap();
        }
        let Some(observed) = observed else {
            return sampled.unwrap_or_else(|| Decision::new(Kind::Unresolved));
        };
        if timestamp != 0
            && Some(&observed) != self.events.as_ref().and_then(|e| e.find(flow, 0)).as_ref()
        {
            return observed;
        }
        if observed.service_pending
            && sampled
                .as_ref()
                .is_none_or(|d| d.process == observed.process)
        {
            let Some(mut sampled) = sampled else {
                return observed;
            };
            if sampled.service_pending {
                return observed;
            }
            if sampled.kind != Kind::Unresolved {
                sampled.endpoint = observed.endpoint;
                return sampled;
            }
            return Decision::new(Kind::Unresolved);
        }
        if observed.kind == Kind::Unresolved
            || sampled.as_ref().is_some_and(|d| d.kind == Kind::Unresolved)
        {
            return Decision::new(Kind::Unresolved);
        }
        let Some(sampled) = sampled else {
            return observed;
        };
        let same_rule = match (&observed.rule, &sampled.rule) {
            (None, None) => true,
            (Some(a), Some(b)) => std::sync::Arc::ptr_eq(a, b),
            _ => false,
        };
        if observed.kind == sampled.kind && observed.process == sampled.process && same_rule {
            return observed;
        }
        merge(observed, sampled)
    }
    fn find_table(&self, flow: Flow) -> Option<Decision> {
        if flow.protocol == 6 {
            return self.tcp.get(&flow).cloned();
        }
        let for_flow = |owners: Option<&Vec<Decision>>| {
            owners
                .into_iter()
                .flatten()
                .map(|d| d.for_flow(flow))
                .reduce(merge)
        };
        let exact = for_flow(self.udp.get(&(flow.local, flow.local_port)));
        let any = Address {
            ip: if flow.local.ip.is_ipv6() {
                IpAddr::V6(Ipv6Addr::UNSPECIFIED)
            } else {
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            },
            scope: 0,
        };
        let wildcard = for_flow(self.udp.get(&(any, flow.local_port)));
        match (exact, wildcard) {
            (None, b) => b,
            (a, None) => a,
            (Some(a), Some(b)) => Some(merge(a, b)),
        }
    }
}

/// Fresh uncertainty suppresses a reply, while a proven identity/endpoint
/// mismatch permanently retires the association. Uncertainty is not closure.
pub struct FlowOwner {
    owner: Decision,
    invalidated: Mutex<bool>,
}
impl FlowOwner {
    pub fn new(owner: Decision) -> Self {
        Self {
            owner,
            invalidated: Mutex::new(false),
        }
    }
    pub fn invalidated(&self) -> Result<bool> {
        self.invalidated
            .lock()
            .map(|v| *v)
            .map_err(|_| Error::invalid("Flow ownership poisoned."))
    }
    pub fn is_current(&self, read: impl FnOnce() -> Option<Decision>) -> Result<bool> {
        let mut invalidated = self
            .invalidated
            .lock()
            .map_err(|_| Error::invalid("Flow ownership poisoned."))?;
        if *invalidated {
            return Ok(false);
        }
        let Some(current) = read() else {
            return Ok(false);
        };
        if current.kind == Kind::Unresolved
            && current.service_pending
            && self.owner.endpoint != 0
            && current.process == self.owner.process
            && current.endpoint == self.owner.endpoint
        {
            return Ok(false);
        }
        let same_rule = match (&current.rule, &self.owner.rule) {
            (Some(a), Some(b)) => std::sync::Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        *invalidated = current.kind != Kind::Selected
            || current.process != self.owner.process
            || !same_rule
            || current.endpoint != self.owner.endpoint;
        Ok(!*invalidated)
    }
}
