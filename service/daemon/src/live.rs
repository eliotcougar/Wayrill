//! Existing commander gRPC API through a private authenticated SOCKS input.
//! No privileged command endpoint is exposed to the frontend or LAN.
use crate::native::{self, CoreIdentity};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
pub(crate) mod selection;

#[derive(Clone)]
pub struct Control {
    pub config: Arc<Value>,
    address: String,
    password: String,
    rule: Value,
}
impl Control {
    pub fn new(config: &Value) -> Result<Self> {
        let socket = crate::sockets::reserve_loopback(config)?;
        let address = socket
            .local_addr()
            .map_err(|e| ApiError::io("Read core control socket", e))?;
        let password = crate::tun::random_id()? + &crate::tun::random_id()?;
        let mut run = config.clone();
        let tag = crate::loopback::private_tag(&run, "control")?;
        let inbound = format!("{tag}-in");
        run["api"] = json!({"tag":tag,"services":["RoutingService"]});
        run["inbounds"].as_array_mut().ok_or_else(||ApiError::new("INVALID_CONFIG","Missing core inputs."))?.push(json!({"tag":inbound,"listen":"127.0.0.1","port":address.port(),"protocol":"socks","settings":{"auth":"password","udp":false,"accounts":[{"user":"wayrill","pass":password}]}}));
        if !run["routing"].is_object() {
            run["routing"] = json!({});
        }
        if !run["routing"]["rules"].is_array() {
            run["routing"]["rules"] = json!([]);
        }
        let rule = json!({"type":"field","inboundTag":[inbound],"outboundTag":tag});
        run["routing"]["rules"]
            .as_array_mut()
            .unwrap()
            .insert(0, rule.clone());
        Ok(Self {
            config: Arc::new(run),
            address: address.to_string(),
            password,
            rule,
        })
    }
    pub fn routing(&self, routing: &Value) -> Value {
        let mut routing = routing.clone();
        if !routing.is_object() {
            routing = json!({});
        }
        if !routing["rules"].is_array() {
            routing["rules"] = json!([]);
        }
        routing["rules"]
            .as_array_mut()
            .unwrap()
            .insert(0, self.rule.clone());
        routing
    }
    pub fn call(
        &self,
        exe: &Path,
        identity: CoreIdentity<'_>,
        routing: Option<&Value>,
    ) -> Result<()> {
        self.request(exe, identity, routing, false)
    }
    pub fn prepare(&self, exe: &Path, identity: CoreIdentity<'_>, routing: &Value) -> Result<()> {
        self.request(exe, identity, Some(routing), true)
    }
    fn request(
        &self,
        exe: &Path,
        identity: CoreIdentity<'_>,
        routing: Option<&Value>,
        prepare: bool,
    ) -> Result<()> {
        let worker = crate::tun::worker_executable(exe.parent().unwrap().parent().unwrap())?;
        let core = native::spawn_tun_with_token(
            &worker,
            identity.token()?,
            &json!({"address":self.address,"password":self.password,"routing":routing,"prepare":prepare,"previous":if prepare {Some(&self.config["routing"])} else {None}}),
            "wayrill-control",
            None,
            0,
            native::TunOptions {
                metadata: None,
                fakedns: None,
                reuse_settings: false,
                assets: exe.parent().unwrap(),
            },
        )?;
        let deadline = Instant::now() + Duration::from_secs(7);
        loop {
            if let Some(code) = core.exit_code()? {
                return if code == 0 {
                    Ok(())
                } else if code == 2 {
                    Err(ApiError::new(
                        "LIVE_UNSUPPORTED",
                        "The routing table exceeds the Xray API message limit.",
                    ))
                } else {
                    Err(ApiError::new(
                        "LIVE_UPDATE",
                        "Xray routing control failed; configuration recovery is required.",
                    ))
                };
            }
            if Instant::now() >= deadline {
                return Err(ApiError::new(
                    "LIVE_UPDATE",
                    "Xray routing control timed out; its result is uncertain.",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn commit(&mut self, routing: Value) {
        Arc::make_mut(&mut self.config)["routing"] = routing;
    }
}
pub fn same_except_adapter_names(a: &Value, b: &Value) -> bool {
    let normalize = |value: &Value| {
        let mut value = value.clone();
        for input in value["inbounds"].as_array_mut().into_iter().flatten() {
            if input["protocol"] == "tun" {
                if let Some(settings) = input["settings"].as_object_mut() {
                    settings.remove("name");
                }
            }
        }
        value
    };
    a != b && normalize(a) == normalize(b)
}
/// Background refresh may change only outbound definitions, their generated
/// routing tables and required observation features/membership. Existing probe
/// settings remain explicit. Listener/DNS/system changes are
/// always explicit graph Apply operations.
pub fn target_refresh(a: &Value, b: &Value) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    for value in [&mut a, &mut b] {
        let Some(object) = value.as_object_mut() else {
            return false;
        };
        object.remove("outbounds");
        if let Some(routing) = object.get_mut("routing").and_then(Value::as_object_mut) {
            routing.remove("rules");
            routing.remove("balancers");
        }
    }
    for key in ["observatory", "burstObservatory"] {
        // A newly introduced/retired observed policy changes its root feature.
        // Existing shared observers keep their probe settings; only membership
        // may follow an automatic pool update.
        if a.get(key).is_none() || b.get(key).is_none() {
            a.as_object_mut().unwrap().remove(key);
            b.as_object_mut().unwrap().remove(key);
        } else {
            for value in [&mut a, &mut b] {
                if let Some(observer) = value.get_mut(key).and_then(Value::as_object_mut) {
                    observer.remove("subjectSelector");
                }
            }
        }
    }
    a == b
}
pub fn same_except_rules(a: &Value, b: &Value) -> bool {
    fn same(
        a: &serde_json::Map<String, Value>,
        b: &serde_json::Map<String, Value>,
        skip: &str,
    ) -> bool {
        a.iter().filter(|(k, _)| *k != skip).count() == b.iter().filter(|(k, _)| *k != skip).count()
            && a.iter()
                .filter(|(k, _)| *k != skip)
                .all(|(k, v)| b.get(k) == Some(v))
    }
    let (Some(ar), Some(br)) = (a.as_object(), b.as_object()) else {
        return false;
    };
    if !same(ar, br, "routing") {
        return false;
    }
    if !matches!(a["routing"], Value::Null | Value::Object(_))
        || !matches!(b["routing"], Value::Null | Value::Object(_))
    {
        return false;
    }
    let empty = serde_json::Map::new();
    same(
        a["routing"].as_object().unwrap_or(&empty),
        b["routing"].as_object().unwrap_or(&empty),
        "rules",
    ) && same_dns_routes(a, b)
}
// RoutingService cannot retire DNS clients' cached UDP dispatcher sessions.
// Reload the core if a changed rule can affect a routed resolver; otherwise a
// newly selected Block or proxy would not take effect for its next requests.
fn same_dns_routes(a: &Value, b: &Value) -> bool {
    let tags: Vec<_> = a["dns"]["servers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|server| {
            let address = server.as_str().or_else(|| server["address"].as_str())?;
            if address == "localhost"
                || address == "fakedns"
                || address.contains("+local://")
                || address.starts_with("wayrill-dns://127.0.0.1:")
            {
                return None;
            }
            Some(
                server["tag"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| a["dns"]["tag"].as_str())
                    .unwrap_or(""),
            )
        })
        .collect();
    if tags.is_empty() {
        return true;
    }
    let relevant = |config: &Value| {
        config["routing"]["rules"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|rule| {
                rule["inboundTag"].as_array().is_none_or(|inputs| {
                    inputs.is_empty()
                        || inputs
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|tag| tags.contains(&tag))
                })
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    relevant(a) == relevant(b)
}
pub fn main_routing(
    protected: &Value,
    local_rules: &[Value],
    relays: Vec<Value>,
    next: &Value,
    current: &Value,
) -> Value {
    let mut routing = next["routing"].clone();
    if !routing.is_object() {
        routing = json!({});
    }
    // Rule-only updates retain the same transport handlers. Their private
    // scopes and frozen policy selectors must survive every Apply/rollback.
    if let Some(balancers) = current["routing"].get("balancers") {
        routing["balancers"] = balancers.clone();
    }
    let mut rules = vec![protected.clone()];
    rules.extend_from_slice(local_rules);
    rules.extend(relays);
    rules.extend(routing["rules"].as_array().cloned().unwrap_or_default());
    routing["rules"] = json!(rules);
    routing
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn name_only_apply_does_not_include_routing_peers_or_geometry_edits() {
        let old = json!({"inbounds":[{"protocol":"tun","settings":{"name":"Owned","gateway":["10.90.0.1/24"]}}],"outbounds":[{"protocol":"freedom","tag":"direct"}],"routing":{"rules":[]}});
        let mut next = old.clone();
        next["inbounds"][0]["settings"]["name"] = json!("Renamed");
        assert!(same_except_adapter_names(&old, &next));
        assert!(!same_except_adapter_names(&old, &old));
        next["routing"]["rules"] = json!([{"outboundTag":"direct"}]);
        assert!(!same_except_adapter_names(&old, &next));
        next = old.clone();
        next["inbounds"][0]["settings"]["gateway"] = json!(["10.91.0.1/24"]);
        assert!(!same_except_adapter_names(&old, &next));
    }
    #[test]
    fn universal_groups_do_not_select_private_metrics_or_control_handlers() {
        let mut config = json!({"inbounds":[{"tag":"input","listen":"127.0.0.1","port":27941,"protocol":"socks","settings":{}}],"outbounds":[{"tag":"wayrill-peer","protocol":"freedom"}],"routing":{"balancers":[{"tag":"all","selector":[""]}],"rules":[]}});
        crate::loopback::Policy::apply(&mut config, "Loopback").unwrap();
        let bridge = crate::traffic::Bridge::new(&config).unwrap();
        let control = Control::new(&bridge.config).unwrap();
        let prefixes = control.config["routing"]["balancers"][0]["selector"]
            .as_array()
            .unwrap();
        for private in [
            control.config["metrics"]["tag"].as_str().unwrap(),
            control.config["api"]["tag"].as_str().unwrap(),
        ] {
            assert!(prefixes
                .iter()
                .all(|prefix| !private.starts_with(prefix.as_str().unwrap())));
        }
        assert_eq!(prefixes, &vec![json!("w")]);
    }
    #[test]
    fn only_dns_transport_rule_changes_reload_cached_resolver_sessions() {
        let a = json!({"dns":{"tag":"dns-main","servers":[{"address":"127.0.0.1","tag":"dns-local"},"tcp://192.0.2.1"]},"routing":{"rules":[{"inboundTag":["traffic"],"outboundTag":"proxy"},{"inboundTag":["dns-local"],"outboundTag":"proxy"},{"inboundTag":["dns-main"],"outboundTag":"proxy"}]}});
        let mut b = a.clone();
        b["routing"]["rules"][0]["outboundTag"] = json!("block");
        assert!(same_except_rules(&a, &b));
        for index in [1, 2] {
            let mut b = a.clone();
            b["routing"]["rules"][index]["outboundTag"] = json!("block");
            assert!(!same_except_rules(&a, &b));
        }
        let mut b = a.clone();
        b["routing"]["rules"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!({"outboundTag":"block"}));
        assert!(!same_except_rules(&a, &b));
        for address in [
            "localhost",
            "tcp+local://127.0.0.1:53",
            "wayrill-dns://127.0.0.1:54321",
            "https+local://dns.example/query",
        ] {
            let mut a = a.clone();
            a["dns"]["servers"] = json!([address]);
            assert!(same_dns_routes(&a, &b));
        }
    }
    #[test]
    fn rule_apply_retains_local_scopes_and_frozen_candidates() {
        let mut current = json!({"inbounds":[],"outbounds":[{"tag":"proxy","protocol":"freedom"}],"routing":{"balancers":[{"tag":"pool","selector":[""]}],"rules":[]}});
        let policy = crate::loopback::Policy::apply(&mut current, "Loopback").unwrap();
        let next = json!({"routing":{"balancers":[{"tag":"pool","selector":[""]}],"rules":[{"ip":["127.0.0.1"],"outboundTag":"deny"}]}});
        let protected = json!({"inboundTag":["telemetry"],"outboundTag":"metrics"});
        let relay = json!({"inboundTag":["tun-relay"],"outboundTag":"proxy"});
        let routing = main_routing(
            &protected,
            policy.rules(),
            vec![relay.clone()],
            &next,
            &current,
        );
        let rules = routing["rules"].as_array().unwrap();
        assert_eq!(rules[0], protected);
        assert_eq!(&rules[1..1 + policy.rules().len()], policy.rules());
        assert_eq!(rules[rules.len() - 2], relay);
        assert_eq!(rules.last().unwrap()["outboundTag"], "deny");
        assert_eq!(routing["balancers"][0]["selector"], json!(["p"]));
    }
    #[test]
    fn limits_live_changes_to_rules() {
        let a = json!({"inbounds":[],"outbounds":[],"routing":{"rules":[]}});
        let mut b = a.clone();
        b["routing"]["rules"] = json!([{"outboundTag":"direct"}]);
        assert!(same_except_rules(&a, &b));
        for field in ["domainStrategy", "balancers"] {
            b["routing"][field] = json!("changed");
            assert!(!same_except_rules(&a, &b));
            b["routing"].as_object_mut().unwrap().remove(field);
        }
        b["dns"] = json!({});
        assert!(!same_except_rules(&a, &b));
    }
    #[test]
    fn protects_control_before_user_catch_all() {
        let c =
            Control::new(&json!({"inbounds":[],"outbounds":[],"routing":{"rules":[]}})).unwrap();
        let r = c.routing(&json!({"rules":[{"network":"tcp,udp","outboundTag":"block"}]}));
        assert_eq!(r["rules"][0], c.rule);
        assert_eq!(r["rules"][1]["outboundTag"], "block");
        assert!(c.config["api"].get("listen").is_none());
        assert_eq!(c.config["api"]["services"], json!(["RoutingService"]));
        assert_eq!(
            c.config["inbounds"][0]["settings"]["accounts"][0]["pass"],
            c.password
        );
    }
}

#[cfg(test)]
mod outbound_tests {
    use super::*;
    #[test]
    fn replacing_a_plain_outbound_with_an_observed_group_can_add_or_remove_its_observer() {
        let plain = json!({"inbounds":[],"outbounds":[{"tag":"proxy","protocol":"socks"}],"routing":{"rules":[]}});
        for key in ["observatory", "burstObservatory"] {
            let mut group = plain.clone();
            group["outbounds"][0]["tag"] = json!("candidate");
            group["routing"]["balancers"] =
                json!([{"tag":"proxy","selector":["candidate"],"strategy":{"type":"leastPing"}}]);
            group[key] = json!({"subjectSelector":["candidate"],"probeURL":"https://www.gstatic.com/generate_204"});
            assert!(target_refresh(&plain, &group), "cannot introduce {key}");
            assert!(target_refresh(&group, &plain), "cannot retire {key}");
            group["dns"] = json!({"servers":["1.1.1.1"]});
            assert!(!target_refresh(&plain, &group));
        }
    }
    #[test]
    fn outbound_refresh_requires_restart_and_excludes_listener_or_dns_changes() {
        let old = json!({"inbounds":[],"outbounds":[{"tag":"proxy","protocol":"socks","settings":{"address":"192.0.2.1","port":1080}},{"tag":"dns","protocol":"dns"}],"dns":{"servers":["localhost"]},"routing":{"rules":[{"network":"tcp,udp","outboundTag":"proxy"}]}});
        let mut next = old.clone();
        next["outbounds"][0]["settings"]["port"] = json!(2080);
        assert!(!same_except_rules(&old, &next));
        assert!(target_refresh(&old, &next));
        next["inbounds"] = json!([{"tag":"other"}]);
        assert!(!target_refresh(&old, &next));
        next["inbounds"] = json!([]);
        next["dns"]["servers"] = json!(["1.1.1.1"]);
        assert!(!target_refresh(&old, &next));
        next["dns"] = old["dns"].clone();
        next["outbounds"][0]["protocol"] = json!("freedom");
        assert!(!same_except_rules(&old, &next));
        assert!(target_refresh(&old, &next));
    }
    #[test]
    fn only_observation_membership_can_change_in_background() {
        let a = json!({"outbounds":[],"observatory":{"subjectSelector":["old"],"probeInterval":"1m"},"routing":{"rules":[],"balancers":[]}});
        let mut b = a.clone();
        b["observatory"]["subjectSelector"] = json!(["new"]);
        assert!(target_refresh(&a, &b));
        b["observatory"]["probeInterval"] = json!("5m");
        assert!(!target_refresh(&a, &b));
    }
}
