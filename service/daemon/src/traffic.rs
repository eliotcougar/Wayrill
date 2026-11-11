//! Read-only Xray metrics through an authenticated, service-owned loopback SOCKS bridge.
//! Runtime instrumentation is separate from the saved/exported user configuration.
use crate::{display_names::DisplayNames, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{cmp::Ordering, sync::Arc};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};

pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const MIN_RATE_INTERVAL: Duration = Duration::from_secs(1);
const HISTORY_LIMIT: usize = 300;

/// Stamp acquisition before handing counters back to the lifecycle coordinator.
/// Waiting for its lock is not part of the measured traffic interval.
pub struct Sample {
    pub counters: Value,
    pub observed_at: Instant,
    pub timestamp_ms: u64,
}
const RESPONSE_LIMIT: usize = wayrill_protocol::MAX_METRICS_RESPONSE;
const READ_BUDGET: Duration = Duration::from_millis(800);

#[derive(Clone)]
pub struct Bridge {
    address: SocketAddr,
    password: String,
    pub config: Arc<Value>,
    pub control_rule: Value,
    outbound_sources: Arc<crate::loopback::CounterSources>,
}
impl Bridge {
    pub fn new(config: &Value) -> Result<Self> {
        let listener = crate::sockets::reserve_loopback(config)?;
        let address = listener
            .local_addr()
            .map_err(|e| ApiError::io("Read statistics socket", e))?;
        let mut random = [0u8; 32];
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                random.as_mut_ptr(),
                random.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } != 0
        {
            return Err(ApiError::new(
                "STATISTICS_UNAVAILABLE",
                "Cannot generate the statistics bridge credential.",
            ));
        }
        let password = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let scope = crate::loopback::private_tag(config, "telemetry")?;
        let inbound = format!("{scope}-i");
        let metrics = config["metrics"]["tag"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("{scope}-m"));
        let mut run = config.clone();
        run["stats"] = json!({});
        if !run["policy"].is_object() {
            run["policy"] = json!({});
        }
        if !run["policy"]["system"].is_object() {
            run["policy"]["system"] = json!({});
        }
        for key in [
            "statsInboundUplink",
            "statsInboundDownlink",
            "statsOutboundUplink",
            "statsOutboundDownlink",
        ] {
            run["policy"]["system"][key] = json!(true);
        }
        if !run["metrics"].is_object() {
            run["metrics"] = json!({});
        }
        run["metrics"]["tag"] = json!(metrics);
        run["inbounds"].as_array_mut().ok_or_else(||ApiError::new("INVALID_CONFIG","Statistics requires configured inputs."))?.push(json!({
            "tag":inbound,"listen":"127.0.0.1","port":address.port(),"protocol":"socks",
            "settings":{"auth":"password","udp":false,"accounts":[{"user":"wayrill","pass":password}]}
        }));
        if !run["routing"].is_object() {
            run["routing"] = json!({});
        }
        if !run["routing"]["rules"].is_array() {
            run["routing"]["rules"] = json!([]);
        }
        let control_rule = json!({"type":"field","inboundTag":[inbound],"outboundTag":metrics});
        run["routing"]["rules"]
            .as_array_mut()
            .unwrap()
            .insert(0, control_rule.clone());
        Ok(Self {
            address,
            password,
            config: Arc::new(run),
            control_rule,
            outbound_sources: Arc::default(),
        })
    }
    pub fn with_outbound_sources(mut self, sources: Arc<crate::loopback::CounterSources>) -> Self {
        self.outbound_sources = sources;
        self
    }
    pub fn read(&self) -> Result<Sample> {
        self.read_inner()
            .and_then(|mut sample| {
                project_outbound_counters(&mut sample.counters, &self.outbound_sources)?;
                Ok(sample)
            })
            .map_err(|_| {
                ApiError::new(
                "STATISTICS_UNAVAILABLE",
                "The running core’s traffic counters could not be read. Last totals are retained.",
            )
            })
    }
    fn read_inner(&self) -> std::io::Result<Sample> {
        let deadline = Instant::now() + READ_BUDGET;
        let mut stream = TcpStream::connect_timeout(&self.address, READ_BUDGET)?;
        fn budget(stream: &TcpStream, deadline: Instant) -> std::io::Result<()> {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            stream.set_read_timeout(Some(remaining))?;
            stream.set_write_timeout(Some(remaining))
        }
        fn read_exact(
            stream: &mut TcpStream,
            deadline: Instant,
            mut buf: &mut [u8],
        ) -> std::io::Result<()> {
            while !buf.is_empty() {
                budget(stream, deadline)?;
                let n = stream.read(buf)?;
                if n == 0 {
                    return Err(std::io::ErrorKind::UnexpectedEof.into());
                }
                buf = &mut buf[n..];
            }
            Ok(())
        }
        fn write_all(
            stream: &mut TcpStream,
            deadline: Instant,
            mut buf: &[u8],
        ) -> std::io::Result<()> {
            while !buf.is_empty() {
                budget(stream, deadline)?;
                let n = stream.write(buf)?;
                if n == 0 {
                    return Err(std::io::ErrorKind::WriteZero.into());
                }
                buf = &buf[n..];
            }
            Ok(())
        }
        fn invalid() -> std::io::Error {
            std::io::ErrorKind::InvalidData.into()
        }
        write_all(&mut stream, deadline, &[5, 1, 2])?;
        let mut pair = [0; 2];
        read_exact(&mut stream, deadline, &mut pair)?;
        if pair != [5, 2] {
            return Err(invalid());
        }
        let mut auth = vec![1, 7];
        auth.extend_from_slice(b"wayrill");
        auth.push(self.password.len() as u8);
        auth.extend_from_slice(self.password.as_bytes());
        write_all(&mut stream, deadline, &auth)?;
        read_exact(&mut stream, deadline, &mut pair)?;
        if pair != [1, 0] {
            return Err(invalid());
        }
        let host = b"wayrill-metrics.internal";
        let mut request = vec![5, 1, 0, 3, host.len() as u8];
        request.extend_from_slice(host);
        request.extend_from_slice(&80u16.to_be_bytes());
        write_all(&mut stream, deadline, &request)?;
        let mut header = [0; 4];
        read_exact(&mut stream, deadline, &mut header)?;
        if header[0] != 5 || header[1] != 0 || header[2] != 0 {
            return Err(invalid());
        }
        let count = match header[3] {
            1 => 4,
            4 => 16,
            3 => {
                let mut len = [0];
                read_exact(&mut stream, deadline, &mut len)?;
                len[0] as usize
            }
            _ => return Err(invalid()),
        };
        let mut bound = vec![0; count + 2];
        read_exact(&mut stream, deadline, &mut bound)?;
        // HTTP/1.0 avoids chunked responses. No URL, destination or raw body is exposed to clients.
        write_all(&mut stream,deadline,b"GET /debug/vars HTTP/1.0\r\nHost: wayrill-metrics.internal\r\nConnection: close\r\n\r\n")?;
        let mut response = Vec::new();
        let mut buf = [0; 8192];
        let mut body_start = None;
        let mut expected_length = None;
        let mut scanned = 0;
        let mut frame = JsonFrame::default();
        loop {
            budget(&stream, deadline)?;
            let n = stream.read(&mut buf)?;
            if n == 0 {
                break;
            }
            if response.len() + n > RESPONSE_LIMIT {
                return Err(invalid());
            }
            response.extend_from_slice(&buf[..n]);
            // Xray's virtual outbound may keep the SOCKS stream open after HTTP
            // finishes. A complete authenticated JSON response is sufficient;
            // waiting for socket EOF would turn a valid sample into a timeout.
            if body_start.is_none() {
                if let Some(split) = response.windows(4).position(|w| w == b"\r\n\r\n") {
                    let start = split + 4;
                    let header = std::str::from_utf8(&response[..split]).map_err(|_| invalid())?;
                    for line in header.lines().skip(1) {
                        let (name, value) = line.split_once(':').ok_or_else(invalid)?;
                        if name.eq_ignore_ascii_case("content-length") {
                            let body = value.trim().parse::<usize>().map_err(|_| invalid())?;
                            expected_length = Some(
                                start
                                    .checked_add(body)
                                    .filter(|n| *n <= RESPONSE_LIMIT)
                                    .ok_or_else(invalid)?,
                            );
                        }
                    }
                    body_start = Some(start);
                    scanned = start;
                } else if response.len() > 65536 {
                    return Err(invalid());
                }
            }
            if body_start.is_some() {
                frame.feed(&response[scanned..]);
                scanned = response.len();
                if expected_length.map_or(frame.complete, |size| response.len() >= size) {
                    // Scan each byte once; parsing incomplete JSON after every
                    // chunk makes large subscriptions quadratic and times out.
                    return sample_response(&response);
                }
            }
        }
        sample_response(&response)
    }
}

fn project_outbound_counters(
    value: &mut Value,
    sources: &crate::loopback::CounterSources,
) -> std::io::Result<()> {
    for (tag, inputs) in sources {
        let mut row = serde_json::Map::new();
        for direction in ["uplink", "downlink"] {
            let mut total = 0u64;
            let mut complete = true;
            for source in inputs {
                let counter = &value["outbound"][source][direction];
                if counter.is_null() {
                    complete = false;
                    break;
                }
                total = total
                    .checked_add(counter.as_u64().ok_or(std::io::ErrorKind::InvalidData)?)
                    .ok_or(std::io::ErrorKind::InvalidData)?;
            }
            row.insert(
                direction.into(),
                if complete { json!(total) } else { Value::Null },
            );
        }
        value["outbound"][tag] = Value::Object(row);
    }
    Ok(())
}
#[derive(Default)]
struct JsonFrame {
    depth: usize,
    started: bool,
    quoted: bool,
    escaped: bool,
    complete: bool,
}
impl JsonFrame {
    fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if self.complete {
                break;
            }
            if !self.started {
                if byte.is_ascii_whitespace() {
                    continue;
                }
                self.started = true;
                if byte != b'{' {
                    self.complete = true;
                    break;
                }
                self.depth = 1;
            } else if self.quoted {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.quoted = false;
                }
            } else {
                match byte {
                    b'"' => self.quoted = true,
                    b'{' | b'[' => self.depth += 1,
                    b'}' | b']' => {
                        self.depth = self.depth.saturating_sub(1);
                        self.complete = self.depth == 0;
                    }
                    _ => {}
                }
            }
        }
    }
}
fn sample_response(bytes: &[u8]) -> std::io::Result<Sample> {
    let observed_at = Instant::now();
    let timestamp_ms = timestamp_ms();
    let counters = parse_http_metrics(bytes).map_err(|_| std::io::ErrorKind::InvalidData)?;
    Ok(Sample {
        counters,
        observed_at,
        timestamp_ms,
    })
}

fn parse_http_metrics(bytes: &[u8]) -> Result<Value> {
    let split = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| ApiError::new("INVALID_STATISTICS", "Missing metrics header."))?;
    let header = std::str::from_utf8(&bytes[..split])
        .map_err(|_| ApiError::new("INVALID_STATISTICS", "Invalid metrics header."))?;
    let mut status = header.lines().next().unwrap_or("").split_whitespace();
    if !matches!(status.next(), Some("HTTP/1.0" | "HTTP/1.1")) || status.next() != Some("200") {
        return Err(ApiError::new(
            "INVALID_STATISTICS",
            "Unexpected metrics response.",
        ));
    }
    for line in header.lines().skip(1) {
        let (key, val) = line
            .split_once(':')
            .ok_or_else(|| ApiError::new("INVALID_STATISTICS", "Invalid metrics header."))?;
        if key.eq_ignore_ascii_case("transfer-encoding")
            || (key.eq_ignore_ascii_case("content-length")
                && val.trim().parse::<usize>().ok() != Some(bytes.len() - split - 4))
        {
            return Err(ApiError::new(
                "INVALID_STATISTICS",
                "Incomplete metrics response.",
            ));
        }
    }
    let mut value: Value = serde_json::from_slice(&bytes[split + 4..])
        .map_err(|_| ApiError::new("INVALID_STATISTICS", "Invalid metrics data."))?;
    // Discard cmdline, memory statistics and user identities before leaving the reader.
    if !value["stats"]["inbound"].is_object() || !value["stats"]["outbound"].is_object() {
        return Err(ApiError::new(
            "INVALID_STATISTICS",
            "Missing traffic counters.",
        ));
    }
    Ok(Value::Object(serde_json::Map::from_iter([
        ("inbound".into(), value["stats"]["inbound"].take()),
        ("outbound".into(), value["stats"]["outbound"].take()),
        (
            "observatory".into(),
            crate::observation::sanitize(&value["observatory"]),
        ),
    ])))
}

#[derive(Default, Clone, Copy)]
struct Counts {
    up: u128,
    down: u128,
}
impl Counts {
    fn add(self, other: Self) -> Self {
        Self {
            up: self.up.saturating_add(other.up),
            down: self.down.saturating_add(other.down),
        }
    }
}

#[derive(Default)]
struct Counter {
    previous: u64,
    total: u128,
    complete: bool,
    rate: Option<f64>,
}
impl Counter {
    fn observe(&mut self, reading: Option<u64>, seconds: Option<f64>, rebaseline: bool) -> u128 {
        // A missing never-active counter means idle. A missing active counter
        // invalidates this direction until two adjacent readings are available.
        let complete = reading.is_some() || self.previous == 0;
        let current = reading.unwrap_or(self.previous);
        let delta = current.checked_sub(self.previous);
        self.rate = if complete && self.complete {
            seconds.zip(delta).map(|(s, bytes)| bytes as f64 / s)
        } else {
            None
        };
        self.previous = current;
        self.complete = complete;
        let added = if rebaseline {
            0
        } else {
            u128::from(delta.unwrap_or(current))
        };
        self.total = self.total.saturating_add(added);
        added
    }
}

#[derive(Default)]
struct Endpoint {
    upload: Counter,
    download: Counter,
}
impl Endpoint {
    fn json(&self, scope: EndpointScope, tag: &str, live: bool) -> Value {
        json!({
            "scope":scope.key(), "tag":tag,
            "uploadBytes":self.upload.total.to_string(),
            "downloadBytes":self.download.total.to_string(),
            "uploadPerSecond":if live { self.upload.rate } else { None },
            "downloadPerSecond":if live { self.download.rate } else { None },
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTotals {
    version: u8,
    owner_sid: String,
    upload_bytes: String,
    download_bytes: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    sample_id: u64,
    timestamp_ms: u64,
    elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    interval_ms: Option<u64>,
    upload_per_second: Option<f64>,
    download_per_second: Option<f64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointPageInput {
    pub scope: EndpointScope,
    pub offset: usize,
    #[serde(default = "page_size")]
    pub limit: usize,
    #[serde(default)]
    pub sort_by: EndpointSort,
    #[serde(default)]
    pub direction: SortDirection,
}
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EndpointScope {
    Inbound,
    Outbound,
}
impl EndpointScope {
    const ALL: [Self; 2] = [Self::Inbound, Self::Outbound];

    fn key(self) -> &'static str {
        match self {
            Self::Inbound => "inbound",
            Self::Outbound => "outbound",
        }
    }
}
#[derive(Debug, Default, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EndpointSort {
    #[default]
    Name,
    UploadPerSecond,
    DownloadPerSecond,
    UploadBytes,
    DownloadBytes,
}
impl EndpointSort {
    fn value(self, endpoint: &Endpoint, live: bool) -> Option<EndpointValue> {
        match self {
            Self::Name => None,
            Self::UploadBytes => Some(EndpointValue::Count(endpoint.upload.total)),
            Self::DownloadBytes => Some(EndpointValue::Count(endpoint.download.total)),
            Self::UploadPerSecond if live => endpoint.upload.rate.map(EndpointValue::Rate),
            Self::DownloadPerSecond if live => endpoint.download.rate.map(EndpointValue::Rate),
            _ => None,
        }
    }
}
#[derive(Debug, Default, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    #[default]
    Asc,
    Desc,
}
impl SortDirection {
    fn apply(self, order: Ordering) -> Ordering {
        match self {
            Self::Asc => order,
            Self::Desc => order.reverse(),
        }
    }
}
enum EndpointValue {
    Count(u128),
    Rate(f64),
}
impl EndpointValue {
    fn compare(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Count(a), Self::Count(b)) => a.cmp(b),
            (Self::Rate(a), Self::Rate(b)) => a.total_cmp(b),
            _ => Ordering::Equal,
        }
    }
}
struct OrderedEndpoint<'a> {
    row: &'a Endpoint,
    name: String,
    tag: &'a str,
    value: Option<EndpointValue>,
}
fn page_size() -> usize {
    wayrill_protocol::MAX_ENDPOINT_PAGE
}
impl EndpointPageInput {
    pub fn validate(&self) -> Result<()> {
        if self.limit == 0
            || self.limit > wayrill_protocol::MAX_ENDPOINT_PAGE
            || self.offset > wayrill_protocol::MAX_OUTBOUNDS + 16
        {
            return Err(ApiError::new(
                "INVALID_PARAMS",
                "Use an endpoint page of 1 to 100 rows and a valid offset.",
            ));
        }
        Ok(())
    }
}
pub struct Traffic {
    owner: String,
    path: PathBuf,
    accumulated: Counts,
    session: Counts,
    counters: [BTreeMap<String, Endpoint>; 2],
    last: Option<Instant>,
    started: Instant,
    history: VecDeque<Point>,
    sample_id: u64,
    generation: u64,
    revision: u64,
    counter_epoch: u64,
    rebaseline: bool,
    state: &'static str,
    error: Option<&'static str>,
    last_persist: Instant,
    dirty: bool,
    persistence_error: Option<&'static str>,
    storage_blocked: bool,
}
impl Traffic {
    pub fn new(owner: &str, path: PathBuf) -> Result<Self> {
        let mut accumulated = Counts::default();
        let recovered =
            (|| -> Result<Counts> {
                if let Some(saved) = storage::read::<StoredTotals>(&path)? {
                    if saved.version != 1 || saved.owner_sid != owner {
                        return Err(ApiError::new(
                            "STATE_INTEGRITY",
                            "Traffic totals belong to another owner or format.",
                        ));
                    }
                    return Ok(Counts {
                        up: saved.upload_bytes.parse().map_err(|_| {
                            ApiError::new("STATE_INTEGRITY", "Invalid traffic total.")
                        })?,
                        down: saved.download_bytes.parse().map_err(|_| {
                            ApiError::new("STATE_INTEGRITY", "Invalid traffic total.")
                        })?,
                    });
                }
                Ok(Counts::default())
            })();
        let storage_blocked = recovered.is_err();
        if let Ok(saved) = recovered {
            accumulated = saved;
        }
        Ok(Self{owner:owner.into(),path,accumulated,session:Counts::default(),counters:Default::default(),last:None,started:Instant::now(),history:VecDeque::new(),sample_id:0,generation:0,revision:0,counter_epoch:0,rebaseline:false,state:"stopped",error:None,last_persist:Instant::now(),dirty:false,
            storage_blocked,persistence_error:storage_blocked.then_some("Saved traffic totals could not be loaded. The existing file is preserved; new totals are session-only until the file is repaired.")})
    }
    pub fn begin(&mut self, generation: u64, revision: u64, config: &Value) {
        self.generation = generation;
        self.rebaseline = false;
        self.revision = revision;
        self.session = Counts::default();
        for endpoints in &mut self.counters {
            endpoints.clear();
        }
        self.last = None;
        self.started = Instant::now();
        self.history.clear();
        self.sample_id = 0;
        self.state = "collecting";
        self.error = None;
        for (section, scope) in [
            ("inbounds", EndpointScope::Inbound),
            ("outbounds", EndpointScope::Outbound),
        ] {
            for endpoint in config[section].as_array().into_iter().flatten() {
                if scope == EndpointScope::Outbound
                    && matches!(
                        endpoint["protocol"].as_str(),
                        Some("blackhole" | "dns" | "loopback")
                    )
                {
                    continue;
                }
                if let Some(tag) = endpoint["tag"].as_str() {
                    self.counters[scope as usize].insert(tag.into(), Endpoint::default());
                }
            }
        }
    }
    pub fn revision(&mut self, revision: u64) {
        self.revision = revision;
    }
    pub fn include_outbound(&mut self, tag: &str) {
        self.counters[EndpointScope::Outbound as usize]
            .entry(tag.into())
            .or_default();
    }
    pub fn due(&self, now: Instant) -> bool {
        self.last
            .is_none_or(|last| now.saturating_duration_since(last) >= MIN_RATE_INTERVAL)
    }
    pub fn record(&mut self, value: &Value, now: Instant, timestamp: u64) -> Result<()> {
        // A final Stop read can overtake an earlier poll waiting for the lock.
        // Never move counter baselines or the history clock backwards.
        if self.last.is_some_and(|last| now <= last) {
            return Ok(());
        }
        fn count(value: &Value) -> Result<Option<u64>> {
            if value.is_null() {
                Ok(None)
            } else {
                value.as_u64().map(Some).ok_or_else(|| {
                    ApiError::new(
                        "INVALID_STATISTICS",
                        "Traffic counters must be nonnegative integers.",
                    )
                })
            }
        }
        let read = |scope: EndpointScope| {
            let section = &value[scope.key()];
            self.counters[scope as usize]
                .keys()
                .map(|tag| {
                    let row = &section[tag];
                    Ok((count(&row["uplink"])?, count(&row["downlink"])?))
                })
                .collect::<Result<Vec<_>>>()
        };
        // Validate the whole sample before advancing any endpoint.
        let readings = [
            read(EndpointScope::Inbound)?,
            read(EndpointScope::Outbound)?,
        ];
        let interval = self.last.map(|last| now.duration_since(last)).filter(|d| {
            *d >= MIN_RATE_INTERVAL && *d < Duration::from_secs(30) && !self.rebaseline
        });
        let seconds = interval.map(|duration| duration.as_secs_f64());
        let mut delta = Counts::default();
        let (mut upload_valid, mut download_valid) = (seconds.is_some(), seconds.is_some());
        for (scope, readings) in EndpointScope::ALL.into_iter().zip(readings) {
            for (endpoint, (up, down)) in self.counters[scope as usize].values_mut().zip(readings) {
                let up = endpoint.upload.observe(up, seconds, self.rebaseline);
                let down = endpoint.download.observe(down, seconds, self.rebaseline);
                if scope == EndpointScope::Inbound {
                    delta = delta.add(Counts { up, down });
                    upload_valid &= endpoint.upload.rate.is_some();
                    download_valid &= endpoint.download.rate.is_some();
                }
            }
        }
        self.last = Some(now);
        self.state = "collecting";
        self.error = None;
        if self.rebaseline {
            self.rebaseline = false;
            return Ok(());
        }
        self.session = self.session.add(delta);
        self.accumulated = self.accumulated.add(delta);
        self.dirty |= delta.up > 0 || delta.down > 0;
        self.sample_id += 1;
        self.history.push_back(Point {
            sample_id: self.sample_id,
            timestamp_ms: timestamp,
            elapsed_ms: now.saturating_duration_since(self.started).as_millis() as u64,
            interval_ms: interval
                .filter(|_| upload_valid || download_valid)
                .map(|d| d.as_millis() as u64),
            upload_per_second: seconds
                .filter(|_| upload_valid)
                .map(|s| delta.up as f64 / s),
            download_per_second: seconds
                .filter(|_| download_valid)
                .map(|s| delta.down as f64 / s),
        });
        if self.history.len() > HISTORY_LIMIT {
            self.history.pop_front();
        }
        if now.saturating_duration_since(self.last_persist) >= Duration::from_secs(30) {
            let _ = self.persist();
        }
        Ok(())
    }
    pub fn counter_epoch(&self) -> u64 {
        self.counter_epoch
    }
    pub fn reset(&mut self) -> Result<()> {
        if self.storage_blocked {
            return Err(ApiError::new("STATE_INTEGRITY", "Saved traffic totals could not be loaded. Repair the existing statistics file before resetting counters."));
        }
        // Commit first: a failed write must not report a durable reset or erase the visible totals.
        storage::write(
            &self.path,
            &StoredTotals {
                version: 1,
                owner_sid: self.owner.clone(),
                upload_bytes: "0".into(),
                download_bytes: "0".into(),
            },
        )?;
        self.accumulated = Counts::default();
        self.session = Counts::default();
        for endpoint in self.counters.iter_mut().flat_map(BTreeMap::values_mut) {
            for counter in [&mut endpoint.upload, &mut endpoint.download] {
                counter.total = 0;
                counter.rate = None;
            }
        }
        self.counter_epoch += 1;
        self.sample_id += 1;
        self.history.clear();
        self.last = None;
        self.rebaseline = true;
        self.dirty = false;
        self.last_persist = Instant::now();
        self.persistence_error = None;
        Ok(())
    }
    pub fn unavailable(&mut self) {
        self.state = "unavailable";
        self.error =
            Some("Traffic counters are temporarily unavailable. Last totals are retained.");
        self.last = None;
    }
    pub fn stopped(&mut self) {
        self.state = "stopped";
        self.error = None;
        self.last = None;
        let _ = self.persist();
    }
    pub fn persist(&mut self) -> Result<()> {
        if !self.dirty || self.storage_blocked {
            return Ok(());
        }
        self.last_persist = Instant::now();
        if let Err(e) = storage::write(
            &self.path,
            &StoredTotals {
                version: 1,
                owner_sid: self.owner.clone(),
                upload_bytes: self.accumulated.up.to_string(),
                download_bytes: self.accumulated.down.to_string(),
            },
        ) {
            self.persistence_error=Some("Traffic totals cannot currently be saved. Live counters continue; totals since the last successful save may be lost when the service exits.");
            return Err(e);
        }
        self.dirty = false;
        self.persistence_error = None;
        Ok(())
    }
    fn live(&self) -> bool {
        self.state == "collecting" && self.last.is_some()
    }
    pub fn snapshot(&self) -> Value {
        let point = self.history.back();
        let live = self.live();
        let [inbound, outbound] = self.counters.each_ref().map(BTreeMap::len);
        let rows = EndpointScope::ALL
            .into_iter()
            .flat_map(|scope| {
                self.counters[scope as usize]
                    .iter()
                    .map(move |(tag, row)| (scope, tag, row))
            })
            .take(if self.sample_id == 0 {
                0
            } else {
                wayrill_protocol::MAX_SNAPSHOT_ENDPOINTS
            })
            .map(|(scope, tag, row)| row.json(scope, tag, live));
        let mut snapshot = json!({
            "state":self.state,"generation":self.generation,"revision":self.revision,"counterEpoch":self.counter_epoch,
            "sampleIntervalMs":SAMPLE_INTERVAL.as_millis() as u64,"sampleId":self.sample_id,"lastSample":point,
            "uploadBytes":self.session.up.to_string(),"downloadBytes":self.session.down.to_string(),
            "accumulatedUploadBytes":self.accumulated.up.to_string(),"accumulatedDownloadBytes":self.accumulated.down.to_string(),
            "uploadPerSecond":if live { point.and_then(|p|p.upload_per_second) } else { None },
            "downloadPerSecond":if live { point.and_then(|p|p.download_per_second) } else { None },
            "endpointCounts":{"inbound":inbound,"outbound":outbound},
            "endpointsTruncated":inbound + outbound > wayrill_protocol::MAX_SNAPSHOT_ENDPOINTS,
            "error":self.error,"persistenceError":self.persistence_error,
        });
        snapshot["endpoints"] = Value::Array(rows.collect());
        snapshot
    }
    pub fn endpoints(
        &self,
        input: EndpointPageInput,
        names: Option<(u64, &DisplayNames)>,
    ) -> Result<Value> {
        input.validate()?;
        let scope = input.scope;
        // A stopped core may still expose counters from an earlier applied revision.
        let labels = names
            .filter(|(revision, _)| *revision == self.revision)
            .map(|(_, names)| match scope {
                EndpointScope::Inbound => &names.inbound,
                EndpointScope::Outbound => &names.outbound,
            });
        let live = self.live();
        let mut rows: Vec<_> = self.counters[scope as usize]
            .iter()
            .take(if self.sample_id == 0 { 0 } else { usize::MAX })
            .map(|(tag, row)| OrderedEndpoint {
                row,
                tag,
                name: labels
                    .and_then(|names| names.get(tag))
                    .unwrap_or(tag)
                    .to_lowercase(),
                value: input.sort_by.value(row, live),
            })
            .collect();
        let compare = |a: &OrderedEndpoint<'_>, b: &OrderedEndpoint<'_>| {
            let primary = if input.sort_by == EndpointSort::Name {
                input.direction.apply(a.name.cmp(&b.name))
            } else {
                match (&a.value, &b.value) {
                    (Some(a), Some(b)) => input.direction.apply(a.compare(b)),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => Ordering::Equal,
                }
            };
            primary
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.tag.cmp(b.tag))
        };
        let total = rows.len();
        let mut result = json!({
            "generation":self.generation,"revision":self.revision,"counterEpoch":self.counter_epoch,"sampleId":self.sample_id,
            "scope":scope.key(),"offset":input.offset,"total":total,"sortBy":input.sort_by,"direction":input.direction,
        });
        let page = if input.offset >= total {
            Vec::new()
        } else {
            // Partition around the requested slice, then order only that page.
            let end = (input.offset + input.limit).min(total);
            if end < total {
                rows.select_nth_unstable_by(end, compare);
            }
            let prefix = &mut rows[..end];
            if input.offset > 0 {
                prefix.select_nth_unstable_by(input.offset, compare);
            }
            let page = &mut prefix[input.offset..];
            page.sort_unstable_by(compare);
            page.iter()
                .map(|row| row.row.json(scope, row.tag, live))
                .collect()
        };
        result["endpoints"] = Value::Array(page);
        Ok(result)
    }
    pub fn history(&self) -> Value {
        json!({"generation":self.generation,"revision":self.revision,"counterEpoch":self.counter_epoch,"points":self.history})
    }
}
pub fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    #[test]
    fn projects_transport_counters_without_double_counting_helpers_or_inbound_totals() {
        let config = json!({"inbounds":[{"tag":"client"}],"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"proxy","protocol":"socks"},{"tag":"chain","protocol":"loopback"}]});
        let sources = crate::loopback::CounterSources::from([
            ("direct".into(), vec!["private-direct".into()]),
            ("proxy".into(), vec!["private-proxy".into()]),
            (
                "Local loopback".into(),
                vec!["local4".into(), "local6".into()],
            ),
        ]);
        let mut value = json!({"inbound":{"client":{"uplink":100,"downlink":200}},"outbound":{
            "direct":{"uplink":0,"downlink":0},"proxy":{"uplink":0,"downlink":0},
            "private-direct":{"uplink":10,"downlink":20},"private-proxy":{"uplink":30,"downlink":40},
            "local4":{"uplink":50,"downlink":60},"local6":{"uplink":70,"downlink":80}
        }});
        project_outbound_counters(&mut value, &sources).unwrap();
        let mut t = tracker();
        t.begin(1, 1, &config);
        t.include_outbound("Local loopback");
        t.record(&value, Instant::now(), 1000).unwrap();
        let snapshot = t.snapshot();
        assert_eq!(snapshot["uploadBytes"], "100");
        assert_eq!(snapshot["downloadBytes"], "200");
        assert_eq!(snapshot["endpointCounts"]["outbound"], 3);
        for (tag, up, down) in [
            ("direct", "10", "20"),
            ("proxy", "30", "40"),
            ("Local loopback", "120", "140"),
        ] {
            let row = snapshot["endpoints"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["scope"] == "outbound" && row["tag"] == tag)
                .unwrap();
            assert_eq!(row["uploadBytes"], up);
            assert_eq!(row["downloadBytes"], down);
        }
        assert!(snapshot["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| !row["tag"].as_str().unwrap().starts_with("private-")
                && row["tag"] != "chain"));
    }
    #[test]
    fn counter_projection_retains_gaps_and_rejects_malformed_or_overflowing_values() {
        let sources = crate::loopback::CounterSources::from([(
            "logical".into(),
            vec!["a".into(), "b".into()],
        )]);
        let mut value =
            json!({"outbound":{"a":{"uplink":5,"downlink":7},"b":{"uplink":null,"downlink":3}}});
        project_outbound_counters(&mut value, &sources).unwrap();
        assert!(value["outbound"]["logical"]["uplink"].is_null());
        assert_eq!(value["outbound"]["logical"]["downlink"], 10);
        for bad in [json!(-1), json!("1"), json!(u64::MAX)] {
            let mut value =
                json!({"outbound":{"a":{"uplink":5,"downlink":7},"b":{"uplink":bad,"downlink":3}}});
            assert!(project_outbound_counters(&mut value, &sources).is_err());
        }
    }
    #[test]
    fn metrics_json_framing_handles_chunked_strings_and_unicode_linearly() {
        let body=serde_json::to_vec(&json!({"stats":{"inbound":{},"outbound":{"name { } [ ] \" \\ 🤗":{"uplink":123,"downlink":456}}}})).unwrap();
        for size in 1..18 {
            let mut frame = JsonFrame::default();
            for (index, chunk) in body.chunks(size).enumerate() {
                frame.feed(chunk);
                assert_eq!(frame.complete, (index + 1) * size >= body.len());
            }
        }
    }
    #[test]
    fn sorts_all_columns_exactly_with_labels_missing_rates_and_stable_ties() {
        let mut t = tracker();
        t.begin(3, 9, &json!({"inbounds":[{"tag":"a"},{"tag":"m"},{"tag":"z"}],"outbounds":[{"tag":"a"},{"tag":"m"},{"tag":"z"}]}));
        t.record(
            &json!({"inbound":{},"outbound":{},"observatory":null}),
            Instant::now(),
            100,
        )
        .unwrap();
        for endpoints in &mut t.counters {
            for (tag, up, down, up_rate, down_rate) in [
                ("a", 9007199254740993, 2, None, 0.0),
                ("z", 9007199254740992, 900000, Some(2.0), 10000.0),
                ("m", u128::MAX, 10, Some(0.0), 2.0),
            ] {
                let endpoint = endpoints.get_mut(tag).unwrap();
                endpoint.upload.total = up;
                endpoint.download.total = down;
                endpoint.upload.rate = up_rate;
                endpoint.download.rate = Some(down_rate);
            }
        }
        let labels = BTreeMap::from([
            ("a".into(), "Zulu".into()),
            ("z".into(), "alpha".into()),
            ("m".into(), "ALPHA".into()),
        ]);
        let names = DisplayNames {
            inbound: labels.clone(),
            outbound: labels,
            ..DisplayNames::default()
        };
        for scope in ["inbound", "outbound"] {
            for (column, ascending, descending) in [
                ("name", ["m", "z", "a"], ["a", "m", "z"]),
                ("uploadBytes", ["z", "a", "m"], ["m", "a", "z"]),
                ("downloadBytes", ["a", "m", "z"], ["z", "m", "a"]),
                ("uploadPerSecond", ["m", "z", "a"], ["z", "m", "a"]),
                ("downloadPerSecond", ["a", "m", "z"], ["z", "m", "a"]),
            ] {
                for (direction, expected) in [("asc", ascending), ("desc", descending)] {
                    let input = wayrill_protocol::params(
                        json!({"scope":scope,"offset":0,"sortBy":column,"direction":direction}),
                    )
                    .unwrap();
                    let page = t.endpoints(input, Some((9, &names))).unwrap();
                    let actual: Vec<_> = page["endpoints"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|row| row["tag"].as_str().unwrap())
                        .collect();
                    assert_eq!(actual, expected, "{scope} {column} {direction}");
                    assert_eq!(page["sortBy"], column);
                    assert_eq!(page["direction"], direction);
                }
            }
        }
        let input = wayrill_protocol::params(json!({"scope":"outbound","offset":1,"limit":1,"sortBy":"uploadBytes","direction":"desc"})).unwrap();
        assert_eq!(
            t.endpoints(input, Some((9, &names))).unwrap()["endpoints"][0]["tag"],
            "a"
        );
        let input = wayrill_protocol::params(json!({"scope":"outbound","offset":0})).unwrap();
        assert_eq!(
            t.endpoints(input, Some((10, &names))).unwrap()["endpoints"][0]["tag"],
            "a",
            "new-profile labels must not rename old counters"
        );
        t.state = "stopped";
        let input = wayrill_protocol::params(
            json!({"scope":"outbound","offset":0,"sortBy":"uploadPerSecond","direction":"desc"}),
        )
        .unwrap();
        assert_eq!(
            t.endpoints(input, Some((9, &names))).unwrap()["endpoints"][0]["tag"],
            "m",
            "unavailable rates use stable alphabetical ties"
        );
    }
    #[test]
    fn sorts_beyond_the_snapshot_before_selecting_large_pages() {
        let mut t = tracker();
        let count = wayrill_protocol::MAX_OUTBOUNDS;
        let outputs: Vec<_> = (0..count)
            .map(|i| json!({"tag":format!("pool-{i:05}")}))
            .collect();
        t.begin(1, 2, &json!({"inbounds":[],"outbounds":outputs}));
        let counters: serde_json::Map<String, Value> = (0..count)
            .map(|i| {
                (
                    format!("pool-{i:05}"),
                    json!({"uplink":i,"downlink":count-i}),
                )
            })
            .collect();
        t.record(
            &json!({"inbound":{},"outbound":counters}),
            Instant::now(),
            100,
        )
        .unwrap();
        let started = Instant::now();
        for offset in [0, 100, 16300] {
            let input = wayrill_protocol::params(json!({"scope":"outbound","offset":offset,"sortBy":"uploadBytes","direction":"desc"})).unwrap();
            let page = t.endpoints(input, None).unwrap();
            assert_eq!(page["total"], count);
            let rows = page["endpoints"].as_array().unwrap();
            assert_eq!(rows.len(), (count - offset).min(100));
            for (index, row) in rows.iter().enumerate() {
                assert_eq!(
                    row["tag"],
                    format!("pool-{:05}", count - 1 - offset - index)
                );
            }
        }
        crate::diagnostics::error!(
            "Three complete {count}-endpoint sorts/pages: {:?}",
            started.elapsed()
        );
        for value in [
            json!({"scope":"outbound","offset":0,"sortBy":"tag"}),
            json!({"scope":"outbound","offset":0,"direction":"ascending"}),
            json!({"scope":"outbound","offset":0,"sortBy":null}),
            json!({"scope":"outbound","offset":0,"sortBy":"uploadBytes","path":"private"}),
        ] {
            assert!(wayrill_protocol::params::<EndpointPageInput>(value).is_err());
        }
    }
    #[test]
    fn hides_sink_protocols_without_hiding_idle_real_outbounds() {
        let mut t = tracker();
        t.begin(1, 2, &json!({"inbounds":[{"tag":"client"}],"outbounds":[{"tag":"renamed block","protocol":"blackhole"},{"tag":"resolver","protocol":"dns"},{"tag":"idle","protocol":"freedom"}]}));
        t.record(
            &json!({"inbound":{},"outbound":{},"observatory":null}),
            Instant::now(),
            100,
        )
        .unwrap();
        assert_eq!(t.snapshot()["endpointCounts"]["outbound"], 1);
        let page = t
            .endpoints(
                EndpointPageInput {
                    scope: EndpointScope::Outbound,
                    offset: 0,
                    limit: 100,
                    sort_by: EndpointSort::Name,
                    direction: SortDirection::Asc,
                },
                None,
            )
            .unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["endpoints"][0]["tag"], "idle");
        assert_eq!(page["endpoints"][0]["uploadBytes"], "0");
    }
    #[test]
    fn large_endpoint_sets_have_bounded_snapshots_and_complete_pages() {
        let mut t = tracker();
        let count = wayrill_protocol::MAX_OUTBOUNDS;
        let outputs: Vec<_> = (0..count)
            .map(|i| json!({"tag":format!("pool-{i:05}")}))
            .collect();
        t.begin(
            3,
            9,
            &json!({"inbounds":[{"tag":"client"}],"outbounds":outputs}),
        );
        t.record(
            &json!({"inbound":{},"outbound":{},"observatory":null}),
            Instant::now(),
            100,
        )
        .unwrap();
        let snapshot = t.snapshot();
        assert_eq!(
            snapshot["endpoints"].as_array().unwrap().len(),
            wayrill_protocol::MAX_SNAPSHOT_ENDPOINTS
        );
        assert_eq!(snapshot["endpointCounts"]["outbound"], count);
        assert_eq!(snapshot["endpointsTruncated"], true);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() < 48 * 1024);
        let page = t
            .endpoints(
                EndpointPageInput {
                    scope: EndpointScope::Outbound,
                    offset: 16300,
                    limit: 100,
                    sort_by: EndpointSort::Name,
                    direction: SortDirection::Asc,
                },
                None,
            )
            .unwrap();
        assert_eq!(page["endpoints"].as_array().unwrap().len(), 84);
        assert_eq!(page["endpoints"][83]["tag"], "pool-16383");
        assert_eq!(page["generation"], 3);
        assert_eq!(page["revision"], 9);
        assert_eq!(page["sampleId"], 1);
        assert_eq!(
            t.endpoints(
                EndpointPageInput {
                    scope: EndpointScope::Inbound,
                    offset: 0,
                    limit: 100,
                    sort_by: EndpointSort::Name,
                    direction: SortDirection::Asc,
                },
                None
            )
            .unwrap()["total"],
            1
        );
        assert!(t
            .endpoints(
                EndpointPageInput {
                    scope: EndpointScope::Outbound,
                    offset: 0,
                    limit: 101,
                    sort_by: EndpointSort::Name,
                    direction: SortDirection::Asc,
                },
                None
            )
            .is_err());
        assert!(t
            .endpoints(
                EndpointPageInput {
                    scope: EndpointScope::Outbound,
                    offset: 0,
                    limit: 0,
                    sort_by: EndpointSort::Name,
                    direction: SortDirection::Asc,
                },
                None
            )
            .is_err());
        for input in [
            json!({"scope":"user","offset":0}),
            json!({"scope":"outbound","offset":-1}),
            json!({"scope":"outbound","offset":0,"path":"private"}),
            json!({"scope":"outbound"}),
        ] {
            assert!(wayrill_protocol::params::<EndpointPageInput>(input).is_err());
        }
    }
    #[test]
    fn reads_a_complete_authenticated_response_without_waiting_for_socket_eof() {
        for large in [false, true] {
            let bridge = Bridge::new(&config()).unwrap();
            let listener = TcpListener::bind(bridge.address).unwrap();
            let password = bridge.password.clone();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut greeting = [0; 3];
                stream.read_exact(&mut greeting).unwrap();
                assert_eq!(greeting, [5, 1, 2]);
                stream.write_all(&[5, 2]).unwrap();
                let mut auth = [0; 2];
                stream.read_exact(&mut auth).unwrap();
                let mut user = vec![0; auth[1] as usize];
                stream.read_exact(&mut user).unwrap();
                assert_eq!(user, b"wayrill");
                let mut len = [0];
                stream.read_exact(&mut len).unwrap();
                let mut secret = vec![0; len[0] as usize];
                stream.read_exact(&mut secret).unwrap();
                assert_eq!(secret, password.as_bytes());
                stream.write_all(&[1, 0]).unwrap();
                let mut request = [0; 5];
                stream.read_exact(&mut request).unwrap();
                assert_eq!(&request[..4], &[5, 1, 0, 3]);
                let mut destination = vec![0; request[4] as usize + 2];
                stream.read_exact(&mut destination).unwrap();
                stream
                    .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                    .unwrap();
                let mut http = Vec::new();
                loop {
                    let mut b = [0];
                    stream.read_exact(&mut b).unwrap();
                    http.push(b[0]);
                    if http.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                assert!(http.starts_with(b"GET /debug/vars HTTP/1.0"));
                let body=serde_json::to_vec(&json!({"stats":{"inbound":{},"outbound":{}},"privatePadding":if large {"{ \\\" }".repeat(350000)} else {String::new()}})).unwrap();
                if large {
                    stream.write_all(b"HTTP/1.0 200 OK\r\n\r\n").unwrap();
                } else {
                    write!(
                        stream,
                        "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                }
                stream.write_all(&body).unwrap();
                std::thread::sleep(Duration::from_millis(1100));
            });
            assert_eq!(
                bridge.read().unwrap().counters,
                json!({"inbound":{},"outbound":{},"observatory":null})
            );
            server.join().unwrap();
        }
    }
    #[test]
    fn preserves_unreadable_totals_without_blocking_live_collection() {
        let mut t = tracker();
        std::fs::write(&t.path, b"corrupt-existing-totals").unwrap();
        let mut recovered = Traffic::new("test", t.path.clone()).unwrap();
        recovered.begin(1, 1, &config());
        recovered
            .record(&counters(10, 20), Instant::now(), 1)
            .unwrap();
        recovered.persist().unwrap();
        assert_eq!(recovered.snapshot()["downloadBytes"], "20");
        assert!(recovered.snapshot()["persistenceError"].is_string());
        assert_eq!(std::fs::read(&t.path).unwrap(), b"corrupt-existing-totals");
        std::fs::remove_file(&t.path).unwrap();
        t.dirty = false;
    }
    fn config() -> Value {
        json!({"inbounds":[{"tag":"client"}],"outbounds":[{"tag":"direct"},{"tag":"hop"}],"routing":{"rules":[{"outboundTag":"direct"}]}})
    }
    #[test]
    fn reset_is_durable_and_rebaselines_without_recounting_old_bytes() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(&counters(100, 200), now, 1000).unwrap();
        t.reset().unwrap();
        let snap = t.snapshot();
        assert_eq!(snap["uploadBytes"], "0");
        assert_eq!(snap["accumulatedDownloadBytes"], "0");
        assert_eq!(snap["counterEpoch"], 1);
        assert!(t.history()["points"].as_array().unwrap().is_empty());
        assert!(snap["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["uploadBytes"] == "0"));
        t.record(&counters(120, 240), now + Duration::from_secs(2), 3000)
            .unwrap();
        assert_eq!(t.snapshot()["uploadBytes"], "0");
        t.record(&counters(130, 270), now + Duration::from_secs(4), 5000)
            .unwrap();
        assert_eq!(t.snapshot()["uploadBytes"], "10");
        assert_eq!(t.snapshot()["downloadBytes"], "30");
        assert_eq!(t.snapshot()["generation"], 1);
        assert_eq!(t.snapshot()["revision"], 7);
        let restored = Traffic::new("test", t.path.clone()).unwrap();
        assert_eq!(restored.snapshot()["accumulatedUploadBytes"], "0");
        let _ = std::fs::remove_file(&t.path);
    }
    #[test]
    fn reset_rejects_foreign_or_corrupt_storage_without_erasing_memory_totals() {
        let mut t = tracker();
        t.record(&counters(100, 200), Instant::now(), 1000).unwrap();
        t.storage_blocked = true;
        assert!(t.reset().is_err());
        assert_eq!(t.snapshot()["uploadBytes"], "100");
        assert_eq!(t.snapshot()["counterEpoch"], 0);
    }
    fn tracker() -> Traffic {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let mut t = Traffic::new(
            "test",
            std::env::temp_dir().join(format!(
                "wayrill-traffic-{}-{}-{}.json",
                std::process::id(),
                timestamp_ms(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            )),
        )
        .unwrap();
        t.last_persist = Instant::now() + Duration::from_secs(3600);
        t.begin(1, 7, &config());
        t
    }
    fn counters(up: u64, down: u64) -> Value {
        json!({"inbound":{"client":{"uplink":up,"downlink":down},"wayrill-telemetry-in":{"uplink":90000,"downlink":90000}},"outbound":{"direct":{"uplink":up,"downlink":down},"hop":{"uplink":up,"downlink":down}}})
    }

    #[test]
    fn acquisition_time_survives_delayed_delivery_without_rate_spikes() {
        let mut t = tracker();
        let start = Instant::now();
        t.record(&counters(100, 200), start, 1000).unwrap();
        // The coordinator is busy for ten seconds. Both reads still carry their
        // actual acquisition times instead of the near-identical delivery times.
        let first = Sample {
            counters: counters(300, 800),
            observed_at: start + Duration::from_secs(2),
            timestamp_ms: 3000,
        };
        let second = Sample {
            counters: counters(1100, 3200),
            observed_at: start + Duration::from_secs(10),
            timestamp_ms: 11000,
        };
        for sample in [first, second] {
            t.record(&sample.counters, sample.observed_at, sample.timestamp_ms)
                .unwrap();
        }
        assert_eq!(t.snapshot()["uploadPerSecond"], 100.0);
        assert_eq!(t.snapshot()["downloadPerSecond"], 300.0);
        let points = t.history()["points"].as_array().unwrap().clone();
        assert_eq!(
            points[2]["elapsedMs"].as_u64().unwrap() - points[1]["elapsedMs"].as_u64().unwrap(),
            8000
        );
        assert_eq!(points[2]["timestampMs"], 11000);
        assert_eq!(points[2]["intervalMs"], 8000);
    }
    #[test]
    fn catch_up_is_not_due_and_short_final_reads_keep_bytes_without_a_rate() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(&counters(100, 200), now, 1000).unwrap();
        t.record(&counters(300, 800), now + Duration::from_secs(2), 3000)
            .unwrap();
        assert!(!t.due(now + Duration::from_millis(2050)));
        assert!(t.due(now + Duration::from_secs(4)));
        t.record(&counters(330, 890), now + Duration::from_millis(2050), 3050)
            .unwrap();
        assert_eq!(t.snapshot()["uploadBytes"], "330");
        assert_eq!(t.snapshot()["downloadBytes"], "890");
        assert_eq!(t.snapshot()["downloadPerSecond"], Value::Null);
        assert!(t.snapshot()["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["downloadPerSecond"].is_null()));
    }
    #[test]
    fn old_or_duplicate_reads_cannot_rewind_baselines_or_double_count_bytes() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(&counters(100, 200), now, 1000).unwrap();
        t.record(&counters(300, 800), now + Duration::from_secs(2), 3000)
            .unwrap();
        let before = t.snapshot();
        let history = t.history();
        t.record(&counters(50, 100), now + Duration::from_secs(1), 2000)
            .unwrap();
        t.record(&counters(300, 800), now + Duration::from_secs(2), 3000)
            .unwrap();
        assert_eq!(t.snapshot(), before);
        assert_eq!(t.history(), history);
        t.record(&counters(500, 1400), now + Duration::from_secs(4), 5000)
            .unwrap();
        assert_eq!(t.snapshot()["downloadBytes"], "1400");
        assert_eq!(t.snapshot()["downloadPerSecond"], 300.0);
    }
    #[test]
    fn missing_active_counters_create_a_gap_and_return_without_a_false_burst() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(&counters(100, 200), now, 1000).unwrap();
        t.record(&counters(300, 800), now + Duration::from_secs(2), 3000)
            .unwrap();
        let mut missing = counters(500, 1400);
        missing["inbound"]["client"]
            .as_object_mut()
            .unwrap()
            .remove("downlink");
        t.record(&missing, now + Duration::from_secs(4), 5000)
            .unwrap();
        assert_eq!(t.snapshot()["downloadPerSecond"], Value::Null);
        assert_eq!(t.snapshot()["uploadPerSecond"], 100.0);
        t.record(&counters(700, 2000), now + Duration::from_secs(6), 7000)
            .unwrap();
        assert_eq!(t.snapshot()["downloadBytes"], "2000");
        assert_eq!(t.snapshot()["downloadPerSecond"], Value::Null);
        assert_eq!(t.snapshot()["uploadPerSecond"], 100.0);
        t.record(&counters(900, 2600), now + Duration::from_secs(8), 9000)
            .unwrap();
        assert_eq!(t.snapshot()["downloadPerSecond"], 300.0);
    }
    #[test]
    fn outbound_gaps_and_resets_do_not_interrupt_other_measurements() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(&counters(100, 200), now, 1000).unwrap();
        let mut missing = counters(300, 800);
        missing["outbound"]["hop"] = json!({"downlink":800});
        t.record(&missing, now + Duration::from_secs(2), 3000)
            .unwrap();
        let snapshot = t.snapshot();
        let hop = &snapshot["endpoints"][2];
        assert_eq!(hop["tag"], "hop");
        assert!(hop["uploadPerSecond"].is_null());
        assert_eq!(hop["downloadPerSecond"], 300.0);
        assert_eq!(snapshot["uploadPerSecond"], 100.0);
        let mut returned = counters(500, 1400);
        returned["outbound"]["hop"]["downlink"] = json!(10);
        t.record(&returned, now + Duration::from_secs(4), 5000)
            .unwrap();
        let snapshot = t.snapshot();
        assert_eq!(snapshot["downloadPerSecond"], 300.0);
        assert!(snapshot["endpoints"][2]["uploadPerSecond"].is_null());
        assert!(snapshot["endpoints"][2]["downloadPerSecond"].is_null());
        assert_eq!(snapshot["endpoints"][2]["downloadBytes"], "810");
        t.record(&counters(700, 2000), now + Duration::from_secs(6), 7000)
            .unwrap();
        assert_eq!(t.snapshot()["endpoints"][2]["uploadPerSecond"], 100.0);
    }
    #[test]
    fn never_active_missing_counters_do_not_hide_other_measured_rates() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(
            &json!({"inbound":{"client":{"downlink":200}},"outbound":{}}),
            now,
            1000,
        )
        .unwrap();
        t.record(
            &json!({"inbound":{"client":{"downlink":800}},"outbound":{}}),
            now + Duration::from_secs(2),
            3000,
        )
        .unwrap();
        assert_eq!(t.snapshot()["uploadPerSecond"], 0.0);
        assert_eq!(t.snapshot()["downloadPerSecond"], 300.0);
    }
    #[test]
    fn computes_monotonic_rates_without_double_counting_outbound_hops_or_private_polls() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(&counters(100, 200), now, 1000).unwrap();
        assert_eq!(t.snapshot()["uploadPerSecond"], Value::Null);
        t.record(&counters(300, 800), now + Duration::from_secs(2), 3000)
            .unwrap();
        let s = t.snapshot();
        assert_eq!(s["uploadBytes"], "300");
        assert_eq!(s["downloadBytes"], "800");
        assert_eq!(s["uploadPerSecond"], 100.0);
        assert_eq!(s["downloadPerSecond"], 300.0);
        assert_eq!(s["endpoints"].as_array().unwrap().len(), 3);
    }
    #[test]
    fn retains_accumulated_totals_and_resets_session_history_for_new_core_generation() {
        let mut t = tracker();
        t.record(&counters(100, 200), Instant::now(), 1).unwrap();
        t.begin(2, 8, &config());
        assert_eq!(t.history()["points"], json!([]));
        t.record(&counters(10, 20), Instant::now(), 2).unwrap();
        assert_eq!(t.snapshot()["uploadBytes"], "10");
        assert_eq!(t.snapshot()["accumulatedUploadBytes"], "110");
    }
    #[test]
    fn handles_counter_resets_and_downtime_without_spikes_or_losing_totals() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(&counters(100, 200), now, 1).unwrap();
        t.record(&counters(10, 20), now + Duration::from_secs(2), 3)
            .unwrap();
        assert_eq!(t.snapshot()["uploadBytes"], "110");
        assert_eq!(t.snapshot()["uploadPerSecond"], Value::Null);
        t.unavailable();
        t.record(&counters(60, 90), now + Duration::from_secs(20), 21)
            .unwrap();
        assert_eq!(t.snapshot()["uploadBytes"], "160");
        assert_eq!(t.snapshot()["uploadPerSecond"], Value::Null);
    }
    #[test]
    fn keeps_exact_large_integer_totals_and_bounds_history() {
        let mut t = tracker();
        let now = Instant::now();
        t.record(&counters(9007199254740993, 9007199254740994), now, 1)
            .unwrap();
        assert_eq!(t.snapshot()["uploadBytes"], "9007199254740993");
        for i in 1..=350 {
            t.record(
                &counters(9007199254740993, 9007199254740994),
                now + Duration::from_secs(i),
                i,
            )
            .unwrap();
        }
        assert_eq!(t.history()["points"].as_array().unwrap().len(), 300);
    }
    #[test]
    fn discards_raw_metrics_and_rejects_errors_and_malformed_counters() {
        let value=parse_http_metrics(b"HTTP/1.0 200 OK\r\n\r\n{\"stats\":{\"inbound\":{},\"outbound\":{},\"user\":{\"private\":{}}},\"cmdline\":[\"secret\"]}").unwrap();
        assert_eq!(
            value,
            json!({"inbound":{},"outbound":{},"observatory":null})
        );
        assert!(parse_http_metrics(b"HTTP/1.0 302 Found\r\n\r\n{}").is_err());
        let mut t = tracker();
        assert!(t
            .record(
                &json!({"inbound":{"client":{"uplink":-1}}}),
                Instant::now(),
                1
            )
            .is_err());
        assert_eq!(t.snapshot()["uploadBytes"], "0");
    }
    #[test]
    fn persists_owner_scoped_totals_and_leaves_the_user_configuration_unchanged() {
        let mut t = tracker();
        t.record(&counters(100, 200), Instant::now(), 1).unwrap();
        t.persist().unwrap();
        let recovered = Traffic::new("test", t.path.clone()).unwrap();
        assert_eq!(recovered.snapshot()["accumulatedDownloadBytes"], "200");
        let other = Traffic::new("other", t.path.clone()).unwrap();
        assert_eq!(other.snapshot()["accumulatedDownloadBytes"], "0");
        assert!(other.snapshot()["persistenceError"].is_string());
        std::fs::remove_file(&t.path).unwrap();
        let mut c = config();
        c["metrics"] = json!({"tag":"existing-metrics"});
        let original = c.clone();
        let b = Bridge::new(&c).unwrap();
        assert_eq!(c, original);
        assert_eq!(b.config["metrics"]["tag"], "existing-metrics");
        assert_eq!(b.config["inbounds"][1]["settings"]["auth"], "password");
        assert_eq!(
            b.config["routing"]["rules"][0]["outboundTag"],
            "existing-metrics"
        );
    }
}
