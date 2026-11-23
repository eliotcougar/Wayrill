//! Isolated, bounded outbound checks. Never modify the applied runtime or system settings.
use crate::native::{spawn_core, CoreIdentity, XRAY_CONFIG_LOAD_TIMEOUT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    future::Future,
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
const HTTP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
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
    #[serde(skip)]
    Health,
}
#[derive(Clone, Copy)]
enum ProbeProxy {
    Http,
    Socks { udp: bool },
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
    Outbounds { token: String, source: String },
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
    #[serde(default)]
    job: u64,
    source_token: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    delay_unavailable: Option<bool>,
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
    udp: Option<udp::Reachability>,
}
#[derive(Default)]
enum JobPhase {
    #[default]
    Finished,
    Preparing,
    Running,
    Draining,
}
impl JobPhase {
    fn busy(&self) -> bool {
        !matches!(self, Self::Finished)
    }
}
#[derive(Default)]
struct State {
    job: u64,
    phase: JobPhase,
    total: usize,
    results: Vec<TestResult>,
    previews: BTreeMap<String, TestResult>,
    planned: bool,
    plan: Option<Plan>,
    error: Option<ApiError>,
    reservation: Option<crate::operation_gate::Foreground>,
}
impl State {
    fn finish_target(&mut self, id: String, name: Option<&String>, result: Result<TestResult>) {
        self.previews.remove(&id);
        let mut result = match result {
            Ok(result) => result,
            Err(error) if error.code == TEST_CANCELLED => return,
            Err(error) => failed(id, &error.message),
        };
        result.name = name.cloned();
        self.results.push(result);
    }
}
// Publish completion and release admission even if the coordinator unwinds.
struct Completion(Arc<Mutex<State>>);
impl Drop for Completion {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.phase = JobPhase::Finished;
        state.previews.clear();
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
    source_token: Option<String>,
}
impl Job {
    fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        if state.phase.busy() {
            state.phase = JobPhase::Draining;
            self.stop.store(true, Ordering::Release);
        }
    }
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
        self.current.state.lock().unwrap().phase.busy()
    }
    pub(crate) fn retain_reservation(
        &mut self,
        job: u64,
        reservation: Option<crate::operation_gate::Foreground>,
    ) {
        let mut state = self.current.state.lock().unwrap();
        if state.job == job && state.phase.busy() {
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
        let mut snapshot = json!({"job":s.job,"busy":s.phase.busy(),"total":s.total,"completed":s.results.len(),"cancelled":job.stop.load(Ordering::Acquire),"results":&s.results[offset..end]});
        if !s.previews.is_empty() {
            snapshot["previews"] = json!(s.previews.values().collect::<Vec<_>>());
        }
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
        if let Some(job) = self.planned_job(&request.source_token) {
            return Ok(Self::snapshot(job, JobInput::default()));
        }
        if !request.settings.targets.is_empty() || request.settings.mode == Mode::Timezone {
            return Err(invalid("Choose a delay or speed test for the draft."));
        }
        validate_endpoints(&request.settings)?;
        let source = subscriptions.take_outbound_test_source(&request.source_token)?;
        self.start(
            request.settings,
            Some(Preparation::Outbounds {
                token: request.source_token,
                source,
            }),
            exe,
            owner,
            egress,
            active,
        )
    }
    pub(crate) fn start_health(
        &mut self,
        value: Value,
        exe: PathBuf,
        egress: Option<crate::tun::OutboundEgress>,
    ) -> Result<Value> {
        let mut input: Input = params(value)?;
        input.mode = Mode::Health;
        self.start(input, None, exe, String::new(), egress, None)
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
        let source_token = match &preparation {
            Some(Preparation::Outbounds { token, .. }) => Some(token.clone()),
            _ => None,
        };
        let planned = source_token.is_some();
        let job = Job {
            state: Arc::new(Mutex::new(State {
                job: id,
                phase: if preparation.is_some() {
                    JobPhase::Preparing
                } else {
                    JobPhase::Running
                },
                total: if matches!(preparation, Some(Preparation::StashTimezone(_))) {
                    1
                } else {
                    input.targets.len()
                },
                planned,
                ..State::default()
            })),
            stop: Arc::new(AtomicBool::new(false)),
            source_token,
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
                } else if let Some(Preparation::Outbounds { source, .. }) = preparation {
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
                {
                    let mut state = state.lock().unwrap();
                    if matches!(state.phase, JobPhase::Draining) {
                        return;
                    }
                    state.phase = JobPhase::Running;
                }
                // Each probe starts a separate Xray. Leave CPU headroom for
                // routing and config loading when testing on a small machine.
                let workers = if input.mode == Mode::Speed {
                    1
                } else {
                    std::thread::available_parallelism()
                        .map_or(1, |cpus| cpus.get().div_ceil(2))
                        .min(4)
                        .min(queue.len())
                };
                let queue = Mutex::new(queue);
                std::thread::scope(|scope| {
                    for _ in 0..workers {
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
                                    |result| {
                                        state
                                            .lock()
                                            .unwrap()
                                            .previews
                                            .insert(result.id.clone(), result.clone());
                                    },
                                )
                            });
                            let result =
                                checked.unwrap_or_else(|_| Err(invalid("Outbound test failed.")));
                            state.lock().unwrap().finish_target(id, name, result);
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
    fn planned_job(&self, token: &str) -> Option<&Job> {
        self.last_planned
            .as_ref()
            .filter(|job| job.source_token.as_deref() == Some(token))
    }

    pub(crate) fn start_input(
        &mut self,
        value: Value,
        exe: PathBuf,
        owner: String,
        egress: Option<crate::tun::OutboundEgress>,
        active: Option<ActivePolicy>,
    ) -> Result<Value> {
        self.start(params(value)?, None, exe, owner, egress, active)
    }

    pub(crate) fn status(
        &self,
        method: &str,
        value: Value,
        subscriptions: Option<&crate::subscriptions::Manager>,
    ) -> Result<Value> {
        let cancel = match method {
            "outbounds.testGet" => false,
            "outbounds.testCancel" => true,
            _ => {
                return Err(ApiError::new(
                    "METHOD_NOT_FOUND",
                    "Unknown outbound test method.",
                ))
            }
        };
        let input: JobInput = params(value)?;
        let job = match (&input.source_token, input.job) {
            (Some(token), 0)
                if token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit()) =>
            {
                match self.planned_job(token) {
                    Some(job) => Some(job),
                    None if cancel => {
                        // Admission and cancellation share the kernel lock.
                        // Revoke the single-use draft if a delayed start has
                        // not consumed it yet. That start can no longer run.
                        subscriptions
                            .ok_or_else(|| {
                                invalid("A draft token requires the subscription store.")
                            })?
                            .discard_outbound_test_source(token);
                        return Ok(json!({
                            "job":0,"busy":false,"cancelled":true,
                            "total":0,"completed":0,"results":[]
                        }));
                    }
                    None => None,
                }
            }
            (None, id) if id != 0 => ([Some(&self.current), self.last_planned.as_ref()])
                .into_iter()
                .flatten()
                .find(|job| job.state.lock().unwrap().job == id),
            _ => return Err(invalid("Specify one outbound test job or draft token.")),
        };
        let job = job.ok_or_else(|| {
            ApiError::new(
                "TEST_JOB_CHANGED",
                "This outbound test is no longer available.",
            )
        })?;
        if cancel {
            job.cancel();
        }
        Ok(Self::snapshot(job, input))
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
        delay_unavailable: None,
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
const TEST_CANCELLED: &str = "TEST_CANCELLED";
fn cancelled() -> ApiError {
    ApiError::new(TEST_CANCELLED, "Test cancelled.")
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
fn test_config(target: &Target, port: u16, password: &str, proxy: ProbeProxy) -> Result<Value> {
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
    // The private probe rule precedes imported DNS and loopback routes.
    // Give this listener its own identity so those routes can still use theirs.
    let inbound_tag = crate::tun::random_id()?;
    config["log"] = json!({"loglevel":"none","access":"none"});
    let accounts = json!([{"user":"wayrill-test","pass":password}]);
    let (protocol, settings) = match proxy {
        ProbeProxy::Http => ("http", json!({"accounts":accounts})),
        ProbeProxy::Socks { udp } => (
            "socks",
            json!({"auth":"password","udp":udp,"accounts":accounts}),
        ),
    };
    config["inbounds"] = json!([{"tag":inbound_tag,"listen":"127.0.0.1","port":port,"protocol":protocol,"settings":settings}]);
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
            json!({"type":"field","inboundTag":[inbound_tag],"outboundTag":target.outbound_tag}),
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

fn wait_for_test_listeners(
    pid: u32,
    ports: &[u16],
    stop: &AtomicBool,
    mut exit_code: impl FnMut() -> Result<Option<u32>>,
) -> Result<()> {
    let deadline = Instant::now() + XRAY_CONFIG_LOAD_TIMEOUT;
    loop {
        if stop.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        if let Some(code) = exit_code()? {
            return Err(ApiError::new(
                "XRAY_TEST_START_FAILED",
                format!("Xray exited while starting the outbound test (code {code})."),
            ));
        }
        if crate::sockets::owns_loopback_tcp_listeners(pid, ports.iter().copied())? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ApiError::new(
                "TIMEOUT",
                format!(
                    "The local Xray test listener did not become ready within {} seconds.",
                    XRAY_CONFIG_LOAD_TIMEOUT.as_secs()
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn run(target: &Target, probe: &Probe<'_>, preview: impl Fn(&TestResult)) -> Result<TestResult> {
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
    let udp_endpoint = (mode == Mode::Latency && !udp_url.is_empty())
        .then(|| udp::Endpoint::parse(udp_url))
        .transpose()?;
    let proxy = if mode == Mode::Latency {
        ProbeProxy::Socks {
            udp: udp_endpoint.is_some(),
        }
    } else {
        ProbeProxy::Http
    };
    let mut config = test_config(target, port, &password, proxy)?;
    let policy_source = (matches!(mode, Mode::Speed | Mode::Timezone)
        && config["routing"]["balancers"]
            .as_array()
            .is_some_and(|groups| !groups.is_empty()))
    .then(|| config.clone());
    bind_probe(&mut config, egress)?;
    let loopback = match egress {
        Some(selection) => selection.loopback.clone(),
        None => crate::tun::loopback_interface()?,
    };
    // The authored fragment was validated before bounded runtime expansion.
    crate::loopback::Policy::apply(&mut config, &loopback)?;
    let policy = policy_source
        .map(|source| {
            // Keep failed groups isolated without aborting a different healthy path.
            // A fresh initial also excludes this helper from authored prefix selectors.
            let tag = format!("{}unavailable", crate::loopback::private_prefix(&config)?);
            config["outbounds"]
                .as_array_mut()
                .unwrap()
                .push(json!({"tag":tag,"protocol":"blackhole"}));
            let control = crate::live::Control::new(&config)?;
            Ok::<_, ApiError>((source, tag, control))
        })
        .transpose()?;
    if stop.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    drop(reservation);
    let core = spawn_core(
        exe,
        if owner.is_empty() {
            CoreIdentity::LocalService
        } else {
            CoreIdentity::Owner(owner)
        },
        policy
            .as_ref()
            .map(|(_, _, control)| control.config.as_ref())
            .unwrap_or(&config),
        false,
        None,
        0,
    )?;
    // The UDP SOCKS association and policy RPC also start through TCP listeners.
    let ports: Vec<_> = std::iter::once(port)
        .chain(policy.as_ref().map(|(_, _, control)| control.port()))
        .collect();
    wait_for_test_listeners(core.pid, &ports, stop, || core.exit_code())?;
    if let Some((source, unavailable, control)) = &policy {
        policy::prepare(
            control,
            active,
            source,
            &target.outbound_tag,
            unavailable,
            stop,
        )?;
    }
    match mode {
        Mode::Timezone => {
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
        Mode::Speed => {
            let speed = speed::test(port, &password, speed_url, stop)?;
            return Ok(TestResult {
                speed: Some(speed),
                error: None,
                ..failed(target.id.clone(), "")
            });
        }
        Mode::Health => {
            let client = Client::new(port, &password)?;
            client.run(
                stop,
                client.initial_response(test, Instant::now() + HTTP_RESPONSE_TIMEOUT),
            )?;
            return Ok(TestResult {
                error: None,
                ..failed(target.id.clone(), "")
            });
        }
        Mode::Latency => {}
    }
    let (client, reuse_only) = Client::for_delay(port, &password)?;
    // Optional probes must not compete with the timed request for transport state.
    let mut result = client.run(stop, measure_delay(&client, &reuse_only, &target.id, test))?;
    if result.latency_ms.is_some() || result.delay_unavailable == Some(true) {
        preview(&result);
    }
    let lookup_exit = (result.latency_ms.is_some() || result.delay_unavailable == Some(true))
        && !country.is_empty();
    if udp_endpoint.is_none() && !lookup_exit {
        return Ok(result);
    }
    let (udp, exit) = client.run(stop, async {
        let udp = async {
            match udp_endpoint {
                Some(endpoint) => {
                    let nonce: [u8; 12] = random[32..].try_into().unwrap();
                    Some(udp::test(port, &password, &endpoint, &nonce).await)
                }
                None => None,
            }
        };
        let exit = async {
            if !lookup_exit {
                return None;
            }
            Some(
                client
                    .fetch_before(country, Instant::now() + HTTP_RESPONSE_TIMEOUT)
                    .await
                    .and_then(|body| country_info(&body)),
            )
        };
        Ok(tokio::join!(udp, exit))
    })?;
    result.udp = udp;
    match exit {
        Some(Ok((ip, country))) => {
            result.ip = Some(ip);
            result.country = country;
        }
        Some(Err(error)) => result.country_error = Some(error.message),
        None => {}
    }

    Ok(result)
}

async fn measure_delay(
    client: &Client,
    reuse_only: &AtomicBool,
    id: &str,
    test: &str,
) -> Result<TestResult> {
    let deadline = Instant::now() + HTTP_RESPONSE_TIMEOUT;
    let response = match client.initial_response(test, deadline).await {
        Ok(response) => response,
        Err(error) => return Ok(failed(id.to_owned(), &error.message)),
    };
    let unavailable = |message| TestResult {
        delay_unavailable: Some(true),
        ..failed(id.to_owned(), message)
    };
    // The first body's end makes this exact SOCKS tunnel available for reuse.
    match tokio::time::timeout_at(deadline.into(), Client::read_body(response)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => return Ok(unavailable(&error.message)),
        Err(_) => {
            return Ok(unavailable(
                "The test endpoint did not finish the first response in time for connection reuse.",
            ))
        }
    }
    reuse_only.store(true, Ordering::Release);
    let start = Instant::now();
    let sample = client
        .response_before(test, start + HTTP_RESPONSE_TIMEOUT)
        .await;
    let elapsed = start.elapsed();
    reuse_only.store(false, Ordering::Release);
    Ok(match sample {
        Ok(_) => TestResult {
            latency_ms: Some(elapsed.as_millis().max(1) as u64),
            error: None,
            ..failed(id.to_owned(), "")
        },
        Err(_) => unavailable("The test endpoint did not return a successful response on the established connection. Try a small HTTP(S) endpoint that supports connection reuse."),
    })
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
// The explicit authenticated proxy is also required for local-origin URLs.
struct Client {
    http: reqwest::Client,
    runtime: tokio::runtime::Runtime,
}
impl Client {
    fn new(port: u16, password: &str) -> Result<Self> {
        Self::build(Self::builder(port, password, "http")?.pool_max_idle_per_host(0))
    }
    fn for_delay(port: u16, password: &str) -> Result<(Self, Arc<AtomicBool>)> {
        let reuse_only = Arc::new(AtomicBool::new(false));
        let gate = reuse_only.clone();
        // SOCKS provides an end-to-end byte stream for HTTP as well as HTTPS.
        // A reusable HTTP forward-proxy connection alone is insufficient.
        let builder = Self::builder(port, password, "socks5h")?
            .pool_max_idle_per_host(1)
            .connector_layer(tower::filter::FilterLayer::new(move |request| {
                if gate.load(Ordering::Acquire) {
                    Err(std::io::Error::other(
                        "Delay test requires an established connection",
                    ))
                } else {
                    Ok(request)
                }
            }));
        Ok((Self::build(builder)?, reuse_only))
    }
    fn builder(port: u16, password: &str, scheme: &str) -> Result<reqwest::ClientBuilder> {
        let proxy = reqwest::Proxy::all(format!("{scheme}://127.0.0.1:{port}"))
            .map_err(|_| invalid("Cannot select the private test proxy."))?
            .basic_auth("wayrill-test", password);
        Ok(reqwest::Client::builder()
            .no_proxy()
            .proxy(proxy)
            .user_agent("Wayrill outbound test")
            .redirect(reqwest::redirect::Policy::none()))
    }
    fn build(builder: reqwest::ClientBuilder) -> Result<Self> {
        let http = builder
            .build()
            .map_err(|_| invalid("Cannot create the test HTTP client."))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| invalid("Cannot start the outbound test client."))?;
        Ok(Self { http, runtime })
    }
    fn run<T>(&self, stop: &AtomicBool, work: impl Future<Output = Result<T>>) -> Result<T> {
        self.runtime.block_on(async {
            tokio::select! {
                biased;
                _ = async {
                    while !stop.load(Ordering::Acquire) {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                } => Err(cancelled()),
                result = work => result,
            }
        })
    }
    fn get(&self, text: &str) -> Result<reqwest::RequestBuilder> {
        Ok(self.http.get(checked_url(text)?))
    }
    fn fetch(&self, text: &str, stop: &AtomicBool) -> Result<Vec<u8>> {
        self.run(
            stop,
            self.fetch_before(text, Instant::now() + HTTP_RESPONSE_TIMEOUT),
        )
    }
    async fn response(&self, text: &str) -> Result<reqwest::Response> {
        let response = self.get(text)?.send().await.map_err(|error| {
            invalid(if error.is_connect() {
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
        Ok(response)
    }
    async fn response_before(&self, text: &str, deadline: Instant) -> Result<reqwest::Response> {
        tokio::time::timeout_at(deadline.into(), self.response(text))
            .await
            .map_err(|_| invalid("HTTP test timed out waiting for the response."))?
    }
    async fn initial_response(&self, text: &str, deadline: Instant) -> Result<reqwest::Response> {
        match self.response_before(text, deadline).await {
            Err(_) if Instant::now() < deadline => self.response_before(text, deadline).await,
            result => result,
        }
    }
    async fn read_body(mut response: reqwest::Response) -> Result<Vec<u8>> {
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| invalid("Test response was interrupted."))?
        {
            if body.len() + chunk.len() > 65536 {
                return Err(invalid(
                    "Test response exceeds 64 KiB; choose a small test endpoint.",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
    async fn fetch_before(&self, text: &str, deadline: Instant) -> Result<Vec<u8>> {
        tokio::time::timeout_at(deadline.into(), async {
            Self::read_body(self.response(text).await?).await
        })
        .await
        .map_err(|_| invalid("HTTP test timed out waiting for the response."))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn cancelling_a_target_discards_its_preview_without_losing_completed_results() {
        let mut state = State::default();
        let mut measured = failed("preview".into(), "");
        measured.latency_ms = Some(42);
        state.previews.insert(measured.id.clone(), measured);
        state.finish_target(
            "other".into(),
            None,
            Err(invalid("A completed probe failed.")),
        );
        state.finish_target("preview".into(), None, Err(cancelled()));
        assert!(state.previews.is_empty());
        assert_eq!(state.results.len(), 1);
        assert_eq!(state.results[0].id, "other");
    }

    #[tokio::test]
    async fn waits_for_a_local_relay_that_loads_after_the_old_deadline() {
        let http = TcpListener::bind("127.0.0.1:0").unwrap();
        let socks = tokio::net::TcpSocket::new_v4().unwrap();
        socks.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let http_port = http.local_addr().unwrap().port();
        let socks_port = socks.local_addr().unwrap().port();
        let (checking, started) = tokio::sync::oneshot::channel();
        let waiter = tokio::task::spawn_blocking(move || {
            let mut checking = Some(checking);
            wait_for_test_listeners(
                std::process::id(),
                &[http_port, socks_port],
                &AtomicBool::new(false),
                || {
                    if let Some(checking) = checking.take() {
                        let _ = checking.send(());
                    }
                    Ok(None)
                },
            )
        });
        started.await.unwrap();
        tokio::time::sleep(Duration::from_millis(5250)).await;
        let finished_early = waiter.is_finished();
        let _socks = socks.listen(1).unwrap();
        waiter.await.unwrap().unwrap();
        assert!(
            !finished_early,
            "the SOCKS control listener was still starting"
        );
    }

    async fn accept_delay_request(listener: &tokio::net::TcpListener) -> tokio::net::TcpStream {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = [0; 2];
        socket.read_exact(&mut header).await.unwrap();
        assert_eq!(header[0], 5);
        let mut methods = vec![0; usize::from(header[1])];
        socket.read_exact(&mut methods).await.unwrap();
        assert!(methods.contains(&2));
        socket.write_all(&[5, 2]).await.unwrap();
        assert_eq!(socket.read_u8().await.unwrap(), 1);
        for expected in [b"wayrill-test".as_slice(), b"fixture"] {
            let mut input = vec![0; usize::from(socket.read_u8().await.unwrap())];
            socket.read_exact(&mut input).await.unwrap();
            assert_eq!(input, expected);
        }
        socket.write_all(&[1, 0]).await.unwrap();
        let mut connect = [0; 5];
        socket.read_exact(&mut connect).await.unwrap();
        assert_eq!(&connect[..4], &[5, 1, 0, 3]);
        let mut address = vec![0; usize::from(connect[4]) + 2];
        socket.read_exact(&mut address).await.unwrap();
        assert_eq!(&address[..address.len() - 2], b"latency.example.test");
        tokio::time::sleep(Duration::from_millis(250)).await;
        socket
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
            .await
            .unwrap();
        socket
    }

    async fn read_headers(socket: &mut tokio::net::TcpStream) {
        use tokio::io::AsyncReadExt;
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        assert!(request.starts_with(b"GET /check HTTP/1.1\r\n"));
    }

    #[test]
    fn delay_requires_the_warmed_tunnel_and_reports_closure_without_dialing_again() {
        use tokio::io::AsyncWriteExt;
        for keep_open in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let (client, gate) =
                Client::for_delay(listener.local_addr().unwrap().port(), "fixture").unwrap();
            client.run(&AtomicBool::new(false), async {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let server = async {
                    let mut socket = accept_delay_request(&listener).await;
                    read_headers(&mut socket).await;
                    if keep_open {
                        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK").await.unwrap();
                        read_headers(&mut socket).await;
                        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n").await.unwrap();
                        // An unfinished timed body must not defer the result.
                        let (next, _) = listener.accept().await.unwrap();
                        drop(next);
                    } else {
                        socket.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await.unwrap();
                        drop(socket);
                        let (next, _) = listener.accept().await.unwrap();
                        drop(next);
                    }
                };
                let result = tokio::time::timeout(Duration::from_secs(3), async {
                    tokio::select! {
                        result = measure_delay(&client, &gate, "test", "http://latency.example.test/check") => result,
                        () = server => panic!("The latency test opened a second SOCKS connection"),
                    }
                }).await.unwrap().unwrap();
                if keep_open {
                    assert!(result.latency_ms.is_some_and(|ms| ms < 250));
                    assert_eq!(result.error, None);
                } else {
                    assert_eq!(result.latency_ms, None);
                    assert_eq!(result.delay_unavailable, Some(true));
                }
                Ok(())
            }).unwrap();
        }
    }

    #[test]
    fn isolated_tests_keep_valid_listener_settings_and_reject_other_environment() {
        let mut target = Target {
            id: "test".into(),
            outbound_tag: "direct".into(),
            config: json!({"outbounds":[{"tag":"direct","protocol":"freedom"}],"env":{"WAYRILL_UDP_LISTENER_RECEIVE_BYTES":"524288"}}),
        };
        let config = test_config(&target, 18777, "private", ProbeProxy::Http).unwrap();
        assert_eq!(config["env"], target.config["env"]);
        target.config["env"]["WAYRILL_FAKEDNS"] = json!("not-allowed");
        assert!(test_config(&target, 18777, "private", ProbeProxy::Http).is_err());
    }
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
        let client = Client::new(port, "fixture").unwrap();
        let result = client.run(
            &AtomicBool::new(false),
            client.fetch_before(
                "http://streaming.example/check",
                Instant::now() + Duration::from_secs(5),
            ),
        );
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
            config: json!({"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"deny","protocol":"blackhole"}],"routing":{"rules":[{"type":"field","inboundTag":["wti","wtu"],"outboundTag":"deny"}]}}),
        };
        let config =
            test_config(&target, 18777, "private", ProbeProxy::Socks { udp: true }).unwrap();
        let listener = &config["inbounds"][0];
        assert_eq!(listener["listen"], "127.0.0.1");
        assert_eq!(listener["protocol"], "socks");
        assert_eq!(listener["settings"]["accounts"][0]["pass"], "private");
        assert_eq!(listener["settings"]["udp"], true);
        let rules = config["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules[0]["inboundTag"], json!([listener["tag"]]));
        assert_eq!(rules[0]["outboundTag"], "direct");
        assert_eq!(rules[1]["inboundTag"], json!(["wti", "wtu"]));
        assert!(!rules[1]["inboundTag"]
            .as_array()
            .unwrap()
            .contains(&listener["tag"]));
        let target = Target {
            config: json!({"inbounds":[],"outbounds":[]}),
            ..target
        };
        assert!(test_config(&target, 18777, "private", ProbeProxy::Http).is_err());
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
            assert!(std::panic::catch_unwind(|| test_config(
                &target,
                18999,
                "secret",
                ProbeProxy::Http
            ))
            .unwrap()
            .is_err());
        }
    }
    #[test]
    fn test_target_precedes_existing_catch_all() {
        let target = Target {
            id: "bad".into(),
            outbound_tag: "unreachable".into(),
            config: json!({"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"unreachable","protocol":"socks","settings":{"address":"127.0.0.1","port":1}}],"routing":{"rules":[{"type":"field","network":"tcp,udp","outboundTag":"direct"}]}}),
        };
        let c = test_config(&target, 18999, "secret", ProbeProxy::Http).unwrap();
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
            manager.current.state.lock().unwrap().phase = JobPhase::Running;
            manager.retain_reservation(0, Some(gate.foreground(&AtomicBool::new(false)).unwrap()));
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
        let mut config = test_config(&target, 12345, "private", ProbeProxy::Http).unwrap();
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
        let manager = Manager::new();
        {
            let mut state = manager.current.state.lock().unwrap();
            state.job = 2;
            state.phase = JobPhase::Running;
        }
        assert!(manager
            .status("outbounds.testCancel", json!({"job":1}), None)
            .is_err());
        assert!(!manager.current.stop.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelling_by_token_prevents_a_delayed_start_from_consuming_the_draft() {
        let subscriptions = crate::subscriptions::Manager::open(
            "test-owner",
            std::env::temp_dir().join(format!(
                "wayrill-draft-{}.dpapi",
                crate::tun::random_id().unwrap()
            )),
            crate::events::Events::new(),
        );
        let begin = subscriptions
            .handle(
                "subscriptions.uploadStart",
                json!({"kind":"outbound-tests","bytes":2}),
            )
            .unwrap();
        let token = begin["token"].as_str().unwrap();
        subscriptions
            .handle(
                "subscriptions.uploadChunk",
                json!({"token":token,"offset":0,"text":"{}"}),
            )
            .unwrap();
        subscriptions
            .handle("subscriptions.uploadCommit", json!({"token":token}))
            .unwrap();
        let mut manager = Manager::new();
        let result = manager
            .status(
                "outbounds.testCancel",
                json!({"sourceToken":token}),
                Some(&subscriptions),
            )
            .unwrap();
        assert_eq!(result["cancelled"], true);
        assert_eq!(result["busy"], false);
        let start = manager.start_planned(
            json!({"sourceToken":token,"settings":{"testUrl":"http://127.0.0.1/","countryUrl":""}}),
            &subscriptions,
            PathBuf::new(),
            "test-owner".into(),
            None,
            None,
        );
        assert!(start.unwrap_err().message.contains("draft expired"));
        assert!(manager.worker.is_none());
    }

    #[test]
    fn planned_pages_remain_available_after_another_probe_starts() {
        let mut manager = Manager::new();
        let mut completed = Manager::new();
        let token = "a".repeat(32);
        completed.current.source_token = Some(token.clone());
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
            manager.status("outbounds.testGet", page, None).unwrap()
        };
        let first = read(
            &mut manager,
            json!({"sourceToken":token,"rowOffset":0,"targetOffset":0}),
        );
        assert_eq!(first["job"], 1);
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
            assert!(test_config(&target, 19999, "test-password", ProbeProxy::Http).is_ok());
        }
    }
}
