//! Narrow service-owned bridge to the GPL capture worker. Xray stays restricted.
use crate::native::{verify_hash, Handle};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Write},
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
    System::JobObjects::*,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interfaces {
    #[serde(default = "yes")]
    pub monitor_new_interfaces: bool,
    #[serde(default)]
    pub interfaces: Vec<Interface>,
}
impl Default for Interfaces {
    fn default() -> Self {
        Self {
            monitor_new_interfaces: true,
            interfaces: Vec::new(),
        }
    }
}
fn yes() -> bool {
    true
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interface {
    pub id: String,
    pub name: String,
    pub monitored: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selector {
    pub kind: String,
    pub value: String,
    pub mode: String,
    pub children: bool,
    pub enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub tag: String,
    pub selectors: Vec<Selector>,
    pub ports: String,
    pub networks: Vec<String>,
    #[serde(default)]
    pub predicates: Vec<Vec<Selector>>,
    #[serde(default)]
    pub masks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nat_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambiguous_mask: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub version: u32,
    pub inputs: Vec<Input>,
    pub interfaces: Interfaces,
    pub bypass_local_traffic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tun_sharing: Option<crate::tun::sharing::Options>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sharing_disabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoopbackChanges {
    pub expected_version: String,
    pub changes: Vec<LoopbackChange>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoopbackChange {
    pub family: String,
    pub enabled: bool,
}
fn invalid(message: &str) -> ApiError {
    ApiError::new("INVALID_CAPTURE", message)
}
/// Saved capture relays are noauth templates, instrumented with private
/// credentials at runtime. They cannot be leased as an ordinary Windows proxy.
pub fn public_proxy_input(input: &Value, plan: Option<&Plan>) -> bool {
    wayrill_protocol::http_proxy_input(input)
        && !plan.is_some_and(|plan| {
            plan.inputs
                .iter()
                .any(|relay| input["tag"].as_str() == Some(relay.tag.as_str()))
        })
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn absolute_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with("\\\\")
        || (bytes.first().is_some_and(u8::is_ascii_alphabetic)
            && bytes.get(1) == Some(&b':')
            && matches!(bytes.get(2), Some(b'\\' | b'/')))
}
pub fn port_ranges(ports: &str) -> Result<Vec<(u16, u16)>> {
    if ports.trim().is_empty() {
        return Ok(vec![(1, 65535)]);
    }
    if ports.len() > 4096 {
        return Err(invalid("Capture port list is too long."));
    }
    ports
        .split(',')
        .map(|range| {
            let parts: Vec<_> = range.trim().split('-').collect();
            if parts.is_empty() || parts.len() > 2 {
                return Err(invalid("Invalid destination port range."));
            }
            let first: u16 = parts[0]
                .parse()
                .map_err(|_| invalid("Ports must be 1-65535."))?;
            let last: u16 = parts[parts.len() - 1]
                .parse()
                .map_err(|_| invalid("Ports must be 1-65535."))?;
            if first == 0 || first > last {
                return Err(invalid("Invalid destination port range."));
            }
            Ok((first, last))
        })
        .collect()
}
pub fn validate(plan: Option<&Plan>, config: &Value) -> Result<()> {
    let tuns = config["inbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["protocol"] == "tun")
        .count();
    if tuns > 2 || (tuns > 1 && plan.is_none_or(|p| p.tun_sharing.is_none())) {
        return Err(invalid("Use at most one host TUN and one ICS TUN."));
    }
    let Some(plan) = plan else {
        return Ok(());
    };
    if plan.version != 2
        || (plan.inputs.is_empty() && plan.tun_sharing.is_none() && !plan.sharing_disabled)
        || (plan.sharing_disabled && plan.tun_sharing.is_some())
        || plan.inputs.len() > 17
        || plan.inputs.iter().filter(|i| i.source.is_some()).count() > 1
        || plan.inputs.iter().filter(|i| i.source.is_none()).count() > 16
        || plan.interfaces.interfaces.len() > 1024
    {
        return Err(invalid("Invalid capture plan capacity/version."));
    }
    if serde_json::to_vec(plan)
        .map_err(|_| invalid("Invalid capture plan."))?
        .len()
        > 2 * 1024 * 1024
    {
        return Err(invalid("Capture plan exceeds 2 MiB."));
    }
    let mut ids = HashSet::new();
    for item in &plan.interfaces.interfaces {
        if !text(&item.id, 128) || !text(&item.name, 512) || !ids.insert(item.id.to_lowercase()) {
            return Err(invalid("Invalid or duplicate interface choice."));
        }
    }
    let inbounds = config["inbounds"]
        .as_array()
        .ok_or_else(|| invalid("Capture needs Xray inbounds."))?;
    if let Some(sharing) = &plan.tun_sharing {
        if !text(&sharing.tag, 128)
            || !crate::tun::sharing::valid_options(sharing)
            || plan.inputs.iter().any(|i| i.tag == sharing.tag)
            || !inbounds
                .iter()
                .any(|i| i["protocol"] == "tun" && i["tag"].as_str() == Some(&sharing.tag))
        {
            return Err(invalid(
                "ICS support must reference the enabled TUN inbound.",
            ));
        }
    }
    if let Some(sharing) = &plan.tun_sharing {
        if sharing.ipv6
            && !inbounds
                .iter()
                .filter(|i| i["protocol"] == "tun" && i["tag"] != sharing.tag)
                .any(|i| crate::tun::client_ipv6_settings(&i["settings"]).unwrap_or(false))
        {
            return Err(ApiError::new("ICS_IPV6_TUN","IPv6 sharing requires an enabled dual-stack host TUN with complete IPv6 capture and MTU at least 1280."));
        }
    }
    if let Some(sharing) = &plan.tun_sharing {
        let input = inbounds.iter().find(|i| i["tag"] == sharing.tag).unwrap();
        if input["settings"]["autoSystemRoutingTable"]
            .as_array()
            .is_none_or(|r| !r.is_empty())
            || input["settings"]
                .get("autoSystemWfpBlockLeak")
                .is_some_and(|v| !v.is_array() || v.as_array().is_some_and(|a| !a.is_empty()))
            || input["settings"].get("dns").is_some()
        {
            return Err(invalid(
                "ICS TUN must not install host capture routes, DNS or WFP blocking.",
            ));
        }
        for tag in &sharing.upstream_tags {
            if !config["outbounds"].as_array().is_some_and(|outbounds| {
                outbounds
                    .iter()
                    .any(|o| o["tag"] == *tag && o["protocol"] == "freedom")
            }) {
                return Err(invalid(
                    "ICS upstream binding must refer to a Direct outbound.",
                ));
            }
        }
        for rule in config["routing"]["rules"].as_array().into_iter().flatten() {
            if rule["inboundTag"]
                .as_array()
                .is_none_or(|tags| tags.is_empty() || tags.iter().any(|t| t == &sharing.tag))
                && [
                    "process",
                    "sourceIP",
                    "sourcePort",
                    "user",
                    "localIP",
                    "localPort",
                    "localOS",
                    "vlessRoute",
                ]
                .iter()
                .any(|key| rule.get(key).is_some())
            {
                return Err(invalid("ICS traffic cannot match host processes, proxy accounts or original client identity. Scope that rule to a host input."));
            }
        }
    }
    let mut tags = HashSet::new();
    for input in &plan.inputs {
        if !text(&input.tag, 128)
            || !tags.insert(&input.tag)
            || input.selectors.len() > 4096
            || input.networks.is_empty()
            || input.networks.len() > 2
            || input.networks.iter().any(|n| n != "tcp" && n != "udp")
            || input.networks.iter().collect::<HashSet<_>>().len() != input.networks.len()
        {
            return Err(invalid("Invalid capture input identity/networks."));
        }
        let inbound = inbounds
            .iter()
            .find(|i| i["tag"].as_str() == Some(&input.tag))
            .ok_or_else(|| invalid("Capture tag has no inbound."))?;
        let tun = input.source.as_deref() == Some("tun");
        if input.source.is_some() && !tun {
            return Err(invalid("Unknown local capture source."));
        }
        if tun {
            if inbound["protocol"] != "tun"
                || !input.selectors.is_empty()
                || !input.ports.is_empty()
                || input.networks != ["tcp", "udp"]
                || input
                    .nat_tag
                    .as_deref()
                    .is_some_and(|tag| tag != "wayrill-runtime-nat")
            {
                return Err(invalid("Invalid TUN application scope."));
            }
        } else if input.nat_tag.is_some()
            || inbound["protocol"] != "socks"
            || inbound["listen"] != "127.0.0.1"
            || !inbound["port"]
                .as_u64()
                .is_some_and(|p| (1024..=65535).contains(&p))
            || inbound["settings"]["udp"] != true
            || inbound.get("streamSettings").is_some()
            || inbound["settings"]["auth"] != "noauth"
            || inbound["settings"].get("accounts").is_some()
        {
            return Err(invalid("Capture requires a plain IPv4 loopback SOCKS input with UDP; runtime authentication is service-owned."));
        }
        if input.predicates.len() > 768
            || input.predicates.iter().map(Vec::len).sum::<usize>() > 4096
        {
            return Err(invalid("Windows application predicates exceed capacity."));
        }
        let digits = input.predicates.len().div_ceil(4).max(1);
        if let Some(mask) = &input.ambiguous_mask {
            if !tun
                || mask.len() < digits
                || mask.len() > 192
                || !mask
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || input
                    .masks
                    .iter()
                    .any(|m| m.trim_start_matches('0') == mask.trim_start_matches('0'))
            {
                return Err(invalid("Invalid ambiguous TUN identity profile."));
            }
        }
        {
            let mut masks = HashSet::new();
            if input.masks.is_empty()
                || input.masks.len() > 4096
                || !input.masks.contains(&"0".repeat(digits))
            {
                return Err(invalid("Invalid Windows identity profiles."));
            }
            for mask in &input.masks {
                if mask.len() != digits
                    || !mask
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    || !masks.insert(mask)
                {
                    return Err(invalid("Invalid or duplicate Windows identity profile."));
                }
                if (input.predicates.is_empty() && mask != "0")
                    || (input.predicates.len() % 4 != 0
                        && u8::from_str_radix(&mask[..1], 16).unwrap()
                            >= 1 << (input.predicates.len() % 4))
                {
                    return Err(invalid(
                        "Windows identity profile exceeds its predicate width.",
                    ));
                }
            }
        }
        if input
            .predicates
            .iter()
            .any(|p| p.is_empty() || p.iter().all(|s| !s.enabled))
        {
            return Err(invalid("An application predicate needs enabled selectors."));
        }
        for s in input
            .selectors
            .iter()
            .chain(input.predicates.iter().flatten())
        {
            if !text(&s.value, 4096)
                || !["process", "package", "service"].contains(&s.kind.as_str())
                || !["name", "path", "folder"].contains(&s.mode.as_str())
                || (s.kind == "service" && s.children)
            {
                return Err(invalid("Invalid process, package or service selector."));
            }
            if s.kind == "process" && s.mode != "name" && !absolute_windows_path(&s.value) {
                return Err(invalid("Executable and folder paths must be absolute."));
            }
        }
        port_ranges(&input.ports)?;
    }
    Ok(())
}
fn secret() -> Result<String> {
    let mut bytes = [0u8; 24];
    if unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err(ApiError::new(
            "OS_ERROR",
            "Generate capture authentication.",
        ));
    }
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
// Random credentials exist only in the running configuration and inherited worker pipe.
pub fn instrument(plan: Option<&Plan>, config: &Value) -> Result<(Value, Option<Value>)> {
    validate(plan, config)?;
    let mut config = config.clone();
    let Some(plan) = plan else {
        return Ok((config, None));
    };
    let mut worker_plan = plan.clone();
    worker_plan.inputs.retain(|i| i.source.is_none());
    worker_plan.tun_sharing = None;
    worker_plan.sharing_disabled = false;
    if worker_plan.inputs.is_empty() {
        return Ok((config, None));
    }
    let mut worker = serde_json::to_value(&worker_plan).unwrap();
    worker.as_object_mut().unwrap().remove("version");
    let udp_options = crate::sockets::udp_buffer_options(&config);
    for (index, input) in worker_plan.inputs.iter().enumerate() {
        let username = secret()?;
        let password = secret()?;
        let inbound = config["inbounds"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|i| i["tag"] == input.tag)
            .unwrap();
        let port = inbound["port"].as_u64().unwrap();
        inbound["streamSettings"] = json!({"sockopt":udp_options.clone()});
        inbound["settings"]["auth"] = json!("password");
        inbound["settings"]["accounts"] = {
            json!(input
                .masks
                .iter()
                .map(|mask| json!({"user":format!("wr-{mask}-{username}"),"pass":password}))
                .collect::<Vec<_>>())
        };
        inbound["settings"]["ip"] = json!("127.0.0.1");
        worker["inputs"][index]["endpoint"] =
            json!({"port":port,"username":username,"password":password});
    }
    if serde_json::to_vec(&config).unwrap().len() > wayrill_protocol::MAX_CONFIG {
        return Err(invalid(
            "Runtime application authentication exceeds the core configuration byte limit.",
        ));
    }
    Ok((config, Some(worker)))
}

pub(crate) struct Worker {
    resource_sample: Option<Instant>,
    component: &'static str,
    child: Child,
    input: mpsc::SyncSender<(u64, Vec<u8>)>,
    written: mpsc::Receiver<(u64, Result<()>)>,
    output: mpsc::Receiver<Result<Value>>,
    job: Handle,
    sequence: u64,
    graceful_stop: bool,
    synchronized: bool,
}
impl Worker {
    fn verify(root: &Path, attribution: bool) -> Result<()> {
        let entries: Vec<Value> = serde_json::from_str(if attribution {
            include_str!("attribution-manifest.json")
        } else {
            include_str!("capture-manifest.json")
        })
        .map_err(|_| invalid("Invalid embedded capture manifest."))?;
        if entries.is_empty() {
            return Err(ApiError::new(
                "CAPTURE_UNAVAILABLE",
                "Capture worker has not been packaged.",
            ));
        }
        for entry in entries {
            verify_hash(
                &root.join(entry["path"].as_str().unwrap()),
                entry["sha256"].as_str().unwrap(),
            )?;
        }
        if attribution {
            return Ok(());
        }
        let driver = root.parent().unwrap().join("windivert");
        verify_hash(
            &driver.join("WinDivert.dll"),
            "c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2",
        )?;
        verify_hash(
            &driver.join("WinDivert64.sys"),
            "8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2",
        )?;
        Ok(())
    }
    pub(crate) fn spawn(root: &Path) -> Result<Self> {
        Self::spawn_kind(root, false)
    }
    pub(crate) fn spawn_attribution(root: &Path) -> Result<Self> {
        Self::spawn_kind(root, true)
    }
    fn spawn_kind(root: &Path, attribution: bool) -> Result<Self> {
        Self::verify(root, attribution)?;
        let mut child = Command::new(root.join(if attribution {
            "wayrill-attribution.exe"
        } else {
            "wayrill-capture.exe"
        }))
        .current_dir(root)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ApiError::io("Start capture worker", e))?;
        let job = unsafe { Handle(CreateJobObjectW(std::ptr::null(), std::ptr::null())) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.JobMemoryLimit = 512 * 1024 * 1024;
        if job.0.is_null()
            || unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            || unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(crate::native::os_error("Contain capture worker"));
        }
        crate::diagnostics::output(
            child.stderr.take().unwrap(),
            if attribution {
                "attribution"
            } else {
                "capture"
            },
        )
        .inspect_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
        })?;
        let mut stdin = child.stdin.take().unwrap();
        let (input, requests) = mpsc::sync_channel::<(u64, Vec<u8>)>(1);
        let (acknowledge, written) = mpsc::sync_channel(1);
        let stdout = child.stdout.take().unwrap();
        let (send, output) = mpsc::sync_channel(4);
        std::thread::Builder::new()
            .name("wayrill-capture-output".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut bytes = Vec::new();
                    let result = std::io::Read::take(&mut reader, 8 * 1024 * 1024 + 1)
                        .read_until(b'\n', &mut bytes);
                    match result {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    };
                    if bytes.len() > 8 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
                        let _ = send.try_send(Err(ApiError::new(
                            "CAPTURE_ERROR",
                            "Worker response exceeds capacity.",
                        )));
                        break;
                    }
                    let parsed = serde_json::from_slice(&bytes)
                        .map_err(|_| ApiError::new("CAPTURE_ERROR", "Invalid worker response."));
                    if send.send(parsed).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                ApiError::io("Start capture output reader", error)
            })?;
        std::thread::Builder::new()
            .name("wayrill-capture-input".into())
            .spawn(move || {
                while let Ok((id, frame)) = requests.recv() {
                    let result = stdin
                        .write_all(&frame)
                        .map_err(|e| ApiError::io("Write capture request", e));
                    let failed = result.is_err();
                    if acknowledge.send((id, result)).is_err() || failed {
                        break;
                    }
                }
            })
            .map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                ApiError::io("Start capture input writer", error)
            })?;
        Ok(Self {
            child,
            input,
            written,
            output,
            job,
            sequence: 0,
            graceful_stop: attribution,
            resource_sample: None,
            component: if attribution {
                "attribution"
            } else {
                "capture"
            },
            synchronized: true,
        })
    }
    /// Drain the observers first; Drop still ends the contained process on error.
    pub(crate) fn stop(mut self) -> Result<()> {
        self.graceful_stop = false;
        self.call("stop", json!({})).map(|_| ())
    }
    pub(crate) fn call(&mut self, method: &str, data: Value) -> Result<Value> {
        if method == "stop"
            || self
                .resource_sample
                .is_none_or(|sample| sample.elapsed() >= Duration::from_secs(60))
        {
            crate::diagnostics::process(self.component, self.child.id());
            self.resource_sample = Some(Instant::now());
        }
        if !self.synchronized {
            return Err(ApiError::new(
                "CAPTURE_ERROR",
                "Worker transport is no longer synchronized; restart is required.",
            ));
        }
        let response_timeout = worker_response_timeout(method);
        let operation = if method == "sharing.set" {
            match data["role"].as_i64() {
                Some(0) => "sharing.enablePublic",
                Some(1) => "sharing.enablePrivate",
                _ if data["role"].is_null() => "sharing.disable",
                _ => method,
            }
        } else {
            method
        };
        self.sequence += 1;
        let mut frame =
            serde_json::to_vec(&json!({"id":self.sequence,"method":method,"data":data})).unwrap();
        frame.push(b'\n');
        // After an uncertain exchange, a late response cannot be paired with a
        // new command (including Drop's stop request). Retire the owned job.
        self.synchronized = false;
        let response = (|| {
            let started = Instant::now();
            let deadline = started + response_timeout;
            self.input.try_send((self.sequence, frame)).map_err(|_| {
                ApiError::new("CAPTURE_ERROR", "Capture request writer is unavailable.")
            })?;
            wait_written(
                &self.written,
                self.sequence,
                started + Duration::from_secs(15),
            )?;
            let mut deadline = deadline;
            loop {
                let response = self.output.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .map_err(|_| ApiError::new("CAPTURE_ERROR", "Capture worker stopped responding; the mutation outcome must be reconciled."))??;
                if let Some(progress) = worker_progress(&response, self.sequence, method)? {
                    crate::activity::report(progress);
                    deadline = Instant::now() + response_timeout;
                    continue;
                }
                validate_worker_response(&response, self.sequence)?;
                break Ok(response);
            }
        })()
        .map_err(|mut error: ApiError| {
            error.message = format!("{operation}: {}", error.message);
            if let Ok(Some(status)) = self.child.try_wait() {
                error.message.push_str(&format!(" Worker exited with code {:?}.",status.code()));
            }
            crate::diagnostics::log(self.component,"error",&error.message);
            error
        })?;
        self.synchronized = true;
        if response["ok"] != true {
            return Err(ApiError::new(
                response["error"]["code"]
                    .as_str()
                    .unwrap_or("CAPTURE_ERROR"),
                response["error"]["message"]
                    .as_str()
                    .unwrap_or("Capture operation failed."),
            ));
        }
        Ok(response["result"].clone())
    }
}
fn worker_response_timeout(method: &str) -> Duration {
    // Inactivity bounds, not native completion deadlines. Only a correctly
    // correlated, typed ICS progress frame renews the wait. Never replay a
    // mutation after transport loss.
    Duration::from_secs(if method == "sharing.set" { 30 } else { 15 })
}
fn worker_progress(
    response: &Value,
    sequence: u64,
    method: &str,
) -> Result<Option<wayrill_protocol::NativeActivity>> {
    let Some(progress) = response.get("progress") else {
        return Ok(None);
    };
    if !matches!(method, "sharing.set" | "sharing.inspect")
        || response["id"].as_u64() != Some(sequence)
        || response.get("ok").is_some()
    {
        return Err(ApiError::new(
            "CAPTURE_ERROR",
            "Invalid native progress identity or envelope.",
        ));
    }
    serde_json::from_value(progress.clone())
        .map(Some)
        .map_err(|_| ApiError::new("CAPTURE_ERROR", "Invalid native progress phase."))
}
fn validate_worker_response(response: &Value, sequence: u64) -> Result<()> {
    if response["id"].as_u64() != Some(sequence) || response["ok"].as_bool().is_none() {
        return Err(ApiError::new(
            "CAPTURE_ERROR",
            "Invalid capture response identity or envelope.",
        ));
    }
    Ok(())
}
fn wait_written(
    written: &mpsc::Receiver<(u64, Result<()>)>,
    sequence: u64,
    deadline: Instant,
) -> Result<()> {
    let (id, result) = written
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| {
            ApiError::new(
                "CAPTURE_ERROR",
                "Capture request write timed out or disconnected.",
            )
        })?;
    if id != sequence {
        return Err(ApiError::new(
            "CAPTURE_ERROR",
            "Capture write identity mismatch.",
        ));
    }
    result
}
impl Drop for Worker {
    fn drop(&mut self) {
        // Includes abandoned candidates/one-shot companions. A hard process kill
        // cannot run ETW/COM destructors and leaves the owned trace session alive.
        if self.graceful_stop && self.synchronized && matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.call("stop", json!({}));
        }
        crate::diagnostics::job(
            self.component,
            self.child.id(),
            &self.job,
            self.child
                .try_wait()
                .ok()
                .flatten()
                .and_then(|status| status.code()),
        );
        if unsafe { TerminateJobObject(self.job.0, 0) } == 0 {
            let _ = self.child.kill();
        }
        // Never block the lifecycle forever if Windows cannot terminate a child.
        // Closing this owned kill-on-close job remains the final containment step.
        let deadline = Instant::now() + Duration::from_secs(5);
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
fn availability_result(result: &Result<Value>) -> Value {
    match result {
        Ok(_) => json!({"state":"available","message":null}),
        Err(error) => {
            json!({"state":if error.code == "WINDIVERT_CONFLICT" {"blocked"} else {"unknown"},"message":error.message.strip_prefix("WINDIVERT_CONFLICT: ").unwrap_or(&error.message)})
        }
    }
}
// Explicit graph choices take precedence over persisted first-seen choices. Changing
// the default for new adapters must never reclassify an adapter already discovered.
fn merge_interfaces(explicit: &Interfaces, known: &[Interface]) -> Result<Interfaces> {
    let mut merged = explicit.clone();
    let mut ids: HashSet<_> = explicit
        .interfaces
        .iter()
        .map(|i| i.id.to_lowercase())
        .collect();
    for item in known {
        if ids.insert(item.id.to_lowercase()) {
            merged.interfaces.push(item.clone());
        }
    }
    if merged.interfaces.len() > 1024 {
        return Err(invalid("Too many retained interface choices."));
    }
    Ok(merged)
}
pub struct Manager {
    root: PathBuf,
    interface_path: PathBuf,
    known: Vec<Interface>,
    worker: Option<Worker>,
    last: Value,
    availability: Value,
    availability_checked: Option<Instant>,
}
impl Manager {
    pub fn new(root: PathBuf, interface_path: PathBuf) -> Result<Self> {
        let known = crate::storage::read::<Vec<Interface>>(&interface_path)?.unwrap_or_default();
        if known.len() > 1024
            || known
                .iter()
                .any(|i| !text(&i.id, 128) || !text(&i.name, 512))
            || known
                .iter()
                .map(|i| i.id.to_lowercase())
                .collect::<HashSet<_>>()
                .len()
                != known.len()
        {
            return Err(invalid("Invalid retained interface choices."));
        }
        let mut manager = Self {
            root,
            interface_path,
            known,
            worker: None,
            last: json!({"state":"stopped","mode":"routing","inputs":[]}),
            availability: json!({"state":"unknown","message":"Capture ownership has not been checked."}),
            availability_checked: None,
        };
        let _ = manager.recover_firewall();
        manager.refresh_availability(true);
        Ok(manager)
    }
    pub fn preflight(&mut self, plan: &Plan) -> Result<()> {
        if plan
            .inputs
            .iter()
            .all(|i| i.source.as_deref() == Some("tun"))
        {
            return Ok(());
        }
        self.check_available()
    }
    pub fn check_available(&mut self) -> Result<()> {
        let result = self.once("check", json!({"ownedCapturePid":self.worker.as_ref().map(|w|w.child.id()),"servicePid":std::process::id()}));
        self.availability = availability_result(&result);
        self.availability_checked = Some(Instant::now());
        result.map(|_| ())
    }
    pub fn refresh_availability(&mut self, force: bool) -> bool {
        if self.worker.is_some()
            || (!force
                && self
                    .availability_checked
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(5)))
        {
            return false;
        }
        let previous = self.availability.clone();
        let _ = self.check_available(); // Failure blocks capture; it must not prevent service/editor use.
        previous != self.availability
    }
    pub fn status(&self) -> Value {
        let mut status = self.last.clone();
        status["availability"] = self.availability.clone();
        status
    }
    pub fn start(
        &mut self,
        plan: Option<Value>,
        core_pids: &[u32],
        excluded_interfaces: &[String],
    ) -> Result<()> {
        let Some(mut plan) = plan else {
            return self.stop(); // A ready replacement graph explicitly removed capture.
        };
        let explicit: Interfaces = serde_json::from_value(plan["interfaces"].clone())
            .map_err(|_| invalid("Invalid worker interface choices."))?;
        plan["interfaces"] =
            serde_json::to_value(merge_interfaces(&explicit, &self.known)?).unwrap();
        if let Some(worker) = &mut self.worker {
            // Reuse NETWORK and observation handles so replacement never creates
            // a native-traffic window between two contained capture workers.
            let status = worker.call(
                "reconfigure",
                json!({"plan":plan,"corePids":core_pids,"excludedInterfaces":excluded_interfaces}),
            )?;
            if status["state"] != "running" {
                return Err(ApiError::new(
                    "CAPTURE_FAILED",
                    "Capture cannot accept the replacement configuration.",
                ));
            }
            self.last = status;
            self.remember_interfaces()?;
            return Ok(());
        }
        self.stop()?;
        let mut worker = Worker::spawn(&self.root)?;
        let result = worker.call(
            "start",
            json!({"plan":plan,"corePids":core_pids,"excludedInterfaces":excluded_interfaces}),
        );
        match result {
            Ok(status) => {
                self.last = status;
                self.availability = json!({"state":"available","message":null});
            }
            Err(error) => {
                self.availability = availability_result(&Err(error.clone()));
                drop(worker);
                let cleanup = self.recover_firewall();
                return Err(crate::lifecycle::Cleanup::after_failure(
                    error,
                    "capture firewall recovery",
                    cleanup,
                ));
            }
        }
        if let Err(error) = self.remember_interfaces() {
            let _ = worker.call("stop", json!({}));
            drop(worker);
            let cleanup = self.recover_firewall();
            return Err(crate::lifecycle::Cleanup::after_failure(
                error,
                "capture firewall recovery",
                cleanup,
            ));
        }
        self.worker = Some(worker);
        Ok(())
    }
    pub fn poll(&mut self) -> Result<()> {
        if let Some(worker) = &mut self.worker {
            if worker
                .child
                .try_wait()
                .map_err(|e| ApiError::io("Observe capture worker", e))?
                .is_some()
            {
                return Err(ApiError::new(
                    "CAPTURE_EXITED",
                    "Capture worker exited unexpectedly.",
                ));
            }
            self.last = worker.call("status", json!({}))?;
            if self.last["state"] != "running" {
                return Err(ApiError::new(
                    "CAPTURE_FAILED",
                    self.last["lastError"]
                        .as_str()
                        .unwrap_or("Capture/ownership observation failed; restart is manual."),
                ));
            }
            self.remember_interfaces()?;
        }
        Ok(())
    }
    pub fn stop(&mut self) -> Result<()> {
        let result = if let Some(mut worker) = self.worker.take() {
            let stopped = worker.call("stop", json!({}));
            drop(worker); // End owned handles before recovering an orphaned rule.
            match stopped {
                Ok(_) => {
                    self.last["firewallRecoveryError"] = Value::Null;
                    Ok(())
                }
                Err(error) => match self.recover_firewall() {
                    // Ending the contained job and recovering its rule is a
                    // complete Stop even when the old IPC reply was lost.
                    Ok(()) => Ok(()),
                    Err(recovery) => Err(crate::lifecycle::Cleanup::after_failure(
                        error,
                        "capture firewall recovery",
                        Err(recovery),
                    )),
                },
            }
        } else {
            Ok(())
        };
        self.last["state"] = json!(if result.is_ok() { "stopped" } else { "failed" });
        self.last["firewallManaged"] = json!(false);
        result
    }
    pub fn failed(&mut self, error: &ApiError) {
        self.last["state"] = json!("failed");
        self.last["lastError"] = json!(error.message);
    }
    fn recover_firewall(&mut self) -> Result<()> {
        let result = self.once("firewall.clear", json!({}));
        self.last["firewallRecoveryError"] = result
            .as_ref()
            .err()
            .map(|error| json!(error.message))
            .unwrap_or(Value::Null);
        result.map(|_| ())
    }
    fn remember_interfaces(&mut self) -> Result<()> {
        let value: Interfaces = serde_json::from_value(self.last["interfaces"].clone())
            .map_err(|_| invalid("Invalid discovered interface choices."))?;
        let next = merge_interfaces(&value, &self.known)?.interfaces;
        if next != self.known {
            crate::storage::write(&self.interface_path, &next)?;
            self.known = next;
        }
        Ok(())
    }
    pub fn once(&self, method: &str, data: Value) -> Result<Value> {
        let mut worker = if [
            "catalog",
            "loopback.get",
            "loopback.set",
            "sharing.inspect",
            "sharing.set",
        ]
        .contains(&method)
        {
            Worker::spawn_attribution(&self.root.parent().unwrap().join("attribution"))?
        } else {
            Worker::spawn(&self.root)?
        };
        let mut result = worker.call(method, data)?;
        if method == "catalog" {
            result["captureInterfaces"] = json!(self.known);
        }
        Ok(result)
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tun_application_plan_is_separate_from_packet_capture() {
        let mut p = plan();
        p.inputs[0].source = Some("tun".into());
        p.inputs[0].selectors.clear();
        p.inputs[0].predicates = vec![vec![Selector {
            kind: "package".into(),
            value: "Example_family".into(),
            mode: "name".into(),
            children: true,
            enabled: true,
        }]];
        p.inputs[0].masks = vec!["0".into(), "1".into()];
        let c = json!({"inbounds":[{"tag":p.inputs[0].tag,"protocol":"tun","settings":{}}],"outbounds":[{"tag":"direct","protocol":"freedom"}]});
        assert!(validate(Some(&p), &c).is_ok());
        let (same, packet) = instrument(Some(&p), &c).unwrap();
        assert_eq!(same, c);
        assert!(packet.is_none());
        let mut malformed = p.clone();
        malformed.inputs[0].source = Some("unknown".into());
        assert!(validate(Some(&malformed), &c).is_err());
        let mut malformed = p.clone();
        malformed.inputs[0].source = None;
        assert!(validate(Some(&malformed), &c).is_err());
        let mut malformed = p.clone();
        malformed.inputs[0].predicates[0][0].kind = "unknown".into();
        assert!(validate(Some(&malformed), &c).is_err());
        let mut malformed = p;
        malformed.inputs[0].predicates[0][0].kind = "service".into();
        assert!(validate(Some(&malformed), &c).is_err()); // service descendants are never guessed
    }
    #[test]
    fn nat_scope_is_fixed_and_available_without_application_predicates() {
        let mut p = plan();
        p.inputs[0].source = Some("tun".into());
        p.inputs[0].selectors.clear();
        p.inputs[0].predicates.clear();
        p.inputs[0].masks = vec!["0".into()];
        p.inputs[0].nat_tag = Some("wayrill-runtime-nat".into());
        let c = json!({"inbounds":[{"tag":p.inputs[0].tag,"protocol":"tun","settings":{}}],"outbounds":[{"tag":"direct","protocol":"freedom"}]});
        assert!(validate(Some(&p), &c).is_ok());
        p.inputs[0].nat_tag = Some("arbitrary-inbound".into());
        assert!(validate(Some(&p), &c).is_err());
        p.inputs[0].nat_tag = Some("wayrill-runtime-nat".into());
        p.inputs[0].source = None;
        assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_err());
    }
    #[test]
    fn stalled_capture_writes_and_stale_acknowledgements_are_bounded() {
        let (sender, written) = mpsc::sync_channel(1);
        let start = Instant::now();
        assert!(wait_written(&written, 1, start + Duration::from_millis(20)).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        sender.send((1, Ok(()))).unwrap();
        assert!(wait_written(&written, 2, Instant::now() + Duration::from_secs(1)).is_err());
        sender.send((3, Ok(()))).unwrap();
        assert!(wait_written(&written, 3, Instant::now() + Duration::from_secs(1)).is_ok());
    }
    #[test]
    fn worker_waits_are_inactivity_budgets() {
        assert_eq!(
            worker_response_timeout("sharing.set"),
            Duration::from_secs(30)
        );
        for method in [
            "sharing.inspect",
            "stop",
            "applications.start",
            "applications.status",
            "status",
            "catalog",
        ] {
            assert_eq!(worker_response_timeout(method), Duration::from_secs(15));
        }
    }
    #[test]
    fn progress_is_typed_correlated_and_only_valid_for_native_sharing() {
        let frame = json!({"id":7,"progress":{"phase":"enablePublic","elapsedMs":45000}});
        assert!(worker_progress(&frame, 7, "sharing.set").unwrap().is_some());
        assert!(worker_progress(&frame, 7, "sharing.inspect")
            .unwrap()
            .is_some());
        assert!(worker_progress(&frame, 8, "sharing.set").is_err());
        assert!(worker_progress(&frame, 7, "stop").is_err());
        let mut bad = frame.clone();
        bad["ok"] = json!(true);
        assert!(worker_progress(&bad, 7, "sharing.set").is_err());
        let mut bad = frame;
        bad["progress"]["phase"] = json!("arbitrary");
        assert!(worker_progress(&bad, 7, "sharing.set").is_err());
    }
    #[test]
    fn only_a_matching_worker_envelope_allows_another_command() {
        for response in [
            json!(null),
            json!({"id":1,"ok":true}),
            json!({"id":2}),
            json!({"id":2,"ok":"true"}),
        ] {
            assert!(validate_worker_response(&response, 2).is_err());
        }
        assert!(validate_worker_response(
            &json!({"id":2,"ok":false,"error":{"code":"ICS_STATE","message":"Conflict"}}),
            2
        )
        .is_ok());
        assert!(validate_worker_response(&json!({"id":2,"ok":true,"result":{}}), 2).is_ok());
    }
    #[test]
    fn uncertain_ownership_never_becomes_available() {
        assert_eq!(
            availability_result(&Ok(json!({"available":true})))["state"],
            "available"
        );
        let conflict = Err(ApiError::new(
            "WINDIVERT_CONFLICT",
            "WINDIVERT_CONFLICT: v2rayN is active.",
        ));
        assert_eq!(availability_result(&conflict)["state"], "blocked");
        assert_eq!(
            availability_result(&conflict)["message"],
            "v2rayN is active."
        );
        assert_eq!(
            availability_result(&Err(ApiError::new(
                "CAPTURE_ERROR",
                "Inventory unavailable"
            )))["state"],
            "unknown"
        );
    }
    #[test]
    fn sharing_off_metadata_is_valid_without_packet_capture_and_never_reaches_workers() {
        let config = wayrill_protocol::direct_example();
        let mut p = plan();
        p.sharing_disabled = true;
        validate(Some(&p), &config).unwrap();
        let (_, worker) = instrument(Some(&p), &config).unwrap();
        assert!(worker.unwrap().get("sharingDisabled").is_none());
        p.inputs.clear();
        validate(Some(&p), &config).unwrap();
        assert!(instrument(Some(&p), &config).unwrap().1.is_none());
        p.sharing_disabled = false;
        assert!(validate(Some(&p), &config).is_err());
    }
    fn plan() -> Plan {
        serde_json::from_value(json!({"version":2,"inputs":[{"tag":"local-socks","selectors":[{"kind":"process","value":"curl.exe","mode":"name","children":true,"enabled":true}],"ports":"","networks":["tcp","udp"],"predicates":[],"masks":["0"]}],"interfaces":{"monitorNewInterfaces":true,"interfaces":[]},"bypassLocalTraffic":true})).unwrap()
    }

    #[test]
    fn ambiguous_identity_is_tun_only_and_disjoint_from_normal_profiles() {
        let mut p = plan();
        p.inputs[0].ambiguous_mask = Some("1".into());
        assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_err());
        p.inputs[0].source = Some("tun".into());
        p.inputs[0].selectors.clear();
        let config = json!({"inbounds":[{"tag":"local-socks","protocol":"tun","settings":{}}],"outbounds":[{"tag":"direct","protocol":"freedom"}]});
        validate(Some(&p), &config).unwrap();
        for mask in ["", "0", "00", "Q", &"f".repeat(193)] {
            p.inputs[0].ambiguous_mask = Some(mask.into());
            assert!(validate(Some(&p), &config).is_err(), "{mask}");
        }
    }
    #[test]
    fn zero_predicates_cannot_claim_nonzero_identity_bits() {
        let mut p = plan();
        p.inputs[0].masks.push("f".into());
        assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_err());
    }
    #[test]
    fn runtime_credentials_are_private_and_rotate() {
        let p = plan();
        let config = wayrill_protocol::direct_example();
        let (a, worker) = instrument(Some(&p), &config).unwrap();
        let (b, _) = instrument(Some(&p), &config).unwrap();
        assert_ne!(a, b);
        assert_eq!(config["inbounds"][0]["settings"]["auth"], "noauth");
        assert!(config["inbounds"][0].get("streamSettings").is_none());
        assert_eq!(
            a["inbounds"][0]["streamSettings"]["sockopt"],
            crate::sockets::udp_buffer_options(&config)
        );
        assert_eq!(
            a["inbounds"][0]["settings"]["accounts"][0]["user"],
            format!(
                "wr-0-{}",
                worker.as_ref().unwrap()["inputs"][0]["endpoint"]["username"]
                    .as_str()
                    .unwrap()
            )
        );
        let input = &worker.unwrap()["inputs"][0];
        assert_eq!(input["masks"], json!(["0"]));
        assert_eq!(input["predicates"], json!([]));
    }
    #[test]
    fn application_profiles_authenticate_all_matching_predicates_and_remain_private() {
        let mut p = plan();
        p.inputs[0].predicates = vec![p.inputs[0].selectors.clone()];
        p.inputs[0].selectors.clear();
        p.inputs[0].masks = vec!["0".into(), "1".into()];
        let template = wayrill_protocol::direct_example();
        let (config, worker) = instrument(Some(&p), &template).unwrap();
        let worker = worker.unwrap();
        let suffix = worker["inputs"][0]["endpoint"]["username"]
            .as_str()
            .unwrap();
        assert_eq!(
            config["inbounds"][0]["settings"]["accounts"][1]["user"],
            format!("wr-1-{suffix}")
        );
        assert_eq!(
            config["inbounds"][0]["settings"]["accounts"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(template["inbounds"][0]["settings"]
            .get("accounts")
            .is_none());
        for mask in ["2", "00", "Z"] {
            p.inputs[0].masks = vec!["0".into(), mask.into()];
            assert!(validate(Some(&p), &template).is_err());
        }
        p.inputs[0].masks = vec!["0".into(), "0".into()];
        assert!(validate(Some(&p), &template).is_err());
    }
    #[test]
    fn private_relays_cannot_be_leased_as_a_windows_proxy() {
        let p = plan();
        let mut config = wayrill_protocol::direct_example();
        let port = config["inbounds"][0]["port"].as_u64().unwrap() as u16;
        assert!(public_proxy_input(&config["inbounds"][0], None));
        assert!(!public_proxy_input(&config["inbounds"][0], Some(&p)));
        let mut public = config["inbounds"][0].clone();
        public["tag"] = json!("public-http");
        public["port"] = json!(port + 1);
        config["inbounds"].as_array_mut().unwrap().push(public);
        assert!(public_proxy_input(&config["inbounds"][2], Some(&p)));
    }
    #[test]
    fn current_full_capture_is_explicit_and_retired_versions_and_bad_targets_are_rejected() {
        let mut p = plan();
        p.inputs[0].selectors.clear();
        assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_ok());
        p.version = 1;
        assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_err());
        p.version = 2;
        p.inputs[0].ports = "80,443".into();
        assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_ok());
        p.inputs[0].tag = "missing".into();
        assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_err());
    }
    #[test]
    fn ports_are_bounded() {
        for value in ["0", "65536", "80-1", "1-2-3", "80,,443", "-1"] {
            assert!(port_ranges(value).is_err(), "{value}");
        }
        assert_eq!(
            port_ranges("80,443-444").unwrap(),
            vec![(80, 80), (443, 444)]
        );
    }
    #[test]
    fn sharing_requires_a_unique_service_role_without_host_routes_or_source_identity() {
        let mut config = json!({"inbounds":[{"protocol":"tun","tag":"shared","settings":{"autoSystemRoutingTable":[]}}],"outbounds":[{"protocol":"freedom","tag":"upstream"}],"routing":{"rules":[]}});
        let mut p = plan();
        p.inputs.clear();
        p.tun_sharing = Some(crate::tun::sharing::Options {
            ipv6: false,
            tag: "shared".into(),
            expected_version: "0".repeat(64),
            public_id: "11111111-1111-1111-1111-111111111111".into(),
            private_id: "22222222-2222-2222-2222-222222222222".into(),
            upstream_tags: vec!["upstream".into()],
        });
        assert!(validate(Some(&p), &config).is_ok());
        config["inbounds"]
            .as_array_mut()
            .unwrap()
            .push(json!({"protocol":"tun","tag":"host","settings":{}}));
        assert!(validate(None, &config).is_err());
        assert!(validate(Some(&p), &config).is_ok());
        config["inbounds"][0]["settings"]["autoSystemWfpBlockLeak"] = json!(["0.0.0.0/0"]);
        assert!(validate(Some(&p), &config).is_err());
        config["inbounds"][0]["settings"]
            .as_object_mut()
            .unwrap()
            .remove("autoSystemWfpBlockLeak");
        config["routing"]["rules"] = json!([{"process":["client.exe"],"outboundTag":"upstream"}]);
        assert!(validate(Some(&p), &config).is_err());
        config["routing"]["rules"][0]["inboundTag"] = json!(["host"]);
        assert!(validate(Some(&p), &config).is_ok());
        p.tun_sharing.as_mut().unwrap().private_id =
            p.tun_sharing.as_ref().unwrap().public_id.clone();
        assert!(validate(Some(&p), &config).is_err());
    }
    #[test]
    fn rejects_drive_relative_paths_and_folders() {
        for mode in ["path", "folder"] {
            let mut p = plan();
            p.inputs[0].selectors[0].mode = mode.into();
            for value in ["C:relative", "relative", "1:\\file.exe"] {
                p.inputs[0].selectors[0].value = value.into();
                assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_err());
            }
            p.inputs[0].selectors[0].value = "C:\\apps\\client.exe".into();
            assert!(validate(Some(&p), &wayrill_protocol::direct_example()).is_ok());
        }
    }
    #[test]
    fn new_interface_defaults_do_not_reclassify_known_adapters() {
        let known = vec![Interface {
            id: "old".into(),
            name: "Ethernet".into(),
            monitored: true,
        }];
        let explicit = Interfaces {
            monitor_new_interfaces: false,
            interfaces: vec![],
        };
        assert!(merge_interfaces(&explicit, &known).unwrap().interfaces[0].monitored);
        let explicit = Interfaces {
            interfaces: vec![Interface {
                id: "OLD".into(),
                name: "Ethernet".into(),
                monitored: false,
            }],
            ..explicit
        };
        assert_eq!(
            merge_interfaces(&explicit, &known)
                .unwrap()
                .interfaces
                .len(),
            1
        );
        assert!(!merge_interfaces(&explicit, &known).unwrap().interfaces[0].monitored);
        assert!(Interfaces::default().monitor_new_interfaces);
    }
}
