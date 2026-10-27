// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    address::{Address, DivertAddress},
    packet::{self, Flow},
    policy::{SharedPolicy, Target},
    Error, Result,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::watch;

pub struct NatEntry {
    pub flow: Flow,
    pub rule: Arc<Target>,
    pub translated_port: u16,
    pub initial_sequence: u32,
    pub original_address: DivertAddress,
    last_activity: AtomicU64,
    accepted: AtomicBool,
    closed: AtomicBool,
    retired: AtomicBool,
    client_ack: AtomicU64,
    relay_stop: Mutex<Option<watch::Sender<bool>>>,
}
impl NatEntry {
    fn new(
        flow: Flow,
        rule: Arc<Target>,
        translated_port: u16,
        initial_sequence: u32,
        address: DivertAddress,
        now: u64,
    ) -> Self {
        Self {
            flow,
            rule,
            translated_port,
            initial_sequence,
            original_address: address,
            last_activity: AtomicU64::new(now),
            accepted: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            client_ack: AtomicU64::new(0),
            relay_stop: Mutex::new(None),
        }
    }
    pub fn last_activity(&self) -> u64 {
        self.last_activity.load(Ordering::Acquire)
    }
    pub fn touch(&self, now: u64) {
        self.last_activity.store(now, Ordering::Release);
    }
    pub fn accepted(&self) -> bool {
        self.accepted.load(Ordering::Acquire)
    }
    pub fn set_accepted(&self, value: bool) {
        self.accepted.store(value, Ordering::Release);
    }
    pub fn closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    pub fn set_closed(&self, value: bool) {
        self.closed.store(value, Ordering::Release);
    }
    pub fn retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }
    pub fn acknowledge(&self, sequence: u32) {
        self.client_ack
            .store((1 << 32) | u64::from(sequence), Ordering::Release);
    }
    pub fn create_reset(&self) -> Result<Vec<u8>> {
        let ack = self.client_ack.load(Ordering::Acquire);
        if ack >> 32 != 0 {
            packet::tcp_reset(self.flow, ack as u32, None)
        } else {
            packet::tcp_reset(self.flow, 0, Some(self.initial_sequence.wrapping_add(1)))
        }
    }
    pub fn begin_relay(&self) -> Result<watch::Receiver<bool>> {
        let mut stop = self
            .relay_stop
            .lock()
            .map_err(|_| Error::invalid("TCP relay cancellation poisoned."))?;
        if stop.is_some() {
            return Err(Error::invalid("TCP relay was already accepted."));
        }
        let (sender, receiver) = watch::channel(self.closed());
        *stop = Some(sender);
        Ok(receiver)
    }
    pub fn retire(&self, now: u64) -> Result<()> {
        let stop = self
            .relay_stop
            .lock()
            .map_err(|_| Error::invalid("TCP relay cancellation poisoned."))?;
        self.retired.store(true, Ordering::Release);
        self.closed.store(true, Ordering::Release);
        self.touch(now);
        if let Some(sender) = stop.as_ref() {
            sender.send_replace(true);
        }
        Ok(())
    }
}
struct State {
    forward: HashMap<Flow, Arc<NatEntry>>,
    reverse: HashMap<u16, Arc<NatEntry>>,
    next: u16,
}
pub struct NatTable {
    state: Mutex<State>,
}
impl Default for NatTable {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                forward: HashMap::new(),
                reverse: HashMap::new(),
                next: 1024,
            }),
        }
    }
}
impl NatTable {
    pub fn get_or_add(
        &self,
        flow: Flow,
        rule: Arc<Target>,
        initial_sequence: u32,
        address: DivertAddress,
        now: u64,
    ) -> Result<Arc<NatEntry>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("TCP NAT table poisoned."))?;
        if let Some(entry) = state.forward.get(&flow) {
            return Ok(entry.clone());
        }
        for _ in 0..64512 {
            let port = state.next;
            state.next = if port == 65535 { 1024 } else { port + 1 };
            if state.reverse.contains_key(&port) {
                continue;
            }
            let entry = Arc::new(NatEntry::new(
                flow,
                rule,
                port,
                initial_sequence,
                address,
                now,
            ));
            state.forward.insert(flow, entry.clone());
            state.reverse.insert(port, entry.clone());
            return Ok(entry);
        }
        Err(Error::invalid(
            "Application routing connection limit reached.",
        ))
    }
    pub fn find(
        &self,
        flow: Flow,
        syn_sequence: Option<u32>,
        now: u64,
    ) -> Result<Option<Arc<NatEntry>>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("TCP NAT table poisoned."))?;
        let Some(entry) = state.forward.get(&flow).cloned() else {
            return Ok(None);
        };
        if syn_sequence.is_some_and(|sequence| entry.closed() || entry.initial_sequence != sequence)
        {
            entry.retire(now)?;
            state.forward.remove(&flow);
            return Ok(None);
        }
        Ok(Some(entry))
    }
    pub fn reverse(
        &self,
        local: Address,
        remote: Address,
        port: u16,
    ) -> Result<Option<Arc<NatEntry>>> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("TCP NAT table poisoned."))?;
        Ok(state
            .reverse
            .get(&port)
            .filter(|entry| {
                !entry.retired()
                    && entry.flow.local.wire_equals(local)
                    && entry.flow.remote.wire_equals(remote)
            })
            .cloned())
    }
    pub fn expire(&self, now: u64) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("TCP NAT table poisoned."))?;
        let expired: Vec<_> = state
            .reverse
            .values()
            .filter(|e| {
                (e.closed() || !e.accepted()) && now.saturating_sub(e.last_activity()) > 120_000
            })
            .cloned()
            .collect();
        for entry in expired {
            entry.retire(now)?;
            if state
                .forward
                .get(&entry.flow)
                .is_some_and(|current| Arc::ptr_eq(current, &entry))
            {
                state.forward.remove(&entry.flow);
            }
            state.reverse.remove(&entry.translated_port);
        }
        Ok(())
    }
    pub fn may_be_reflection(&self, local: Address, remote: Address) -> Result<bool> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("TCP NAT table poisoned."))?;
        Ok(state
            .reverse
            .values()
            .any(|e| e.flow.local.wire_equals(local) && e.flow.remote.wire_equals(remote)))
    }
    /// Keep forward tombstones until a new SYN or expiry. Old ACK/data must not
    /// escape through a newly unselected/direct policy after a live Apply.
    pub fn retain(
        &self,
        policy: Option<&SharedPolicy>,
        retain_interface: impl Fn(&NatEntry) -> bool,
        now: u64,
    ) -> Result<Vec<Arc<NatEntry>>> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("TCP NAT table poisoned."))?;
        let retired: Vec<_> = state
            .forward
            .values()
            .filter(|e| {
                !e.closed() && (!policy.is_some_and(|p| p.retains(&e.rule)) || !retain_interface(e))
            })
            .cloned()
            .collect();
        for entry in &retired {
            entry.retire(now)?;
        }
        Ok(retired)
    }
}
