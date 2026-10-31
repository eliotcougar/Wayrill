pub mod companion;
mod config_guard;
pub use config_guard::validate_udp_listener_environment;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const API_VERSION: u32 = 1;
pub const PIPE_NAME: &str = r"\\.\pipe\Wayrill.Service.v1";
pub const SERVICE_NAME: &str = "WayrillService";
pub const MAX_FRAME: usize = 32 * 1024 * 1024;
pub const MAX_CONFIG: usize = 16 * 1024 * 1024;
pub const MAX_OUTBOUNDS: usize = 16384;
pub const MAX_ROUTING_RULES: usize = 16384;
pub const MAX_SNAPSHOT_ENDPOINTS: usize = 128;
pub const MAX_ENDPOINT_PAGE: usize = 100;
pub const MAX_METRICS_RESPONSE: usize = 8 * 1024 * 1024;

/// The system proxy and subscription fetcher send plain, unauthenticated HTTP.
pub fn http_proxy_port(config: &Value, port: u16) -> bool {
    config["inbounds"].as_array().is_some_and(|inputs| {
        inputs
            .iter()
            .any(|input| input["port"].as_u64() == Some(u64::from(port)) && http_proxy_input(input))
    })
}

/// Eligibility belongs to a listener, not every tag sharing its port number.
pub fn http_proxy_input(input: &Value) -> bool {
    if !["http", "mixed", "socks"].contains(&input["protocol"].as_str().unwrap_or_default())
        || input["listen"] != "127.0.0.1"
        || !input["port"]
            .as_u64()
            .is_some_and(|port| (1..=65535).contains(&port))
    {
        return false;
    }
    let settings = native(input, "settings");
    let accounts = if native(settings, "accounts").is_null() {
        native(settings, "users")
    } else {
        native(settings, "accounts")
    };
    if native(settings, "auth") == "password"
        || accounts.as_array().is_some_and(|values| !values.is_empty())
    {
        return false;
    }
    let stream = native(input, "streamSettings");
    if !["raw", "tcp"].contains(
        &native(stream, "method")
            .as_str()
            .or_else(|| native(stream, "network").as_str())
            .unwrap_or("raw"),
    ) || !["none", ""].contains(&native(stream, "security").as_str().unwrap_or("none"))
    {
        return false;
    }
    let transport = if native(stream, "rawSettings").is_null() {
        native(stream, "tcpSettings")
    } else {
        native(stream, "rawSettings")
    };
    let header = native(transport, "header");
    if [input, settings, stream, transport, header]
        .iter()
        .any(|object| ambiguous_keys(object))
    {
        return false;
    }
    native(header, "type")
        .as_str()
        .is_none_or(|value| value == "none" || value.is_empty())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub api_version: u32,
    pub id: u64,
    pub method: String,
    #[serde(default = "object")]
    pub params: Value,
}
fn object() -> Value {
    json!({})
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}
impl ApiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
    pub fn io(context: &str, error: impl std::fmt::Display) -> Self {
        Self::new("OS_ERROR", format!("{context}: {error}"))
    }
}
pub type Result<T> = std::result::Result<T, ApiError>;

/// Fixed native ICS phases only; no caller-selected status text or system APIs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SharingPhase {
    CheckSharing,
    EnablePublic,
    EnablePrivate,
    DisableSharing,
    RestoreServices,
    WaitAdapter,
    VerifySharing,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeActivity {
    pub phase: SharingPhase,
    pub elapsed_ms: u64,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Message {
    #[serde(rename_all = "camelCase")]
    Progress {
        api_version: u32,
        id: u64,
        activity: NativeActivity,
    },
    #[serde(rename_all = "camelCase")]
    Response {
        api_version: u32,
        id: u64,
        ok: bool,
        result: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ApiError>,
    },
    #[serde(rename_all = "camelCase")]
    Event {
        api_version: u32,
        instance_id: String,
        sequence: u64,
        timestamp_ms: u64,
        kind: String,
        payload: Value,
    },
}
impl Message {
    pub fn response(id: u64, result: Result<Value>) -> Self {
        match result {
            Ok(result) => Self::Response {
                api_version: API_VERSION,
                id,
                ok: true,
                result,
                error: None,
            },
            Err(error) => Self::Response {
                api_version: API_VERSION,
                id,
                ok: false,
                result: Value::Null,
                error: Some(error),
            },
        }
    }
}
pub fn params<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| {
        ApiError::new(
            "INVALID_PARAMS",
            "Parameters do not match this method's schema.",
        )
    })
}
pub fn check_request(request: &Request) -> Result<()> {
    if request.api_version != API_VERSION {
        return Err(ApiError::new(
            "API_VERSION",
            "This service supports API version 1.",
        ));
    }
    if request.method.len() > 64 || !request.params.is_object() {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "A method and object parameters are required.",
        ));
    }
    Ok(())
}

/// Full runtime configurations only. Every socket listener uses an explicit IP; core API,
/// file output and automatic asset downloads are service-owned rather than user paths.
pub const INBOUND_PROTOCOLS: &[&str] = &[
    "tunnel",
    "dokodemo-door",
    "http",
    "shadowsocks",
    "mixed",
    "socks",
    "vless",
    "vmess",
    "trojan",
    "wireguard",
    "hysteria",
    "masque",
    "tun",
];
pub const OUTBOUND_PROTOCOLS: &[&str] = &[
    "block",
    "blackhole",
    "loopback",
    "direct",
    "freedom",
    "http",
    "shadowsocks",
    "socks",
    "vless",
    "vmess",
    "trojan",
    "hysteria",
    "masque",
    "dns",
    "wireguard",
];
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ListenerNetwork {
    Tcp,
    Udp,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ListenerEndpoint {
    pub address: std::net::SocketAddr,
    pub network: ListenerNetwork,
}
impl ListenerEndpoint {
    pub fn overlaps(self, other: Self) -> bool {
        let a = self.address.ip().to_canonical();
        let b = other.address.ip().to_canonical();
        self.network == other.network
            && self.address.port() == other.address.port()
            && (a == b || a.is_unspecified() || b.is_unspecified())
    }
}
fn network_contains(value: &Value, network: &str) -> bool {
    match value {
        Value::String(s) => s.split(',').any(|n| n.trim().eq_ignore_ascii_case(network)),
        Value::Array(a) => a.iter().any(|v| {
            v.as_str()
                .map(|s| s.eq_ignore_ascii_case(network))
                .unwrap_or(false)
        }),
        _ => network == "tcp",
    }
}
fn ambiguous_keys(object: &Value) -> bool {
    let mut seen = HashSet::new();
    object.as_object().is_some_and(|fields| {
        fields
            .keys()
            .any(|key| !seen.insert(key.to_ascii_lowercase()))
    })
}
fn native<'a>(object: &'a Value, key: &str) -> &'a Value {
    object
        .get(key)
        .or_else(|| {
            object.as_object().and_then(|o| {
                o.iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
                    .map(|(_, v)| v)
            })
        })
        .unwrap_or(&Value::Null)
}
// The logical proxy Network() can report TCP while QUIC/mKCP listens on UDP.
// SOCKS/Mixed UDP ASSOCIATE binds an ephemeral socket per request, not this port.
pub fn listener_endpoints(config: &Value) -> Vec<ListenerEndpoint> {
    let mut endpoints = Vec::new();
    for input in config["inbounds"].as_array().into_iter().flatten() {
        let protocol = input["protocol"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase();
        if protocol == "tun" {
            continue;
        }
        let Some(ip) = input["listen"].as_str().and_then(|s| s.parse().ok()) else {
            continue;
        };
        let Some(port) = input["port"].as_u64().and_then(|p| u16::try_from(p).ok()) else {
            continue;
        };
        let address = std::net::SocketAddr::new(ip, port);
        let stream = native(input, "streamSettings");
        let transport = native(stream, "method")
            .as_str()
            .or_else(|| native(stream, "network").as_str())
            .unwrap_or("raw")
            .to_ascii_lowercase();
        let tls = native(stream, "security").as_str() == Some("tls");
        let alpn = native(native(stream, "tlsSettings"), "alpn");
        let alpn: Vec<&str> = if !tls {
            Vec::new()
        } else if let Some(value) = alpn.as_str() {
            value.split(',').collect()
        } else {
            alpn.as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect()
        };
        let has_alpn = |name: &str| alpn.contains(&name);
        let masque = transport == "masque";
        let xhttp3 = ["xhttp", "splithttp"].contains(&transport.as_str())
            && has_alpn("h3")
            && alpn.len() == 1;
        let udp_transport = ["hysteria", "kcp"].contains(&transport.as_str())
            || masque && (!has_alpn("h2") || has_alpn("h3"))
            || xhttp3;
        let tcp_transport = !udp_transport || masque && has_alpn("h2");
        let wireguard = protocol == "wireguard";
        let settings = native(input, "settings");
        let networks = if !native(settings, "network").is_null() {
            native(settings, "network")
        } else {
            native(settings, "allowedNetwork")
        };
        let tunnel = ["tunnel", "dokodemo-door", "shadowsocks"].contains(&protocol.as_str());
        if !wireguard && tcp_transport && (!tunnel || network_contains(networks, "tcp")) {
            endpoints.push(ListenerEndpoint {
                address,
                network: ListenerNetwork::Tcp,
            });
        }
        if wireguard
            || tunnel && network_contains(networks, "udp")
            || udp_transport && (!tunnel || network_contains(networks, "tcp"))
        {
            endpoints.push(ListenerEndpoint {
                address,
                network: ListenerNetwork::Udp,
            });
        }
    }
    if let Some(address) = config["metrics"]["listen"]
        .as_str()
        .and_then(|s| s.parse().ok())
    {
        endpoints.push(ListenerEndpoint {
            address,
            network: ListenerNetwork::Tcp,
        });
    }
    endpoints
}

pub fn normalize_config(mut config: Value) -> Result<Value> {
    if serde_json::to_vec(&config)
        .map_err(|e| ApiError::io("JSON", e))?
        .len()
        > MAX_CONFIG
    {
        return Err(ApiError::new(
            "CONFIG_TOO_LARGE",
            "Maximum configuration size is 16 MiB.",
        ));
    }
    let root = config
        .as_object_mut()
        .ok_or_else(|| ApiError::new("INVALID_CONFIG", "Supply a complete Xray JSON object."))?;
    const KEYS: &[&str] = &[
        "log",
        "inbounds",
        "outbounds",
        "routing",
        "dns",
        "policy",
        "stats",
        "metrics",
        "fakedns",
        "observatory",
        "burstObservatory",
        "env",
    ];
    if root.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return Err(ApiError::new("UNSUPPORTED_CONFIG", "Supported root sections: log, inbounds, outbounds, routing, dns, policy, stats, metrics, fakedns, observatory, burstObservatory and Wayrill UDP listener env settings."));
    }
    config_guard::canonicalize(&mut config)?;
    config_guard::validate(&config)?;
    let root = config.as_object_mut().unwrap();
    let inbounds = root
        .get("inbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::new(
                "INVALID_CONFIG",
                "A DNS fragment is not a complete runtime configuration; add inbounds.",
            )
        })?;
    if inbounds.is_empty() || inbounds.len() > 16 {
        return Err(ApiError::new(
            "INVALID_CONFIG",
            "Configure between one and sixteen listeners.",
        ));
    }
    let mut tags = HashSet::new();
    for inbound in inbounds {
        let protocol = inbound
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if !INBOUND_PROTOCOLS.contains(&protocol.as_str()) {
            return Err(ApiError::new(
                "UNSUPPORTED_CONFIG",
                "Unknown inbound protocol for the pinned Xray core.",
            ));
        }
        let tag = inbound
            .get("tag")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::new("INVALID_CONFIG", "Every inbound needs a unique tag."))?;
        if !tags.insert(tag.to_string()) {
            return Err(ApiError::new("INVALID_CONFIG", "Duplicate inbound tag."));
        }
        if protocol == "tun" {
            continue;
        }
        let listen = inbound.get("listen").and_then(Value::as_str).unwrap_or("");
        if listen.parse::<std::net::IpAddr>().is_err() {
            return Err(ApiError::new(
                "UNSAFE_LISTENER",
                "Listen address must be an explicit IPv4 or IPv6 address.",
            ));
        }
        inbound
            .get("port")
            .and_then(Value::as_u64)
            .filter(|p| (1..=65535).contains(p))
            .ok_or_else(|| {
                ApiError::new(
                    "INVALID_CONFIG",
                    "Listener ports must be integers from 1 to 65535.",
                )
            })?;
    }
    let endpoints = listener_endpoints(&json!({"inbounds":inbounds}));
    for (index, endpoint) in endpoints.iter().enumerate() {
        if endpoints[..index]
            .iter()
            .any(|other| endpoint.overlaps(*other))
        {
            return Err(ApiError::new(
                "INVALID_CONFIG",
                "Overlapping listener address/port/network.",
            ));
        }
    }
    if root
        .get("outbounds")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= MAX_OUTBOUNDS)
        .is_none()
    {
        return Err(ApiError::new(
            "INVALID_CONFIG",
            "Configure between one and 16,384 outbounds.",
        ));
    }
    if root
        .get("routing")
        .and_then(|r| r.get("rules"))
        .and_then(Value::as_array)
        .is_some_and(|rules| rules.len() > MAX_ROUTING_RULES)
    {
        return Err(ApiError::new(
            "INVALID_CONFIG",
            "Expanded routing exceeds 16,384 rules.",
        ));
    }
    // Keep snapshot/replay memory bounded even for advanced API configurations.
    // This exceeds the graph editor's tag budget, including generated helper tags.
    for section in ["inbounds", "outbounds"] {
        if root[section]
            .as_array()
            .into_iter()
            .flatten()
            .any(|endpoint| endpoint["tag"].as_str().is_some_and(|tag| tag.len() > 1024))
        {
            return Err(ApiError::new(
                "INVALID_CONFIG",
                "Endpoint tags must fit in 1 KiB of UTF-8.",
            ));
        }
    }
    for outbound in root["outbounds"].as_array().unwrap() {
        let protocol = outbound
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if !OUTBOUND_PROTOCOLS.contains(&protocol.as_str()) {
            return Err(ApiError::new(
                "UNSUPPORTED_CONFIG",
                "Unknown outbound protocol for the pinned Xray core.",
            ));
        }
    }
    if let Some(metrics) = root.get("metrics") {
        let options = metrics
            .as_object()
            .ok_or_else(|| ApiError::new("INVALID_CONFIG", "metrics must be an object."))?;
        if options
            .keys()
            .any(|key| !["tag", "listen"].contains(&key.as_str()))
        {
            return Err(ApiError::new(
                "UNSUPPORTED_CONFIG",
                "Unsupported metrics option.",
            ));
        }
        if let Some(listen) = options.get("listen") {
            let address = listen
                .as_str()
                .and_then(|s| s.parse::<std::net::SocketAddr>().ok())
                .ok_or_else(|| {
                    ApiError::new(
                        "UNSAFE_LISTENER",
                        "Metrics requires an explicit loopback socket address.",
                    )
                })?;
            if !address.ip().is_loopback()
                || address.port() < 1024
                || endpoints.iter().any(|e| {
                    e.overlaps(ListenerEndpoint {
                        address,
                        network: ListenerNetwork::Tcp,
                    })
                })
            {
                return Err(ApiError::new(
                    "UNSAFE_LISTENER",
                    "Metrics must use an unused loopback port from 1024 to 65535.",
                ));
            }
        }
    }
    if root.contains_key("observatory") && root.contains_key("burstObservatory") {
        return Err(ApiError::new(
            "INVALID_CONFIG",
            "Use one observatory provider.",
        ));
    }
    for key in ["observatory", "burstObservatory"] {
        if let Some(value) = root.get(key) {
            if !value.is_object() {
                return Err(ApiError::new(
                    "INVALID_CONFIG",
                    "Observatory settings must be objects.",
                ));
            }
        }
    }
    let level = root
        .get("log")
        .and_then(|v| v.get("loglevel"))
        .and_then(Value::as_str)
        .unwrap_or("warning");
    if !["debug", "info", "warning", "error", "none"].contains(&level) {
        return Err(ApiError::new("INVALID_CONFIG", "Invalid log level."));
    }
    let dns_log = match root.get("log").and_then(|v| v.get("dnsLog")) {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err(ApiError::new("INVALID_CONFIG", "dnsLog must be boolean.")),
    };
    let mask_address = match root.get("log").and_then(|v| v.get("maskAddress")) {
        None => "",
        Some(Value::String(value)) if ["", "quarter", "half", "full"].contains(&value.as_str()) => {
            value.as_str()
        }
        _ => {
            return Err(ApiError::new(
                "INVALID_CONFIG",
                "Invalid core log address masking.",
            ))
        }
    };
    let mut log = json!({"loglevel":level,"access":"none","error":""});
    if dns_log {
        log["dnsLog"] = json!(true);
    }
    if !mask_address.is_empty() {
        log["maskAddress"] = json!(mask_address);
    }
    root.insert("log".into(), log);
    Ok(config)
}

pub fn direct_example() -> Value {
    json!({"log":{"loglevel":"warning"},"inbounds":[{"tag":"local-socks","listen":"127.0.0.1","port":2080,"protocol":"socks","settings":{"auth":"noauth","udp":true}},{"tag":"local-http","listen":"127.0.0.1","port":2081,"protocol":"http","settings":{}}],"outbounds":[{"tag":"direct","protocol":"freedom","settings":{}},{"tag":"block","protocol":"blackhole","settings":{}}],"routing":{"domainStrategy":"AsIs","rules":[]}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifies_plain_http_compatible_proxy_listeners() {
        for protocol in ["http", "mixed", "socks"] {
            let config =
                json!({"inbounds":[{"protocol":protocol,"listen":"127.0.0.1","port":2081}]});
            assert!(http_proxy_port(&config, 2081));
            assert!(!http_proxy_port(&config, 2080));
        }
    }
    #[test]
    fn refuses_encrypted_authenticated_and_obfuscated_http_proxies() {
        let changes = [
            json!({"settings":{"auth":"password"}}),
            json!({"settings":{"Accounts":[{"user":"fictional","pass":"fictional"}]}}),
            json!({"streamSettings":{"Security":"tls"}}),
            json!({"StreamSettings":{"security":"reality"}}),
            json!({"streamSettings":{"network":"ws"}}),
            json!({"streamSettings":{"rawSettings":null,"tcpSettings":{"header":{"type":"http"}}}}),
            json!({"streamSettings":{"security":"none","Security":"tls"}}),
            json!({"listen":"::1"}),
        ];
        for change in changes {
            let mut input = json!({"protocol":"mixed","listen":"127.0.0.1","port":2081});
            input
                .as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(!http_proxy_port(&json!({"inbounds":[input]}), 2081));
        }
    }
    #[test]
    fn proxy_account_aliases_follow_the_core() {
        for (accounts, expected) in [(json!([]), true), (Value::Null, false)] {
            let config = json!({"inbounds":[{"protocol":"http","listen":"127.0.0.1","port":2081,"settings":{"accounts":accounts,"users":[{"user":"fictional","pass":"fictional"}]}}]});
            assert_eq!(http_proxy_port(&config, 2081), expected);
        }
    }
    #[test]
    fn preserves_mixed_listener_and_socks_outbound() {
        let mut config = direct_example();
        config["inbounds"][0]["protocol"] = json!("mixed");
        config["outbounds"][0] = json!({"tag":"socks","protocol":"socks","settings":{"address":"127.0.0.1","port":1090,"user":"qa","pass":"fictional-only","level":0,"email":""},"streamSettings":{"sockopt":{"tcpFastOpen":false}}});
        let normalized = normalize_config(config.clone()).unwrap();
        assert_eq!(normalized["inbounds"], config["inbounds"]);
        assert_eq!(normalized["outbounds"], config["outbounds"]);
    }
    #[test]
    fn preserves_tag_only_and_local_metrics() {
        for metrics in [
            json!({"tag":"metrics"}),
            json!({"tag":"metrics","listen":"127.0.0.1:21903"}),
            json!({"listen":"[::1]:21903"}),
        ] {
            let mut config = direct_example();
            config["metrics"] = metrics.clone();
            assert_eq!(normalize_config(config).unwrap()["metrics"], metrics);
        }
    }
    #[test]
    fn metrics_cannot_expose_a_public_or_privileged_listener() {
        for listen in [
            "0.0.0.0:21903",
            "[::]:21903",
            "example.org:21903",
            "127.0.0.1:80",
            "127.0.0.1:2080",
            "",
            "127.0.0.1:65536",
        ] {
            let mut config = direct_example();
            config["metrics"] = json!({"tag":"metrics","listen":listen});
            assert_eq!(
                normalize_config(config).unwrap_err().code,
                "UNSAFE_LISTENER"
            );
        }
        let mut config = direct_example();
        config["metrics"] = json!({"tag":"metrics","unknown":true});
        assert_eq!(
            normalize_config(config).unwrap_err().code,
            "UNSUPPORTED_CONFIG"
        );
    }
    #[test]
    fn preserves_balancer_and_standard_observatory() {
        let mut config = direct_example();
        config["routing"]["balancers"] = json!([{"tag":"group","selector":["direct"],"strategy":{"type":"leastPing"},"fallbackTag":"block"}]);
        config["observatory"] = json!({"subjectSelector":["direct"],"probeURL":"http://127.0.0.1:18880/health","probeInterval":"2s","enableConcurrency":true});
        let result = normalize_config(config.clone()).unwrap();
        assert_eq!(result["observatory"], config["observatory"]);
        assert_eq!(
            result["routing"]["balancers"],
            config["routing"]["balancers"]
        );
    }
    #[test]
    fn preserves_burst_observatory() {
        let mut config = direct_example();
        config["burstObservatory"] = json!({"subjectSelector":["direct"],"pingConfig":{"destination":"http://127.0.0.1:18880/health","interval":"2s","sampling":2,"timeout":"1s","httpMethod":"HEAD"}});
        assert_eq!(
            normalize_config(config.clone()).unwrap()["burstObservatory"],
            config["burstObservatory"]
        );
    }
    #[test]
    fn rejects_ambiguous_or_malformed_observation_providers() {
        let mut config = direct_example();
        config["observatory"] = json!({});
        config["burstObservatory"] = json!({});
        assert_eq!(normalize_config(config).unwrap_err().code, "INVALID_CONFIG");
        for key in ["observatory", "burstObservatory"] {
            let mut config = direct_example();
            config[key] = json!([]);
            assert_eq!(normalize_config(config).unwrap_err().code, "INVALID_CONFIG");
        }
    }
    #[test]
    fn rejects_fragment() {
        assert_eq!(
            normalize_config(json!({"dns":{}})).unwrap_err().code,
            "INVALID_CONFIG"
        );
    }
    #[test]
    fn rejects_implicit_and_malformed_listeners() {
        for listen in [
            "",
            "localhost",
            "example.net",
            "999.1.1.1",
            "[::1]",
            "127.0.0.1:80",
        ] {
            let mut c = direct_example();
            c["inbounds"][0]["listen"] = json!(listen);
            assert_eq!(normalize_config(c).unwrap_err().code, "UNSAFE_LISTENER");
        }
    }
    #[test]
    fn accepts_public_addresses_and_all_nonzero_ports() {
        for address in [
            "0.0.0.0",
            "::",
            "192.0.2.1",
            "2001:db8::1",
            "127.0.0.2",
            "::ffff:192.0.2.1",
        ] {
            for port in [1, 53, 80, 443, 1023, 65535] {
                let mut c = direct_example();
                c["inbounds"][0]["listen"] = json!(address);
                c["inbounds"][0]["port"] = json!(port);
                let normalized = normalize_config(c.clone()).unwrap();
                assert_eq!(normalized["inbounds"], c["inbounds"]);
                assert_eq!(
                    listener_endpoints(&normalized)[0].address.ip(),
                    address.parse::<std::net::IpAddr>().unwrap()
                );
            }
        }
        for port in [json!(0), json!(65536), json!(-1), json!(1.5), json!("80")] {
            let mut c = direct_example();
            c["inbounds"][0]["port"] = port;
            assert_eq!(normalize_config(c).unwrap_err().code, "INVALID_CONFIG");
        }
        let c = json!({"inbounds":[{"protocol":"mixed","listen":"127.0.0.1","port":80}]});
        assert!(http_proxy_port(&c, 80));
    }
    #[test]
    fn detects_wildcard_mapped_and_canonical_socket_collisions() {
        for (a, b) in [
            ("0.0.0.0", "127.0.0.1"),
            ("::", "127.0.0.1"),
            ("::", "2001:db8::1"),
            ("0:0:0:0:0:0:0:1", "::1"),
            ("::ffff:127.0.0.1", "127.0.0.1"),
        ] {
            let mut c = direct_example();
            c["inbounds"][0]["listen"] = json!(a);
            c["inbounds"][1]["listen"] = json!(b);
            c["inbounds"][1]["port"] = json!(2080);
            assert_eq!(normalize_config(c).unwrap_err().code, "INVALID_CONFIG");
        }
        let mut c = direct_example();
        c["inbounds"][0]["listen"] = json!("0.0.0.0");
        c["metrics"] = json!({"listen":"127.0.0.1:2080"});
        assert_eq!(
            normalize_config(c.clone()).unwrap_err().code,
            "UNSAFE_LISTENER"
        );
        c["metrics"] = Value::Null;
        c.as_object_mut().unwrap().remove("metrics");
        c["inbounds"][1] = json!({"protocol":"tunnel","tag":"udp","listen":"127.0.0.1","port":2080,"settings":{"network":"udp"}});
        assert!(normalize_config(c).is_ok());
    }
    #[test]
    fn rejects_core_control_plane() {
        let mut c = direct_example();
        c["api"] = json!({});
        assert_eq!(normalize_config(c).unwrap_err().code, "UNSUPPORTED_CONFIG");
    }
    #[test]
    fn rejects_unknown_request_fields() {
        assert!(serde_json::from_value::<Request>(
            json!({"apiVersion":1,"id":1,"method":"system.exec","executable":"cmd.exe"})
        )
        .is_err());
    }
    #[test]
    fn version_negotiation() {
        let r = Request {
            api_version: 2,
            id: 1,
            method: "service.hello".into(),
            params: json!({}),
        };
        assert_eq!(check_request(&r).unwrap_err().code, "API_VERSION");
    }
    #[test]
    fn response_wire_shape() {
        let r = serde_json::to_value(Message::response(7, Ok(json!({})))).unwrap();
        assert_eq!(r["apiVersion"], 1);
        assert_eq!(r["type"], "response");
        assert_eq!(r["id"], 7);
    }
}

#[cfg(test)]
mod log_default_tests {
    use super::*;

    #[test]
    fn diagnostic_defaults_keep_service_owned_sinks() {
        let mut config = direct_example();
        config["log"] = json!({"access":"C:\\private","error":"C:\\private","loglevel":"info","dnsLog":true,"maskAddress":"full"});
        let normalized = normalize_config(config).unwrap();
        assert_eq!(
            normalized["log"],
            json!({"loglevel":"info","access":"none","error":"","dnsLog":true,"maskAddress":"full"})
        );
    }

    #[test]
    fn malformed_diagnostic_defaults_are_rejected() {
        for options in [
            json!({"dnsLog":"yes"}),
            json!({"maskAddress":"invalid"}),
            json!({"maskAddress":true}),
        ] {
            let mut config = direct_example();
            config["log"] = options;
            assert!(normalize_config(config).is_err());
        }
    }
}

#[cfg(test)]
mod protocol_registry_tests {
    use super::*;
    #[test]
    fn normalizes_protocol_names_before_runtime_classification() {
        let mut config = direct_example();
        config["inbounds"] = json!([{"tag":"tun", "protocol":"TuN", "settings":{"name":"WayrillTUN","gateway":["10.90.0.1/24"]}}]);
        config["outbounds"][0]["protocol"] = json!("FrEeDoM");
        let normalized = normalize_config(config).unwrap();
        assert_eq!(normalized["inbounds"][0]["protocol"], "tun");
        assert_eq!(normalized["outbounds"][0]["protocol"], "freedom");
        assert!(listener_endpoints(&normalized).is_empty());
    }
    #[test]
    fn every_socket_protocol_and_alias_passes_service_safeguards() {
        for protocol in INBOUND_PROTOCOLS.iter().filter(|p| **p != "tun") {
            let mut config = direct_example();
            config["inbounds"][0]["protocol"] = json!(protocol);
            assert_eq!(
                normalize_config(config.clone()).unwrap()["inbounds"],
                config["inbounds"]
            );
            config["inbounds"][0]["listen"] = json!("0.0.0.0");
            assert_eq!(
                normalize_config(config.clone()).unwrap()["inbounds"],
                config["inbounds"]
            );
        }
        for protocol in OUTBOUND_PROTOCOLS {
            let mut config = direct_example();
            config["outbounds"][1]["protocol"] = json!(protocol);
            assert!(normalize_config(config).is_ok());
        }
    }
    #[test]
    fn rejects_unregistered_inbound_and_outbound_protocols() {
        for section in ["inbounds", "outbounds"] {
            let mut config = direct_example();
            config[section][0]["protocol"] = json!("ssr");
            assert_eq!(
                normalize_config(config).unwrap_err().code,
                "UNSUPPORTED_CONFIG"
            );
        }
    }
    #[test]
    fn listener_networks_follow_proxy_and_transport_source() {
        let mut config = direct_example();
        config["inbounds"] = json!([{"tag":"udp","protocol":"tunnel","listen":"127.0.0.1","port":20920,"settings":{"allowedNetwork":["udp"]}}]);
        assert_eq!(
            listener_endpoints(&config)
                .iter()
                .map(|e| e.network)
                .collect::<Vec<_>>(),
            vec![ListenerNetwork::Udp]
        );
        for network in ["hysteria", "masque", "kcp"] {
            config["inbounds"][0]["protocol"] = json!("vless");
            config["inbounds"][0]["streamSettings"] = json!({"network":network});
            assert_eq!(
                listener_endpoints(&config)
                    .iter()
                    .map(|e| e.network)
                    .collect::<Vec<_>>(),
                vec![ListenerNetwork::Udp]
            );
        }
        config["inbounds"][0]["streamSettings"] = json!({"network":"raw"});
        config["inbounds"][0]["protocol"] = json!("wireguard");
        assert_eq!(
            listener_endpoints(&config)
                .iter()
                .map(|e| e.network)
                .collect::<Vec<_>>(),
            vec![ListenerNetwork::Udp]
        );
        config["inbounds"][0]["protocol"] = json!("mixed");
        config["inbounds"][0]["settings"] = json!({"udp":true});
        assert_eq!(listener_endpoints(&config).len(), 1);
        config["metrics"] = json!({"listen":"127.0.0.1:20925"});
        assert_eq!(listener_endpoints(&config).len(), 2);
    }
    #[test]
    fn http2_and_http3_listener_networks_follow_active_tls_alpn() {
        let mut config = direct_example();
        config["inbounds"] =
            json!([{"tag":"local","protocol":"vless","listen":"127.0.0.1","port":20930}]);
        for (transport, security, alpn, expected) in [
            ("masque", "tls", json!("h2"), vec![ListenerNetwork::Tcp]),
            (
                "masque",
                "tls",
                json!("h2,h3"),
                vec![ListenerNetwork::Tcp, ListenerNetwork::Udp],
            ),
            ("xhttp", "tls", json!("h3"), vec![ListenerNetwork::Udp]),
            ("masque", "tls", json!(["h2"]), vec![ListenerNetwork::Tcp]),
            ("masque", "tls", json!(["h3"]), vec![ListenerNetwork::Udp]),
            (
                "masque",
                "tls",
                json!(["h2", "h3"]),
                vec![ListenerNetwork::Tcp, ListenerNetwork::Udp],
            ),
            ("xhttp", "tls", json!(["h3"]), vec![ListenerNetwork::Udp]),
            (
                "splithttp",
                "tls",
                json!(["h3"]),
                vec![ListenerNetwork::Udp],
            ),
            (
                "xhttp",
                "tls",
                json!(["h2", "http/1.1"]),
                vec![ListenerNetwork::Tcp],
            ),
            ("xhttp", "none", json!(["h3"]), vec![ListenerNetwork::Tcp]),
        ] {
            config["inbounds"][0]["streamSettings"] =
                json!({"network":transport,"security":security,"tlsSettings":{"alpn":alpn}});
            assert_eq!(
                listener_endpoints(&config)
                    .iter()
                    .map(|e| e.network)
                    .collect::<Vec<_>>(),
                expected,
                "{transport} {security}"
            );
        }
    }
    #[test]
    fn masque_http2_can_share_its_numeric_port_with_an_unrelated_udp_listener() {
        let mut config = direct_example();
        config["inbounds"][0]["streamSettings"] =
            json!({"network":"masque","security":"tls","tlsSettings":{"alpn":["h2"]}});
        config["inbounds"][1] = json!({"tag":"udp","listen":"127.0.0.1","port":2080,"protocol":"tunnel","settings":{"allowedNetwork":"udp"}});
        assert!(normalize_config(config.clone()).is_ok());
        config["inbounds"][0]["streamSettings"]["tlsSettings"]["alpn"] = json!(["h2", "h3"]);
        assert!(normalize_config(config).is_err());
    }
    #[test]
    fn separate_tcp_udp_ports_coexist_but_same_network_cannot() {
        let mut config = direct_example();
        config["inbounds"][1] = json!({"tag":"udp","listen":"127.0.0.1","port":2080,"protocol":"tunnel","settings":{"allowedNetwork":"udp"}});
        config["inbounds"][0]["protocol"] = json!("tunnel");
        config["inbounds"][0]["settings"] = json!({"network":"tcp"});
        assert!(normalize_config(config.clone()).is_ok());
        config["inbounds"][0]["settings"]["network"] = json!("tcp,udp");
        assert!(normalize_config(config).is_err());
    }
    #[test]
    fn socks_udp_association_does_not_reserve_a_fixed_udp_port() {
        let mut config = direct_example();
        config["inbounds"][1] = json!({"tag":"udp","listen":"127.0.0.1","port":2080,"protocol":"tunnel","settings":{"network":"udp"}});
        for protocol in ["socks", "mixed"] {
            config["inbounds"][0]["protocol"] = json!(protocol);
            assert!(normalize_config(config.clone()).is_ok());
            assert_eq!(listener_endpoints(&config).len(), 2);
        }
    }
    #[test]
    fn transport_case_is_respected_without_ambiguous_listener_fields() {
        let mut config = direct_example();
        config["inbounds"] = json!([{"tag":"quic","listen":"127.0.0.1","port":20920,"protocol":"hysteria","StreamSettings":{"Network":"hysteria"}}]);
        assert_eq!(listener_endpoints(&config)[0].network, ListenerNetwork::Udp);
        assert!(normalize_config(config.clone()).is_ok());
        config["inbounds"][0]["Listen"] = json!("0.0.0.0");
        assert!(normalize_config(config).is_err());
    }
    #[test]
    fn published_budgets_match_privileged_boundaries() {
        let limits: Value = serde_json::from_str(include_str!("../../limits.json")).unwrap();
        for (key, constant) in [
            ("maxOutbounds", MAX_OUTBOUNDS),
            ("maxRoutingRules", MAX_ROUTING_RULES),
            ("configBytes", MAX_CONFIG),
            ("frameBytes", MAX_FRAME),
            ("metricsResponseBytes", MAX_METRICS_RESPONSE),
            ("snapshotEndpoints", MAX_SNAPSHOT_ENDPOINTS),
            ("endpointPageSize", MAX_ENDPOINT_PAGE),
        ] {
            assert_eq!(limits[key].as_u64().unwrap() as usize, constant, "{}", key);
        }
    }
    #[test]
    fn accepts_large_pools_and_rejects_over_budget_outbounds_and_rules() {
        let mut config = direct_example();
        config["outbounds"] = Value::Array(
            (0..MAX_OUTBOUNDS)
                .map(|i| json!({"tag":format!("edge-{i}"),"protocol":"freedom"}))
                .collect(),
        );
        assert!(normalize_config(config.clone()).is_ok());
        config["outbounds"]
            .as_array_mut()
            .unwrap()
            .push(json!({"tag":"over-budget","protocol":"freedom"}));
        assert!(normalize_config(config).is_err());
        let mut config = direct_example();
        config["routing"]["rules"] = json!(vec![
            json!({"port":"443","outboundTag":"direct"});
            MAX_ROUTING_RULES + 1
        ]);
        assert!(normalize_config(config).is_err());
        let mut config = direct_example();
        config["outbounds"][0]["tag"] = json!("x".repeat(1025));
        assert!(normalize_config(config).is_err());
    }
}
