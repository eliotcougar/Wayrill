//! Memory-only routing decisions. Collection never depends on an open UI or its pause state.
use crate::display_names::DisplayNames;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    sync::{Arc, Mutex},
};
use wayrill_protocol::{ApiError, Result};

const CAPACITY: usize = 8192;
const BYTES: usize = 8 * 1024 * 1024;
const PAGE: usize = 1000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hop {
    pub filter_id: String,
    pub rule_id: Option<String>,
    pub rule: String,
    pub output_id: String,
    pub output: String,
}
fn printable(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}
pub fn validate_metadata(names: &DisplayNames, config: &Value) -> Result<()> {
    let rules = config["routing"]["rules"].as_array();
    let trails = names.routing.values().chain(names.routing_default.iter());
    if names.routing.keys().any(|key| {
        key.parse::<usize>()
            .ok()
            .is_none_or(|i| i.to_string() != *key || rules.is_none_or(|r| i >= r.len()))
    }) || trails.clone().any(|trail| {
        trail.is_empty()
            || trail.len() > 128
            || trail.iter().any(|h| {
                !printable(&h.filter_id, 160)
                    || !printable(&h.output_id, 160)
                    || !printable(&h.rule, 160)
                    || !printable(&h.output, 160)
                    || h.rule_id.as_ref().is_some_and(|id| !printable(id, 160))
            })
    }) || serde_json::to_vec(&(&names.routing, &names.routing_default))
        .map_or(true, |b| b.len() > 4 * 1024 * 1024)
    {
        return Err(ApiError::new(
            "INVALID_PARAMS",
            "Invalid or oversized routing-log metadata.",
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub filter_id: String,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        if printable(&self.filter_id, 160) {
            Ok(())
        } else {
            Err(ApiError::new(
                "INVALID_PARAMS",
                "A routing filter ID is required.",
            ))
        }
    }
}
#[derive(Clone)]
struct Route {
    trail: Arc<Vec<Hop>>,
    target: String,
    weight: usize,
}
pub struct Session {
    generation: u64,
    revision: u64,
    routes: BTreeMap<String, Route>,
    filters: BTreeSet<String>,
    names: BTreeMap<String, String>,
    blocked: BTreeSet<String>,
}
impl Session {
    pub fn include_aliases(&mut self, aliases: &[(String, String)]) {
        for (alias, original) in aliases {
            if let Some(route) = self.routes.get(original).cloned() {
                self.routes.insert(alias.clone(), route);
            }
        }
    }
}
pub fn enable(config: &mut Value) {
    if !config["log"].is_object() {
        config["log"] = json!({});
    }
    if config["log"]["loglevel"] != "debug" {
        config["log"]["loglevel"] = json!("info");
    }
    config["log"]["access"] = json!("none");
    config["log"]["error"] = json!("");
    // The live decision ring needs the real destination. Privacy masking is a
    // presentation/export concern; it cannot be undone after Xray formats a line.
    config["log"].as_object_mut().unwrap().remove("maskAddress");
}
/// Tag a clone before capture/TUN projection. Xray retains the tag on the matching worker rule.
pub fn instrument(
    config: &mut Value,
    names: &DisplayNames,
    generation: u64,
    revision: u64,
) -> Option<Session> {
    // Script routers choose their own outbound without field rules. Adding any
    // rule would make the original script configuration invalid in Xray.
    if config["routing"]["script"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        return None;
    }
    let default = config["outbounds"][0]["tag"].as_str()?.to_string();
    let mut session = Session {
        generation,
        revision,
        routes: BTreeMap::new(),
        filters: BTreeSet::new(),
        names: names.outbound.clone(),
        blocked: config["outbounds"]
            .as_array()?
            .iter()
            .filter(|outbound| matches!(outbound["protocol"].as_str(), Some("blackhole" | "block")))
            .filter_map(|outbound| outbound["tag"].as_str().map(str::to_owned))
            .collect(),
    };
    if !config["routing"].is_object() {
        config["routing"] = json!({"rules":[]});
    }
    if !config["routing"]["rules"].is_array() {
        config["routing"]["rules"] = json!([]);
    }
    // IPIfNonMatch must first exhaust the domain pass before resolving and
    // retrying IP rules. A catch-all would suppress that second pass. Leave its
    // implicit fallback unobserved rather than change the route to observe it.
    let observe_default = !config["routing"]["domainStrategy"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case("IPIfNonMatch"));
    if observe_default {
        config["routing"]["rules"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"field", "network":"tcp,udp", "outboundTag":default}));
    }
    let rules = config["routing"]["rules"].as_array_mut()?;
    let mut used_tags: BTreeSet<String> = rules
        .iter()
        .filter_map(|r| r["ruleTag"].as_str().map(str::to_owned))
        .collect();
    let last = rules.len().saturating_sub(1);
    let empty_trail = Vec::new();
    for (index, rule) in rules.iter_mut().enumerate() {
        let trail = names.routing.get(&index.to_string()).or_else(|| {
            (observe_default && index == last)
                .then_some(names.routing_default.as_ref())
                .flatten()
        });
        let trail = trail.unwrap_or(&empty_trail);
        let target = rule["outboundTag"]
            .as_str()
            .or_else(|| rule["balancerTag"].as_str())
            .unwrap_or(&default)
            .to_string();
        let base = format!(
            "wrr-{}",
            crate::tags::sequence(&[generation, revision, index as u64])
        );
        let mut tag = base.clone();
        let mut suffix = 0;
        while !used_tags.insert(tag.clone()) {
            suffix += 1;
            tag = format!("{base}-{suffix}");
        }
        rule["ruleTag"] = json!(tag);
        session
            .filters
            .extend(trail.iter().map(|h| h.filter_id.clone()));
        session.routes.insert(
            tag,
            Route {
                trail: Arc::new(trail.clone()),
                target,
                weight: serde_json::to_vec(trail).map_or(0, |b| b.len()),
            },
        );
    }
    Some(session)
}
struct Row {
    id: u64,
    generation: u64,
    timestamp: u64,
    revision: u64,
    destination: String,
    outbound: String,
    blocked: bool,
    trail: Arc<Vec<Hop>>,
    connection_id: Option<String>,
    transport: &'static str,
    source: &'static str,
    event: Option<Arc<(u32, String)>>,
    weight: usize,
}
#[derive(Default)]
struct State {
    session: Option<Session>,
    previous_sessions: VecDeque<Session>,
    monitored: VecDeque<u64>,
    collecting: bool,
    sequence: u64,
    bytes: usize,
    rows: VecDeque<Arc<Row>>,
    // Retain one last decision per destination independently of connection-log
    // churn. Both stores have explicit row and byte bounds.
    known: BTreeMap<String, Arc<Row>>,
    known_order: BTreeMap<u64, String>,
    known_bytes: usize,
    seen: HashSet<Arc<(u32, String)>>,
}
#[derive(Default)]
pub struct Log {
    state: Mutex<State>,
}
impl Log {
    pub fn begin(&self, session: Option<Session>) {
        let mut state = self.state.lock().unwrap();
        if let Some(s) = &session {
            state.monitored.push_back(s.generation);
            if state.monitored.len() > 8 {
                state.monitored.pop_front();
            }
        }
        state.previous_sessions.clear();
        state.collecting = session.is_some();
        state.session = session;
    }
    pub fn live(&self, session: Option<Session>) {
        let mut state = self.state.lock().unwrap();
        if let Some(previous) = state.session.take() {
            state.previous_sessions.push_back(previous);
        }
        while state.previous_sessions.len() > 8 {
            state.previous_sessions.pop_front();
        }
        state.collecting = session.is_some();
        state.session = session;
    }
    pub fn rollback_live(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(previous) = state.previous_sessions.pop_back() {
            if let Some(candidate) = state.session.replace(previous) {
                state.previous_sessions.push_back(candidate);
            }
        }
        state.collecting = state.session.is_some();
    }
    pub fn stop(&self) {
        self.state.lock().unwrap().collecting = false;
    }
    /// Consume monitored Info messages before the generic core-log event/tail.
    /// Only dispatcher decisions are retained; account/relay diagnostic messages are discarded.
    #[cfg(test)]
    fn ingest(&self, generation: u64, text: &str) -> bool {
        self.ingest_from(generation, 0, "Xray", text)
    }
    pub fn ingest_from(
        &self,
        generation: u64,
        origin: u32,
        source: &'static str,
        text: &str,
    ) -> bool {
        if !is_info(text) {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        if !state.collecting {
            return state.monitored.contains(&generation);
        }
        let Some(decision) = decision(text) else {
            return state.monitored.contains(&generation);
        };
        let Some(session) = state
            .session
            .iter()
            .chain(state.previous_sessions.iter().rev())
            .find(|s| s.generation == generation && s.routes.contains_key(decision.tag))
        else {
            return state.monitored.contains(&generation);
        };
        let Some(route) = session.routes.get(decision.tag) else {
            return true;
        };
        // Dedupe an exact logger observation, never a destination. Independent
        // cores/connections and later dispatches must retain their own decisions.
        let event = decision
            .session_id
            .map(|_| Arc::new((origin, text.trim_end().to_owned())));
        if event
            .as_ref()
            .is_some_and(|event| state.seen.contains(event))
        {
            return true;
        }
        // Worker relay names are intentionally hidden. The applied graph output is
        // authoritative; the main core additionally supplies the selected member.
        let outbound = session
            .names
            .get(decision.outbound)
            .cloned()
            .unwrap_or_else(|| {
                session
                    .names
                    .get(&route.target)
                    .cloned()
                    .unwrap_or_else(|| route.target.clone())
            });
        let weight = decision.destination.len() + outbound.len() + route.weight + text.len() + 256;
        let row = Row {
            id: state.sequence + 1,
            generation: session.generation,
            timestamp: crate::traffic::timestamp_ms(),
            revision: session.revision,
            destination: decision.destination.into(),
            outbound,
            blocked: session.blocked.contains(decision.outbound)
                || session.blocked.contains(&route.target),
            trail: route.trail.clone(),
            connection_id: decision
                .session_id
                .map(|id| format!("{generation}/{origin}/{id}")),
            transport: decision.transport,
            source,
            event,
            weight,
        };
        if let Some(event) = &row.event {
            state.seen.insert(event.clone());
        }
        state.sequence = row.id;
        state.bytes += weight;
        let row = Arc::new(row);
        if let Some(host) = row.destination.rsplit_once(':').and_then(|(host, port)| {
            port.parse::<u16>().ok()?;
            wayrill_protocol::companion::normalize_host(host).ok()
        }) {
            if let Some(old) = state.known.insert(host.clone(), row.clone()) {
                state.known_bytes -= old.weight;
                state.known_order.remove(&old.id);
            }
            state.known_bytes += row.weight;
            state.known_order.insert(row.id, host);
            while state.known.len() > CAPACITY || state.known_bytes > BYTES {
                let Some((_, host)) = state.known_order.pop_first() else {
                    break;
                };
                if let Some(old) = state.known.remove(&host) {
                    state.known_bytes -= old.weight;
                }
            }
        }
        state.rows.push_back(row);
        while state.rows.len() > CAPACITY || state.bytes > BYTES {
            if let Some(old) = state.rows.pop_front() {
                state.bytes -= old.weight;
                if let Some(event) = &old.event {
                    state.seen.remove(event);
                }
            } else {
                break;
            }
        }
        true
    }
    pub fn snapshot(&self, filter: &str, instance: &str) -> Value {
        let state = self.state.lock().unwrap();
        let session = state.session.as_ref();
        let configured = session.is_some_and(|s| s.filters.contains(filter));
        let mut rows: Vec<_> = state.rows.iter().rev().filter_map(|row| {
            let hop = row.trail.iter().find(|h| h.filter_id == filter)?;
            Some(json!({"id":row.id.to_string(),"timestampMs":row.timestamp,"revision":row.revision,"destination":row.destination,"outbound":row.outbound,"output":hop.output,"outputId":hop.output_id,"rule":hop.rule,"ruleId":hop.rule_id,"connectionId":row.connection_id,"transport":row.transport,"source":row.source}))
        }).take(PAGE).collect();
        rows.reverse();
        json!({"instanceId":instance,"generation":session.map(|s|s.generation),"revision":session.map(|s|s.revision),"state":if state.collecting && configured {"collecting"} else if configured {"stopped"} else {"unconfigured"},"capacity":PAGE,"rows":rows})
    }
    /// Destination correlation, never an assertion about a browser tab or socket.
    /// Keep last known decisions in a bounded per-destination history, including Block.
    /// Each match carries its own revision/generation, even after Stop or activation.
    pub fn companion(&self, hosts: &BTreeSet<String>, instance: &str, now: u64) -> Value {
        use wayrill_protocol::companion::normalize_host;
        let state = self.state.lock().unwrap();
        let session = state.session.as_ref();
        let mut results: BTreeMap<&str, Vec<Value>> =
            hosts.iter().map(|s| (s.as_str(), Vec::new())).collect();
        let mut truncated = BTreeSet::new();
        let mut bytes = 0;
        let mut epochs = BTreeMap::new();
        for row in state.rows.iter().rev().chain(
            state
                .known_order
                .values()
                .rev()
                .filter_map(|host| state.known.get(host)),
        ) {
            let Some((host, port)) = row.destination.rsplit_once(':') else {
                continue;
            };
            let Ok(host) = normalize_host(host) else {
                continue;
            };
            let Some(matches) = results.get_mut(host.as_str()) else {
                continue;
            };
            let Ok(port) = port.parse::<u16>() else {
                continue;
            };
            // A newer observed revision replaces the old route set for this
            // host. Do not mix an old Block with a new Direct observation.
            let epoch = epochs
                .entry(host.clone())
                .or_insert((row.generation, row.revision));
            if *epoch != (row.generation, row.revision) {
                continue;
            }
            let path: Vec<_> = row
                .trail
                .iter()
                .take(8)
                .map(|hop| json!({"rule":hop.rule,"output":hop.output}))
                .collect();
            if matches.iter().any(|m| {
                m["outbound"] == row.outbound
                    && m["port"] == port
                    && m["transport"] == row.transport
                    && m["path"] == json!(path)
            }) {
                continue;
            }
            if matches.len() == 3 {
                truncated.insert(host);
                continue;
            }
            let value = json!({"outbound":row.outbound,"port":port,"transport":row.transport,
                    "timestampMs":row.timestamp,"generation":row.generation,"revision":row.revision,
                    "action":if row.blocked {"block"} else {"route"},
                    "source":row.source,"path":path,"pathTruncated":row.trail.len()>8});
            let size = serde_json::to_vec(&value).map_or(usize::MAX, |v| v.len());
            if size > 768 * 1024 - bytes {
                truncated.insert(host);
                continue;
            }
            bytes += size;
            matches.push(value);
        }
        let hosts: Vec<_> = results.into_iter().map(|(host, matches)|
            json!({"host":host,"matches":matches,"truncated":truncated.contains(host)})).collect();
        json!({"instanceId":instance,"generation":session.map(|s|s.generation),"revision":session.map(|s|s.revision),
            "state":if state.collecting {"collecting"} else if session.is_some() {"stopped"} else {"unconfigured"},
            "timestampMs":now,"capacity":CAPACITY,"hosts":hosts})
    }
}
pub(crate) fn is_info(text: &str) -> bool {
    wayrill_diagnostics::xray_level(text) == Some("info")
}
pub(crate) struct Decision<'a> {
    tag: &'a str,
    outbound: &'a str,
    destination: &'a str,
    transport: &'static str,
    session_id: Option<u32>,
}
pub(crate) fn decision(text: &str) -> Option<Decision<'_>> {
    let (prefix, message) = text
        .trim_end()
        .split_once(" app/dispatcher: Hit route rule: [")?;
    // The logger prefix contains timestamp/severity/session only, never another log message.
    if !prefix.contains("[Info]")
        || !prefix
            .chars()
            .all(|c| c.is_ascii_digit() || "/:. []Info".contains(c))
    {
        return None;
    }
    let (tag, tail) = message.split_once("] so taking detour [")?;
    let (outbound, tail) = tail.split_once("] for [")?;
    let target = tail.strip_suffix(']')?;
    let (transport, destination) = if let Some(destination) = target.strip_prefix("tcp:") {
        ("tcp", destination)
    } else {
        ("udp", target.strip_prefix("udp:")?)
    };
    if !tag.starts_with("wrr-")
        || !printable(tag, 128)
        || !printable(outbound, 160)
        || !printable(destination, 1024)
    {
        return None;
    }
    let session_id = prefix.split_once("[Info]").and_then(|(_, rest)| {
        rest.trim()
            .strip_prefix('[')?
            .strip_suffix(']')?
            .parse::<u32>()
            .ok()
            .filter(|id| *id != 0)
    });
    Some(Decision {
        tag,
        outbound,
        destination,
        transport,
        session_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ip_retry_config() -> Value {
        json!({"log":{"loglevel":"info"},"dns":{"hosts":{"ip-retry.companion.test":"127.0.0.1"}},
            "inbounds":[{"tag":"browser","protocol":"http","listen":"127.0.0.1","port":28974}],
            "outbounds":[{"tag":"default-block","protocol":"blackhole"},{"tag":"ip-match","protocol":"freedom","settings":{"domainStrategy":"UseIP"}}],
            "routing":{"domainStrategy":"IPIfNonMatch","rules":[{"type":"field","ip":["127.0.0.1/32"],"outboundTag":"ip-match"}]}})
    }
    #[test]
    fn instrumentation_preserves_ip_retry_and_never_labels_an_explicit_rule_as_default() {
        for strategy in ["IPIfNonMatch", "ipifnonmatch", "IPIFNONMATCH"] {
            for with_default_metadata in [false, true] {
                let mut config = ip_retry_config();
                config["routing"]["domainStrategy"] = json!(strategy);
                let mut metadata = DisplayNames::default();
                if with_default_metadata {
                    metadata.routing_default = names().routing.get("0").cloned();
                }
                let session = instrument(&mut config, &metadata, 1, 7).unwrap();
                assert_eq!(config["routing"]["rules"].as_array().unwrap().len(), 1);
                assert_eq!(config["routing"]["rules"][0]["outboundTag"], "ip-match");
                assert!(session.routes.values().all(|route| route.trail.is_empty()));
                assert!(session.filters.is_empty());
            }
        }
        let mut scripted =
            json!({"outbounds":[{"tag":"direct"}],"routing":{"script":"return 'direct'"}});
        let original = scripted.clone();
        assert!(instrument(&mut scripted, &DisplayNames::default(), 1, 7).is_none());
        assert_eq!(scripted, original);
    }
    #[test]
    fn companion_limits_diverse_routes_and_unicode_trails_below_chromium_frame_limit() {
        let log = Log::default();
        let mut metadata = names();
        let mut hop = metadata.routing["0"][0].clone();
        hop.rule = "界".repeat(160);
        hop.output = "界".repeat(160);
        metadata.routing.insert("0".into(), vec![hop; 8]);
        log.begin(instrument(&mut config(), &metadata, 1, 7));
        let mut hosts = BTreeSet::new();
        for i in 0..128 {
            let host = format!("host{i}.test");
            hosts.insert(host.clone());
            for port in 440..444 {
                log.ingest(1, &line(1, &format!("tcp:{host}:{port}"), "direct"));
            }
        }
        log.ingest(1, &line(1, "tcp:unrequested-private.test:443", "direct"));
        let snapshot = log.companion(&hosts, "instance", crate::traffic::timestamp_ms());
        let bytes = serde_json::to_vec(&snapshot).unwrap();
        assert!(bytes.len() < 900 * 1024);
        assert!(!String::from_utf8(bytes)
            .unwrap()
            .contains("unrequested-private"));
        assert!(snapshot["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h["matches"].as_array().unwrap().len() <= 3));
        assert!(snapshot["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["truncated"] == true));
    }
    #[test]
    fn companion_observes_simple_graphs_and_native_rules_without_filter_metadata() {
        let log = Log::default();
        let mut simple = json!({"outbounds":[{"tag":"direct"}]});
        let saved = simple.clone();
        let names = DisplayNames::default();
        log.begin(instrument(&mut simple, &names, 1, 7));
        assert!(saved.get("routing").is_none());
        assert_eq!(simple["routing"]["rules"][0]["outboundTag"], "direct");
        log.ingest(1, &line(1, "tcp:example.org:443", "direct"));
        let hosts = BTreeSet::from(["example.org".into()]);
        let snapshot = log.companion(&hosts, "instance", crate::traffic::timestamp_ms());
        assert_eq!(snapshot["state"], "collecting");
        assert_eq!(snapshot["hosts"][0]["matches"][0]["outbound"], "direct");
        assert_eq!(snapshot["hosts"][0]["matches"][0]["path"], json!([]));
        assert_eq!(
            log.snapshot("unconfigured-filter", "instance")["rows"],
            json!([])
        );
    }
    #[test]
    fn companion_retains_last_known_routes_and_replaces_them_with_new_observations() {
        let log = Log::default();
        let hosts = BTreeSet::from([
            "example.org".into(),
            "2001:db8::1".into(),
            "other.test".into(),
        ]);
        log.begin(instrument(&mut config(), &names(), 1, 7));
        log.ingest(1, &line(1, "tcp:EXAMPLE.org.:443", "direct"));
        log.ingest(1, &line(1, "udp:[2001:db8::1]:443", "direct"));
        let now = crate::traffic::timestamp_ms();
        let snapshot = log.companion(&hosts, "instance", now);
        assert_eq!(snapshot["hosts"][0]["matches"][0]["outbound"], "Direct");
        assert_eq!(
            snapshot["hosts"][1]["matches"][0]["path"][0]["rule"],
            "Web 🌍"
        );
        assert_eq!(snapshot["hosts"][2]["matches"], json!([]));
        assert_eq!(
            log.companion(&hosts, "instance", now + 86_400_000)["hosts"][1]["matches"],
            snapshot["hosts"][1]["matches"]
        );
        log.stop();
        assert_eq!(
            log.companion(&hosts, "instance", now)["hosts"][1]["matches"],
            snapshot["hosts"][1]["matches"]
        );
        let mut blocked_config = config();
        blocked_config["outbounds"][1]["protocol"] = json!("blackhole");
        log.begin(instrument(&mut blocked_config, &names(), 2, 7));
        assert_eq!(
            log.companion(&hosts, "instance", now)["hosts"][1]["matches"],
            snapshot["hosts"][1]["matches"]
        );
        log.ingest(
            2,
            &line(2, "tcp:example.org:443", "block").replace("wrr-AggA", "wrr-AgcA"),
        );
        assert_eq!(
            log.companion(&hosts, "instance", now)["hosts"][1]["matches"][0]["outbound"],
            "Block"
        );
        let blocked = log.companion(&hosts, "instance", now + 120_001);
        assert_eq!(blocked["hosts"][1]["matches"][0]["action"], "block");
        assert_eq!(blocked["hosts"][1]["matches"][0]["generation"], 2);
        assert_eq!(blocked["hosts"][1]["matches"][0]["revision"], 7);
        // Activation is not evidence of a new connection. Retain the old Block
        // with its provenance until a newly observed route replaces it.
        log.live(instrument(&mut config(), &names(), 2, 8));
        assert_eq!(
            log.companion(&hosts, "instance", now)["hosts"][1]["matches"],
            blocked["hosts"][1]["matches"]
        );
        log.ingest(2, &line(2, "tcp:example.org:443", "direct"));
        let changed = log.companion(&hosts, "instance", now);
        assert_eq!(changed["hosts"][1]["matches"].as_array().unwrap().len(), 1);
        assert_eq!(changed["hosts"][1]["matches"][0]["outbound"], "Direct");
        assert_eq!(changed["hosts"][1]["matches"][0]["action"], "route");
        assert_eq!(changed["hosts"][1]["matches"][0]["revision"], 8);
    }
    #[test]
    fn companion_keeps_renamed_block_after_connection_log_rollover() {
        let log = Log::default();
        let mut config = config();
        config["outbounds"][1]["protocol"] = json!("blackhole");
        let mut metadata = names();
        metadata
            .outbound
            .insert("block".into(), "Advertising".into());
        log.begin(instrument(&mut config, &metadata, 1, 7));
        log.ingest(1, &line(1, "tcp:blocked.test:443", "block"));
        for port in 1..=CAPACITY + 100 {
            log.ingest(1, &line(1, &format!("tcp:busy.test:{port}"), "direct"));
        }
        {
            let state = log.state.lock().unwrap();
            assert!(!state
                .rows
                .iter()
                .any(|row| row.destination == "blocked.test:443"));
            assert_eq!(state.known.len(), 2);
            assert!(state.known_bytes <= BYTES);
        }
        let snapshot = log.companion(
            &BTreeSet::from(["blocked.test".into()]),
            "instance",
            u64::MAX,
        );
        assert_eq!(
            snapshot["hosts"][0]["matches"][0]["outbound"],
            "Advertising"
        );
        assert_eq!(snapshot["hosts"][0]["matches"][0]["action"], "block");
    }
    #[test]
    fn live_revisions_keep_late_old_decisions_and_rollback_metadata() {
        let log = Log::default();
        log.begin(instrument(&mut config(), &names(), 1, 7));
        let mut updated = names();
        updated.routing.get_mut("0").unwrap()[0].rule = "New rule".into();
        log.live(instrument(&mut config(), &updated, 1, 8));
        let old = line(1, "tcp:old.example:80", "direct");
        let new = line(1, "tcp:new.example:80", "direct").replace("wrr-AQcA", "wrr-AQgA");
        assert!(log.ingest(1, &new));
        assert!(log.ingest(1, &old));
        let snapshot = log.snapshot("parent", "instance");
        assert_eq!(snapshot["rows"][0]["revision"], 8);
        assert_eq!(snapshot["rows"][0]["rule"], "New rule");
        assert_eq!(snapshot["rows"][1]["revision"], 7);
        assert_eq!(snapshot["rows"][1]["rule"], "Web 🌍");
        log.rollback_live();
        assert_eq!(log.snapshot("parent", "instance")["revision"], 7);
        log.ingest(1, &new.replace("new.example", "late.example"));
        assert_eq!(
            log.snapshot("parent", "instance")["rows"][2]["rule"],
            "New rule"
        );
    }
    #[test]
    fn preserves_distinct_connections_and_cores_to_one_destination_but_deduplicates_exact_observations(
    ) {
        let log = Log::default();
        let mut config = config();
        config["routing"]["rules"]
            .as_array_mut()
            .unwrap()
            .push(json!({"domain":["domain:example.org"],"outboundTag":"direct"}));
        let mut names = names();
        let mut later = names.routing["0"].clone();
        later[0].rule_id = Some("google".into());
        later[0].rule = "Google".into();
        names.routing.insert("1".into(), later);
        log.begin(instrument(&mut config, &names, 1, 7));
        let first = line(1, "tcp:mtalk.google.com:5228", "direct");
        let second = first
            .replace("[345]", "[678]")
            .replace("wrr-AQcA", "wrr-AQcB");
        log.ingest_from(1, 100, "TUN", &first);
        log.ingest_from(1, 100, "TUN", &first);
        log.ingest_from(1, 100, "TUN", &second);
        log.ingest_from(1, 200, "Xray", &first);
        let snapshot = log.snapshot("parent", "test");
        assert_eq!(snapshot["rows"].as_array().unwrap().len(), 3);
        assert_eq!(snapshot["rows"][0]["connectionId"], "1/100/345");
        assert_eq!(snapshot["rows"][1]["connectionId"], "1/100/678");
        assert_eq!(snapshot["rows"][1]["rule"], "Google");
        assert_eq!(snapshot["rows"][2]["connectionId"], "1/200/345");
        assert_eq!(snapshot["rows"][0]["transport"], "tcp");
        assert_eq!(snapshot["rows"][2]["source"], "Xray");
        // A later dispatch on one session is not an exact duplicate.
        log.ingest_from(1, 100, "TUN", &first.replace("02.123", "03.123"));
        assert_eq!(
            log.snapshot("parent", "test")["rows"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }
    #[test]
    fn duplicate_index_expires_with_the_bounded_ring_and_absent_session_ids_are_not_conflated() {
        let log = Log::default();
        log.begin(instrument(&mut config(), &names(), 1, 7));
        let no_id = line(1, "udp:no-id.example:53", "direct").replace(" [345]", "");
        log.ingest_from(1, 100, "Xray", &no_id);
        log.ingest_from(1, 100, "Xray", &no_id);
        assert_eq!(
            log.snapshot("parent", "test")["rows"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(log.snapshot("parent", "test")["rows"][0]["connectionId"].is_null());
        for i in 0..CAPACITY + 10 {
            log.ingest_from(
                1,
                100,
                "Xray",
                &line(1, &format!("udp:host{i}.example:53"), "direct"),
            );
        }
        let state = log.state.lock().unwrap();
        assert!(state.seen.len() <= CAPACITY);
        assert_eq!(state.seen.len(), state.rows.len());
    }
    #[test]
    fn shared_ipv6_alias_keeps_the_original_filter_decision() {
        let log = Log::default();
        let mut session = instrument(&mut config(), &names(), 1, 7).unwrap();
        session.include_aliases(&[("wrr-AQcA-ics6".into(), "wrr-AQcA".into())]);
        log.begin(Some(session));
        assert!(log.ingest(
            1,
            &line(1, "tcp:[2001:db8::1]:443", "wi6-A").replace("[wrr-AQcA]", "[wrr-AQcA-ics6]")
        ));
        let rows = log.snapshot("parent", "test");
        assert_eq!(rows["rows"].as_array().unwrap().len(), 1);
        assert_eq!(rows["rows"][0]["rule"], "Web 🌍");
        assert_eq!(rows["rows"][0]["revision"], 7);
    }
    fn names() -> DisplayNames {
        serde_json::from_value(json!({"outbound":{"direct":"Direct","block":"Block"},"routing":{"0":[{"filterId":"parent","ruleId":"web","rule":"Web 🌍","outputId":"inspect","output":"Inspect"},{"filterId":"child","ruleId":null,"rule":"Unmatched traffic","outputId":"direct","output":"Direct"}]}})).unwrap()
    }
    fn config() -> Value {
        json!({"log":{"loglevel":"warning"},"outbounds":[{"tag":"direct"},{"tag":"block"}],"routing":{"rules":[{"domain":["domain:example.org"],"ruleTag":"original","outboundTag":"direct"}]}})
    }
    fn line(generation: u64, destination: &str, outbound: &str) -> String {
        let revision = if generation == 2 { 8 } else { 7 };
        let tag = format!("wrr-{}", crate::tags::sequence(&[generation, revision, 0]));
        format!("2026/10/13 12:01:02.123 [Info] [345] app/dispatcher: Hit route rule: [{tag}] so taking detour [{outbound}] for [{destination}]\r\n")
    }
    #[test]
    fn actual_decision_retains_every_filter_and_hides_tun_relay() {
        let log = Log::default();
        let mut config = config();
        log.begin(instrument(&mut config, &names(), 1, 7));
        assert!(log.ingest(1, &line(1, "tcp:[2001:db8::1]:443", "wtr-3")));
        for filter in ["parent", "child"] {
            let snapshot = log.snapshot(filter, "test");
            assert_eq!(snapshot["rows"][0]["destination"], "[2001:db8::1]:443");
            assert_eq!(snapshot["rows"][0]["outbound"], "Direct");
            assert_eq!(snapshot["rows"][0]["revision"], 7);
        }
        assert_eq!(log.snapshot("parent", "test")["rows"][0]["rule"], "Web 🌍");
        assert_eq!(
            log.snapshot("child", "test")["rows"][0]["rule"],
            "Unmatched traffic"
        );
        assert_eq!(log.snapshot("missing", "test")["state"], "unconfigured");
    }
    #[test]
    fn instrumentation_does_not_change_author_profile_and_fallback_is_last() {
        let mut config = config();
        let original = config.clone();
        let mut names = names();
        names.routing_default = names.routing.get("0").cloned();
        let session = instrument(&mut config, &names, 8, 12).unwrap();
        assert_eq!(original["routing"]["rules"][0]["ruleTag"], "original");
        assert_eq!(config["routing"]["rules"].as_array().unwrap().len(), 2);
        assert_eq!(config["routing"]["rules"][1]["outboundTag"], "direct");
        assert_eq!(config["routing"]["rules"][1]["network"], "tcp,udp");
        assert_eq!(session.routes.len(), 2);
        enable(&mut config);
        assert_eq!(config["log"]["loglevel"], "info");
        config["log"]["loglevel"] = json!("debug");
        enable(&mut config);
        assert_eq!(config["log"]["loglevel"], "debug");
    }
    #[test]
    fn live_telemetry_removes_irreversible_address_masking_from_runtime_only() {
        for mask in ["quarter", "half", "full"] {
            let saved = json!({"log":{"maskAddress":mask,"loglevel":"warning"}});
            let mut runtime = saved.clone();
            enable(&mut runtime);
            assert!(runtime["log"].get("maskAddress").is_none());
            assert_eq!(saved["log"]["maskAddress"], mask);
            assert_eq!(runtime["log"]["access"], "none");
            assert_eq!(runtime["log"]["error"], "");
        }
    }
    #[test]
    fn runtime_rule_tags_do_not_collide_with_imported_tags() {
        let mut config = config();
        config["routing"]["rules"]
            .as_array_mut()
            .unwrap()
            .push(json!({"ruleTag":"wrr-AQEA", "outboundTag":"block"}));
        let session = instrument(&mut config, &names(), 1, 1).unwrap();
        assert_eq!(config["routing"]["rules"][0]["ruleTag"], "wrr-AQEA-1");
        assert!(session.routes.contains_key("wrr-AQEA-1"));
        assert_eq!(config["routing"]["rules"][1]["ruleTag"], "wrr-AQEB");
        assert_eq!(config["routing"]["rules"][2]["ruleTag"], "wrr-AQEC");
    }
    #[test]
    #[cfg(feature = "core-integration")]
    fn core_integration_accepts_instrumented_implicit_fallback() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        let exe = std::env::var_os("WAYRILL_XRAY_TEST_EXE")
            .expect("Run tools/Check-Core.ps1 to prepare core integration tests");
        let config = json!({"inbounds":[{"tag":"test","protocol":"socks","listen":"127.0.0.1","port":22981,"settings":{}}],"outbounds":[{"tag":"direct","protocol":"freedom","settings":{}},{"tag":"block","protocol":"blackhole","settings":{}}],"routing":{"rules":[{"type":"field","domain":["full:blocked.example"],"outboundTag":"block"}]}});
        let mut names = names();
        names.routing_default = names.routing.get("0").cloned();
        let mut simple = config.clone();
        simple.as_object_mut().unwrap().remove("routing");
        for (mut config, names) in [
            (config.clone(), names),
            (config, DisplayNames::default()),
            (simple, DisplayNames::default()),
            (ip_retry_config(), DisplayNames::default()),
        ] {
            instrument(&mut config, &names, 1, 1);
            enable(&mut config);
            let mut child = Command::new(&exe)
                .args(["run", "-test", "-format", "json", "-config", "stdin:"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&serde_json::to_vec(&config).unwrap())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            if config["routing"]["domainStrategy"] == "IPIfNonMatch" {
                let fixture = std::env::var_os("WAYRILL_XRAY_FIXTURE_DIR")
                    .expect("Run tools/Check-Core.ps1 to prepare fixtures");
                std::fs::write(
                    std::path::Path::new(&fixture).join("companion-ip-retry.json"),
                    serde_json::to_vec(&config).unwrap(),
                )
                .unwrap();
            }
        }
    }
    #[test]
    fn bounded_rollover_and_retired_generation_never_relabels_held_rows() {
        let log = Log::default();
        log.begin(instrument(&mut config(), &names(), 1, 7));
        for i in 0..CAPACITY + 100 {
            log.ingest(1, &line(1, &format!("udp:host{i}.example:53"), "direct"));
        }
        assert!(log.state.lock().unwrap().rows.len() <= CAPACITY);
        assert!(log.state.lock().unwrap().known.len() <= CAPACITY);
        assert!(log.state.lock().unwrap().known_bytes <= BYTES);
        let before = log.snapshot("parent", "test");
        assert_eq!(before["rows"].as_array().unwrap().len(), PAGE);
        let mut updated = names();
        updated.routing.get_mut("0").unwrap()[0].rule = "Renamed draft".into();
        log.begin(instrument(&mut config(), &updated, 2, 8));
        assert!(log.ingest(1, &line(1, "tcp:late.example:443", "direct")));
        log.ingest(2, &line(2, "tcp:current.example:443", "direct"));
        let after = log.snapshot("parent", "test");
        assert_eq!(after["rows"][998]["rule"], "Web 🌍");
        assert_eq!(after["rows"][999]["rule"], "Renamed draft");
        log.stop();
        log.ingest(2, &line(2, "tcp:stopped.example:443", "direct"));
        assert_eq!(log.snapshot("parent", "test")["rows"], after["rows"]);
    }
    #[test]
    fn rejects_untrusted_or_malformed_metadata_and_messages() {
        for key in ["bad", "01", "999"] {
            let mut n = names();
            let trail = n.routing.remove("0").unwrap();
            n.routing.insert(key.into(), trail);
            assert!(validate_metadata(&n, &config()).is_err());
        }
        let log = Log::default();
        log.begin(instrument(&mut config(), &names(), 1, 7));
        for bad in [
            line(1, "tcp:bad\n.example:443", "direct"),
            line(1, "tcp:bad.example:443", "direct").replace("app/dispatcher:", "proxy/vless:"),
            line(2, "tcp:wrong.example:443", "direct"),
            line(1, &format!("tcp:{}:443", "x".repeat(1025)), "direct"),
            "[Info] proxy/socks: account secret-password".into(),
        ] {
            assert!(log.ingest(1, &bad));
        }
        assert_eq!(log.snapshot("parent", "test")["rows"], json!([]));
        assert!(!log.ingest(1, "[Warning] cannot connect"));
        assert!(!log.ingest(
            1,
            "2026/10/13 12:01:02 [Warning] failed target contains [Info]"
        ));
        let request: std::result::Result<Request, _> =
            serde_json::from_value(json!({"filterId":"x","query":"raw"}));
        assert!(request.is_err());
        assert!(Request {
            filter_id: "\n".into()
        }
        .validate()
        .is_err());
    }
}
