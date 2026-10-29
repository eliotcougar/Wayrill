// SPDX-License-Identifier: GPL-3.0-only
use super::{
    clock, owners,
    process_events::{ProcessEvents, Scope},
    processes::ProcessSnapshot,
    service_catalog,
};
#[cfg(feature = "windivert")]
use super::{divert::Api, socket_events::SocketEvents};
use crate::{
    attribution::AttributionSnapshot,
    policy::SharedPolicy,
    process::{Decision, Kind, ProcessKey, ProcessTree},
    process_decisions::ProcessDecisions,
    services::ServiceSnapshot,
    socket_presence::SocketPresence,
    sockets::SocketHistory,
    Error, Result,
};
use std::sync::Arc;
use tokio::sync::Notify;

pub struct AttributionSource {
    processes: ProcessSnapshot,
    tree: ProcessTree,
    sockets: SocketHistory,
    process_events: Option<ProcessEvents>,
    #[cfg(feature = "windivert")]
    socket_events: Option<SocketEvents>,
    last_process_read: u64,
    last_service_read: u64,
    last_socket_reconciliation: u64,
    read_packages: bool,
    services: Option<ServiceSnapshot>,
    service_names: Vec<String>,
}
impl AttributionSource {
    pub fn new() -> Result<Self> {
        Ok(Self {
            processes: ProcessSnapshot::default(),
            tree: ProcessTree::new(None, []),
            sockets: SocketHistory::new(10 * clock::frequency()?),
            process_events: None,
            #[cfg(feature = "windivert")]
            socket_events: None,
            last_process_read: 0,
            last_service_read: 0,
            last_socket_reconciliation: 0,
            read_packages: false,
            services: None,
            service_names: Vec::new(),
        })
    }
    pub fn start_tun(&mut self, changed: Arc<Notify>) -> Result<()> {
        self.start_processes(Scope::Tun, changed)
    }
    #[cfg(feature = "windivert")]
    pub fn start_capture(&mut self, api: &Arc<Api>, changed: Arc<Notify>) -> Result<()> {
        self.start_processes(Scope::Capture, changed.clone())?;
        match SocketEvents::open(api, changed) {
            Ok(sockets) => {
                self.socket_events = Some(sockets);
                Ok(())
            }
            Err(error) => {
                let _ = self.close();
                Err(error)
            }
        }
    }
    fn start_processes(&mut self, scope: Scope, changed: Arc<Notify>) -> Result<()> {
        if self.process_events.is_some() {
            return Err(Error::invalid("Attribution observation already active."));
        }
        super::observation::enable()?;
        self.process_events = Some(ProcessEvents::open(scope, changed)?);
        self.last_process_read = 0;
        Ok(())
    }
    /// Serial ownership construction. Callers publish only the completed immutable
    /// snapshot, and keep failed native refreshes from authorizing new flows.
    pub fn read(
        &mut self,
        rules: Option<Arc<SharedPolicy>>,
        excluded: &[ProcessKey],
        flush: bool,
    ) -> Result<AttributionSnapshot> {
        let read_at = clock::milliseconds();
        self.tree.set_rules(rules.clone(), excluded.iter().copied());
        let mut updates = Vec::new();
        let events = self
            .process_events
            .as_ref()
            .map(|events| events.drain(flush))
            .transpose()?;
        let reconcile = events.as_ref().is_some_and(|batch| batch.discontinuity);
        let has_packages = rules.as_ref().is_some_and(|r| r.has_packages);
        let read_processes = self.process_events.is_none()
            || read_at.saturating_sub(self.last_process_read) >= 1000
            || flush
            || reconcile
            || has_packages && !self.read_packages;
        if read_processes {
            updates.extend(self.processes.read(has_packages)?.into_iter().map(|mut p| {
                if p.exited.is_some() {
                    p.exited_at = Some(clock::ticks());
                }
                p
            }));
            self.last_process_read = read_at;
            self.read_packages = has_packages;
        }
        if let Some(events) = events {
            updates.extend(events.items);
        }
        if reconcile {
            // Keep the original observation epoch and proven ancestry. Processes
            // with proven native identity/ancestry can recover without inventing
            // historical event times. Unknown ancestors still fail closed.
            self.last_service_read = 0;
            self.last_socket_reconciliation = 0;
            eprintln!("Process event loss reconciled with a fresh Windows process snapshot.");
        }
        // Quiet socket refreshes need no ancestry rebuild. Native polling still
        // maintains expiry at least once a second, even without ETW events.
        if read_processes || !updates.is_empty() {
            self.tree.ingest(updates);
            if read_processes {
                self.processes.reconcile(&mut self.tree);
            }
            self.tree.refresh(super::now_filetime())?;
        }
        let has_services = rules.as_ref().is_some_and(|r| !r.service_names.is_empty());
        if has_services
            && (self.last_service_read == 0
                || read_at.saturating_sub(self.last_service_read) >= 1000
                || flush
                || self.service_names != rules.as_ref().unwrap().service_names)
        {
            let names = &rules.as_ref().unwrap().service_names;
            self.services = Some(ServiceSnapshot::new(
                &service_catalog::read()?,
                self.tree
                    .processes()
                    .filter(|p| self.tree.is_current(p.key)),
                names,
            ));
            self.service_names.clone_from(names);
            self.last_service_read = read_at;
        } else if !has_services {
            self.services = None;
            self.service_names.clear();
        }
        // Preserve the generations paired with the SCM read; rebinding cached
        // service PIDs to the latest process table would misidentify reused IDs.
        let services = self.services.as_ref();
        let mut decisions = ProcessDecisions::new(
            &self.tree,
            self.process_events.as_ref().map_or(0, |e| e.started),
            services,
        );
        let module_hosts = services.filter(|s| s.has_selected_hosts());
        let (mut tcp, mut udp) = (Vec::new(), Vec::new());
        for six in [false, true] {
            tcp.extend(owners::read(6, six, module_hosts)?);
            udp.extend(owners::read(17, six, module_hosts)?);
        }
        #[cfg(feature = "windivert")]
        let socket_active = self.socket_events.is_some();
        #[cfg(not(feature = "windivert"))]
        let socket_active = false;
        let presence =
            if socket_active && read_at.saturating_sub(self.last_socket_reconciliation) >= 1000 {
                self.last_socket_reconciliation = read_at;
                Some(SocketPresence::new(&tcp, &udp))
            } else {
                None
            };
        #[cfg(feature = "windivert")]
        let socket_events = self
            .socket_events
            .as_ref()
            .map(SocketEvents::drain)
            .transpose()?
            .unwrap_or_default();
        #[cfg(not(feature = "windivert"))]
        let socket_events = Vec::new();
        let is_present = |event: &_| presence.as_ref().unwrap().contains(event);
        self.sockets.update(
            socket_events,
            clock::ticks(),
            &|pid, at| decisions.owner_at(pid, at).and_then(|p| p.exited_at),
            presence
                .as_ref()
                .map(|_| &is_present as &dyn Fn(&crate::sockets::SocketEvent) -> bool),
        )?;
        let events = if socket_active {
            Some(self.sockets.snapshot(|pid, at| {
                if pid <= 4 {
                    Ok(Decision::new(Kind::Unselected))
                } else {
                    decisions.at(pid, at, None)
                }
            })?)
        } else {
            None
        };
        AttributionSnapshot::new(
            &tcp,
            &udp,
            |pid, module| {
                if pid <= 4 {
                    Ok(Decision::new(Kind::Unselected))
                } else {
                    decisions.current(pid, module)
                }
            },
            read_at,
            events,
        )
    }
    pub fn close(&mut self) -> Result<()> {
        #[cfg(feature = "windivert")]
        let sockets = self.socket_events.take().map(|mut s| s.close()).transpose();
        let processes = self
            .process_events
            .take()
            .map(|mut p| p.close())
            .transpose();
        // Close both observers even when the first cleanup reports a failure.
        #[cfg(feature = "windivert")]
        sockets?;
        processes?;
        Ok(())
    }
}
impl Drop for AttributionSource {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
