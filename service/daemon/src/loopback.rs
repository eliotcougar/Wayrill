//! Locality is a socket policy, applied after the user's routing decision.
//! Official Xray Loopback handlers redispatch allowed destinations into private
//! scopes. Blackhole handlers stay untouched, including policy fallbacks.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
use wayrill_protocol::{ApiError, Result};

const MAX_RUNTIME_BYTES: usize = 64 * 1024 * 1024;

pub fn local_address(address: &str) -> bool {
    let host = address.trim_end_matches('.');
    host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(local_ip)
}
fn local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => {
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback())
        }
    }
}
pub fn local_peer(outbound: &Value) -> bool {
    let settings = &outbound["settings"];
    if settings["redirect"].as_str().is_some_and(|s| {
        s.parse::<SocketAddr>().is_ok_and(|a| local_ip(a.ip()))
            || s.rsplit_once(':')
                .is_some_and(|(host, _)| local_address(host))
    }) || settings["address"].as_str().is_some_and(local_address)
    {
        return true;
    }
    ["servers", "vnext"].iter().any(|key| {
        settings[*key]
            .as_array()
            .filter(|p| !p.is_empty())
            .is_some_and(|peers| {
                peers
                    .iter()
                    .all(|peer| peer["address"].as_str().is_some_and(local_address))
            })
    })
}

pub struct Policy {
    rules: Vec<Value>,
    counter_sources: Arc<CounterSources>,
    local_counter_tag: Option<String>,
}
pub type CounterSources = BTreeMap<String, Vec<String>>;
pub(crate) fn private_prefix(config: &Value) -> Result<char> {
    let initials: HashSet<_> = ["outbounds", "inbounds"]
        .into_iter()
        .flat_map(|section| config[section].as_array().into_iter().flatten())
        .chain([&config["metrics"], &config["api"]])
        .filter_map(|item| item["tag"].as_str()?.chars().next())
        .collect();
    let first = (126..=0x10ffff)
        .filter_map(char::from_u32)
        .find(|c| !c.is_control() && !c.is_whitespace() && !initials.contains(c))
        .ok_or_else(|| ApiError::new("INVALID_CONFIG", "Cannot reserve private routing scope."))?;
    Ok(first)
}
pub fn private_tag(config: &Value, base: &str) -> Result<String> {
    let first = private_prefix(config)?;
    Ok(format!("{first}wr-{base}-{}", crate::tun::random_id()?))
}
impl Policy {
    pub fn rules(&self) -> &[Value] {
        &self.rules
    }
    pub fn counter_sources(&self) -> Arc<CounterSources> {
        self.counter_sources.clone()
    }
    pub fn local_counter_tag(&self) -> Option<&str> {
        self.local_counter_tag.as_deref()
    }
    pub fn apply(config: &mut Value, interface: &str) -> Result<Self> {
        let original = config["outbounds"]
            .as_array()
            .ok_or_else(|| ApiError::new("INVALID_CONFIG", "Missing core outbounds."))?;
        // No internal tag can match an original tag prefix or inbound scope.
        let tags: Vec<_> = original
            .iter()
            .filter_map(|o| o["tag"].as_str())
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned)
            .collect();
        let namespace = private_tag(config, "local")?;
        let local4 = format!("{namespace}-v4");
        let local6 = format!("{namespace}-v6");
        let mut outputs = Vec::with_capacity(original.len());
        let mut internal = Vec::new();
        let mut scopes = Vec::new();
        let mut fallbacks = Vec::new();
        let mut counter_sources = CounterSources::new();
        for (index, original) in original.iter().enumerate() {
            if ["blackhole", "block", "dns", "loopback"]
                .contains(&original["protocol"].as_str().unwrap_or(""))
            {
                outputs.push(original.clone());
                continue;
            }
            let scope = format!("{namespace}-{index}");
            let inner = format!("{scope}-transport");
            let mut transport = original.clone();
            transport["tag"] = json!(inner);
            if let Some(tag) = original["tag"].as_str().filter(|tag| !tag.is_empty()) {
                counter_sources.insert(tag.to_owned(), vec![inner.clone()]);
            }
            if local_peer(original) {
                // A fixed local peer must never inherit a physical/VPN source.
                if !transport["streamSettings"].is_object() {
                    transport["streamSettings"] = json!({});
                }
                if !transport["streamSettings"]["sockopt"].is_object() {
                    transport["streamSettings"]["sockopt"] = json!({});
                }
                transport["streamSettings"]["sockopt"]["interface"] = json!(interface);
                transport.as_object_mut().unwrap().remove("sendThrough");
            }
            let mut wrapper = json!({"protocol":"loopback","settings":{"inboundTag":scope}});
            if let Some(tag) = original.get("tag") {
                wrapper["tag"] = tag.clone();
            }
            // Preserve authored name resolution. Do not force remote domains
            // through a new local DNS dependency merely to inspect literal IPs.
            if let Some(strategy) = original
                .get("targetStrategy")
                .filter(|v| v.as_str().is_some_and(|s| s != "AsIs"))
            {
                wrapper["targetStrategy"] = strategy.clone();
            } else if original["protocol"] == "freedom" {
                // Direct already resolves its destination locally. Resolve it
                // before the local-IP guard, not after binding the uplink.
                let strategy = [
                    &original["streamSettings"]["sockopt"]["domainStrategy"],
                    &original["settings"]["domainStrategy"],
                ]
                .into_iter()
                .find(|v| v.as_str().is_some_and(|s| s != "AsIs"));
                wrapper["targetStrategy"] = strategy.cloned().unwrap_or_else(|| json!("ForceIP"));
            }
            outputs.push(wrapper);
            internal.push(transport);
            scopes.push(scope.clone());
            fallbacks.push(json!({"type":"field","inboundTag":[scope],"outboundTag":inner}));
        }
        let mut rules = Vec::new();
        let mut local_counter_tag = None;
        if !scopes.is_empty() {
            // These shared Direct sockets do not belong to any one selected
            // proxy or Direct node. Report their bytes separately and once.
            let mut tag = "Local loopback".to_owned();
            let mut suffix = 2;
            let occupied: HashSet<_> = tags.iter().map(String::as_str).collect();
            while occupied.contains(tag.as_str()) {
                tag = format!("Local loopback ({suffix})");
                suffix += 1;
            }
            counter_sources.insert(tag.clone(), vec![local4.clone(), local6.clone()]);
            local_counter_tag = Some(tag);
            rules.push(json!({"type":"field","inboundTag":scopes,"ip":["127.0.0.0/8"],"outboundTag":local4}));
            rules.push(
                json!({"type":"field","inboundTag":scopes,"ip":["::1/128"],"outboundTag":local6}),
            );
            rules.push(json!({"type":"field","inboundTag":scopes,"domain":["domain:localhost","full:localhost."],"outboundTag":local4}));
            rules.extend(fallbacks);
            for (tag, source) in [(&local4, "127.0.0.1"), (&local6, "::1")] {
                internal.push(json!({"tag":tag,"protocol":"freedom","sendThrough":source,
                    "streamSettings":{"sockopt":{"interface":interface,"domainStrategy":if source == "::1" {"UseIPv6"} else {"UseIPv4"}}}}));
            }
            // Local names must resolve locally even with a remote-only DNS set.
            if !config["dns"].is_object() {
                config["dns"] = json!({});
            }
            if !config["dns"]["hosts"].is_object() {
                config["dns"]["hosts"] = json!({});
            }
            config["dns"]["hosts"]["domain:localhost"] = json!("127.0.0.1");
            config["dns"]["hosts"]["full:localhost."] = json!("127.0.0.1");
            if !config["routing"].is_object() {
                config["routing"] = json!({});
            }
            if let Some(groups) = config["routing"]["balancers"].as_array_mut() {
                for group in groups {
                    freeze(
                        group,
                        "selector",
                        &tags,
                        &format!("{namespace}-no-candidate"),
                    );
                }
            }
            for name in ["observatory", "burstObservatory"] {
                if let Some(value) = config.get_mut(name) {
                    freeze(
                        value,
                        "subjectSelector",
                        &tags,
                        &format!("{namespace}-no-candidate"),
                    );
                }
            }
            let mut all = rules.clone();
            all.extend(
                config["routing"]["rules"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            );
            config["routing"]["rules"] = json!(all);
        }
        outputs.extend(internal);
        config["outbounds"] = json!(outputs);
        if serde_json::to_vec(config)
            .map_err(|e| ApiError::io("Encode local routing policy", e))?
            .len()
            > MAX_RUNTIME_BYTES
        {
            return Err(ApiError::new(
                "INVALID_CONFIG",
                "Expanded local routing policy exceeds the runtime budget.",
            ));
        }
        Ok(Self {
            rules,
            counter_sources: Arc::new(counter_sources),
            local_counter_tag,
        })
    }
}
pub(crate) fn freeze(value: &mut Value, key: &str, tags: &[String], unmatched: &str) {
    if let Some(selectors) = value[key].as_array() {
        // Keep efficient prefixes. Expanding a selector to thousands of exact
        // tags makes Xray's prefix scan quadratic for large subscriptions.
        let matched: BTreeSet<String> = if selectors.iter().any(|s| s == "") {
            tags.iter()
                .filter_map(|tag| tag.chars().next())
                .map(|c| c.to_string())
                .collect()
        } else {
            selectors
                .iter()
                .filter_map(Value::as_str)
                .filter(|selector| tags.iter().any(|tag| tag.starts_with(selector)))
                .map(str::to_owned)
                .collect()
        };
        // Xray rejects an empty balancer selector, even with fallbackTag.
        // This reserved prefix cannot select any original or helper handler.
        value[key] = if matched.is_empty() {
            json!([unmatched])
        } else {
            json!(matched)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_socket_counters_and_reserves_an_unambiguous_local_bucket() {
        let mut config = json!({"outbounds":[{"tag":"proxy","protocol":"freedom"},{"tag":"Local loopback","protocol":"freedom"},{"tag":"block","protocol":"blackhole"},{"tag":"chain","protocol":"loopback","settings":{"inboundTag":"hop"}}]});
        let policy = Policy::apply(&mut config, "Loopback").unwrap();
        assert_eq!(policy.local_counter_tag(), Some("Local loopback (2)"));
        let sources = policy.counter_sources();
        assert_eq!(sources.len(), 3);
        assert!(!sources.contains_key("block"));
        assert!(!sources.contains_key("chain"));
        for tag in sources.values().flatten() {
            assert!(config["outbounds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|output| output["tag"] == *tag && output["protocol"] == "freedom"));
        }
        assert_eq!(sources["Local loopback (2)"].len(), 2);
    }
    #[test]
    fn recognizes_local_addresses_without_confusing_private_networks() {
        for address in [
            "127.0.0.1",
            "127.92.1.2",
            "::1",
            "[::1]",
            "::ffff:127.9.1.2",
            "LOCALHOST",
            "localhost.",
            "app.localhost",
        ] {
            assert!(local_address(address), "{address}");
        }
        for address in [
            "128.0.0.1",
            "10.0.0.1",
            "192.168.0.1",
            "localhost.example",
            "::ffff:192.168.0.1",
        ] {
            assert!(!local_address(address), "{address}");
        }
    }
    #[test]
    fn guards_selected_transports_without_changing_block_or_user_rule_order() {
        let original = json!({"outbounds":[{"tag":"proxy","protocol":"socks","settings":{"address":"192.0.2.9","port":99},"mux":{"enabled":true}},{"tag":"direct","protocol":"freedom","streamSettings":{"sockopt":{"interface":"VPN"}}},{"tag":"deny","protocol":"blackhole"},{"tag":"chain","protocol":"loopback","settings":{"inboundTag":"chain-hop"}}],"routing":{"balancers":[{"tag":"pool","selector":[""]}],"rules":[{"ip":["127.9.0.0/16"],"outboundTag":"deny"},{"outboundTag":"proxy"}]},"observatory":{"subjectSelector":[""]}});
        let mut config = original.clone();
        let policy = Policy::apply(&mut config, "Loopback").unwrap();
        assert_eq!(policy.rules.len(), 5);
        assert_eq!(config["outbounds"][2], original["outbounds"][2]);
        assert_eq!(config["outbounds"][3], original["outbounds"][3]);
        assert_eq!(
            &config["routing"]["rules"].as_array().unwrap()[5..],
            original["routing"]["rules"].as_array().unwrap()
        );
        assert_eq!(config["outbounds"][0]["protocol"], "loopback");
        assert!(config["outbounds"][0].get("mux").is_none());
        assert_eq!(
            config["outbounds"][4]["mux"],
            original["outbounds"][0]["mux"]
        );
        assert_eq!(
            config["outbounds"][5]["streamSettings"]["sockopt"]["interface"],
            "VPN"
        );
        for key in ["selector", "subjectSelector"] {
            let value = if key == "selector" {
                &config["routing"]["balancers"][0]
            } else {
                &config["observatory"]
            };
            assert_eq!(value[key], json!(["c", "d", "p"]));
        }
        for output in config["outbounds"].as_array().unwrap().iter().skip(4) {
            let tag = output["tag"].as_str().unwrap();
            assert!(["proxy", "direct", "deny", "chain"]
                .iter()
                .all(|prefix| !tag.starts_with(prefix)));
        }
    }
    #[test]
    fn fixed_local_chain_peers_ignore_a_physical_source_but_keep_dependencies() {
        let mut config = json!({"outbounds":[{"tag":"hop","protocol":"socks","settings":{"servers":[{"address":"::ffff:127.0.0.2","port":999} ]},"sendThrough":"192.0.2.8","streamSettings":{"sockopt":{"interface":"Ethernet","dialerProxy":"next"}}},{"tag":"next","protocol":"blackhole"}]});
        Policy::apply(&mut config, "Loopback").unwrap();
        let transport = &config["outbounds"][2];
        assert_eq!(
            transport["streamSettings"]["sockopt"]["interface"],
            "Loopback"
        );
        assert_eq!(
            transport["streamSettings"]["sockopt"]["dialerProxy"],
            "next"
        );
        assert!(transport.get("sendThrough").is_none());
    }
    #[test]
    fn untagged_default_and_dns_outbounds_retain_dispatch_identity() {
        let mut config = json!({"outbounds":[{"protocol":"freedom"},{"tag":"dns","protocol":"dns"}],"dns":{"servers":[{"address":"127.0.0.1","tag":"dns-peer"}]},"routing":{"rules":[{"inboundTag":["dns-peer"],"outboundTag":"dns"}]}});
        Policy::apply(&mut config, "Loopback").unwrap();
        assert!(config["outbounds"][0].get("tag").is_none());
        assert_eq!(config["outbounds"][1]["protocol"], "dns");
        assert_eq!(config["dns"]["servers"][0]["address"], "127.0.0.1");
    }
    #[test]
    fn supports_the_public_outbound_budget_without_admitting_helpers_to_groups() {
        let mut config = json!({"inbounds":[{"tag":"test","protocol":"socks","listen":"127.0.0.1","port":27940,"settings":{}}],"outbounds":(0..wayrill_protocol::MAX_OUTBOUNDS).map(|i|json!({"tag":format!("p{i}"),"protocol":"freedom"})).collect::<Vec<_>>(),"routing":{"balancers":[{"tag":"all","selector":["p"]}],"rules":[]}});
        wayrill_protocol::normalize_config(config.clone()).unwrap();
        let policy = Policy::apply(&mut config, "Loopback").unwrap();
        assert_eq!(policy.rules.len(), wayrill_protocol::MAX_OUTBOUNDS + 3);
        assert_eq!(
            config["outbounds"].as_array().unwrap().len(),
            2 * wayrill_protocol::MAX_OUTBOUNDS + 2
        );
        assert_eq!(config["routing"]["balancers"][0]["selector"], json!(["p"]));
    }
    #[test]
    fn pinned_core_accepts_the_expanded_policy_and_chained_handlers() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        let Some(exe) = std::env::var_os("WAYRILL_XRAY_TEST_EXE") else {
            return;
        };
        let mut config = json!({"inbounds":[],"outbounds":[
            {"tag":"direct","protocol":"freedom"},
            {"tag":"proxy","protocol":"socks","settings":{"servers":[{"address":"127.0.0.2","port":12345}]},"streamSettings":{"sockopt":{"dialerProxy":"direct"}}},
            {"tag":"deny","protocol":"blackhole"},
            {"tag":"chain","protocol":"loopback","settings":{"inboundTag":"chain-hop"}}
        ],"observatory":{"subjectSelector":["proxy"]},"routing":{"balancers":[{"tag":"pool","selector":["proxy"],"fallbackTag":"deny","strategy":{"type":"random"}},{"tag":"empty","selector":["no-match"],"fallbackTag":"deny","strategy":{"type":"random"}}],"rules":[{"inboundTag":["chain-hop"],"outboundTag":"proxy"}]}});
        Policy::apply(&mut config, "Loopback").unwrap();
        let empty = config["routing"]["balancers"][1]["selector"][0]
            .as_str()
            .unwrap();
        assert!(config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|o| !o["tag"].as_str().unwrap().starts_with(empty)));
        let mut child = Command::new(exe)
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
    }
}
