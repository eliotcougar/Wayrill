//! A compatible Apply replaces packet workers, not their Windows ownership.
//! Keys contain only authored network topology; rules, peers and sniffing live
//! in the replacement worker/core. A healthy live lease is still required.
use super::*;

pub(super) struct Running {
    pub key: Value,
    pub host_settings: Option<Value>,
    pub applications: Option<Value>,
    pub metadata: Option<String>,
    pub uplink: Value,
}

pub(super) fn network_key(config: &Value, capture: Option<&crate::capture::Plan>) -> Value {
    let sharing = capture.and_then(|p| p.tun_sharing.as_ref());
    let mut inputs: Vec<_> = config["inbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["protocol"] == "tun")
        .map(|i| {
            let mut settings = i["settings"].clone();
            if let Some(settings) = settings.as_object_mut() {
                settings.remove("userLevel");
                settings.remove("name");
                // The monitor pins Automatic to an effective alias in runtime
                // copies. Compare the resolved live uplink separately below.
                settings.remove("autoOutboundsInterface");
            }
            json!({"tag":i["tag"],"shared":sharing.is_some_and(|s| i["tag"]==s.tag),"settings":settings})
        })
        .collect();
    inputs.sort_by(|a, b| a["tag"].as_str().cmp(&b["tag"].as_str()));
    let sharing = sharing.map(|options| {
        let mut value = serde_json::to_value(options).unwrap();
        // Direct target selection changes core binding, not the native pair.
        value.as_object_mut().unwrap().remove("upstreamTags");
        value
    });
    json!({"inputs":inputs,"sharing":sharing})
}

pub(super) fn compatible(key: &Value, next: &Value) -> bool {
    key == next
        && key["inputs"].as_array().is_some_and(|inputs| {
            !inputs.is_empty()
                && inputs.iter().all(|i| {
                    i["settings"].is_object()
                        && i["settings"]["autoSystemWfpBlockLeak"]
                            .as_array()
                            .is_none_or(Vec::is_empty)
                })
        })
}

pub(super) fn application_provider(
    service: &Path,
    input: Option<Value>,
    options: Option<&sharing::Options>,
) -> Result<(Option<crate::capture::Worker>, Option<String>)> {
    let mut applications = None;
    let mut endpoint = None;
    if let Some(input) = input {
        let nat_tag = input["natTag"].as_str().map(str::to_owned);
        let mut provider = crate::capture::Worker::spawn_attribution(&service.join("attribution"))?;
        let width = input["predicates"]
            .as_array()
            .ok_or_else(|| invalid("TUN application predicates are missing."))?
            .len()
            .div_ceil(4)
            .max(1);
        let result = provider.call("applications.start", input)?;
        let port = result["port"]
            .as_u64()
            .filter(|p| (1..=65535).contains(p))
            .ok_or_else(|| invalid("Invalid TUN metadata port."))?;
        let secret = result["secret"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
            .ok_or_else(|| invalid("Invalid TUN metadata identity."))?;
        if result["width"].as_u64() != Some(width as u64) {
            return Err(invalid("TUN metadata width mismatch."));
        }
        endpoint = Some(format!("127.0.0.1:{port}:{secret}:{width}"));
        if let Some(tag) = nat_tag {
            if !matches!(tag.as_str(), "wr-n" | "wayrill-runtime-nat")
                || result["natTag"].as_str() != Some(&tag)
            {
                return Err(invalid("Invalid NAT metadata scope."));
            }
            endpoint = endpoint.map(|endpoint| format!("{endpoint}:{tag}"));
        }
        applications = Some(provider);
    }
    if let Some(options) = options.filter(|options| options.ipv6) {
        endpoint = Some(format!(
            "{}|{}/64",
            endpoint.unwrap_or_default(),
            clients::prefix(&options.private_id)
        ));
    }
    Ok((applications, endpoint))
}

impl Manager {
    pub fn can_replace(
        &mut self,
        config: &Value,
        capture: Option<&crate::capture::Plan>,
    ) -> Result<bool> {
        if self.retirement_pending.is_some() {
            return Ok(false);
        }
        let Some(running) = &self.running else {
            return Ok(false);
        };
        if !compatible(&running.key, &network_key(config, capture)) {
            return Ok(false);
        }
        let (host_name, shared_name) = Self::requested_names(config, capture)?;
        if !self.adapters.preferences()?.reuse_adapters
            && (host_name.is_some_and(|name| self.adapter.as_ref().is_some_and(|a| a.name != name))
                || shared_name.is_some_and(|name| {
                    self.keeper
                        .as_ref()
                        .is_some_and(|k| k.adapter_name() != Some(name))
                }))
        {
            return Ok(false);
        }
        if self.adapter_recovery_error.is_some() || self.core.is_none() && self.keeper.is_none() {
            return Ok(false);
        }
        self.poll()?;
        let running = self.running.as_ref().unwrap();
        let Some(uplink) = &self.uplink else {
            return Ok(false);
        };
        let options = capture.and_then(|p| p.tun_sharing.as_ref());
        let host = config["inbounds"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|i| i["protocol"] == "tun" && options.is_none_or(|o| i["tag"] != o.tag));
        let requested = if let Some(host) = host {
            uplink_except(&host["settings"], self.owned_host_index())?
        } else if let Some(options) = options {
            guid_uplink(&options.public_id)?
        } else {
            return Ok(false);
        };
        if &requested != uplink {
            return Ok(false);
        }
        if running.uplink != network::snapshot(uplink)? {
            return Ok(false);
        }
        if let (Some(adapter), Some(settings)) = (&self.adapter, &running.host_settings) {
            if !adapter.identity_ready()? || !configuration::ready(adapter.index, settings)? {
                return Ok(false);
            }
        } else if self.adapter.is_some() || running.host_settings.is_some() {
            return Ok(false);
        }
        if let Some(keeper) = &mut self.keeper {
            if keeper.call("canReplace", json!({}))?["compatible"] != true {
                return Ok(false);
            }
        }
        self.check_names(config, capture)?;
        Ok(true)
    }

    fn requested_names<'a>(
        config: &'a Value,
        capture: Option<&crate::capture::Plan>,
    ) -> Result<(Option<&'a str>, Option<&'a str>)> {
        let sharing = capture.and_then(|p| p.tun_sharing.as_ref());
        let mut names = (None, None);
        for input in config["inbounds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["protocol"] == "tun")
        {
            let shared = sharing.is_some_and(|s| input["tag"] == s.tag);
            let name = adapter_name(&input["settings"], shared)?;
            if shared {
                names.1 = Some(name);
            } else {
                names.0 = Some(name);
            }
        }
        Ok(names)
    }
    pub(crate) fn check_names(
        &mut self,
        config: &Value,
        capture: Option<&crate::capture::Plan>,
    ) -> Result<()> {
        let (host, shared) = Self::requested_names(config, capture)?;
        if let Some(name) = host {
            self.adapter
                .as_ref()
                .ok_or_else(|| invalid("Owned host adapter is missing."))?
                .check_name(name)?;
        }
        if let Some(name) =
            shared.filter(|name| self.keeper.as_ref().and_then(|k| k.adapter_name()) != Some(*name))
        {
            self.keeper
                .as_mut()
                .ok_or_else(|| invalid("Owned sharing keeper is missing."))?
                .call("rename", json!({"name":name,"checkOnly":true}))?;
        }
        Ok(())
    }
    pub(crate) fn rename(
        &mut self,
        config: &Value,
        capture: Option<&crate::capture::Plan>,
    ) -> Result<()> {
        // Preflight both before changing either, then rely on activation rollback
        // for a later native/property/storage failure. No device is enumerated.
        self.check_names(config, capture)?;
        let (host, shared) = Self::requested_names(config, capture)?;
        if let Some(name) = host {
            self.adapter.as_mut().unwrap().rename(name)?;
            if let Some(control) = &mut self.host_control {
                Arc::make_mut(&mut control.config)["inbounds"][0]["settings"]["name"] = json!(name);
            }
            if let Some(settings) = &mut self.adapter_settings {
                settings["name"] = json!(name);
            }
            if let Some(settings) = self.running.as_mut().and_then(|r| r.host_settings.as_mut()) {
                settings["name"] = json!(name);
            }
        }
        if let Some(name) =
            shared.filter(|name| self.keeper.as_ref().and_then(|k| k.adapter_name()) != Some(*name))
        {
            self.keeper
                .as_mut()
                .unwrap()
                .call("rename", json!({"name":name}))?;
            if let Some(worker) = &mut self.shared_worker {
                worker["inbounds"][0]["settings"]["name"] = json!(name);
            }
        }
        Ok(())
    }

    pub fn owned_host_index(&self) -> Option<u32> {
        self.adapter.as_ref().map(|a| a.index)
    }

    pub fn replace(
        &mut self,
        exe: &Path,
        mut plan: Plan,
        events: Arc<Events>,
        generation: u64,
    ) -> Result<()> {
        let running = self
            .running
            .as_ref()
            .ok_or_else(|| invalid("TUN update has no live network lease."))?;
        if !compatible(&running.key, &plan.network_key)
            || self.uplink.as_ref() != Some(&plan.uplink)
            || running.uplink != network::snapshot(&plan.uplink)?
        {
            return Err(invalid(
                "TUN network topology changed during Apply; recovery is required.",
            ));
        }
        if let Some(guard) = &self.uplink_guard {
            guard.check()?;
        }
        plan.release_relay();
        let options = plan.sharing_options.take();
        if plan.shared_source {
            self.replace_shared(
                plan.worker,
                options.as_ref(),
                generation,
                plan.fake_dns.as_deref(),
            )?;
            return Ok(());
        }
        let adapter = self
            .adapter
            .as_ref()
            .ok_or_else(|| invalid("The owned host TUN is missing."))?;
        let previous_settings = running
            .host_settings
            .as_ref()
            .ok_or_else(|| invalid("Host TUN configuration checkpoint is missing."))?;
        if !adapter.identity_ready()? || !configuration::ready(adapter.index, previous_settings)? {
            return Err(invalid("The owned host TUN settings changed during Apply."));
        }
        plan.worker["inbounds"][0]["settings"]["name"] = json!(adapter.name);
        let settings = plan.worker["inbounds"][0]["settings"].clone();
        let service = exe.parent().unwrap().parent().unwrap();
        let unchanged_applications = running.applications == plan.applications
            && (running.applications.is_none() || self.applications.is_some());
        let previous_metadata = running.metadata.clone();
        let worker_exe = worker_executable(service)?;
        let token = scoped_token()?;
        // Only close the old packet session. Its adapter, routes, forwarding
        // guard, sharing keeper and advertisements remain owned and enabled.
        if let Some(core) = self.core.take() {
            core.stop()?;
        }
        let (applications, metadata) = if unchanged_applications {
            (None, previous_metadata)
        } else {
            // Process observation has one owned ETW session. Retire the old
            // packet consumer and provider before acquiring that observer again.
            // Keep its authored checkpoint until replacement succeeds. A missing
            // provider invalidates reuse, including during candidate rollback.
            self.applications
                .take()
                .map_or(Ok(()), crate::capture::Worker::stop)?;
            application_provider(service, plan.applications.clone(), options.as_ref())?
        };
        let control = crate::live::Control::new(&plan.worker)?;
        let core = native::spawn_tun_with_token(
            &worker_exe,
            token,
            &control.config,
            "run -format json -config stdin:",
            Some(events),
            generation,
            native::TunOptions {
                metadata: metadata.as_deref(),
                fakedns: plan.fake_dns.as_deref(),
                reuse_settings: true,
                assets: exe.parent().unwrap(),
            },
        )?;
        wait_started(&core)?;
        if !routes_ready(
            adapter.index,
            &prefixes(&settings, "autoSystemRoutingTable")?,
        )? {
            return Err(invalid("Retained TUN capture routes are no longer ready."));
        }
        self.core = Some(core);
        self.host_control = Some(control);
        if !unchanged_applications {
            self.applications = applications;
        }
        let running = self.running.as_mut().unwrap();
        running.host_settings = Some(settings);
        running.applications = plan.applications;
        running.metadata = metadata;
        self.adapter_settings = Some(plan.adapter_settings);
        // Publish the live attribution identity before another worker can
        // fail: rollback must never reuse a replaced provider's old secret.
        // Shared IPv6 uses the same host LUID and return routes throughout.
        if let Some(shared) = plan.shared.take() {
            self.replace_shared(
                shared.worker,
                options.as_ref(),
                generation,
                shared.fake_dns.as_deref(),
            )?;
        }
        Ok(())
    }

    fn replace_shared(
        &mut self,
        worker: Value,
        options: Option<&sharing::Options>,
        generation: u64,
        fake_dns: Option<&str>,
    ) -> Result<()> {
        let shared_worker = worker.clone();
        self.keeper
            .as_mut()
            .ok_or_else(|| invalid("The sharing keeper is missing."))?
            .replace_worker(
                worker,
                options.ok_or_else(|| invalid("Sharing selection is missing."))?,
                generation,
                fake_dns,
            )?;
        self.shared_worker = Some(shared_worker);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value {
        json!({"inbounds":[{"protocol":"tun","tag":"host","settings":{"name":"Wayrill-TUN","gateway":["10.90.0.1/24"],"dns":["1.1.1.1"],"mtu":1500,"autoSystemRoutingTable":["0.0.0.0/1","128.0.0.0/1"],"autoOutboundsInterface":"auto"}}],"outbounds":[{"tag":"direct","protocol":"freedom"}],"routing":{"rules":[{"domain":["domain:example.org"],"outboundTag":"direct"}]}})
    }
    #[test]
    fn rules_peers_sniffing_and_level_do_not_rebuild_network_ownership() {
        let config = config();
        let key = network_key(&config, None);
        let mut next = config.clone();
        next["routing"]["rules"][0]["domain"] = json!(["domain:other.example"]);
        next["outbounds"] = json!([{"tag":"new","protocol":"socks","settings":{"address":"peer.example","port":1080}}]);
        next["inbounds"][0]["sniffing"] = json!({"enabled":true,"destOverride":["tls"]});
        next["inbounds"][0]["settings"]["userLevel"] = json!(2);
        assert!(compatible(&key, &network_key(&next, None)));
    }
    #[test]
    fn every_adapter_geometry_change_uses_full_reconfiguration() {
        let config = config();
        let key = network_key(&config, None);
        for (field, value) in [
            ("gateway", json!(["10.91.0.1/24"])),
            ("dns", json!(["9.9.9.9"])),
            ("mtu", json!(1420)),
            ("autoSystemRoutingTable", json!(["203.0.113.0/24"])),
            ("autoSystemWfpBlockLeak", json!(["0.0.0.0/0"])),
        ] {
            let mut next = config.clone();
            next["inbounds"][0]["settings"][field] = value;
            assert!(!compatible(&key, &network_key(&next, None)), "{field}");
        }
        let mut wfp = config;
        wfp["inbounds"][0]["settings"]["autoSystemWfpBlockLeak"] = json!(["0.0.0.0/0"]);
        let wfp = network_key(&wfp, None);
        assert!(!compatible(&wfp, &wfp));
        assert!(!compatible(&json!({"inputs":[]}), &json!({"inputs":[]})));
    }
    #[test]
    fn alias_edits_preserve_the_authored_network_topology() {
        let old = config();
        let mut next = old.clone();
        next["inbounds"][0]["settings"]["name"] = json!("Owned renamed TUN");
        assert!(compatible(
            &network_key(&old, None),
            &network_key(&next, None)
        ));
    }
    #[test]
    fn input_order_does_not_change_the_owned_network_key() {
        let mut config = config();
        let mut second = config["inbounds"][0].clone();
        second["tag"] = json!("another");
        config["inbounds"].as_array_mut().unwrap().push(second);
        let key = network_key(&config, None);
        config["inbounds"].as_array_mut().unwrap().reverse();
        assert_eq!(key, network_key(&config, None));
    }
    #[test]
    fn automatic_monitor_pinning_uses_a_separate_live_uplink_check() {
        let mut config = config();
        let key = network_key(&config, None);
        config["inbounds"][0]["settings"]["autoOutboundsInterface"] = json!("Ethernet");
        assert!(compatible(&key, &network_key(&config, None)));
    }
    #[test]
    fn sharing_pair_and_ipv6_changes_are_cold_but_direct_targets_are_not() {
        let mut config = config();
        let mut shared = config["inbounds"][0].clone();
        shared["tag"] = json!("shared");
        shared["settings"]["name"] = json!("Wayrill-ICS");
        config["inbounds"].as_array_mut().unwrap().push(shared);
        let mut capture: crate::capture::Plan=serde_json::from_value(json!({"version":1,"inputs":[],"interfaces":{"monitorNewInterfaces":true,"interfaces":[]},"bypassLocalTraffic":true,"tunSharing":{"tag":"shared","expectedVersion":"a".repeat(64),"publicId":"22944640-3598-4b5d-aa13-06ea38f26fb0","privateId":"830b3b6e-fa82-4103-8ff5-66f93d1dafa4","upstreamTags":["direct"],"ipv6":false}})).unwrap();
        let key = network_key(&config, Some(&capture));
        capture.tun_sharing.as_mut().unwrap().upstream_tags = vec!["another-direct".into()];
        assert!(compatible(&key, &network_key(&config, Some(&capture))));
        for property in ["publicId", "privateId", "expectedVersion", "ipv6", "tag"] {
            let mut value = serde_json::to_value(&capture).unwrap();
            value["tunSharing"][property] = if property == "ipv6" {
                json!(true)
            } else {
                json!("changed")
            };
            let changed = serde_json::from_value::<crate::capture::Plan>(value).unwrap();
            assert!(
                !compatible(&key, &network_key(&config, Some(&changed))),
                "{property}"
            );
        }
        assert!(!compatible(&key, &network_key(&config, None)));
        config["inbounds"].as_array_mut().unwrap().pop();
        assert!(!compatible(&key, &network_key(&config, Some(&capture))));
    }
}
