//! One Xray-owned FakeDNS mapping table shared by the restricted routing cores.
//! The previous authority stays alive until the whole activation commits. Maps
//! survive compatible Apply/restart and rollback; explicit Stop drops its job.
use crate::native::{self, CoreIdentity, CoreProcess};
use serde_json::{json, Value};
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
mod health;
mod usage;
pub(crate) use usage::Usage;

pub(crate) struct Pool {
    monitor: health::Monitor,
    process: CoreProcess,
    specification: Value,
    endpoint: String,
    pools: Value,
}

fn specification(config: &Value) -> Option<Value> {
    let tun = config["inbounds"]
        .as_array()
        .is_some_and(|a| a.iter().any(|i| i["protocol"] == "tun"));
    let resolver = config["dns"]["servers"].as_array().is_some_and(|servers| {
        servers.iter().any(|server| {
            server
                .as_str()
                .or_else(|| server["address"].as_str())
                .is_some_and(|a| a.eq_ignore_ascii_case("fakedns"))
        })
    });
    let pools = config.get("fakedns").filter(|p| !p.is_null());
    if !tun || pools.is_none() && !resolver {
        return None;
    }
    if let Some(pools) = pools {
        return Some(json!({"fakedns":pools}));
    }
    let mut result = json!({"dns":{"servers":["fakedns"]}});
    if let Some(strategy) = config["dns"].get("queryStrategy") {
        result["dns"]["queryStrategy"] = strategy.clone();
    }
    Some(result)
}

fn failure(message: impl Into<String>) -> ApiError {
    ApiError::new("FAKEDNS_UNAVAILABLE", message)
}

pub(crate) fn valid_endpoint(endpoint: &str) -> bool {
    let Some((address, secret)) = endpoint.rsplit_once(':') else {
        return false;
    };
    address
        .parse::<SocketAddr>()
        .is_ok_and(|a| a.ip() == Ipv4Addr::LOCALHOST && a.port() != 0)
        && secret.len() == 64
        && secret.bytes().all(|b| b.is_ascii_hexdigit())
}

fn readiness(line: &str, secret: &str) -> Option<(String, Value)> {
    let ready: Value = serde_json::from_str(line).ok()?;
    let address = ready["wayrillFakeDNSReady"].as_str()?;
    let endpoint = format!("{address}:{secret}");
    let pools = ready.get("pools")?.clone();
    valid_endpoint(&endpoint).then_some((endpoint, pools))
}

pub(crate) fn prepare(
    previous: Option<&Arc<Pool>>,
    config: &Value,
    service: &Path,
    identity: CoreIdentity<'_>,
) -> Result<Option<Arc<Pool>>> {
    let Some(specification) = specification(config) else {
        return Ok(None);
    };
    if let Some(previous) =
        previous.filter(|pool| pool.specification == specification && pool.check().is_ok())
    {
        return Ok(Some(previous.clone()));
    }
    let secret = crate::tun::random_id()? + &crate::tun::random_id()?;
    let executable = crate::tun::worker_executable(service)?;
    let process = native::spawn_with_token(
        &executable,
        identity.token()?,
        &json!({"address":"127.0.0.1:0","secret":secret,"config":specification}),
        "wayrill-fakedns",
        None,
        0,
    )?;
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        if process.exit_code()?.is_some() {
            return Err(failure(
                "The shared Xray FakeDNS pool exited during startup.",
            ));
        }
        let ready = process
            .lines
            .lock()
            .unwrap()
            .iter()
            .find_map(|line| readiness(line, &secret));
        if let Some((endpoint, pools)) = ready {
            let monitor = health::Monitor::start(&endpoint, &pools)?;
            let pool = Arc::new(Pool {
                monitor,
                process,
                specification,
                endpoint,
                pools,
            });
            return Ok(Some(pool));
        }
        if Instant::now() >= deadline {
            return Err(failure(
                "The shared Xray FakeDNS pool did not become ready.",
            ));
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

impl Pool {
    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }
    pub(crate) fn pid(&self) -> u32 {
        self.process.pid
    }
    pub(crate) fn usage(&self) -> Option<Usage> {
        self.monitor.usage()
    }
    pub(crate) fn check(&self) -> Result<()> {
        if self.process.exit_code()?.is_some() {
            return Err(failure(
                "The shared Xray FakeDNS pool exited. Automatic routing recovery is pending.",
            ));
        }
        self.monitor.check()
    }
    pub(crate) fn instrument(&self, config: &mut Value) -> Result<()> {
        instrument(config, &self.pools)
    }
}

fn prefixes(pools: &Value) -> Result<Vec<String>> {
    let rows = pools
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![pools.clone()]);
    if rows.is_empty() {
        return Err(failure("Invalid shared FakeDNS pool count."));
    }
    rows.iter()
        .map(|row| {
            let prefix = row["ipPool"]
                .as_str()
                .ok_or_else(|| failure("Missing FakeDNS pool prefix."))?;
            prefix
                .parse::<ipnet::IpNet>()
                .map(|network| network.trunc().to_string())
                .map_err(|_| failure("Invalid FakeDNS pool prefix."))
        })
        .collect()
}

fn instrument(config: &mut Value, pools: &Value) -> Result<()> {
    let prefixes = prefixes(pools)?;
    let block = format!(
        "{}wr-fakedns-unresolved",
        crate::loopback::private_prefix(config)?
    );
    let tags: Vec<String> = config["outbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o["tag"].as_str().map(str::to_owned))
        .collect();
    if let Some(groups) = config["routing"]["balancers"].as_array_mut() {
        for group in groups {
            crate::loopback::freeze(group, "selector", &tags, &format!("{block}-no-candidate"));
        }
    }
    for name in ["observatory", "burstObservatory"] {
        if let Some(observer) = config.get_mut(name) {
            crate::loopback::freeze(
                observer,
                "subjectSelector",
                &tags,
                &format!("{block}-no-candidate"),
            );
        }
    }
    config["fakedns"] = pools.clone();
    let outbounds = config["outbounds"]
        .as_array_mut()
        .ok_or_else(|| failure("Missing FakeDNS routing outbounds."))?;
    if outbounds.iter().any(|o| o["tag"] == block) {
        return Err(failure(
            "A reserved FakeDNS outbound tag is already in use.",
        ));
    }
    outbounds.push(json!({"tag":block,"protocol":"blackhole","settings":{}}));
    if !config["routing"].is_object() {
        config["routing"] = json!({});
    }
    if !config["routing"]["rules"].is_array() {
        config["routing"]["rules"] = json!([]);
    }
    // Native FakeDNS sniffing rewrites valid mappings before routing. Only
    // unresolved synthetic destinations reach this guard, including IPC failure.
    config["routing"]["rules"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({"type":"field","ip":prefixes,"outboundTag":block}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_tun_with_native_fakedns_uses_the_shared_pool() {
        let mut c = json!({"inbounds":[{"protocol":"tun"}],"dns":{"servers":[{"address":"FakeDNS","domains":["domain:example.org"]}],"queryStrategy":"UseIPv4"}});
        assert_eq!(
            specification(&c).unwrap(),
            json!({"dns":{"servers":["fakedns"],"queryStrategy":"UseIPv4"}})
        );
        c["inbounds"][0]["protocol"] = json!("socks");
        assert!(specification(&c).is_none());
        c["inbounds"][0]["protocol"] = json!("tun");
        c["dns"]["servers"] = json!(["1.1.1.1"]);
        assert!(specification(&c).is_none());
        c["fakedns"] = json!({"ipPool":"198.18.0.0/24","poolSize":100});
        assert!(specification(&c).is_some());
    }
    #[test]
    fn endpoint_is_fixed_loopback_with_a_private_credential() {
        assert!(valid_endpoint(&format!(
            "127.0.0.1:12345:{}",
            "a".repeat(64)
        )));
        for host in [
            "0.0.0.0:12345",
            "127.0.0.2:12345",
            "[::1]:12345",
            "127.0.0.1:0",
        ] {
            assert!(!valid_endpoint(&format!("{host}:{}", "a".repeat(64))));
        }
        assert!(!valid_endpoint("127.0.0.1:12345:secret"));
    }
    #[test]
    fn unresolved_fake_ips_have_a_block_target_and_saved_rules_are_preserved() {
        let original = json!({"inbounds":[],"outbounds":[{"tag":"direct","protocol":"freedom"}],"routing":{"rules":[{"type":"field","domain":["full:blocked.example"],"outboundTag":"block"}]}});
        let mut runtime = original.clone();
        let pools = json!([{"ipPool":"198.18.0.0/24","poolSize":128},{"ipPool":"2001:2::/120","poolSize":128}]);
        instrument(&mut runtime, &pools).unwrap();
        assert_eq!(runtime["fakedns"], pools);
        assert!(runtime["routing"]["rules"][0]["outboundTag"]
            .as_str()
            .unwrap()
            .ends_with("wr-fakedns-unresolved"));
        assert_eq!(
            runtime["routing"]["rules"][1],
            original["routing"]["rules"][0]
        );
        assert_eq!(runtime["outbounds"][1]["protocol"], "blackhole");
        assert!(original.get("fakedns").is_none());
    }
    #[test]
    fn policy_groups_and_observers_never_select_the_synthetic_ip_guard() {
        let mut c = json!({"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"wayrill-user","protocol":"freedom"}],"routing":{"balancers":[{"tag":"all","selector":[""]}],"rules":[]},"observatory":{"subjectSelector":[""]}});
        let pools = json!({"ipPool":"198.18.0.0/24","poolSize":128});
        instrument(&mut c, &pools).unwrap();
        let block = c["routing"]["rules"][0]["outboundTag"].as_str().unwrap();
        for selectors in [
            &c["routing"]["balancers"][0]["selector"],
            &c["observatory"]["subjectSelector"],
        ] {
            assert!(selectors
                .as_array()
                .unwrap()
                .iter()
                .all(|prefix| !block.starts_with(prefix.as_str().unwrap())));
        }
        let mut next = json!({"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"wayrill-user","protocol":"freedom"}],"routing":{"rules":[]}});
        instrument(&mut next, &pools).unwrap();
        assert_eq!(
            next["routing"]["rules"][0]["outboundTag"],
            c["routing"]["rules"][0]["outboundTag"]
        );
    }
    #[test]
    fn explicit_pools_do_not_restart_when_only_resolver_strategy_changes() {
        let mut a = json!({"inbounds":[{"protocol":"tun"}],"fakedns":{"ipPool":"198.18.0.0/24","poolSize":128},"dns":{"queryStrategy":"UseIP"}});
        let original = specification(&a);
        a["dns"]["queryStrategy"] = json!("UseIPv4");
        assert_eq!(specification(&a), original);
    }

    #[test]
    fn readiness_uses_the_authority_bound_port_and_rejects_other_frames() {
        let secret = "a".repeat(64);
        let pools = json!({"ipPool":"198.18.0.0/24","poolSize":128});
        assert_eq!(
            readiness(
                &json!({"wayrillFakeDNSReady":"127.0.0.1:12345","pools":pools}).to_string(),
                &secret
            ),
            Some((format!("127.0.0.1:12345:{secret}"), pools))
        );
        for line in [
            "not JSON",
            r#"{"address":"127.0.0.1:12345"}"#,
            r#"{"wayrillFakeDNSReady":"127.0.0.1:0"}"#,
            r#"{"wayrillFakeDNSReady":"0.0.0.0:12345"}"#,
        ] {
            assert!(readiness(line, &secret).is_none());
        }
    }

    #[test]
    fn pool_prefixes_follow_xray_network_normalization() {
        assert_eq!(
            prefixes(&json!([
                {"ipPool":"198.18.1.9/24"}, {"ipPool":"2001:2::9/120"}
            ]))
            .unwrap(),
            ["198.18.1.0/24", "2001:2::/120"]
        );
        for prefix in ["bad", "198.18.0.0/33", "2001:2::/129"] {
            assert!(prefixes(&json!({"ipPool":prefix})).is_err());
        }
    }
    #[test]
    fn null_pool_section_keeps_native_automatic_or_disabled_behavior() {
        let mut c =
            json!({"inbounds":[{"protocol":"tun"}],"fakedns":null,"dns":{"servers":["fakedns"]}});
        assert_eq!(
            specification(&c),
            Some(json!({"dns":{"servers":["fakedns"]}}))
        );
        c["dns"]["servers"] = json!(["1.1.1.1"]);
        assert!(specification(&c).is_none());
    }
}
