//! Service-owned library and a single background maintenance actor.
//! Slow parsing, downloads and probes never hold the routing mutex.
pub(crate) mod vault;
mod worker;
use crate::{events::Events, kernel::Kernel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use wayrill_protocol::{params, ApiError, Result};

const MAX_UPLOAD: usize = 256 * 1024 * 1024;
const CHUNK: usize = 512 * 1024;
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn invalid(message: &str) -> ApiError {
    ApiError::new("SUBSCRIPTION_STATE", message)
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    #[serde(default)]
    auto_refresh: bool,
    #[serde(default = "refresh_default")]
    refresh_minutes: u64,
    #[serde(default)]
    remove_unreachable: bool,
    #[serde(default = "retries_default")]
    max_retries: usize,
    #[serde(default)]
    via_proxy: bool,
}
fn refresh_default() -> u64 {
    360
}
fn retries_default() -> usize {
    2
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    id: String,
    kind: Option<String>,
    retained: bool,
    checked_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Group {
    id: String,
    name: String,
    url: String,
    user_agent: String,
    headers: BTreeMap<String, String>,
    allow_http: bool,
    maintenance: Settings,
    maintenance_paused: bool,
    updated_at: Option<u64>,
    last_test_at: Option<u64>,
    test_cycle_at: Option<u64>,
    entries: Vec<Entry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Applied {
    graph: String,
    revision: u64,
    hash: String,
    #[serde(default)]
    source_hash: String,
}
pub(crate) struct RuntimeSource {
    pub(crate) revision: u64,
    pub(crate) hash: Option<String>,
    pub(crate) source_hash: Option<String>,
    pub(crate) running: bool,
    pub(crate) wants_running: bool,
}
impl Applied {
    fn matches(&self, source: &RuntimeSource) -> bool {
        self.revision == source.revision
            && source.hash.as_deref() == Some(&self.hash)
            && source.source_hash.as_deref() == Some(&self.source_hash)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    owner_sid: String,
    version: u64,
    stash: Option<String>,
    catalog: Vec<Group>,
    draft: Option<String>,
    applied: Option<Applied>,
    test_url: String,
    #[serde(default)]
    test_context: String,
    pending: BTreeSet<String>,
    // Completed provider publications, frozen independently of editable Stash
    // definitions until runtime acknowledgement. Compact group JSON, not graphs.
    #[serde(default)]
    publications: BTreeMap<String, String>,
    retry_after: BTreeMap<String, u64>,
    last_group: String,
}
impl Library {
    fn empty(owner: String) -> Self {
        Self {
            owner_sid: owner,
            version: 0,
            stash: None,
            catalog: vec![],
            draft: None,
            applied: None,
            test_url: "https://www.google.com/generate_204".into(),
            test_context: String::new(),
            pending: BTreeSet::new(),
            publications: BTreeMap::new(),
            retry_after: BTreeMap::new(),
            last_group: String::new(),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    state: &'static str,
    message: String,
}
struct Upload {
    id: String,
    kind: String,
    expected: usize,
    text: String,
    at: Instant,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replacement {
    node_id: String,
    group_id: String,
    entry_id: String,
}
#[derive(Clone)]
enum Work {
    Replace {
        id: u64,
        selection: Replacement,
    },
    Upload {
        id: u64,
        kind: String,
        text: String,
    },
    Run {
        id: u64,
        group: String,
        operation: String,
        entries: Option<Vec<String>>,
    },
}
impl Work {
    fn id(&self) -> u64 {
        match self {
            Self::Upload { id, .. } | Self::Run { id, .. } | Self::Replace { id, .. } => *id,
        }
    }
    fn group(&self) -> Option<String> {
        match self {
            Self::Run { group, .. } => Some(group.clone()),
            _ => None,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Completed {
    job: u64,
    error: Option<ApiError>,
}
struct Active {
    job: u64,
    group: Option<String>,
    automatic: bool,
    cancelled_by_user: bool,
    stop: Arc<AtomicBool>,
}
struct Dispatch {
    work: Work,
    _reservation: Option<crate::operation_gate::Background>,
    stop: Arc<AtomicBool>,
}
struct State {
    source: Option<(String, String, Instant)>,
    library: Arc<Library>,
    error: Option<ApiError>,
    statuses: BTreeMap<String, Status>,
    upload: Option<Upload>,
    queue: VecDeque<Work>,
    active: Option<Active>,
    completed: VecDeque<Completed>,
}
#[derive(Clone)]
pub struct Manager {
    state: Arc<Mutex<State>>,
    pub(crate) gate: crate::operation_gate::Gate,
    path: PathBuf,
    events: Arc<Events>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    kind: String,
    #[serde(default)]
    offset: usize,
    version: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Begin {
    kind: String,
    bytes: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Chunk {
    token: String,
    offset: usize,
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    job: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Run {
    group_id: String,
    operation: String,
    entry_ids: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cancel {
    group_id: Option<String>,
    #[serde(default)]
    automatic_only: bool,
}

impl Manager {
    pub fn open(owner: &str, path: PathBuf, events: Arc<Events>) -> Self {
        let (mut library, error) = match vault::read(&path) {
            Ok(Some(library)) if library.owner_sid == owner => (library, None),
            Ok(None) => (Library::empty(owner.into()), None),
            Ok(Some(_)) => (
                Library::empty(owner.into()),
                Some(invalid(
                    "Subscription storage belongs to another owner; it was preserved.",
                )),
            ),
            Err(error) => (Library::empty(owner.into()), Some(error)),
        };
        // Older versions recorded group IDs without the approved definitions.
        // Never turn an unproven historical intent into activation of drafts.
        library
            .pending
            .retain(|id| library.publications.contains_key(id));
        Self {
            state: Arc::new(Mutex::new(State {
                source: None,
                library: Arc::new(library),
                error,
                statuses: BTreeMap::new(),
                upload: None,
                queue: VecDeque::new(),
                active: None,
                completed: VecDeque::new(),
            })),
            gate: crate::operation_gate::Gate::default(),
            path,
            events,
        }
    }
    /// Hold the library state through cursor capture so a newer event cannot
    /// be acknowledged while returning an older subscription view.
    pub(crate) fn synchronized<T>(&self, read: impl FnOnce(Value) -> T) -> T {
        let state = self.state.lock().unwrap();
        read(Self::view(&state))
    }
    pub fn snapshot(&self) -> Value {
        self.synchronized(|view| view)
    }
    fn view(state: &State) -> Value {
        json!({"version":state.library.version,"initialized":state.library.stash.is_some(),"error":state.error,
            "busy":state.active.is_some(),"automatic":state.active.as_ref().is_some_and(|a|a.automatic),
            "statuses":state.statuses,"appliedRevision":state.library.applied.as_ref().map(|a|a.revision),
            "appliedSourceHash":state.library.applied.as_ref().map(|a|&a.source_hash)})
    }
    fn notify(&self, state: &State, kind: &str) {
        self.events.publish(kind, Self::view(state));
    }
    pub fn handle(&self, method: &str, input: Value) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        // Applying a saved graph must remain possible when the separate library
        // cannot be opened. Source staging never replaces that damaged file.
        let source_transfer = method == "subscriptions.uploadStart" && input["kind"] == "source"
            || matches!(
                method,
                "subscriptions.uploadChunk" | "subscriptions.uploadCommit"
            ) && state.upload.as_ref().is_some_and(|u| u.kind == "source");
        if state.error.is_some()
            && !source_transfer
            && !matches!(
                method,
                "subscriptions.status" | "subscriptions.cancel" | "subscriptions.uploadAbort"
            )
        {
            return Err(state.error.clone().unwrap());
        }
        match method {
            "subscriptions.status" => {
                let _: crate::kernel::Empty = params(input)?;
                drop(state);
                Ok(self.snapshot())
            }
            "subscriptions.read" => {
                let p: Read = params(input)?;
                let (text, version) = match p.kind.as_str() {
                    "stash" => (state.library.stash.as_deref(), state.library.version),
                    "applied" => (
                        state.library.applied.as_ref().map(|a| a.graph.as_str()),
                        state.library.version,
                    ),
                    _ => return Err(invalid("Unknown subscription document.")),
                };
                if p.version.is_some_and(|v| v != version) {
                    return Err(ApiError::new(
                        "REVISION_CONFLICT",
                        "Subscription document changed while reading; retry.",
                    ));
                }
                let text = text.unwrap_or("");
                if p.offset > text.len() || !text.is_char_boundary(p.offset) {
                    return Err(invalid("Invalid document offset."));
                }
                let mut end = (p.offset + CHUNK).min(text.len());
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                Ok(
                    json!({"version":version,"initialized":!text.is_empty(),"text":&text[p.offset..end],"nextOffset":end,"totalBytes":text.len()}),
                )
            }
            "subscriptions.uploadStart" => {
                let p: Begin = params(input)?;
                if !["save", "context", "source"].contains(&p.kind.as_str())
                    || p.bytes > MAX_UPLOAD
                    || p.kind == "source" && p.bytes > 64 * 1024 * 1024
                {
                    return Err(invalid("Invalid subscription upload."));
                }
                if state
                    .upload
                    .as_ref()
                    .is_some_and(|u| u.at.elapsed() < Duration::from_secs(120))
                {
                    return Err(ApiError::new(
                        "BUSY",
                        "Another subscription upload is in progress.",
                    ));
                }
                let id = crate::tun::random_id()?;
                state.upload = Some(Upload {
                    id: id.clone(),
                    kind: p.kind,
                    expected: p.bytes,
                    text: String::new(),
                    at: Instant::now(),
                });
                Ok(json!({"token":id,"chunkBytes":CHUNK}))
            }
            "subscriptions.uploadChunk" => {
                let p: Chunk = params(input)?;
                let upload = state
                    .upload
                    .as_mut()
                    .filter(|u| u.id == p.token && u.at.elapsed() < Duration::from_secs(120))
                    .ok_or_else(|| invalid("Subscription upload expired."))?;
                if p.offset != upload.text.len()
                    || p.text.len() > CHUNK
                    || upload.text.len() + p.text.len() > upload.expected
                {
                    return Err(invalid("Invalid subscription upload chunk."));
                }
                upload.text.push_str(&p.text);
                upload.at = Instant::now();
                Ok(json!({"offset":upload.text.len()}))
            }
            "subscriptions.uploadAbort" => {
                let p: Token = params(input)?;
                if state.upload.as_ref().is_some_and(|u| u.id == p.token) {
                    state.upload = None;
                }
                Ok(json!({}))
            }
            "subscriptions.uploadCommit" => {
                let p: Token = params(input)?;
                if state.queue.len() >= 4
                    && !state.upload.as_ref().is_some_and(|u| u.kind == "source")
                {
                    return Err(ApiError::new("BUSY", "Subscription work queue is full."));
                }
                let upload = state
                    .upload
                    .as_ref()
                    .filter(|u| u.id == p.token && u.at.elapsed() < Duration::from_secs(120))
                    .ok_or_else(|| invalid("Missing or expired subscription upload."))?;
                if upload.text.len() != upload.expected {
                    return Err(invalid("Incomplete subscription upload."));
                }
                let queued_bytes: usize = state
                    .queue
                    .iter()
                    .map(|w| match w {
                        Work::Upload { text, .. } => text.len(),
                        _ => 0,
                    })
                    .sum();
                if queued_bytes + upload.text.len() > MAX_UPLOAD {
                    return Err(ApiError::new(
                        "BUSY",
                        "Wait for subscription saves to finish.",
                    ));
                }
                let upload = state.upload.take().unwrap();
                if upload.kind == "source" {
                    let token = upload.id.clone();
                    state.source = Some((upload.id, upload.text, Instant::now()));
                    return Ok(json!({"sourceGraphToken":token}));
                }
                let id = u64::from_str_radix(&crate::tun::random_id()?[..13], 16)
                    .map_err(|_| invalid("Cannot create subscription job identity."))?
                    .max(1);
                let automatic_only = upload.kind == "context";
                state.queue.push_back(Work::Upload {
                    id,
                    kind: upload.kind,
                    text: upload.text,
                });
                interrupt_maintenance(&state, automatic_only);
                Ok(json!({"job":id}))
            }
            "subscriptions.replace" => {
                let selection: Replacement = params(input)?;
                if [&selection.node_id, &selection.group_id, &selection.entry_id]
                    .iter()
                    .any(|s| s.is_empty() || s.len() > 128)
                {
                    return Err(invalid("Invalid outbound replacement identity."));
                }
                // Coalesce choices that have not started, without overtaking
                // earlier library saves or growing a second work queue.
                let mut superseded = vec![];
                state.queue.retain(|work| {
                    if let Work::Replace { id, selection: old } = work {
                        if old.node_id == selection.node_id {
                            superseded.push(*id);
                            return false;
                        }
                    }
                    true
                });
                for job in superseded {
                    Self::complete_locked(
                        &mut state,
                        job,
                        Some(ApiError::new(
                            "SUPERSEDED",
                            "A newer replacement was selected.",
                        )),
                    );
                }
                if state.queue.len() >= 4 {
                    return Err(ApiError::new("BUSY", "Subscription work queue is full."));
                }
                let id = u64::from_str_radix(&crate::tun::random_id()?[..13], 16)
                    .map_err(|_| invalid("Cannot create subscription job identity."))?
                    .max(1);
                state.queue.push_back(Work::Replace { id, selection });
                interrupt_maintenance(&state, false);
                Ok(json!({"job":id}))
            }
            "subscriptions.run" => {
                let p: Run = params(input)?;
                if !["refresh", "test"].contains(&p.operation.as_str())
                    || p.group_id.len() > 128
                    || p.entry_ids.as_ref().is_some_and(|e| e.len() > 50000)
                {
                    return Err(invalid("Invalid subscription operation."));
                }
                if state.queue.len() >= 4 {
                    return Err(ApiError::new("BUSY", "Subscription work queue is full."));
                }
                let id = u64::from_str_radix(&crate::tun::random_id()?[..13], 16)
                    .map_err(|_| invalid("Cannot create subscription job identity."))?
                    .max(1);
                state.queue.push_back(Work::Run {
                    id,
                    group: p.group_id,
                    operation: p.operation,
                    entries: p.entry_ids,
                });
                interrupt_maintenance(&state, true);
                Ok(json!({"job":id}))
            }
            "subscriptions.job" => {
                let p: Job = params(input)?;
                if let Some(done) = state.completed.iter().find(|r| r.job == p.job) {
                    return Ok(json!({"busy":false,"error":done.error}));
                }
                if state.active.as_ref().is_some_and(|a| a.job == p.job)
                    || state.queue.iter().any(|w| w.id() == p.job)
                {
                    return Ok(json!({"busy":true,"error":null}));
                }
                Err(invalid(
                    "Subscription job is unavailable; refresh the library before retrying.",
                ))
            }
            "subscriptions.cancel" => {
                let p: Cancel = params(input)?;
                if let Some(active) = &mut state.active {
                    if (active.automatic || active.group.is_some())
                        && (!p.automatic_only || active.automatic)
                        && p.group_id
                            .as_ref()
                            .is_none_or(|g| active.group.as_ref() == Some(g))
                    {
                        active.cancelled_by_user = true;
                        active.stop.store(true, Ordering::Release);
                    }
                }
                if !p.automatic_only {
                    let mut cancelled = vec![];
                    state.queue.retain(|work| {
                        if let Work::Run { id, group, .. } = work {
                            if p.group_id.as_ref().is_none_or(|g| g == group) {
                                cancelled.push(*id);
                                return false;
                            }
                        }
                        true
                    });
                    for job in cancelled {
                        state.completed.push_back(Completed {
                            job,
                            error: Some(worker::cancelled()),
                        });
                    }
                    while state.completed.len() > 8 {
                        state.completed.pop_front();
                    }
                }
                Ok(json!({}))
            }
            _ => Err(ApiError::new(
                "METHOD_NOT_FOUND",
                "Unknown subscription method.",
            )),
        }
    }
    fn commit(&self, mut library: Library) -> Result<()> {
        {
            let state = self.state.lock().unwrap();
            if state.library.applied.as_ref().map(|a| &a.graph)
                != library.applied.as_ref().map(|a| &a.graph)
            {
                library.version = library.version.max(
                    state
                        .library
                        .version
                        .checked_add(1)
                        .ok_or_else(|| invalid("Subscription version exhausted."))?,
                );
            }
        }
        vault::write(&self.path, &library)?;
        let mut state = self.state.lock().unwrap();
        state.library = Arc::new(library);
        let ids: BTreeSet<_> = state.library.catalog.iter().map(|g| g.id.clone()).collect();
        state
            .statuses
            .retain(|id, _| ids.contains(id) || id == "runtime");
        self.notify(&state, "subscriptions.changed");
        Ok(())
    }
    pub(crate) fn take_source(&self, token: &str) -> Result<String> {
        let mut state = self.state.lock().unwrap();
        if !state
            .source
            .as_ref()
            .is_some_and(|(id, _, at)| id == token && at.elapsed() < Duration::from_secs(120))
        {
            return Err(invalid("The source graph upload expired. Apply again."));
        }
        Ok(state.source.take().unwrap().1)
    }
    fn status(&self, id: &str, state: &'static str, message: impl Into<String>) {
        let message = message.into();
        if state == "error" {
            crate::diagnostics::log(
                "subscriptions",
                "warning",
                &format!("Subscription maintenance: {message}"),
            );
        }
        let mut current = self.state.lock().unwrap();
        current
            .statuses
            .insert(id.into(), Status { state, message });
        self.notify(&current, "subscriptions.progress");
    }
    fn clear_status(&self, id: &str) {
        let mut state = self.state.lock().unwrap();
        if state.statuses.remove(id).is_some() {
            self.notify(&state, "subscriptions.progress");
        }
    }
    fn begin(&self, job: u64, group: Option<String>, automatic: bool, stop: Arc<AtomicBool>) {
        let mut state = self.state.lock().unwrap();
        Self::begin_locked(&mut state, job, group, automatic, stop);
        self.notify(&state, "subscriptions.progress");
    }
    fn begin_locked(
        state: &mut State,
        job: u64,
        group: Option<String>,
        automatic: bool,
        stop: Arc<AtomicBool>,
    ) {
        state.active = Some(Active {
            job,
            group,
            automatic,
            cancelled_by_user: false,
            stop: stop.clone(),
        });
    }
    fn next_work(&self) -> Option<Dispatch> {
        let mut state = self.state.lock().unwrap();
        let reservation = match state.queue.front()? {
            Work::Run { .. } | Work::Replace { .. } => Some(self.gate.background()?),
            Work::Upload { .. } => None,
        };
        let work = state.queue.pop_front()?;
        let (id, group) = (work.id(), work.group());
        let stop = reservation
            .as_ref()
            .map_or_else(|| Arc::new(AtomicBool::new(false)), |r| r.stop.clone());
        Self::begin_locked(&mut state, id, group, false, stop.clone());
        self.notify(&state, "subscriptions.progress");
        Some(Dispatch {
            work,
            _reservation: reservation,
            stop,
        })
    }
    fn finish(&self, job: u64, error: Option<ApiError>) {
        if let Some(error) = error.as_ref().filter(|e| e.code != "CANCELLED") {
            crate::diagnostics::log(
                "subscriptions",
                "warning",
                &format!(
                    "Subscription job failed ({}): {}",
                    error.code, error.message
                ),
            );
        }
        let mut state = self.state.lock().unwrap();
        state.active = None;
        Self::complete_locked(&mut state, job, error);
        self.notify(&state, "subscriptions.progress");
    }
    fn complete_locked(state: &mut State, job: u64, error: Option<ApiError>) {
        if job != 0 {
            state.completed.push_back(Completed { job, error });
            while state.completed.len() > 8 {
                state.completed.pop_front();
            }
        }
    }
    fn retry_replacement(&self, work: Work) {
        let mut state = self.state.lock().unwrap();
        state.active = None;
        let Work::Replace { selection, .. } = &work else {
            return;
        };
        if state.queue.iter().any(|w| matches!(w, Work::Replace { selection: newer, .. } if newer.node_id == selection.node_id)) {
            Self::complete_locked(&mut state, work.id(), Some(ApiError::new("SUPERSEDED", "A newer replacement was selected.")));
        } else { state.queue.push_back(work); }
        self.notify(&state, "subscriptions.progress");
    }
    pub(crate) fn stop_replacements(&self) {
        let mut state = self.state.lock().unwrap();
        let mut cancelled = vec![];
        state.queue.retain(|work| {
            if matches!(work, Work::Replace { .. }) {
                cancelled.push(work.id());
                false
            } else {
                true
            }
        });
        for job in cancelled {
            Self::complete_locked(&mut state, job, Some(worker::cancelled()));
        }
        self.notify(&state, "subscriptions.progress");
    }
    fn user_cancelled(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .is_some_and(|a| a.cancelled_by_user)
    }
}
// Authored library changes and route assignments take precedence over checks or
// downloads. The actor drains the interrupted work before accepting the edit;
// uploads and an in-flight route commit retain their ordered transaction.
fn interrupt_maintenance(state: &State, automatic_only: bool) {
    if let Some(active) = &state.active {
        if active.automatic || !automatic_only && active.group.is_some() {
            active.stop.store(true, Ordering::Release);
        }
    }
}
pub struct Actor {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Actor {
    pub fn failed(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(|thread| thread.is_finished())
            && !self.stop.load(Ordering::Acquire)
    }
    pub fn start(kernel: Arc<Mutex<Kernel>>, manager: Manager) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let shutdown = stop.clone();
        let thread = std::thread::Builder::new()
            .name("wayrill-subscriptions".into())
            .stack_size(4 * 1024 * 1024)
            .spawn(move || worker::run(kernel, manager, shutdown))
            .map_err(|e| ApiError::io("Start subscription maintenance", e))?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}
impl Drop for Actor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_choices_coalesce_only_while_queued_and_stop_does_not_discard_saves() {
        let manager = manager();
        let choose = |node, entry| {
            manager
                .handle(
                    "subscriptions.replace",
                    json!({"nodeId":node,"groupId":"g","entryId":entry}),
                )
                .unwrap()["job"]
                .as_u64()
                .unwrap()
        };
        let old = choose("one", "first");
        let newer = choose("one", "second");
        let other = choose("two", "third");
        assert_eq!(
            manager
                .handle("subscriptions.job", json!({"job":old}))
                .unwrap()["error"]["code"],
            "SUPERSEDED"
        );
        let reservation = manager.gate.foreground(&AtomicBool::new(false)).unwrap();
        assert!(manager.next_work().is_none());
        manager.state.lock().unwrap().queue.push_back(Work::Upload {
            id: 99,
            kind: "context".into(),
            text: "{}".into(),
        });
        manager.stop_replacements();
        for job in [newer, other] {
            assert_eq!(
                manager
                    .handle("subscriptions.job", json!({"job":job}))
                    .unwrap()["error"]["code"],
                "CANCELLED"
            );
        }
        let save = manager.next_work().unwrap();
        assert!(matches!(save.work, Work::Upload { id: 99, .. }));
        assert!(!save.stop.load(Ordering::Acquire));
        drop(reservation);
    }
    #[test]
    fn interrupted_replacement_yields_to_newer_choices_without_losing_job_identity() {
        let manager = manager();
        let choose = |entry| {
            manager
                .handle(
                    "subscriptions.replace",
                    json!({"nodeId":"one","groupId":"g","entryId":entry}),
                )
                .unwrap()["job"]
                .as_u64()
                .unwrap()
        };
        let first = choose("first");
        let dispatch = manager.next_work().unwrap();
        manager.retry_replacement(dispatch.work.clone());
        drop(dispatch);
        let dispatch = manager.next_work().unwrap();
        assert_eq!(dispatch.work.id(), first);
        let newer = choose("second");
        manager.retry_replacement(dispatch.work.clone());
        drop(dispatch);
        assert_eq!(
            manager
                .handle("subscriptions.job", json!({"job":first}))
                .unwrap()["error"]["code"],
            "SUPERSEDED"
        );
        let dispatch = manager.next_work().unwrap();
        assert_eq!(dispatch.work.id(), newer);
        // A competing foreground action interrupts preparation and drains it
        // before it can take the kernel; its reservation then blocks retry.
        use std::{sync::mpsc, thread};
        let gate = manager.gate.clone();
        let (tx, rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            let guard = gate.foreground(&AtomicBool::new(false)).unwrap();
            tx.send(guard).unwrap();
        });
        let until = Instant::now() + Duration::from_secs(2);
        while !dispatch.stop.load(Ordering::Acquire) {
            assert!(Instant::now() < until);
            thread::yield_now();
        }
        manager.retry_replacement(dispatch.work.clone());
        assert!(rx.try_recv().is_err());
        drop(dispatch);
        let guard = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(manager.next_work().is_none());
        manager.stop_replacements();
        drop(guard);
        waiter.join().unwrap();
        assert!(manager.next_work().is_none());
    }
    #[test]
    fn source_proof_includes_metadata_identity_even_when_config_revision_is_unchanged() {
        let applied = Applied {
            graph: "graph".into(),
            revision: 7,
            hash: "config".into(),
            source_hash: "one".into(),
        };
        let mut source = RuntimeSource {
            revision: 7,
            hash: Some("config".into()),
            source_hash: Some("one".into()),
            running: true,
            wants_running: true,
        };
        assert!(applied.matches(&source));
        source.source_hash = Some("two".into());
        assert!(!applied.matches(&source));
    }
    fn manager() -> Manager {
        Manager::open(
            "test-owner",
            std::env::temp_dir().join(format!(
                "wayrill-subscriptions-{}.dpapi",
                crate::tun::random_id().unwrap()
            )),
            Events::new(),
        )
    }
    #[test]
    fn uploads_enforce_utf8_byte_offsets_and_consume_source_tokens_once() {
        let manager = manager();
        let begin = manager
            .handle(
                "subscriptions.uploadStart",
                json!({"kind":"source","bytes":7}),
            )
            .unwrap();
        let token = begin["token"].as_str().unwrap();
        manager
            .handle(
                "subscriptions.uploadChunk",
                json!({"token":token,"offset":0,"text":"🛰"}),
            )
            .unwrap();
        assert!(manager
            .handle(
                "subscriptions.uploadChunk",
                json!({"token":token,"offset":2,"text":"abc"})
            )
            .is_err());
        assert!(manager
            .handle("subscriptions.uploadCommit", json!({"token":token}))
            .is_err());
        manager
            .handle(
                "subscriptions.uploadChunk",
                json!({"token":token,"offset":4,"text":"abc"}),
            )
            .unwrap();
        manager
            .handle("subscriptions.uploadCommit", json!({"token":token}))
            .unwrap();
        assert_eq!(manager.take_source(token).unwrap(), "🛰abc");
        assert!(manager.take_source(token).is_err());
    }
    #[test]
    fn cancellation_removes_only_matching_queued_runs_and_preserves_saves() {
        let manager = manager();
        let a = manager
            .handle(
                "subscriptions.run",
                json!({"groupId":"a","operation":"test"}),
            )
            .unwrap()["job"]
            .as_u64()
            .unwrap();
        let b = manager
            .handle(
                "subscriptions.run",
                json!({"groupId":"b","operation":"refresh"}),
            )
            .unwrap()["job"]
            .as_u64()
            .unwrap();
        manager
            .handle("subscriptions.cancel", json!({"groupId":"a"}))
            .unwrap();
        assert_eq!(
            manager
                .handle("subscriptions.job", json!({"job":a}))
                .unwrap()["error"]["code"],
            "CANCELLED"
        );
        assert_eq!(
            manager
                .handle("subscriptions.job", json!({"job":b}))
                .unwrap()["busy"],
            true
        );
        assert_eq!(manager.state.lock().unwrap().queue.len(), 1);
    }
    #[test]
    fn a_storage_failure_cannot_prevent_foreground_routing() {
        let manager = manager();
        manager.state.lock().unwrap().error = Some(invalid("Unreadable library"));
        let _reservation = manager.gate.foreground(&AtomicBool::new(false)).unwrap();
        assert!(manager
            .handle("subscriptions.read", json!({"kind":"stash"}))
            .is_err());
        let upload = manager
            .handle(
                "subscriptions.uploadStart",
                json!({"kind":"source","bytes":2}),
            )
            .unwrap();
        manager
            .handle(
                "subscriptions.uploadChunk",
                json!({"token":upload["token"],"offset":0,"text":"{}"}),
            )
            .unwrap();
        manager
            .handle(
                "subscriptions.uploadCommit",
                json!({"token":upload["token"]}),
            )
            .unwrap();
        assert_eq!(
            manager
                .take_source(upload["token"].as_str().unwrap())
                .unwrap(),
            "{}"
        );
        assert!(manager
            .handle(
                "subscriptions.uploadStart",
                json!({"kind":"save","bytes":0})
            )
            .is_err());
    }
    #[test]
    fn admission_defers_runs_but_allows_library_saves_and_preserves_their_completion() {
        let manager = manager();
        let job = manager
            .handle(
                "subscriptions.run",
                json!({"groupId":"g","operation":"test"}),
            )
            .unwrap()["job"]
            .as_u64()
            .unwrap();
        let reservation = manager.gate.foreground(&AtomicBool::new(false)).unwrap();
        assert!(manager.next_work().is_none());
        manager
            .handle("subscriptions.cancel", json!({"groupId":"g"}))
            .unwrap();
        assert_eq!(
            manager
                .handle("subscriptions.job", json!({"job":job}))
                .unwrap()["error"]["code"],
            "CANCELLED"
        );
        let upload = manager
            .handle(
                "subscriptions.uploadStart",
                json!({"kind":"save","bytes":2}),
            )
            .unwrap();
        manager
            .handle(
                "subscriptions.uploadChunk",
                json!({"token":upload["token"],"offset":0,"text":"{}"}),
            )
            .unwrap();
        let saved = manager
            .handle(
                "subscriptions.uploadCommit",
                json!({"token":upload["token"]}),
            )
            .unwrap()["job"]
            .as_u64()
            .unwrap();
        let dispatch = manager.next_work().unwrap();
        assert!(matches!(dispatch.work, Work::Upload { id, .. } if id == saved));
        manager.handle("subscriptions.cancel", json!({})).unwrap();
        assert!(!dispatch.stop.load(Ordering::Acquire));
        manager.finish(saved, None);
        assert_eq!(
            manager
                .handle("subscriptions.job", json!({"job":saved}))
                .unwrap(),
            json!({"busy":false,"error":null})
        );
        drop(dispatch);
        drop(reservation);
        assert!(manager.gate.background().is_some());
    }
    #[test]
    fn subscription_cursor_and_snapshot_cannot_acknowledge_a_change_they_omit() {
        use std::{sync::mpsc, thread};
        let manager = manager();
        let copy = manager.clone();
        let (ready, waiting) = mpsc::channel();
        let (thread, mut receiver) = manager.synchronized(|view| {
            let thread = thread::spawn(move || {
                ready.send(()).unwrap();
                copy.status("provider", "testing", "1 of 4");
                copy.finish(7, None);
            });
            waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            let (sequence, _, _, receiver) = manager.events.subscribe(0, None);
            assert_eq!(sequence, 0);
            assert!(view["statuses"].as_object().unwrap().is_empty());
            (thread, receiver)
        });
        thread.join().unwrap();
        let mut views = Vec::new();
        while let Ok(wayrill_protocol::Message::Event {
            sequence, payload, ..
        }) = receiver.try_recv()
        {
            views.push((sequence, payload));
        }
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].0, 1);
        assert_eq!(views[0].1["statuses"]["provider"]["message"], "1 of 4");
        assert_eq!(views[1].0, 2);
        assert_eq!(views[1].1, manager.snapshot());
        assert_eq!(
            manager
                .handle("subscriptions.job", json!({"job":7}))
                .unwrap()["busy"],
            false
        );
    }
    #[test]
    fn observers_receive_started_and_terminal_job_states_without_polling() {
        let manager = manager();
        let (_, _, _, mut receiver) = manager.events.subscribe(0, None);
        manager.begin(
            9,
            Some("provider".into()),
            false,
            Arc::new(AtomicBool::new(false)),
        );
        manager.finish(9, Some(worker::cancelled()));
        let wayrill_protocol::Message::Event {
            payload: started, ..
        } = receiver.try_recv().unwrap()
        else {
            panic!("missing start event")
        };
        let wayrill_protocol::Message::Event {
            payload: finished, ..
        } = receiver.try_recv().unwrap()
        else {
            panic!("missing terminal event")
        };
        assert_eq!(started["busy"], true);
        assert_eq!(finished["busy"], false);
        assert_eq!(
            manager
                .handle("subscriptions.job", json!({"job":9}))
                .unwrap()["error"]["code"],
            "CANCELLED"
        );
    }
    #[test]
    fn job_identities_do_not_restart_at_one_with_a_new_coordinator() {
        let one = manager();
        let two = manager();
        let a = one
            .handle(
                "subscriptions.run",
                json!({"groupId":"g","operation":"test"}),
            )
            .unwrap()["job"]
            .as_u64()
            .unwrap();
        let b = two
            .handle(
                "subscriptions.run",
                json!({"groupId":"g","operation":"test"}),
            )
            .unwrap()["job"]
            .as_u64()
            .unwrap();
        assert_ne!(a, b);
        assert!(two.handle("subscriptions.job", json!({"job":a})).is_err());
    }
    #[test]
    fn authored_mutations_interrupt_manual_maintenance_but_context_does_not() {
        for kind in ["context", "save", "replace"] {
            for group in [Some("manual".into()), None] {
                let manager = manager();
                let stop = Arc::new(AtomicBool::new(false));
                manager.begin(1, group.clone(), false, stop.clone());
                if kind == "replace" {
                    manager
                        .handle(
                            "subscriptions.replace",
                            json!({"nodeId":"n","groupId":"g","entryId":"e"}),
                        )
                        .unwrap();
                } else {
                    let upload = manager
                        .handle("subscriptions.uploadStart", json!({"kind":kind,"bytes":2}))
                        .unwrap();
                    manager
                        .handle(
                            "subscriptions.uploadChunk",
                            json!({"token":upload["token"],"offset":0,"text":"{}"}),
                        )
                        .unwrap();
                    manager
                        .handle(
                            "subscriptions.uploadCommit",
                            json!({"token":upload["token"]}),
                        )
                        .unwrap();
                }
                assert_eq!(
                    stop.load(Ordering::Acquire),
                    kind != "context" && group.is_some(),
                    "{kind}"
                );
                assert_eq!(manager.state.lock().unwrap().queue.len(), 1);
            }
        }
    }
}
