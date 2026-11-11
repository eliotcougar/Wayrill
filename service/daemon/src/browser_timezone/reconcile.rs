//! One actor reconciles saved intent with startup registrations and live
//! processes. Native work never holds the UI snapshot or policy-store lock.
use super::{identity, select_process_record, select_record, Manager, Records};
use crate::native;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};

struct Applied {
    record: String,
    revision: u64,
    checked: Instant,
    error: Option<String>,
    refreshes_left: u8,
}
struct StartupApplied {
    target: crate::timezone_startup::Target,
    record: String,
    revision: u64,
    enabled: bool,
    checked: Instant,
    error: Option<String>,
}
fn startup_target(
    path: &str,
    package: Option<String>,
    force: bool,
    detected: &mut BTreeMap<String, Option<crate::timezone_startup::Target>>,
) -> Option<crate::timezone_startup::Target> {
    let mut target = detected
        .entry(path.to_lowercase())
        .or_insert_with(|| crate::timezone_startup::detect(path))
        .clone()
        .or_else(|| {
            force.then(|| crate::timezone_startup::Target {
                path: path.into(),
                package: package.clone(),
                node: false,
            })
        })?;
    target.package = package;
    Some(target)
}
fn external_image(path: &str, root: &Path) -> bool {
    !Path::new(&path.to_lowercase()).starts_with(
        root.parent()
            .unwrap_or(root)
            .to_string_lossy()
            .to_lowercase(),
    )
}

struct Reconciler {
    manager: Manager,
    root: PathBuf,
    stop: Arc<AtomicBool>,
    worker: Option<crate::capture::Worker>,
    applied: BTreeMap<(u32, u64), Applied>,
    // Off still needs one full reconciliation of processes that could have
    // survived a policy change or service restart. Future launches are native.
    idle_revision: Option<u64>,
    startup: BTreeMap<String, StartupApplied>,
    targets: Option<BTreeMap<String, crate::timezone_startup::Target>>,
    detected: BTreeMap<String, Option<crate::timezone_startup::Target>>,
}
impl Reconciler {
    fn step(&mut self) -> Result<()> {
        let records = self.manager.records()?;
        let mut statuses = BTreeMap::new();
        self.startup(&records, &mut statuses)?;
        if !is_current(&self.manager, &self.stop, &records)? {
            return Ok(());
        }
        let (catalog, leased) = {
            let mut state = self
                .manager
                .state
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            (
                std::mem::take(&mut state.catalog_requested),
                state.lease.is_some_and(|t| t > Instant::now()),
            )
        };
        let result = self.processes(&records, catalog, leased, &mut statuses);
        // Publish a complete pass rather than exposing an empty status map
        // while a slow native operation is in progress. Snapshot revisions
        // still hide results for preferences changed during the pass.
        if is_current(&self.manager, &self.stop, &records)? {
            self.manager
                .state
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .statuses = statuses;
        }
        result
    }
    fn startup(
        &mut self,
        records: &Arc<Records>,
        statuses: &mut BTreeMap<String, Value>,
    ) -> Result<()> {
        if self.targets.is_none() {
            self.targets = Some(
                crate::timezone_startup::targets(Some(&self.manager.owner))?
                    .into_iter()
                    .map(|(_, target)| (target.path.to_lowercase(), target))
                    .collect(),
            );
        }
        let targets = self.targets.as_mut().unwrap();
        for record in records
            .values()
            .filter(|r| r.package.is_none() && external_image(&r.path, &self.root))
        {
            if Path::new(&record.path).is_file() {
                if let Some(target) =
                    startup_target(&record.path, None, record.startup, &mut self.detected)
                {
                    targets.entry(record.path.to_lowercase()).or_insert(target);
                }
            }
        }
        let revision = records.values().map(|r| r.revision).max().unwrap_or(0);
        // Startup registrations need saved intent, not a process inventory.
        // In particular, Off must work even when discovery is unavailable.
        let mut retired = Vec::new();
        // A package or a batch edit can prepare several images in one zone.
        // Resolve it once for this pass, without caching Windows zone data
        // across later changes to the installed timezone database.
        let mut zones = BTreeMap::new();
        for (path_key, known) in targets.iter() {
            if self.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let selected = select_record(records, &identity(&known.path), known.package.as_deref())
                .filter(|_| external_image(&known.path, &self.root));
            let desired = selected.and_then(|(_, r)| {
                startup_target(
                    &known.path,
                    known.package.clone(),
                    r.startup,
                    &mut self.detected,
                )
            });
            let target = desired.as_ref().unwrap_or(known);
            let (id, record_revision) =
                selected.map_or(("", revision), |(id, r)| (id.as_str(), r.revision));
            let enabled = desired.is_some()
                && selected.is_some_and(|(_, r)| r.policy.mode != "off")
                && Path::new(&target.path).is_file();
            let cached = self.startup.get(path_key).filter(|a| {
                a.target == *target
                    && a.record == id
                    && a.revision == record_revision
                    && a.enabled == enabled
                    && (a.error.is_none() || a.checked.elapsed() < Duration::from_secs(30))
            });
            let error = if let Some(current) = cached {
                current.error.clone()
            } else {
                if !is_current(&self.manager, &self.stop, records)? {
                    return Ok(());
                }
                let result = (|| -> Result<Option<()>> {
                    let zone = if enabled {
                        let name = selected.unwrap().1.policy.zone.as_str();
                        if let std::collections::btree_map::Entry::Vacant(entry) = zones.entry(name)
                        {
                            let child = native::spawn_owned(
                                &self.root.join("timezone/wayrill-timezone.exe"),
                                &self.manager.owner,
                                &json!(name),
                                "--resolve-zone",
                                None,
                                0,
                            )?;
                            let reply = wait_adapter(
                                child,
                                &self.stop,
                                native::CoreProcess::private_reply,
                            )?;
                            entry.insert(crate::timezone_startup::Resolved::from_reply(&reply)?);
                        }
                        zones.get(name)
                    } else {
                        None
                    };
                    if !is_current(&self.manager, &self.stop, records)? {
                        return Ok(None);
                    }
                    crate::timezone_startup::configure(
                        &self.root,
                        &self.manager.owner,
                        target,
                        zone,
                        selected.map_or("", |(_, r)| r.policy.zone.as_str()),
                        record_revision,
                    )?;
                    Ok(Some(()))
                })();
                if matches!(result, Ok(None)) {
                    return Ok(());
                }
                let error = result.err().map(|e| e.message);
                self.startup.insert(
                    path_key.clone(),
                    StartupApplied {
                        target: target.clone(),
                        record: id.into(),
                        revision: record_revision,
                        enabled,
                        checked: Instant::now(),
                        error: error.clone(),
                    },
                );
                error
            };
            if error.is_none()
                && (!enabled && (desired.is_none() || !Path::new(&target.path).is_file()))
            {
                retired.push(path_key.clone());
            }
            if let Some((id, record)) = selected.filter(|_| desired.is_some() || error.is_some()) {
                // One failed target must remain visible even if another
                // executable in the same package was configured successfully.
                if statuses.get(id).is_none_or(|s| s["phase"] != "error") {
                    statuses.insert(id.clone(), match error {
                            Some(message) => json!({"phase":"error","message":message,"revision":record.revision}),
                            None => json!({"phase":"startup","message": if target.node {
                                "Node.js / Electron: startup timezone prepared. Fully quit and reopen the app after changing this setting, including Off."
                            } else {
                                "Startup timezone prepared. Fully quit and reopen the app after changing this setting, including Off."
                            },"revision":record.revision}),
                        });
                }
            }
        }
        for key in retired {
            targets.remove(&key);
            self.startup.remove(&key);
            // An image no longer using the startup provider may need its
            // already-running process reconciled by the live path.
            self.idle_revision = None;
        }
        Ok(())
    }
    fn processes(
        &mut self,
        records: &Arc<Records>,
        catalog: bool,
        leased: bool,
        statuses: &mut BTreeMap<String, Value>,
    ) -> Result<()> {
        let targets = self.targets.as_mut().unwrap();
        let revision = records.values().map(|r| r.revision).max().unwrap_or(0);
        // Enabled policies always watch for new processes and image versions.
        // Once Off has been reconciled, discovery only serves an open editor.
        let enabled = records.values().any(|r| r.policy.mode != "off");
        if !leased && !enabled && (records.is_empty() || self.idle_revision == Some(revision)) {
            self.worker.take();
            let mut state = self
                .manager
                .state
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            state.processes.clear();
            state.error = None;
            return Ok(());
        }
        if self.worker.is_none() {
            self.worker = Some(crate::capture::Worker::spawn_attribution(
                &self.root.join("attribution"),
            )?);
        }
        let inventory = self.worker.as_mut().unwrap().call(
            "timezone.scan",
            json!({"ownerSid":self.manager.owner,"catalog":catalog}),
        )?;
        let processes = inventory["processes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        {
            let mut state = self
                .manager
                .state
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            state.processes = processes.clone();
            if catalog {
                state.catalog_at = Some(Instant::now());
                state.browsers = inventory["browsers"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                state.packages = inventory["packages"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                state.error = inventory["catalogError"].as_str().map(String::from);
            }
        }
        let mut present = std::collections::BTreeSet::new();
        let images = processes
            .iter()
            .filter_map(|p| p["path"].as_str().map(str::to_lowercase))
            .collect::<std::collections::BTreeSet<_>>();
        for process in processes {
            if self.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let Some(path) = process["path"].as_str() else {
                continue;
            };
            // Never inject into Wayrill's own service, workers or desktop.
            if !external_image(path, &self.root) {
                continue;
            }
            let selected =
                select_process_record(records, &process, self.root.parent().unwrap_or(&self.root));
            let Some((id, record)) = selected else {
                continue;
            };
            let path_key = path.to_lowercase();
            let package = process["package"]
                .as_str()
                .filter(|_| process["packageApplication"] == true)
                .map(String::from);
            if let Some(target) =
                startup_target(path, package.clone(), record.startup, &mut self.detected)
            {
                targets.insert(path_key.clone(), target);
                statuses.entry(id.clone()).or_insert_with(|| json!({"phase":"preparing","message":"Preparing startup timezone. Fully quit and reopen the app when ready.","revision":record.revision}));
                continue;
            }
            if targets.contains_key(&path_key) {
                continue;
            }
            let Some(pid) = process["pid"].as_u64().and_then(|v| u32::try_from(v).ok()) else {
                continue;
            };
            let Some(created) = process["created"].as_u64() else {
                continue;
            };
            let key = (pid, created);
            present.insert(key);
            let previous = self
                .applied
                .get(&key)
                .filter(|a| a.record == *id && a.revision == record.revision);
            let cached = previous.filter(|a| {
                if a.error.is_some() {
                    a.checked.elapsed() < Duration::from_secs(30)
                } else {
                    a.refreshes_left == 0 || a.checked.elapsed() < Duration::from_secs(1)
                }
            });
            let error = if let Some(current) = cached {
                current.error.clone()
            } else {
                if !is_current(&self.manager, &self.stop, records)? {
                    return Ok(());
                }
                // Window creation and Chromium's first platform-zone reply
                // are asynchronous. Idempotent re-application sends a few
                // later notifications, then becomes completely idle. Keep
                // unrelated application edits out of this activation cycle.
                let refreshes_left = previous
                    .filter(|a| a.error.is_none())
                    .map_or(3, |a| a.refreshes_left.saturating_sub(1));
                let zone = if record.policy.mode == "off" {
                    "off"
                } else {
                    &record.policy.zone
                };
                let result = apply_process(
                    &self.root,
                    &self.manager.owner,
                    &process,
                    zone,
                    revision,
                    &self.stop,
                );
                let error = result.err().map(|e| e.message);
                self.applied.insert(
                    key,
                    Applied {
                        record: id.clone(),
                        revision: record.revision,
                        checked: Instant::now(),
                        refreshes_left: if error.is_none() && process["nodeRuntime"] != true {
                            refreshes_left
                        } else {
                            0
                        },
                        error: error.clone(),
                    },
                );
                error
            };
            let status = statuses
                .entry(id.clone())
                .or_insert_with(|| json!({"phase":"applied","revision":record.revision}));
            if let Some(error) = error {
                *status = json!({"phase":"error","message":error,"revision":record.revision});
            }
        }
        self.applied.retain(|key, _| present.contains(key));
        if !enabled
            && self
                .applied
                .values()
                .all(|a| a.error.is_none() && a.refreshes_left == 0)
        {
            self.idle_revision = Some(revision);
        }
        self.detected.retain(|path, _| {
            targets.contains_key(path)
                || images.contains(path)
                || records.values().any(|r| r.path.eq_ignore_ascii_case(path))
        });
        Ok(())
    }
}
fn is_current(manager: &Manager, stop: &AtomicBool, records: &Arc<Records>) -> Result<bool> {
    // Let a native operation already in progress finish. Before the next one,
    // check that the saved intent still matches the pass that planned it.
    Ok(!stop.load(Ordering::Acquire) && Arc::ptr_eq(records, &manager.records()?))
}
pub(super) fn supervise(manager: Manager, root: PathBuf, stop: Arc<AtomicBool>) {
    let mut runtime = Reconciler {
        manager,
        root,
        stop,
        worker: None,
        applied: BTreeMap::new(),
        idle_revision: None,
        startup: BTreeMap::new(),
        targets: None,
        detected: BTreeMap::new(),
    };
    while !runtime.stop.load(Ordering::Acquire) {
        if let Err(error) = runtime.step() {
            runtime.worker.take();
            let mut state = runtime
                .manager
                .state
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if state.error.as_deref() != Some(&error.message) {
                crate::diagnostics::log("timezone", "warning", &error.message);
            }
            state.error = Some(error.message);
            state.catalog_requested = true;
        }
        let state = runtime
            .manager
            .state
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !runtime.stop.load(Ordering::Acquire) {
            drop(
                runtime
                    .manager
                    .state
                    .1
                    .wait_timeout(state, Duration::from_secs(1))
                    .unwrap_or_else(|e| e.into_inner()),
            );
        }
    }
}
fn apply_process(
    root: &Path,
    owner: &str,
    process: &Value,
    zone: &str,
    revision: u64,
    stop: &AtomicBool,
) -> Result<()> {
    let session = process["session"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| ApiError::new("TIMEZONE_APPLICATION", "Invalid application session."))?;
    let input = json!({"target":{"pid":process["pid"],"created":process["created"],"path":process["path"]},"zone":zone,"revision":revision,"session":session});
    let pid = process["pid"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| ApiError::new("TIMEZONE_APPLICATION", "Invalid application process."))?;
    let adapter = crate::timezone_startup::live_adapter(root, pid)?;
    let child = native::spawn_desktop(&adapter, owner, session, &input)?;
    wait_adapter(child, stop, |_| Ok(Some(())))
}
fn wait_adapter<T>(
    child: native::CoreProcess,
    stop: &AtomicBool,
    finish: impl Fn(&native::CoreProcess) -> Result<Option<T>>,
) -> Result<T> {
    let deadline = Instant::now() + Duration::from_secs(35);
    loop {
        if stop.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err(ApiError::new(
                "TIMEZONE_APPLICATION",
                "Native timezone application timed out; it will be retried.",
            ));
        }
        if let Some(code) = child.exit_code()? {
            if code != 0 {
                return Err(ApiError::new(
                    "TIMEZONE_APPLICATION",
                    format!("Application refused timezone override (Windows error {code})."),
                ));
            }
            // A resolver's output readers can finish after process exit.
            if let Some(result) = finish(&child)? {
                return Ok(result);
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
}
