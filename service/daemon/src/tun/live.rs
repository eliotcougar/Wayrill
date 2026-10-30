//! Rule-only updates keep every packet session and the native sharing keeper.
use super::*;
#[derive(Clone)]
pub(crate) struct Routes {
    pub host: Option<Value>,
    pub shared: Option<Value>,
}
pub(crate) struct PreparedRoutes {
    pub previous: Routes,
    pub next: Routes,
    pub relays: Vec<Value>,
    pub aliases: Vec<(String, String)>,
}
fn relay_rules(main: &Value, tags: &BTreeSet<&str>) -> Vec<Value> {
    main["routing"]["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|rule| {
            rule["inboundTag"]
                .as_array()
                .is_some_and(|a| a.len() == 1 && a[0].as_str().is_some_and(|t| tags.contains(t)))
                && rule["user"].as_array().is_some_and(|a| {
                    a.len() == 1 && a[0].as_str().is_some_and(|u| u.starts_with("wtr-"))
                })
        })
        .cloned()
        .collect()
}
fn project_worker(old: &Value, raw: &Value, relays: &[Value]) -> Option<Value> {
    let tag = old["inbounds"][0]["tag"].as_str()?;
    let allowed: BTreeSet<_> = old["outbounds"]
        .as_array()?
        .iter()
        .filter_map(|o| o["tag"].as_str())
        .collect();
    let mut targets = BTreeMap::new();
    for rule in relays.iter().filter(|r| r["inboundTag"] == json!([tag])) {
        let user = rule["user"][0].as_str()?;
        if !allowed.contains(user) {
            continue;
        }
        for key in ["outboundTag", "balancerTag"] {
            if let Some(target) = rule[key].as_str() {
                targets.entry((key, target)).or_insert(user);
            }
        }
    }
    let dns: BTreeSet<_> = old["outbounds"]
        .as_array()?
        .iter()
        .filter(|o| o["protocol"] == "dns")
        .filter_map(|o| o["tag"].as_str())
        .collect();
    let mut rules: Vec<_> = old["routing"]["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["outboundTag"].as_str().is_some_and(|t| dns.contains(t)))
        .cloned()
        .collect();
    for mut rule in super::worker_rules_for_dns(raw, tag, &old["dns"]) {
        let key = if rule["outboundTag"].is_string() {
            "outboundTag"
        } else {
            "balancerTag"
        };
        let alias = *targets.get(&(key, rule[key].as_str()?))?;
        rule.as_object_mut()?.remove(key);
        rule["outboundTag"] = json!(alias);
        rules.push(rule);
    }
    let mut worker = old.clone();
    worker["routing"]["rules"] = json!(rules);
    Some(worker)
}
impl Manager {
    pub(crate) fn live_routes(
        &self,
        raw: &Value,
        main: &Value,
        capture: Option<&crate::capture::Plan>,
    ) -> Option<PreparedRoutes> {
        let old = Routes {
            host: self
                .host_control
                .as_ref()
                .map(|c| c.config["routing"].clone()),
            shared: self.shared_worker.as_ref().map(|c| c["routing"].clone()),
        };
        let tags: BTreeSet<_> = self
            .host_control
            .iter()
            .map(|c| &*c.config)
            .chain(self.shared_worker.iter())
            .filter_map(|c| c["inbounds"][0]["tag"].as_str())
            .collect();
        let relays = relay_rules(main, &tags);
        let mut host = match &self.host_control {
            Some(c) => Some(project_worker(&c.config, raw, &relays)?),
            None => None,
        };
        let shared = match &self.shared_worker {
            Some(c) => Some(project_worker(c, raw, &relays)?),
            None => None,
        };
        let mut aliases = Vec::new();
        if capture
            .and_then(|p| p.tun_sharing.as_ref())
            .is_some_and(|s| s.ipv6)
        {
            let host = host.as_mut()?;
            let shared = shared.as_ref()?;
            // This is a routing projection, not an adapter write. The authored
            // geometry proves IPv6 scope; the live worker may have started with
            // empty routes while the service completed the sharing handoff.
            host["inbounds"][0]["settings"] = raw["inbounds"]
                .as_array()?
                .iter()
                .find(|i| i["tag"] == host["inbounds"][0]["tag"])?["settings"]
                .clone();
            host["outbounds"]
                .as_array_mut()?
                .retain(|o| !o["tag"].as_str().is_some_and(|t| t.starts_with("wi6-")));
            aliases =
                super::shared_ipv6_worker(host, shared, &capture?.tun_sharing.as_ref()?.private_id)
                    .ok()?;
        }
        let next = Routes {
            host: match (&self.host_control, host) {
                (Some(c), Some(w)) => Some(c.routing(&w["routing"])),
                (None, None) => None,
                _ => return None,
            },
            shared: shared.map(|w| w["routing"].clone()),
        };
        Some(PreparedRoutes {
            previous: old,
            next,
            relays,
            aliases,
        })
    }
    pub(crate) fn live_probe(
        &mut self,
        exe: &Path,
        identity: native::CoreIdentity<'_>,
        routes: &Routes,
    ) -> Result<()> {
        if let Some(c) = &self.host_control {
            c.prepare(
                exe,
                identity,
                routes
                    .host
                    .as_ref()
                    .ok_or_else(|| invalid("Missing host live routing."))?,
            )?;
        }
        if let Some(k) = &mut self.keeper {
            k.call(
                "routing.prepare",
                routes
                    .shared
                    .as_ref()
                    .ok_or_else(|| invalid("Missing shared live routing."))?
                    .clone(),
            )?;
        }
        Ok(())
    }
    fn apply_host(
        &mut self,
        exe: &Path,
        identity: native::CoreIdentity<'_>,
        routes: &Routes,
    ) -> Result<()> {
        match (&mut self.host_control, &routes.host) {
            (Some(c), Some(r)) => {
                c.call(exe, identity, Some(r))?;
                c.commit(r.clone());
                Ok(())
            }
            (None, None) => Ok(()),
            _ => Err(invalid("Host routing control/checkpoint mismatch.")),
        }
    }
    fn apply_shared(&mut self, routes: &Routes) -> Result<()> {
        if let Some(r) = &routes.shared {
            self.keeper
                .as_mut()
                .ok_or_else(|| invalid("Sharing control is unavailable."))?
                .call("routing.replace", r.clone())?;
            self.shared_worker
                .as_mut()
                .ok_or_else(|| invalid("Sharing routing checkpoint is unavailable."))?["routing"] =
                r.clone();
        } else if self.shared_worker.is_some() || self.keeper.is_some() {
            return Err(invalid("Missing shared routing checkpoint."));
        }
        Ok(())
    }
    pub(crate) fn live_apply(
        &mut self,
        exe: &Path,
        identity: native::CoreIdentity<'_>,
        routes: &Routes,
    ) -> Result<()> {
        self.apply_host(exe, identity, routes)?;
        self.apply_shared(routes)
    }
    pub(crate) fn restore_live(
        &mut self,
        exe: &Path,
        identity: native::CoreIdentity<'_>,
        routes: &Routes,
    ) -> Result<()> {
        let host = self.apply_host(exe, identity, routes);
        let shared = self.apply_shared(routes);
        host.and(shared)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_resolver_bridge_does_not_acquire_original_dns_server_scopes() {
        let old = json!({"inbounds":[{"tag":"shared"}],"outbounds":[{"tag":"wtr-2","protocol":"socks"}],"dns":{"tag":"global-dns","servers":["tcp+local://127.0.0.1:54321"]},"routing":{"rules":[]}});
        let relays = vec![json!({"inboundTag":["shared"],"user":["wtr-2"],"outboundTag":"b"})];
        let raw = json!({"dns":{"servers":[{"tag":"original-server"}]},"routing":{"rules":[{"inboundTag":["original-server"],"outboundTag":"unprepared"},{"outboundTag":"b"}]}});
        let projected = project_worker(&old, &raw, &relays).unwrap();
        assert_eq!(projected["routing"]["rules"].as_array().unwrap().len(), 1);
        assert_eq!(projected["routing"]["rules"][0]["outboundTag"], "wtr-2");
    }
    #[test]
    fn projects_removed_rules_without_changing_relay_accounts_or_resolver() {
        let old = json!({"inbounds":[{"tag":"host"}],"outbounds":[{"tag":"wtr-9","protocol":"socks"},{"tag":"wtr-2","protocol":"socks"},{"tag":"dns","protocol":"dns"}],"routing":{"rules":[{"inboundTag":["resolver"],"outboundTag":"dns"}]}});
        let relays = vec![
            json!({"inboundTag":["host"],"user":["wtr-9"],"outboundTag":"a"}),
            json!({"inboundTag":["host"],"user":["wtr-2"],"outboundTag":"b"}),
        ];
        let raw = json!({"routing":{"rules":[{"domain":["example.org"],"outboundTag":"b"}]}});
        let projected = project_worker(&old, &raw, &relays).unwrap();
        assert_eq!(projected["outbounds"], old["outbounds"]);
        assert_eq!(projected["routing"]["rules"][0], old["routing"]["rules"][0]);
        assert_eq!(projected["routing"]["rules"][1]["outboundTag"], "wtr-2");
        let mut changed = raw;
        changed["routing"]["rules"][0]["outboundTag"] = json!("unprepared");
        assert!(project_worker(&old, &changed, &relays).is_none());
    }
}
