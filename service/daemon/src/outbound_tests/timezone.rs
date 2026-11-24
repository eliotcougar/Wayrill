//! Measure a saved outbound through an isolated, bound probe.
use super::{Job, Manager};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
use wayrill_protocol::{
    companion::{Policy, TimezoneSelection},
    ApiError, Result,
};

pub(super) struct Probe {
    pub(super) job: Job,
    revision: u64,
    selection: Option<TimezoneSelection>,
    name: Option<String>,
    started: Instant,
}

impl Manager {
    pub(crate) fn remember_timezone_probe(
        &mut self,
        revision: u64,
        selection: Option<TimezoneSelection>,
        name: Option<String>,
    ) {
        self.last_timezone = Some(Probe {
            job: self.current.clone(),
            revision,
            selection,
            name,
            started: Instant::now(),
        });
    }

    pub(crate) fn resolve_timezone_policy(
        &self,
        mut policy: Policy,
        revision: u64,
        job: Option<u64>,
    ) -> Result<Policy> {
        if !matches!(policy.mode.as_str(), "main" | "custom") {
            return Ok(policy);
        }
        let stale = || {
            ApiError::new(
                "CONFIG_CHANGED",
                "The outbound timezone lookup has changed or expired. Run the lookup again.",
            )
        };
        let probe = self
            .last_timezone
            .as_ref()
            .filter(|probe| {
                probe.revision == revision
                    && probe.selection == policy.selection
                    && probe.selection.is_some() == (policy.mode == "custom")
                    && probe.started.elapsed() < Duration::from_secs(180)
            })
            .ok_or_else(stale)?;
        let state = probe.job.state.lock().unwrap();
        if state.phase.busy() || job.is_some_and(|id| id != state.job) {
            return Err(stale());
        }
        let Some(result) = state.results.first() else {
            return Err(stale());
        };
        // Signed Companion clients return the probed IP instead of a job ID.
        // Persist the service's result, including its zone rather than an alias
        // canonicalized by a particular browser.
        if result.ip.is_none() || policy.ip != result.ip {
            return Err(stale());
        }
        policy.zone = result.timezone.clone().ok_or_else(stale)?;
        policy.ip = result.ip.clone();
        policy.name = result.name.clone().or_else(|| probe.name.clone());
        Ok(policy)
    }
}

pub(crate) fn input(config: &Value, source: Option<&str>) -> Result<(Value, String, String)> {
    let graph: Value = serde_json::from_str(source.ok_or_else(|| {
        ApiError::new(
            "MAIN_UNAVAILABLE",
            "Apply a graph with a Main outbound first.",
        )
    })?)
    .map_err(|_| ApiError::new("MAIN_UNAVAILABLE", "Cannot read the applied Main outbound."))?;
    let node = graph["nodes"]
        .as_array()
        .and_then(|nodes| {
            nodes
                .iter()
                .find(|node| node["id"] == graph["mainOutboundId"] && node["id"].is_string())
        })
        .ok_or_else(|| {
            ApiError::new(
                "MAIN_UNAVAILABLE",
                "Mark an outbound as Main and apply the graph first.",
            )
        })?;
    let tag = node["data"]["settings"]["tag"]
        .as_str()
        .filter(|tag| !tag.is_empty())
        .ok_or_else(|| {
            ApiError::new("MAIN_UNAVAILABLE", "The applied Main outbound has no tag.")
        })?;
    let name = node["data"]["label"].as_str().unwrap_or(tag).to_owned();
    let mut fragment = config.clone();
    fragment
        .as_object_mut()
        .ok_or_else(|| ApiError::new("MAIN_UNAVAILABLE", "No applied configuration."))?
        .retain(|key, _| {
            [
                "outbounds",
                "routing",
                "dns",
                "fakedns",
                "observatory",
                "burstObservatory",
                "policy",
                "env",
            ]
            .contains(&key.as_str())
        });
    let mut tags: BTreeSet<String> = fragment["outbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            fragment["routing"]["balancers"]
                .as_array()
                .into_iter()
                .flatten(),
        )
        .filter_map(|item| item["tag"].as_str().map(str::to_owned))
        .collect();
    let is_group = node["data"]["kind"] == "policy-group";
    let collection = if is_group {
        &fragment["routing"]["balancers"]
    } else {
        &fragment["outbounds"]
    };
    if !collection
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["tag"] == tag))
    {
        return Err(ApiError::new(
            "MAIN_UNAVAILABLE",
            "The applied Main outbound is unavailable.",
        ));
    }
    if let Some(rules) = fragment["routing"]["rules"].as_array_mut() {
        rules.retain(|rule| {
            rule["outboundTag"]
                .as_str()
                .or_else(|| rule["balancerTag"].as_str())
                .is_some_and(|target| tags.contains(target))
        });
    }
    let mut target = tag.to_owned();
    if is_group {
        target = "wctz".into();
        while tags.contains(&target) {
            target.push('x');
        }
        tags.insert(target.clone());
        fragment["outbounds"]
            .as_array_mut()
            .unwrap()
            .push(json!({"tag":target,"protocol":"loopback","settings":{"inboundTag":target}}));
        let rules = fragment["routing"]["rules"]
            .as_array_mut()
            .ok_or_else(|| ApiError::new("MAIN_UNAVAILABLE", "Missing Main policy routing."))?;
        rules.insert(
            0,
            json!({"type":"field","inboundTag":[target],"balancerTag":tag}),
        );
    }
    Ok((
        json!({"mode":"timezone","testUrl":"https://ipwho.is/","countryUrl":"","targets":[{"id":"companion-main","config":fragment,"outboundTag":target}]}),
        tag.into(),
        name,
    ))
}

pub(crate) fn response(bytes: &[u8]) -> Result<String> {
    let data: Value = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::new("TIMEZONE_UNAVAILABLE", "Invalid exit lookup response."))?;
    data["timezone"]["id"]
        .as_str()
        .filter(|zone| {
            !zone.is_empty()
                && zone.len() <= 128
                && zone
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"/_+-".contains(&c))
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::new(
                "TIMEZONE_UNAVAILABLE",
                "Exit lookup did not return an IANA timezone.",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timezone_policy_uses_the_completed_probe_only_for_its_configuration() {
        let mut manager = Manager::new();
        let mut result = super::super::failed("main".into(), "");
        result.error = None;
        result.ip = Some("192.0.2.1".into());
        result.timezone = Some("Europe/Berlin".into());
        {
            let mut state = manager.current.state.lock().unwrap();
            state.job = 42;
            state.results.push(result);
        }
        manager.remember_timezone_probe(7, None, Some("Main".into()));
        // An unrelated speed test may occupy the current job after the lookup.
        manager.current = Job::default();
        let policy = Policy {
            mode: "main".into(),
            zone: "UTC".into(),
            ip: Some("192.0.2.1".into()),
            ..Policy::default()
        };
        for job in [None, Some(42)] {
            let resolved = manager
                .resolve_timezone_policy(policy.clone(), 7, job)
                .unwrap();
            assert_eq!(resolved.zone, "Europe/Berlin");
            assert_eq!(resolved.name.as_deref(), Some("Main"));
        }
        for (revision, job) in [(8, Some(42)), (7, Some(43))] {
            assert!(matches!(
                manager.resolve_timezone_policy(policy.clone(), revision, job),
                Err(error) if error.code == "CONFIG_CHANGED"
            ));
        }
        let mut different_ip = policy;
        different_ip.ip = Some("192.0.2.2".into());
        assert!(manager
            .resolve_timezone_policy(different_ip, 7, None)
            .is_err());
    }

    #[test]
    fn main_probe_is_pinned_and_never_exposes_or_keeps_capture_or_api_listeners() {
        let config = json!({"api":{"tag":"admin"},"inbounds":[{"port":123}],"outbounds":[{"tag":"direct","protocol":"freedom"}],"routing":{"rules":[{"inboundTag":["admin"],"outboundTag":"admin"}],"balancers":[{"tag":"main","selector":["direct"]}]}});
        let source = json!({"mainOutboundId":"group","nodes":[{"id":"group","data":{"kind":"policy-group","label":"Main","settings":{"tag":"main"}}}]}).to_string();
        let (probe, tag, _) = input(&config, Some(&source)).unwrap();
        assert_eq!(tag, "main");
        assert_eq!(probe["targets"][0]["outboundTag"], "wctz");
        assert_eq!(
            probe["targets"][0]["config"]["routing"]["rules"][0]["balancerTag"],
            "main"
        );
        assert!(probe["targets"][0]["config"]["inbounds"].is_null());
        assert!(probe["targets"][0]["config"]["api"].is_null());
        assert!(input(&config, None).is_err());
        assert!(response(br#"{"timezone":{"id":"Europe/Berlin"}}"#).is_ok());
        assert!(response(br#"{"timezone":{"id":"bad\nzone"}}"#).is_err());
    }
}
