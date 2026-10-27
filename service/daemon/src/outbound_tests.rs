//! Isolated, bounded outbound checks. Never modify the applied runtime or system settings.
use crate::native::{spawn_core, CoreIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
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
#[cfg(test)]
mod integration;
mod policy;
mod speed;
mod udp;
#[cfg(test)]
mod udp_integration;
#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Mode {
    #[default]
    Latency,
    Speed,
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
    targets: Vec<Target>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    id: String,
    config: Value,
    outbound_tag: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobInput {
    job: u64,
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
    speed: Option<speed::Measurement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    udp: Option<udp::Measurement>,
}
struct State {
    job: u64,
    busy: bool,
    total: usize,
    results: Vec<TestResult>,
    reservation: Option<crate::operation_gate::Foreground>,
}
// Publish completion and release admission even if the coordinator unwinds.
struct Completion(Arc<Mutex<State>>);
impl Drop for Completion {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.busy = false;
        state.reservation = None;
    }
}
pub struct Manager {
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    sequence: u64,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Manager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                job: 0,
                busy: false,
                total: 0,
                results: vec![],
                reservation: None,
            })),
            stop: Arc::new(AtomicBool::new(false)),
            sequence: 0,
            worker: None,
        }
    }
    pub fn busy(&self) -> bool {
        self.state.lock().unwrap().busy
    }
    pub(crate) fn retain_reservation(
        &mut self,
        reservation: Option<crate::operation_gate::Foreground>,
    ) {
        let mut state = self.state.lock().unwrap();
        if state.busy {
            state.reservation = reservation;
        }
    }
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
    fn snapshot(&self) -> Value {
        let s = self.state.lock().unwrap();
        json!({"job":s.job,"busy":s.busy,"total":s.total,"completed":s.results.len(),"cancelled":self.stop.load(Ordering::SeqCst),"results":s.results})
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
            "outbounds.testStart" => {
                let input: Input = params(value)?;
                validate_input(&input)?;
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
                self.sequence = (u64::from_le_bytes(random) & ((1u64 << 53) - 1)).max(1);
                self.stop = Arc::new(AtomicBool::new(false));
                self.state = Arc::new(Mutex::new(State {
                    job: self.sequence,
                    busy: true,
                    total: input.targets.len(),
                    results: vec![],
                    reservation: None,
                }));
                let state = self.state.clone();
                let stop = self.stop.clone();
                if let Some(worker) = self.worker.take() {
                    let _ = worker.join();
                }
                let worker = std::thread::Builder::new()
                    .name("wayrill-outbound-tests".into())
                    .spawn(move || {
                        let _completion = Completion(state.clone());
                        let queue = Mutex::new(VecDeque::from(input.targets));
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
                                let work = move || loop {
                                    if stop.load(Ordering::SeqCst) {
                                        break;
                                    }
                                    let Some(target) = queue.lock().unwrap().pop_front() else {
                                        break;
                                    };
                                    let id = target.id.clone();
                                    let checked = std::panic::catch_unwind(|| {
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
                                    let result = match checked {
                                        Ok(Ok(result)) => result,
                                        Ok(Err(error)) => failed(id, &error.message),
                                        Err(_) => failed(id, "Outbound test failed."),
                                    };
                                    state.lock().unwrap().results.push(result);
                                };
                                // A failed thread allocation must not panic the job
                                // coordinator and leave busy=true indefinitely.
                                if std::thread::Builder::new()
                                    .name("wayrill-outbound-probe".into())
                                    .spawn_scoped(scope, work)
                                    .is_err()
                                {
                                    stop.store(true, Ordering::SeqCst);
                                }
                            }
                        });
                    });
                match worker {
                    Ok(worker) => self.worker = Some(worker),
                    Err(error) => {
                        self.state.lock().unwrap().busy = false;
                        return Err(ApiError::io("Start outbound test worker", error));
                    }
                }
                Ok(self.snapshot())
            }
            "outbounds.testGet" | "outbounds.testCancel" => {
                let input: JobInput = params(value)?;
                if input.job != self.sequence || self.sequence == 0 {
                    return Err(ApiError::new(
                        "TEST_JOB_CHANGED",
                        "This outbound test is no longer available.",
                    ));
                }
                if method == "outbounds.testCancel" {
                    self.stop.store(true, Ordering::SeqCst);
                }
                Ok(self.snapshot())
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
fn validate_input(input: &Input) -> Result<()> {
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
    config["inbounds"] = json!([{"tag":"wayrill-test-input","listen":"127.0.0.1","port":port,"protocol":"http","settings":{"accounts":[{"user":"wayrill-test","pass":password}]}}]);
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
    config["inbounds"] = json!([{"tag":"wayrill-test-input","listen":"127.0.0.1","port":port,"protocol":"http","settings":{"accounts":[{"user":"wayrill-test","pass":password}]}}]);
    if config["routing"].is_null() {
        config["routing"] = json!({});
    }
    if config["routing"]["rules"].is_null() {
        config["routing"]["rules"] = json!([]);
    }
    config["routing"]["rules"].as_array_mut().ok_or_else(||invalid("Invalid test routing rules."))?.insert(0, json!({"type":"field","inboundTag":["wayrill-test-input"],"outboundTag":target.outbound_tag}));
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
    let policy_source = (mode == Mode::Speed).then(|| config.clone());
    bind_probe(&mut config, egress)?;
    let loopback = match egress {
        Some(selection) => selection.loopback.clone(),
        None => crate::tun::loopback_interface()?,
    };
    // The authored fragment was validated before bounded runtime expansion.
    crate::loopback::Policy::apply(&mut config, &loopback)?;
    let control = (mode == Mode::Speed)
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
            stop,
        )?;
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
        let (stop, done) = (m.stop.clone(), finished.clone());
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
            manager.state.lock().unwrap().busy = true;
            manager.retain_reservation(Some(gate.foreground(&AtomicBool::new(false)).unwrap()));
            assert!(gate.background().is_none());
            let state = manager.state.clone();
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
        manager.sequence = 2;
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
        assert!(!manager.stop.load(Ordering::SeqCst));
    }
}
