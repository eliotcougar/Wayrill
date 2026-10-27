use super::*;
use crate::native::{spawn_with_token, CoreIdentity};
use std::thread;

pub(super) fn cancelled() -> ApiError {
    ApiError::new(
        "CANCELLED",
        "Subscription work cancelled; committed results were retained.",
    )
}
fn check(stop: &AtomicBool, shutdown: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::Acquire) || shutdown.load(Ordering::Acquire) {
        Err(cancelled())
    } else {
        Ok(())
    }
}
fn helper(input: &Value, stop: &AtomicBool, shutdown: &AtomicBool) -> Result<Value> {
    check(stop, shutdown)?;
    let exe = std::env::current_exe().map_err(|e| ApiError::io("Find subscription worker", e))?;
    let process = spawn_with_token(
        &exe,
        CoreIdentity::LocalService.token()?,
        input,
        "--subscription-worker",
        None,
        0,
    )?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        check(stop, shutdown)?;
        if process.exit_code()?.is_some() {
            if let Some(value) = process.private_reply()? {
                return if value["ok"] == true {
                    Ok(value["result"].clone())
                } else {
                    Err(serde_json::from_value(value["error"].clone())
                        .unwrap_or_else(|_| invalid("Subscription worker failed.")))
                };
            }
        }
        if Instant::now() >= deadline {
            return Err(ApiError::new(
                "SUBSCRIPTION_TIMEOUT",
                "Subscription worker timed out; previous data was preserved.",
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}
fn engine(
    library: &Library,
    operation: &str,
    extra: Value,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<Value> {
    let mut input = json!({"operation":operation,"trusted":true,"stash":library.stash.as_deref().unwrap_or(""),
        "graph":library.draft,"appliedGraph":library.applied.as_ref().map(|a|&a.graph),"publications":library.publications});
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    helper(&input, stop, shutdown)
}
fn accept(
    manager: &Manager,
    mut library: Library,
    value: Value,
    groups: impl IntoIterator<Item = String>,
) -> Result<()> {
    let stash = value["stash"]
        .as_str()
        .ok_or_else(|| invalid("Missing prepared library."))?;
    if stash.len() > 64 * 1024 * 1024 {
        return Err(invalid("The subscription library exceeds 64 MiB."));
    }
    library.catalog = serde_json::from_value(value["catalog"].clone())
        .map_err(|_| invalid("Invalid prepared subscription catalogue."))?;
    if library.catalog.len() > 500
        || library
            .catalog
            .iter()
            .map(|g| g.entries.len())
            .sum::<usize>()
            > 50000
    {
        return Err(invalid("The subscription library exceeds its capacity."));
    }
    library.stash = Some(stash.into());
    library.version = library
        .version
        .checked_add(1)
        .ok_or_else(|| invalid("Subscription version exhausted."))?;
    let approved: BTreeSet<_> = value["runtimeGroups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|id| id.as_str())
        .collect();
    let published: BTreeSet<_> = groups
        .into_iter()
        .filter(|id| approved.contains(id.as_str()))
        .collect();
    for id in &published {
        let snapshot = value["publications"][id.as_str()]
            .as_str()
            .ok_or_else(|| invalid("Missing approved provider publication."))?;
        library.publications.insert(id.clone(), snapshot.into());
    }
    library.pending.extend(published);
    let ids: BTreeSet<_> = library.catalog.iter().map(|g| g.id.clone()).collect();
    library.pending.retain(|id| ids.contains(id));
    library
        .publications
        .retain(|id, _| library.pending.contains(id));
    library.retry_after.retain(|id, _| ids.contains(id));
    manager.commit(library)
}
fn library(manager: &Manager) -> Arc<Library> {
    manager.state.lock().unwrap().library.clone()
}
fn profile(kernel: &Arc<Mutex<Kernel>>) -> Result<RuntimeSource> {
    Ok(kernel
        .lock()
        .map_err(|_| invalid("Routing controller unavailable."))?
        .subscription_profile())
}
fn pending_source(kernel: &Arc<Mutex<Kernel>>, current: &Library) -> Result<Option<Applied>> {
    if current.stash.is_none() {
        return Ok(None);
    }
    let observed = profile(kernel)?;
    if observed.source_hash.is_none() {
        return Ok(None);
    }
    if current
        .applied
        .as_ref()
        .is_some_and(|a| a.matches(&observed))
    {
        return Ok(None);
    }
    let source = kernel
        .lock()
        .map_err(|_| invalid("Routing controller unavailable."))?
        .subscription_source_graph()?;
    Ok(source.map(|(graph, revision, hash, source_hash)| Applied {
        graph,
        revision,
        hash,
        source_hash,
    }))
}
fn synchronize_applied(
    kernel: &Arc<Mutex<Kernel>>,
    manager: &Manager,
    source: Applied,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    let current = library(manager);
    let compiled = helper(
        &json!({"operation":"runtime","stash":current.stash,"appliedGraph":source.graph}),
        stop,
        shutdown,
    )?;
    kernel
        .lock()
        .map_err(|_| invalid("Routing controller unavailable."))?
        .subscription_verify(&compiled, source.revision)?;
    let mut next = (*current).clone();
    if next.draft.is_none() {
        next.draft = Some(source.graph.clone());
    }
    next.applied = Some(source);
    manager.commit(next)?;
    manager.clear_status("runtime");
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    base: String,
    document: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextInput {
    draft: Option<String>,
    test_url: Option<String>,
    test_context: Option<String>,
}

fn upload(
    manager: &Manager,
    kind: &str,
    text: &str,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    let current = library(manager);
    if kind == "save" {
        let input: Save =
            serde_json::from_str(text).map_err(|_| invalid("Invalid subscription save."))?;
        let value = if current.stash.is_none() {
            if !input.base.is_empty() {
                return Err(invalid("The service library has not been initialized."));
            }
            helper(
                &json!({"operation":"validate","stash":input.document}),
                stop,
                shutdown,
            )?
        } else {
            engine(
                &current,
                "merge",
                json!({"base":input.base,"local":input.document}),
                stop,
                shutdown,
            )?
        };
        let groups = value["runtimeGroups"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        accept(manager, (*current).clone(), value, groups)
    } else {
        let input: ContextInput =
            serde_json::from_str(text).map_err(|_| invalid("Invalid subscription context."))?;
        let mut next = (*current).clone();
        if let Some(url) = input.test_url {
            crate::subscription_http::validate_url(&url, true)
                .map_err(|_| invalid("Invalid health test URL."))?;
            if next.test_url != url {
                next.test_url = url;
                next.retry_after.clear();
            }
        }
        if let Some(context) = input.test_context {
            if context.len() > 1024 * 1024 {
                return Err(invalid("Invalid health test context."));
            }
            if next.test_context != context {
                next.test_context = context;
            }
        }
        if let Some(graph) = input.draft {
            if graph.len() > 64 * 1024 * 1024 {
                return Err(invalid("Subscription graph exceeds 64 MiB."));
            }
            // The fixed engine validates graph input before it can protect entries
            // or participate in subsequent tests. No configuration is activated.
            helper(
                &json!({"operation":"validate","stash":"","graph":graph}),
                stop,
                shutdown,
            )?;
            next.draft = Some(graph);
        }
        check(stop, shutdown)?;
        manager.commit(next)
    }
}

// A load is published once its removal scan finishes. Test batches remain durable
// without repeatedly restarting routing or exposing an untested candidate pool.
fn cleanup_pending(group: &Group) -> bool {
    group.maintenance.remove_unreachable
        && (group.test_cycle_at.is_some()
            || group
                .updated_at
                .is_some_and(|loaded| loaded > group.last_test_at.unwrap_or(0))
            || !group.entries.is_empty() && group.last_test_at.is_none())
}
fn publication_ready(library: &Library, group: &str) -> bool {
    library.pending.contains(group)
        && library
            .catalog
            .iter()
            .find(|g| g.id == group)
            .is_some_and(|g| !cleanup_pending(g))
}

fn next_task(library: &Library, time: u64) -> Option<(Group, &'static str)> {
    let index = library
        .catalog
        .iter()
        .position(|g| g.id == library.last_group)
        .map_or(0, |i| i + 1);
    for g in library.catalog[index..]
        .iter()
        .chain(&library.catalog[..index])
    {
        if g.maintenance_paused || library.retry_after.get(&g.id).is_some_and(|t| *t > time) {
            continue;
        }
        let m = &g.maintenance;
        // Finish the current load before downloading the next one. A short
        // refresh interval must not endlessly reset a large subscription scan.
        if cleanup_pending(g) {
            return Some((g.clone(), "test"));
        }
        if m.auto_refresh
            && !g.url.is_empty()
            && time.saturating_sub(g.updated_at.unwrap_or(0)) >= m.refresh_minutes * 60000
        {
            return Some((g.clone(), "refresh"));
        }
    }
    None
}

fn refresh(
    kernel: &Arc<Mutex<Kernel>>,
    manager: &Manager,
    group: &Group,
    scan: bool,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    manager.status(&group.id, "refreshing", "Downloading subscriptionвЂ¦");
    let proxy_port = if group.maintenance.via_proxy {
        Some(
            kernel
                .lock()
                .map_err(|_| invalid("Routing controller unavailable."))?
                .subscription_proxy_port()?,
        )
    } else {
        None
    };
    let download = helper(
        &json!({"operation":"download","url":group.url,"allowHttp":group.allow_http,
        "userAgent":group.user_agent,"headers":group.headers,"proxyPort":proxy_port}),
        stop,
        shutdown,
    )?;
    let current = library(manager);
    let value = engine(
        &current,
        "refresh",
        json!({"groupId":group.id,"text":download}),
        stop,
        shutdown,
    )?;
    check(stop, shutdown)?;
    accept(manager, (*current).clone(), value, [group.id.clone()])?;
    if scan {
        let current = library(manager);
        if let Some(loaded) = current
            .catalog
            .iter()
            .find(|g| g.id == group.id)
            .filter(|g| cleanup_pending(g))
        {
            test(kernel, manager, loaded, None, false, stop, shutdown)?;
        }
    }
    manager.status(&group.id, "idle", "Subscription updated.");
    Ok(())
}

fn probe(
    kernel: &Arc<Mutex<Kernel>>,
    targets: Vec<Value>,
    url: &str,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<Vec<Value>> {
    check(stop, shutdown)?;
    let job = kernel
        .lock()
        .map_err(|_| invalid("Routing controller unavailable."))?
        .subscription_test(
            "outbounds.testStart",
            json!({"testUrl":url,"countryUrl":"","targets":targets}),
        )?;
    let id = job["job"]
        .as_u64()
        .ok_or_else(|| invalid("Health test job unavailable."))?;
    let result = (|| loop {
        check(stop, shutdown)?;
        thread::sleep(Duration::from_millis(250));
        let job = kernel
            .lock()
            .map_err(|_| invalid("Routing controller unavailable."))?
            .subscription_test("outbounds.testGet", json!({"job":id}))?;
        if job["busy"] != true {
            if job["cancelled"] == true {
                return Err(cancelled());
            }
            return job["results"]
                .as_array()
                .cloned()
                .ok_or_else(|| invalid("Invalid health response."));
        }
    })();
    if result.is_err() {
        // Drain this exact job before another actor or foreground test can use
        // the lane. A service shutdown retains the same bounded core deadlines.
        let _ = kernel
            .lock()
            .map_err(|_| invalid("Routing controller unavailable."))?
            .subscription_test("outbounds.testCancel", json!({"job":id}));
        loop {
            let job = kernel
                .lock()
                .map_err(|_| invalid("Routing controller unavailable."))?
                .subscription_test("outbounds.testGet", json!({"job":id}))?;
            if job["busy"] != true {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    result
}

fn health_observations(
    plan: &Value,
    results: &BTreeMap<String, Value>,
    published: &mut BTreeSet<String>,
    last_attempt: bool,
) -> Result<Vec<Value>> {
    let rows = plan["plan"]["rows"]
        .as_array()
        .ok_or_else(|| invalid("Missing subscription test rows."))?;
    Ok(rows.iter().filter_map(|row|{
        let key=row["key"].as_str()?.strip_prefix("stash:")?;
        let link:Value=serde_json::from_str(key).ok()?;let id=link["entryId"].as_str()?;
        if published.contains(id){return None;}
        let targets=row["targets"].as_array()?;
        let unavailable=row["error"].is_string() || targets.is_empty();
        if !unavailable && !targets.iter().all(|id|id.as_str().is_some_and(|id|results.contains_key(id))){return None;}
        let latency=targets.iter().filter_map(|id|results.get(id.as_str()?).and_then(|r|r["latencyMs"].as_u64())).min();
        if !unavailable && latency.is_none() && !last_attempt{return None;}
        published.insert(id.into());
        Some(json!({"entryId":id,"health":{"profileId":plan["identities"][id],"checkedAt":now(),
            "status":if unavailable{"unavailable"}else if latency.is_some(){"alive"}else{"dead"},"latencyMs":latency}}))
    }).collect())
}
fn publish_health(
    manager: &Manager,
    group: &Group,
    observations: Vec<Value>,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    if observations.is_empty() {
        return Ok(());
    }
    let current = library(manager);
    let value = engine(
        &current,
        "health",
        json!({"groupId":group.id,"observations":observations,"removeDead":group.maintenance.remove_unreachable}),
        stop,
        shutdown,
    )?;
    accept(manager, (*current).clone(), value, [group.id.clone()])
}
fn test(
    kernel: &Arc<Mutex<Kernel>>,
    manager: &Manager,
    group: &Group,
    ids: Option<&[String]>,
    automatic: bool,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    let current = library(manager);
    let cycle = if automatic {
        group.test_cycle_at.unwrap_or_else(now)
    } else {
        now()
    };
    let requested = ids.map(|ids| ids.iter().cloned().collect::<BTreeSet<_>>());
    let candidates: Vec<_> = group
        .entries
        .iter()
        .filter(|e| {
            e.kind.is_some()
                && e.kind.as_deref() != Some("block-outbound")
                && requested
                    .as_ref()
                    .map_or(!e.retained, |ids| ids.contains(&e.id))
        })
        .collect();
    let eligible: Vec<_> = candidates
        .iter()
        .filter(|e| !automatic || e.checked_at.is_none_or(|t| t < cycle))
        .map(|e| e.id.clone())
        .collect();
    let entries: Vec<_> = eligible
        .iter()
        .take(if automatic { 128 } else { 50000 })
        .cloned()
        .collect();
    if automatic && group.test_cycle_at.is_none() {
        let stamped = engine(
            &current,
            "cycle",
            json!({"groupId":group.id,"cycleAt":cycle}),
            stop,
            shutdown,
        )?;
        accept(manager, (*current).clone(), stamped, [])?;
    }
    let mut completed = candidates.len() - eligible.len();
    for entries in entries.chunks(128) {
        let current = library(manager);
        let plan = engine(
            &current,
            "plan",
            json!({"groupId":group.id,"entryIds":entries}),
            stop,
            shutdown,
        )?;
        let targets = plan["targets"]
            .as_array()
            .ok_or_else(|| invalid("Invalid subscription test plan."))?;
        let mut results: BTreeMap<String, Value> = BTreeMap::new();
        let mut pending = targets.clone();
        let mut published = BTreeSet::new();
        let mut observations = health_observations(&plan, &results, &mut published, false)?;
        for attempt in 0..=group.maintenance.max_retries {
            for batch in pending.chunks(8) {
                manager.status(
                    &group.id,
                    "testing",
                    format!(
                        "{}/{} checked В· attempt {}",
                        completed + published.len(),
                        candidates.len(),
                        attempt + 1
                    ),
                );
                let batch_results =
                    match probe(kernel, batch.to_vec(), &current.test_url, stop, shutdown) {
                        Ok(results) => results,
                        Err(error) => {
                            // Commit the observations from completed probe batches,
                            // including when a foreground action cancels this scan.
                            publish_health(
                                manager,
                                group,
                                observations,
                                &AtomicBool::new(false),
                                shutdown,
                            )?;
                            return Err(error);
                        }
                    };
                for result in batch_results {
                    if let Some(id) = result["id"].as_str() {
                        results.insert(id.into(), result);
                    }
                }
                observations.extend(health_observations(
                    &plan,
                    &results,
                    &mut published,
                    attempt == group.maintenance.max_retries,
                )?);
            }
            pending = targets
                .iter()
                .filter(|target| {
                    results
                        .get(target["id"].as_str().unwrap_or(""))
                        .is_some_and(|r| r["latencyMs"].is_null())
                })
                .cloned()
                .collect();
            if pending.is_empty() {
                break;
            }
        }
        publish_health(
            manager,
            group,
            observations,
            &AtomicBool::new(false),
            shutdown,
        )?;
        completed += published.len();
    }
    check(stop, shutdown)?;
    if ids.is_none() && entries.len() == eligible.len() {
        let current = library(manager);
        let value = engine(
            &current,
            "cycle",
            json!({"groupId":group.id,"cycleAt":null,"lastTestAt":now()}),
            stop,
            shutdown,
        )?;
        accept(manager, (*current).clone(), value, [])?;
    }
    manager.status(
        &group.id,
        "idle",
        format!(
            "{}/{} checked",
            candidates.len() - eligible.len() + entries.len(),
            candidates.len()
        ),
    );
    Ok(())
}

fn apply_pending(
    kernel: &Arc<Mutex<Kernel>>,
    manager: &Manager,
    group: &str,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    let current = library(manager);
    let observed = profile(kernel)?;
    if !observed.running || !observed.wants_running {
        return Ok(());
    }
    if !publication_ready(&current, group) {
        return Ok(());
    }
    let Some(applied) = &current.applied else {
        return Ok(());
    };
    if !applied.matches(&observed) {
        return Ok(());
    }
    let candidate = engine(
        &current,
        "runtime",
        json!({"groupId":group,"groupSnapshot":current.publications.get(group)}),
        stop,
        shutdown,
    )?;
    commit_runtime(
        kernel,
        manager,
        &current,
        candidate,
        Some(group),
        stop,
        shutdown,
    )
}

fn replace(
    kernel: &Arc<Mutex<Kernel>>,
    manager: &Manager,
    selection: &Replacement,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    let observed = profile(kernel)?;
    if !observed.wants_running {
        return Err(cancelled());
    }
    if !observed.running {
        return Err(ApiError::new(
            "REVISION_CONFLICT",
            "Waiting for routing recovery.",
        ));
    }
    if let Some(source) = pending_source(kernel, &library(manager))? {
        synchronize_applied(kernel, manager, source, stop, shutdown)?;
    }
    let current = library(manager);
    if current.applied.is_none() {
        return Err(invalid(
            "The running configuration has no source graph. Apply the graph first.",
        ));
    }
    let group = current
        .pending
        .contains(&selection.group_id)
        .then_some(selection.group_id.as_str())
        .filter(|group| publication_ready(&current, group));
    let candidate = engine(
        &current,
        "runtime",
        json!({"replacement":selection,"groupId":group,"groupSnapshot":group.and_then(|id| current.publications.get(id))}),
        stop,
        shutdown,
    )?;
    commit_runtime(kernel, manager, &current, candidate, group, stop, shutdown)
}

// Manual assignments and provider publications have one activation boundary.
// Preparation runs outside the kernel; this proof is rechecked under its lock.
fn commit_runtime(
    kernel: &Arc<Mutex<Kernel>>,
    manager: &Manager,
    current: &Library,
    candidate: Value,
    group: Option<&str>,
    stop: &AtomicBool,
    shutdown: &AtomicBool,
) -> Result<()> {
    check(stop, shutdown)?;
    let observed = {
        let mut routing = kernel
            .lock()
            .map_err(|_| invalid("Routing controller unavailable."))?;
        check(stop, shutdown)?;
        let source = routing.subscription_profile();
        if !source.wants_running {
            return Err(cancelled());
        }
        if !source.running || !current.applied.as_ref().is_some_and(|a| a.matches(&source)) {
            return Err(ApiError::new(
                "REVISION_CONFLICT",
                "The applied graph changed during preparation.",
            ));
        }
        routing.handle("config.refreshOutbounds", json!({
            "config":candidate["config"],"capture":candidate["capture"],"displayNames":candidate["displayNames"],
            "sourceGraph":candidate["graph"],"expectedRevision":source.revision}))?;
        routing.subscription_profile()
    };
    let mut next = current.clone();
    if let Some(group) = group {
        next.pending.remove(group);
        next.publications.remove(group);
    }
    next.applied = Some(Applied {
        graph: candidate["graph"]
            .as_str()
            .ok_or_else(|| invalid("Missing refreshed graph."))?
            .into(),
        revision: observed.revision,
        hash: observed
            .hash
            .ok_or_else(|| invalid("Missing committed runtime profile."))?,
        source_hash: observed
            .source_hash
            .ok_or_else(|| invalid("Missing committed source graph."))?,
    });
    let complete = next.pending.is_empty();
    manager.commit(next)?;
    if complete {
        manager.clear_status("runtime");
    }
    Ok(())
}

fn next_pending<'a>(
    library: &'a Library,
    source: &RuntimeSource,
    retry_after: &mut BTreeMap<String, Instant>,
    last_group: &str,
    time: Instant,
) -> Option<&'a str> {
    retry_after.retain(|group, _| library.pending.contains(group));
    if !source.running
        || !source.wants_running
        || library.applied.as_ref().is_none_or(|a| !a.matches(source))
    {
        return None;
    }
    library
        .pending
        .iter()
        .filter(|group| group.as_str() > last_group)
        .chain(
            library
                .pending
                .iter()
                .take_while(|group| group.as_str() <= last_group),
        )
        .find(|group| {
            publication_ready(library, group)
                && retry_after.get(*group).is_none_or(|until| *until <= time)
        })
        .map(String::as_str)
}

pub(super) fn run(kernel: Arc<Mutex<Kernel>>, manager: Manager, shutdown: Arc<AtomicBool>) {
    let mut runtime_retry_after = BTreeMap::new();
    let mut last_runtime_group = String::new();
    let mut next_source = Instant::now();
    while !shutdown.load(Ordering::Acquire) {
        {
            let mut state = manager.state.lock().unwrap();
            if state
                .upload
                .as_ref()
                .is_some_and(|u| u.at.elapsed() >= Duration::from_secs(120))
            {
                state.upload = None;
            }
            if state
                .source
                .as_ref()
                .is_some_and(|(_, _, at)| at.elapsed() >= Duration::from_secs(120))
            {
                state.source = None;
            }
        }
        if let Some(Dispatch {
            work,
            _reservation,
            stop,
        }) = manager.next_work()
        {
            let (id, group) = (work.id(), work.group());
            let retry = matches!(work, Work::Replace { .. }).then(|| work.clone());
            let result = match work {
                Work::Replace { selection, .. } => {
                    replace(&kernel, &manager, &selection, &stop, &shutdown)
                }
                Work::Upload { kind, text, .. } => upload(&manager, &kind, &text, &stop, &shutdown),
                Work::Run {
                    group,
                    operation,
                    entries,
                    ..
                } => {
                    let library = library(&manager);
                    match library.catalog.iter().find(|g| g.id == group) {
                        Some(group) => {
                            if operation == "refresh" {
                                refresh(&kernel, &manager, group, true, &stop, &shutdown)
                            } else {
                                test(
                                    &kernel,
                                    &manager,
                                    group,
                                    entries.as_deref(),
                                    false,
                                    &stop,
                                    &shutdown,
                                )
                            }
                        }
                        None => Err(invalid("This subscription was removed.")),
                    }
                }
            };
            if let Some(work) = retry {
                if result
                    .as_ref()
                    .is_err_and(|e| matches!(e.code.as_str(), "CANCELLED" | "REVISION_CONFLICT"))
                    && !shutdown.load(Ordering::Acquire)
                    && profile(&kernel).is_ok_and(|p| p.wants_running)
                {
                    manager.retry_replacement(work);
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            }
            if let (Some(group), Err(error)) = (group, &result) {
                if manager.user_cancelled() {
                    let mut next = (*library(&manager)).clone();
                    let minutes = next
                        .catalog
                        .iter()
                        .find(|g| g.id == group)
                        .map_or(30, |g| g.maintenance.refresh_minutes.min(30));
                    next.retry_after
                        .insert(group.clone(), now() + minutes * 60000);
                    if let Err(error) = manager.commit(next) {
                        manager.status(&group, "error", error.message);
                    }
                }
                manager.status(
                    &group,
                    if error.code == "CANCELLED" {
                        "idle"
                    } else {
                        "error"
                    },
                    error.message.clone(),
                );
            }
            manager.finish(id, result.err());
            continue;
        }
        if let Some(reservation) = (Instant::now() >= next_source)
            .then(|| manager.gate.background())
            .flatten()
        {
            let stop = reservation.stop.clone();
            // Comparing the committed source is polling, not a subscription job.
            let result = pending_source(&kernel, &library(&manager)).and_then(|source| {
                let Some(source) = source else {
                    return Ok(());
                };
                manager.begin(0, None, true, stop.clone());
                let result = synchronize_applied(&kernel, &manager, source, &stop, &shutdown);
                manager.finish(0, None);
                result
            });
            match result {
                Ok(()) => next_source = Instant::now() + Duration::from_secs(1),
                Err(error) if error.code == "CANCELLED" => {
                    next_source = Instant::now() + Duration::from_secs(1)
                }
                Err(error) => {
                    manager.status("runtime", "error", error.message);
                    next_source = Instant::now() + Duration::from_secs(30);
                }
            }
        }
        let mut ready = {
            let state = manager.state.lock().unwrap();
            state.error.is_none() && state.library.stash.is_some() && state.library.draft.is_some()
        };
        if ready {
            let current = library(&manager);
            match profile(&kernel) {
                Ok(observed) => {
                    if observed.hash.is_some()
                        && current
                            .applied
                            .as_ref()
                            .is_none_or(|a| !a.matches(&observed))
                    {
                        ready = false;
                    }
                }
                Err(_) => ready = false,
            }
        }
        if let Some(reservation) = ready.then(|| manager.gate.background()).flatten() {
            let stop = reservation.stop.clone();
            let current = library(&manager);
            if let Some(group) = profile(&kernel).ok().and_then(|source| {
                next_pending(
                    &current,
                    &source,
                    &mut runtime_retry_after,
                    &last_runtime_group,
                    Instant::now(),
                )
            }) {
                manager.begin(0, None, true, stop.clone());
                last_runtime_group = group.to_owned();
                if let Err(error) = apply_pending(&kernel, &manager, group, &stop, &shutdown) {
                    if error.code != "CANCELLED" {
                        manager.status("runtime", "error", error.message);
                    }
                    runtime_retry_after.insert(
                        group.to_owned(),
                        Instant::now()
                            + Duration::from_secs(if error.code == "CANCELLED" { 1 } else { 30 }),
                    );
                } else {
                    runtime_retry_after.remove(group);
                }
                manager.finish(0, None);
            }
            let current = library(&manager);
            if let Some((group, operation)) =
                next_task(&current, now()).filter(|_| check(&stop, &shutdown).is_ok())
            {
                manager.begin(0, Some(group.id.clone()), true, stop.clone());
                let result = if operation == "refresh" {
                    refresh(&kernel, &manager, &group, false, &stop, &shutdown)
                } else {
                    test(&kernel, &manager, &group, None, true, &stop, &shutdown)
                };
                let mut next = (*library(&manager)).clone();
                next.last_group = group.id.clone();
                match result {
                    Ok(()) => {
                        next.retry_after.remove(&group.id);
                    }
                    Err(error) => {
                        next.retry_after.insert(
                            group.id.clone(),
                            now()
                                + if error.code == "CANCELLED" {
                                    if manager.user_cancelled() {
                                        group.maintenance.refresh_minutes.min(30) * 60000
                                    } else {
                                        15000
                                    }
                                } else {
                                    60000
                                },
                        );
                        manager.status(
                            &group.id,
                            if error.code == "CANCELLED" {
                                "idle"
                            } else {
                                "error"
                            },
                            error.message,
                        );
                    }
                }
                if let Err(error) = manager.commit(next) {
                    manager.status(&group.id, "error", error.message);
                }
                manager.finish(0, None);
            }
        }
        for _ in 0..10 {
            if shutdown.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> RuntimeSource {
        RuntimeSource {
            revision: 7,
            hash: Some("config".into()),
            source_hash: Some("source".into()),
            running: true,
            wants_running: true,
        }
    }
    fn pending_library(ids: &[&str]) -> Library {
        let mut library = Library::empty("test".into());
        library.applied = Some(Applied {
            graph: String::new(),
            revision: 7,
            hash: "config".into(),
            source_hash: "source".into(),
        });
        for id in ids {
            library.pending.insert((*id).into());
            library.catalog.push(serde_json::from_value(json!({
                "id":id,"name":id,"url":"https://example.test/sub","userAgent":"","headers":{},
                "allowHttp":false,"maintenance":{"autoRefresh":true,"refreshMinutes":60},
                "maintenancePaused":false,"updatedAt":1000,"lastTestAt":null,"testCycleAt":null,"entries":[]
            })).unwrap());
        }
        library
    }
    #[test]
    fn a_pending_publication_is_frozen_across_saves_and_service_reopen() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-publication-{}.dpapi",
            crate::tun::random_id().unwrap()
        ));
        let manager = Manager::open("test", path.clone(), Events::new());
        let group = json!({"id":"provider","name":"Provider","url":"","userAgent":"","headers":{},
            "allowHttp":false,"maintenance":{"autoRefresh":false,"refreshMinutes":360,"removeUnreachable":false,"maxRetries":2,"viaProxy":false},
            "maintenancePaused":false,"updatedAt":1,"lastTestAt":null,"testCycleAt":null,"entries":[]});
        let prepared = |port| {
            json!({"stash":json!({"groups":[{"id":"provider","settingsDefaults":{},"entries":[{"port":port}]}]}).to_string(),
            "catalog":[group.clone()],"runtimeGroups":["provider"],"publications":{"provider":json!({"entries":[{"port":port}]}).to_string()}})
        };
        accept(
            &manager,
            (*library(&manager)).clone(),
            prepared(2080),
            ["provider".into()],
        )
        .unwrap();
        accept(&manager, (*library(&manager)).clone(), prepared(3080), []).unwrap();
        let reopened = Manager::open("test", path.clone(), Events::new());
        let current = library(&reopened);
        let snapshot: Value = serde_json::from_str(&current.publications["provider"]).unwrap();
        assert_eq!(snapshot["entries"][0]["port"], 2080);
        assert!(current.stash.as_ref().unwrap().contains("3080"));
        assert!(current.pending.contains("provider"));
        // A newer completed provider load coalesces the old publication.
        accept(
            &reopened,
            (*current).clone(),
            prepared(4080),
            ["provider".into()],
        )
        .unwrap();
        let snapshot: Value =
            serde_json::from_str(&library(&reopened).publications["provider"]).unwrap();
        assert_eq!(snapshot["entries"][0]["port"], 4080);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn a_failed_provider_does_not_starve_other_pending_runtime_updates() {
        let time = Instant::now();
        let mut library = pending_library(&["a-broken", "b-rotated"]);
        let source = source();
        let mut retries = BTreeMap::new();
        assert_eq!(
            next_pending(&library, &source, &mut retries, "", time),
            Some("a-broken")
        );
        retries.insert("a-broken".into(), time + Duration::from_secs(30));
        assert_eq!(
            next_pending(&library, &source, &mut retries, "a-broken", time),
            Some("b-rotated")
        );
        // A long maintenance scan can outlast the failed provider's backoff.
        // Rotation must still give the other provider its turn.
        assert_eq!(
            next_pending(
                &library,
                &source,
                &mut retries,
                "a-broken",
                time + Duration::from_secs(60)
            ),
            Some("b-rotated")
        );
        // A successful update acknowledges only its provider. The failed intent
        // remains durable and becomes eligible after its own bounded backoff.
        library.pending.remove("b-rotated");
        assert!(next_pending(&library, &source, &mut retries, "b-rotated", time).is_none());
        assert_eq!(
            next_pending(
                &library,
                &source,
                &mut retries,
                "b-rotated",
                time + Duration::from_secs(30)
            ),
            Some("a-broken")
        );
        library.pending.clear();
        assert!(next_pending(&library, &source, &mut retries, "a-broken", time).is_none());
        assert!(retries.is_empty());
    }
    #[test]
    fn deferred_publications_are_not_jobs_until_the_runtime_and_scan_are_ready() {
        let time = Instant::now();
        let mut library = pending_library(&["a-scanning", "b-ready"]);
        let mut source = source();
        let mut retries = BTreeMap::new();
        library.catalog[0].maintenance.remove_unreachable = true;
        assert_eq!(
            next_pending(&library, &source, &mut retries, "", time),
            Some("b-ready")
        );
        library.pending.remove("b-ready");
        assert!(next_pending(&library, &source, &mut retries, "", time).is_none());
        library.catalog[0].last_test_at = Some(1000);
        assert_eq!(
            next_pending(&library, &source, &mut retries, "", time),
            Some("a-scanning")
        );
        source.running = false;
        assert!(next_pending(&library, &source, &mut retries, "", time).is_none());
        source.running = true;
        source.wants_running = false;
        assert!(next_pending(&library, &source, &mut retries, "", time).is_none());
        source.wants_running = true;
        source.source_hash = Some("new source".into());
        assert!(next_pending(&library, &source, &mut retries, "", time).is_none());
        source.source_hash = Some("source".into());
        library.applied = None;
        assert!(next_pending(&library, &source, &mut retries, "", time).is_none());
    }
    #[test]
    fn idle_maintenance_waits_for_its_interval_pause_and_retry_deadline() {
        let mut library = pending_library(&["provider"]);
        library.pending.clear();
        assert!(next_task(&library, 1000 + 60 * 60000 - 1).is_none());
        let due = 1000 + 60 * 60000;
        assert_eq!(next_task(&library, due).unwrap().1, "refresh");
        library.catalog[0].maintenance_paused = true;
        assert!(next_task(&library, due).is_none());
        library.catalog[0].maintenance_paused = false;
        library.retry_after.insert("provider".into(), due + 60000);
        assert!(next_task(&library, due).is_none());
        assert_eq!(next_task(&library, due + 60000).unwrap().1, "refresh");
        library.catalog[0].maintenance.auto_refresh = false;
        assert!(next_task(&library, due + 60000).is_none());
    }
    #[test]
    fn schedules_refresh_and_rotates_health_work() {
        let mut library = Library::empty("test".into());
        let group = |id: &str| Group {
            id: id.into(),
            name: id.into(),
            url: "https://example.test/sub".into(),
            user_agent: String::new(),
            headers: BTreeMap::new(),
            allow_http: false,
            maintenance: Settings {
                auto_refresh: true,
                refresh_minutes: 1,
                remove_unreachable: true,
                max_retries: 0,
                via_proxy: false,
            },
            maintenance_paused: false,
            updated_at: None,
            last_test_at: None,
            test_cycle_at: None,
            entries: vec![],
        };
        library.catalog = vec![group("a"), group("b")];
        assert_eq!(next_task(&library, 60000).unwrap().0.id, "a");
        library.last_group = "a".into();
        assert_eq!(next_task(&library, 60000).unwrap().0.id, "b");
        library.retry_after.insert("b".into(), 120000);
        assert_eq!(next_task(&library, 60000).unwrap().0.id, "a");
    }
    #[test]
    fn cleanup_runs_once_per_load_and_holds_publication_until_complete() {
        let mut library = Library::empty("test".into());
        let mut group = Group {
            id: "g".into(),
            name: "Provider".into(),
            url: String::new(),
            user_agent: String::new(),
            headers: BTreeMap::new(),
            allow_http: false,
            maintenance: Settings {
                remove_unreachable: true,
                ..Settings::default()
            },
            maintenance_paused: false,
            updated_at: Some(100),
            last_test_at: None,
            test_cycle_at: None,
            entries: vec![],
        };
        library.pending.insert(group.id.clone());
        library.catalog.push(group.clone());
        assert_eq!(next_task(&library, 100).unwrap().1, "test");
        assert!(!publication_ready(&library, "g"));
        group.last_test_at = Some(200);
        library.catalog[0] = group.clone();
        assert!(next_task(&library, 99_999_999).is_none());
        assert!(publication_ready(&library, "g"));
        group.test_cycle_at = Some(200); // even two loads in the same millisecond
        library.catalog[0] = group;
        assert_eq!(next_task(&library, 200).unwrap().1, "test");
        assert!(!publication_ready(&library, "g"));
    }
    #[test]
    fn health_only_marks_completed_rows_after_the_final_retry() {
        let row = |id: &str, targets: Value| json!({"key":format!("stash:{}",json!({"groupId":"g","entryId":id})),"targets":targets});
        let plan = json!({"plan":{"rows":[row("dead",json!(["a"])),row("alive",json!(["b","c"])),row("incomplete",json!(["d"]))]},
            "identities":{"dead":"id1","alive":"id2","incomplete":"id3"}});
        let results = BTreeMap::from([
            ("a".into(), json!({"latencyMs":null})),
            ("b".into(), json!({"latencyMs":null})),
            ("c".into(), json!({"latencyMs":42})),
        ]);
        let mut published = BTreeSet::new();
        let first = health_observations(&plan, &results, &mut published, false).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["entryId"], "alive");
        assert_eq!(first[0]["health"]["latencyMs"], 42);
        let last = health_observations(&plan, &results, &mut published, true).unwrap();
        assert_eq!(last.len(), 1);
        assert_eq!(last[0]["entryId"], "dead");
        assert_eq!(last[0]["health"]["status"], "dead");
    }
}
