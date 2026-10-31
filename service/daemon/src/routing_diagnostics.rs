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
        input.config = dns_config(&input.config, &input.handler, &input.server, egress)?;
        if input.config["observatory"].is_object() || input.config["burstObservatory"].is_object() {
            warnings.push("Policy observations start fresh in this isolated test; a group may use its fallback before probes finish.".into());
        }
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
