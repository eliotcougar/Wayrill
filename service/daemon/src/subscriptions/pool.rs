//! Managed Pool enrollment shares the subscription actor's admission and durable
//! library. Downloads and compilation run outside the routing lock.
use super::*;
use crate::pool_access::Source;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

// Increase when existing publications need to be read again after an upgrade.
const DELIVERY_READER: u16 = 5;

fn default_minutes() -> u64 {
    5
}

pub(super) fn validate_minutes(minutes: u64) -> Result<()> {
    if !(1..=1440).contains(&minutes) {
        return Err(error(
            "Enter a Pool update interval from 1 to 1440 minutes.",
        ));
    }
    Ok(())
}

fn error(message: &str) -> ApiError {
    ApiError::new("POOL", message)
}
fn digest(text: &str) -> String {
    STANDARD.encode(Sha256::digest(text.as_bytes()))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Connection {
    source: Source,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pool_name: Option<String>,
    digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    verified_source: Option<String>,
    checked_at: u64,
    #[serde(default = "default_minutes")]
    pub(super) refresh_minutes: u64,
    #[serde(default)]
    published_version: u64,
    #[serde(default)]
    delivery_reader: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bindings: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selection: Option<Selection>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    choice_names: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    routing_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    preference_base: Value,
    #[serde(
        default,
        skip_serializing_if = "crate::pool_device::Settings::is_empty"
    )]
    pub(super) device_settings: crate::pool_device::Settings,
    #[serde(default, skip_serializing_if = "PortableApplications::is_empty")]
    portable_applications: PortableApplications,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableApplications {
    descriptors: BTreeMap<String, Value>,
    paths: BTreeMap<String, String>,
}
impl PortableApplications {
    fn is_empty(&self) -> bool {
        self.descriptors.is_empty()
    }
}
fn detect_apps(
    root: &std::path::Path,
    owner: &str,
    descriptors: &BTreeMap<String, Value>,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<Value> {
    if descriptors.is_empty() {
        return Ok(json!({}));
    }
    worker::check(stop, shutdown)?;
    let mut helper = crate::capture::Worker::spawn_attribution(root)?;
    let detection = helper.call(
        "applications.detect",
        json!({"ownerSid":owner, "descriptors":descriptors}),
    )?;
    worker::check(stop, shutdown)?;
    Ok(detection)
}
fn detected_paths(detection: &Value) -> BTreeMap<String, String> {
    detection
        .as_object()
        .into_iter()
        .flat_map(|map| map.iter())
        .filter_map(|(id, result)| {
            result["path"]
                .as_str()
                .map(|path| (id.clone(), path.to_owned()))
        })
        .collect()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutboundChoice {
    #[serde(rename = "groupId")]
    group_id: String,
    #[serde(rename = "entryId")]
    entry_id: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    graph: String,
    #[serde(default, rename = "followDefault")]
    follow_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stashes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filters: Option<BTreeMap<String, String>>,
    #[serde(rename = "stashOverrides", skip_serializing_if = "Option::is_none")]
    stash_overrides: Option<BTreeMap<String, bool>>,
    #[serde(rename = "filterOverrides", skip_serializing_if = "Option::is_none")]
    filter_overrides: Option<BTreeMap<String, Option<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outbounds: Option<BTreeMap<String, OutboundChoice>>,
    #[serde(rename = "deviceLayers", skip_serializing_if = "Option::is_none")]
    device_layers: Option<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Pending {
    connection: Connection,
    source_digest: String,
    config_hash: String,
    stash: String,
    catalog: Vec<Group>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Enrollment {
    source: Source,
    capture: String,
    start: bool,
    expected_revision: u64,
    expected_source_hash: Option<String>,
    bindings: Option<BTreeMap<String, String>>,
    application_changes: Option<ApplicationChanges>,
    expected_digest: Option<String>,
    selection: Option<Selection>,
    #[serde(default = "default_minutes")]
    refresh_minutes: u64,
}
impl Enrollment {
    pub(super) fn validate(&self) -> Result<()> {
        self.source.location()?;
        validate_minutes(self.refresh_minutes)?;
        validate_application_changes(self.application_changes.as_ref())?;
        validate_selection(
            &self.capture,
            self.bindings.as_ref(),
            self.selection.as_ref(),
        )
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PreviewRequest {
    source: Option<Source>,
    capture: String,
    expected_revision: u64,
    expected_source_hash: Option<String>,
    selection: Option<Selection>,
    bindings: Option<BTreeMap<String, String>>,
    expected_digest: Option<String>,
    #[serde(default)]
    reset_bindings: bool,
    #[serde(default)]
    use_defaults: bool,
}
impl PreviewRequest {
    pub(super) fn validate(&self) -> Result<()> {
        if let Some(source) = &self.source {
            source.location()?;
        }
        validate_selection(
            &self.capture,
            self.bindings.as_ref(),
            self.selection.as_ref(),
        )
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BindingChange {
    capture: String,
    expected_revision: u64,
    expected_source_hash: Option<String>,
    expected_digest: String,
    bindings: BTreeMap<String, String>,
    application_changes: Option<ApplicationChanges>,
    selection: Option<Selection>,
    #[serde(default)]
    reset_preferences: BTreeMap<String, Vec<String>>,
}
impl BindingChange {
    pub(super) fn validate(&self) -> Result<()> {
        validate_application_changes(self.application_changes.as_ref())?;
        if self.reset_preferences.len() > 500
            || self.reset_preferences.iter().any(|(id, keys)| {
                id.len() > 128
                    || keys.len() > 50_000
                    || keys.iter().any(|key| key.len() > 131_072 + 5)
            })
        {
            return Err(error("Invalid selection of personal settings."));
        }
        validate_selection(&self.capture, Some(&self.bindings), self.selection.as_ref())
    }
}

type ApplicationChanges = BTreeMap<String, Option<ApplicationBinding>>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplicationBinding {
    kind: String,
    value: String,
}

fn validate_application_changes(changes: Option<&ApplicationChanges>) -> Result<()> {
    if changes.is_some_and(|map| {
        map.len() > 1024
            || map.iter().any(|(id, binding)| {
                id.len() != 36
                    || binding.as_ref().is_some_and(|binding| {
                        !matches!(binding.kind.as_str(), "process" | "package" | "service")
                            || binding.value.len() > 16 * 1024
                    })
            })
    }) {
        return Err(error("Invalid Pool application bindings."));
    }
    Ok(())
}

fn validate_selection(
    capture: &str,
    bindings: Option<&BTreeMap<String, String>>,
    selection: Option<&Selection>,
) -> Result<()> {
    if !matches!(capture, "current" | "proxy" | "tun" | "both") {
        return Err(error("Choose the capture setup for this computer."));
    }
    let valid_id = |id: &str| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    };
    if bindings.is_some_and(|map| {
        map.len() > 1500
            || map
                .iter()
                .any(|(inbound, placeholder)| !valid_id(inbound) || !valid_id(placeholder))
    }) {
        return Err(error("Invalid Pool inbound assignments."));
    }
    let map_valid = |map: &BTreeMap<String, String>| {
        map.len() <= 500
            && map
                .iter()
                .all(|(key, value)| valid_id(key) && valid_id(value))
    };
    let valid_stash_id =
        |id: &str| !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control);
    if selection.is_some_and(|choice| {
        !valid_id(&choice.graph)
            || choice
                .stashes
                .as_ref()
                .is_some_and(|ids| ids.len() > 500 || !ids.iter().all(|id| valid_id(id)))
            || choice.filters.as_ref().is_some_and(|map| !map_valid(map))
            || choice
                .device_layers
                .as_ref()
                .is_some_and(|ids| ids.len() > 500 || !ids.iter().all(|id| valid_id(id)))
            || (choice.filters.is_some() && choice.filter_overrides.is_some())
            || (choice.stashes.is_some() && choice.stash_overrides.is_some())
            || choice
                .stash_overrides
                .as_ref()
                .is_some_and(|map| map.len() > 500 || !map.keys().all(|key| valid_id(key)))
            || choice.filter_overrides.as_ref().is_some_and(|map| {
                map.len() > 500
                    || !map.iter().all(|(key, value)| {
                        valid_id(key) && value.as_ref().is_none_or(|id| valid_id(id))
                    })
            })
            || choice.outbounds.as_ref().is_some_and(|map| {
                map.len() > 500
                    || map.iter().any(|(node, entry)| {
                        !valid_id(node)
                            || !valid_stash_id(&entry.group_id)
                            || !valid_stash_id(&entry.entry_id)
                    })
            })
    }) {
        return Err(error("Invalid Pool layer selection."));
    }
    Ok(())
}

#[derive(Clone)]
pub(super) enum Task {
    Preview(Box<PreviewRequest>),
    Bind(Box<BindingChange>),
    Enroll(Box<Enrollment>),
    Refresh,
    Disconnect { keep_stash: bool },
    SetInterval(u64),
}

pub(super) fn view(state: &State) -> Value {
    let connection = state.library.pool.as_ref().map(|connection| {
        json!({
            "name": connection.name, "poolName": connection.pool_name, "kind": connection.source.kind,
            "address": connection.source.address, "appliedAt": connection.checked_at, "refreshMinutes": connection.refresh_minutes,
            "personalSettings": !connection.preference_base.is_null(),
        })
    });
    json!({"connection":connection,"error":state.pool_error,"lastCheckAt":state.pool_last_check,
        "applying":state.library.pool_pending.is_some(),
        "busy":state.pool_busy || state.library.pool_pending.is_some() || state.queue.iter().any(|work| matches!(work, Work::Pool { .. }))})
}

fn verify_routing(
    connection: &Connection,
    graph: Option<&str>,
    accepted_bundle: Option<&Value>,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<Value> {
    if connection.routing_digest.is_none() && accepted_bundle.is_none() {
        return Err(ApiError::new("POOL_REVIEW_REQUIRED", "A new Pool delivery is available. Review and apply your choices once to resume automatic updates."));
    }
    let routing = worker::helper(
        &json!({"operation":"poolRoutingState","appliedGraph":graph,"layeredRouting":!connection.preference_base.is_null(),
          "bundle":accepted_bundle,"recipient":connection.source.parts()?.0,"poolSelection":connection.selection,"bindings":connection.bindings}),
        stop,
        shutdown,
    )?;
    if routing["matchesPublication"] != true
        && connection.routing_digest.as_ref()
            != Some(&digest(&routing["poolRoutingState"].to_string()))
    {
        return Err(ApiError::new("POOL_LOCAL_ROUTING", "Pool updates are paused because you applied personal routing changes. Open Edit configuration choices to resume managed routing."));
    }
    Ok(routing)
}

pub(super) fn perform(
    kernel: &Arc<Mutex<Kernel>>,
    manager: &Manager,
    task: Task,
    job: Option<u64>,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    let current = manager.state.lock().unwrap().library.clone();
    let initial = match &task {
        Task::Disconnect { keep_stash } => {
            let mut next = (*current).clone();
            if let Some(connection) = next.pool.as_ref().filter(|_| !keep_stash) {
                let (recipient, _) = connection.source.parts()?;
                let prefix = format!("pool-{recipient}-");
                if next
                    .catalog
                    .iter()
                    .any(|group| group.id.starts_with(&prefix))
                {
                    let response = worker::helper(
                        &json!({
                            "operation": "poolForgetStash",
                            "recipient": recipient,
                            "stash": next.stash,
                            "trusted": true,
                        }),
                        stop,
                        shutdown,
                    )?;
                    next.pool = None;
                    return worker::accept(manager, next, response, []);
                }
            }
            next.pool = None;
            return manager.commit(next);
        }
        Task::SetInterval(minutes) => {
            let mut next = (*current).clone();
            let connection = next
                .pool
                .as_mut()
                .ok_or_else(|| error("Connect to a Pool first."))?;
            connection.refresh_minutes = *minutes;
            return manager.commit(next);
        }
        Task::Enroll(input) if current.pool.is_none() => Some(input),
        Task::Enroll(_) => {
            return Err(error(
                "Disconnect from the current Pool before enrolling again.",
            ))
        }
        Task::Preview(_) | Task::Bind(_) | Task::Refresh => None,
    };
    let preview = if let Task::Preview(input) = &task {
        Some(input)
    } else {
        None
    };
    let rebind = if let Task::Bind(input) = &task {
        Some(input)
    } else {
        None
    };
    if preview.is_some_and(|input| input.source.is_some()) && current.pool.is_some() {
        return Err(error("Disconnect before reviewing a different Pool."));
    }
    let source = initial
        .map(|input| &input.source)
        .or_else(|| preview.and_then(|input| input.source.as_ref()))
        .or_else(|| current.pool.as_ref().map(|pool| &pool.source))
        .ok_or_else(|| error("Connect to a Pool first."))?;
    let capture = initial
        .map(|input| input.capture.as_str())
        .or_else(|| preview.map(|input| input.capture.as_str()))
        .or_else(|| rebind.map(|input| input.capture.as_str()))
        .unwrap_or("current");
    let expected_revision = initial
        .map(|input| input.expected_revision)
        .or_else(|| preview.map(|input| input.expected_revision))
        .or_else(|| rebind.map(|input| input.expected_revision));
    let expected_digest = initial
        .and_then(|input| input.expected_digest.as_deref())
        .or_else(|| rebind.map(|input| input.expected_digest.as_str()))
        .or_else(|| preview.and_then(|input| input.expected_digest.as_deref()));
    let expected_source_hash = initial
        .and_then(|i| i.expected_source_hash.as_deref())
        .or_else(|| preview.and_then(|i| i.expected_source_hash.as_deref()))
        .or_else(|| rebind.and_then(|i| i.expected_source_hash.as_deref()));
    let saved_selection = current
        .pool
        .as_ref()
        .and_then(|pool| pool.selection.as_ref());
    let mut selection = initial
        .and_then(|input| input.selection.as_ref())
        .or_else(|| rebind.and_then(|input| input.selection.as_ref()))
        .or_else(|| preview.and_then(|input| input.selection.as_ref()))
        .or_else(|| saved_selection.filter(|_| !preview.is_some_and(|p| p.use_defaults)))
        .cloned();
    let bindings = initial
        .and_then(|input| input.bindings.as_ref())
        .or_else(|| rebind.map(|input| &input.bindings))
        .or_else(|| preview.and_then(|input| input.bindings.as_ref()))
        .or_else(|| {
            current
                .pool
                .as_ref()
                .filter(|_| !preview.is_some_and(|input| input.reset_bindings))
                .and_then(|connection| connection.bindings.as_ref())
        });
    let (recipient, _) = source.parts()?;
    let (proof, applied, owner, attribution) = {
        let routing = kernel
            .lock()
            .map_err(|_| error("Routing controller unavailable."))?;
        let proof = routing.subscription_profile();
        if let Some(expected) = expected_revision {
            if expected != proof.revision
                || expected_source_hash
                    .is_some_and(|h| h != proof.source_hash.as_deref().unwrap_or_default())
            {
                return Err(error(
                    "The applied graph changed. Review the capture choice and try again.",
                ));
            }
        } else if proof.wants_running && !proof.running {
            return Err(error("Waiting for the running configuration to recover."));
        }
        (
            proof,
            routing.pool_source()?,
            current.owner_sid.clone(),
            routing.attribution_root(),
        )
    };
    if matches!(task, Task::Refresh)
        && applied
            .as_ref()
            .and_then(|value| serde_json::from_str::<Value>(&value.0).ok())
            .is_none_or(|graph| graph["poolId"] != recipient)
    {
        return Err(ApiError::new("POOL_LOCAL_ROUTING", "Pool updates are paused because a local graph was applied. Open Edit configuration choices to resume managed routing."));
    }
    let identity = if source.kind == "folder" {
        crate::native::CoreIdentity::Owner(&owner)
    } else {
        crate::native::CoreIdentity::LocalService
    };
    let connection = current.pool.as_ref().filter(|_| initial.is_none());
    let refresh = matches!(task, Task::Refresh);
    let saved_apps = connection
        .filter(|c| refresh && c.delivery_reader == DELIVERY_READER)
        .map(|c| &c.portable_applications);
    let previous_detection = saved_apps
        .map(|apps| detect_apps(&attribution, &owner, &apps.descriptors, stop, shutdown))
        .transpose()?;
    let applications_changed = saved_apps
        .zip(previous_detection.as_ref())
        .is_some_and(|(apps, detected)| apps.paths != detected_paths(detected));
    let validator = connection
        .filter(|c| {
            refresh
                && !applications_changed
                && c.delivery_reader == DELIVERY_READER
                && !c.preference_base.is_null()
        })
        .and_then(|p| p.etag.as_ref());
    let request = json!({"operation":"poolDownload","source":source,"etag":validator});
    let response = match worker::helper_as(&request, identity, stop, shutdown) {
        Err(error) if source.kind == "folder" && error.code == "OWNER_NOT_LOGGED_ON" => {
            worker::helper(&request, stop, shutdown)
        }
        result => result,
    }?;
    let fetched: crate::subscription_http::Fetched =
        serde_json::from_value(response).map_err(|_| error("Invalid Pool download response."))?;
    let (bundle, published_version, content_digest) = match fetched.text {
        Some(text) => crate::pool_access::publication(&text)?,
        None => {
            let saved = connection
                .filter(|_| validator.is_some() && fetched.etag.as_ref() == validator)
                .ok_or_else(|| error("The Pool server returned no publication."))?;
            (Value::Null, saved.published_version, saved.digest.clone())
        }
    };
    let pool_name = bundle["poolName"].as_str().map(str::to_owned);
    if let Some((graph, device_layers)) = bundle["defaultGraph"]
        .as_str()
        .zip(saved_selection.and_then(|choice| choice.device_layers.as_ref()))
        .filter(|_| selection.is_none() && preview.is_some_and(|input| input.use_defaults))
    {
        selection = Some(Selection {
            graph: graph.into(),
            follow_default: true,
            device_layers: Some(device_layers.clone()),
            ..Default::default()
        });
    }
    if refresh || preview.is_some() {
        if let Some(choice) = selection.as_mut().filter(|choice| choice.follow_default) {
            if let Some(default) = bundle["defaultGraph"].as_str() {
                choice.graph = default.into();
            }
        }
    }
    let mut migrated = None;
    if let Some(connection) = connection {
        if connection.published_version > published_version
            || (published_version != 0
                && connection.published_version == published_version
                && connection.digest != content_digest)
        {
            return Err(error(
                "The source returned an older or conflicting Pool publication.",
            ));
        }
        let verified =
            proof.source_hash.is_some() && connection.verified_source == proof.source_hash;
        if refresh && (!verified || connection.preference_base.is_null()) {
            let state = verify_routing(
                connection,
                applied.as_ref().map(|value| value.0.as_str()),
                (connection.preference_base.is_null() && connection.digest == content_digest)
                    .then_some(&bundle),
                stop,
                shutdown,
            )?;
            if connection.preference_base.is_null() {
                migrated = Some((
                    state["poolPreferenceBase"].clone(),
                    digest(&state["managedRoutingState"].to_string()),
                ));
            }
        }
        if refresh
            && !applications_changed
            && connection.delivery_reader == DELIVERY_READER
            && connection.digest == content_digest
        {
            if connection.published_version < published_version
                || connection.etag != fetched.etag
                || migrated.is_some()
                || (!verified && connection.routing_digest.is_some())
            {
                let mut next = (*current).clone();
                let saved = next.pool.as_mut().unwrap();
                saved.published_version = published_version;
                saved.etag = fetched.etag;
                if let Some((base, hash)) = migrated {
                    saved.preference_base = base;
                    saved.routing_digest = Some(hash);
                }
                if saved.routing_digest.is_some() {
                    saved.verified_source = proof.source_hash;
                }
                return manager.commit(next);
            }
            return Ok(());
        }
    }
    if expected_digest.is_some_and(|expected| expected != content_digest) {
        return Err(error(
            "The Pool changed since your review. Reopen the latest Pool choices and try again.",
        ));
    }
    let choice_names = connection.map(|pool| &pool.choice_names);
    let same_graph = saved_selection.map(|s| &s.graph) == selection.as_ref().map(|s| &s.graph);
    let preference_base = same_graph
        .then(|| {
            migrated
                .as_ref()
                .map(|m| &m.0)
                .or_else(|| connection.map(|c| &c.preference_base))
        })
        .flatten();
    let application_changes = initial
        .and_then(|input| input.application_changes.as_ref())
        .or_else(|| rebind.and_then(|input| input.application_changes.as_ref()));
    let (descriptors, detection, preview_entries) = if applications_changed
        && connection.is_some_and(|connection| connection.digest == content_digest)
    {
        let apps = saved_apps.unwrap();
        (apps.descriptors.clone(), previous_detection.unwrap(), None)
    } else if preview.is_some() || bundle["extensions"]["portableExecutablesV1"] == true {
        let mut response = worker::helper(
            &json!({"operation":"poolInspect","recipient":recipient,"appliedGraph":applied.as_ref().map(|value| &value.0),
            "bundle":bundle,"capture":capture,"bindings":bindings,"poolSelection":selection,"poolChoiceNames":choice_names,
            "poolPreferenceBase":preference_base}),
            stop,
            shutdown,
        )?;
        let entries = response["poolEntries"].take();
        let manual = applied
            .as_ref()
            .and_then(|value| serde_json::from_str::<Value>(&value.0).ok())
            .filter(|graph| graph["poolId"] == recipient);
        let descriptors = entries["applications"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|app| {
                let id = app["id"].as_str()?;
                let descriptor = app.get("executable")?;
                let manual = application_changes
                    .and_then(|changes| changes.get(id))
                    .map_or_else(
                        || {
                            manual
                                .as_ref()
                                .and_then(|graph| graph["poolApplicationBindings"].get(id))
                                .is_some()
                        },
                        |binding| binding.is_some(),
                    );
                (preview.is_some() || !manual).then(|| (id.to_owned(), descriptor.clone()))
            })
            .collect();
        let detection = detect_apps(&attribution, &owner, &descriptors, stop, shutdown)?;
        (descriptors, detection, Some(entries))
    } else {
        (BTreeMap::new(), json!({}), None)
    };
    if preview.is_some() {
        let mut preview = preview_entries.ok_or_else(|| error("Missing Pool preview."))?;
        let entries = preview
            .as_object_mut()
            .ok_or_else(|| error("Invalid Pool preview."))?;
        entries.insert("digest".into(), json!(content_digest));
        entries.insert("revision".into(), json!(proof.revision));
        entries.insert(
            "sourceHash".into(),
            json!(proof.source_hash.unwrap_or_default()),
        );
        if let Some(applications) = entries
            .get_mut("applications")
            .and_then(Value::as_array_mut)
        {
            for application in applications {
                if let Some(value) = application["id"].as_str().and_then(|id| detection.get(id)) {
                    application["detection"] = value.clone();
                }
            }
        }
        let id = job.ok_or_else(|| error("Missing Pool preview job."))?;
        manager.state.lock().unwrap().pool_preview = Some((id, preview));
        return Ok(());
    }
    let candidate = worker::helper(
        &json!({"operation":"poolPrepare","stash":current.stash.as_deref().unwrap_or(""),
        "appliedGraph":applied.as_ref().map(|value| &value.0),"bundle":bundle,"recipient":recipient,
        "capture":capture,"bindings":bindings,"poolSelection":selection,"poolChoiceNames":choice_names,
        "applicationChanges":application_changes,"detectedApplications":detection,
        "poolPreferenceBase":preference_base,"resetPreferences":rebind.map(|r| &r.reset_preferences),
        "reconcileBindings":refresh}),
        stop,
        shutdown,
    )?;
    let graph = candidate["graph"]
        .as_str()
        .ok_or_else(|| error("Pool preparation omitted the graph."))?;
    let stash = candidate["stash"]
        .as_str()
        .filter(|text| text.len() <= 64 * 1024 * 1024)
        .ok_or_else(|| error("The combined Pool and local Stash exceeds 64 MiB."))?;
    let catalog: Vec<Group> = serde_json::from_value(candidate["catalog"].clone())
        .map_err(|_| error("Invalid prepared Pool Stash."))?;
    if catalog.len() > 500
        || catalog
            .iter()
            .map(|group| group.entries.len())
            .sum::<usize>()
            > 50000
    {
        return Err(error(
            "The combined Pool and local Stash exceeds its capacity.",
        ));
    }
    let name = candidate["name"]
        .as_str()
        .ok_or_else(|| error("Missing Pool configuration name."))?;
    let mut device_settings = if candidate["poolDeviceSettings"].is_null() {
        crate::pool_device::Settings::default()
    } else {
        serde_json::from_value(candidate["poolDeviceSettings"].clone())
            .map_err(|_| error("Invalid prepared Pool Windows settings."))?
    };
    device_settings.validate()?;
    let pending = Pending {
        connection: Connection {
            source: source.clone(),
            name: name.into(),
            pool_name,
            digest: content_digest,
            etag: fetched.etag,
            verified_source: None,
            checked_at: now(),
            refresh_minutes: initial.map_or_else(
                || {
                    current
                        .pool
                        .as_ref()
                        .map_or_else(default_minutes, |pool| pool.refresh_minutes)
                },
                |input| input.refresh_minutes,
            ),
            published_version,
            delivery_reader: DELIVERY_READER,
            bindings: Some(
                serde_json::from_value(candidate["bindings"].clone())
                    .map_err(|_| error("Invalid prepared Pool inbound assignments."))?,
            ),
            selection: serde_json::from_value(candidate["poolSelection"].clone())
                .map_err(|_| error("Invalid prepared Pool selection."))?,
            choice_names: candidate["poolChoiceNames"].clone(),
            routing_digest: Some(digest(&candidate["poolRoutingState"].to_string())),
            preference_base: candidate["poolPreferenceBase"].clone(),
            device_settings,
            portable_applications: PortableApplications {
                descriptors,
                paths: detected_paths(&detection),
            },
        },
        source_digest: digest(graph),
        config_hash: Kernel::subscription_candidate_hash(&candidate)?,
        stash: stash.into(),
        catalog,
    };
    let (plans, proxy) = kernel
        .lock()
        .map_err(|_| error("Routing controller unavailable."))?
        .pool_resource_downloads(
            &candidate["config"],
            serde_json::from_value(candidate["resources"].clone())
                .map_err(|_| error("Invalid prepared Pool resource files."))?,
        )?;
    worker::check(stop, shutdown)?;
    let files = crate::resources::download_files(&plans, stop, proxy);
    worker::check(stop, shutdown)?;
    let files = files?;
    let mut routing = kernel
        .lock()
        .map_err(|_| error("Routing controller unavailable."))?;
    worker::check(stop, shutdown)?;
    let observed = routing.subscription_profile();
    if observed.revision != proof.revision
        || observed.source_hash != proof.source_hash
        || observed.wants_running != proof.wants_running
    {
        return Err(error(
            "Routing changed during the Pool check. The previous configuration was kept.",
        ));
    }
    let mut next = (*current).clone();
    routing.install_pool_resources(&candidate["config"], files, stop)?;
    // A publication can change an unselected graph or Stash without changing
    // this computer's routing. Commit its delivery without invoking activation.
    let already_applied = (refresh || rebind.is_some())
        && applied
            .as_ref()
            .is_some_and(|(source, _, hash, _)| source == graph && hash == &pending.config_hash);
    next.pool_pending = Some(pending);
    manager.commit(next)?;
    if already_applied {
        return finish_pending(&routing, manager);
    }
    let activate =
        observed.wants_running || observed.running || initial.is_some_and(|input| input.start);
    let result = routing.handle(if activate { "config.applyAndStart" } else { "config.apply" }, json!({
        "config":candidate["config"],"capture":candidate["capture"],"displayNames":candidate["displayNames"],
        "sourceGraph":graph,"expectedRevision":observed.revision,
    }));
    if let Err(failure) = result {
        // Reconcile against the authoritative profile after any guarded rollback.
        // If recovery still owns a checkpoint, leave the Pool journal intact.
        if routing.pool_source().is_ok() {
            finish_pending(&routing, manager)?;
        }
        return Err(failure);
    }
    finish_pending(&routing, manager)
}

pub(super) fn finish_pending(routing: &Kernel, manager: &Manager) -> Result<()> {
    let current = manager.state.lock().unwrap().library.clone();
    let Some(pending) = &current.pool_pending else {
        return Ok(());
    };
    let mut next = (*current).clone();
    if let Some((graph, revision, hash, source_hash)) = routing.pool_source()? {
        if hash == pending.config_hash && digest(&graph) == pending.source_digest {
            let mut connection = pending.connection.clone();
            connection.verified_source = Some(source_hash.clone());
            next.pool = Some(connection);
            next.stash = Some(pending.stash.clone());
            next.catalog = pending.catalog.clone();
            next.applied = Some(Applied {
                graph,
                revision,
                hash,
                source_hash,
            });
            next.version = next
                .version
                .checked_add(1)
                .ok_or_else(|| error("Stash version exhausted."))?;
        }
    }
    next.pool_pending = None;
    manager.commit(next)
}

pub(super) fn next_check(connection: Option<&Connection>) -> Instant {
    let minutes =
        connection.map_or_else(default_minutes, |pool| pool.refresh_minutes.clamp(1, 1440));
    Instant::now() + Duration::from_secs(60 * minutes)
}
