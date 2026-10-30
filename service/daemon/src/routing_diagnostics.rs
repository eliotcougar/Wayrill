//! Bounded, isolated Xray diagnostics. No active-core commands or Windows mutations.
use crate::native::{self, CoreIdentity};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use wayrill_protocol::{params, ApiError, Result};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    pub config: Value,
    #[serde(default)]
    pub capture: Value,
    mode: String,
    #[serde(default)]
    route: Value,
    #[serde(default)]
    application: Value,
    #[serde(default, rename = "resolvedIPs")]
    resolved_ips: Vec<String>,
    #[serde(default)]
    handler: String,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    query_type: String,
    #[serde(default)]
    server: String,
    #[serde(skip)]
    pub resource_warnings: Vec<String>,
}
struct State {
    job: u64,
    busy: bool,
    result: Option<Value>,
    error: Option<ApiError>,
    reservation: Option<crate::operation_gate::Foreground>,
}
pub(crate) struct Manager {
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Manager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                job: 0,
                busy: false,
                result: None,
                error: None,
                reservation: None,
            })),
            stop: Arc::new(AtomicBool::new(false)),
            worker: None,
        }
    }
    pub fn busy(&self) -> bool {
        self.state.lock().unwrap().busy
    }
    pub fn retain_reservation(&mut self, reservation: Option<crate::operation_gate::Foreground>) {
        let mut state = self.state.lock().unwrap();
        if state.busy {
            state.reservation = reservation;
        }
    }
    fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({"job":state.job,"busy":state.busy,"result":state.result,"error":state.error,"cancelled":self.stop.load(Ordering::Acquire)})
    }
    pub fn get(&self, method: &str, value: Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Query {
            job: u64,
        }
        let query: Query = params(value)?;
        if query.job == 0 || query.job != self.state.lock().unwrap().job {
            return Err(invalid("This diagnostic is no longer available."));
        }
        if method == "routing.diagnosticCancel" && self.busy() {
            self.stop.store(true, Ordering::Release);
        }
        Ok(self.snapshot())
    }
    pub fn start(
        &mut self,
        input: Input,
        exe: PathBuf,
        owner: String,
        egress: Option<crate::tun::OutboundEgress>,
    ) -> Result<Value> {
        if self.busy() {
            return Err(ApiError::new(
                "BUSY",
                "A routing diagnostic is already running.",
            ));
        }
        if !["route", "dns"].contains(&input.mode.as_str())
            || input.resolved_ips.len() > 64
            || serde_json::to_vec(&input.application)
                .unwrap_or_default()
                .len()
                > 64 * 1024
        {
            return Err(invalid("Invalid diagnostic request."));
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let id = u64::from_str_radix(&crate::tun::random_id()?[..12], 16)
            .map_err(|_| invalid("Cannot create diagnostic job."))?
            .max(1);
        self.stop = Arc::new(AtomicBool::new(false));
        self.state = Arc::new(Mutex::new(State {
            job: id,
            busy: true,
            result: None,
            error: None,
            reservation: None,
        }));
        let state = self.state.clone();
        let stop = self.stop.clone();
        match std::thread::Builder::new()
            .name("wayrill-routing-diagnostic".into())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(input, &exe, &owner, egress.as_ref(), &stop)
                }));
                let mut state = state.lock().unwrap();
                match outcome {
                    Ok(Ok(result)) => state.result = Some(result),
                    Ok(Err(error)) => state.error = Some(error),
                    Err(_) => state.error = Some(invalid("Diagnostic worker failed.")),
                }
                state.busy = false;
                state.reservation = None;
            }) {
            Ok(worker) => self.worker = Some(worker),
            Err(error) => {
                self.state.lock().unwrap().busy = false;
                return Err(ApiError::io("Start diagnostic", error));
            }
        }
        Ok(self.snapshot())
    }
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new("ROUTING_DIAGNOSTIC", message)
}

fn process_context(input: &mut Input, root: &std::path::Path) -> Result<Vec<String>> {
    let mut warnings = vec![];
    let tag = input.route["inbound"].as_str().unwrap_or("").to_owned();
    let capture = input.capture["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| v["tag"] == tag);
    let predicates = capture
        .and_then(|v| v["predicates"].as_array())
        .cloned()
        .unwrap_or_default();
    let capture_count = predicates.len();
    if capture.is_none() {
        return Ok(warnings);
    }
    if input.application.is_null() {
        warnings.push("Application identity was not supplied. Process, child-process, app and service rules may change this result.".into());
    }
    let mut worker = crate::capture::Worker::spawn_attribution(&root.join("attribution"))?;
    let width = capture
        .and_then(|c| c["ambiguousMask"].as_str())
        .map(str::len)
        .unwrap_or(capture_count.div_ceil(4).max(1));
    let evaluated=worker.call("policy.evaluate",json!({"predicates":predicates,"lineage":input.application["lineage"].as_array().cloned().unwrap_or_default(),"service":input.application["service"],"maskCount":capture_count,"maskWidth":width}))?;
    if capture.is_some() {
        let mask = evaluated["mask"]
            .as_str()
            .ok_or_else(|| invalid("Invalid application mask."))?;
        input.route["user"] = json!(format!("wr-{mask}-{}", "0".repeat(48)));
    }
    Ok(warnings)
}

fn dns_config(
    config: &Value,
    handler: &str,
    egress: Option<&crate::tun::OutboundEgress>,
) -> Result<Value> {
    let mut config = config.clone();
    let root = config
        .as_object_mut()
        .ok_or_else(|| invalid("Invalid diagnostic configuration."))?;
    root.retain(|key, _| {
        [
            "outbounds",
            "routing",
            "dns",
            "fakedns",
            "policy",
            "env",
            "observatory",
            "burstObservatory",
        ]
        .contains(&key.as_str())
    });
    root.insert("inbounds".into(), json!([]));
    let outputs = config["outbounds"]
        .as_array()
        .ok_or_else(|| invalid("Missing outbounds."))?;
    if !outputs
        .iter()
        .any(|o| o["tag"] == handler && o["protocol"] == "dns")
    {
        return Err(invalid("Choose a DNS handler from this configuration."));
    }
    if outputs
        .iter()
        .any(|o| ["tun", "wireguard"].contains(&o["protocol"].as_str().unwrap_or("")))
    {
        return Err(invalid("DNS tests cannot start virtual network outbounds."));
    }
    // DNS diagnostics run entirely in memory; background observations are retained
    // only when the config needs them for policy-group decisions.
    if let Some(egress) = egress {
        egress.bind(&mut config)?;
    } else if crate::tun::needs_direct_binding(&config) {
        return Err(invalid(
            "No upstream interface is available for the DNS test.",
        ));
    }
    let loopback = egress
        .map(|e| Ok(e.loopback.clone()))
        .unwrap_or_else(crate::tun::loopback_interface)?;
    crate::loopback::Policy::apply(&mut config, &loopback)?;
    // Never fire a routing webhook for a diagnostic query.
    for rule in config["routing"]["rules"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        if let Some(rule) = rule.as_object_mut() {
            rule.remove("webhook");
        }
    }
    Ok(config)
}
fn run(
    mut input: Input,
    exe: &std::path::Path,
    owner: &str,
    egress: Option<&crate::tun::OutboundEgress>,
    stop: &AtomicBool,
) -> Result<Value> {
    let root = exe
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or_else(|| invalid("Invalid service path."))?;
    let mut warnings = if input.mode == "route" {
        process_context(&mut input, root)?
    } else {
        vec![]
    };
    warnings.extend(input.resource_warnings.clone());
    if input.mode == "dns"
        && (input.config["observatory"].is_object() || input.config["burstObservatory"].is_object())
    {
        warnings.push("Policy observations start fresh in this isolated test; a group may use its fallback before probes finish.".into());
    }
    if input.mode == "route"
        && (crate::loopback::local_address(input.route["domain"].as_str().unwrap_or(""))
            || input.route["ips"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(crate::loopback::local_address))
    {
        warnings.push("Loopback destinations use local Direct sockets after the routing decision. Explicit Block rules remain effective.".into());
    }
    if stop.load(Ordering::Acquire) {
        return Err(invalid("Diagnostic cancelled."));
    }
    if input.mode == "dns" {
        input.config = dns_config(&input.config, &input.handler, egress)?;
    }
    let request = json!({"mode":input.mode,"config":input.config,"route":input.route,"resolvedIPs":input.resolved_ips,"process":input.application["lineage"].as_array().and_then(|v|v.first()).map(|p|json!({"name":p["name"].as_str().unwrap_or(""),"path":p["path"].as_str().unwrap_or("")})),"handler":input.handler,"domain":input.domain,"queryType":input.query_type,"server":input.server});
    let worker = crate::tun::worker_executable(root)?;
    let process = native::spawn_tun_with_token(
        &worker,
        CoreIdentity::Owner(owner).token()?,
        &request,
        "wayrill-diagnose",
        None,
        0,
        native::TunOptions {
            metadata: None,
            fakedns: None,
            reuse_settings: false,
            assets: exe.parent().unwrap(),
        },
    )?;
    let deadline = Instant::now() + Duration::from_secs(18);
    loop {
        if stop.load(Ordering::Acquire) {
            return Err(invalid("Diagnostic cancelled."));
        }
        if let Some(code) = process.exit_code()? {
            if code != 0 {
                return Err(invalid("The isolated Xray diagnostic failed."));
            }
            if let Some(mut reply) = process.private_reply()? {
                reply["warnings"] = json!(warnings);
                return Ok(reply);
            }
        }
        if Instant::now() >= deadline {
            return Err(invalid("The isolated Xray diagnostic timed out."));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_wire_contract_preserves_ip_acronyms() {
        let request:Input=params(json!({"mode":"route","config":{},"capture":null,"route":{"inbound":"tun","domain":"example.test","ips":[],"port":443,"network":"tcp","protocol":"tls","user":"","sourceIP":"","sourcePort":0},"application":null,"resolvedIPs":["192.0.2.8"],"handler":"dns","domain":"example.test","queryType":"A","server":"8.8.8.8:53"})).unwrap();
        assert_eq!(request.resolved_ips, ["192.0.2.8"]);
    }
}
