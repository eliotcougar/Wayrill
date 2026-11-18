// SPDX-License-Identifier: GPL-3.0-only
//! Authenticated loopback attribution for the private TUN core. This bridge
//! observes identities only: it never captures packets or modifies adapters.
use crate::{
    address::Address,
    attribution::AttributionSnapshot,
    nat_sessions::{Index as NatIndex, Origin},
    native::{self, attribution_source::AttributionSource, clock},
    packet::Flow,
    policy::{Endpoint, Input, InterfaceOptions, Plan, Selector, SharedPolicy},
    process::{ApplicationProof, Decision, Kind, ProcessKey},
    Error, Result,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{oneshot, watch, Notify, Semaphore},
    task::{JoinHandle, JoinSet},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunInput {
    source: String,
    tag: String,
    selectors: Vec<Selector>,
    ports: String,
    networks: Vec<String>,
    predicates: Vec<Vec<Selector>>,
    masks: Vec<String>,
    #[serde(default)]
    nat_tag: Option<String>,
    #[serde(default)]
    ambiguous_mask: Option<String>,
}
impl TunInput {
    fn policy(self) -> Result<(Arc<SharedPolicy>, String)> {
        if self.source != "tun"
            || self.predicates.len() > 768
            || self.predicates.iter().map(Vec::len).sum::<usize>() > 4096
            || !self.selectors.is_empty()
            || !self.ports.is_empty()
            || self.networks != ["tcp", "udp"]
            || self
                .nat_tag
                .as_deref()
                .is_some_and(|tag| !matches!(tag, "wr-n" | "wayrill-runtime-nat"))
        {
            return Err(Error::invalid("Invalid TUN application scope."));
        }
        let digits = self.predicates.len().div_ceil(4).max(1);
        if let Some(mask) = &self.ambiguous_mask {
            if mask.len() < digits
                || mask.len() > 192
                || !mask
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || self
                    .masks
                    .iter()
                    .any(|m| m.trim_start_matches('0') == mask.trim_start_matches('0'))
            {
                return Err(Error::invalid("Invalid ambiguous TUN identity profile."));
            }
        }
        let zero = "0".repeat(self.ambiguous_mask.as_ref().map_or(digits, String::len));
        let rules = SharedPolicy::new(Plan {
            inputs: vec![Input {
                tag: self.tag,
                selectors: Vec::new(),
                ports: String::new(),
                networks: self.networks,
                endpoint: Endpoint {
                    port: 0,
                    username: String::new(),
                    password: String::new(),
                },
                predicates: self.predicates,
                masks: self.masks,
            }],
            interfaces: InterfaceOptions::default(),
            bypass_local_traffic: false,
        })?;
        Ok((Arc::new(rules.with_application_log()), zero))
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeEndpoint {
    pub port: u16,
    pub secret: String,
    pub width: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nat_tag: Option<String>,
}
#[derive(Default)]
struct Published {
    snapshot: Option<Arc<AttributionSnapshot>>,
    failure: Option<Error>,
}
#[derive(Default)]
struct Rejections {
    last: AtomicU64,
    pending: AtomicU64,
}
impl Rejections {
    fn record(&self, now: u64) -> Option<u64> {
        self.pending.fetch_add(1, Ordering::Relaxed);
        let last = self.last.load(Ordering::Relaxed);
        if (last == 0 || now.saturating_sub(last) >= 10_000)
            && self
                .last
                .compare_exchange(last, now.max(1), Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            Some(self.pending.swap(0, Ordering::Relaxed))
        } else {
            None
        }
    }
}
struct State {
    rejections: Rejections,
    ambiguous_mask: Option<String>,
    published: RwLock<Published>,
    changed: Arc<Notify>,
    udp_changed: Notify,
    snapshot_ready: Notify,
    secret: [u8; 32],
    zero: String,
    nat: RwLock<NatPublished>,
    nat_changed: Arc<Notify>,
}
#[derive(Default)]
struct NatPublished {
    started: u64,
    read_at: u64,
    index: Option<NatIndex>,
}
impl NatPublished {
    fn find(&self, flow: Flow, arrived: u64, now: u64) -> Result<Option<Origin>> {
        if self.started < arrived || now.saturating_sub(self.read_at) > 500 {
            return Ok(None);
        }
        self.index
            .as_ref()
            .map(|index| index.find(flow))
            .transpose()
            .map(Option::flatten)
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    mask: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<Origin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    application_proof: Option<Arc<ApplicationProof>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    udp_owner: Option<UdpOwner>,
}

#[derive(Clone, Copy, Serialize)]
struct UdpOwner {
    pid: u32,
    started: i64,
    endpoint: u64,
}

#[derive(Clone)]
enum LocalOwnership {
    Verified(Identity),
    Absent,
    Ambiguous,
    Pending(&'static str),
}

#[derive(Serialize)]
struct UdpReply<'a> {
    index: usize,
    identity: &'a Identity,
}
// Verify every ordinary process generation, including unmatched ones: a PID
// reused after the ownership sample must not inherit an old default identity.
fn identity_for(
    decision: Decision,
    zero: &str,
    read_key: impl FnOnce(u32) -> Option<ProcessKey>,
) -> Option<Identity> {
    if !matches!(decision.kind, Kind::Selected | Kind::Unselected) {
        return None;
    }
    let udp_owner = if let Some(key) = decision.process {
        if read_key(key.pid) != Some(key) {
            return None;
        }
        Some(UdpOwner {
            pid: key.pid,
            started: key.started,
            endpoint: decision.endpoint,
        })
    } else {
        None
    };
    match decision.kind {
        Kind::Unselected => Some(Identity {
            mask: zero.to_owned(),
            origin: None,
            application_proof: None,
            udp_owner,
        }),
        Kind::Selected if decision.process.is_some() => decision.rule.map(|rule| Identity {
            mask: format!(
                "{:0>width$}",
                rule.id.rsplit(':').next().unwrap_or(zero),
                width = zero.len()
            ),
            origin: None,
            application_proof: decision.application_proof,
            udp_owner,
        }),
        _ => None,
    }
}
impl State {
    fn snapshot(&self) -> Result<Option<Arc<AttributionSnapshot>>> {
        let state = self
            .published
            .read()
            .map_err(|_| Error::invalid("TUN attribution state poisoned."))?;
        if let Some(error) = &state.failure {
            return Err(Error::invalid(format!(
                "TUN application attribution failed: {error}"
            )));
        }
        Ok(state.snapshot.clone())
    }
    fn fail(&self, error: Error) {
        if let Ok(mut state) = self.published.write() {
            if state.failure.is_none() {
                state.failure = Some(error);
            }
        }
        self.snapshot_ready.notify_waiters();
    }
    async fn find(&self, flow: Flow) -> Result<Identity> {
        let arrived = clock::milliseconds();
        let mut reason = "no fresh ownership snapshot";
        loop {
            let now = clock::milliseconds();
            if now.saturating_sub(arrived) >= 1400 {
                return Err(Error::invalid(format!(
                    "TUN flow ownership could not be established: {reason}."
                )));
            }
            self.changed.notify_one();
            let snapshot = self.snapshot()?;
            if let Some(snapshot) = snapshot.filter(|s| s.is_fresh(now, arrived)) {
                match self.local_ownership(&snapshot, flow) {
                    LocalOwnership::Verified(identity) => return Ok(identity),
                    LocalOwnership::Ambiguous => {
                        return Err(Error::invalid("Ambiguous TUN flow ownership."));
                    }
                    LocalOwnership::Pending(waiting) => reason = waiting,
                    LocalOwnership::Absent => {
                        reason = "socket absent from native ownership tables and NAT not proven";
                        if let Some(identity) = self.forwarded(flow, arrived, now)? {
                            return Ok(identity);
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    }

    fn local_ownership(&self, snapshot: &AttributionSnapshot, flow: Flow) -> LocalOwnership {
        let decision = snapshot.find(flow, 0);
        if decision.kind == Kind::Ambiguous {
            return match &self.ambiguous_mask {
                Some(mask) => LocalOwnership::Verified(Identity {
                    mask: mask.clone(),
                    origin: None,
                    application_proof: None,
                    udp_owner: None,
                }),
                None => LocalOwnership::Ambiguous,
            };
        }
        if !snapshot.has_local_record(flow) {
            return LocalOwnership::Absent;
        }
        if decision.service_pending {
            return LocalOwnership::Pending("service identity unresolved");
        }
        if !matches!(decision.kind, Kind::Selected | Kind::Unselected) {
            return LocalOwnership::Pending("process identity or ancestry unresolved");
        }
        identity_for(decision, &self.zero, native::processes::read_key)
            .map(LocalOwnership::Verified)
            .unwrap_or(LocalOwnership::Pending(
                "process generation changed or mask missing",
            ))
    }

    fn forwarded(&self, flow: Flow, arrived: u64, now: u64) -> Result<Option<Identity>> {
        // Only a fresh, complete NAT inventory may prove this translated tuple.
        let nat = self
            .nat
            .read()
            .map_err(|_| Error::invalid("NAT state poisoned."))?;
        if let Some(origin) = nat.find(flow, arrived, now)? {
            return Ok(Some(Identity {
                mask: self.zero.clone(),
                origin: Some(origin),
                application_proof: None,
                udp_owner: None,
            }));
        }
        self.nat_changed.notify_one();
        Ok(None)
    }

    async fn serve_udp(
        &self,
        mut flows: Vec<(usize, Flow)>,
        stream: &mut TcpStream,
        first_pass: bool,
    ) -> Result<()> {
        let arrived = clock::milliseconds();
        let mut encoded = Vec::new();
        let mut pending = Vec::with_capacity(flows.len());
        while !flows.is_empty() {
            let ready = self.snapshot_ready.notified();
            let now = clock::milliseconds();
            if now.saturating_sub(arrived) >= 1400 {
                self.log_rejection(
                    "UDP ownership could not be established for the remaining destinations.",
                );
                break;
            }
            if let Some(snapshot) = self
                .snapshot()?
                .filter(|s| s.read_at > arrived && s.is_fresh(now, arrived))
            {
                // Native UDP bindings and the validated TUN process policy
                // are destination-independent for nonzero ports. This cache
                // exists only while evaluating this freshly acquired snapshot.
                let mut local = HashMap::new();
                let share = snapshot.can_share_tun_udp_owner();
                for (index, flow) in flows.drain(..) {
                    let ownership = if share {
                        local
                            .entry((flow.local, flow.local_port))
                            .or_insert_with(|| self.local_ownership(&snapshot, flow))
                            .clone()
                    } else {
                        self.local_ownership(&snapshot, flow)
                    };
                    let identity = match ownership {
                        LocalOwnership::Verified(identity) => Some(identity),
                        LocalOwnership::Absent => self.forwarded(flow, arrived, now)?,
                        LocalOwnership::Pending(_) => None,
                        LocalOwnership::Ambiguous => {
                            self.log_rejection("Ambiguous TUN flow ownership.");
                            continue;
                        }
                    };
                    if let Some(mut identity) = identity {
                        let start = encoded.len();
                        serde_json::to_writer(
                            &mut encoded,
                            &UdpReply {
                                index,
                                identity: &identity,
                            },
                        )?;
                        if encoded.len() - start >= 4096 {
                            encoded.truncate(start);
                            identity.application_proof = None;
                            serde_json::to_writer(
                                &mut encoded,
                                &UdpReply {
                                    index,
                                    identity: &identity,
                                },
                            )?;
                        }
                        encoded.push(b'\n');
                    } else if first_pass {
                        serde_json::to_writer(
                            &mut encoded,
                            &serde_json::json!({ "index": index, "pending": true }),
                        )?;
                        encoded.push(b'\n');
                    } else {
                        pending.push((index, flow));
                    }
                }
                if !encoded.is_empty() {
                    stream.write_all(&encoded).await?;
                    encoded.clear();
                }
                std::mem::swap(&mut flows, &mut pending);
            }
            if !flows.is_empty() {
                self.udp_changed.notify_one();
                tokio::select! {
                    _ = ready => {},
                    _ = tokio::time::sleep(Duration::from_millis(40)) => {},
                }
            }
        }
        Ok(())
    }

    fn log_rejection(&self, error: impl std::fmt::Display) {
        if let Some(count) = self.rejections.record(clock::milliseconds()) {
            eprintln!("TUN attribution rejected request ({count} since last report): {error}");
        }
    }
}

async fn wait_for_refresh(
    state: &State,
    stopping: &mut watch::Receiver<bool>,
    read_at: u64,
) -> bool {
    let urgent = tokio::select! {
        biased;
        _ = stopping.changed() => return true,
        _ = state.udp_changed.notified() => true,
        _ = state.changed.notified() => false,
        _ = tokio::time::sleep(Duration::from_secs(1)) => false,
    };
    let remaining = |minimum: u64| {
        Duration::from_millis(minimum.saturating_sub(clock::milliseconds().saturating_sub(read_at)))
    };
    if !urgent {
        tokio::select! {
            biased;
            _ = stopping.changed() => return true,
            _ = state.udp_changed.notified() => {},
            _ = tokio::time::sleep(remaining(100)) => return false,
        }
    }
    // Coalesce native table reads while UDP ownership requests are waiting.
    tokio::select! {
        biased;
        _ = stopping.changed() => true,
        _ = tokio::time::sleep(remaining(25)) => false,
    }
}

pub struct TunApplications {
    state: Arc<State>,
    endpoint: BridgeEndpoint,
    stop: watch::Sender<bool>,
    accept: Option<JoinHandle<Result<()>>>,
    refresh: Option<JoinHandle<Result<()>>>,
    nat_refresh: Option<JoinHandle<()>>,
    nat_cancellation: native::nat_sessions::Cancellation,
}
impl TunApplications {
    pub async fn start(input: TunInput) -> Result<Self> {
        let nat_tag = input.nat_tag.clone();
        let ambiguous_mask = input.ambiguous_mask.clone();
        let (rules, zero) = input.policy()?;
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(|error| {
            Error::invalid(format!("TUN attribution random source failed: {error}"))
        })?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let endpoint = BridgeEndpoint {
            port: listener.local_addr()?.port(),
            secret: secret.iter().map(|b| format!("{b:02x}")).collect(),
            width: zero.len(),
            nat_tag,
        };
        let state = Arc::new(State {
            rejections: Rejections::default(),
            ambiguous_mask,
            published: RwLock::new(Published::default()),
            changed: Arc::new(Notify::new()),
            udp_changed: Notify::new(),
            snapshot_ready: Notify::new(),
            secret,
            zero,
            nat: RwLock::new(NatPublished::default()),
            nat_changed: Arc::new(Notify::new()),
        });
        let (stop, stopping) = watch::channel(false);
        let (ready, started) = oneshot::channel();
        let (worker_state, mut worker_stop) = (state.clone(), stopping.clone());
        let runtime = tokio::runtime::Handle::current();
        // One dedicated native refresh task keeps Windows process/table reads
        // away from async clients. Event bursts are coalesced to at most 10 Hz.
        let refresh = tokio::task::spawn_blocking(move || {
            let mut ready = Some(ready);
            let mut source = None;
            let run = || -> Result<()> {
                source = Some(AttributionSource::new()?);
                let source = source.as_mut().unwrap();
                source.start_tun(worker_state.changed.clone())?;
                let mut flush = true;
                loop {
                    if *worker_stop.borrow() {
                        break;
                    }
                    let snapshot = Arc::new(source.read(Some(rules.clone()), &[], flush)?);
                    let read_at = snapshot.read_at;
                    worker_state
                        .published
                        .write()
                        .map_err(|_| Error::invalid("TUN attribution state poisoned."))?
                        .snapshot = Some(snapshot);
                    worker_state.snapshot_ready.notify_waiters();
                    if let Some(ready) = ready.take() {
                        if ready.send(Ok(())).is_err() {
                            break;
                        }
                    }
                    flush = false;
                    let should_stop = runtime.block_on(wait_for_refresh(
                        &worker_state,
                        &mut worker_stop,
                        read_at,
                    ));
                    if should_stop {
                        break;
                    }
                }
                Ok(())
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
                .unwrap_or_else(|_| Err(Error::invalid("TUN attribution refresh panicked.")));
            if let Err(error) = &result {
                worker_state.fail(error.clone());
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Err(error.clone()));
                }
            }
            // Runtime failure is published above. Retirement reports only a
            // failure to release resources, not the already-reported fault.
            source.as_mut().map_or(Ok(()), AttributionSource::close)
        });
        if let Err(error) = started
            .await
            .unwrap_or_else(|_| Err(Error::invalid("TUN attribution stopped during startup.")))
        {
            let _ = stop.send(true);
            let _ = refresh.await;
            return Err(error);
        }
        let server_state = state.clone();
        let nat_cancellation = native::nat_sessions::Cancellation::default();
        let (nat_state, mut nat_stop, nat_cancel) =
            (state.clone(), stopping.clone(), nat_cancellation.clone());
        let nat_runtime = tokio::runtime::Handle::current();
        let nat_refresh = tokio::task::spawn_blocking(move || {
            let mut reader = None;
            let mut last_read = 0;
            loop {
                if nat_runtime.block_on(async {
                    tokio::select! {
                        _=nat_stop.changed()=>true,
                        _=nat_state.nat_changed.notified()=>false,
                    }
                }) {
                    break;
                }
                let wait = 100u64.saturating_sub(clock::milliseconds().saturating_sub(last_read));
                if wait > 0
                    && nat_runtime.block_on(async {
                        tokio::select! {
                            _=nat_stop.changed()=>true,
                            _=tokio::time::sleep(Duration::from_millis(wait))=>false,
                        }
                    })
                {
                    break;
                }
                if *nat_stop.borrow() {
                    break;
                }
                let started = clock::milliseconds();
                let result = (|| -> Result<NatIndex> {
                    if reader.is_none() {
                        reader = Some(native::nat_sessions::Reader::new(nat_cancel.clone())?);
                    }
                    reader.as_mut().unwrap().read()
                })();
                if result.is_err() {
                    reader = None;
                }
                last_read = clock::milliseconds();
                if let Ok(mut state) = nat_state.nat.write() {
                    *state = NatPublished {
                        started,
                        read_at: last_read,
                        index: result.ok(),
                    };
                }
            }
        });
        let accept =
            tokio::spawn(async move { accept_loop(listener, server_state, stopping).await });
        Ok(Self {
            state,
            endpoint,
            stop,
            accept: Some(accept),
            refresh: Some(refresh),
            nat_refresh: Some(nat_refresh),
            nat_cancellation,
        })
    }
    pub fn endpoint(&self) -> &BridgeEndpoint {
        &self.endpoint
    }
    pub fn check_health(&self) -> Result<()> {
        // Preserve the actual native error before the generic ended-task check.
        self.state.snapshot()?;
        if self.accept.as_ref().is_some_and(|task| task.is_finished())
            || self.refresh.as_ref().is_some_and(|task| task.is_finished())
            || self
                .nat_refresh
                .as_ref()
                .is_some_and(|task| task.is_finished())
        {
            return Err(Error::invalid(
                "TUN attribution background task ended unexpectedly.",
            ));
        }
        Ok(())
    }
    pub async fn close(&mut self) -> Result<()> {
        let _ = self.stop.send(true);
        self.nat_cancellation.cancel();
        let accept = match self.accept.take() {
            Some(task) => task
                .await
                .map_err(|_| Error::invalid("TUN bridge listener panicked."))
                .and_then(|r| r),
            None => Ok(()),
        };
        let refresh = match self.refresh.take() {
            Some(task) => task
                .await
                .map_err(|_| Error::invalid("TUN attribution refresh panicked."))
                .and_then(|r| r),
            None => Ok(()),
        };
        let nat = match self.nat_refresh.take() {
            Some(mut task) => loop {
                tokio::select! {
                    result=&mut task=>break result.map_err(|_|Error::invalid("NAT refresh panicked.")),
                    // Cancellation can race entry into a COM call. Retry until the
                    // registered reader exits; no COM object leaves its apartment.
                    _=tokio::time::sleep(Duration::from_millis(50))=>self.nat_cancellation.cancel(),
                }
            },
            None => Ok(()),
        };
        accept?;
        refresh?;
        nat
    }
}
impl Drop for TunApplications {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        self.nat_cancellation.cancel();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Query {
    auth: String,
    network: String,
    source: String,
    source_port: u16,
    destination: String,
    destination_port: u16,
    #[serde(default)]
    include_application_proof: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UdpBatch {
    auth: String,
    udp: Vec<(String, u16, String, u16)>,
    #[serde(default, rename = "firstPass")]
    first_pass: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Request {
    Single(Query),
    Udp(UdpBatch),
}

fn query_flow(
    protocol: u8,
    source: &str,
    source_port: u16,
    target: &str,
    target_port: u16,
) -> Result<Flow> {
    if source_port == 0 || target_port == 0 {
        return Err(Error::invalid("Invalid TUN query port."));
    }
    Ok(Flow {
        protocol,
        local: address(source).ok_or_else(|| Error::invalid("Invalid TUN source address."))?,
        local_port: source_port,
        remote: address(target)
            .ok_or_else(|| Error::invalid("Invalid TUN destination address."))?,
        remote_port: target_port,
    })
}

fn auth(value: &str, secret: &[u8; 32]) -> bool {
    if value.len() != 64 {
        return false;
    }
    let mut decoded = [0u8; 32];
    let digit = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    for (pair, out) in value.as_bytes().as_chunks::<2>().0.iter().zip(&mut decoded) {
        let (Some(a), Some(b)) = (digit(pair[0]), digit(pair[1])) else {
            return false;
        };
        *out = (a << 4) | b;
    }
    // OR every byte rather than short-circuiting on the first secret mismatch.
    decoded
        .iter()
        .zip(secret)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}
fn address(value: &str) -> Option<Address> {
    let (text, scope) = match value.rsplit_once('%') {
        Some((ip, scope)) => (ip, scope.parse::<u32>().ok()?),
        None => (value, 0),
    };
    let ip = text.parse::<IpAddr>().ok()?;
    match ip {
        IpAddr::V4(_) if value.contains('%') => None,
        IpAddr::V6(ip) => Some(Address {
            ip: ip
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(ip)),
            scope: if ip.to_ipv4_mapped().is_some() {
                0
            } else {
                scope
            },
        }),
        _ => Some(Address { ip, scope }),
    }
}
async fn serve(mut stream: TcpStream, state: Arc<State>, mut stopping: watch::Receiver<bool>) {
    if *stopping.borrow() {
        return;
    }
    let request = async {
        const UDP_BATCH_LIMIT: usize = 512;
        let mut bytes = Vec::with_capacity(1024);
        BufReader::new((&mut stream).take(64 * 1024))
            .read_until(b'\n', &mut bytes)
            .await?;
        if bytes.last() != Some(&b'\n') {
            return Err(Error::invalid("Incomplete or oversized TUN query."));
        }
        let query = match serde_json::from_slice::<Request>(&bytes)? {
            Request::Single(query) if bytes.len() <= 1024 => query,
            Request::Single(_) => return Err(Error::invalid("TUN query exceeds capacity.")),
            Request::Udp(batch) => {
                if !auth(&batch.auth, &state.secret) {
                    return Err(Error::invalid("Invalid TUN query authentication."));
                }
                if !(1..=UDP_BATCH_LIMIT).contains(&batch.udp.len()) {
                    return Err(Error::invalid("Invalid TUN UDP batch size."));
                }
                let flows = batch
                    .udp
                    .into_iter()
                    .enumerate()
                    .filter_map(|(index, (source, port, target, target_port))| {
                        query_flow(17, &source, port, &target, target_port)
                            .ok()
                            .map(|flow| (index, flow))
                    })
                    .collect();
                return state.serve_udp(flows, &mut stream, batch.first_pass).await;
            }
        };
        if !auth(&query.auth, &state.secret) {
            return Err(Error::invalid("Invalid TUN query authentication."));
        }
        let protocol = match query.network.as_str() {
            "tcp" => 6,
            "udp" => 17,
            _ => return Err(Error::invalid("Invalid TUN query protocol.")),
        };
        let flow = query_flow(
            protocol,
            &query.source,
            query.source_port,
            &query.destination,
            query.destination_port,
        )?;
        let mut result = state.find(flow).await.inspect_err(|error| {
            // Only authenticated, valid ownership requests reach this point.
            // Bound repeated reports; never log the secret or destinations.
            state.log_rejection(error);
        })?;
        if !query.include_application_proof {
            result.application_proof = None;
        }
        if flow.protocol != 17 || !query.include_application_proof {
            result.udp_owner = None;
        }
        let mut response = serde_json::to_vec(&result)?;
        // Keep diagnostics within both the private reply and Xray log readers.
        // Oversized evidence must never prevent dispatch.
        if response.len() >= 4096 {
            result.application_proof = None;
            response = serde_json::to_vec(&result)?;
        }
        response.push(b'\n');
        stream.write_all(&response).await?;
        Ok::<_, Error>(())
    };
    tokio::select! {biased; _=stopping.changed()=>{},_=tokio::time::timeout(Duration::from_millis(1800),request)=>{}}
    // Invalid/expired/unresolved queries are closed without a fallback identity.
}
async fn accept_loop(
    listener: TcpListener,
    state: Arc<State>,
    mut stopping: watch::Receiver<bool>,
) -> Result<()> {
    if *stopping.borrow() {
        return Ok(());
    }
    let slots = Arc::new(Semaphore::new(32));
    let mut clients = JoinSet::new();
    let result=async {
        loop {
            let slot=tokio::select! {biased; _=stopping.changed()=>break,slot=slots.clone().acquire_owned()=>slot.map_err(|_|Error::invalid("TUN bridge slots closed."))?};
            let (client,_)=tokio::select! {
                biased;
                _=stopping.changed()=>break,
                result=listener.accept()=>result?,
                Some(result)=clients.join_next()=>{result.map_err(|_|Error::invalid("TUN bridge client panicked."))?;continue;},
            };
            let (state,stopping)=(state.clone(),stopping.clone());
            clients.spawn(async move {let _slot=slot;serve(client,state,stopping).await;});
            while let Some(result)=clients.try_join_next(){result.map_err(|_|Error::invalid("TUN bridge client panicked."))?;}
        }
        Ok::<_,Error>(())
    }.await;
    if let Err(error) = &result {
        state.fail(error.clone());
    }
    clients.abort_all();
    while clients.join_next().await.is_some() {}
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_matched_and_unmatched_tun_identities_verify_the_process_generation() {
        let key = ProcessKey {
            pid: 100,
            started: 1000,
        };
        let mut decision = Decision::new(Kind::Unselected);
        decision.process = Some(key);
        assert_eq!(
            identity_for(decision.clone(), "0", |_| Some(key))
                .unwrap()
                .mask,
            "0"
        );
        assert!(identity_for(decision.clone(), "0", |_| Some(ProcessKey {
            pid: 100,
            started: 1100
        }))
        .is_none());
        assert!(identity_for(decision.clone(), "0", |_| None).is_none());
        let policy = SharedPolicy::new(Plan {
            inputs: vec![Input {
                tag: "tun".into(),
                selectors: Vec::new(),
                ports: String::new(),
                networks: vec!["tcp".into(), "udp".into()],
                endpoint: Endpoint {
                    port: 0,
                    username: String::new(),
                    password: String::new(),
                },
                predicates: vec![vec![Selector {
                    kind: "process".into(),
                    value: "client.exe".into(),
                    mode: "name".into(),
                    children: false,
                    enabled: true,
                }]],
                masks: vec!["0".into(), "1".into()],
            }],
            interfaces: InterfaceOptions::default(),
            bypass_local_traffic: false,
        })
        .unwrap();
        decision.kind = Kind::Selected;
        decision.rule = policy
            .select(
                &[crate::policy::Identity::new(
                    "client.exe",
                    Some("C:/client.exe"),
                    Some(""),
                )],
                None,
            )
            .unwrap();
        assert_eq!(
            identity_for(decision.clone(), "0", |_| Some(key))
                .unwrap()
                .mask,
            "1"
        );
        assert!(identity_for(decision, "0", |_| None).is_none());
        assert!(
            identity_for(Decision::new(Kind::Unresolved), "0", |_| panic!(
                "must not query an unresolved process"
            ))
            .is_none()
        );
        let mut accepted = Decision::new(Kind::Unselected);
        accepted.accepted = true;
        assert_eq!(
            identity_for(accepted, "0", |_| panic!(
                "accepted/kernel traffic has no process key"
            ))
            .unwrap()
            .mask,
            "0"
        );
    }

    #[tokio::test]
    async fn only_explicit_ambiguity_can_return_the_reserved_identity() {
        let flow = Flow {
            protocol: 17,
            local: address("10.90.0.1").unwrap(),
            local_port: 50500,
            remote: address("203.0.113.5").unwrap(),
            remote_port: 443,
        };
        let rows = [1, 2].map(|pid| crate::attribution::OwnerRow {
            local: flow.local,
            port: flow.local_port,
            remote: None,
            remote_port: 0,
            pid,
            module: None,
            state: 0,
        });
        let snapshot = Arc::new(
            AttributionSnapshot::new(
                &[],
                &rows,
                |pid, _| {
                    Ok(Decision::new(if pid == 1 {
                        Kind::Selected
                    } else {
                        Kind::Unselected
                    }))
                },
                clock::milliseconds() + 2000,
                None,
            )
            .unwrap(),
        );
        assert_eq!(snapshot.find(flow, 0).kind, Kind::Ambiguous);
        let mut state = lifecycle_state();
        state.published.write().unwrap().snapshot = Some(snapshot);
        assert!(state
            .find(flow)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("Ambiguous TUN flow ownership"));
        Arc::get_mut(&mut state).unwrap().ambiguous_mask = Some("2".into());
        let identity = state.find(flow).await.unwrap();
        assert_eq!(identity.mask, "2");
        assert!(identity.origin.is_none());
        state.fail(Error::invalid("observer failed"));
        assert!(state
            .find(flow)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("observer failed"));
    }
    #[test]
    fn ambiguity_identity_cannot_collide_or_exceed_the_private_core_width() {
        let input = || serde_json::json!({"source":"tun","tag":"host","selectors":[],"ports":"","networks":["tcp","udp"],"predicates":[],"masks":["0"]});
        for mask in ["", "0", "00", "G", "f;", &"1".repeat(193)] {
            let mut value = input();
            value["ambiguousMask"] = serde_json::json!(mask);
            assert!(
                serde_json::from_value::<TunInput>(value)
                    .unwrap()
                    .policy()
                    .is_err(),
                "{mask}"
            );
        }
        let mut value = input();
        value["ambiguousMask"] = serde_json::json!("1");
        let (_, zero) = serde_json::from_value::<TunInput>(value)
            .unwrap()
            .policy()
            .unwrap();
        assert_eq!(zero, "0");
    }
    #[test]
    fn rejection_reports_are_bounded_and_count_suppressed_failures() {
        let reports = Rejections::default();
        assert_eq!(reports.record(100), Some(1));
        assert_eq!(reports.record(101), None);
        assert_eq!(reports.record(10_099), None);
        assert_eq!(reports.record(10_100), Some(3));
        assert_eq!(reports.record(10_101), None);
    }
    #[test]
    fn nat_requires_a_successful_complete_inventory_started_after_arrival() {
        let flow = Flow {
            protocol: 6,
            local: address("10.90.0.1").unwrap(),
            local_port: 50000,
            remote: address("203.0.113.1").unwrap(),
            remote_port: 443,
        };
        let mut published = NatPublished {
            started: 100,
            read_at: 150,
            index: Some(
                NatIndex::new([crate::nat_sessions::Session {
                    external: flow,
                    source: address("172.30.1.2").unwrap(),
                    source_port: 53000,
                    identity: "test/lease".into(),
                }])
                .unwrap(),
            ),
        };
        assert_eq!(
            published.find(flow, 100, 200).unwrap().unwrap().source,
            "172.30.1.2"
        );
        assert!(published.find(flow, 101, 200).unwrap().is_none());
        assert!(published.find(flow, 100, 651).unwrap().is_none());
        published.index = None;
        assert!(published.find(flow, 100, 200).unwrap().is_none());
    }
    #[test]
    fn unresolved_local_socket_is_not_a_forwarded_client() {
        let local = address("10.90.0.1").unwrap();
        let remote = address("203.0.113.1").unwrap();
        let flow = Flow {
            protocol: 6,
            local,
            local_port: 50000,
            remote,
            remote_port: 443,
        };
        let row = crate::attribution::OwnerRow {
            local,
            port: 50000,
            remote: Some(remote),
            remote_port: 443,
            pid: 123,
            module: None,
            state: 5,
        };
        let empty = AttributionSnapshot::new(&[], &[], |_, _| unreachable!(), 100, None).unwrap();
        let local = AttributionSnapshot::new(
            &[row],
            &[],
            |_, _| Ok(crate::process::Decision::new(Kind::Unresolved)),
            100,
            None,
        )
        .unwrap();
        assert!(!empty.has_local_record(flow));
        assert!(local.has_local_record(flow));
        assert_eq!(local.find(flow, 0).kind, Kind::Unresolved);
    }
    #[tokio::test]
    async fn failed_listener_is_unhealthy_even_with_a_cached_snapshot() {
        let (stop, stopping) = watch::channel(false);
        let state = Arc::new(State {
            rejections: Rejections::default(),
            ambiguous_mask: None,
            published: RwLock::new(Published::default()),
            changed: Arc::new(Notify::new()),
            udp_changed: Notify::new(),
            snapshot_ready: Notify::new(),
            secret: [0; 32],
            zero: "0".into(),
            nat: RwLock::new(NatPublished::default()),
            nat_changed: Arc::new(Notify::new()),
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let accept = tokio::spawn(accept_loop(listener, state.clone(), stopping));
        let mut app = TunApplications {
            state,
            endpoint: BridgeEndpoint {
                port: 0,
                secret: String::new(),
                width: 1,
                nat_tag: None,
            },
            stop,
            accept: Some(accept),
            refresh: None,
            nat_refresh: None,
            nat_cancellation: Default::default(),
        };
        app.accept.as_ref().unwrap().abort();
        while !app.accept.as_ref().unwrap().is_finished() {
            tokio::task::yield_now().await;
        }
        assert!(app.check_health().is_err());
        assert!(app.close().await.is_err());
    }
    #[test]
    fn auth_and_scoped_mapped_addresses_are_strict() {
        assert!(auth(&"11".repeat(32), &[0x11; 32]));
        assert!(!auth(&format!("{}12", "11".repeat(31)), &[0x11; 32]));
        assert!(!auth(&"gg".repeat(32), &[0; 32]));
        assert!(!auth("", &[0; 32]));
        assert_eq!(
            address("::ffff:127.2.3.4").unwrap().ip,
            "127.2.3.4".parse::<IpAddr>().unwrap()
        );
        assert_eq!(address("fe80::1%12").unwrap().scope, 12);
        assert!(address("host.example").is_none());
        assert!(address("127.0.0.1%12").is_none());
    }
    fn lifecycle_state() -> Arc<State> {
        Arc::new(State {
            rejections: Rejections::default(),
            ambiguous_mask: None,
            published: RwLock::new(Published::default()),
            changed: Arc::new(Notify::new()),
            udp_changed: Notify::new(),
            snapshot_ready: Notify::new(),
            secret: [0; 32],
            zero: "0".into(),
            nat: RwLock::new(NatPublished::default()),
            nat_changed: Arc::new(Notify::new()),
        })
    }

    #[tokio::test]
    async fn udp_batch_uses_fresh_bindings_and_sends_verified_peers_ahead_of_an_unresolved_one() {
        for first_pass in [true, false] {
            check_mixed_udp_batch(first_pass).await;
        }
    }

    async fn check_mixed_udp_batch(first_pass: bool) {
        use crate::attribution::OwnerRow;
        let state = lifecycle_state();
        let local = address("127.0.0.1").unwrap();
        let key = native::processes::read_key(std::process::id()).unwrap();
        let snapshot = |bind_port, read_at| {
            Arc::new(
                AttributionSnapshot::new(
                    &[],
                    &[OwnerRow {
                        local,
                        port: bind_port,
                        remote: None,
                        remote_port: 0,
                        pid: key.pid,
                        module: None,
                        state: 0,
                    }],
                    |_, _| {
                        let mut decision = Decision::new(Kind::Unselected);
                        decision.process = Some(key);
                        Ok(decision)
                    },
                    read_at,
                    None,
                )
                .unwrap(),
            )
        };
        state.published.write().unwrap().snapshot = Some(snapshot(12001, 0));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let (stop, stopping) = watch::channel(false);
        let server = tokio::spawn(serve(stream, state.clone(), stopping));
        let mut reader = BufReader::new(client);
        let request = serde_json::json!({
            "auth": "0".repeat(64),
            "firstPass": first_pass,
            "udp": [
                ["127.0.0.1", 0, "192.0.2.1", 53],
                ["127.0.0.1", 12001, "192.0.2.1", 53],
                ["127.0.0.1", 12002, "192.0.2.1", 53],
                ["127.0.0.1", 12002, "192.0.2.2", 443]
            ]
        });
        reader
            .get_mut()
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), state.udp_changed.notified())
            .await
            .unwrap();
        state.published.write().unwrap().snapshot =
            Some(snapshot(12002, clock::milliseconds() + 1));
        state.snapshot_ready.notify_waiters();
        if first_pass {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&line).unwrap(),
                serde_json::json!({"index":1, "pending":true})
            );
        }
        for index in [2, 3] {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_millis(500), reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap();
            let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(reply["index"], index);
            assert_eq!(reply["identity"]["udpOwner"]["pid"], key.pid);
            assert_eq!(reply["identity"]["udpOwner"]["started"], key.started);
        }
        if first_pass {
            let mut line = String::new();
            assert_eq!(reader.read_line(&mut line).await.unwrap(), 0);
        } else {
            stop.send(true).unwrap();
        }
        server.await.unwrap();
    }
    #[tokio::test]
    async fn reported_runtime_fault_does_not_become_a_retirement_failure() {
        let (stop, _) = watch::channel(false);
        let state = lifecycle_state();
        state.fail(Error::invalid("Original observer fault"));
        let mut app = TunApplications {
            state,
            endpoint: BridgeEndpoint {
                port: 0,
                secret: String::new(),
                width: 1,
                nat_tag: None,
            },
            stop,
            accept: None,
            refresh: Some(tokio::spawn(async { Ok(()) })),
            nat_refresh: None,
            nat_cancellation: Default::default(),
        };
        assert!(app
            .check_health()
            .unwrap_err()
            .to_string()
            .contains("Original observer fault"));
        app.close().await.unwrap();
        app.close().await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_error_is_not_hidden_by_an_earlier_runtime_fault() {
        let (stop, _) = watch::channel(false);
        let state = lifecycle_state();
        state.fail(Error::invalid("Original observer fault"));
        let mut app = TunApplications {
            state,
            endpoint: BridgeEndpoint {
                port: 0,
                secret: String::new(),
                width: 1,
                nat_tag: None,
            },
            stop,
            accept: None,
            refresh: Some(tokio::spawn(async {
                Err(Error::invalid("Observer release failed"))
            })),
            nat_refresh: None,
            nat_cancellation: Default::default(),
        };
        assert!(app
            .close()
            .await
            .unwrap_err()
            .to_string()
            .contains("Observer release failed"));
    }
    #[tokio::test]
    async fn terminated_nat_task_is_unhealthy_and_is_joined() {
        let (stop, _) = watch::channel(false);
        let mut app = TunApplications {
            state: lifecycle_state(),
            endpoint: BridgeEndpoint {
                port: 0,
                secret: String::new(),
                width: 1,
                nat_tag: None,
            },
            stop,
            accept: None,
            refresh: None,
            nat_refresh: Some(tokio::spawn(async { panic!("injected NAT failure") })),
            nat_cancellation: Default::default(),
        };
        while !app.nat_refresh.as_ref().unwrap().is_finished() {
            tokio::task::yield_now().await;
        }
        assert!(app.check_health().is_err());
        assert!(app.close().await.is_err());
        assert!(app.close().await.is_ok());
    }
    #[tokio::test]
    async fn already_stopped_listener_releases_its_socket() {
        let (_stop, stopping) = watch::channel(true);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::time::timeout(
            Duration::from_millis(300),
            accept_loop(listener, lifecycle_state(), stopping),
        )
        .await
        .unwrap()
        .unwrap();
        let _replacement = TcpListener::bind(address).await.unwrap();
    }
    #[tokio::test]
    async fn stop_drains_connected_attribution_clients() {
        let state = lifecycle_state();
        let (stop, stopping) = watch::channel(false);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(accept_loop(listener, state, stopping));
        let mut clients = Vec::new();
        for _ in 0..32 {
            clients.push(TcpStream::connect(address).await.unwrap());
        }
        tokio::task::yield_now().await;
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        for mut client in clients {
            let mut b = [0];
            assert!(!matches!(
                tokio::time::timeout(Duration::from_millis(300), client.read(&mut b)).await,
                Err(_) | Ok(Ok(1..))
            ));
        }
        let _replacement = TcpListener::bind(address).await.unwrap();
    }
}
