//! Isolated, bounded outbound checks. Never modify the applied runtime or system settings.
use crate::native::{spawn_core, CoreIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    io::Read,
    net::TcpListener,
    path::PathBuf,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use wayrill_protocol::{normalize_config, params, ApiError, Result};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};

const MAX_BATCH: usize = 8;
const RESULT_PAGE: usize = 128;
const PLAN_PAGE: usize = 256;
const PLAN_PAGE_BYTES: usize = 2 * 1024 * 1024;
mod policy;
mod speed;
pub(crate) mod timezone;
mod udp;
#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Mode {
    #[default]
    Latency,
    Speed,
    Timezone,
}
#[derive(Clone)]
pub(crate) struct ActivePolicy {
    pub control: crate::live::Control,
    pub config: Arc<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    test_url: String,
    country_url: String,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    speed_url: String,
    #[serde(default)]
    udp_url: String,
    #[serde(default)]
    targets: Vec<Target>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlannedInput {
    source_token: String,
    settings: Input,
}
enum Preparation {
    StashTimezone(Value),
    Outbounds(String),
}
#[derive(Deserialize)]
struct Prepared {
    plan: Plan,
    #[serde(rename = "preparedTargets")]
    targets: Vec<PreparedTarget>,
    fragments: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedTarget {
    id: String,
    outbound_tag: String,
    outbounds: Vec<usize>,
    fields: BTreeMap<String, usize>,
}
enum QueuedTarget {
    Inline(Target),
    Prepared(PreparedTarget),
}
impl QueuedTarget {
    fn id(&self) -> &str {
        match self {
            Self::Inline(target) => &target.id,
            Self::Prepared(target) => &target.id,
        }
    }
    fn materialize(self, fragments: &[Value]) -> Result<Target> {
        let target = match self {
            Self::Prepared(target) => target,
            Self::Inline(target) => return Ok(target),
        };
        let get = |index: usize| {
            fragments
                .get(index)
                .cloned()
                .ok_or_else(|| invalid("An outbound test configuration fragment is missing."))
        };
        let mut config = serde_json::Map::new();
        for (key, index) in target.fields {
            config.insert(key, get(index)?);
        }
        let outbounds = target
            .outbounds
            .into_iter()
            .map(get)
            .collect::<Result<Vec<_>>>()?;
        config.insert("outbounds".into(), Value::Array(outbounds));
        Ok(Target {
            id: target.id,
            config: Value::Object(config),
            outbound_tag: target.outbound_tag,
        })
    }
}
#[derive(Deserialize)]
struct Plan {
    rows: Vec<Value>,
    targets: Vec<Value>,
}
impl Plan {
    fn page(items: &[Value], offset: usize) -> &[Value] {
        let mut bytes = 0;
        let rest = &items[offset.min(items.len())..];
        let count = rest
            .iter()
            .take(PLAN_PAGE)
            .take_while(|item| {
                let first = bytes == 0;
                bytes += item.to_string().len() + 1;
                first || bytes <= PLAN_PAGE_BYTES
            })
            .count();
        &rest[..count]
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    id: String,
    config: Value,
    outbound_tag: String,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobInput {
    job: u64,
    #[serde(default)]
    offset: usize,
    row_offset: Option<usize>,
    target_offset: Option<usize>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestResult {
    id: String,
    latency_ms: Option<u64>,
    ip: Option<String>,
    country: Option<String>,
    error: Option<String>,
    country_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<speed::Measurement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    udp: Option<udp::Measurement>,
}
#[derive(Default)]
struct State {
    job: u64,
    busy: bool,
    total: usize,
    results: Vec<TestResult>,
    planned: bool,
    plan: Option<Plan>,
    error: Option<ApiError>,
    reservation: Option<crate::operation_gate::Foreground>,
}
// Publish completion and release admission even if the coordinator unwinds.
struct Completion(Arc<Mutex<State>>);
impl Drop for Completion {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.busy = false;
        state.reservation = None;
        if state.planned && std::thread::panicking() {
            state.error = Some(ApiError::new(
                "TEST_WORKER",
                "The outbound test job ended unexpectedly.",
            ));
        }
    }
}
#[derive(Clone, Default)]
struct Job {
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
}
pub struct Manager {
    current: Job,
    last_planned: Option<Job>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Manager {
    pub fn new() -> Self {
        Self {
            current: Job::default(),
            last_planned: None,
            worker: None,
        }
    }
    pub fn busy(&self) -> bool {
        self.current.state.lock().unwrap().busy
    }
    pub(crate) fn retain_reservation(
        &mut self,
        reservation: Option<crate::operation_gate::Foreground>,
    ) {
        let mut state = self.current.state.lock().unwrap();
        if state.busy {
            state.reservation = reservation;
        }
    }
    pub fn shutdown(&mut self) {
        self.current.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
    fn snapshot(job: &Job, page: JobInput) -> Value {
        let s = job.state.lock().unwrap();
        let offset = page.offset.min(s.results.len());
        let end = if s.planned {
            (offset + RESULT_PAGE).min(s.results.len())
        } else {
            s.results.len()
        };
        let mut snapshot = json!({"job":s.job,"busy":s.busy,"total":s.total,"completed":s.results.len(),"cancelled":job.stop.load(Ordering::SeqCst),"results":&s.results[offset..end]});
        if s.planned {
            snapshot["error"] = json!(s.error);
            if let Some(plan) = &s.plan {
                snapshot["planReady"] = json!(true);
                snapshot["totalRows"] = json!(plan.rows.len());
                if let Some(offset) = page.row_offset {
                    snapshot["rows"] = json!(Plan::page(&plan.rows, offset));
                }
                if let Some(offset) = page.target_offset {
                    snapshot["targets"] = json!(Plan::page(&plan.targets, offset));
                }
            }
        }
        snapshot
    }
    pub(crate) fn start_planned(
        &mut self,
        value: Value,
        subscriptions: &crate::subscriptions::Manager,
        exe: PathBuf,
        owner: String,
        egress: Option<crate::tun::OutboundEgress>,
        active: Option<ActivePolicy>,
    ) -> Result<Value> {
        let request: PlannedInput = params(value)?;
        if !request.settings.targets.is_empty() || request.settings.mode == Mode::Timezone {
            return Err(invalid("Choose a delay or speed test for the draft."));
        }
        validate_endpoints(&request.settings)?;
        let source = subscriptions.take_outbound_test_source(&request.source_token)?;
        self.start(
            request.settings,
            Some(Preparation::Outbounds(source)),
            exe,
            owner,
            egress,
            active,
        )
    }
    pub(crate) fn stash_timezone(
        &mut self,
        preparation: Value,
        exe: PathBuf,
        owner: String,
        egress: Option<crate::tun::OutboundEgress>,
        active: Option<ActivePolicy>,
    ) -> Result<Value> {
        self.start(
            Input {
                test_url: "https://ipwho.is/".into(),
                country_url: String::new(),
                mode: Mode::Timezone,
                speed_url: String::new(),
                udp_url: String::new(),
                targets: vec![],
            },
            Some(Preparation::StashTimezone(preparation)),
            exe,
            owner,
            egress,
            active,
        )
    }
    fn start(
        &mut self,
        mut input: Input,
        preparation: Option<Preparation>,
        exe: PathBuf,
        owner: String,
        egress: Option<crate::tun::OutboundEgress>,
        active: Option<ActivePolicy>,
    ) -> Result<Value> {
        if preparation.is_none() {
            validate_input(&input)?;
        }
        if self.busy() {
            return Err(ApiError::new(
                "BUSY",
                "An outbound test is already running.",
            ));
        }
        let mut random = [0u8; 8];
        if unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                random.as_mut_ptr(),
                8,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err(invalid("Cannot create an outbound test job."));
        }
        let id = (u64::from_le_bytes(random) & ((1u64 << 53) - 1)).max(1);
        let planned = matches!(preparation, Some(Preparation::Outbounds(_)));
        let job = Job {
            state: Arc::new(Mutex::new(State {
                job: id,
                busy: true,
                total: if matches!(preparation, Some(Preparation::StashTimezone(_))) {
                    1
                } else {
                    input.targets.len()
                },
                planned,
                ..State::default()
            })),
            stop: Arc::new(AtomicBool::new(false)),
        };
        let state = job.state.clone();
        let stop = job.stop.clone();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let worker = std::thread::Builder::new()
            .name("wayrill-outbound-tests".into())
            .spawn(move || {
                let _completion = Completion(state.clone());
                let mut name = None;
                let mut prepared_targets = None;
                if let Some(Preparation::StashTimezone(preparation)) = preparation {
                    let prepared = (|| {
                        let plan = crate::subscriptions::prepare_probe(&preparation, &stop, &stop)?;
                        input.targets = params(plan["targets"].clone())?;
                        validate_input(&input)?;
                        if input.targets.len() != 1 {
                            return Err(invalid("The selected Stash outbound cannot be tested."));
                        }
                        name = plan["plan"]["rows"][0]["name"].as_str().map(str::to_owned);
                        Ok(())
                    })();
                    if let Err(error) = prepared {
                        state
                            .lock()
                            .unwrap()
                            .results
                            .push(failed("companion-custom".into(), &error.message));
                        return;
                    }
                } else if let Some(Preparation::Outbounds(source)) = preparation {
                    match prepare_outbounds(source, input.mode, &stop) {
                        Ok(prepared) => {
                            let mut state = state.lock().unwrap();
                            state.total = prepared.targets.len();
                            state.plan = Some(prepared.plan);
                            prepared_targets = Some((prepared.targets, prepared.fragments));
                        }
                        Err(error) => {
                            if !stop.load(Ordering::Acquire) {
                                state.lock().unwrap().error = Some(error);
                            }
                            return;
                        }
                    }
                }
                let (queue, fragments): (VecDeque<_>, _) = match prepared_targets {
                    Some((targets, fragments)) => (
                        targets.into_iter().map(QueuedTarget::Prepared).collect(),
                        fragments,
                    ),
                    None => (
                        input
                            .targets
                            .into_iter()
                            .map(QueuedTarget::Inline)
                            .collect(),
                        Vec::new(),
                    ),
                };
                if queue.is_empty() {
                    return;
                }
                let queue = Mutex::new(queue);
                std::thread::scope(|scope| {
                    for _ in 0..if input.mode == Mode::Speed { 1 } else { 4 } {
                        let queue = &queue;
                        let state = &state;
                        let stop = &stop;
                        let exe = &exe;
                        let owner = &owner;
                        let test = &input.test_url;
                        let country = &input.country_url;
                        let speed_url = &input.speed_url;
                        let mode = input.mode;
                        let udp_url = &input.udp_url;
                        let active = active.as_ref();
                        let egress = egress.as_ref();
                        let name = name.as_ref();
                        let fragments = &fragments;
                        let work = move || loop {
                            if stop.load(Ordering::SeqCst) {
                                break;
                            }
                            let Some(target) = queue.lock().unwrap().pop_front() else {
                                break;
                            };
                            let id = target.id().to_owned();
                            let checked = std::panic::catch_unwind(|| {
                                let target = target.materialize(fragments)?;
                                run(
                                    &target,
                                    &Probe {
                                        test,
                                        country,
                                        exe,
                                        owner,
                                        stop,
                                        egress,
                                        mode,
                                        speed_url,
                                        active,
                                        udp_url,
                                    },
                                )
                            });
                            let mut result = match checked {
                                Ok(Ok(result)) => result,
                                Ok(Err(error)) => failed(id, &error.message),
                                Err(_) => failed(id, "Outbound test failed."),
                            };
                            result.name = name.cloned();
                            state.lock().unwrap().results.push(result);
                        };
                        // A failed thread allocation must not panic the job
                        // coordinator and leave busy=true indefinitely.
                        if std::thread::Builder::new()
                            .name("wayrill-outbound-probe".into())
                            .spawn_scoped(scope, work)
                            .is_err()
                        {
                            state.lock().unwrap().error = Some(ApiError::new(
                                "TEST_WORKER",
                                "Could not start an outbound test worker.",
                            ));
                            stop.store(true, Ordering::SeqCst);
                        }
                    }
                });
            });
        self.worker = Some(worker.map_err(|e| ApiError::io("Start outbound test worker", e))?);
        if planned {
            self.last_planned = Some(job.clone());
        }
        self.current = job;
        Ok(Self::snapshot(&self.current, JobInput::default()))
    }
    pub fn handle(
        &mut self,
        method: &str,
        value: Value,
        exe: PathBuf,
        owner: String,
        egress: Option<crate::tun::OutboundEgress>,
        active: Option<ActivePolicy>,
    ) -> Result<Value> {
        match method {
            "outbounds.testStart" => self.start(params(value)?, None, exe, owner, egress, active),
            "outbounds.testGet" | "outbounds.testCancel" => {
                let input: JobInput = params(value)?;
                let job =
                    if input.job == self.current.state.lock().unwrap().job && input.job != 0 {
                        Some(&self.current)
                    } else {
                        self.last_planned
                            .as_ref()
                            .filter(|job| job.state.lock().unwrap().job == input.job)
                    }
                    .ok_or_else(|| {
                        ApiError::new(
                            "TEST_JOB_CHANGED",
                            "This outbound test is no longer available.",
                        )
                    })?;
                if method == "outbounds.testCancel" {
                    job.stop.store(true, Ordering::SeqCst);
                }
                Ok(Self::snapshot(job, input))
            }
            _ => Err(ApiError::new(
                "METHOD_NOT_FOUND",
                "Unknown outbound test method.",
            )),
        }
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn failed(id: String, message: &str) -> TestResult {
    TestResult {
        id,
        latency_ms: None,
        ip: None,
        country: None,
        error: Some(message.into()),
        country_error: None,
        timezone: None,
        name: None,
        speed: None,
        udp: None,
    }
}
fn invalid(message: &str) -> ApiError {
    ApiError::new("INVALID_PARAMS", message)
}
fn checked_url(text: &str) -> Result<url::Url> {
    let parsed = url::Url::parse(text).map_err(|_| invalid("Enter a valid HTTP(S) test URL."))?;
    if text.len() > 2048
        || !["https", "http"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid(
            "Test URLs must use HTTP(S), without login credentials or a fragment.",
        ));
    }
    Ok(parsed)
}
fn validate_endpoints(input: &Input) -> Result<()> {
    if input.mode == Mode::Speed {
        checked_url(&input.speed_url)?;
    } else {
        checked_url(&input.test_url)?;
        if !input.udp_url.is_empty() {
            udp::Endpoint::parse(&input.udp_url)?;
        }
        if !input.country_url.is_empty() {
            checked_url(&input.country_url)?;
        }
    }
    Ok(())
}
fn validate_input(input: &Input) -> Result<()> {
    validate_endpoints(input)?;
    if input.targets.is_empty() || input.targets.len() > MAX_BATCH {
        return Err(invalid(
            "Choose between one and eight outbound tests per batch.",
        ));
    }
    let mut ids = HashSet::new();
    let mut bytes = 0;
    for target in &input.targets {
        if target.id.is_empty()
            || target.id.len() > 160
            || !ids.insert(&target.id)
            || target.outbound_tag.is_empty()
            || target.outbound_tag.len() > 128
            || !target.config.is_object()
        {
            return Err(invalid("Invalid or duplicate outbound test target."));
        }
        bytes += serde_json::to_vec(&target.config)
            .map_err(|_| invalid("Invalid test configuration."))?
            .len();
    }
    if bytes > wayrill_protocol::MAX_CONFIG {
        return Err(invalid("Outbound test batch exceeds 16 MiB."));
    }
    Ok(())
}
fn prepare_outbounds(source: String, mode: Mode, stop: &AtomicBool) -> Result<Prepared> {
    let mut request: Value =
        serde_json::from_str(&source).map_err(|_| invalid("Invalid outbound test draft."))?;
    drop(source);
    let object = request
        .as_object_mut()
        .ok_or_else(|| invalid("Invalid outbound test draft."))?;
    object.retain(|key, _| {
        matches!(
            key.as_str(),
            "graph" | "stash" | "nodeIds" | "entries" | "selection"
        )
    });
    request["operation"] = json!("outboundTests");
    request["mode"] = json!(if mode == Mode::Speed {
        "speed"
    } else {
        "latency"
    });
    let prepared: Prepared = params(crate::subscriptions::prepare_probe(&request, stop, stop)?)?;
    if prepared.targets.len() != prepared.plan.targets.len() {
        return Err(invalid(
            "The outbound test plan does not match its targets.",
        ));
    }
    Ok(prepared)
}
fn test_config(target: &Target, port: u16, password: &str) -> Result<Value> {
    let mut config = target.config.clone();
    let root = config
        .as_object_mut()
        .ok_or_else(|| invalid("Invalid test configuration."))?;
    if root.keys().any(|key| {
        ![
            "outbounds",
            "routing",
            "dns",
            "fakedns",
            "observatory",
            "burstObservatory",
            "policy",
            "env",
        ]
        .contains(&key.as_str())
    }) {
        return Err(invalid(
            "Only outbound, routing, DNS, policy and observation settings are accepted for tests.",
        ));
    }
    config["log"] = json!({"loglevel":"none","access":"none"});
    config["inbounds"] = json!([{"tag":"wti","listen":"127.0.0.1","port":port,"protocol":"http","settings":{"accounts":[{"user":"wayrill-test","pass":password}]}}]);
    config = normalize_config(config)?;
    let outputs = config["outbounds"]
        .as_array()
        .ok_or_else(|| invalid("Test outbounds are missing."))?;
    if !outputs
        .iter()
        .any(|o| o["tag"].as_str() == Some(&target.outbound_tag))
    {
        return Err(invalid("The tested outbound tag is missing."));
    }
    if outputs.iter().any(|o| o["protocol"] == "tun") {
        return Err(invalid("TUN outbounds cannot be tested in isolation."));
    }
    config["log"] = json!({"loglevel":"none","access":"none"});
    config["inbounds"] = json!([{"tag":"wti","listen":"127.0.0.1","port":port,"protocol":"http","settings":{"accounts":[{"user":"wayrill-test","pass":password}]}}]);
    if config["routing"].is_null() {
        config["routing"] = json!({});
    }
    if config["routing"]["rules"].is_null() {
        config["routing"]["rules"] = json!([]);
    }
    config["routing"]["rules"]
        .as_array_mut()
        .ok_or_else(|| invalid("Invalid test routing rules."))?
        .insert(
            0,
            json!({"type":"field","inboundTag":["wti"],"outboundTag":target.outbound_tag}),
        );
    normalize_config(config)
}
fn bind_probe(config: &mut Value, egress: Option<&crate::tun::OutboundEgress>) -> Result<()> {
    if let Some(selection) = egress {
        selection.bind(config)
    } else if crate::tun::needs_direct_binding(config) {
        Err(ApiError::new("OUTBOUND_INTERFACE", "No active upstream interface is available for automatic Direct. Select a network interface or reconnect the uplink."))
    } else {
        Ok(())
    }
}
#[derive(Clone, Copy)]
struct Probe<'a> {
    test: &'a str,
    country: &'a str,
    exe: &'a std::path::Path,
    owner: &'a str,
    stop: &'a AtomicBool,
    egress: Option<&'a crate::tun::OutboundEgress>,
    mode: Mode,
    speed_url: &'a str,
    active: Option<&'a ActivePolicy>,
    udp_url: &'a str,
}
fn run(target: &Target, probe: &Probe<'_>) -> Result<TestResult> {
    let Probe {
        test,
        country,
        exe,
        owner,
        stop,
        egress,
        mode,
        speed_url,
        active,
        udp_url,
    } = *probe;
    let mut random = [0u8; 44];
    if unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            random.as_mut_ptr(),
            44,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err(invalid("Cannot create private test credentials."));
    }
    let password = random[..32]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let reservation = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| invalid("No local test port is available."))?;
    let port = reservation
        .local_addr()
        .map_err(|_| invalid("Cannot select a test port."))?
        .port();
    let mut config = test_config(target, port, &password)?;
    let udp_endpoint = (mode == Mode::Latency && !udp_url.is_empty())
        .then(|| udp::Endpoint::parse(udp_url))
        .transpose()?;
    let udp_reservation = udp_endpoint
        .as_ref()
        .map(|_| {
            TcpListener::bind("127.0.0.1:0")
                .map_err(|_| invalid("No local UDP relay port is available."))
        })
        .transpose()?;
    let udp_port = udp_reservation
        .as_ref()
        .map(|listener| {
            listener
                .local_addr()
                .map(|a| a.port())
                .map_err(|_| invalid("Cannot select a UDP relay port."))
        })
        .transpose()?;
    if let Some(udp_port) = udp_port {
        udp::add_inbound(&mut config, udp_port, &password, &target.outbound_tag);
    }
    let policy_source = (mode != Mode::Latency).then(|| config.clone());
    bind_probe(&mut config, egress)?;
    let loopback = match egress {
        Some(selection) => selection.loopback.clone(),
        None => crate::tun::loopback_interface()?,
    };
    // The authored fragment was validated before bounded runtime expansion.
    crate::loopback::Policy::apply(&mut config, &loopback)?;
    let unavailable = if mode != Mode::Latency {
        // Keep failed groups isolated without aborting a different healthy path.
        // A fresh initial also excludes this helper from authored prefix selectors.
        let tag = format!("{}unavailable", crate::loopback::private_prefix(&config)?);
        config["outbounds"]
            .as_array_mut()
            .unwrap()
            .push(json!({"tag":tag,"protocol":"blackhole"}));
        Some(tag)
    } else {
        None
    };
    let control = (mode != Mode::Latency)
        .then(|| crate::live::Control::new(&config))
        .transpose()?;
    drop(reservation);
    drop(udp_reservation);
    let core = spawn_core(
        exe,
        if owner.is_empty() {
            CoreIdentity::LocalService
        } else {
            CoreIdentity::Owner(owner)
        },
        control
            .as_ref()
            .map(|c| c.config.as_ref())
            .unwrap_or(&config),
        false,
        None,
        0,
    )?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(invalid("Test cancelled."));
        }
        if core.exit_code()?.is_some() {
            return Err(invalid("Xray could not start this test configuration."));
        }
        let listeners = crate::sockets::listeners()?;
        if std::iter::once(port).chain(udp_port).all(|port| {
            listeners.iter().any(|e| {
                e.pid == core.pid
                    && e.endpoint.address == std::net::SocketAddr::from(([127, 0, 0, 1], port))
            })
        }) {
            break;
        }
        if Instant::now() > deadline {
            return Err(invalid("The outbound test listener did not become ready."));
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    if let Some(control) = &control {
        policy::prepare(
            control,
            active,
            policy_source.as_ref().unwrap(),
            &target.outbound_tag,
            unavailable.as_deref().unwrap(),
            stop,
        )?;
        if mode == Mode::Timezone {
            let client = Client::new(port, &password)?;
            let bytes = client.fetch(test, stop)?;
            let (ip, country) = country_info(&bytes)?;
            return Ok(TestResult {
                ip: Some(ip),
                country,
                timezone: Some(timezone::response(&bytes)?),
                error: None,
                ..failed(target.id.clone(), "")
            });
        }
        let speed = speed::test(port, &password, speed_url, stop)?;
        return Ok(TestResult {
            speed: Some(speed),
            error: None,
            ..failed(target.id.clone(), "")
        });
    }
    let client = Client::new(port, &password)?;
    let mut measurements = Vec::new();
    let mut last_error = None;
    for _ in 0..2 {
        if stop.load(Ordering::SeqCst) {
            return Err(invalid("Test cancelled."));
        }
        let start = Instant::now();
        match client.fetch(test, stop) {
            Ok(_) => measurements.push(start.elapsed().as_millis().max(1) as u64),
            Err(e) => last_error = Some(e.message),
        }
    }
    let mut result = if let Some(latency) = measurements.iter().min().copied() {
        TestResult {
            latency_ms: Some(latency),
            error: None,
            ..failed(target.id.clone(), "")
        }
    } else {
        failed(
            target.id.clone(),
            last_error.as_deref().unwrap_or("No HTTP response."),
        )
    };
    if result.latency_ms.is_some() && !country.is_empty() && !stop.load(Ordering::SeqCst) {
        match client
            .fetch(country, stop)
            .and_then(|bytes| country_info(&bytes))
        {
            Ok((ip, country)) => {
                result.ip = Some(ip);
                result.country = country;
            }
            Err(e) => result.country_error = Some(e.message),
        }
    }
    if let (Some(endpoint), Some(udp_port)) = (udp_endpoint, udp_port) {
        let nonce: [u8; 12] = random[32..].try_into().unwrap();
        result.udp = Some(udp::test(udp_port, &password, &endpoint, &nonce, stop)?);
    }
    drop(core);
    Ok(result)
}
fn country_info(bytes: &[u8]) -> Result<(String, Option<String>)> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| invalid("Country lookup did not return JSON."))?;
    let ip = ["ip", "clientIp", "ip_addr", "query"]
        .iter()
        .find_map(|key| value[*key].as_str())
        .ok_or_else(|| invalid("Country response has no exit IP."))?;
    let parsed = ip
        .parse::<std::net::IpAddr>()
        .map_err(|_| invalid("Country response has an invalid IP."))?;
    let country = ["country_code", "countryCode", "country", "country_name"]
        .iter()
        .find_map(|key| value[*key].as_str())
        .or_else(|| value["location"]["country_code"].as_str());
    let country = country
        .filter(|c| !c.is_empty() && c.chars().count() <= 80 && !c.chars().any(char::is_control))
        .map(String::from);
    Ok((parsed.to_string(), country))
}
// An explicit proxy client must never bypass its private listener for literal
// loopback URLs. WinHTTP's local-IP bypass can otherwise report false success.
struct Client(reqwest::blocking::Client);
impl Client {
    fn new(port: u16, password: &str) -> Result<Self> {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
            .map_err(|_| invalid("Cannot select the private test proxy."))?
            .basic_auth("wayrill-test", password);
        reqwest::blocking::Client::builder()
            .no_proxy()
            .proxy(proxy)
            .user_agent("Wayrill outbound test")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .connect_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(0)
            .build()
            .map(Self)
            .map_err(|_| invalid("Cannot create the test HTTP client."))
    }
    fn fetch(&self, text: &str, stop: &AtomicBool) -> Result<Vec<u8>> {
        let url = checked_url(text)?;
        if stop.load(Ordering::SeqCst) {
            return Err(invalid("Test cancelled."));
        }
        // Blocking-client timeouts restart per read; the request timeout also
        // bounds the complete streaming body so slow peers cannot hold a job.
        let mut response = self
            .0
            .get(url)
            .timeout(Duration::from_secs(5))
            .send()
            .map_err(|error| {
                invalid(if error.is_timeout() {
                    "HTTP test timed out."
                } else if error.is_connect() {
                    "Cannot connect through this outbound."
                } else {
                    "The connection closed before the test response."
                })
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(invalid(&format!(
                "Test URL returned HTTP {}; use a URL that returns 2xx without redirects.",
                status.as_u16()
            )));
        }
        let mut body = Vec::new();
        let mut chunk = [0; 8192];
        loop {
            if stop.load(Ordering::SeqCst) {
                return Err(invalid("Test cancelled."));
            }
            let read = response
                .read(&mut chunk)
                .map_err(|_| invalid("Test response was interrupted or timed out."))?;
            if read == 0 {
                return Ok(body);
            }
            if body.len() + read > 65536 {
                return Err(invalid(
                    "Test response exceeds 64 KiB; choose a small test endpoint.",
                ));
            }
            body.extend_from_slice(&chunk[..read]);
        }
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn isolated_tests_keep_valid_listener_settings_and_reject_other_environment() {
        let mut target = Target {
            id: "test".into(),
            outbound_tag: "direct".into(),
            config: json!({"outbounds":[{"tag":"direct","protocol":"freedom"}],"env":{"WAYRILL_UDP_LISTENER_RECEIVE_BYTES":"524288"}}),
        };
        let config = test_config(&target, 18777, "private").unwrap();
        assert_eq!(config["env"], target.config["env"]);
        target.config["env"]["WAYRILL_FAKEDNS"] = json!("not-allowed");
        assert!(test_config(&target, 18777, "private").is_err());
    }
    use super::*;
    #[test]
    fn test_http_deadline_includes_a_slow_streaming_response_body() {
        use std::io::Write;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => panic!("Test proxy was not used: {e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let read = socket.read(&mut buffer).unwrap();
                assert!(read > 0 && request.len() < 8192);
                request.extend_from_slice(&buffer[..read]);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\na")
                .unwrap();
            // Each gap fits the I/O timeout, but the complete body exceeds the
            // request deadline. A per-read timeout alone accepts this response.
            for byte in *b"bcd" {
                std::thread::sleep(Duration::from_secs(2));
                if socket.write_all(&[byte]).is_err() {
                    break;
                }
            }
        });
        let result = Client::new(port, "fixture")
            .unwrap()
            .fetch("http://streaming.example/check", &AtomicBool::new(false));
        server.join().unwrap();
        assert!(result.unwrap_err().message.contains("timed out"));
    }
    #[test]
    fn test_http_client_never_bypasses_its_private_proxy_for_local_origins() {
        use std::io::Write;
        for origin in ["127.9.8.7", "[::1]", "localhost."] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            listener.set_nonblocking(true).unwrap();
            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(6);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(10))
                        }
                        Err(e) => panic!("Private proxy was not used: {e}"),
                    }
                };
                // Accepted sockets inherit nonblocking mode on Windows. The
                // fixture reads a complete request with a bounded blocking read.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 1024];
                while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0 && bytes.len() < 8192);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproof",
                    )
                    .unwrap();
                String::from_utf8(bytes).unwrap()
            });
            let client = Client::new(port, "fixture").unwrap();
            assert_eq!(
                client
                    .fetch(&format!("http://{origin}:1/check"), &AtomicBool::new(false))
                    .unwrap(),
                b"proof"
            );
            let request = server.join().unwrap();
            assert!(request.starts_with(&format!("GET http://{origin}:1/check HTTP/1.1")));
            assert!(request
                .to_ascii_lowercase()
                .contains("proxy-authorization: basic "));
        }
    }
    #[test]
    fn rejects_unsafe_urls_and_batches() {
        for text in [
            "file:///secret",
            "https://user:pass@example.net/",
            "https://example.net/#secret",
            "",
        ] {
            assert!(checked_url(text).is_err());
        }
        assert!(checked_url("http://127.0.0.1:18880/health").is_ok());
        let input = Input {
            test_url: "https://example.net/".into(),
            country_url: "".into(),
            mode: Mode::Latency,
            speed_url: String::new(),
            udp_url: String::new(),
            targets: vec![],
        };
        assert!(validate_input(&input).is_err());
    }
    #[test]
    fn owns_input_and_preserves_chain_rules() {
        let target = Target {
            id: "a".into(),
            outbound_tag: "direct".into(),
            config: json!({"outbounds":[{"tag":"direct","protocol":"freedom","settings":{}}],"routing":{"rules":[{"type":"field","inboundTag":["hop"],"outboundTag":"direct"}]}}),
        };
        let config = test_config(&target, 18777, "private").unwrap();
        assert_eq!(config["inbounds"][0]["listen"], "127.0.0.1");
        assert_eq!(
            config["inbounds"][0]["settings"]["accounts"][0]["pass"],
            "private"
        );
        assert_eq!(config["routing"]["rules"][1]["inboundTag"][0], "hop");
        assert_eq!(config["routing"]["rules"][0]["outboundTag"], "direct");
        let target = Target {
            config: json!({"inbounds":[],"outbounds":[]}),
            ..target
        };
        assert!(test_config(&target, 18777, "private").is_err());
    }
    #[test]
    fn malformed_test_fragments_return_errors_without_panicking() {
        for routing in [
            json!(42),
            json!("bad"),
            json!({"rules":true}),
            json!({"rules":[null]}),
        ] {
            let target = Target {
                id: "bad".into(),
                outbound_tag: "direct".into(),
                config: json!({"outbounds":[{"tag":"direct","protocol":"freedom"}],"routing":routing}),
            };
            assert!(
                std::panic::catch_unwind(|| test_config(&target, 18999, "secret"))
                    .unwrap()
                    .is_err()
            );
        }
    }
    #[test]
    fn test_target_precedes_existing_catch_all() {
        let target = Target {
            id: "bad".into(),
            outbound_tag: "unreachable".into(),
            config: json!({"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"unreachable","protocol":"socks","settings":{"address":"127.0.0.1","port":1}}],"routing":{"rules":[{"type":"field","network":"tcp,udp","outboundTag":"direct"}]}}),
        };
        let c = test_config(&target, 18999, "secret").unwrap();
        assert_eq!(c["routing"]["rules"][0]["outboundTag"], "unreachable");
        assert_eq!(c["routing"]["rules"][1]["outboundTag"], "direct");
    }
    #[test]
    fn shutdown_joins_the_test_coordinator() {
        let mut m = Manager::new();
        let finished = Arc::new(AtomicBool::new(false));
        let (stop, done) = (m.current.stop.clone(), finished.clone());
        m.worker = Some(std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            done.store(true, Ordering::SeqCst);
        }));
        m.shutdown();
        assert!(finished.load(Ordering::SeqCst));
        assert!(m.worker.is_none());
    }
    #[test]
    fn asynchronous_completion_releases_admission_on_success_and_unwind() {
        for unwind in [false, true] {
            let gate = crate::operation_gate::Gate::default();
            let mut manager = Manager::new();
            manager.current.state.lock().unwrap().busy = true;
            manager.retain_reservation(Some(gate.foreground(&AtomicBool::new(false)).unwrap()));
            assert!(gate.background().is_none());
            let state = manager.current.state.clone();
            let result = std::panic::catch_unwind(move || {
                let _completion = Completion(state);
                if unwind {
                    panic!("Simulated test coordinator failure");
                }
            });
            assert_eq!(result.is_err(), unwind);
            assert!(!manager.busy());
            assert!(gate.background().is_some());
        }
    }
    #[test]
    fn accepts_provider_aliases_without_exposing_other_fields() {
        for text in [
            r#"{"ip":"203.0.113.2","country_code":"FI","secret":"hidden"}"#,
            r#"{"query":"203.0.113.2","countryCode":"FI"}"#,
            r#"{"clientIp":"203.0.113.2","location":{"country_code":"FI"}}"#,
        ] {
            assert_eq!(
                country_info(text.as_bytes()).unwrap(),
                ("203.0.113.2".into(), Some("FI".into()))
            );
        }
        assert!(country_info(br#"{"ip":"not-an-ip"}"#).is_err());
    }
    #[test]
    fn isolated_probes_use_capture_egress_and_preserve_explicit_vpn_selection() {
        let target = Target {
            id: "fixture".into(),
            outbound_tag: "direct".into(),
            config: json!({"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"peer","protocol":"socks","settings":{"address":"192.0.2.9","port":443}},{"tag":"explicit","protocol":"freedom","streamSettings":{"sockopt":{"interface":"OpenVPN","domainStrategy":"UseIPv4"}}}]}),
        };
        let mut config = test_config(&target, 12345, "private").unwrap();
        let selection = crate::tun::OutboundEgress {
            uplink: "Ethernet".into(),
            loopback: "Loopback".into(),
            captured: true,
        };
        bind_probe(&mut config, Some(&selection)).unwrap();
        let outbounds = config["outbounds"].as_array().unwrap();
        assert_eq!(
            outbounds.iter().find(|o| o["tag"] == "peer").unwrap()["streamSettings"]["sockopt"]
                ["interface"],
            "Ethernet"
        );
        assert_eq!(
            outbounds.iter().find(|o| o["tag"] == "explicit").unwrap()["streamSettings"]["sockopt"]
                ["interface"],
            "OpenVPN"
        );
        assert!(outbounds
            .iter()
            .any(|o| o["tag"] == "direct"
                && o["streamSettings"]["sockopt"]["interface"] == "Ethernet"));
        assert_eq!(config["inbounds"][0]["listen"], "127.0.0.1");
        assert_eq!(
            config["routing"]["rules"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["outboundTag"],
            "direct"
        );
        normalize_config(config).unwrap();
    }
    #[test]
    fn automatic_direct_probes_fail_closed_without_an_upstream() {
        let mut automatic = json!({"outbounds":[{"protocol":"freedom"}]});
        assert_eq!(
            bind_probe(&mut automatic, None).unwrap_err().code,
            "OUTBOUND_INTERFACE"
        );
        let mut explicit = json!({"outbounds":[{"protocol":"freedom","streamSettings":{"sockopt":{"interface":"OpenVPN"}}}]});
        bind_probe(&mut explicit, None).unwrap();
        assert_eq!(
            explicit["outbounds"][0]["streamSettings"]["sockopt"]["interface"],
            "OpenVPN"
        );
    }
    #[test]
    fn stale_cancel_cannot_cancel_a_new_job() {
        let mut manager = Manager::new();
        manager.current.state.lock().unwrap().job = 2;
        assert!(manager
            .handle(
                "outbounds.testCancel",
                json!({"job":1}),
                PathBuf::new(),
                "".into(),
                None,
                None
            )
            .is_err());
        assert!(!manager.current.stop.load(Ordering::SeqCst));
    }

    #[test]
    fn planned_pages_remain_available_after_another_probe_starts() {
        let mut manager = Manager::new();
        let completed = Manager::new();
        let total = RESULT_PAGE * 2 + 3;
        {
            let mut state = completed.current.state.lock().unwrap();
            state.job = 1;
            state.planned = true;
            state.total = total;
            state.results = (0..total)
                .map(|i| failed(i.to_string(), "fixture"))
                .collect();
            state.plan = Some(Plan {
                rows: (0..total).map(|i| json!({"key":i.to_string()})).collect(),
                targets: (0..total).map(|i| json!({"id":i.to_string()})).collect(),
            });
        }
        manager.last_planned = Some(completed.current.clone());
        manager.current.state.lock().unwrap().job = 2;
        let read = |manager: &mut Manager, page: Value| {
            manager
                .handle(
                    "outbounds.testGet",
                    page,
                    PathBuf::new(),
                    String::new(),
                    None,
                    None,
                )
                .unwrap()
        };
        let first = read(
            &mut manager,
            json!({"job":1,"rowOffset":0,"targetOffset":0}),
        );
        assert_eq!(first["results"].as_array().unwrap().len(), RESULT_PAGE);
        assert_eq!(first["rows"].as_array().unwrap().len(), PLAN_PAGE);
        let end = read(
            &mut manager,
            json!({"job":1,"offset":2 * RESULT_PAGE,"rowOffset":PLAN_PAGE,"targetOffset":PLAN_PAGE}),
        );
        assert_eq!(end["completed"], total);
        assert_eq!(end["results"].as_array().unwrap().len(), 3);
        assert_eq!(end["results"][0]["id"], (2 * RESULT_PAGE).to_string());
        assert_eq!(end["targets"][0]["id"], PLAN_PAGE.to_string());
        assert_eq!(end["busy"], false);
    }

    #[test]
    fn restricted_planner_prepares_a_whole_stash_selection_with_shared_fragments() {
        let links = (0..32)
            .map(|i| format!("socks://127.0.0.1:{}#Server-{i}", 20000 + i))
            .collect::<Vec<_>>()
            .join("\n");
        let refreshed = crate::subscription_engine::execute(
            &json!({"operation":"refresh","stash":"","groupId":"wayrill:default","text":links}),
        )
        .unwrap();
        let entries: Vec<_> = refreshed["catalog"][0]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| json!({"groupId":"wayrill:default","entryId":entry["id"]}))
            .collect();
        let prepared: Prepared = params(crate::subscription_engine::execute(&json!({"operation":"outboundTests","mode":"latency","stash":refreshed["stash"],"entries":entries})).unwrap()).unwrap();
        assert_eq!(prepared.targets.len(), 32);
        assert_eq!(prepared.plan.rows.len(), 32);
        assert!(
            prepared.fragments.len() < 40,
            "Common routing and defaults should be shared"
        );
        for (i, target) in prepared.targets.into_iter().enumerate() {
            let target = QueuedTarget::Prepared(target)
                .materialize(&prepared.fragments)
                .unwrap();
            assert_eq!(target.id, prepared.plan.targets[i]["id"]);
            assert_eq!(target.config["outbounds"][0]["tag"], target.outbound_tag);
            assert!(test_config(&target, 19999, "test-password").is_ok());
        }
    }
}
