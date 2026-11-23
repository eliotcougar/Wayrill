//! Bounded, isolated Xray diagnostics. No active-core commands or Windows mutations.
use crate::native::{self, CoreIdentity};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use wayrill_protocol::{params, ApiError, Result};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    pub ticket: Option<String>,
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
// Admission and the worker share one terminal transition. A ticket can cancel
// the work before there is a job ID, while a completed result wins the same CAS.
#[repr(u8)]
enum Decision {
    Open,
    Cancelled,
    Completed,
}

#[derive(Default)]
pub(crate) struct Cancellation(AtomicU8);

impl Cancellation {
    pub fn cancel(&self) {
        let _ = self.0.compare_exchange(
            Decision::Open as u8,
            Decision::Cancelled as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire) == Decision::Cancelled as u8
    }

    pub fn check(&self) -> Result<()> {
        check_cancelled(self.cancelled())
    }

    fn settle(&self, result: Result<Value>) -> Outcome {
        let previous = self.0.compare_exchange(
            Decision::Open as u8,
            Decision::Completed as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if previous == Err(Decision::Cancelled as u8) {
            return Outcome::Cancelled;
        }
        match result {
            Ok(value) => Outcome::Succeeded(value),
            Err(error) => Outcome::Failed(error),
        }
    }
}

enum Outcome {
    Succeeded(Value),
    Failed(ApiError),
    Cancelled,
}

enum Phase {
    Running(Option<crate::operation_gate::Foreground>),
    Complete(Outcome),
}

struct Job {
    job: u64,
    ticket: Option<String>,
    cancellation: Arc<Cancellation>,
    phase: Phase,
}

impl Job {
    fn finish(&mut self, result: Result<Value>) {
        self.phase = Phase::Complete(self.cancellation.settle(result));
    }

    fn snapshot(&self) -> Value {
        let (busy, result, error, cancelled) = match &self.phase {
            Phase::Running(_) => (true, None, None, self.cancellation.cancelled()),
            Phase::Complete(Outcome::Succeeded(result)) => (false, Some(result), None, false),
            Phase::Complete(Outcome::Failed(error)) => (false, None, Some(error), false),
            Phase::Complete(Outcome::Cancelled) => (false, None, None, true),
        };
        json!({"job":self.job,"busy":busy,"result":result,"error":error,"cancelled":cancelled})
    }
}

pub(crate) struct Manager {
    current: Option<Arc<Mutex<Job>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Manager {
    pub fn new() -> Self {
        Self {
            current: None,
            worker: None,
        }
    }
    pub fn busy(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|job| matches!(job.lock().unwrap().phase, Phase::Running(_)))
    }
    pub fn retain_reservation(&mut self, reservation: Option<crate::operation_gate::Foreground>) {
        let Some(job) = &self.current else { return };
        if let Phase::Running(held) = &mut job.lock().unwrap().phase {
            *held = reservation;
        }
    }
    pub fn get(&self, method: &str, value: Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Query {
            job: Option<u64>,
            ticket: Option<String>,
        }
        let query: Query = params(value)?;
        let job = self
            .current
            .as_ref()
            .ok_or_else(|| invalid("This diagnostic is no longer available."))?
            .lock()
            .unwrap();
        let matches = match (query.job, query.ticket.as_ref()) {
            (Some(id), None) => id == job.job,
            (None, Some(ticket)) => job.ticket.as_ref() == Some(ticket),
            _ => false,
        };
        if !matches {
            return Err(invalid("This diagnostic is no longer available."));
        }
        if method == "routing.diagnosticCancel" {
            job.cancellation.cancel();
        }
        Ok(job.snapshot())
    }
    pub fn start(
        &mut self,
        input: Input,
        exe: PathBuf,
        owner: String,
        egress: Option<crate::tun::OutboundEgress>,
        cancel: Option<Arc<Cancellation>>,
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
        let cancellation = cancel.unwrap_or_default();
        cancellation.check()?;
        let job = Arc::new(Mutex::new(Job {
            job: id,
            ticket: input.ticket.clone(),
            cancellation: cancellation.clone(),
            phase: Phase::Running(None),
        }));
        let worker_job = job.clone();
        self.worker = Some(
            std::thread::Builder::new()
                .name("wayrill-routing-diagnostic".into())
                .spawn(move || {
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        run(input, &exe, &owner, egress.as_ref(), &cancellation)
                    }));
                    worker_job.lock().unwrap().finish(
                        outcome.unwrap_or_else(|_| Err(invalid("Diagnostic worker failed."))),
                    );
                })
                .map_err(|error| ApiError::io("Start diagnostic", error))?,
        );
        let reply = job.lock().unwrap().snapshot();
        self.current = Some(job);
        Ok(reply)
    }
    pub fn shutdown(&mut self) {
        if let Some(job) = &self.current {
            job.lock().unwrap().cancellation.cancel();
        }
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

fn check_cancelled(cancelled: bool) -> Result<()> {
    if cancelled {
        Err(ApiError::new("CANCELLED", "The diagnostic was cancelled."))
    } else {
        Ok(())
    }
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
    server: &str,
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
    isolate_dns_routes(&mut config);
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
    // Unlike DNS-client queries dispatched through routing, a DNS outbound's
    // Direct request policy dials its original/rewritten server itself.
    let dns = config["outbounds"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["tag"] == handler)
        .unwrap();
    bind_dns_forward(dns, server, egress, &loopback)?;
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

fn bind_dns_forward(
    outbound: &mut Value,
    server: &str,
    egress: Option<&crate::tun::OutboundEgress>,
    loopback: &str,
) -> Result<()> {
    let server: std::net::SocketAddr = server
        .parse()
        .map_err(|_| invalid("Provide a DNS destination IP and port."))?;
    let settings = &outbound["settings"];
    let address = settings["address"]
        .as_str()
        .or_else(|| settings["rewriteAddress"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| server.ip().to_string());
    let local = crate::loopback::local_address(&address);
    if !outbound["streamSettings"].is_object() {
        outbound["streamSettings"] = json!({});
    }
    if !outbound["streamSettings"]["sockopt"].is_object() {
        outbound["streamSettings"]["sockopt"] = json!({});
    }
    let options = &mut outbound["streamSettings"]["sockopt"];
    if local || options["interface"].as_str().unwrap_or("").is_empty() {
        let interface = if local {
            loopback
        } else {
            &egress
                .ok_or_else(|| invalid("No upstream interface is available for the DNS test."))?
                .uplink
        };
        options["interface"] = json!(interface);
    }
    Ok(())
}

fn isolate_dns_routes(config: &mut Value) {
    // DNS upstreams enter the dispatcher with the DNS/server tag. Loopback
    // outbounds can redispatch them under another tag, including in proxy chains.
    // Keep unscoped rules and all such scopes; discard only impossible inputs.
    let mut inputs =
        std::collections::BTreeSet::from([String::new(), "wayrill-diagnostic".to_owned()]);
    for tag in std::iter::once(&config["dns"]["tag"])
        .chain(
            config["dns"]["servers"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| &s["tag"]),
        )
        .chain(
            config["outbounds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|o| o["protocol"] == "loopback")
                .map(|o| &o["settings"]["inboundTag"]),
        )
        .filter_map(Value::as_str)
    {
        inputs.insert(tag.to_owned());
    }
    // A routing script may choose a group without a field-rule reference.
    if config["routing"]["script"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        return;
    }
    if let Some(rules) = config["routing"]["rules"].as_array_mut() {
        rules.retain(|rule| {
            rule["inboundTag"].as_array().is_none_or(|tags| {
                tags.is_empty()
                    || tags
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|tag| inputs.contains(tag))
            })
        });
    }
    let groups: std::collections::BTreeSet<_> = config["routing"]["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["balancerTag"].as_str().map(str::to_owned))
        .collect();
    if let Some(balancers) = config["routing"]["balancers"].as_array_mut() {
        balancers.retain(|group| {
            group["tag"]
                .as_str()
                .is_some_and(|tag| groups.contains(tag))
        });
    }
    if groups.is_empty() {
        config.as_object_mut().unwrap().remove("observatory");
        config.as_object_mut().unwrap().remove("burstObservatory");
    }
}
fn run(
    mut input: Input,
    exe: &std::path::Path,
    owner: &str,
    egress: Option<&crate::tun::OutboundEgress>,
    cancellation: &Cancellation,
) -> Result<Value> {
    cancellation.check()?;
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
    cancellation.check()?;
    if input.mode == "dns" {
        input.config = dns_config(&input.config, &input.handler, &input.server, egress)?;
        if input.config["observatory"].is_object() || input.config["burstObservatory"].is_object() {
            warnings.push("Policy observations start fresh in this isolated test; a group may use its fallback before probes finish.".into());
        }
    }
    let request = json!({"mode":input.mode,"config":input.config,"route":input.route,"resolvedIPs":input.resolved_ips,"process":input.application["lineage"].as_array().and_then(|v|v.first()).map(|p|json!({"name":p["name"].as_str().unwrap_or(""),"path":p["path"].as_str().unwrap_or("")})),"handler":input.handler,"domain":input.domain,"queryType":input.query_type,"server":input.server});
    let mut reply = query_core(
        exe.parent().unwrap(),
        CoreIdentity::Owner(owner),
        &request,
        || cancellation.cancelled(),
    )?;
    reply["warnings"] = json!(warnings);
    Ok(reply)
}

pub(crate) fn geosite(
    assets: &std::path::Path,
    file: &str,
    domain: &str,
    offset: usize,
    limit: usize,
    stop: &AtomicBool,
) -> Result<Value> {
    let reply = query_core(
        assets,
        CoreIdentity::LocalService,
        &json!({"mode":"geosite","file":file,"domain":domain,"offset":offset,"limit":limit}),
        || stop.load(Ordering::Acquire),
    )?;
    if let Some(error) = reply["error"].as_str() {
        return Err(invalid(error));
    }
    Ok(reply)
}

fn query_core(
    assets: &std::path::Path,
    identity: CoreIdentity<'_>,
    request: &Value,
    cancelled: impl Fn() -> bool,
) -> Result<Value> {
    check_cancelled(cancelled())?;
    let root = assets
        .parent()
        .ok_or_else(|| invalid("Invalid assets path."))?;
    let worker = crate::tun::worker_executable(root)?;
    let process = native::spawn_tun_with_token(
        &worker,
        identity.token()?,
        request,
        "wayrill-diagnose",
        None,
        0,
        native::TunOptions {
            metadata: None,
            fakedns: None,
            reuse_settings: false,
            assets,
        },
    )?;
    // Leave time around the diagnostic's own budget to start the process,
    // transfer the request and drain its response.
    let deadline = Instant::now() + native::XRAY_CONFIG_LOAD_TIMEOUT + Duration::from_secs(15);
    loop {
        check_cancelled(cancelled())?;
        if let Some(code) = process.exit_code()? {
            if code != 0 {
                return Err(invalid("The isolated Xray diagnostic failed."));
            }
            if let Some(reply) = process.private_reply()? {
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
    fn a_cancel_ticket_can_win_before_completion_but_cannot_rewrite_a_terminal_result() {
        for cancel_first in [true, false] {
            for fail in [true, false] {
                let receipts = crate::operation_receipts::Receipts::default();
                let mut query = receipts.prepare_diagnostic(json!({})).unwrap();
                let admission = receipts
                    .admit("routing.diagnosticStart", &mut query)
                    .unwrap()
                    .unwrap();
                admission.begin().unwrap();
                let ticket = query["ticket"].as_str().unwrap();
                let cancellation = receipts.diagnostic_stop(ticket).unwrap();
                let job = Arc::new(Mutex::new(Job {
                    job: 1,
                    ticket: Some(ticket.into()),
                    cancellation,
                    phase: Phase::Running(None),
                }));
                let manager = Manager {
                    current: Some(job.clone()),
                    worker: None,
                };
                admission.finish(Ok(()));
                let cancel = || {
                    receipts
                        .diagnostic("routing.diagnosticCancel", &query)
                        .unwrap()
                };
                if cancel_first {
                    cancel();
                    let running = manager.get("routing.diagnosticGet", query.clone()).unwrap();
                    assert_eq!(running["busy"], true);
                    assert_eq!(running["cancelled"], true);
                }
                let result = if fail {
                    Err(invalid("Fixture error."))
                } else {
                    Ok(json!({"outboundTag":"direct"}))
                };
                job.lock().unwrap().finish(result);
                let settled = manager.get("routing.diagnosticGet", query.clone()).unwrap();
                cancel();
                assert_eq!(
                    manager.get("routing.diagnosticGet", query).unwrap(),
                    settled
                );
                assert_eq!(settled["busy"], false);
                assert_eq!(settled["cancelled"], cancel_first);
                assert_eq!(settled["result"].is_object(), !cancel_first && !fail);
                assert_eq!(settled["error"].is_object(), !cancel_first && fail);
            }
        }
    }
    #[test]
    fn dns_isolation_respects_native_field_spelling_and_removes_webhooks() {
        let original = wayrill_protocol::normalize_config(json!({
            "inbounds":[{"tag":"proxy","protocol":"socks","listen":"127.0.0.1","port":2080}],
            "outbounds":[
                {"tag":"direct","protocol":"freedom"},
                {"tag":"block","protocol":"blackhole"},
                {"tag":"handler","protocol":"dns","settings":{"Address":"127.0.0.2"}}
            ],
            "dns":{"servers":[{"address":"8.8.8.8","Tag":"private-dns"}]},
            "routing":{"rules":[{"inboundTag":["private-dns"],"outboundTag":"block","WebHook":{"url":"https://must-not-be-called.invalid/"}}]}
        })).unwrap();
        let egress = crate::tun::OutboundEgress {
            uplink: "Ethernet".into(),
            loopback: "Loopback".into(),
            captured: true,
        };
        let prepared = dns_config(&original, "handler", "8.8.8.8:53", Some(&egress)).unwrap();
        assert!(prepared["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|rule| rule["inboundTag"] == json!(["private-dns"])
                && rule["outboundTag"] == "block"));
        assert!(prepared["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|rule| rule
                .as_object()
                .unwrap()
                .keys()
                .all(|key| !key.eq_ignore_ascii_case("webhook"))));
        let handler = prepared["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["tag"] == "handler")
            .unwrap();
        assert_eq!(
            handler["streamSettings"]["sockopt"]["interface"],
            "Loopback"
        );
        assert_eq!(original["outbounds"][2]["settings"]["address"], "127.0.0.2");

        let mut scripted = original;
        scripted["routing"]["Script"] = json!("return 'group'");
        scripted["routing"]["balancers"] = json!([{"tag":"group","selector":["direct"]}]);
        scripted["observatory"] = json!({"subjectSelector":["direct"]});
        let mut scripted = wayrill_protocol::normalize_config(scripted).unwrap();
        isolate_dns_routes(&mut scripted);
        assert_eq!(
            scripted["routing"]["balancers"].as_array().unwrap().len(),
            1
        );
        assert!(scripted["observatory"].is_object());
    }

    #[test]
    fn diagnostic_wire_contract_preserves_ip_acronyms() {
        let request:Input=params(json!({"mode":"route","config":{},"capture":null,"route":{"inbound":"tun","domain":"example.test","ips":[],"port":443,"network":"tcp","protocol":"tls","user":"","sourceIP":"","sourcePort":0},"application":null,"resolvedIPs":["192.0.2.8"],"handler":"dns","domain":"example.test","queryType":"A","server":"8.8.8.8:53"})).unwrap();
        assert_eq!(request.resolved_ips, ["192.0.2.8"]);
    }

    #[test]
    fn dns_isolation_keeps_query_and_chain_scopes_without_traffic_only_probes() {
        let original = json!({
            "dns":{"tag":"dns","servers":[{"address":"8.8.8.8","tag":"remote-dns"}]},
            "outbounds":[{"tag":"chain","protocol":"loopback","settings":{"inboundTag":"chain-hop"}}],
            "routing":{"rules":[
                {"inboundTag":["proxy","tun"],"balancerTag":"traffic"},
                {"inboundTag":["remote-dns"],"outboundTag":"chain"},
                {"inboundTag":["dns"],"outboundTag":"direct"},
                {"inboundTag":["chain-hop"],"outboundTag":"hop"},
                {"ip":["127.0.0.0/8"],"outboundTag":"local"}
            ],"balancers":[{"tag":"traffic","selector":["server-"]}]},
            "observatory":{"subjectSelector":["server-"]}
        });
        let mut config = original.clone();
        isolate_dns_routes(&mut config);
        assert_eq!(
            config["routing"]["rules"],
            json!(&original["routing"]["rules"].as_array().unwrap()[1..])
        );
        assert_eq!(config["routing"]["balancers"], json!([]));
        assert!(config.get("observatory").is_none());
        assert_eq!(config["outbounds"], original["outbounds"]);

        // A real DNS policy decision (including a chain's redispatch) still
        // needs its balancer and observations. Unscoped rules remain eligible.
        for scope in [json!(["remote-dns"]), json!(["chain-hop"]), json!([])] {
            let mut config = original.clone();
            config["routing"]["rules"][0]["inboundTag"] = scope;
            isolate_dns_routes(&mut config);
            assert_eq!(
                config["routing"]["balancers"],
                original["routing"]["balancers"]
            );
            assert_eq!(config["observatory"], original["observatory"]);
        }
    }

    #[test]
    fn dns_forwarding_binds_actual_destination_without_changing_request_policies() {
        let egress = crate::tun::OutboundEgress {
            uplink: "Ethernet".into(),
            loopback: "Loopback".into(),
            captured: true,
        };
        for (server, settings, options, expected) in [
            ("8.8.8.8:53", json!({}), json!({}), "Ethernet"),
            ("127.0.0.1:53", json!({}), json!({}), "Loopback"),
            (
                "[::1]:53",
                json!({}),
                json!({"interface":"Ethernet"}),
                "Loopback",
            ),
            (
                "8.8.8.8:53",
                json!({"rewriteAddress":"127.0.0.2"}),
                json!({}),
                "Loopback",
            ),
            (
                "127.0.0.1:53",
                json!({"address":"8.8.4.4","rewriteAddress":"127.0.0.2"}),
                json!({"interface":"Chosen VPN"}),
                "Chosen VPN",
            ),
        ] {
            let mut outbound = json!({"protocol":"dns","settings":settings,"streamSettings":{"sockopt":options},"proxySettings":{"tag":"hop"}});
            bind_dns_forward(&mut outbound, server, Some(&egress), &egress.loopback).unwrap();
            assert_eq!(outbound["streamSettings"]["sockopt"]["interface"], expected);
            assert_eq!(outbound["settings"], settings);
            assert_eq!(outbound["proxySettings"]["tag"], "hop");
        }
    }
}
