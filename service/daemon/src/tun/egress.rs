//! Bind capture egress to its selected uplink. Locality is enforced separately
//! for every selected transport by the shared runtime loopback policy.
use super::Result;
use serde_json::{json, Value};

pub(super) fn needs_direct_binding(config: &Value) -> bool {
    config["outbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|outbound| {
            outbound["protocol"] == "freedom"
                && outbound["streamSettings"]["sockopt"]["interface"]
                    .as_str()
                    .unwrap_or("")
                    .is_empty()
        })
}

pub(super) fn bind_direct(config: &mut Value, uplink: &str, loopback: &str) -> Result<()> {
    bind_selected(config, uplink, loopback, true)
}

pub(super) fn bind(config: &mut Value, uplink: &str, loopback: &str) -> Result<()> {
    bind_selected(config, uplink, loopback, false)
}

fn bind_selected(
    config: &mut Value,
    uplink: &str,
    loopback: &str,
    direct_only: bool,
) -> Result<()> {
    for outbound in config["outbounds"].as_array_mut().unwrap() {
        if (direct_only
            && (outbound["protocol"] != "freedom"
                || !outbound["streamSettings"]["sockopt"]["interface"]
                    .as_str()
                    .unwrap_or("")
                    .is_empty()))
            || ["blackhole", "block", "loopback", "dns"]
                .contains(&outbound["protocol"].as_str().unwrap_or(""))
        {
            continue;
        }
        let local = crate::loopback::local_peer(outbound);
        if !outbound["streamSettings"].is_object() {
            outbound["streamSettings"] = json!({});
        }
        if !outbound["streamSettings"]["sockopt"].is_object() {
            outbound["streamSettings"]["sockopt"] = json!({});
        }
        let options = &mut outbound["streamSettings"]["sockopt"];
        if local || options["interface"].as_str().unwrap_or("").is_empty() {
            options["interface"] = json!(if local { loopback } else { uplink });
        }
        if options["domainStrategy"].as_str().unwrap_or("AsIs") == "AsIs" {
            options["domainStrategy"] = json!("ForceIP");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automatic_direct_has_a_physical_path_without_changing_remote_proxy_defaults() {
        let proxy = json!({"tag":"proxy","protocol":"vless","settings":{"address":"192.0.2.9","port":443,"id":"fixture"}});
        let fixed = json!({"tag":"vpn-direct","protocol":"freedom","streamSettings":{"sockopt":{"interface":"OpenVPN"}}});
        let mut config = json!({"outbounds":[{"tag":"direct","protocol":"freedom"},proxy,fixed]});
        assert!(needs_direct_binding(&config));
        bind_direct(&mut config, "Ethernet", "Loopback").unwrap();
        assert_eq!(config["outbounds"][1], proxy);
        assert_eq!(config["outbounds"][2], fixed);
        assert_eq!(config["outbounds"].as_array().unwrap().len(), 3);
        assert_eq!(
            config["outbounds"][0]["streamSettings"]["sockopt"]["interface"],
            "Ethernet"
        );
    }
    #[test]
    fn direct_only_without_automatic_direct_does_not_require_a_physical_route() {
        let mut config = json!({"outbounds":[{"protocol":"freedom","streamSettings":{"sockopt":{"interface":"Chosen VPN"}}},{"protocol":"blackhole"}]});
        assert!(!needs_direct_binding(&config));
        let original = config.clone();
        bind_direct(&mut config, "unused", "Loopback").unwrap();
        assert_eq!(config, original);
    }
    #[test]
    fn explicit_bindings_chains_and_redirects_keep_their_semantics() {
        for extra in [
            json!({"streamSettings":{"sockopt":{"interface":"Chosen"}}}),
            json!({"streamSettings":{"sockopt":{"dialerProxy":"next"}}}),
            json!({"proxySettings":{"tag":"next"}}),
            json!({"settings":{"redirect":"192.0.2.2:53"}}),
        ] {
            let mut outbound = json!({"tag":"direct","protocol":"freedom"});
            outbound
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let mut config = json!({"outbounds":[outbound],"routing":{"rules":[]}});
            bind(&mut config, "Ethernet", "Loopback").unwrap();
            let actual = &config["outbounds"][0];
            assert_eq!(actual["settings"], extra["settings"]);
            assert_eq!(actual["proxySettings"], extra["proxySettings"]);
            assert_eq!(
                actual["streamSettings"]["sockopt"]["dialerProxy"],
                extra["streamSettings"]["sockopt"]["dialerProxy"]
            );
            assert_eq!(
                actual["streamSettings"]["sockopt"]["interface"],
                extra["streamSettings"]["sockopt"]["interface"]
                    .as_str()
                    .unwrap_or("Ethernet")
            );
        }
    }
    #[test]
    fn local_fixed_peers_bind_loopback_in_both_native_forms() {
        for settings in [
            json!({"address":"127.0.0.1"}),
            json!({"servers":[{"address":"::1"}]}),
            json!({"vnext":[{"address":"localhost"}]}),
        ] {
            let mut config = json!({"outbounds":[{"tag":"hop","protocol":"socks","settings":settings}],"routing":{"rules":[]}});
            bind(&mut config, "Ethernet", "Loopback").unwrap();
            assert_eq!(
                config["outbounds"][0]["streamSettings"]["sockopt"]["interface"],
                "Loopback"
            );
        }
    }
}
