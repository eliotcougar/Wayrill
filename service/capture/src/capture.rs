// SPDX-License-Identifier: GPL-3.0-only
//! Contained WinDivert TCP reflection/UDP forwarding. Publication and final
//! packet injection share one gate; Windows ownership reads run outside it.
use crate::{
    address::{Address, DivertAddress},
    attribution::{AttributionSnapshot, FlowOwner},
    batch::{self, PacketBatch},
    buffers::{cancelled, Buffer, BufferPool, Envelope, Queue},
    fragments::{FragmentBuffer, FragmentResult},
    interfaces::{self, InterfacePolicy},
    nat::{NatEntry, NatTable},
    native::{
        self,
        attribution_source::AttributionSource,
        clock,
        divert::{Api, Handle as DivertHandle},
        divert_monitor::Monitor,
        firewall::ReflectionFirewall,
        lease::CaptureLease,
    },
    packet::{self, Flow, Packet},
    pending::{Original, PendingPacket, PendingPackets, WAIT_MILLISECONDS},
    policy::{InterfaceOptions, Plan, SharedPolicy, Target},
    process::{Decision, Kind, ProcessKey},
    socks, udp, Error, Result,
};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock, Weak,
    },
    thread,
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpSocket, TcpStream},
    runtime::Handle,
    sync::{mpsc, watch, Notify, Semaphore},
    task::{JoinHandle, JoinSet},
};

struct Policy {
    rules: Arc<SharedPolicy>,
    excluded: Vec<ProcessKey>,
}
struct Routing {
    policy: Arc<Policy>,
    owners: Arc<AttributionSnapshot>,
}
#[derive(Clone, Hash, PartialEq, Eq)]
struct UdpKey {
    process: ProcessKey,
    local: Address,
    port: u16,
    rule: String,
    interface: u32,
    endpoint: u64,
}
struct State {
    fragments: FragmentBuffer,
    pending: PendingPackets,
    udp: HashMap<UdpKey, Arc<udp::Session>>,
    options: InterfaceOptions,
    bypass_local: bool,
    owned: Vec<String>,
    version: u64,
}
struct Reply {
    bytes: Buffer,
    address: DivertAddress,
    owner: Arc<SessionOwner>,
}
struct Shared {
    api: Arc<Api>,
    network: Mutex<Option<Arc<DivertHandle>>>,
    runtime: Handle,
    routing: RwLock<Arc<Routing>>,
    interfaces: RwLock<Arc<InterfacePolicy>>,
    state: Mutex<State>,
    nat: Arc<NatTable>,
    source: Mutex<AttributionSource>,
    stop: watch::Sender<bool>,
    stopping: AtomicBool,
    refresh: Arc<Notify>,
    updates: watch::Sender<u64>,
    pool: Arc<BufferPool>,
    replies: Queue<Reply>,
    sessions: Mutex<Vec<JoinHandle<()>>>,
    udp_slots: Arc<Semaphore>,
    tcp_slots: Arc<Semaphore>,
    ports: [u16; 2],
    packets: AtomicU64,
    bytes: AtomicU64,
    last_report: AtomicU64,
    last_error: Mutex<Option<Error>>,
    failure: Mutex<Option<Error>>,
}
pub struct CaptureEngine {
    shared: Arc<Shared>,
    workers: Vec<JoinHandle<()>>,
    capture: Option<thread::JoinHandle<()>>,
    firewall: Option<ReflectionFirewall>,
    monitor: Option<Monitor>,
    lease: Option<CaptureLease>,
}
fn lock_error() -> Error {
    Error::invalid("Capture runtime state poisoned.")
}
impl Shared {
    fn routing(&self) -> Result<Arc<Routing>> {
        self.routing
            .read()
            .map(|r| r.clone())
            .map_err(|_| lock_error())
    }
    fn interfaces(&self) -> Result<Arc<InterfacePolicy>> {
        self.interfaces
            .read()
            .map(|i| i.clone())
            .map_err(|_| lock_error())
    }
    fn report(&self, error: Error) {
        let now = clock::milliseconds();
        let old = self.last_report.load(Ordering::Relaxed);
        if now.saturating_sub(old) >= 1000
            && self
                .last_report
                .compare_exchange(old, now, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
        {
            if let Ok(mut last) = self.last_error.lock() {
                *last = Some(error);
            }
        }
    }
    fn send_batch(&self, bytes: &[u8], addresses: &[DivertAddress], force: bool) -> Result<()> {
        let handle = self.network.lock().map_err(|_| lock_error())?;
        if !force && self.stopping.load(Ordering::Acquire) {
            return Ok(());
        }
        if let Some(handle) = handle.as_ref() {
            handle.send(bytes, addresses)
        } else {
            Ok(())
        }
    }
    fn flush(&self, batch: &mut PacketBatch) -> Result<()> {
        batch.flush(&mut |p, a| self.send_batch(p, a, false))
    }
    fn send(
        &self,
        bytes: &mut [u8],
        mut address: DivertAddress,
        checksum: bool,
        batch: &mut PacketBatch,
    ) -> Result<()> {
        if self.stopping.load(Ordering::Acquire) {
            return Ok(());
        }
        if checksum {
            self.api.calculate_checksums(bytes, &mut address)?;
        }
        batch.add(bytes, address, &mut |p, a| self.send_batch(p, a, false))
    }
    fn reset(&self, entries: Vec<Arc<NatEntry>>, batch: &mut PacketBatch) {
        for entry in entries {
            let result = (|| {
                let mut address = entry.original_address;
                address.set_outbound(false);
                self.send(&mut entry.create_reset()?, address, true, batch)
            })();
            if let Err(error) = result {
                self.report(error);
            }
        }
    }
    fn stop_now(&self, error: Option<Error>) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(error) = error {
            if let Ok(mut failure) = self.failure.lock() {
                *failure = Some(error);
            }
        }
        // Retire before closing NETWORK. Force only these final sequence-correct
        // resets through the stopped gate; ordinary queued packets are discarded.
        if let Ok(mut state) = self.state.lock() {
            if let Ok(entries) = self.nat.retain(None, |_| true, clock::milliseconds()) {
                let mut batch = PacketBatch::default();
                for entry in entries {
                    let result = (|| {
                        let mut bytes = entry.create_reset()?;
                        let mut address = entry.original_address;
                        address.set_outbound(false);
                        self.api.calculate_checksums(&mut bytes, &mut address)?;
                        batch.add(&bytes, address, &mut |p, a| self.send_batch(p, a, true))
                    })();
                    if let Err(error) = result {
                        self.report(error);
                    }
                }
                if let Err(error) = batch.flush(&mut |p, a| self.send_batch(p, a, true)) {
                    self.report(error);
                }
            }
            for session in state.udp.values() {
                session.cancel();
            }
            state.udp.clear();
        }
        self.stop.send_replace(true);
        self.refresh.notify_one();
        if let Ok(handle) = self.network.lock() {
            if let Some(handle) = handle.as_ref() {
                if let Err(error) = handle.shutdown(1) {
                    self.report(error);
                }
            }
        }
    }
    fn track(&self, task: JoinHandle<()>) -> Result<()> {
        let mut tasks = self.sessions.lock().map_err(|_| lock_error())?;
        tasks.retain(|t| !t.is_finished());
        tasks.push(task);
        Ok(())
    }
    fn publish(&self, routing: Arc<Routing>) -> Result<()> {
        *self.routing.write().map_err(|_| lock_error())? = routing;
        self.updates.send_modify(|n| *n = n.wrapping_add(1));
        Ok(())
    }
    fn matched(&self, flow: Flow, arrived: u64, fresh: bool, timestamp: i64) -> Result<Decision> {
        Ok(self
            .routing()?
            .owners
            .find_fresh(
                flow,
                clock::milliseconds(),
                if fresh { arrived } else { 0 },
                timestamp,
            )
            .unwrap_or_else(|| Decision::new(Kind::Unresolved)))
    }
    fn passthrough(
        &self,
        bytes: &mut [u8],
        address: DivertAddress,
        originals: &[Original],
        batch: &mut PacketBatch,
    ) -> Result<()> {
        if originals.is_empty() {
            self.send(bytes, address, false, batch)
        } else {
            for (bytes, address) in originals {
                batch.add(bytes, *address, &mut |p, a| self.send_batch(p, a, false))?;
            }
            Ok(())
        }
    }
    fn reset_packet(
        &self,
        packet: Packet,
        bytes: &[u8],
        mut address: DivertAddress,
        batch: &mut PacketBatch,
    ) -> Result<()> {
        if let Some(mut reset) = packet.tcp_reset(bytes)? {
            address.set_outbound(false);
            self.send(&mut reset, address, true, batch)?;
        }
        Ok(())
    }
}
enum Outcome {
    Done,
    Deferred,
}
impl State {
    fn defer(decision: &Decision, arrived: u64) -> Result<bool> {
        match decision.kind {
            Kind::Ambiguous => Err(Error::invalid("Ambiguous shared endpoint; packet blocked.")),
            Kind::Unresolved
                if clock::milliseconds().saturating_sub(arrived) < WAIT_MILLISECONDS =>
            {
                Ok(true)
            }
            Kind::Unresolved => Err(Error::invalid(
                "Could not identify the application owning a packet; packet blocked.",
            )),
            _ => Ok(false),
        }
    }
    fn process(
        &mut self,
        shared: &Arc<Shared>,
        bytes: &mut [u8],
        mut address: DivertAddress,
        originals: &[Original],
        arrived: u64,
        batch: &mut PacketBatch,
    ) -> Result<Outcome> {
        let Some(packet) = Packet::parse(bytes, address.interface()) else {
            shared.passthrough(bytes, address, originals, batch)?;
            return Ok(Outcome::Done);
        };
        let flow = packet.flow;
        let six = flow.local.ip.is_ipv6();
        let interfaces = shared.interfaces()?;
        let listener = shared.ports[usize::from(six)];
        if flow.protocol == 6 && listener != 0 {
            if flow.local_port == listener {
                if let Some(entry) =
                    shared
                        .nat
                        .reverse(flow.local, flow.remote, flow.remote_port)?
                {
                    entry.touch(clock::milliseconds());
                    let valid = packet.reflect(
                        bytes,
                        entry.flow.remote_port,
                        entry.flow.local_port,
                        address,
                    )?;
                    address.set_interface(entry.original_address.interface());
                    address.set_sub_interface(entry.original_address.sub_interface());
                    address.set_outbound(false);
                    shared.send(bytes, address, !valid, batch)?;
                }
                return Ok(Outcome::Done); // Never leak reflected replies onto the uplink.
            }
            let mut entry = shared.nat.find(
                flow,
                packet.is_tcp_syn().then_some(packet.tcp_sequence),
                clock::milliseconds(),
            )?;
            if entry.as_ref().is_some_and(|e| e.retired()) {
                shared.reset_packet(packet, bytes, address, batch)?;
                return Ok(Outcome::Done);
            }
            if !interfaces.monitors(address.interface(), six) {
                shared.passthrough(bytes, address, originals, batch)?;
                return Ok(Outcome::Done);
            }
            if entry.is_none() {
                if interfaces.bypasses_flow(address.interface(), flow)
                    || packet.tcp_flags & 0x12 == 0x12
                {
                    shared.passthrough(bytes, address, originals, batch)?;
                    return Ok(Outcome::Done);
                }
                let selected =
                    shared.matched(flow, arrived, packet.is_tcp_syn(), address.timestamp)?;
                if Self::defer(&selected, arrived)? {
                    return Ok(Outcome::Deferred);
                }
                if selected.kind == Kind::Unselected {
                    shared.passthrough(bytes, address, originals, batch)?;
                    return Ok(Outcome::Done);
                }
                if !packet.is_tcp_syn() {
                    shared.reset_packet(packet, bytes, address, batch)?;
                    return Ok(Outcome::Done);
                }
                let rule = selected
                    .rule
                    .ok_or_else(|| Error::invalid("Selected TCP route lacks a target."))?;
                entry = Some(shared.nat.get_or_add(
                    flow,
                    rule,
                    packet.tcp_sequence,
                    address,
                    clock::milliseconds(),
                )?);
            }
            let entry = entry.unwrap();
            if packet.tcp_flags & 16 != 0 {
                entry.acknowledge(u32::from_be_bytes(
                    bytes[packet.transport + 8..packet.transport + 12]
                        .try_into()
                        .unwrap(),
                ));
            }
            entry.touch(clock::milliseconds());
            let valid = packet.reflect(bytes, entry.translated_port, listener, address)?;
            address.set_outbound(false);
            shared.send(bytes, address, !valid, batch)?;
        } else if flow.protocol == 17 {
            if !interfaces.monitors(address.interface(), six)
                || interfaces.bypasses_flow(address.interface(), flow)
            {
                shared.passthrough(bytes, address, originals, batch)?;
                return Ok(Outcome::Done);
            }
            let selected = shared.matched(flow, arrived, false, address.timestamp)?;
            if Self::defer(&selected, arrived)? {
                return Ok(Outcome::Deferred);
            }
            if selected.kind == Kind::Unselected {
                shared.passthrough(bytes, address, originals, batch)?;
                return Ok(Outcome::Done);
            }
            let rule = selected
                .rule
                .clone()
                .ok_or_else(|| Error::invalid("Selected UDP route lacks a target."))?;
            let key = UdpKey {
                process: selected.process.ok_or_else(|| {
                    Error::invalid("Selected UDP route lacks a process generation.")
                })?,
                local: flow.local,
                port: flow.local_port,
                rule: rule.id.clone(),
                interface: address.interface(),
                endpoint: selected.endpoint,
            };
            if self
                .udp
                .get(&key)
                .map(|s| s.usable())
                .transpose()?
                .is_some_and(|usable| !usable)
            {
                if let Some(old) = self.udp.remove(&key) {
                    old.cancel();
                }
            }
            if !self.udp.contains_key(&key) {
                let permit = shared
                    .udp_slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| Error::invalid("UDP routing session limit reached."))?;
                let owner = Arc::new(SessionOwner {
                    shared: Arc::downgrade(shared),
                    rule: rule.clone(),
                    interfaces,
                    flow,
                    address,
                    ownership: FlowOwner::new(selected),
                });
                let weak = Arc::downgrade(shared);
                let report: udp::Report = Arc::new(move |error| {
                    if let Some(shared) = weak.upgrade() {
                        shared.report(error);
                    }
                });
                let (session, task) = udp::Session::start(
                    &shared.runtime,
                    rule,
                    flow.remote.socket(flow.remote_port),
                    owner,
                    shared.stop.subscribe(),
                    shared.pool.clone(),
                    report,
                );
                let weak = Arc::downgrade(shared);
                shared.track(shared.runtime.spawn(async move {
                    let _permit = permit;
                    if task.await.is_err() {
                        if let Some(shared) = weak.upgrade() {
                            shared.stop_now(Some(Error::invalid("UDP relay task panicked.")));
                        }
                    }
                }))?;
                self.udp.insert(key.clone(), session);
            }
            let payload = usize::from(u16::from_be_bytes(
                bytes[packet.transport + 4..packet.transport + 6]
                    .try_into()
                    .unwrap(),
            )) - 8;
            self.udp.get(&key).unwrap().send(
                flow.remote.socket(flow.remote_port),
                &bytes[packet.transport + 8..packet.transport + 8 + payload],
            )?;
        } else {
            shared.passthrough(bytes, address, originals, batch)?;
        }
        Ok(Outcome::Done)
    }
}

struct SessionOwner {
    shared: Weak<Shared>,
    rule: Arc<Target>,
    interfaces: Arc<InterfacePolicy>,
    flow: Flow,
    address: DivertAddress,
    ownership: FlowOwner,
}
impl SessionOwner {
    fn allowed(&self, shared: &Shared) -> Result<bool> {
        Ok(!shared.stopping.load(Ordering::Acquire)
            && shared.routing()?.policy.rules.retains(&self.rule)
            && shared.interfaces()?.retains(
                &self.interfaces,
                self.address.interface(),
                self.flow.local.ip.is_ipv6(),
            ))
    }
}
impl udp::Owner for SessionOwner {
    fn can_send(&self) -> Result<bool> {
        match self.shared.upgrade() {
            Some(shared) => self.allowed(&shared),
            None => Ok(false),
        }
    }
    fn current(&self) -> Result<bool> {
        let Some(shared) = self.shared.upgrade() else {
            return Ok(false);
        };
        let current = if self.allowed(&shared)? {
            shared
                .routing()?
                .owners
                .find_fresh(self.flow, clock::milliseconds(), 0, 0)
        } else {
            Some(Decision::new(Kind::Unselected))
        };
        self.ownership.is_current(|| current)
    }
    fn invalidated(&self) -> Result<bool> {
        self.ownership.invalidated()
    }
    fn updates(&self) -> watch::Receiver<u64> {
        if let Some(shared) = self.shared.upgrade() {
            shared.updates.subscribe()
        } else {
            watch::channel(0).1
        }
    }
    fn refresh(&self) {
        if let Some(shared) = self.shared.upgrade() {
            shared.refresh.notify_one();
        }
    }
    fn deliver(self: Arc<Self>, peer: SocketAddr, payload: &[u8]) -> Result<()> {
        let Some(shared) = self.shared.upgrade() else {
            return Ok(());
        };
        if shared.stopping.load(Ordering::Acquire) {
            return Ok(());
        }
        let flow = Flow {
            remote: Address {
                ip: peer.ip(),
                scope: match peer {
                    SocketAddr::V6(a) => a.scope_id(),
                    _ => 0,
                },
            },
            remote_port: peer.port(),
            ..self.flow
        };
        let mut bytes = shared.pool.rent(48 + payload.len())?;
        let length = packet::write_udp_reply(bytes.bytes_mut(), flow, payload)?.len();
        bytes.length = length;
        let mut address = self.address;
        address.set_outbound(false);
        shared
            .api
            .calculate_checksums(bytes.bytes_mut(), &mut address)?;
        shared.replies.try_send(
            Reply {
                bytes,
                address,
                owner: self,
            },
            length,
        );
        Ok(())
    }
}

impl CaptureEngine {
    pub async fn start(
        api: Arc<Api>,
        plan: Plan,
        core_pids: &[u32],
        owned: Vec<String>,
    ) -> Result<Self> {
        native::observation::enable()?;
        let rules = Arc::new(SharedPolicy::new(plan.clone())?);
        let policy = Arc::new(Policy {
            rules,
            excluded: excluded(core_pids)?,
        });
        native::capture_availability::check(&api, None, None)?;
        let lease = CaptureLease::acquire()?;
        let monitor = Monitor::open(&api, true)?
            .ok_or_else(|| Error::invalid("WinDivert monitor unavailable."))?;
        native::drivers::check_loaded()?;
        if let Some(foreign) = monitor.conflict(None, None)? {
            return Err(native::capture_availability::conflict_message(&foreign));
        }
        let adapters = native::adapters::read()?;
        let options = interfaces::discover(&plan.interfaces, &adapters);
        let interfaces = Arc::new(InterfacePolicy::new(
            &options,
            &adapters,
            plan.bypass_local_traffic,
            &owned,
        )?);
        let refresh = Arc::new(Notify::new());
        let mut source = AttributionSource::new()?;
        source.start_capture(&api, refresh.clone())?;
        let initial = source.read(Some(policy.rules.clone()), &policy.excluded, true)?;
        let mut listeners = Vec::new();
        let mut ports = [0; 2];
        for six in [false, true] {
            let socket = if six {
                TcpSocket::new_v6()?
            } else {
                TcpSocket::new_v4()?
            };
            if six {
                socket2::SockRef::from(&socket).set_only_v6(true)?;
            }
            socket.bind(SocketAddr::new(
                if six {
                    IpAddr::V6(Ipv6Addr::UNSPECIFIED)
                } else {
                    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
                },
                0,
            ))?;
            let listener = socket.listen(128)?;
            ports[usize::from(six)] = listener.local_addr()?.port();
            listeners.push(listener);
        }
        let firewall = ReflectionFirewall::new(&ports)?;
        let network = Arc::new(api.open_network()?);
        network.set_param(0, 8192)?;
        network.set_param(2, 8 * 1024 * 1024)?;
        let (stop, _) = watch::channel(false);
        let (updates, _) = watch::channel(0);
        let (replies, receiver) = Queue::new(1024, 2 * 1024 * 1024);
        let shared = Arc::new(Shared {
            api,
            network: Mutex::new(Some(network)),
            runtime: Handle::current(),
            routing: RwLock::new(Arc::new(Routing {
                policy,
                owners: Arc::new(initial),
            })),
            interfaces: RwLock::new(interfaces),
            state: Mutex::new(State {
                fragments: FragmentBuffer::default(),
                pending: PendingPackets::default(),
                udp: HashMap::new(),
                options,
                bypass_local: plan.bypass_local_traffic,
                owned,
                version: 0,
            }),
            nat: Arc::new(NatTable::default()),
            source: Mutex::new(source),
            stop,
            stopping: AtomicBool::new(false),
            refresh,
            updates,
            pool: Arc::new(BufferPool::default()),
            replies,
            sessions: Mutex::new(Vec::new()),
            udp_slots: Arc::new(Semaphore::new(2048)),
            tcp_slots: Arc::new(Semaphore::new(2048)),
            ports,
            packets: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            last_report: AtomicU64::new(0),
            last_error: Mutex::new(None),
            failure: Mutex::new(None),
        });
        let mut engine = Self {
            shared: shared.clone(),
            workers: Vec::new(),
            capture: None,
            firewall: Some(firewall),
            monitor: Some(monitor),
            lease: Some(lease),
        };
        let capture_shared = shared.clone();
        engine.capture = Some(
            thread::Builder::new()
                .name("capture-network".into())
                .spawn(move || {
                    let run = || capture_loop(&capture_shared);
                    if let Err(error) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
                        .unwrap_or_else(|_| Err(Error::invalid("Capture thread panicked.")))
                    {
                        capture_shared.stop_now(Some(error));
                    }
                    if let Ok(mut handle) = capture_shared.network.lock() {
                        handle.take();
                    }
                })?,
        );
        for listener in listeners {
            let s = shared.clone();
            engine.workers.push(tokio::spawn(async move {
                if let Err(error) = accept_loop(s.clone(), listener).await {
                    s.stop_now(Some(error));
                }
            }));
        }
        let s = shared.clone();
        engine.workers.push(tokio::spawn(async move {
            if let Err(error) = reply_loop(s.clone(), receiver).await {
                s.stop_now(Some(error));
            }
        }));
        let s = shared.clone();
        engine.workers.push(tokio::task::spawn_blocking(move || {
            if let Err(error) = attribution_loop(&s) {
                s.stop_now(Some(error));
            }
        }));
        Ok(engine)
    }
    pub fn counts(&self) -> (u64, u64) {
        (
            self.shared.packets.load(Ordering::Relaxed),
            self.shared.bytes.load(Ordering::Relaxed),
        )
    }
    pub fn failure(&self) -> Result<Option<Error>> {
        if !self.shared.stopping.load(Ordering::Acquire)
            && self.workers.iter().any(JoinHandle::is_finished)
        {
            self.shared.stop_now(Some(Error::invalid(
                "Capture background task ended unexpectedly.",
            )));
        }
        if let Some(monitor) = &self.monitor {
            let failure = match monitor.conflict(None, None) {
                Ok(Some(handle)) => Some(native::capture_availability::conflict_message(&handle)),
                Ok(None) => None,
                Err(error) => Some(error),
            };
            if let Some(error) = failure {
                // A failed observer cannot authorize continued capture from its
                // last cached ownership inventory.
                self.shared.stop_now(Some(error));
            }
        }
        self.shared
            .failure
            .lock()
            .map(|f| f.clone())
            .map_err(|_| lock_error())
    }
    pub fn last_error(&self) -> Result<Option<Error>> {
        self.shared
            .last_error
            .lock()
            .map(|f| f.clone())
            .map_err(|_| lock_error())
    }
    pub fn clear_error(&self) -> Result<()> {
        *self.shared.last_error.lock().map_err(|_| lock_error())? = None;
        Ok(())
    }
    pub fn interfaces(&self) -> Result<InterfaceOptions> {
        self.shared
            .state
            .lock()
            .map(|s| s.options.clone())
            .map_err(|_| lock_error())
    }
    pub async fn apply(&mut self, plan: Plan, core_pids: &[u32], owned: Vec<String>) -> Result<()> {
        if self.shared.stopping.load(Ordering::Acquire) {
            return Err(Error::invalid("Capture is not running."));
        }
        native::drivers::check_loaded()?;
        if let Some(foreign) = self
            .monitor
            .as_ref()
            .map(|m| m.conflict(None, None))
            .transpose()?
            .flatten()
        {
            return Err(native::capture_availability::conflict_message(&foreign));
        }
        let policy = Arc::new(Policy {
            rules: Arc::new(SharedPolicy::new(plan.clone())?),
            excluded: excluded(core_pids)?,
        });
        let shared = self.shared.clone();
        let candidate = policy.clone();
        let owners = tokio::task::spawn_blocking(move || {
            shared.source.lock().map_err(|_| lock_error())?.read(
                Some(candidate.rules.clone()),
                &candidate.excluded,
                false,
            )
        })
        .await
        .map_err(|_| Error::invalid("Capture attribution refresh panicked."))??;
        let adapters = native::adapters::read()?;
        let options = interfaces::discover(&plan.interfaces, &adapters);
        let next = Arc::new(InterfacePolicy::new(
            &options,
            &adapters,
            plan.bypass_local_traffic,
            &owned,
        )?);
        let mut state = self.shared.state.lock().map_err(|_| lock_error())?;
        if self.shared.stopping.load(Ordering::Acquire) {
            return Err(Error::invalid("Capture is stopping."));
        }
        self.shared.publish(Arc::new(Routing {
            policy: policy.clone(),
            owners: Arc::new(owners),
        }))?;
        state.options = options;
        state.owned = owned;
        state.bypass_local = plan.bypass_local_traffic;
        state.version = state.version.wrapping_add(1);
        let mut batch = PacketBatch::default();
        retire_interfaces(&self.shared, &mut state, next, &mut batch)?;
        self.shared.reset(
            self.shared
                .nat
                .retain(Some(&policy.rules), |_| true, clock::milliseconds())?,
            &mut batch,
        );
        state.udp.retain(|_, session| {
            if policy.rules.retains(&session.rule) {
                true
            } else {
                session.cancel();
                false
            }
        });
        self.shared.flush(&mut batch)?;
        Ok(())
    }
    pub async fn close(&mut self) -> Result<()> {
        self.shared.stop_now(None);
        let mut failures = Vec::new();
        if let Some(reader) = self.capture.take() {
            let result = tokio::task::spawn_blocking(move || reader.join())
                .await
                .map_err(|_| lock_error())
                .and_then(|r| r.map_err(|_| Error::invalid("Capture thread panicked.")));
            if let Err(error) = result {
                failures.push(error);
            }
        }
        for worker in self.workers.drain(..) {
            if worker.await.is_err() {
                failures.push(Error::invalid("Capture worker task panicked."));
            }
        }
        let tasks = match self.shared.sessions.lock() {
            Ok(mut tasks) => std::mem::take(&mut *tasks),
            Err(_) => {
                failures.push(lock_error());
                Vec::new()
            }
        };
        for task in tasks {
            if task.await.is_err() {
                failures.push(Error::invalid("Capture relay task panicked."));
            }
        }
        if let Err(error) = self
            .shared
            .source
            .lock()
            .map_err(|_| lock_error())
            .and_then(|mut source| source.close())
        {
            failures.push(error);
        }
        // All producers/readers have joined. Close exactly this NETWORK handle
        // before relinquishing its shared lease, even after another cleanup fails.
        match self.shared.network.lock() {
            Ok(mut handle) => {
                handle.take();
            }
            Err(_) => failures.push(lock_error()),
        }
        if let Some(mut firewall) = self.firewall.take() {
            if let Err(error) = firewall.close() {
                failures.push(error);
            }
        }
        if let Some(mut monitor) = self.monitor.take() {
            if let Err(error) = monitor.close() {
                failures.push(error);
            }
        }
        self.lease.take();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(Error::invalid(
                failures
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(" Cleanup: "),
            ))
        }
    }
}
impl Drop for CaptureEngine {
    fn drop(&mut self) {
        self.shared.stop_now(None);
    }
}
fn excluded(pids: &[u32]) -> Result<Vec<ProcessKey>> {
    if pids.is_empty()
        || pids.len() > 3
        || pids.contains(&0)
        || pids.iter().enumerate().any(|(i, p)| pids[..i].contains(p))
    {
        return Err(Error::invalid("Invalid owned core processes."));
    }
    let mut all = pids.to_vec();
    all.push(std::process::id());
    all.sort();
    all.dedup();
    all.into_iter()
        .map(|pid| {
            native::processes::read_key(pid)
                .ok_or_else(|| Error::invalid("Cannot verify an excluded routing process."))
        })
        .collect()
}

fn process_owned(
    shared: &Arc<Shared>,
    state: &mut State,
    mut packet: PendingPacket,
    batch: &mut PacketBatch,
) -> Result<()> {
    if matches!(
        state.process(
            shared,
            &mut packet.bytes,
            packet.address,
            &packet.fragments,
            packet.arrived,
            batch
        )?,
        Outcome::Deferred
    ) && !state.pending.push(packet)
    {
        return Err(Error::invalid(
            "Application ownership pending queue is full; packet blocked.",
        ));
    }
    Ok(())
}
fn captured(
    shared: &Arc<Shared>,
    state: &mut State,
    bytes: &mut [u8],
    address: DivertAddress,
    batch: &mut PacketBatch,
) -> Result<()> {
    let interfaces = shared.interfaces()?;
    let fragments = state.fragments.add(
        bytes,
        address,
        clock::milliseconds(),
        |address, protocol, local, remote| {
            (!interfaces.monitors(address.interface(), local.ip.is_ipv6())
                || interfaces.bypasses_address(address.interface(), remote.ip))
                && (!matches!(protocol, 6 | 60)
                    || !shared.nat.may_be_reflection(local, remote).unwrap_or(true))
        },
    )?;
    match fragments {
        FragmentResult::Ordinary => {
            let arrived = clock::milliseconds();
            if matches!(
                state.process(shared, bytes, address, &[], arrived, batch)?,
                Outcome::Deferred
            ) {
                if !state.pending.push(PendingPacket {
                    bytes: bytes.to_vec(),
                    address,
                    arrived,
                    fragments: Vec::new(),
                }) {
                    return Err(Error::invalid(
                        "Application ownership pending queue is full; packet blocked.",
                    ));
                }
                shared.refresh.notify_one();
            }
        }
        FragmentResult::Buffered => {}
        FragmentResult::Complete(packet) => {
            if packet.pass_through {
                for (bytes, address) in packet.originals {
                    batch.add(&bytes, address, &mut |p, a| shared.send_batch(p, a, false))?;
                }
            } else {
                process_owned(
                    shared,
                    state,
                    PendingPacket {
                        bytes: packet.packet,
                        address: packet.address,
                        arrived: clock::milliseconds(),
                        fragments: packet.originals,
                    },
                    batch,
                )?;
                shared.refresh.notify_one();
            }
        }
    }
    Ok(())
}
fn capture_loop(shared: &Arc<Shared>) -> Result<()> {
    let handle = shared
        .network
        .lock()
        .map_err(|_| lock_error())?
        .as_ref()
        .cloned()
        .ok_or_else(|| Error::invalid("Capture handle unavailable."))?;
    let mut bytes = vec![0; batch::BUFFER_LENGTH];
    let mut addresses = [DivertAddress::default(); batch::CAPACITY];
    let mut lengths = [0; batch::CAPACITY];
    let mut output = PacketBatch::default();
    while !shared.stopping.load(Ordering::Acquire) {
        let (count, address_length) = match handle.receive(&mut bytes, &mut addresses) {
            Ok(value) => value,
            Err(_) if shared.stopping.load(Ordering::Acquire) => break,
            Err(error) => return Err(error),
        };
        let packets = batch::read_lengths(&bytes[..count], address_length, &mut lengths)?;
        shared.packets.fetch_add(packets as u64, Ordering::Relaxed);
        shared.bytes.fetch_add(count as u64, Ordering::Relaxed);
        let mut state = shared.state.lock().map_err(|_| lock_error())?;
        let mut offset = 0;
        for i in 0..packets {
            if shared.stopping.load(Ordering::Acquire) {
                break;
            }
            let end = offset + lengths[i];
            if let Err(error) = captured(
                shared,
                &mut state,
                &mut bytes[offset..end],
                addresses[i],
                &mut output,
            ) {
                shared.report(error);
            }
            offset = end;
        }
        if let Err(error) = shared.flush(&mut output) {
            shared.report(error);
        }
    }
    Ok(())
}
fn retire_interfaces(
    shared: &Arc<Shared>,
    state: &mut State,
    next: Arc<InterfacePolicy>,
    batch: &mut PacketBatch,
) -> Result<()> {
    let previous = shared.interfaces()?;
    if *previous == *next {
        return Ok(());
    }
    *shared.interfaces.write().map_err(|_| lock_error())? = next.clone();
    let retain = |index, six| next.retains(&previous, index, six);
    state.fragments.retain_interfaces(retain);
    for _ in 0..state.pending.len() {
        if let Some(packet) = state.pending.pop() {
            if retain(packet.address.interface(), packet.bytes[0] >> 4 == 6) {
                state.pending.push(packet);
            }
        }
    }
    shared.reset(
        shared.nat.retain(
            Some(&shared.routing()?.policy.rules),
            |e| retain(e.original_address.interface(), e.flow.local.ip.is_ipv6()),
            clock::milliseconds(),
        )?,
        batch,
    );
    state.udp.retain(|key, session| {
        if retain(key.interface, key.local.ip.is_ipv6()) {
            true
        } else {
            session.cancel();
            false
        }
    });
    Ok(())
}
fn attribution_loop(shared: &Arc<Shared>) -> Result<()> {
    let mut stop = shared.stop.subscribe();
    let (mut last, mut last_adapters, mut last_cleanup) =
        (clock::milliseconds(), 0, clock::milliseconds());
    let mut batch = PacketBatch::default();
    loop {
        let pending = !shared
            .state
            .lock()
            .map_err(|_| lock_error())?
            .pending
            .is_empty();
        let period = if pending { 25 } else { 100 };
        let stopped=shared.runtime.block_on(async {tokio::select!{_=cancelled(&mut stop)=>return true,_=shared.refresh.notified()=>{},_=tokio::time::sleep(Duration::from_millis(period))=>{}}let delay=period.saturating_sub(clock::milliseconds().saturating_sub(last));if delay>0{tokio::select!{_=cancelled(&mut stop)=>return true,_=tokio::time::sleep(Duration::from_millis(delay))=>{}}}false});
        if stopped {
            return Ok(());
        }
        let previous = shared.routing()?;
        let snapshot = shared.source.lock().map_err(|_| lock_error())?.read(
            Some(previous.policy.rules.clone()),
            &previous.policy.excluded,
            pending,
        )?;
        last = clock::milliseconds();
        let adapter_state = if last.saturating_sub(last_adapters) >= 1000 {
            let (version, options, bypass, owned) = {
                let state = shared.state.lock().map_err(|_| lock_error())?;
                (
                    state.version,
                    state.options.clone(),
                    state.bypass_local,
                    state.owned.clone(),
                )
            };
            let adapters = native::adapters::read()?;
            let options = interfaces::discover(&options, &adapters);
            let next = Arc::new(InterfacePolicy::new(&options, &adapters, bypass, &owned)?);
            last_adapters = last;
            Some((version, options, next))
        } else {
            None
        };
        let mut state = shared.state.lock().map_err(|_| lock_error())?;
        if !Arc::ptr_eq(&previous.policy, &shared.routing()?.policy) {
            continue;
        }
        shared.publish(Arc::new(Routing {
            policy: previous.policy.clone(),
            owners: Arc::new(snapshot),
        }))?;
        if let Some((version, options, next)) = adapter_state {
            if version == state.version {
                state.options = options;
                retire_interfaces(shared, &mut state, next, &mut batch)?;
            }
        }
        for _ in 0..state.pending.len() {
            if let Some(packet) = state.pending.pop() {
                if let Err(error) = process_owned(shared, &mut state, packet, &mut batch) {
                    shared.report(error);
                }
            }
        }
        if last.saturating_sub(last_cleanup) >= 10000 {
            shared.nat.expire(last)?;
            state.fragments.expire(last);
            let mut dead = Vec::new();
            for (key, session) in &state.udp {
                if session.can_retire()? {
                    dead.push(key.clone());
                }
            }
            for key in dead {
                if let Some(session) = state.udp.remove(&key) {
                    session.cancel();
                }
            }
            last_cleanup = last;
        }
        if let Err(error) = shared.flush(&mut batch) {
            shared.report(error);
        }
    }
}
async fn reply_loop(
    shared: Arc<Shared>,
    mut receiver: mpsc::Receiver<Envelope<Reply>>,
) -> Result<()> {
    let mut stop = shared.stop.subscribe();
    let mut batch = PacketBatch::default();
    let mut ready = Vec::with_capacity(batch::CAPACITY);
    loop {
        let first = tokio::select! {_=cancelled(&mut stop)=>break,packet=receiver.recv()=>match packet{Some(packet)=>packet,None=>break}};
        ready.push(first);
        while ready.len() < batch::CAPACITY {
            match receiver.try_recv() {
                Ok(packet) => ready.push(packet),
                Err(_) => break,
            }
        }
        {
            let _state = shared.state.lock().map_err(|_| lock_error())?;
            let result = (|| {
                for packet in &ready {
                    let packet = packet.value();
                    if shared.stopping.load(Ordering::Acquire) {
                        break;
                    }
                    if udp::Owner::current(packet.owner.as_ref())? {
                        batch.add(packet.bytes.bytes(), packet.address, &mut |p, a| {
                            shared.send_batch(p, a, false)
                        })?;
                    }
                }
                shared.flush(&mut batch)
            })();
            if let Err(error) = result {
                batch.discard();
                shared.report(error);
            }
        }
        ready.clear();
    }
    receiver.close();
    while receiver.try_recv().is_ok() {}
    Ok(())
}
fn socket_address(address: SocketAddr) -> Address {
    Address {
        ip: address.ip(),
        scope: match address {
            SocketAddr::V6(a) => a.scope_id(),
            _ => 0,
        },
    }
}
async fn accept_loop(shared: Arc<Shared>, listener: TcpListener) -> Result<()> {
    let mut stop = shared.stop.subscribe();
    let mut clients = JoinSet::new();
    let result: Result<()> = async {
        loop {
            let(client,remote)=tokio::select!{_=cancelled(&mut stop)=>break,result=listener.accept()=>match result{Ok(client)=>client,Err(error) if matches!(error.raw_os_error(),Some(10054|10053))=>continue,Err(error)=>return Err(error.into())},Some(result)=clients.join_next()=>{result.map_err(|_|Error::invalid("TCP relay task panicked."))?;continue;}};
            let local=client.local_addr()?;
            let Some(entry)=shared.nat.reverse(socket_address(local),socket_address(remote),remote.port())?else{continue;};
            if entry.closed() || entry.accepted(){continue;}
            let Ok(permit)=shared.tcp_slots.clone().try_acquire_owned()else{continue;};entry.set_accepted(true);
            let shared=shared.clone();clients.spawn(async move{let _permit=permit;relay(shared,client,entry).await;});
        }
        Ok(())
    }.await;
    // A failed listener must cancel live relays before joining them. Waiting
    // here before publishing failure could otherwise stall shutdown forever.
    if let Err(error) = &result {
        shared.stop_now(Some(error.clone()));
    }
    while let Some(result) = clients.join_next().await {
        if result.is_err() {
            shared.report(Error::invalid("TCP relay task panicked."));
        }
    }
    result
}
async fn relay(shared: Arc<Shared>, mut client: TcpStream, entry: Arc<NatEntry>) {
    let run = async {
        let mut entry_stop = entry.begin_relay()?;
        let mut engine_stop = shared.stop.subscribe();
        let transfer = async {
            let endpoint = entry
                .rule
                .endpoint
                .as_ref()
                .ok_or_else(|| Error::invalid("TCP route lacks a concrete relay."))?;
            let mut proxy = tokio::time::timeout(
                Duration::from_secs(15),
                socks::connect_tcp(endpoint, entry.flow.remote.socket(entry.flow.remote_port)),
            )
            .await
            .map_err(|_| Error::invalid("Application route connection timed out."))??;
            // Match NetworkStream.CopyToAsync's effective 128-KiB ArrayPool
            // rental and preserve the existing sockets' Nagle defaults.
            tokio::io::copy_bidirectional_with_sizes(&mut client, &mut proxy, 131072, 131072)
                .await?;
            Ok(())
        };
        tokio::select! {_=cancelled(&mut entry_stop)=>Ok(()),_=cancelled(&mut engine_stop)=>Ok(()),result=transfer=>result}
    };
    if let Err(error) = run.await {
        shared.report(error);
    }
    entry.set_closed(true);
    entry.touch(clock::milliseconds());
}
