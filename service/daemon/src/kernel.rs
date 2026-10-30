use crate::display_names::DisplayNames;
use crate::lifecycle::{
    Cleanup, CoreState, Fault, NetworkChange as RestartMode, Retirement, SharingExit,
};
mod activation;
use crate::{
    capture::{self, Plan},
    divert::DivertManager,
    events::Events,
    native::{validate_core, CoreIdentity, CoreProcess},
    proxy::ProxyManager,
    storage,
    traffic::{Bridge, EndpointPageInput, Sample, Traffic},
};
use activation::{ActivationKind, KernelActivation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    net::{SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use wayrill_protocol::{
    listener_endpoints, normalize_config, params, ApiError, ListenerEndpoint, ListenerNetwork,
    Result,
};
struct ResourceReload {
    generation: u64,
    error: ApiError,
    retry_at: Option<Instant>,
}
impl ResourceReload {
    fn failed(generation: u64, mut error: ApiError, now: Instant) -> Self {
        // Invalid content needs corrected files or an explicit Apply. A native
        // availability failure must not leave healthy routing on stale matchers
        // forever; retry on the ordinary serialized tick with a bounded rate.
        let retry_at = (!matches!(
            error.code.as_str(),
            "XRAY_CONFIG_INVALID"
                | "RESOURCE_INVALID"
                | "STATE_INTEGRITY"
                | "OWNER_MISMATCH"
                | "ICS_DISABLED"
        ))
        .then_some(now + Duration::from_secs(30));
        error.retryable = retry_at.is_some();
        Self {
            generation,
            error,
            retry_at,
        }
    }
    fn blocks(&self, generation: u64, now: Instant) -> bool {
        self.generation == generation && self.retry_at.is_none_or(|at| now < at)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_graph: Option<String>,
    owner_sid: String,
    revision: u64,
    hash: String,
    config: Value,
    #[serde(default)]
    display_names: DisplayNames,
    #[serde(default)]
    capture: Option<Plan>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigInput {
    config: Value,
    #[serde(default)]
    capture: Option<Plan>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyInput {
    #[serde(default)]
    source_graph_token: Option<String>,
    #[serde(default)]
    source_graph: Option<String>,
    config: Value,
    #[serde(default)]
    display_names: DisplayNames,
    #[serde(default)]
    capture: Option<Plan>,
    expected_revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivateInput {
    #[serde(default)]
    source_graph_token: Option<String>,
    #[serde(default)]
    source_graph: Option<String>,
    config: Value,
    #[serde(default)]
    display_names: DisplayNames,
    #[serde(default)]
    capture: Option<Plan>,
    expected_revision: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    previous: Option<Profile>,
    next_revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revision {
    revision: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Port {
    port: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Empty {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopInput {
    #[serde(default)]
    disable_sharing: bool,
}
pub struct Kernel {
    protection: crate::app_protection::Manager,
    pub(crate) subscriptions: crate::subscriptions::Manager,
    startup: crate::startup::Startup,
    recovery: crate::recovery::Supervisor,
    network: crate::tun::network::Monitor,
    resources: crate::resources::Manager,
    outbound_tests: crate::outbound_tests::Manager,
    direct_egress: Option<crate::tun::OutboundEgress>,
    loopback_policy: Option<crate::loopback::Policy>,
    core_resource_generation: u64,
    resource_reload: Option<ResourceReload>,
    resource_issues: crate::resource_rules::Report,
    resource_issues_generation: u64,
    owner: String,
    exe: PathBuf,
    profile_path: PathBuf,
    profile: Option<Profile>,
    empty_revision: u64,
    profile_recovery: Option<ApiError>,
    core: Option<CoreProcess>,
    fake_dns: Option<Arc<crate::fakedns::Pool>>,
    fake_dns_usage: Option<(u64, Instant, crate::fakedns::Usage)>,
    tun: crate::tun::Manager,
    statistics: Traffic,
    observation: Option<(u64, Instant, Value)>,
    statistics_bridge: Option<Bridge>,
    control: Option<crate::live::Control>,
    core_state: CoreState,
    health_fault: Option<Fault>,
    lifecycle: Option<crate::lifecycle::Progress>,
    generation: u64,
    last_error: Option<ApiError>,
    pub proxy: ProxyManager,
    divert: DivertManager,
    capture: capture::Manager,
    driver: crate::driver::Driver,
    runtime_capture: Option<Value>,
    bootstrap_cache: Option<(String, Value)>,
    pub events: Arc<Events>,
    started: Instant,
    shutting_down: bool,
    user_settings_retry: Option<Instant>,
    user_settings_error: Option<ApiError>,
}
// Authenticate exactly what was stored before serde adds new defaults. Hashing
// a deserialized Plan first rejects valid profiles after a new optional field.
fn advance_revision(revision: u64) -> Result<u64> {
    revision.checked_add(1).ok_or_else(|| {
        ApiError::new(
            "REVISION_EXHAUSTED",
            "The protected revision counter is exhausted.",
        )
    })
}
fn stored_profile(value: Value) -> Result<Profile> {
    let mut profile: Profile = serde_json::from_value(value.clone())
        .map_err(|e| ApiError::new("STATE_INTEGRITY", format!("Invalid protected profile: {e}")))?;
    let stored_hash = if value["capture"].is_null() {
        config_hash(&value["config"])
    } else {
        config_hash(&json!({"config":value["config"],"capture":value["capture"]}))
    };
    if stored_hash != profile.hash {
        return Err(ApiError::new(
            "STATE_INTEGRITY",
            "Protected profile hash mismatch.",
        ));
    }
    profile.hash = profile_hash(&profile.config, profile.capture.as_ref());
    Ok(profile)
}
// Keep the API available when only the saved runtime profile is damaged. The
// original file remains untouched until the owner applies a new valid graph.
// Exact bytes are preserved separately before permitting that replacement.
fn load_profile(
    path: &std::path::Path,
    owner: &str,
) -> Result<(Option<Profile>, u64, Option<ApiError>)> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((None, 0, None)),
        Err(error) => return Err(ApiError::io("Read protected profile", error)),
    };
    let raw = serde_json::from_slice::<Value>(&bytes);
    if raw
        .as_ref()
        .ok()
        .and_then(|raw| raw["ownerSid"].as_str())
        .is_some_and(|sid| sid != owner)
    {
        return Err(ApiError::new(
            "OWNER_MISMATCH",
            "The protected profile belongs to another installation owner.",
        ));
    }
    let revision = raw
        .as_ref()
        .ok()
        .and_then(|raw| raw["revision"].as_u64())
        .unwrap_or(0);
    let loaded = raw
        .map_err(|error| {
            ApiError::new(
                "STATE_INTEGRITY",
                format!("Unreadable protected profile: {error}"),
            )
        })
        .and_then(stored_profile);
    match loaded {
        Ok(profile) => Ok((Some(profile), revision, None)),
        Err(error) => {
            let backup = path.with_file_name(format!(
                "profile-recovery-{}.json",
                crate::system_native::hex(&Sha256::digest(&bytes))
            ));
            // An existing backup is accepted only when it is byte-for-byte equal.
            // A failed backup must not permit an unprotected replacement.
            match std::fs::read(&backup) {
                Ok(saved) if saved == bytes => {}
                Ok(_) => {
                    return Err(ApiError::new(
                        "STATE_INTEGRITY",
                        "The protected recovery copy differs from the saved profile.",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    storage::write_bytes(&backup, &bytes)?;
                }
                Err(error) => return Err(ApiError::io("Read profile recovery copy", error)),
            }
            Ok((
                None,
                revision,
                Some(ApiError::new(
                    "STATE_INTEGRITY",
                    format!(
                        "{} Routing is stopped. Open your saved graph, run Check and Validate, then Start to apply it and restore routing. The original profile was preserved at {}.",
                        error.message,
                        backup.display()
                    ),
                )),
            ))
        }
    }
}
fn stored_checkpoint(mut value: Value) -> Result<Checkpoint> {
    if !value["previous"].is_null() {
        value["previous"] = serde_json::to_value(stored_profile(value["previous"].take())?)
            .map_err(|e| ApiError::io("Normalize protected checkpoint", e))?;
    }
    serde_json::from_value(value).map_err(|e| ApiError::io("Read activation checkpoint", e))
}
#[cfg(test)]
use crate::resource_rules::uses_resources;

fn require_recovered(profile_path: &std::path::Path) -> Result<()> {
    if profile_path
        .with_file_name("activation-rollback.json")
        .try_exists()
        .map_err(|e| ApiError::io("Inspect activation recovery", e))?
    {
        return Err(ApiError::new("RECOVERY_REQUIRED", "Previous activation recovery is incomplete. Stop networking to finish recovery before starting or applying a configuration."));
    }
    Ok(())
}
fn recover_checkpoint(
    profile_path: &std::path::Path,
    owner: &str,
    profile: &mut Option<Profile>,
    empty_revision: &mut u64,
) -> Result<bool> {
    let checkpoint_path = profile_path.with_file_name("activation-rollback.json");
    let revision_path = profile_path.with_file_name("revision-floor.json");
    let Some(checkpoint) = storage::read::<Value>(&checkpoint_path)?
        .map(stored_checkpoint)
        .transpose()?
    else {
        return Ok(false);
    };
    if let Some(mut previous) = checkpoint.previous {
        if previous.owner_sid != owner
            || profile_hash(&previous.config, previous.capture.as_ref()) != previous.hash
        {
            return Err(ApiError::new(
                "STATE_INTEGRITY",
                "Activation checkpoint does not match its owner or hash.",
            ));
        }
        normalize_config(previous.config.clone())?;
        previous.display_names.validate(&previous.config)?;
        capture::validate(previous.capture.as_ref(), &previous.config)?;
        previous.revision = advance_revision(
            profile
                .as_ref()
                .map(|p| p.revision)
                .unwrap_or(0)
                .max(*empty_revision)
                .max(checkpoint.next_revision),
        )?;
        storage::write(profile_path, &previous)?;
        *profile = Some(previous);
    } else {
        *empty_revision = advance_revision(
            (*empty_revision)
                .max(profile.as_ref().map(|p| p.revision).unwrap_or(0))
                .max(checkpoint.next_revision),
        )?;
        storage::write(&revision_path, empty_revision)?;
        storage::remove(profile_path)?;
        *profile = None;
    }

    storage::remove(&checkpoint_path)?;
    Ok(true)
}
fn profile_hash(config: &Value, capture: Option<&Plan>) -> String {
    if let Some(plan) = capture {
        config_hash(&json!({"config":config,"capture":plan}))
    } else {
        config_hash(config)
    }
}
pub fn config_hash(config: &Value) -> String {
    crate::system_native::hex(&Sha256::digest(serde_json::to_vec(config).unwrap()))
}
fn tcp_listeners(config: &Value) -> Vec<SocketAddr> {
    listener_endpoints(config)
        .into_iter()
        .filter(|e| e.network == ListenerNetwork::Tcp)
        .map(|e| {
            let mut address = e.address;
            if address.ip().is_unspecified() {
                address.set_ip(if address.is_ipv4() {
                    std::net::Ipv4Addr::LOCALHOST.into()
                } else {
                    std::net::Ipv6Addr::LOCALHOST.into()
                });
            }
            address
        })
        .collect()
}
fn check_endpoint(endpoint: ListenerEndpoint) -> Result<()> {
    if crate::sockets::listeners()?
        .iter()
        .any(|row| row.endpoint.overlaps(endpoint))
    {
        return Err(ApiError::new(
            "PORT_IN_USE",
            format!(
                "{:?} listener {} overlaps an occupied socket. No process was stopped.",
                endpoint.network, endpoint.address
            ),
        ));
    }
    let available = match endpoint.network {
        ListenerNetwork::Tcp => TcpListener::bind(endpoint.address).map(|_| ()),
        ListenerNetwork::Udp => UdpSocket::bind(endpoint.address).map(|_| ()),
    };
    available.map_err(|error| {
        ApiError::new(
            if error.kind() == std::io::ErrorKind::AddrInUse {
                "PORT_IN_USE"
            } else {
                "LISTENER_BIND_FAILED"
            },
            format!(
                "Cannot bind {:?} listener {}: {error}. No process was stopped.",
                endpoint.network, endpoint.address
            ),
        )
    })
}
impl Kernel {
    pub(crate) fn subscription_profile(&self) -> crate::subscriptions::RuntimeSource {
        crate::subscriptions::RuntimeSource {
            revision: self.revision(),
            hash: self.profile.as_ref().map(|p| p.hash.clone()),
            source_hash: self
                .profile
                .as_ref()
                .and_then(|p| p.source_graph.as_ref())
                .map(|s| config_hash(&json!(s))),
            running: self.core_state == CoreState::Running,
            wants_running: self.recovery.wants_running(),
        }
    }
    pub(crate) fn subscription_source_graph(
        &self,
    ) -> Result<Option<(String, u64, String, String)>> {
        self.profile
            .as_ref()
            .filter(|p| p.source_graph.is_some())
            .map(|p| {
                Ok((
                    crate::subscriptions::vault::unprotect_graph(
                        p.source_graph.as_deref().unwrap(),
                    )?,
                    p.revision,
                    p.hash.clone(),
                    config_hash(&json!(p.source_graph)),
                ))
            })
            .transpose()
    }
    pub(crate) fn subscription_candidate_hash(candidate: &Value) -> Result<String> {
        let config = normalize_config(candidate["config"].clone())?;
        let capture: Option<Plan> = serde_json::from_value(candidate["capture"].clone())
            .map_err(|_| ApiError::new("SUBSCRIPTION_GRAPH", "Invalid compiled capture plan."))?;
        Ok(profile_hash(&config, capture.as_ref()))
    }
    pub(crate) fn subscription_verify(&self, candidate: &Value, revision: u64) -> Result<()> {
        let profile = self
            .profile
            .as_ref()
            .filter(|p| p.revision == revision)
            .ok_or_else(|| ApiError::new("REVISION_CONFLICT", "The applied graph changed."))?;
        if Self::subscription_candidate_hash(candidate)? != profile.hash {
            return Err(ApiError::new(
                "SUBSCRIPTION_GRAPH",
                "The graph does not match the applied configuration.",
            ));
        }
        Ok(())
    }
    pub(crate) fn subscription_proxy_port(&self) -> Result<u16> {
        if self.core_state == CoreState::Running {
            if let Some(profile) = &self.profile {
                for input in profile.config["inbounds"].as_array().into_iter().flatten() {
                    if let Some(port) = input["port"].as_u64().and_then(|p| u16::try_from(p).ok()) {
                        if wayrill_protocol::http_proxy_port(&profile.config, port) {
                            return Ok(port);
                        }
                    }
                }
            }
        }
        Err(ApiError::new(
            "SUBSCRIPTION_PROXY",
            "Start a plain HTTP-compatible loopback proxy inbound to download through Wayrill.",
        ))
    }
    pub(crate) fn retain_test_reservation(
        &mut self,
        reservation: Option<crate::operation_gate::Foreground>,
    ) {
        self.outbound_tests.retain_reservation(reservation);
    }
    pub(crate) fn subscription_test(&mut self, method: &str, input: Value) -> Result<Value> {
        if self.resources.snapshot()["busy"] == true {
            return Err(ApiError::new("BUSY", "Resource files are being updated."));
        }
        let egress = self.outbound_egress().ok();
        self.outbound_tests
            .handle(method, input, self.exe.clone(), String::new(), egress, None)
    }
    pub fn new(owner: String, base: PathBuf, data: PathBuf, events: Arc<Events>) -> Result<Self> {
        let profile_path = data.join("profile.json");
        let (mut profile, saved_revision, mut profile_recovery) =
            load_profile(&profile_path, &owner)?;
        let revision_path = data.join("revision-floor.json");
        let mut empty_revision = storage::read::<u64>(&revision_path)?
            .unwrap_or(0)
            .max(saved_revision);
        if recover_checkpoint(&profile_path, &owner, &mut profile, &mut empty_revision)? {
            profile_recovery = None;
            events.publish(
                "config.recovered",
                json!({"revision":profile.as_ref().map(|p|p.revision),"coreStopped":true}),
            );
        }
        if profile.as_ref().is_some_and(|p| p.owner_sid != owner) {
            return Err(ApiError::new(
                "OWNER_MISMATCH",
                "The protected profile belongs to another installation owner.",
            ));
        }
        if let Some(p) = &profile {
            if profile_hash(&p.config, p.capture.as_ref()) != p.hash {
                return Err(ApiError::new(
                    "STATE_INTEGRITY",
                    "Protected profile hash mismatch.",
                ));
            }
            normalize_config(p.config.clone())?;
            p.display_names.validate(&p.config)?;
            capture::validate(p.capture.as_ref(), &p.config)?;
        }
        let service_exe =
            std::env::current_exe().map_err(|e| ApiError::io("Find service executable", e))?;
        let statistics = Traffic::new(&owner, data.join("traffic-totals.json"))?;
        let startup = crate::startup::Startup::new(&owner, data.join("startup.json"))?;
        let mut recovery =
            crate::recovery::Supervisor::new(&owner, data.join("routing-intent.json"))?;
        let session = crate::startup::session::Session::open()?;
        // A new Windows boot is explicit saved auto-start authorization. A
        // service crash/restart or installer handoff cannot re-arm a user Stop.
        if startup.requests_boot_start(
            session.is_new,
            data.join("upgrade-resume.json")
                .try_exists()
                .map_err(|e| ApiError::io("Inspect upgrade handoff", e))?,
        ) {
            recovery.request(crate::recovery::Origin::Boot)?;
        }
        // Commit after durable Running intent, so an interrupted initialization
        // cannot consume this boot's auto-start before recording it.
        session.acknowledge()?;
        let mut kernel = Self {
            protection: crate::app_protection::Manager::open(
                &owner,
                data.join("app-protection.json"),
            )?,
            subscriptions: crate::subscriptions::Manager::open(
                &owner,
                data.join("subscriptions.dpapi"),
                events.clone(),
            ),
            startup,
            recovery,
            network: crate::tun::network::Monitor::default(),
            resources: crate::resources::Manager::new(
                base.join("xray"),
                data.clone(),
                events.clone(),
            )?,
            outbound_tests: crate::outbound_tests::Manager::new(),
            direct_egress: None,
            loopback_policy: None,
            core_resource_generation: 0,
            resource_reload: None,
            resource_issues: crate::resource_rules::Report::default(),
            resource_issues_generation: 0,
            proxy: ProxyManager::new(&owner, service_exe, &data),
            owner,
            exe: base.join("xray").join("xray.exe"),
            profile_path,
            profile,
            empty_revision,
            profile_recovery,
            core: None,
            fake_dns: None,
            fake_dns_usage: None,
            tun: crate::tun::Manager::new(&data, base.join("attribution"))?,
            observation: None,
            statistics,
            statistics_bridge: None,
            control: None,
            core_state: CoreState::Stopped,
            health_fault: None,
            lifecycle: None,
            generation: 0,
            last_error: None,
            divert: DivertManager::new(base.join("windivert")),
            driver: crate::driver::Driver::new(base.join("windivert")),
            runtime_capture: None,
            bootstrap_cache: None,
            capture: capture::Manager::new(
                base.join("capture"),
                data.join("capture-interfaces.json"),
            )?,
            events,
            started: Instant::now(),
            shutting_down: false,
            user_settings_retry: None,
            user_settings_error: None,
        };
        // Keep proven assignments while Running intent is recovered or unresolved.
        // Only a known Stopped state authorizes ordinary orphan restoration.
        if let Err(error) =
            if kernel.recovery.retain_assignments() && kernel.profile_recovery.is_none() {
                kernel.proxy.check_owned()
            } else {
                kernel.proxy.restore_all()
            }
        {
            kernel.events.publish(
                "system.captureRecovery",
                json!({"error":error,"status":kernel.proxy.status()}),
            );
        }
        Ok(kernel)
    }
    pub fn revision(&self) -> u64 {
        self.profile
            .as_ref()
            .map(|p| p.revision)
            .unwrap_or(0)
            .max(self.empty_revision)
    }
    fn fake_dns_status(&self) -> Value {
        if self.core_state != CoreState::Running {
            return Value::Null;
        }
        if let Some(pool) = &self.fake_dns {
            return json!({"pid":pool.pid(),"usage":pool.usage()});
        }
        self.fake_dns_usage
            .as_ref()
            .filter(|(generation, sampled, _)| {
                *generation == self.generation && sampled.elapsed() < Duration::from_secs(10)
            })
            .map(|(_, _, usage)| json!({"pid":null,"usage":usage}))
            .unwrap_or(Value::Null)
    }
    pub fn snapshot(&self) -> Value {
        json!({"appProtection":self.protection.summary(),"serviceVersion":env!("CARGO_PKG_VERSION"),"apiVersion":1,"instanceId":self.events.instance_id,"ownerSid":self.owner,"uptimeSeconds":self.started.elapsed().as_secs(),"config":{"present":self.profile.is_some(),"revision":self.revision(),"sha256":self.profile.as_ref().map(|p|&p.hash),"recoveryError":self.profile_recovery},"startup":self.startup.snapshot(self.recovery.boot_waiting()),"lifecycle":self.lifecycle,"recovery":self.recovery.snapshot(),"core":{"userSid":self.core.as_ref().map(|c|&c.user_sid),"state":self.core_state,"failureSource":self.health_fault,"pid":self.core.as_ref().map(|c|c.pid),"generation":self.generation,"version":crate::native::XRAY_VERSION,"lastError":self.last_error},"winDivert":self.divert.status(),"capture":self.capture.status(),"tun":self.tun.status(),"fakeDns":self.fake_dns_status(),"network":self.network.snapshot(),"tunAdapters":self.tun.adapter_preferences().ok(),"systemProxy":self.proxy.status(),"systemCapture":self.proxy.extras.summary(),"userSettings":{"waitingForUser":self.proxy.user_deferred(),"lastError":self.user_settings_error.as_ref().filter(|_|self.proxy.user_deferred())},"traffic":self.statistics.snapshot(),"observation":self.observation.as_ref().filter(|(generation, time, _)| *generation == self.generation && self.core_state == CoreState::Running && time.elapsed() < Duration::from_secs(10)).map(|(_, _, value)| value),"resources":self.resource_status()})
    }
    fn hello(&self) -> Value {
        json!({"serviceVersion":env!("CARGO_PKG_VERSION"),"apiVersion":1,"instanceId":self.events.instance_id,"capabilities":["service.sync","subscriptions.service","subscriptions.replace","service.startup","resources.management","resources.browse","xray.lifecycle","xray.routingLive","config.refreshOutbounds","windows.tun","windows.tun.adapters","windows.tun.applications","windows.tun.fakedns","windows.tun.nat","windows.tun.sharing","windows.ics.graph","xray.observatory","xray.statistics","xray.routingLog","xray.statistics.pages","xray.statistics.sorting","xray.statistics.reset","outbounds.testing","outbounds.interfaces","xray.nativeImport","xray.protocols","config.validate","config.apply","config.applyAndStart","config.displayNames","events.replay","windivert.sniffDiagnostic","windivert.routing","windivert.ruleProcesses","windows.catalog","windows.loopback","system.capture","system.capture.diagnostics","system.capture.scope","windivert.maintenance"],"notImplemented":["firewallRules","coreAutoUpdate","fullGraphCompilation"],"protocols":{"inbound":wayrill_protocol::INBOUND_PROTOCOLS,"outbound":wayrill_protocol::OUTBOUND_PROTOCOLS,"adapterRuntime":true},"maxFrameBytes":wayrill_protocol::MAX_FRAME,"maxConfigBytes":wayrill_protocol::MAX_CONFIG,"maxOutbounds":wayrill_protocol::MAX_OUTBOUNDS,"maxRoutingRules":wayrill_protocol::MAX_ROUTING_RULES})
    }
    fn config_view(&self) -> Value {
        json!({"revision":self.revision(),"config":self.profile.as_ref().map(|p|&p.config),"capture":self.profile.as_ref().and_then(|p|p.capture.as_ref()),"displayNames":self.profile.as_ref().map(|p|&p.display_names)})
    }
    fn resource_status(&self) -> Value {
        let mut result = self.resources.snapshot();
        result["reloadError"] = json!(self
            .resource_reload
            .as_ref()
            .filter(|reload| reload.generation == self.resources.generation()
                && reload.generation != self.core_resource_generation)
            .map(|reload| &reload.error));
        // A committed projection describes one DAT generation. Do not use stale
        // missing-group notices to disable editor rules after files change.
        let current = self.resource_issues_generation == self.resources.generation();
        result["skippedSelectorCount"] = json!(if current {
            self.resource_issues.skipped_selector_count
        } else {
            0
        });
        result["skippedSelectors"] = if current {
            json!(self.resource_issues.skipped_selectors)
        } else {
            json!([])
        };
        result["restartRequired"] = json!(
            self.core.is_some() && self.core_resource_generation != self.resources.generation()
        );
        result["reloadPending"] =
            json!(self.resources.reload_generation() > self.core_resource_generation);
        result
    }
    fn changed(&self, kind: &str) {
        self.events.publish(kind, self.snapshot());
    }
    fn progress(&mut self, stage: crate::lifecycle::Stage) {
        if let Some(progress) = &mut self.lifecycle {
            progress.advance(stage);
            self.changed("runtime.progress");
        }
    }
    fn begin_progress(&mut self, operation: crate::lifecycle::Operation) {
        self.lifecycle = Some(crate::lifecycle::Progress::new(operation));
        self.changed("runtime.progress");
    }
    fn end_progress(&mut self) {
        self.lifecycle = None;
        self.changed("runtime.progress");
    }
    fn outbound_egress(&self) -> Result<crate::tun::OutboundEgress> {
        if self.core.is_some() {
            if let Some(selection) = &self.direct_egress {
                return Ok(selection.clone());
            }
        }
        self.tun.outbound_egress()
    }
    pub fn handle(&mut self, method: &str, input: Value) -> Result<Value> {
        let events = self.events.clone();
        crate::activity::with_events(events, || self.handle_observed(method, input))
    }
    fn handle_observed(&mut self, method: &str, input: Value) -> Result<Value> {
        use crate::lifecycle::Operation;
        let operation = match method {
            "config.applyAndStart" | "config.refreshOutbounds" => Some(Operation::Apply),
            "core.start" => Some(Operation::Start),
            "core.restart" => Some(Operation::Restart),
            "core.stop" | "core.stopForUpgrade" => Some(Operation::Stop),
            _ => None,
        };
        if let Some(operation) = operation {
            self.begin_progress(operation);
        }
        let result = self.handle_request(method, input);
        if operation.is_some() {
            self.end_progress();
            // The reply must include the terminal state, not a snapshot taken
            // inside the operation while its progress was still active.
            return result.map(|_| self.snapshot());
        }
        result
    }
    fn handle_request(&mut self, method: &str, input: Value) -> Result<Value> {
        if matches!(
            method,
            "config.apply"
                | "config.applyAndStart"
                | "config.refreshOutbounds"
                | "core.start"
                | "core.restart"
        ) && self
            .profile_path
            .with_file_name("upgrade-resume.json")
            .exists()
        {
            return Err(ApiError::new("UPGRADE_RECOVERY_PENDING", "The update is restoring previous routing and Windows settings automatically. Stop cancels that recovery before applying another configuration."));
        }
        if self.protection.upgrading()
            && crate::operation_gate::requires_foreground(method)
            && !matches!(method, "core.stop" | "core.stopForUpgrade")
        {
            return Err(ApiError::new("UPGRADE_IN_PROGRESS", "Wayrill is being updated. Routing and app protection are held for the replacement service."));
        }
        if self.shutting_down {
            return Err(ApiError::new(
                "SERVICE_STOPPING",
                "The service is shutting down.",
            ));
        }
        if method.starts_with("subscriptions.") {
            return self.subscriptions.handle(method, input);
        }
        if method.starts_with("outbounds.test") {
            if method == "outbounds.testStart" && self.resources.snapshot()["busy"] == true {
                return Err(ApiError::new(
                    "BUSY",
                    "Wait for the resource update to finish.",
                ));
            }
            let egress = (method == "outbounds.testStart")
                .then(|| self.outbound_egress().ok())
                .flatten();
            let active = if method == "outbounds.testStart"
                && input["mode"] == "speed"
                && self.core_state == CoreState::Running
            {
                self.control
                    .as_ref()
                    .zip(self.profile.as_ref())
                    .map(|(control, profile)| crate::outbound_tests::ActivePolicy {
                        control: control.clone(),
                        config: Arc::new(profile.config.clone()),
                    })
            } else {
                None
            };
            return self.outbound_tests.handle(
                method,
                input,
                self.exe.clone(),
                self.owner.clone(),
                egress,
                active,
            );
        }
        if method.starts_with("resources.") {
            let proxy_port = self.subscription_proxy_port().ok();
            self.resources.set_proxy_port(proxy_port);
            if self.outbound_tests.busy()
                && [
                    "resources.update",
                    "resources.ensure",
                    "resources.uploadCommit",
                ]
                .contains(&method)
            {
                return Err(ApiError::new(
                    "BUSY",
                    "Wait for outbound tests to finish before changing resource files.",
                ));
            }
            let mut result = self.resources.handle(method, input)?;
            if result.get("generation").is_some() {
                result = self.resource_status();
            }
            return Ok(result);
        }
        if [
            "config.validate",
            "config.apply",
            "config.applyAndStart",
            "config.refreshOutbounds",
            "core.start",
            "core.restart",
            "startup.set",
        ]
        .contains(&method)
            && self.resources.snapshot()["busy"] == true
        {
            return Err(ApiError::new(
                "BUSY",
                "Wait for the resource update to finish.",
            ));
        }
        match method {
            "appProtection.get" => {
                let _: Empty = params(input)?;
                Ok(self.protection.snapshot())
            }
            "appProtection.set" => {
                let request = params(input)?;
                let base = self.exe.parent().unwrap().parent().unwrap().to_path_buf();
                let value = self.protection.set(request, &base)?;
                self.changed("appProtection.changed");
                Ok(value)
            }
            "core.stopForUpgrade" => {
                let _: Empty = params(input)?;
                // Unlike explicit Stop, installer retirement must not release
                // applications between stopping this service and its successor.
                if self.core.is_some() || self.recovery.wants_running() || self.protection.blocked()
                {
                    if self.protection.enabled() {
                        self.progress(crate::lifecycle::Stage::ProtectApps);
                    }
                    self.protection.arm(crate::app_protection::Phase::Upgrade)?;
                }
                self.subscriptions.stop_replacements();
                self.recovery.stop()?;
                self.network.cancel();
                self.stop_core()?;
                Ok(self.snapshot())
            }
            "tun.sharing.get" => {
                let _: Empty = params(input)?;
                self.tun.sharing_inspect()
            }
            "tun.sharing.keep" => {
                let p: crate::tun::sharing::Keep = params(input)?;
                if self.core.is_some() {
                    return Err(ApiError::new(
                        "ICS_RUNNING",
                        "Stop routing before keeping current sharing settings.",
                    ));
                }
                self.tun.sharing_keep(&p.expected_version)?;
                self.recovery.stop()?;
                self.stop_core()?;
                Ok(self.snapshot())
            }
            "tun.sharing.restore" => {
                let _: Empty = params(input)?;
                self.recovery.stop()?;
                self.stop_core()?;
                self.tun.restore_sharing()?;
                Ok(self.snapshot())
            }
            "tun.adapters.get" => {
                let _: Empty = params(input)?;
                self.tun.adapter_inspect()
            }
            "tun.adapters.set" => {
                let value: crate::tun::adapters::Preferences = params(input)?;
                if self.core.is_some() || self.tun.status()["state"] != "stopped" {
                    return Err(ApiError::new(
                        "TUN_RUNNING",
                        "Stop routing before changing adapter management.",
                    ));
                }
                self.tun.adapter_set(value)?;
                self.changed("tun.adapters.changed");
                self.tun.adapter_inspect()
            }
            "tun.adapters.remove" => {
                let value: crate::tun::adapters::Remove = params(input)?;
                if self.core.is_some() {
                    return Err(ApiError::new(
                        "TUN_RUNNING",
                        "Stop routing before removing adapters.",
                    ));
                }
                self.tun.adapter_remove(value)?;
                self.changed("tun.adapters.changed");
                self.tun.adapter_inspect()
            }
            "outbounds.interfaces" => {
                let _: Empty = params(input)?;
                let selection = self.outbound_egress();
                Ok(
                    json!({"adapters":self.tun.outbound_interfaces()?, "automatic":selection.as_ref().ok().map(|s| &s.uplink), "captured":selection.as_ref().ok().is_some_and(|s| s.captured), "loopback":selection.as_ref().ok().map(|s| &s.loopback),
                    "error":selection.err().map(|e| e.message)}),
                )
            }
            "tun.interfaces" => {
                let _: Empty = params(input)?;
                self.tun.interfaces()
            }
            "service.hello" => {
                let _: Empty = params(input)?;
                let mut hello = self.hello();
                hello["capabilities"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("windows.appProtection"));
                Ok(hello)
            }
            "service.sync" => {
                let _: Empty = params(input)?;
                Ok(self.subscriptions.synchronized(|subscriptions| {
                    json!({"snapshot":self.snapshot(),"profile":self.config_view(),
                        "hello":self.hello(),"subscriptions":subscriptions,"sequence":self.events.sequence()})
                }))
            }
            "startup.set" => {
                let change: crate::startup::Change = params(input)?;
                if change.enabled {
                    if change.expected_revision != self.revision() {
                        return Err(ApiError::new(
                            "REVISION_CONFLICT",
                            "Applied configuration changed. Refresh before enabling startup.",
                        ));
                    }
                    let profile = self.profile.as_ref().ok_or_else(|| {
                        ApiError::new(
                            "NO_CONFIG",
                            "Apply a working configuration before enabling startup.",
                        )
                    })?;
                    crate::tun::validate(&profile.config)?;
                    let projection = self.resources.project(&profile.config)?;
                    validate_core(&self.exe, CoreIdentity::LocalService, &projection.config)
                        .map_err(|e| {
                            ApiError::new(
                                "BOOT_CONFIG_INVALID",
                                format!(
                                    "The applied configuration cannot run as LocalService. {}",
                                    e.message
                                ),
                            )
                        })?;
                }
                self.startup.set(change.enabled)?;
                if !change.enabled && self.recovery.boot_waiting() && self.core.is_none() {
                    self.recovery.stop()?;
                }
                self.changed("startup.changed");
                Ok(self.snapshot())
            }
            "service.status" => {
                let _: Empty = params(input)?;
                self.capture.refresh_availability(false);
                self.tick();
                Ok(self.snapshot())
            }
            "routing.log" => {
                let p: crate::routing_log::Request = params(input)?;
                p.validate()?;
                Ok(self
                    .events
                    .routing
                    .snapshot(&p.filter_id, &self.events.instance_id))
            }
            "traffic.get" => {
                let _: Empty = params(input)?;
                Ok(self.statistics.snapshot())
            }
            "traffic.endpoints" => {
                let p: EndpointPageInput = params(input)?;
                self.statistics.endpoints(
                    p,
                    self.profile
                        .as_ref()
                        .map(|profile| (profile.revision, &profile.display_names)),
                )
            }
            "traffic.reset" => {
                let _: Empty = params(input)?;
                self.statistics.reset()?;
                self.changed("traffic.reset");
                Ok(self.statistics.snapshot())
            }
            "traffic.history" => {
                let _: Empty = params(input)?;
                Ok(self.statistics.history())
            }
            "config.get" => {
                let _: Empty = params(input)?;
                Ok(self.config_view())
            }
            "config.validate" => {
                let p: ConfigInput = params(input)?;
                let config = normalize_config(p.config)?;
                capture::validate(p.capture.as_ref(), &config)?;
                if let Some(plan) = &p.capture {
                    self.capture.preflight(plan)?;
                }
                crate::tun::validate(&config)?;
                let projection = self.resources.project(&config)?;
                validate_core(&self.exe, self.identity(), &projection.config)?;
                require_recovered(&self.profile_path)?;
                self.tun.preflight(&config, p.capture.as_ref())?;
                Ok(
                    json!({"valid":true,"sha256":config_hash(&config),"resourceWarnings":projection.report,"normalization":["Access-file logging disabled; diagnostic output captured by the service."]}),
                )
            }
            "config.apply" => {
                let mut p: ApplyInput = params(input)?;
                if let Some(token) = p.source_graph_token.take() {
                    if p.source_graph.is_some() {
                        return Err(ApiError::new(
                            "INVALID_PARAMS",
                            "Supply one source graph representation.",
                        ));
                    }
                    p.source_graph = Some(self.subscriptions.take_source(&token)?);
                }
                if p.expected_revision != self.revision() {
                    return Err(ApiError::new(
                        "REVISION_CONFLICT",
                        "Configuration changed. Fetch config.get before applying.",
                    ));
                }
                if self.core.is_some() {
                    return Err(ApiError::new(
                        "BUSY",
                        "Stop Xray before applying a different configuration.",
                    ));
                }
                let config = normalize_config(p.config)?;
                p.display_names.validate(&config)?;
                capture::validate(p.capture.as_ref(), &config)?;
                if let Some(plan) = &p.capture {
                    self.capture.preflight(plan)?;
                }
                crate::tun::validate(&config)?;
                let projection = self.resources.project(&config)?;
                validate_core(&self.exe, self.identity(), &projection.config)?;
                require_recovered(&self.profile_path)?;
                self.tun.preflight(&config, p.capture.as_ref())?;
                let profile = Profile {
                    source_graph: p
                        .source_graph
                        .as_deref()
                        .map(crate::subscriptions::vault::protect_graph)
                        .transpose()?,
                    owner_sid: self.owner.clone(),
                    revision: advance_revision(self.revision())?,
                    hash: profile_hash(&config, p.capture.as_ref()),
                    capture: p.capture,
                    display_names: p.display_names,
                    config,
                };
                self.recovery.stop()?;
                storage::write(&self.profile_path, &profile)?;
                self.network.cancel();
                self.profile = Some(profile);
                self.resource_issues = projection.report;
                self.resource_issues_generation = self.resources.generation();
                self.profile_recovery = None;
                self.last_error = None;
                self.changed("config.applied");
                Ok(self.snapshot())
            }
            "config.applyAndStart" | "config.refreshOutbounds" => {
                let mut p: ActivateInput = params(input)?;
                if let Some(token) = p.source_graph_token.take() {
                    if p.source_graph.is_some() {
                        return Err(ApiError::new(
                            "INVALID_PARAMS",
                            "Supply one source graph representation.",
                        ));
                    }
                    p.source_graph = Some(self.subscriptions.take_source(&token)?);
                }
                if method == "config.refreshOutbounds" {
                    let next = normalize_config(p.config.clone())?;
                    let previous = self.profile.as_ref().ok_or_else(|| {
                        ApiError::new("NO_CONFIG", "No running graph to refresh.")
                    })?;
                    if self.core_state != CoreState::Running
                        || self
                            .core
                            .as_ref()
                            .is_none_or(|core| !matches!(core.exit_code(), Ok(None)))
                    {
                        return Err(ApiError::new(
                            "NOT_RUNNING",
                            "Routing stopped; the updated outbounds remain in the graph draft.",
                        ));
                    }
                    if !crate::live::target_refresh(&previous.config, &next)
                        || serde_json::to_value(&previous.capture).ok()
                            != serde_json::to_value(&p.capture).ok()
                    {
                        return Err(ApiError::new("OUTBOUND_REFRESH_SCOPE","Apply other graph changes explicitly before refreshing running outbounds."));
                    }
                }
                self.activate(p, ActivationKind::Apply)?;
                Ok(self.snapshot())
            }
            "core.start" | "core.restart" => {
                let p: Revision = params(input)?;
                if p.revision != self.revision() {
                    return Err(ApiError::new(
                        "REVISION_CONFLICT",
                        "Start requires the current configuration revision.",
                    ));
                }
                require_recovered(&self.profile_path)?;
                let profile = self.profile.clone().ok_or_else(|| {
                    ApiError::new("NO_CONFIG", "Apply a configuration before starting.")
                })?;
                self.recovery.request(crate::recovery::Origin::Manual)?;
                if method == "core.start"
                    && self.healthy_runtime(&profile.config, profile.capture.as_ref())?
                {
                    self.proxy.check_owned()?;
                    self.recovery.healthy(Instant::now())?;
                    self.protection.ready()?;
                    return Ok(self.snapshot());
                }
                self.activate(
                    ActivateInput {
                        source_graph_token: None,
                        source_graph: None,
                        config: profile.config,
                        capture: profile.capture,
                        display_names: profile.display_names,
                        expected_revision: p.revision,
                    },
                    ActivationKind::Restart,
                )?;
                Ok(self.snapshot())
            }
            "core.stop" => {
                let p: StopInput = params(input)?;
                self.subscriptions.stop_replacements();
                storage::remove(&self.profile_path.with_file_name("upgrade-resume.json"))?;
                let intent = self.recovery.stop();
                self.network.cancel();
                let retirement = self.stop_core_with_sharing(if p.disable_sharing {
                    SharingExit::Disable
                } else {
                    SharingExit::Native
                });
                let mut cleanup = Cleanup::default();
                cleanup.record("cancel automatic recovery", intent);
                cleanup.record("explicit routing stop", retirement);
                cleanup.record("release app protection", self.protection.release());
                let result = cleanup.finish();
                if let Err(error) = &result {
                    self.recovery
                        .retirement_failed(error.clone(), Instant::now());
                }
                result?;
                Ok(self.snapshot())
            }
            "windows.catalog" | "windows.loopback.get" => {
                let _: Empty = params(input)?;
                let mut result = self.capture.once(
                    if method == "windows.catalog" {
                        "catalog"
                    } else {
                        "loopback.get"
                    },
                    json!({"ownerSid":self.owner}),
                )?;
                if method == "windows.catalog" {
                    let excluded = self.tun.excluded_capture_interfaces()?;
                    result["excludedCaptureInterfaces"] = json!(excluded);
                    if let Some(adapters) = result["interfaces"].as_array_mut() {
                        for adapter in adapters {
                            let owned = adapter["id"].as_str().is_some_and(|id| {
                                excluded.iter().any(|ours| {
                                    ours.eq_ignore_ascii_case(id.trim_matches(['{', '}']))
                                })
                            });
                            adapter["captureExcluded"] = json!(owned);
                        }
                    }
                }
                Ok(result)
            }
            "windows.loopback.set" => {
                let p: capture::LoopbackChanges = params(input)?;
                if p.expected_version.len() != 64
                    || !p.expected_version.bytes().all(|b| b.is_ascii_hexdigit())
                    || p.changes.is_empty()
                    || p.changes.len() > 4096
                    || p.changes.iter().any(|c| {
                        c.family.trim().is_empty()
                            || c.family.len() > 256
                            || c.family.chars().any(char::is_control)
                    })
                {
                    return Err(ApiError::new("INVALID_PARAMS", "Invalid loopback changes."));
                }
                let result = self.capture.once("loopback.set",json!({"ownerSid":self.owner,"expectedVersion":p.expected_version,"changes":p.changes}))?;
                self.events.publish(
                    "windows.loopbackChanged",
                    json!({"changed":p.changes.len()}),
                );
                Ok(result)
            }
            "windivert.startDiagnostic" => {
                if self.capture.status()["state"] == "running" {
                    return Err(ApiError::new(
                        "BUSY",
                        "Stop the routing core before starting a packet diagnostic.",
                    ));
                }
                let p: Port = params(input)?;
                self.capture.check_available()?;
                self.divert.start(p.port)?;
                self.changed("windivert.changed");
                Ok(self.snapshot())
            }
            "windivert.stop" => {
                let _: Empty = params(input)?;
                self.divert.stop()?;
                self.changed("windivert.changed");
                Ok(self.snapshot())
            }
            "system.capture.get" => {
                let _: Empty = params(input)?;
                let profile = self.profile.as_ref();
                let config = profile.map(|p| &p.config).cloned().unwrap_or(json!({}));
                let mut inputs = crate::system_settings::inputs(
                    &config,
                    profile.and_then(|p| p.capture.as_ref()),
                );
                for input in &mut inputs {
                    let tag = input["tag"].as_str().unwrap_or("");
                    input["label"] = json!(profile
                        .and_then(|p| p.display_names.inbound.get(tag))
                        .cloned()
                        .unwrap_or_else(|| tag.into()));
                }
                Ok(
                    json!({"rows":self.proxy.capture_status()?,"inputs":inputs,"revision":self.revision(),"running":self.core.is_some(),"capture":self.capture.status(),"tun":self.tun.status(),"fakeDns":self.fake_dns_status(),"network":self.network.snapshot(),"captureInputs":profile.and_then(|p|p.capture.as_ref()).map(|p|p.inputs.iter().map(|i|&i.tag).collect::<Vec<_>>()).unwrap_or_default(),"driver":self.driver.status()?}),
                )
            }
            "system.capture.diagnose" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Diagnose {
                    channel: crate::system_native::Channel,
                }
                let request: Diagnose = params(input)?;
                self.proxy.extras.diagnose(request.channel)
            }
            "system.capture.setScope" => {
                let request: crate::proxy::ScopeChange = params(input)?;
                if self.proxy.switch_scope(request)? {
                    self.changed("system.captureScopeChanged");
                }
                Ok(self.snapshot())
            }
            "system.capture.set" => {
                let request: crate::system_settings::Request = params(input)?;
                if request.mode == "proxy" && self.core.is_none() {
                    return Err(ApiError::new(
                        "INVALID_STATE",
                        "Apply & Start the selected proxy input before using it.",
                    ));
                }
                let profile = self.profile.as_ref();
                let config = profile.map(|p| p.config.clone()).unwrap_or(json!({}));
                let plan = profile.and_then(|p| p.capture.clone());
                self.proxy.set_capture(request, &config, plan.as_ref())?;
                self.changed("system.captureChanged");
                Ok(self.snapshot())
            }
            "system.capture.clear" | "system.capture.restore" | "system.capture.keepExternal" => {
                let action: crate::system_settings::Action = params(input)?;
                self.proxy
                    .capture_action(&action, method.rsplit('.').next().unwrap())?;
                self.changed("system.captureChanged");
                Ok(self.snapshot())
            }
            "system.capture.restoreAll" => {
                let _: Empty = params(input)?;
                self.proxy.restore_all()?;
                self.changed("system.captureChanged");
                Ok(self.snapshot())
            }
            "capture.start" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Start {
                    revision: u64,
                    input_tags: Vec<String>,
                }
                let p: Start = params(input)?;
                if p.revision != self.revision() {
                    return Err(ApiError::new(
                        "REVISION_CONFLICT",
                        "Applied capture changed; refresh.",
                    ));
                }
                if p.input_tags.is_empty() || p.input_tags.len() > 16 {
                    return Err(ApiError::new(
                        "INVALID_PARAMS",
                        "Choose one or more applied WinDivert inputs.",
                    ));
                }
                let core = self.core.as_ref().ok_or_else(|| {
                    ApiError::new(
                        "INVALID_STATE",
                        "Apply & Start the graph before enabling capture.",
                    )
                })?;
                let mut plan = self.runtime_capture.clone().ok_or_else(|| {
                    ApiError::new(
                        "INVALID_STATE",
                        "The running configuration has no WinDivert input.",
                    )
                })?;
                let inputs = plan["inputs"]
                    .as_array_mut()
                    .ok_or_else(|| ApiError::new("STATE_INTEGRITY", "No runtime capture plan."))?;
                if p.input_tags
                    .iter()
                    .any(|tag| !inputs.iter().any(|i| i["tag"].as_str() == Some(tag)))
                {
                    return Err(ApiError::new(
                        "INVALID_PARAMS",
                        "Capture input must belong to the applied graph.",
                    ));
                }
                inputs.retain(|i| {
                    p.input_tags
                        .iter()
                        .any(|tag| i["tag"].as_str() == Some(tag))
                });
                if self.divert.status()["state"] == "running" {
                    return Err(ApiError::new(
                        "BUSY",
                        "Stop the packet diagnostic before routing.",
                    ));
                }
                self.capture.check_available()?;
                let core_pids: Vec<_> = std::iter::once(core.pid)
                    .chain(self.tun.core_pids())
                    .collect();
                self.capture.start(
                    Some(plan),
                    &core_pids,
                    &self.tun.excluded_capture_interfaces()?,
                )?;
                self.changed("capture.changed");
                Ok(self.snapshot())
            }
            "capture.stop" => {
                let _: Empty = params(input)?;
                self.capture.stop()?;
                self.changed("capture.changed");
                Ok(self.snapshot())
            }
            "windivert.driver.install" | "windivert.driver.uninstall" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Maintenance {
                    expected_version: String,
                }
                let p: Maintenance = params(input)?;
                if self.capture.status()["state"] == "running"
                    || self.divert.status()["state"] == "running"
                {
                    return Err(ApiError::new(
                        "DRIVER_BUSY",
                        "Stop Wayrill capture and its diagnostic before driver maintenance.",
                    ));
                }
                self.capture.check_available()?; // Fresh foreign-handle/driver checks, never a driver open that installs.
                let result = if method.ends_with("install") && !method.ends_with("uninstall") {
                    self.driver.install(&p.expected_version)?
                } else {
                    self.driver.uninstall(&p.expected_version)?
                };
                self.capture.refresh_availability(true);
                self.changed("windivert.driverChanged");
                Ok(result)
            }
            _ => Err(ApiError::new(
                "METHOD_NOT_FOUND",
                "Unknown or unimplemented service method.",
            )),
        }
    }
    fn identity(&self) -> CoreIdentity<'_> {
        if self.startup.enabled() {
            CoreIdentity::LocalService
        } else {
            CoreIdentity::Owner(&self.owner)
        }
    }
    // A single protected upgrade receipt restores the previous running/stopped
    // state, independently of the permanent pre-sign-in startup preference.
    pub fn resume_upgrade(&mut self) -> bool {
        let data = self.profile_path.parent().unwrap().to_path_buf();
        let path = data.join("upgrade-resume.json");
        let raw = match storage::read::<Value>(&path) {
            Ok(None) => return false,
            Ok(Some(raw)) => raw,
            Err(error) => {
                self.last_error = Some(error);
                return true;
            }
        };
        let id = raw["transactionId"].as_str().unwrap_or("").to_owned();
        self.begin_progress(crate::lifecycle::Operation::Start);
        let mut result = (|| {
            // Keep the handoff until every scope is restored. Its version/CAS
            // checks remain authoritative across failed starts and service exits.
            if let Some(error) = &self.profile_recovery {
                return Err(error.clone());
            }
            let intent =
                crate::upgrade::validate(raw, &self.owner, self.revision(), &self.profile_path)?;
            self.proxy.check_owned()?;
            let settings = crate::upgrade::remaining(intent.settings, &self.proxy.requests()?)?;
            if intent.resume_routing {
                self.recovery
                    .request(crate::recovery::Origin::ServiceRecovery)?;
                let profile = self.profile.as_ref().ok_or_else(|| {
                    ApiError::new("NO_CONFIG", "The upgrade's applied profile is unavailable.")
                })?;
                self.proxy.preflight_requests(
                    &settings,
                    &profile.config,
                    profile.capture.as_ref(),
                )?;
                let projection = self.resources.project(&profile.config)?;
                validate_core(&self.exe, self.identity(), &projection.config)?;
                self.start_core()?;
            }
            let profile = self.profile.as_ref();
            let config = profile.map(|p| p.config.clone()).unwrap_or(json!({}));
            let plan = profile.and_then(|p| p.capture.clone());
            let resume_routing = intent.resume_routing;
            for request in settings {
                if request.mode == "proxy" && self.core.is_none() {
                    return Err(ApiError::new(
                        "UPGRADE_STATE",
                        "A stopped core cannot reclaim a manual proxy.",
                    ));
                }
                // Preserve the exact post-stop versions. An external edit
                // during installation must fail rather than be overwritten.
                self.proxy.set_capture(request, &config, plan.as_ref())?;
            }
            if resume_routing {
                self.recovery.healthy(Instant::now())?;
            }
            storage::remove(&path)?;
            self.protection.ready()?;
            Ok::<(), ApiError>(())
        })();
        if let Err(error) = &mut result {
            if let Err(recovery) = self.retire_core(Retirement::Fault(Fault::Core)) {
                error
                    .message
                    .push_str(&format!(" Recovery remains pending: {}", recovery.message));
            }
            self.recovery.fail(error.clone(), Instant::now());
            self.last_error = Some(error.clone());
            if self.core.is_none() {
                self.core_state = if self.profile_recovery.is_some() {
                    CoreState::Stopped
                } else {
                    CoreState::Failed
                };
            }
        }
        let receipt = json!({"transactionId":id,"ok":result.is_ok(),"error":result.err(),"core":self.core_state,"revision":self.revision(),"serviceVersion":env!("CARGO_PKG_VERSION")});
        if let Err(error) = storage::write(&data.join("upgrade-result.json"), &receipt) {
            self.last_error = Some(error);
        }
        self.end_progress();
        self.events.publish("upgrade.completed", receipt);
        true
    }
    pub fn resume_routing(&mut self) {
        // A committed Running intent survives both service and Windows restarts.
        // The pre-sign-in setting chooses the validated account, not whether an
        // intermittent failure is allowed to revoke the user's routing intent.
        if self.recovery.wants_running() && self.startup.enabled() {
            if let Err(error) = self.recovery.request(crate::recovery::Origin::Boot) {
                self.last_error = Some(error);
                return;
            }
        }
        self.retry_routing();
    }
    fn retry_routing(&mut self) {
        if self.shutting_down || self.protection.upgrading() || !self.recovery.due(Instant::now()) {
            return;
        }
        if self
            .profile_path
            .with_file_name("upgrade-resume.json")
            .exists()
        {
            self.resume_upgrade();
            return;
        }
        self.begin_progress(crate::lifecycle::Operation::Start);
        if let Some(progress) = &mut self.lifecycle {
            progress.recover();
        }
        self.changed("recovery.attempting");
        if let Err(error) = self.recovery.resolve_intent(Instant::now()) {
            self.last_error = Some(error);
            self.end_progress();
            self.changed("recovery.waiting");
            return;
        }
        let restoring_running = self.recovery.wants_running();
        let result = (|| {
            if !restoring_running {
                let intent = self.recovery.persist_stop();
                let retirement = self.tun.finish_retirement().and_then(|()| self.stop_core());
                let mut cleanup = Cleanup::default();
                cleanup.record("cancel automatic recovery", intent);
                cleanup.record("explicit routing stop", retirement);
                return cleanup.finish();
            }
            // Cleanup belongs to the prior transition. Finish it even when a
            // disabled-sharing/invalid-new-plan guard will prohibit activation.
            self.tun.finish_retirement()?;
            if let Some(error) = &self.profile_recovery {
                if error.code != "ACTIVATION_RECOVERY_FAILED" {
                    return Err(error.clone());
                }
            }
            if self
                .profile_path
                .with_file_name("activation-rollback.json")
                .exists()
            {
                // Keep a healthy capture barrier while replacing an uncertain
                // main-core table/handler update. A failed retention proof still
                // requires the existing ownership-guarded retirement path.
                let retain = self.profile.as_ref().is_some_and(|profile| {
                    self.tun
                        .can_replace(&profile.config, profile.capture.as_ref())
                        .unwrap_or(false)
                });
                self.retire_core(Retirement::Replace(
                    if retain {
                        RestartMode::PreserveNetwork
                    } else {
                        RestartMode::Reconfigure
                    },
                    SharingExit::Suspend,
                ))?;
                if recover_checkpoint(
                    &self.profile_path,
                    &self.owner,
                    &mut self.profile,
                    &mut self.empty_revision,
                )? {
                    self.profile_recovery = None;
                    self.changed("config.recovered");
                }
            }
            let profile = self.profile.clone().ok_or_else(|| {
                ApiError::new(
                    "NO_CONFIG",
                    "No applied configuration is available for recovery.",
                )
            })?;
            if profile
                .capture
                .as_ref()
                .is_some_and(|p| p.tun_sharing.is_some())
                && self.tun.status()["sharing"]["restoreNativeOnBoot"].as_bool() == Some(false)
            {
                return Err(ApiError::new(
                    "ICS_DISABLED",
                    "Internet sharing was disabled. Enable ICS TUN and Apply to resume sharing.",
                ));
            }
            self.activate(
                ActivateInput {
                    source_graph_token: None,
                    source_graph: None,
                    config: profile.config,
                    capture: profile.capture,
                    display_names: profile.display_names,
                    expected_revision: profile.revision,
                },
                ActivationKind::Restart,
            )
        })();
        if self.recovery.is_boot() {
            self.startup.attempted(&result);
        }
        if let Err(error) = &result {
            self.core_state = CoreState::Failed;
            self.last_error = Some(error.clone());
            if restoring_running {
                self.recovery.fail(error.clone(), Instant::now());
            } else {
                self.recovery
                    .retirement_failed(error.clone(), Instant::now());
            }
        } else if !restoring_running {
            self.recovery.stopped();
        }
        self.end_progress();
        self.changed(if result.is_ok() {
            "recovery.completed"
        } else {
            "recovery.waiting"
        });
    }
    fn prepare_bootstrap(&mut self, config: &Value) -> Result<Option<Value>> {
        // Recovery from a dead core must not send DNS through its retained relay.
        // Cache only belongs to this exact configuration and only to this service run.
        let cached = if self.core.is_none()
            && (self.capture.status()["state"] == "running"
                || self.tun.status()["state"] == "running")
        {
            self.bootstrap_cache
                .as_ref()
                .filter(|(hash, _)| *hash == config_hash(config))
                .map(|(_, hosts)| hosts.clone())
        } else {
            None
        };
        let projected = self.resources.project(config)?;
        let cached = cached
            .map(|hosts| self.resources.project(&json!({"dns":{"hosts":hosts}})))
            .transpose()?
            .map(|p| p.config["dns"]["hosts"].clone());
        crate::tun::bootstrap_hosts(&projected.config, cached.as_ref())
    }
    fn healthy_runtime(&mut self, config: &Value, capture: Option<&Plan>) -> Result<bool> {
        if self.core_state != CoreState::Running
            || self.core_resource_generation != self.resources.generation()
            || !self
                .core
                .as_ref()
                .is_some_and(|c| matches!(c.exit_code(), Ok(None)))
        {
            return Ok(false);
        }
        if self
            .fake_dns
            .as_ref()
            .is_some_and(|pool| pool.check().is_err())
        {
            return Ok(false);
        }
        self.capture.poll()?;
        if self.runtime_capture.is_some() && self.capture.status()["state"] != "running" {
            return Ok(false);
        }
        if config["inbounds"]
            .as_array()
            .is_some_and(|a| a.iter().any(|i| i["protocol"] == "tun"))
        {
            self.tun.can_replace(config, capture)
        } else {
            self.tun.poll()?;
            Ok(true)
        }
    }
    fn activate(&mut self, p: ActivateInput, kind: ActivationKind) -> Result<()> {
        if self.protection.upgrading() {
            return Err(ApiError::new(
                "UPGRADE_IN_PROGRESS",
                "Routing is paused for the Wayrill update.",
            ));
        }
        if p.expected_revision != self.revision() {
            return Err(ApiError::new(
                "REVISION_CONFLICT",
                "Configuration changed. Refresh before Apply & Start.",
            ));
        }
        require_recovered(&self.profile_path)?;
        let mut p = p;
        p.config = normalize_config(p.config)?;
        if let Some(source) = p.source_graph.as_deref() {
            let unchanged = self
                .profile
                .as_ref()
                .and_then(|p| p.source_graph.as_deref())
                .and_then(|value| crate::subscriptions::vault::unprotect_graph(value).ok())
                .as_deref()
                == Some(source);
            p.source_graph = if unchanged {
                self.profile.as_ref().and_then(|p| p.source_graph.clone())
            } else {
                Some(crate::subscriptions::vault::protect_graph(source)?)
            };
        }
        let config = &p.config;
        if kind == ActivationKind::Apply
            && self.profile.as_ref().is_some_and(|old| {
                old.hash == profile_hash(config, p.capture.as_ref())
                    && serde_json::to_value(&old.display_names).ok()
                        == serde_json::to_value(&p.display_names).ok()
            })
            && self.healthy_runtime(config, p.capture.as_ref())?
        {
            self.proxy.check_owned()?;
            self.recovery.healthy(Instant::now())?;
            self.protection.ready()?;
            if p.source_graph.is_some()
                && self
                    .profile
                    .as_ref()
                    .is_some_and(|old| old.source_graph != p.source_graph)
            {
                let mut updated = self.profile.clone().unwrap();
                updated.source_graph = p.source_graph;
                storage::write(&self.profile_path, &updated)?;
                self.profile = Some(updated);
            }
            return Ok(());
        }
        p.display_names.validate(config)?;
        capture::validate(p.capture.as_ref(), config)?;
        if let Some(plan) = &p.capture {
            self.capture.preflight(plan)?;
        }
        let capture_settings = self.proxy.requests()?;
        self.proxy
            .preflight_requests(&capture_settings, config, p.capture.as_ref())?;
        let result =
            crate::activation::execute(&mut KernelActivation::new(self, p, capture_settings, kind));
        if let Err(error) = result {
            if error.code == "ACTIVATION_RECOVERY_FAILED" {
                self.profile_recovery = Some(error.clone());
                self.last_error = Some(error.clone());
            }
            if self.core_state != CoreState::Running || error.code == "ACTIVATION_RECOVERY_FAILED" {
                if self.recovery.wants_running() {
                    self.recovery.fail(error.clone(), Instant::now());
                } else if error.code == "ACTIVATION_RECOVERY_FAILED" {
                    self.recovery
                        .retirement_failed(error.clone(), Instant::now());
                }
            }
            return Err(error);
        }
        self.recovery.healthy(Instant::now())?;
        Ok(())
    }
    fn start_core(&mut self) -> Result<()> {
        if self.core.is_some() {
            return Ok(());
        }
        if let Some(profile) = &self.profile {
            let config = self.network.configuration(&profile.config)?;
            self.tun.preflight(&config, profile.capture.as_ref())?;
        }
        self.progress(crate::lifecycle::Stage::Resolve);
        let hosts = self
            .profile
            .as_ref()
            .map(|p| p.config.clone())
            .as_ref()
            .map(|config| self.prepare_bootstrap(config))
            .transpose()?
            .flatten();
        self.start_core_with_hosts(hosts)
    }
    fn start_core_with_hosts(&mut self, bootstrap_hosts: Option<Value>) -> Result<()> {
        self.start_core_with_adapter(bootstrap_hosts, None)
    }
    fn start_core_with_adapter(
        &mut self,
        bootstrap_hosts: Option<Value>,
        retained: Option<crate::tun::RetainedAdapter>,
    ) -> Result<()> {
        self.start_core_with_runtime(bootstrap_hosts, retained, RestartMode::Reconfigure)
    }
    fn start_core_with_runtime(
        &mut self,
        bootstrap_hosts: Option<Value>,
        retained: Option<crate::tun::RetainedAdapter>,
        mode: RestartMode,
    ) -> Result<()> {
        self.protection
            .arm(crate::app_protection::Phase::Recovery)?;
        let mut retained = retained;
        let result = retry_private_listener(|attempt| {
            if attempt > 0 {
                self.events
                    .publish("core.privateListenerRetry", json!({"attempt":attempt + 1}));
            }
            self.start_core_attempt(bootstrap_hosts.clone(), &mut retained, mode)
        });
        if let Err(error) = &result {
            if self.core_state == CoreState::Starting {
                self.core_state = CoreState::Failed;
                self.last_error = Some(error.clone());
                self.changed("core.state");
            }
        }
        result
    }
    fn start_core_attempt(
        &mut self,
        bootstrap_hosts: Option<Value>,
        retained: &mut Option<crate::tun::RetainedAdapter>,
        mode: RestartMode,
    ) -> Result<()> {
        if self.core.is_some() {
            return Ok(());
        }
        let profile = self.profile.clone().ok_or_else(|| {
            ApiError::new(
                "NO_CONFIG",
                "Validate and apply a complete configuration first.",
            )
        })?;
        self.progress(crate::lifecycle::Stage::Prepare);
        if let Some(plan) = &profile.capture {
            self.capture.preflight(plan)?;
        }
        if mode == RestartMode::PreserveNetwork {
            self.tun.rename(&profile.config, profile.capture.as_ref())?;
        }
        let projection = self.resources.project(&profile.config)?;
        let mut network_config = self.network.configuration(&projection.config)?;
        let mut routing_log = crate::routing_log::instrument(
            &mut network_config,
            &profile.display_names,
            self.generation + 1,
            profile.revision,
        );
        self.tun
            .preflight(&network_config, profile.capture.as_ref())?;
        self.divert.stop()?;
        // A main-core failure can retain healthy capture. Release our old TUN
        // before selecting the next uplink; otherwise its own split routes win.
        if mode == RestartMode::Reconfigure {
            self.tun.retire(
                if profile.capture.as_ref().is_some_and(|p| p.sharing_disabled) {
                    SharingExit::Disable
                } else {
                    SharingExit::Suspend
                },
            )?;
        }
        let (mut runtime_config, worker_plan) =
            capture::instrument(profile.capture.as_ref(), &network_config)?;
        if let Some(hosts) = &bootstrap_hosts {
            if !runtime_config["dns"].is_object() {
                runtime_config["dns"] = json!({});
            }
            // Cached bootstrap hosts can predate a DAT update. Keep resolved
            // full: addresses, but do not reinsert now-unavailable selectors.
            let projected = self.resources.project(&json!({"dns":{"hosts":hosts}}))?;
            runtime_config["dns"]["hosts"] = projected.config["dns"]["hosts"].clone();
        }
        let fake_dns = crate::fakedns::prepare(
            self.fake_dns.as_ref(),
            &runtime_config,
            self.exe.parent().unwrap().parent().unwrap(),
            if self.startup.enabled() {
                CoreIdentity::LocalService
            } else {
                CoreIdentity::Owner(&self.owner)
            },
        )?;
        if let Some(pool) = &fake_dns {
            pool.instrument(&mut runtime_config)?;
        }
        let mut tun_plan = crate::tun::prepare_with_applications(
            &runtime_config,
            profile.capture.as_ref(),
            retained.as_ref().map(|r| r.index()).or_else(|| {
                (mode == RestartMode::PreserveNetwork)
                    .then(|| self.tun.owned_host_index())
                    .flatten()
            }),
        )?;
        if let Some(plan) = &mut tun_plan {
            plan.set_fake_dns(fake_dns.as_ref().map(|p| p.endpoint()));
        }
        self.direct_egress = None;
        if tun_plan.is_none() && crate::tun::needs_direct_binding(&runtime_config) {
            let selection = self.tun.outbound_egress()?;
            selection.bind(&mut runtime_config)?;
            self.direct_egress = Some(selection);
        }
        let loopback = crate::tun::loopback_interface()?;
        self.loopback_policy = Some(crate::loopback::Policy::apply(
            tun_plan
                .as_mut()
                .map(|p| &mut p.main)
                .unwrap_or(&mut runtime_config),
            &loopback,
        )?);
        let mut bridge = Bridge::new(
            tun_plan
                .as_ref()
                .map(|p| &p.main)
                .unwrap_or(&runtime_config),
        )?
        .with_outbound_sources(self.loopback_policy.as_ref().unwrap().counter_sources());
        if routing_log.is_some() {
            crate::routing_log::enable(std::sync::Arc::make_mut(&mut bridge.config));
            if let Some(plan) = &mut tun_plan {
                plan.monitor_routing();
                if let Some(session) = &mut routing_log {
                    session.include_aliases(&plan.routing_aliases);
                }
            }
        }
        // The resolver lives in a different worker config. Keep its socket
        // reserved until the main core has selected all its private listeners.
        let control = crate::live::Control::new(&bridge.config)?;
        if let Some(plan) = &mut tun_plan {
            plan.release_relay();
        }
        bridge.config = control.config.clone();
        let listeners = tcp_listeners(&bridge.config);
        for endpoint in listener_endpoints(&bridge.config) {
            check_endpoint(endpoint)?;
        }
        self.generation += 1;
        self.events.routing.begin(routing_log);
        self.core_state = CoreState::Starting;
        self.changed("core.state");
        let result = (|| {
            self.progress(crate::lifecycle::Stage::StartCore);
            let core = crate::native::spawn_core_with_fakedns(
                &self.exe,
                self.identity(),
                &bridge.config,
                fake_dns.as_ref().map(|p| p.endpoint()),
                Some(self.events.clone()),
                self.generation,
            )?;
            self.progress(crate::lifecycle::Stage::WaitCore);
            let now = Instant::now();
            let until = now + Duration::from_secs(8);
            let ready_after = now + Duration::from_millis(300);
            loop {
                if let Some(code) = core.exit_code()? {
                    let detail = core.lines.lock().unwrap().join("");
                    let failure =
                        if private_listener_failure(&bridge.config, &profile.config, &detail) {
                            "PRIVATE_LISTENER_RETRY"
                        } else {
                            "XRAY_START_FAILED"
                        };
                    return Err(ApiError::new(
                        failure,
                        format!("Xray exited during startup (code {code}). {detail}"),
                    ));
                }
                if Instant::now() >= ready_after
                    && listeners
                        .iter()
                        .all(|a| TcpStream::connect_timeout(a, Duration::from_millis(100)).is_ok())
                    && {
                        let owned = crate::sockets::listeners()?;
                        listener_endpoints(&bridge.config).iter().all(|endpoint| {
                            owned
                                .iter()
                                .any(|row| row.pid == core.pid && row.endpoint.overlaps(*endpoint))
                        })
                    }
                {
                    if let Some(plan) = tun_plan.take() {
                        self.progress(
                            if profile
                                .capture
                                .as_ref()
                                .is_some_and(|p| p.tun_sharing.is_some())
                            {
                                crate::lifecycle::Stage::StartSharing
                            } else {
                                crate::lifecycle::Stage::StartTun
                            },
                        );
                        if mode == RestartMode::PreserveNetwork {
                            self.tun.replace(
                                &self.exe,
                                plan,
                                self.events.clone(),
                                self.generation,
                            )?;
                        } else {
                            self.tun.start(
                                &self.exe,
                                plan,
                                self.events.clone(),
                                self.generation,
                                retained.take(),
                            )?;
                        }
                    }
                    let core_pids: Vec<_> = std::iter::once(core.pid)
                        .chain(self.tun.core_pids())
                        .collect();
                    if worker_plan.is_some() {
                        self.progress(crate::lifecycle::Stage::StartCapture);
                    } else if self.runtime_capture.is_some() {
                        self.progress(crate::lifecycle::Stage::DrainCapture);
                    }
                    self.capture.start(
                        worker_plan.clone(),
                        &core_pids,
                        &self.tun.excluded_capture_interfaces()?,
                    )?;
                    self.network.arm(
                        &profile.config,
                        profile.capture.as_ref(),
                        &self.tun.status(),
                    )?;
                    return Ok(core);
                }
                if Instant::now() >= until {
                    return Err(ApiError::new(
                        "TIMEOUT",
                        "Xray listeners did not become ready.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })();
        match result {
            Ok(core) => {
                self.statistics
                    .begin(self.generation, profile.revision, &profile.config);
                if let Some(tag) = self
                    .loopback_policy
                    .as_ref()
                    .and_then(|policy| policy.local_counter_tag())
                {
                    self.statistics.include_outbound(tag);
                }
                self.statistics_bridge = Some(bridge);
                self.control = Some(control);
                self.core_resource_generation = self.resources.generation();
                self.resource_issues = projection.report;
                self.resource_issues_generation = self.resources.generation();
                self.runtime_capture = worker_plan;
                self.bootstrap_cache =
                    bootstrap_hosts.map(|hosts| (config_hash(&profile.config), hosts));
                self.core = Some(core);
                self.fake_dns = fake_dns;
                self.core_state = CoreState::Running;
                self.health_fault = None;
                self.last_error = None;
                self.changed("core.state");
                Ok(())
            }
            Err(error) => {
                self.events.routing.stop();
                // This marker is emitted only before main-core readiness: no
                // TUN/ICS cutover has occurred. Reallocate our private endpoints
                // without resetting a retained adapter or published authority.
                if error.code == "PRIVATE_LISTENER_RETRY" {
                    return Err(error);
                }
                if mode == RestartMode::Reconfigure {
                    let cleanup = self.tun.retire(SharingExit::Suspend);
                    let error = Cleanup::after_failure(error, "candidate TUN retirement", cleanup);
                    self.core_state = CoreState::Failed;
                    self.last_error = Some(error.clone());
                    self.changed("core.state");
                    return Err(error);
                }
                self.core_state = CoreState::Failed;
                self.last_error = Some(error.clone());
                self.changed("core.state");
                Err(error)
            }
        }
    }
    fn stop_core(&mut self) -> Result<()> {
        self.stop_core_with_sharing(SharingExit::Native)
    }
    fn stop_core_with_sharing(&mut self, sharing: SharingExit) -> Result<()> {
        let sharing = if self
            .profile
            .as_ref()
            .and_then(|p| p.capture.as_ref())
            .is_some_and(|p| p.sharing_disabled)
        {
            SharingExit::Disable
        } else {
            sharing
        };
        self.retire_core(Retirement::Stop(sharing))?;
        if recover_checkpoint(
            &self.profile_path,
            &self.owner,
            &mut self.profile,
            &mut self.empty_revision,
        )? {
            self.profile_recovery = None;
            self.changed("config.recovered");
        }
        Ok(())
    }
    fn retire_core(&mut self, intent: Retirement) -> Result<()> {
        if !matches!(
            intent,
            Retirement::Stop(_) | Retirement::Shutdown(crate::lifecycle::ServiceExit::Stop)
        ) {
            if self.protection.enabled() {
                self.progress(crate::lifecycle::Stage::ProtectApps);
            }
            self.protection.arm(crate::app_protection::Phase::Restart)?;
        }
        self.events.routing.stop();
        self.core_state = CoreState::Stopping;
        let tun_result = if !intent.retain_network() {
            if self.tun.status()["sharedPid"].as_u64().is_some() {
                self.progress(crate::lifecycle::Stage::RetireSharing);
            } else if self.tun.status()["pid"].as_u64().is_some() {
                self.progress(crate::lifecycle::Stage::RetireTun);
            }
            self.tun.retire(intent.sharing())
        } else {
            Ok(())
        };
        let capture_result = if !intent.retain_capture() {
            self.progress(crate::lifecycle::Stage::DrainCapture);
            let result = self.capture.stop();
            self.runtime_capture = None;
            result
        } else {
            Ok(())
        };
        self.progress(crate::lifecycle::Stage::SaveCounters);
        if let Some(bridge) = &self.statistics_bridge {
            if let Ok(sample) = bridge.read() {
                let _ = self.statistics.record(
                    &sample.counters,
                    sample.observed_at,
                    sample.timestamp_ms,
                );
            }
        }
        self.statistics.stopped();
        self.statistics_bridge = None;
        self.control = None;
        if !intent.retain_network() {
            self.direct_egress = None;
            self.loopback_policy = None;
        }
        let proxy_result = if intent.restore_settings() {
            self.progress(crate::lifecycle::Stage::RestoreSettings);
            self.proxy.restore_all()
        } else {
            Ok(())
        };
        self.progress(crate::lifecycle::Stage::StopCore);
        let core_result = self.core.take().map_or(Ok(()), |core| core.stop());
        if intent.release_fake_dns() {
            self.fake_dns = None;
        }
        let mut cleanup = Cleanup::default();
        cleanup.record("TUN retirement", tun_result);
        cleanup.record("capture retirement", capture_result);
        cleanup.record("core retirement", core_result);
        cleanup.record("Windows settings restoration", proxy_result);
        if matches!(
            intent,
            Retirement::Stop(_) | Retirement::Shutdown(crate::lifecycle::ServiceExit::Stop)
        ) && !self.protection.upgrading()
        {
            cleanup.record("release app protection", self.protection.release());
        }
        let result = cleanup.finish();
        // A fault publishes one terminal failure with its original cause after
        // cleanup; never advertise an intermediate successful Stop.
        if !matches!(intent, Retirement::Fault(_)) {
            self.health_fault = None;
            self.core_state = if result.is_ok() {
                CoreState::Stopped
            } else {
                CoreState::Failed
            };
            self.last_error = result.as_ref().err().cloned();
            self.changed("core.state");
        }
        result
    }
    /// Health faults share retirement policy. Evaluate one fault per tick so a
    /// consequence of teardown cannot overwrite the cause or its cleanup errors.
    fn runtime_fault(&mut self) -> Option<(Fault, ApiError)> {
        if self.core_state == CoreState::Failed
            && !self.health_fault.is_some_and(Fault::monitor_after_failure)
        {
            return None;
        }
        if let Some(error) = self.fake_dns.as_ref().and_then(|pool| pool.check().err()) {
            return Some((Fault::FakeDns, error));
        }
        if let Err(mut error) = self.capture.poll() {
            error.message.push_str(" WinDivert capture is no longer active; affected applications can use Windows networking directly. Owned proxy assignments were retained. Automatic routing recovery is pending; Stop cancels it.");
            return Some((Fault::Capture, error));
        }
        if let Err(error) = self.tun.poll() {
            return Some((Fault::Tun, error));
        }
        if let Some(core) = &self.core {
            let message = match core.exit_code() {
                Ok(None) => return None,
                Ok(Some(code)) => format!("Xray exited unexpectedly with code {code}."),
                Err(_) => "Xray process state could not be read; its owned job was ended.".into(),
            };
            return Some((Fault::Core, ApiError::new("XRAY_EXITED", format!("{message} Capture and owned proxy assignments were retained. Automatic routing recovery is pending; Stop cancels it."))));
        }
        None
    }
    fn fail_runtime(&mut self, fault: Fault, error: ApiError) {
        crate::diagnostics::log(
            "runtime",
            "error",
            &format!("{}: {}", error.code, error.message),
        );
        crate::diagnostics::snapshot(&self.snapshot());
        self.network.cancel();
        let cleanup = self.retire_core(Retirement::Fault(fault));
        let error = Cleanup::after_failure(error, "runtime retirement", cleanup);
        let error = if self.health_fault.is_some() {
            self.last_error
                .clone()
                .map(|original| {
                    Cleanup::after_failure(original, "retained runtime failure", Err(error.clone()))
                })
                .unwrap_or(error)
        } else {
            error
        };
        self.health_fault = Some(fault);
        if fault == Fault::Capture {
            self.capture.failed(&error);
        }
        self.core_state = CoreState::Failed;
        self.recovery.fail(error.clone(), Instant::now());
        self.last_error = Some(error);
        self.changed(fault.event());
    }
    pub fn tick(&mut self) {
        if self.protection.reconcile(Instant::now()) {
            self.changed("appProtection.changed");
        }
        if crate::diagnostics::sampling_due() {
            crate::diagnostics::snapshot(&self.snapshot());
        }
        if !self.outbound_tests.busy() {
            let proxy_port = self.subscription_proxy_port().ok();
            self.resources.set_proxy_port(proxy_port);
            self.resources.tick();
        }
        if self.capture.refresh_availability(false) {
            self.changed("capture.availability");
        }
        if let Some((fault, error)) = self.runtime_fault() {
            self.fail_runtime(fault, error);
        } else {
            self.poll_network();
            if self.core_state == CoreState::Running
                && self.core.is_some()
                && self.profile_recovery.is_none()
                && self.recovery.wants_running()
            {
                if let Err(error) = self.recovery.healthy(Instant::now()) {
                    self.last_error = Some(error);
                }
            }
        }
        if (self.proxy.recovery_pending || self.proxy.extras.recovery_pending)
            && !self.recovery.retain_assignments()
            && self.core_state != CoreState::Failed
            && self.proxy.restore_all().is_ok()
        {
            self.changed("system.captureRecovered");
        }
        self.reload_resource_filters();
        self.retry_routing();
        self.reconcile_user_settings();
    }
    fn reconcile_user_settings(&mut self) {
        if !self.proxy.user_deferred() {
            self.user_settings_retry = None;
            self.user_settings_error = None;
            return;
        }
        if self.core_state != CoreState::Running
            || self
                .user_settings_retry
                .is_some_and(|at| Instant::now() < at)
        {
            return;
        }
        self.user_settings_retry = Some(Instant::now() + Duration::from_secs(30));
        let Some(profile) = &self.profile else {
            return;
        };
        let result = self
            .proxy
            .reconcile_user(&profile.config, profile.capture.as_ref());
        if let Err(error) = &result {
            if self
                .user_settings_error
                .as_ref()
                .map(|e| (&e.code, &e.message))
                != Some((&error.code, &error.message))
            {
                crate::diagnostics::log(
                    "settings",
                    "warning",
                    &format!("Deferred user settings ({}): {}", error.code, error.message),
                );
                self.events.publish(
                    "system.captureRecovery",
                    json!({"error":error,"deferred":true}),
                );
            }
        } else if !self.proxy.user_deferred() {
            self.changed("system.captureRecovered");
        }
        self.user_settings_error = result.err();
    }
    fn reload_resource_filters(&mut self) {
        let generation = self.resources.generation();
        if self.shutting_down
            || !self.recovery.wants_running()
            || self.profile_recovery.is_some()
            || self.core_state != CoreState::Running
            || self.core.is_none()
            || self.outbound_tests.busy()
            || self.resources.snapshot()["busy"] == true
            || generation == self.core_resource_generation
            || self.resources.reload_generation() <= self.core_resource_generation
            || self
                .resource_reload
                .as_ref()
                .is_some_and(|reload| reload.blocks(generation, Instant::now()))
        {
            return;
        }
        self.resource_reload = None;
        let Some(profile) = self.profile.clone() else {
            return;
        };
        let files = self
            .resources
            .changed_files_after(self.core_resource_generation);
        if !self.resources.uses(&profile.config, &files) {
            // Unreferenced changes do not invalidate this projection's notices.
            self.resource_issues_generation = generation;
            self.core_resource_generation = generation;
            self.changed("resources.runtimeUnchanged");
            return;
        }
        // DNS and routing both expand DAT selectors at core construction. The
        // routing API alone cannot refresh the resolver's cached domain/IP sets.
        self.begin_progress(crate::lifecycle::Operation::ReloadResources);
        let result = self.activate(
            ActivateInput {
                source_graph_token: None,
                source_graph: None,
                config: profile.config,
                capture: profile.capture,
                display_names: profile.display_names,
                expected_revision: profile.revision,
            },
            ActivationKind::Restart,
        );
        let succeeded = result.is_ok();
        if let Err(error) = result {
            self.resource_reload = Some(ResourceReload::failed(generation, error, Instant::now()));
        }
        self.end_progress();
        self.changed(if succeeded {
            "resources.runtimeReloaded"
        } else {
            "resources.runtimeReloadFailed"
        });
    }
    fn poll_network(&mut self) {
        if self.shutting_down
            || !self.network.active()
            || self.profile_recovery.is_some()
            || !self.recovery.wants_running()
        {
            return;
        }
        let change = if let Some(profile) = &self.profile {
            self.network.poll(&profile.config)
        } else {
            self.network.cancel();
            return;
        };
        match change {
            Ok(crate::tun::network::Change::None) => return,
            Ok(crate::tun::network::Change::Status) => {
                self.changed("network.changed");
                return;
            }
            Ok(crate::tun::network::Change::Reconnect) => {}
            Err(error) => {
                self.fail_runtime(Fault::Network, error);
                return;
            }
        }
        // Large subscription profiles are copied only for an actual reconnect,
        // never on the steady-state service tick.
        let profile = self.profile.clone().unwrap();
        // Existing peer/bootstrap addresses avoid resolving through an old TUN
        // relay before its stale sockets can be retired. Saved static hosts win.
        let hosts = self
            .bootstrap_cache
            .as_ref()
            .filter(|(hash, _)| *hash == config_hash(&profile.config))
            .map(|(_, hosts)| hosts.clone());
        self.begin_progress(crate::lifecycle::Operation::Restart);
        self.changed("network.reconnecting");
        let result = (|| {
            let config = self.network.configuration(&profile.config)?;
            self.tun.preflight(&config, profile.capture.as_ref())?;
            let retained = self
                .tun
                .retain_adapter(&profile.config, profile.capture.as_ref());
            self.retire_core(Retirement::Replace(
                RestartMode::Reconfigure,
                SharingExit::Suspend,
            ))?;
            self.start_core_with_adapter(hosts, retained)
        })();
        if let Err(error) = result {
            self.network.cancel();
            self.core_state = CoreState::Failed;
            self.health_fault = Some(Fault::Core);
            self.recovery.fail(error.clone(), Instant::now());
            self.last_error = Some(error);
            self.changed("network.failed");
        }
        self.end_progress();
        self.changed("network.changed");
    }
    // The metrics read runs outside the lifecycle lock. Ignore results from a replaced core.
    pub fn traffic_request(&self) -> Option<(u64, u64, Bridge)> {
        if self.shutting_down
            || self.core_state != CoreState::Running
            || !self.statistics.due(Instant::now())
        {
            return None;
        }
        self.statistics_bridge
            .as_ref()
            .map(|b| (self.generation, self.statistics.counter_epoch(), b.clone()))
    }
    pub fn accept_traffic(&mut self, generation: u64, counter_epoch: u64, sample: Result<Sample>) {
        if self.generation != generation
            || self.statistics.counter_epoch() != counter_epoch
            || self.core.is_none()
            || self.shutting_down
        {
            return;
        }
        if self
            .core
            .as_ref()
            .is_some_and(|c| !matches!(c.exit_code(), Ok(None)))
        {
            return;
        }
        match sample {
            Ok(value) => {
                self.fake_dns_usage =
                    crate::fakedns::Usage::from_metrics(&value.counters["fakeDns"])
                        .map(|usage| (generation, value.observed_at, usage));
                self.observation = self.control.as_ref().map(|control| {
                    let groups = crate::observation::groups(&control.config, &value.counters["observatory"]);
                    let truncated = control.config["routing"]["balancers"].as_array().is_some_and(|groups| groups.len() > wayrill_protocol::MAX_SNAPSHOT_ENDPOINTS);
                    (generation, value.observed_at, json!({"generation":generation,"revision":self.revision(),"sampledAtMs":value.timestamp_ms,"groups":groups,"outbounds":crate::observation::outbounds(&control.config, &value.counters["observatory"]),"truncated":truncated}))
                });
                if self
                    .statistics
                    .record(&value.counters, value.observed_at, value.timestamp_ms)
                    .is_err()
                {
                    self.statistics.unavailable();
                }
            }
            Err(_) => self.statistics.unavailable(),
        }
    }
    pub fn shutdown(&mut self, reason: crate::lifecycle::ServiceExit) -> Result<()> {
        self.outbound_tests.shutdown();
        self.resources.shutdown();
        if self.shutting_down {
            return Ok(());
        }
        self.shutting_down = true;
        let boot = if reason == crate::lifecycle::ServiceExit::WindowsShutdown {
            // Also covers Windows Fast Startup, which can retain volatile hives.
            crate::startup::session::Session::prepare_shutdown()
        } else {
            Ok(())
        };
        let intent = if reason == crate::lifecycle::ServiceExit::Stop {
            self.recovery.stop()
        } else {
            Ok(())
        };
        self.network.cancel();
        self.begin_progress(crate::lifecycle::Operation::Stop);
        let core = if self.recovery.wants_running() {
            // Desired assignments stay owned through Windows/service restart;
            // otherwise a proxy-only graph would resume with Windows proxy Off.
            // Native ICS still hands back before Windows service shutdown.
            self.retire_core(Retirement::Shutdown(reason))
        } else {
            self.stop_core()
        };
        let divert = self.divert.stop();
        self.end_progress();
        self.events.publish("service.stopping", self.snapshot());
        let mut cleanup = Cleanup::default();
        cleanup.record("Windows boot policy", boot);
        cleanup.record("cancel routing recovery", intent);
        cleanup.record("routing shutdown", core);
        cleanup.record("diagnostic shutdown", divert);
        cleanup.finish()
    }
}
impl Drop for Kernel {
    fn drop(&mut self) {
        let _ = self.shutdown(crate::lifecycle::ServiceExit::Unexpected);
    }
}

// Numeric configuration listeners cannot be handed off atomically to another
// process. Only generated loopback TCP bind failures may retry; authored inputs
// and unrelated startup errors retain the normal rejection/rollback behavior.
fn private_listener_failure(runtime: &Value, authored: &Value, detail: &str) -> bool {
    let original = listener_endpoints(authored);
    listener_endpoints(runtime).iter().any(|endpoint| {
        endpoint.network == ListenerNetwork::Tcp
            && endpoint.address.ip().is_loopback()
            && !original.iter().any(|old| old.overlaps(*endpoint))
            && detail.contains(&format!(
                "failed to listen TCP on {} ",
                endpoint.address.port()
            ))
    })
}
fn retry_private_listener(mut start: impl FnMut(usize) -> Result<()>) -> Result<()> {
    for attempt in 0..3 {
        match start(attempt) {
            Err(error) if error.code == "PRIVATE_LISTENER_RETRY" && attempt < 2 => continue,
            Err(mut error) if error.code == "PRIVATE_LISTENER_RETRY" => {
                error.code = "XRAY_START_FAILED".into();
                error
                    .message
                    .push_str(" Private listener allocation failed after three attempts.");
                return Err(error);
            }
            result => return result,
        }
    }
    unreachable!()
}
#[cfg(test)]
mod tests {
    use super::*;
    use wayrill_protocol::direct_example;

    #[test]
    fn accepts_profile_hashes_written_before_the_digest_upgrade() {
        let profile = json!({
            "ownerSid": "test-owner",
            "revision": 1,
            "config": {"outbounds": []},
            "hash": "13d1e3db45f13dbcf8a7dbab9084fd3a7bc9f32985792238767a564099ebb037"
        });
        assert!(stored_profile(profile.clone()).is_ok());
        let mut changed = profile;
        changed["config"]["outbounds"] = json!([{"protocol":"freedom"}]);
        assert_eq!(
            stored_profile(changed).err().unwrap().code,
            "STATE_INTEGRITY"
        );
    }

    #[test]
    fn tracks_resource_dependencies_in_routing_dns_and_hosts_without_refreshing_unused_files() {
        let config = json!({"routing":{"rules":[{"ip":["geoip:private"],"domain":["ext:office.dat:local"]}]},
            "dns":{"hosts":{"geosite:private":"127.0.0.1"},"servers":[{"domains":["geosite:cn"],"expectIPs":["ext:expected.dat:cn"]}]}});
        for file in [
            "geoip.dat",
            "geosite.dat",
            "office.dat",
            "expected.dat",
            "OFFICE.DAT",
        ] {
            assert!(uses_resources(&config, &[file.into()]), "{file}");
        }
        assert!(!uses_resources(&config, &["unused.dat".into()]));
        assert!(!uses_resources(
            &json!({"routing":{"rules":[{"ip":["10.0.0.0/8"],"domain":["example.org"]}]}}),
            &["geoip.dat".into(), "geosite.dat".into()]
        ));
    }
    #[test]
    fn resource_reload_recovers_after_a_temporary_checkpoint_lock_without_a_new_download() {
        use std::os::windows::fs::OpenOptionsExt;
        let (root, profile) = checkpoint_fixture();
        let checkpoint = root.join("activation-rollback.json");
        storage::write(&checkpoint, &profile).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(&checkpoint)
            .unwrap();
        let now = Instant::now();
        let error = storage::write(&checkpoint, &profile).unwrap_err();
        let failed = ResourceReload::failed(2, error, now);
        assert!(failed.error.retryable);
        assert!(failed.blocks(2, now));
        assert!(failed.blocks(2, now + Duration::from_secs(29)));
        drop(lock);
        assert!(!failed.blocks(2, now + Duration::from_secs(30)));
        storage::write(&checkpoint, &profile).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn resource_reload_validation_failure_waits_for_corrected_data_and_transient_retries_do_not_expire(
    ) {
        let now = Instant::now();
        for code in ["XRAY_CONFIG_INVALID", "RESOURCE_INVALID"] {
            let failed = ResourceReload::failed(3, ApiError::new(code, "invalid data"), now);
            assert!(!failed.error.retryable);
            assert!(failed.blocks(3, now + Duration::from_secs(86400)));
            assert!(!failed.blocks(4, now));
        }
        for attempt in 0..100 {
            let now = now + Duration::from_secs(attempt * 30);
            let failed = ResourceReload::failed(3, ApiError::new("TIMEOUT", "temporary"), now);
            assert!(failed.blocks(3, now));
            assert!(!failed.blocks(3, now + Duration::from_secs(30)));
        }
    }
    #[test]
    fn names_credentials_and_payload_text_are_not_resource_dependencies() {
        let config = json!({"outbounds":[{"tag":"ext:unused.dat:QA","settings":{"user":"geosite:cn","pass":"geoip:private"}}],
            "routing":{"balancers":[{"selector":["ext:unused.dat:QA"]}],"rules":[{"user":["geosite:cn"]}]},
            "dns":{"tag":"ext:unused.dat:QA","servers":[{"tag":"geosite:cn","address":"localhost"}]}});
        assert!(!uses_resources(
            &config,
            &[
                "unused.dat".into(),
                "geoip.dat".into(),
                "geosite.dat".into()
            ]
        ));
    }
    fn checkpoint_fixture() -> (PathBuf, Profile) {
        let root = std::env::temp_dir().join(format!(
            "wayrill-checkpoint-{}",
            crate::tun::random_id().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let config = direct_example();
        let previous = Profile {
            source_graph: None,
            owner_sid: "test-owner".into(),
            revision: 7,
            hash: profile_hash(&config, None),
            config,
            display_names: DisplayNames::default(),
            capture: None,
        };
        (root, previous)
    }
    #[test]
    fn pending_recovery_cannot_be_replaced_and_stop_restores_a_monotonic_profile() {
        let (root, previous) = checkpoint_fixture();
        let path = root.join("profile.json");
        let checkpoint = root.join("activation-rollback.json");
        storage::write(
            &checkpoint,
            &Checkpoint {
                previous: Some(previous.clone()),
                next_revision: 9,
            },
        )
        .unwrap();
        let saved = std::fs::read(&checkpoint).unwrap();
        assert_eq!(
            require_recovered(&path).unwrap_err().code,
            "RECOVERY_REQUIRED"
        );
        assert_eq!(std::fs::read(&checkpoint).unwrap(), saved);
        let mut current = previous.clone();
        current.revision = 8;
        current.config["outbounds"][0]["protocol"] = json!("blackhole");
        let mut profile = Some(current);
        let mut floor = 12;
        assert!(recover_checkpoint(&path, "test-owner", &mut profile, &mut floor).unwrap());
        let restored = profile.unwrap();
        assert_eq!(restored.revision, 13);
        assert_eq!(restored.config, previous.config);
        assert_eq!(restored.hash, previous.hash);
        assert!(!checkpoint.exists());
        assert!(require_recovered(&path).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn empty_checkpoint_recovery_retains_revision_floor() {
        let (root, previous) = checkpoint_fixture();
        let path = root.join("profile.json");
        storage::write(&path, &previous).unwrap();
        storage::write(
            &root.join("activation-rollback.json"),
            &Checkpoint {
                previous: None,
                next_revision: 11,
            },
        )
        .unwrap();
        let mut profile = Some(previous);
        let mut floor = 15;
        assert!(recover_checkpoint(&path, "test-owner", &mut profile, &mut floor).unwrap());
        assert!(profile.is_none());
        assert!(!path.exists());
        assert_eq!(floor, 16);
        assert_eq!(
            storage::read::<u64>(&root.join("revision-floor.json")).unwrap(),
            Some(16)
        );
        assert!(!recover_checkpoint(&path, "test-owner", &mut profile, &mut floor).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unauthenticated_checkpoint_is_never_discarded_or_applied() {
        let (root, previous) = checkpoint_fixture();
        let path = root.join("profile.json");
        let checkpoint = root.join("activation-rollback.json");
        let mut broken = serde_json::to_value(Checkpoint {
            previous: Some(previous.clone()),
            next_revision: 9,
        })
        .unwrap();
        broken["previous"]["config"]["outbounds"][0]["protocol"] = json!("blackhole");
        storage::write(&checkpoint, &broken).unwrap();
        let bytes = std::fs::read(&checkpoint).unwrap();
        let mut profile = Some(previous);
        let mut floor = 0;
        assert_eq!(
            recover_checkpoint(&path, "test-owner", &mut profile, &mut floor)
                .unwrap_err()
                .code,
            "STATE_INTEGRITY"
        );
        assert_eq!(std::fs::read(&checkpoint).unwrap(), bytes);
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn old_shared_profile() -> Value {
        let config = direct_example();
        let capture = json!({"version":1,"inputs":[],"interfaces":{"monitorNewInterfaces":true,"interfaces":[]},"bypassLocalTraffic":true,"tunSharing":{"tag":"shared","expectedVersion":"a".repeat(64),"publicId":"22944640-3598-4b5d-aa13-06ea38f26fb0","privateId":"830b3b6e-fa82-4103-8ff5-66f93d1dafa4","upstreamTags":["direct"]}});
        json!({"ownerSid":"test-owner","revision":7,"hash":config_hash(&json!({"config":config,"capture":capture})),"config":config,"capture":capture})
    }
    #[test]
    fn authenticates_saved_representation_before_applying_new_capture_defaults() {
        let raw = old_shared_profile();
        let profile = stored_profile(raw.clone()).unwrap();
        assert!(
            !profile
                .capture
                .as_ref()
                .unwrap()
                .tun_sharing
                .as_ref()
                .unwrap()
                .ipv6
        );
        assert_ne!(profile.hash, raw["hash"].as_str().unwrap());
        assert_eq!(
            profile.hash,
            profile_hash(&profile.config, profile.capture.as_ref())
        );
        // Subsequent saves use the new normalized representation consistently.
        assert!(stored_profile(serde_json::to_value(profile).unwrap()).is_ok());
        for ipv6 in [false, true] {
            let mut current = raw.clone();
            current["capture"]["tunSharing"]["ipv6"] = json!(ipv6);
            current["hash"] = json!(config_hash(
                &json!({"config":current["config"],"capture":current["capture"]})
            ));
            assert_eq!(
                stored_profile(current)
                    .unwrap()
                    .capture
                    .unwrap()
                    .tun_sharing
                    .unwrap()
                    .ipv6,
                ipv6
            );
        }
    }
    #[test]
    fn protected_profile_integrity_still_rejects_capture_and_config_tampering() {
        let mut changed = old_shared_profile();
        changed["capture"]["tunSharing"]["ipv6"] = json!(true);
        assert_eq!(
            stored_profile(changed).err().unwrap().code,
            "STATE_INTEGRITY"
        );
        let mut changed = old_shared_profile();
        changed["config"]["inbounds"][0]["port"] = json!(19080);
        assert_eq!(
            stored_profile(changed).err().unwrap().code,
            "STATE_INTEGRITY"
        );
    }
    #[test]
    fn rollback_authenticates_the_original_profile_and_accepts_no_capture() {
        let checkpoint = json!({"previous":old_shared_profile(),"nextRevision":8});
        let normalized = stored_checkpoint(checkpoint.clone()).unwrap();
        let previous = normalized.previous.unwrap();
        assert_eq!(
            previous.hash,
            profile_hash(&previous.config, previous.capture.as_ref())
        );
        let mut changed = checkpoint;
        changed["previous"]["capture"]["bypassLocalTraffic"] = json!(false);
        assert_eq!(
            stored_checkpoint(changed).err().unwrap().code,
            "STATE_INTEGRITY"
        );
        let mut profile = old_shared_profile();
        profile.as_object_mut().unwrap().remove("capture");
        profile["hash"] = json!(config_hash(&profile["config"]));
        assert!(stored_profile(profile.clone()).is_ok());
        profile["capture"] = Value::Null;
        assert!(stored_profile(profile).is_ok());
    }
    #[test]
    fn damaged_profile_is_preserved_and_cannot_be_executed() {
        let root = std::env::temp_dir().join(format!(
            "wayrill-profile-recovery-{}-{}",
            std::process::id(),
            crate::traffic::timestamp_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("profile.json");
        let mut profile = old_shared_profile();
        profile["config"]["log"] = json!({"loglevel":"debug"});
        let changed = serde_json::to_vec_pretty(&profile).unwrap();
        std::fs::write(&path, &changed).unwrap();
        for _ in 0..2 {
            let (loaded, revision, recovery) = load_profile(&path, "test-owner").unwrap();
            assert!(loaded.is_none());
            assert_eq!(revision, 7);
            assert_eq!(recovery.unwrap().code, "STATE_INTEGRITY");
            assert_eq!(std::fs::read(&path).unwrap(), changed);
            let backups: Vec<_> = std::fs::read_dir(&root)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p != &path)
                .collect();
            assert_eq!(backups.len(), 1);
            assert_eq!(std::fs::read(&backups[0]).unwrap(), changed);
        }
        assert_eq!(
            load_profile(&path, "another-owner").err().unwrap().code,
            "OWNER_MISMATCH"
        );
        storage::write(&path, &old_shared_profile()).unwrap();
        let (loaded, _, recovery) = load_profile(&path, "test-owner").unwrap();
        assert!(loaded.is_some());
        assert!(recovery.is_none());
        std::fs::write(&path, b"{broken JSON").unwrap();
        let (loaded, _, recovery) = load_profile(&path, "test-owner").unwrap();
        assert!(loaded.is_none());
        assert_eq!(recovery.unwrap().code, "STATE_INTEGRITY");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn revision_overflow_is_an_error_instead_of_panicking_or_wrapping() {
        assert_eq!(
            advance_revision(u64::MAX).unwrap_err().code,
            "REVISION_EXHAUSTED"
        );
        assert_eq!(advance_revision(u64::MAX - 1).unwrap(), u64::MAX);
    }
    #[test]
    fn readiness_uses_loopback_for_wildcards_and_preserves_specific_ips() {
        for (listen, probe) in [
            ("0.0.0.0", "127.0.0.1"),
            ("::", "::1"),
            ("192.0.2.1", "192.0.2.1"),
            ("2001:db8::1", "2001:db8::1"),
        ] {
            let mut c = direct_example();
            c["inbounds"][0]["listen"] = json!(listen);
            let c = normalize_config(c).unwrap();
            assert_eq!(
                tcp_listeners(&c)[0].ip(),
                probe.parse::<std::net::IpAddr>().unwrap()
            );
            assert_eq!(
                listener_endpoints(&c)[0].address.ip(),
                listen.parse::<std::net::IpAddr>().unwrap()
            );
        }
    }
    #[test]
    fn reports_unassigned_addresses_as_bind_failures() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            check_endpoint(ListenerEndpoint {
                address: std::net::SocketAddr::from(([192, 0, 2, 254], port)),
                network: ListenerNetwork::Tcp
            })
            .unwrap_err()
            .code,
            "LISTENER_BIND_FAILED"
        );
    }

    #[test]
    fn rejects_occupied_udp_endpoints_without_stopping_any_process() {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        assert_eq!(
            check_endpoint(ListenerEndpoint {
                address: socket.local_addr().unwrap(),
                network: ListenerNetwork::Udp
            })
            .unwrap_err()
            .code,
            "PORT_IN_USE"
        );
    }
    #[test]
    fn quic_and_wireguard_have_no_tcp_readiness_probe() {
        let mut config = direct_example();
        config["inbounds"] = json!([{"tag":"hy","protocol":"hysteria","listen":"127.0.0.1","port":20920,"streamSettings":{"network":"hysteria"}}]);
        assert!(tcp_listeners(&config).is_empty());
        config["inbounds"][0]["protocol"] = json!("wireguard");
        assert!(tcp_listeners(&config).is_empty());
    }
    #[test]
    fn only_generated_loopback_tcp_failures_can_retry() {
        let original = json!({"inbounds":[{"protocol":"socks","tag":"user","listen":"127.0.0.1","port":30001}]});
        let mut runtime = original.clone();
        runtime["inbounds"]
            .as_array_mut()
            .unwrap()
            .push(json!({"protocol":"socks","tag":"generated","listen":"127.0.0.1","port":30002}));
        assert!(private_listener_failure(
            &runtime,
            &original,
            "failed to listen TCP on 30002 > bind: forbidden"
        ));
        assert!(!private_listener_failure(
            &runtime,
            &original,
            "failed to listen TCP on 30001 > bind: forbidden"
        ));
        assert!(!private_listener_failure(
            &runtime,
            &original,
            "TLS configuration failed on 30002"
        ));
        runtime["inbounds"][1]["listen"] = json!("0.0.0.0");
        assert!(!private_listener_failure(
            &runtime,
            &original,
            "failed to listen TCP on 30002 > bind: forbidden"
        ));
    }
    #[test]
    fn private_listener_retry_is_bounded_and_never_retries_public_failures() {
        let mut calls = 0;
        retry_private_listener(|attempt| {
            calls += 1;
            if attempt < 2 {
                Err(ApiError::new("PRIVATE_LISTENER_RETRY", "busy"))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(calls, 3);
        calls = 0;
        let error = retry_private_listener(|_| {
            calls += 1;
            Err(ApiError::new("PRIVATE_LISTENER_RETRY", "busy"))
        })
        .unwrap_err();
        assert_eq!(calls, 3);
        assert_eq!(error.code, "XRAY_START_FAILED");
        calls = 0;
        let error = retry_private_listener(|_| {
            calls += 1;
            Err(ApiError::new("XRAY_START_FAILED", "user input is busy"))
        })
        .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(error.message, "user input is busy");
    }
}
