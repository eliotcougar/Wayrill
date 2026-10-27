use super::*;

struct LiveUpdate {
    old_main: Value,
    new_main: Value,
    old_workers: crate::tun::live::Routes,
    new_workers: crate::tun::live::Routes,
    session: Option<crate::routing_log::Session>,
    attempted: bool,
}

/// Exactly one forward plan and its inverse. Payloads retain the resources
/// needed for rollback until the durable checkpoint has been released.
enum ActivationPlan {
    Replace(RestartMode),
    Rename { attempted: bool },
    Rules(Box<LiveUpdate>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ActivationKind {
    Apply,
    Restart,
}

/// One immutable rollback authority owns all identities that must outlive a
/// candidate, including its FakeDNS mappings and resolved bootstrap hosts.
struct PreviousRuntime {
    generation: u64,
    profile: Option<Profile>,
    was_running: bool,
    wanted_running: bool,
    sharing_native: Option<bool>,
    bootstrap: Option<(String, Value)>,
    fake_dns: Option<Arc<crate::fakedns::Pool>>,
}

pub(super) struct KernelActivation<'a> {
    source_graph: Option<String>,
    kernel: &'a mut Kernel,
    config: Value,
    display_names: DisplayNames,
    capture: Option<Plan>,
    previous: PreviousRuntime,
    capture_settings: Vec<crate::system_settings::Request>,
    checkpoint: PathBuf,
    bootstrap_hosts: Option<Value>,
    retained_adapter: Option<crate::tun::RetainedAdapter>,
    plan: ActivationPlan,
    kind: ActivationKind,
    resource_config: Value,
    resource_report: crate::resource_rules::Report,
}
impl<'a> KernelActivation<'a> {
    pub(super) fn new(
        kernel: &'a mut Kernel,
        input: ActivateInput,
        capture_settings: Vec<crate::system_settings::Request>,
        kind: ActivationKind,
    ) -> Self {
        let previous = PreviousRuntime {
            generation: kernel.generation,
            profile: kernel.profile.clone(),
            was_running: kernel.core.is_some(),
            wanted_running: kernel.recovery.wants_running(),
            sharing_native: kernel.tun.status()["sharing"]["restoreNativeOnBoot"].as_bool(),
            bootstrap: kernel.bootstrap_cache.clone(),
            fake_dns: kernel.fake_dns.clone(),
        };
        let checkpoint = kernel
            .profile_path
            .with_file_name("activation-rollback.json");
        Self {
            source_graph: input.source_graph,
            kernel,
            resource_config: input.config.clone(),
            resource_report: crate::resource_rules::Report::default(),
            config: input.config,
            display_names: input.display_names,
            capture: input.capture,
            previous,
            capture_settings,
            checkpoint,
            bootstrap_hosts: None,
            retained_adapter: None,
            plan: ActivationPlan::Replace(RestartMode::Reconfigure),
            kind,
        }
    }
    fn restore_profile(&mut self) -> Result<()> {
        let revision = advance_revision(self.kernel.revision())?;
        if let Some(mut profile) = self.previous.profile.clone() {
            profile.revision = revision;
            storage::write(&self.kernel.profile_path, &profile)?;
            self.kernel.profile = Some(profile);
        } else {
            storage::write(
                &self
                    .kernel
                    .profile_path
                    .with_file_name("revision-floor.json"),
                &revision,
            )?;
            storage::remove(&self.kernel.profile_path)?;
            self.kernel.empty_revision = revision;
            self.kernel.profile = None;
        }
        if !self.previous.wanted_running {
            self.kernel.recovery.stop()?;
        }
        self.kernel.bootstrap_cache = self.previous.bootstrap.clone();
        self.kernel.statistics.revision(revision);
        self.kernel.changed("config.rolledBack");
        Ok(())
    }
    fn finish_restore(&mut self) -> Result<()> {
        if let Some(previous) = &self.kernel.profile {
            self.kernel.proxy.reapply(
                &self.capture_settings,
                &previous.config,
                previous.capture.as_ref(),
            )?;
            self.kernel.changed("system.captureChanged");
        }
        if self.kernel.core_state == CoreState::Running || !self.kernel.recovery.wants_running() {
            self.kernel.protection.ready()?;
        }
        storage::remove(&self.checkpoint)
    }

    fn prepare_live(&mut self) -> Result<Option<LiveUpdate>> {
        let Some(previous) = &self.previous.profile else {
            return Ok(None);
        };
        if self.kind != ActivationKind::Apply
            || !self.previous.was_running
            || self.kernel.core_state != CoreState::Running
            || self.kernel.control.is_none()
            || self.kernel.statistics_bridge.is_none()
            || self.kernel.core_resource_generation != self.kernel.resources.generation()
            || !crate::live::same_except_rules(&previous.config, &self.config)
            || serde_json::to_value(&previous.capture).ok()
                != serde_json::to_value(&self.capture).ok()
            || (previous.display_names.routing.is_empty()
                && previous.display_names.routing_default.is_none())
                != (self.display_names.routing.is_empty()
                    && self.display_names.routing_default.is_none())
        {
            return Ok(None);
        }
        if self.kernel.core.as_ref().unwrap().exit_code()?.is_some() {
            return Ok(None);
        }
        let has_tun = self.config["inbounds"]
            .as_array()
            .is_some_and(|a| a.iter().any(|i| i["protocol"] == "tun"));
        if has_tun
            && !self
                .kernel
                .tun
                .can_replace(&self.config, self.capture.as_ref())?
        {
            return Ok(None);
        }
        let mut config = self.kernel.network.configuration(&self.resource_config)?;
        let mut session = crate::routing_log::instrument(
            &mut config,
            &self.display_names,
            self.kernel.generation,
            advance_revision(self.kernel.revision())?,
        );
        if let Some(pool) = &self.kernel.fake_dns {
            pool.instrument(&mut config)?;
        }
        let (runtime, _) = capture::instrument(self.capture.as_ref(), &config)?;
        let control = self.kernel.control.as_ref().unwrap();
        let Some(routes) =
            self.kernel
                .tun
                .live_routes(&runtime, &control.config, self.capture.as_ref())
        else {
            return Ok(None);
        };
        if let Some(session) = &mut session {
            session.include_aliases(&routes.aliases);
        }
        let new_main = control.routing(&crate::live::main_routing(
            &self.kernel.statistics_bridge.as_ref().unwrap().control_rule,
            self.kernel
                .loopback_policy
                .as_ref()
                .map(|p| p.rules())
                .unwrap_or(&[]),
            routes.relays,
            &runtime,
            &control.config,
        ));
        // Reject unavailable control channels before saving or changing the profile.
        if let Err(error) = control.prepare(&self.kernel.exe, self.kernel.identity(), &new_main) {
            if matches!(error.code.as_str(), "LIVE_UNSUPPORTED" | "LIVE_UPDATE") {
                return Ok(None);
            }
            return Err(error);
        }
        let identity = if self.kernel.startup.enabled() {
            CoreIdentity::LocalService
        } else {
            CoreIdentity::Owner(&self.kernel.owner)
        };
        if let Err(error) = self
            .kernel
            .tun
            .live_probe(&self.kernel.exe, identity, &routes.next)
        {
            if matches!(error.code.as_str(), "LIVE_UNSUPPORTED" | "LIVE_UPDATE") {
                return Ok(None);
            }
            return Err(error);
        }
        Ok(Some(LiveUpdate {
            old_main: control.config["routing"].clone(),
            new_main,
            old_workers: routes.previous,
            new_workers: routes.next,
            session,
            attempted: false,
        }))
    }
}
impl crate::activation::Activation for KernelActivation<'_> {
    fn action(&self) -> &'static str {
        self.kernel
            .lifecycle
            .as_ref()
            .map(|p| p.action())
            .unwrap_or("Apply")
    }
    fn validate(&mut self) -> Result<()> {
        self.kernel.progress(crate::lifecycle::Stage::Validate);
        crate::tun::validate(&self.config)?;
        let projection = self.kernel.resources.project(&self.config)?;
        validate_core(&self.kernel.exe, self.kernel.identity(), &projection.config)?;
        self.resource_config = projection.config;
        self.resource_report = projection.report;
        // Native preflight can finish a previous owned recovery. Reject malformed
        // candidates before that recovery has any Windows side effects.
        self.kernel
            .tun
            .preflight(&self.config, self.capture.as_ref())?;
        let rename_only = self.kind == ActivationKind::Apply
            && self.previous.was_running
            && self.kernel.core_state == CoreState::Running
            && self
                .kernel
                .core
                .as_ref()
                .is_some_and(|core| matches!(core.exit_code(), Ok(None)))
            && self.kernel.core_resource_generation == self.kernel.resources.generation()
            && self.previous.profile.as_ref().is_some_and(|previous| {
                crate::live::same_except_adapter_names(&previous.config, &self.config)
                    && serde_json::to_value(&previous.capture).ok()
                        == serde_json::to_value(&self.capture).ok()
                    && serde_json::to_value(&previous.display_names).ok()
                        == serde_json::to_value(&self.display_names).ok()
            })
            && self
                .kernel
                .tun
                .can_replace(&self.config, self.capture.as_ref())?;
        self.plan = if rename_only {
            ActivationPlan::Rename { attempted: false }
        } else if let Some(live) = self.prepare_live()? {
            ActivationPlan::Rules(Box::new(live))
        } else {
            self.bootstrap_hosts = self.kernel.prepare_bootstrap(&self.config)?;
            // Live resource proofs decide retention even if the main core died.
            // A process-state flag cannot invalidate healthy TUN/ICS ownership.
            let network = if self
                .kernel
                .tun
                .can_replace(&self.config, self.capture.as_ref())?
            {
                RestartMode::PreserveNetwork
            } else {
                RestartMode::Reconfigure
            };
            ActivationPlan::Replace(network)
        };
        // Check new sockets without interrupting the old core. A changed wildcard
        // can overlap an owned socket; check it again after stopping, with rollback.
        let owned = if self.previous.was_running {
            self.previous
                .profile
                .as_ref()
                .map(|p| listener_endpoints(&p.config))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        for endpoint in listener_endpoints(&self.config) {
            if !owned.iter().any(|old| old.overlaps(endpoint)) {
                check_endpoint(endpoint)?;
            }
        }
        Ok(())
    }
    fn checkpoint(&mut self) -> Result<()> {
        self.kernel.progress(crate::lifecycle::Stage::Checkpoint);
        require_recovered(&self.kernel.profile_path)?;
        // Reserve the rollback revision before disturbing a working runtime.
        advance_revision(advance_revision(self.kernel.revision())?)?;
        storage::write(
            &self.checkpoint,
            &Checkpoint {
                previous: self.previous.profile.clone(),
                next_revision: advance_revision(self.kernel.revision())?,
            },
        )
    }
    fn stop(&mut self) -> Result<()> {
        let ActivationPlan::Replace(network) = self.plan else {
            return Ok(());
        };
        self.kernel.network.cancel();
        if network == RestartMode::Reconfigure {
            self.retained_adapter = self
                .kernel
                .tun
                .retain_adapter(&self.config, self.capture.as_ref());
        }
        let sharing = if self.capture.as_ref().is_some_and(|p| p.sharing_disabled)
            || (self
                .previous
                .profile
                .as_ref()
                .and_then(|p| p.capture.as_ref())
                .is_some_and(|p| p.tun_sharing.is_some())
                && self
                    .capture
                    .as_ref()
                    .is_none_or(|p| p.tun_sharing.is_none()))
        {
            SharingExit::Disable
        } else {
            SharingExit::Suspend
        };
        self.kernel
            .retire_core(Retirement::Replace(network, sharing))
    }
    fn apply(&mut self) -> Result<()> {
        if self.kind != ActivationKind::Apply {
            return Ok(());
        }
        self.kernel.progress(crate::lifecycle::Stage::SaveProfile);
        let profile = Profile {
            source_graph: self.source_graph.clone(),
            owner_sid: self.kernel.owner.clone(),
            revision: advance_revision(self.kernel.revision())?,
            hash: profile_hash(&self.config, self.capture.as_ref()),
            capture: self.capture.clone(),
            config: self.config.clone(),
            display_names: self.display_names.clone(),
        };
        storage::write(&self.kernel.profile_path, &profile)?;
        self.kernel.profile = Some(profile);
        self.kernel.changed("config.applied");
        Ok(())
    }
    fn start(&mut self) -> Result<()> {
        if let ActivationPlan::Rename { attempted } = &mut self.plan {
            self.kernel
                .progress(crate::lifecycle::Stage::RenameAdapters);
            *attempted = true;
            self.kernel
                .tun
                .rename(&self.config, self.capture.as_ref())?;
            self.kernel.statistics.revision(self.kernel.revision());
            if let Some((hash, _)) = &mut self.kernel.bootstrap_cache {
                *hash = config_hash(&self.config);
            }
            self.kernel.changed("tun.renamed");
            return Ok(());
        }
        if let ActivationPlan::Rules(live) = &mut self.plan {
            self.kernel.progress(crate::lifecycle::Stage::UpdateRules);
            self.kernel.events.routing.live(live.session.take());
            live.attempted = true;
            let control = self.kernel.control.as_ref().unwrap();
            control.call(
                &self.kernel.exe,
                self.kernel.identity(),
                Some(&live.new_main),
            )?;
            let identity = if self.kernel.startup.enabled() {
                CoreIdentity::LocalService
            } else {
                CoreIdentity::Owner(&self.kernel.owner)
            };
            self.kernel
                .tun
                .live_apply(&self.kernel.exe, identity, &live.new_workers)?;
            self.kernel
                .control
                .as_mut()
                .unwrap()
                .commit(live.new_main.clone());
            self.kernel.statistics_bridge.as_mut().unwrap().config =
                self.kernel.control.as_ref().unwrap().config.clone();
            self.kernel.statistics.revision(self.kernel.revision());
            if let Some((hash, _)) = &mut self.kernel.bootstrap_cache {
                *hash = config_hash(&self.config);
            }
            self.kernel.changed("core.rulesUpdated");
            return Ok(());
        }
        let ActivationPlan::Replace(network) = self.plan else {
            unreachable!("in-place activation returned above")
        };
        self.kernel.start_core_with_runtime(
            self.bootstrap_hosts.take(),
            self.retained_adapter.take(),
            network,
        )
    }
    fn proxy(&mut self) -> Result<()> {
        self.kernel.progress(crate::lifecycle::Stage::ApplySettings);
        self.kernel
            .proxy
            .reapply(&self.capture_settings, &self.config, self.capture.as_ref())?;
        self.kernel.changed("system.captureChanged");
        Ok(())
    }
    fn commit(&mut self) -> Result<()> {
        self.kernel.progress(crate::lifecycle::Stage::Commit);
        self.kernel.recovery.healthy(Instant::now())?;
        self.kernel.protection.ready()?;
        storage::remove(&self.checkpoint)?;
        self.kernel.profile_recovery = None;
        self.kernel.resource_issues = self.resource_report.clone();
        self.kernel.resource_issues_generation = self.kernel.resources.generation();
        self.kernel.changed("config.recoveryCompleted");
        Ok(())
    }
    fn restore(&mut self) -> Result<()> {
        if let Some(progress) = &mut self.kernel.lifecycle {
            progress.recover();
        }
        // A failed guard/pre-retirement operation has not disturbed this
        // generation. Prove the old runtime instead of restarting it to roll back.
        if matches!(self.plan, ActivationPlan::Replace(_))
            && self.previous.was_running
            && self.kernel.generation == self.previous.generation
        {
            if let Some(previous) = &self.previous.profile {
                if self
                    .kernel
                    .profile
                    .as_ref()
                    .is_some_and(|p| p.hash == previous.hash)
                    && self
                        .kernel
                        .healthy_runtime(&previous.config, previous.capture.as_ref())
                        .unwrap_or(false)
                {
                    self.kernel.protection.ready()?;
                    return storage::remove(&self.checkpoint);
                }
            }
        }
        let plan = std::mem::replace(
            &mut self.plan,
            ActivationPlan::Replace(RestartMode::Reconfigure),
        );
        let network = match &plan {
            ActivationPlan::Replace(network) => *network,
            _ => RestartMode::Reconfigure,
        };
        if let ActivationPlan::Rename { attempted } = &plan {
            let previous = self.previous.profile.as_ref().unwrap();
            let renamed = if *attempted {
                self.kernel
                    .tun
                    .rename(&previous.config, previous.capture.as_ref())
            } else {
                Ok(())
            };
            if renamed.is_ok() {
                self.restore_profile()?;
                return self.finish_restore();
            }
        }
        if let ActivationPlan::Rules(live) = plan {
            let recovered: Result<()> = if !live.attempted {
                Ok(())
            } else {
                (|| {
                    let control = self.kernel.control.as_ref().unwrap();
                    let main = control.call(
                        &self.kernel.exe,
                        self.kernel.identity(),
                        Some(&live.old_main),
                    );
                    let identity = if self.kernel.startup.enabled() {
                        CoreIdentity::LocalService
                    } else {
                        CoreIdentity::Owner(&self.kernel.owner)
                    };
                    let workers =
                        self.kernel
                            .tun
                            .restore_live(&self.kernel.exe, identity, &live.old_workers);
                    let mut cleanup = Cleanup::default();
                    cleanup.record("main routing rollback", main);
                    cleanup.record("TUN routing rollback", workers);
                    cleanup.finish()?;
                    self.kernel
                        .control
                        .as_mut()
                        .unwrap()
                        .commit(live.old_main.clone());
                    self.kernel.statistics_bridge.as_mut().unwrap().config =
                        self.kernel.control.as_ref().unwrap().config.clone();
                    Ok(())
                })()
            };
            if recovered.is_ok() {
                self.restore_profile()?;
                if live.attempted {
                    self.kernel.events.routing.rollback_live();
                }
                return self.finish_restore();
            }
            // A dead control core cannot prove rollback. Use full guarded recovery.
        }
        // A stop error can mean a proxy conflict: stop the owned child, preserve external settings,
        // restore the profile, then report recovery needing attention instead of clobbering them.
        self.retained_adapter = None;
        self.kernel.network.cancel();
        let previous_shared = self.previous.was_running
            && self
                .previous
                .profile
                .as_ref()
                .and_then(|p| p.capture.as_ref())
                .is_some_and(|p| p.tun_sharing.is_some());
        let sharing = if previous_shared {
            SharingExit::Suspend
        } else if self.previous.sharing_native == Some(false) {
            SharingExit::Disable
        } else {
            SharingExit::Native
        };
        let stop = self
            .kernel
            .retire_core(Retirement::Replace(network, sharing));
        self.kernel.fake_dns = self.previous.fake_dns.clone();
        let restored = (|| {
            self.restore_profile()?;
            if !self.previous.was_running
                || self
                    .previous
                    .profile
                    .as_ref()
                    .and_then(|p| p.capture.as_ref())
                    .is_none_or(|p| p.tun_sharing.is_none())
            {
                self.kernel
                    .tun
                    .restore_sharing_intent(self.previous.sharing_native)?;
            }
            if self.previous.was_running {
                let hosts = self
                    .previous
                    .bootstrap
                    .as_ref()
                    .map(|(_, hosts)| hosts.clone());
                if let Err(warm) = self
                    .kernel
                    .start_core_with_runtime(hosts.clone(), None, network)
                {
                    if network == RestartMode::Reconfigure {
                        return Err(warm);
                    }
                    self.kernel
                        .events
                        .publish("activation.recoveryFallback", json!({"code":warm.code}));
                    self.kernel.retire_core(Retirement::Replace(
                        RestartMode::Reconfigure,
                        SharingExit::Suspend,
                    ))?;
                    self.kernel.start_core_with_hosts(hosts)?;
                }
            }
            Ok(())
        })();
        let mut cleanup = Cleanup::default();
        cleanup.record("candidate retirement", stop);
        cleanup.record("previous runtime recovery", restored);
        cleanup.finish()?;
        self.finish_restore()
    }
}
