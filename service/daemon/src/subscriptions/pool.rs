//! Managed Pool enrollment shares the subscription actor's admission and durable
//! library. Downloads and compilation run outside the routing lock.
use super::*;
use crate::pool_access::Source;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

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
    checked_at: u64,
    #[serde(default = "default_minutes")]
    pub(super) refresh_minutes: u64,
    #[serde(default)]
    published_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bindings: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selection: Option<Selection>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    choice_names: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    routing_digest: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutboundChoice {
    #[serde(rename = "groupId")]
    group_id: String,
    #[serde(rename = "entryId")]
    entry_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    graph: String,
    #[serde(default, rename = "followDefault")]
    follow_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stashes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filters: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outbounds: Option<BTreeMap<String, OutboundChoice>>,
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
    bindings: Option<BTreeMap<String, String>>,
    expected_digest: Option<String>,
    selection: Option<Selection>,
    #[serde(default = "default_minutes")]
    refresh_minutes: u64,
}
impl Enrollment {
    pub(super) fn validate(&self) -> Result<()> {
        self.source.location()?;
        validate_minutes(self.refresh_minutes)?;
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
    selection: Option<Selection>,
    bindings: Option<BTreeMap<String, String>>,
    expected_digest: Option<String>,
    #[serde(default)]
    reset_bindings: bool,
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
    expected_digest: String,
    bindings: BTreeMap<String, String>,
    selection: Option<Selection>,
}
impl BindingChange {
    pub(super) fn validate(&self) -> Result<()> {
        validate_selection(&self.capture, Some(&self.bindings), self.selection.as_ref())
    }
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
        })
    });
    json!({"connection":connection,"error":state.pool_error,"lastCheckAt":state.pool_last_check,
        "busy":state.pool_busy || state.library.pool_pending.is_some() || state.queue.iter().any(|work| matches!(work, Work::Pool { .. }))})
}

fn verify_routing(
    connection: &Connection,
    graph: Option<&str>,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    let baseline = connection.routing_digest.as_deref().ok_or_else(|| {
        ApiError::new("POOL_REVIEW_REQUIRED", "A new Pool delivery is available. Review and apply your choices once to resume automatic updates.")
    })?;
    let routing = worker::helper(
        &json!({"operation":"poolRoutingState","appliedGraph":graph}),
        stop,
        shutdown,
    )?;
    if digest(&routing["poolRoutingState"].to_string()) != baseline {
        return Err(ApiError::new("POOL_LOCAL_ROUTING", "Pool updates are paused because you applied personal routing changes. Open Edit configuration choices to resume managed routing."));
    }
    Ok(())
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
    let saved_selection = current
        .pool
        .as_ref()
        .and_then(|pool| pool.selection.as_ref());
    let mut selection = initial
        .and_then(|input| input.selection.as_ref())
        .or_else(|| rebind.and_then(|input| input.selection.as_ref()))
        .or_else(|| preview.and_then(|input| input.selection.as_ref()))
        .or(saved_selection)
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
    let (proof, applied, owner) = {
        let routing = kernel
            .lock()
            .map_err(|_| error("Routing controller unavailable."))?;
        let proof = routing.subscription_profile();
        if let Some(expected) = expected_revision {
            if expected != proof.revision {
                return Err(error(
                    "The applied graph changed. Review the capture choice and try again.",
                ));
            }
        } else if proof.wants_running && !proof.running {
            return Err(error("Waiting for the running configuration to recover."));
        }
        (proof, routing.pool_source()?, current.owner_sid.clone())
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
    let request = json!({"operation":"poolDownload","source":source});
    let response = match worker::helper_as(&request, identity, stop, shutdown) {
        Err(error) if source.kind == "folder" && error.code == "OWNER_NOT_LOGGED_ON" => {
            worker::helper(&request, stop, shutdown)
        }
        result => result,
    }?;
    let text = response
        .as_str()
        .ok_or_else(|| error("Invalid Pool download response."))?;
    let (bundle, published_version, content_digest) = crate::pool_access::publication(text)?;
    let pool_name = bundle["poolName"].as_str().map(str::to_owned);
    if matches!(task, Task::Refresh) {
        if let Some(choice) = selection.as_mut().filter(|choice| choice.follow_default) {
            if let Some(default) = bundle["defaultGraph"].as_str() {
                choice.graph = default.into();
            }
        }
    }
    let connection = current.pool.as_ref().filter(|_| initial.is_none());
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
        if matches!(task, Task::Refresh)
            && (connection.routing_digest.is_some() || connection.digest != content_digest)
        {
            verify_routing(
                connection,
                applied.as_ref().map(|value| value.0.as_str()),
                stop,
                shutdown,
            )?;
        }
        if matches!(task, Task::Refresh) && connection.digest == content_digest {
            if connection.published_version < published_version {
                let mut next = (*current).clone();
                next.pool.as_mut().unwrap().published_version = published_version;
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
    if preview.is_some() {
        let mut response = worker::helper(
            &json!({"operation":"poolInspect","appliedGraph":applied.as_ref().map(|value| &value.0),
            "bundle":bundle,"capture":capture,"bindings":bindings,"poolSelection":selection,"poolChoiceNames":choice_names}),
            stop,
            shutdown,
        )?;
        let mut preview = response["poolEntries"].take();
        let entries = preview
            .as_object_mut()
            .ok_or_else(|| error("Invalid Pool preview."))?;
        entries.insert("digest".into(), json!(content_digest));
        entries.insert("revision".into(), json!(proof.revision));
        let id = job.ok_or_else(|| error("Missing Pool preview job."))?;
        manager.state.lock().unwrap().pool_preview = Some((id, preview));
        return Ok(());
    }
    let candidate = worker::helper(
        &json!({"operation":"poolPrepare","stash":current.stash.as_deref().unwrap_or(""),
        "appliedGraph":applied.as_ref().map(|value| &value.0),"bundle":bundle,"recipient":recipient,
        "capture":capture,"bindings":bindings,"poolSelection":selection,"poolChoiceNames":choice_names}),
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
    let pending = Pending {
        connection: Connection {
            source: source.clone(),
            name: name.into(),
            pool_name,
            digest: content_digest,
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
            bindings: bindings.cloned(),
            selection: serde_json::from_value(candidate["poolSelection"].clone())
                .map_err(|_| error("Invalid prepared Pool selection."))?,
            choice_names: candidate["poolChoiceNames"].clone(),
            routing_digest: Some(digest(&candidate["poolRoutingState"].to_string())),
        },
        source_digest: digest(graph),
        config_hash: Kernel::subscription_candidate_hash(&candidate)?,
        stash: stash.into(),
        catalog,
    };
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
    routing.validate_pool_resources(&candidate["config"])?;
    next.pool_pending = Some(pending);
    manager.commit(next)?;
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
            next.pool = Some(pending.connection.clone());
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
