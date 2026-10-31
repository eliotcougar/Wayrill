//! Own the public ICS adapter beyond the coordinator's lifetime. The only IPC is
//! bounded inherited pipes; coordinator EOF suspends sharing before releasing it.
//! No external command, path, driver operation or remote outbound is accepted.
use super::{add_routes, clients, scoped_token, shared_gateway, sharing, wait_started, Adapter};
use crate::events::Events;
use crate::native::{self, CoreProcess, Handle};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{Foundation::*, Security::*, System::Threading::*};

use crate::lifecycle::SharingExit;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Stop {
    sharing: SharingExit,
}

pub(super) struct MutationLock(Handle);
impl Drop for MutationLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}
fn named_lock(name: &str, timeout: u32) -> Result<Option<MutationLock>> {
    let sd = native::SecurityDescriptor::pipe("S-1-5-18")?;
    let attrs = sd.attributes();
    let handle = Handle(unsafe { CreateMutexW(&attrs, 0, native::wide(name).as_ptr()) });
    if handle.0.is_null() {
        return Err(native::os_error("Create sharing transaction lock"));
    }
    match unsafe { WaitForSingleObject(handle.0, timeout) } {
        WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Some(MutationLock(handle))),
        WAIT_TIMEOUT => Ok(None),
        _ => Err(ApiError::new(
            "ICS_BUSY",
            "Sharing recovery is still running. Refresh before retrying.",
        )),
    }
}
pub(super) fn mutation_lock() -> Result<MutationLock> {
    named_lock("Global\\Wayrill.ICS.Transaction", 30000)?.ok_or_else(busy)
}
pub(super) fn keeper_lease() -> Result<Option<MutationLock>> {
    named_lock("Global\\Wayrill.ICS.Keeper", 0)
}
pub(super) fn busy() -> ApiError {
    ApiError::new(
        "ICS_BUSY",
        "The previous sharing keeper is still draining. Wait for recovery before restarting capture.",
    )
}
fn failure(message: impl Into<String>) -> ApiError {
    ApiError::new("ICS_KEEPER", message)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    method: String,
    params: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    options: sharing::Options,
    worker: Value,
    host_index: Option<u32>,
    host_ipv6: bool,
    fake_dns: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rename {
    name: String,
    #[serde(default, rename = "checkOnly")]
    check_only: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplaceWorker {
    options: sharing::Options,
    worker: Value,
    #[serde(rename = "fakeDns")]
    fake_dns: Option<String>,
}

/// Every completion carries an observation, independent of whether the command
/// succeeded. A progress frame can never be confused with an acknowledgement.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    id: u64,
    reply: Reply,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Reply {
    Progress {
        activity: wayrill_protocol::NativeActivity,
    },
    Complete(Box<Completion>),
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    pid: Option<u32>,
    name: Option<String>,
    adapter_id: Option<String>,
    interface_index: Option<u32>,
    sharing: sharing::Status,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    state: State,
    outcome: Result<Value>,
}
type WriteRequest = (Vec<u8>, mpsc::Sender<Result<()>>);

pub(super) struct Client {
    child: Child,
    writes: Option<mpsc::Sender<WriteRequest>>,
    replies: mpsc::Receiver<Result<Response>>,
    next_id: u64,
    in_flight: Option<u64>,
    draining: bool,
    state: Option<State>,
    // A timeout/lost reply is not a new native observation. Keep the last
    // identity but expose the uncertain outcome until a correlated completion.
    uncertain: Option<ApiError>,
    events: Arc<Events>,
    generation: u64,
}
impl Client {
    pub(super) fn spawn(events: Arc<Events>, generation: u64) -> Result<Self> {
        let exe =
            std::env::current_exe().map_err(|e| ApiError::io("Locate recovery component", e))?;
        let mut child = Command::new(&exe)
            .arg("--ics-keeper")
            .current_dir(exe.parent().unwrap())
            .env_clear()
            .env(
                "SystemRoot",
                std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()),
            )
            .env(
                "ProgramData",
                std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()),
            )
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| ApiError::io("Start sharing recovery component", e))?;
        crate::diagnostics::output(child.stderr.take().unwrap(), "sharing").inspect_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
        })?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (writes, incoming) = mpsc::channel::<WriteRequest>();
        std::thread::spawn(move || {
            for (bytes, done) in incoming {
                let result = stdin
                    .write_all(&bytes)
                    .and_then(|_| stdin.flush())
                    .map_err(|e| ApiError::io("Send sharing request", e));
                let failed = result.is_err();
                let _ = done.send(result);
                if failed {
                    break;
                }
            }
        });
        let (outgoing, replies) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let result = (&mut reader)
                    .take((wayrill_protocol::MAX_FRAME + 1) as u64)
                    .read_until(b'\n', &mut bytes);
                let value = match result {
                    Ok(0) => break,
                    Ok(_)
                        if bytes.len() <= wayrill_protocol::MAX_FRAME
                            && bytes.last() == Some(&b'\n') =>
                    {
                        serde_json::from_slice(&bytes)
                            .map_err(|_| failure("Invalid sharing reply."))
                    }
                    _ => Err(failure(
                        "The sharing reply exceeded its limit or lost its channel.",
                    )),
                };
                let failed = value.is_err();
                if outgoing.send(value).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            writes: Some(writes),
            replies,
            next_id: 0,
            in_flight: None,
            draining: false,
            state: None,
            uncertain: None,
            events,
            generation,
        })
    }
    fn exited(&mut self) -> Result<bool> {
        self.child
            .try_wait()
            .map(|code| code.is_some())
            .map_err(|e| ApiError::io("Inspect sharing component", e))
    }
    pub(super) fn draining(&self) -> bool {
        self.draining
    }
    pub(super) fn prepare_stop(&mut self) -> Result<()> {
        if self.draining {
            return if self.exited()? {
                Ok(())
            } else {
                Err(failure(
                    "The sharing owner is draining its native operation; capture remains parked.",
                ))
            };
        }
        let result = self.call_retirement("prepareStop", json!({}));
        if let Err(error) = &result {
            // EOF requests cooperative retirement AFTER any native operation.
            // Do not keep a lost reply channel alive, replay a request or kill
            // a process which may still own Windows mutations. Dropping the
            // old response receiver also bounds queued progress during drain.
            self.draining = true;
            self.writes = None;
            self.replies = mpsc::channel().1;
            self.uncertain = Some(error.clone());
        }
        result
    }
    pub(super) fn stop(&mut self, sharing: SharingExit) -> Result<()> {
        self.call_retirement("stop", json!({"sharing":sharing}))
    }
    fn call_retirement(&mut self, method: &str, params: Value) -> Result<()> {
        if self.exited()? {
            return Ok(());
        }
        match self.call(method, params) {
            Ok(_) => Ok(()),
            // A dead keeper cannot acknowledge Stop. Let the coordinator
            // acquire the recovery locks and reconcile its durable journal.
            // A live uncertain operation must keep its client/adapter lease.
            Err(_) if self.exited()? => Ok(()),
            Err(error) => Err(error),
        }
    }
    pub(super) fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        if self.draining {
            return Err(failure(
                "The sharing owner is draining; no new command was submitted.",
            ));
        }
        // A timeout is not cancellation. Observe the outstanding operation
        // before submitting another request to this native owner.
        self.observe_in_flight()?;
        let completion = match self.exchange(method, params) {
            Ok(completion) => completion,
            Err(error) => {
                self.uncertain = Some(error.clone());
                return Err(error);
            }
        };
        self.state = Some(completion.state);
        self.uncertain = None;
        let mut value = completion.outcome?;
        if let Some(rows) = value.as_object_mut().and_then(|v| v.remove("routing")) {
            let rows = rows
                .as_array()
                .filter(|rows| rows.len() <= 1000)
                .ok_or_else(|| failure("Invalid sharing routing log."))?;
            for row in rows {
                let line = row
                    .as_str()
                    .filter(|s| s.len() <= 8192)
                    .ok_or_else(|| failure("Invalid sharing routing decision."))?;
                let origin = self.core_pid().unwrap_or(self.child.id());
                self.events
                    .routing
                    .ingest_from(self.generation, origin, "ICS TUN", line);
            }
        }
        if matches!(method, "stop" | "keep") {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !self.exited()? {
                if Instant::now() >= deadline {
                    let error = failure("Sharing restored but its keeper has not finished; inspect before restarting.");
                    self.uncertain = Some(error.clone());
                    return Err(error);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        Ok(value)
    }
    fn observe_in_flight(&mut self) -> Result<()> {
        let Some(id) = self.in_flight else {
            return Ok(());
        };
        for _ in 0..128 {
            match self.replies.try_recv() {
                Ok(Ok(Response {
                    id: response_id,
                    reply,
                })) if response_id == id => match reply {
                    Reply::Progress { activity } => crate::activity::report(activity),
                    Reply::Complete(completion) => {
                        self.state = Some(completion.state);
                        self.uncertain = None;
                        self.in_flight = None;
                        return Ok(());
                    }
                },
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        Err(self.uncertain.clone().unwrap_or_else(|| failure("The previous sharing operation has not completed; its native ownership was retained.")))
    }
    fn exchange(&mut self, method: &str, params: Value) -> Result<Completion> {
        if self.exited()? {
            return Err(failure(
                "Sharing recovery component ended. Inspect recovery before restarting.",
            ));
        }
        self.next_id += 1;
        let id = self.next_id;
        let mut bytes = serde_json::to_vec(&Request {
            id,
            method: method.into(),
            params,
        })
        .map_err(|_| failure("Invalid sharing request."))?;
        if bytes.len() >= wayrill_protocol::MAX_FRAME {
            return Err(failure("Sharing request exceeds capacity."));
        }
        bytes.push(b'\n');
        let duration = Duration::from_secs(
            if matches!(method, "start" | "stop" | "keep" | "replaceWorker") {
                90
            } else {
                25
            },
        );
        let mut until = Instant::now() + duration;
        let (done, written) = mpsc::channel();
        self.writes
            .as_ref()
            .ok_or_else(|| failure("Sharing channel closed."))?
            .send((bytes, done))
            .map_err(|_| failure("Sharing channel closed."))?;
        self.in_flight = Some(id);
        written
            .recv_timeout(duration)
            .map_err(|_| failure("Sharing request timed out; inspect before retrying."))??;
        loop {
            let response = self
                .replies
                .recv_timeout(until.saturating_duration_since(Instant::now()))
                .map_err(|_| {
                    failure("Sharing operation timed out; its adapter and journal were retained.")
                })??;
            if response.id != id {
                continue; // A late completion cannot acknowledge a later mutation.
            }
            match response.reply {
                Reply::Progress { activity } => {
                    crate::activity::report(activity);
                    until = Instant::now() + duration;
                }
                Reply::Complete(completion) => {
                    self.in_flight = None;
                    return Ok(*completion);
                }
            }
        }
    }
    pub(super) fn pid(&self) -> u32 {
        self.child.id()
    }
    pub(super) fn replace_worker(
        &mut self,
        worker: Value,
        options: &sharing::Options,
        generation: u64,
        fake_dns: Option<&str>,
    ) -> Result<()> {
        self.call(
            "replaceWorker",
            json!({"worker":worker,"options":options,"fakeDns":fake_dns}),
        )?;
        self.generation = generation;
        Ok(())
    }
    pub(super) fn core_pid(&self) -> Option<u32> {
        self.state.as_ref()?.pid
    }
    pub(super) fn interface_index(&self) -> Option<u32> {
        self.state.as_ref()?.interface_index
    }
    pub(super) fn adapter_name(&self) -> Option<&str> {
        self.state.as_ref()?.name.as_deref()
    }
    pub(super) fn adapter_id(&self) -> Option<&str> {
        self.state.as_ref()?.adapter_id.as_deref()
    }
    pub(super) fn sharing_status(&self) -> Value {
        let mut status = self
            .state
            .as_ref()
            .map(|state| serde_json::to_value(&state.sharing).unwrap())
            .unwrap_or_else(|| json!({"managed":false,"recoveryPending":true}));
        if let Some(error) = &self.uncertain {
            status["recoveryPending"] = json!(true);
            status["lastError"] = json!(error);
        }
        status
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.writes = None;
    } // EOF asks for recovery; never kill the keeper's adapter.
}

fn retain_worker_settings(settings: &mut Value, previous: &Value, name: &str, uplink: &str) {
    settings["name"] = json!(name);
    // Allocation deliberately avoids existing routes. Allocating again would
    // reject our own live gateway and choose a different transit subnet.
    settings["gateway"] = previous["gateway"].clone();
    settings["autoOutboundsInterface"] = json!(uplink);
}

struct Runtime {
    sharing: sharing::Manager,
    adapter: Option<Adapter>,
    core: Option<CoreProcess>,
    host_index: Option<u32>,
    host_luid: Option<windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH>,
    root: PathBuf,
    data: PathBuf,
    advertiser: Option<clients::Advertiser>,
    poll_failure: Option<ApiError>,
    worker: Option<Value>,
    control: Option<crate::live::Control>,
    options: Option<sharing::Options>,
}
impl Runtime {
    fn start(&mut self, start: Start) -> Result<Value> {
        if self.adapter.is_some() {
            return Err(failure("Sharing capture already exists."));
        }
        validate_worker(&start.worker)?;
        validate_fake_dns(start.fake_dns.as_deref())?;
        if !sharing::valid_options(&start.options) {
            return Err(failure("Invalid sharing selection."));
        }
        if (start.host_ipv6 || start.options.ipv6) && start.host_index.is_none() {
            return Err(failure("Host IPv6 forwarding requires an owned host TUN."));
        }
        let host_luid = start
            .host_index
            .map(|index| {
                let mut row = windows_sys::Win32::NetworkManagement::IpHelper::MIB_IF_ROW2 {
                    InterfaceIndex: index,
                    ..Default::default()
                };
                let code = unsafe {
                    windows_sys::Win32::NetworkManagement::IpHelper::GetIfEntry2(&mut row)
                };
                if code != 0 {
                    return Err(ApiError::io(
                        "Identify owned host TUN",
                        std::io::Error::from_raw_os_error(code as i32),
                    ));
                }
                Ok(row.InterfaceLuid)
            })
            .transpose()?;
        let uplink = self.sharing.selection(&start.options)?;
        let exe = self.root.join("xray/xray.exe");
        native::verify_hash(&exe, native::XRAY_SHA)?;
        let worker_exe = super::worker_executable(&self.root)?;
        let name = super::adapter_name(&start.worker["inbounds"][0]["settings"], true)?;
        let mut adapter = super::adapters::Store::new(&self.data).acquire(
            &exe,
            super::adapters::Kind::Ics,
            name,
        )?;
        let mut worker = start.worker;
        worker["inbounds"][0]["settings"]["name"] = json!(adapter.name);
        worker["inbounds"][0]["settings"]["gateway"] = json!([format!("{}/32", shared_gateway()?)]);
        worker["inbounds"][0]["settings"]["autoOutboundsInterface"] = json!(uplink);
        let original_settings = worker["inbounds"][0]["settings"].clone();
        let reused = adapter.prepare_configuration(&original_settings, false)?;
        let control = crate::live::Control::new(&worker)?;
        let core = native::spawn_tun_with_token(
            &worker_exe,
            scoped_token()?,
            &control.config,
            "run -format json -config stdin:",
            None,
            0,
            native::TunOptions {
                metadata: None,
                fakedns: start.fake_dns.as_deref(),
                reuse_settings: reused,
                assets: exe.parent().unwrap(),
            },
        )?;
        wait_started(&core)?;
        adapter.track_routes(vec![super::configuration::CaptureRoute::on_link(
            "0.0.0.0".parse().unwrap(),
            0,
            4096,
        )])?;
        add_routes(
            adapter.index,
            &BTreeSet::from([("0.0.0.0".parse().unwrap(), 0)]),
            4096,
        )?;
        adapter.activate()?;
        let guid = adapter.guid.clone();
        // Publish ownership before the first native mutation. Any error retains live resources until Restore succeeds.
        self.adapter = Some(adapter);
        self.core = Some(core);
        self.host_index = start.host_index;
        self.host_luid = host_luid;
        self.worker = Some(worker);
        self.control = Some(control);
        self.options = Some(start.options.clone());
        self.sharing
            .move_to(&uplink, &guid, start.host_ipv6, start.options.ipv6)?;
        self.adapter
            .as_mut()
            .unwrap()
            .remember_configuration(&original_settings)?;
        Ok(self.status())
    }
    fn can_replace(&mut self) -> Result<Value> {
        self.poll()?;
        let compatible = match (&self.adapter, &self.worker, &self.core) {
            (Some(adapter), Some(worker), Some(_)) => {
                let settings = &worker["inbounds"][0]["settings"];
                adapter.identity_ready()?
                    && super::reusable_settings(settings, settings)
                    && super::configuration::ready(adapter.index, settings)?
            }
            _ => false,
        };
        Ok(json!({"compatible":compatible}))
    }
    fn rename(&mut self, next: Rename) -> Result<Value> {
        self.poll()?;
        let adapter = self
            .adapter
            .as_mut()
            .ok_or_else(|| failure("Owned sharing adapter is missing."))?;
        adapter.check_name(&next.name)?;
        if !next.check_only {
            adapter.rename(&next.name)?;
            if let Some(worker) = &mut self.worker {
                worker["inbounds"][0]["settings"]["name"] = json!(next.name);
            }
            if let Some(control) = &mut self.control {
                Arc::make_mut(&mut control.config)["inbounds"][0]["settings"]["name"] =
                    json!(next.name);
            }
        }
        Ok(self.status())
    }
    fn replace_worker(&mut self, next: ReplaceWorker) -> Result<Value> {
        validate_worker(&next.worker)?;
        validate_fake_dns(next.fake_dns.as_deref())?;
        if !same_sharing(self.options.as_ref(), &next.options) {
            return Err(failure(
                "Worker replacement cannot change Windows sharing topology.",
            ));
        }
        let uplink = self.sharing.selection(&next.options)?;
        let adapter = self
            .adapter
            .as_ref()
            .ok_or_else(|| failure("Owned sharing adapter is missing."))?;
        let old = self
            .worker
            .as_ref()
            .ok_or_else(|| failure("Sharing worker has no configuration checkpoint."))?;
        let mut worker = next.worker;
        if !adapter.identity_ready()?
            || super::adapter_name(&worker["inbounds"][0]["settings"], true)? != adapter.name
        {
            return Err(failure(
                "Sharing adapter identity changed; full reconfiguration is required.",
            ));
        }
        retain_worker_settings(
            &mut worker["inbounds"][0]["settings"],
            &old["inbounds"][0]["settings"],
            &adapter.name,
            &uplink,
        );
        if !super::reusable_settings(
            &old["inbounds"][0]["settings"],
            &worker["inbounds"][0]["settings"],
        ) || !super::configuration::ready(adapter.index, &old["inbounds"][0]["settings"])?
        {
            return Err(failure(
                "Sharing adapter settings changed; full reconfiguration is required.",
            ));
        }
        let worker_exe = super::worker_executable(&self.root)?;
        let token = scoped_token()?;
        let control = crate::live::Control::new(&worker)?;
        // Keep the owned adapter, journal, native roles and advertiser alive.
        // A failed replacement leaves ownership available for coordinator rollback.
        if let Some(core) = self.core.take() {
            core.stop()?;
        }
        let core = native::spawn_tun_with_token(
            &worker_exe,
            token,
            &control.config,
            "run -format json -config stdin:",
            None,
            0,
            native::TunOptions {
                metadata: None,
                fakedns: next.fake_dns.as_deref(),
                reuse_settings: true,
                assets: &self.root.join("xray"),
            },
        )?;
        wait_started(&core)?;
        self.core = Some(core);
        self.worker = Some(worker);
        self.control = Some(control);
        self.options = Some(next.options);
        Ok(self.status())
    }
    fn live_routing(&mut self, next: Option<Value>, apply: bool) -> Result<Value> {
        self.poll()?;
        let control = self
            .control
            .as_ref()
            .ok_or_else(|| failure("Sharing routing control is unavailable."))?;
        let worker = self
            .worker
            .as_ref()
            .ok_or_else(|| failure("Sharing routing checkpoint is unavailable."))?;
        let routing = if let Some(next) = &next {
            let mut candidate = worker.clone();
            candidate["routing"] = next.clone();
            if !crate::live::same_except_rules(worker, &candidate) {
                return Err(failure("Live sharing updates can change rules only."));
            }
            let allowed: BTreeSet<_> = worker["outbounds"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|o| o["tag"].as_str())
                .collect();
            if next["rules"].as_array().is_none_or(|rules| {
                rules.len() > wayrill_protocol::MAX_ROUTING_RULES + 2
                    || rules.iter().any(|r| {
                        r.get("balancerTag").is_some()
                            || r["outboundTag"]
                                .as_str()
                                .is_none_or(|t| !allowed.contains(t))
                    })
            }) {
                return Err(failure(
                    "Live sharing routing can target its existing local relays only.",
                ));
            }
            Some(control.routing(next))
        } else {
            None
        };
        if let Some(routing) = &routing {
            if apply {
                control.call(
                    &self.root.join("xray/xray.exe"),
                    native::CoreIdentity::LocalService,
                    Some(routing),
                )?;
            } else {
                control.prepare(
                    &self.root.join("xray/xray.exe"),
                    native::CoreIdentity::LocalService,
                    routing,
                )?;
            }
        } else {
            control.call(
                &self.root.join("xray/xray.exe"),
                native::CoreIdentity::LocalService,
                None,
            )?;
        }
        if apply {
            if let Some(routing) = routing {
                self.control.as_mut().unwrap().commit(routing);
                self.worker.as_mut().unwrap()["routing"] = next.unwrap();
            }
        }
        Ok(json!({"updated":true}))
    }
    fn enable_ipv6(&mut self, params: &Value) -> Result<Value> {
        if params.as_object().is_none_or(|p| p.len() != 1) || self.advertiser.is_some() {
            return Err(failure("Invalid IPv6 enable request."));
        }
        let mtu = params["mtu"]
            .as_u64()
            .filter(|m| (1280..=65535).contains(m))
            .ok_or_else(|| failure("Invalid IPv6 MTU."))? as u32;
        let index = self
            .host_index
            .ok_or_else(|| failure("Host TUN is required for shared IPv6."))?;
        if !super::routes_ready(
            index,
            &BTreeSet::from([super::prefix("::/1")?, super::prefix("8000::/1")?]),
        )? && !super::routes_ready(index, &BTreeSet::from([super::prefix("::/0")?]))?
        {
            return Err(failure("Host IPv6 capture is not ready."));
        }
        let id = self.sharing.enable_clients()?;
        let mut advertiser = clients::Advertiser::new(&id, mtu)?;
        advertiser.poll()?;
        self.advertiser = Some(advertiser);
        Ok(self.status())
    }
    fn state(&self) -> State {
        State {
            pid: self.core.as_ref().map(|c| c.pid),
            name: self.adapter.as_ref().map(|a| a.name.clone()),
            adapter_id: self.adapter.as_ref().map(|a| a.guid.clone()),
            interface_index: self.adapter.as_ref().map(|a| a.index),
            sharing: self.sharing.observation(),
        }
    }
    fn status(&self) -> Value {
        let mut state = serde_json::to_value(self.state()).unwrap();
        state["routing"] = json!(self
            .core
            .as_ref()
            .map(CoreProcess::take_routing_lines)
            .unwrap_or_default());
        state
    }
    fn acknowledge_disable(&mut self) -> Result<bool> {
        if self
            .adapter
            .as_ref()
            .map(|a| a.administratively_disabled())
            .transpose()?
            .unwrap_or(false)
        {
            self.sharing.disable_native_intent()?;
            self.adapter.as_ref().unwrap().preserve_disabled()?;
            return Ok(true);
        }
        Ok(false)
    }
    fn poll(&mut self) -> Result<()> {
        if let Some(error) = &self.poll_failure {
            return Err(error.clone());
        }
        if self.acknowledge_disable()? {
            return Err(ApiError::new("ICS_DISABLED", "The ICS TUN adapter was disabled in Windows. Enable ICS TUN and Apply to resume sharing."));
        }
        self.sharing.poll()?;
        if let Some(advertiser) = &mut self.advertiser {
            advertiser.poll()?;
        }
        if let Some(core) = &self.core {
            if let Some(code) = core.exit_code()? {
                return Err(failure(format!(
                    "ICS traffic worker exited ({code}); sharing must be suspended for recovery."
                )));
            }
        }
        Ok(())
    }
    fn stop(&mut self, sharing: SharingExit) -> Result<Value> {
        self.sharing.pause(true)?;
        self.acknowledge_disable()?;
        if let Some(advertiser) = self.advertiser.take() {
            if let Err(e) = advertiser.withdraw() {
                crate::diagnostics::error!("Withdraw shared IPv6 advertisement: {}", e.message);
            }
        }
        self.wait_host_release()?;
        self.sharing.retire(sharing)?;
        if let Some(core) = &self.core {
            core.stop()?;
        }
        self.core = None;
        if let Some(adapter) = &mut self.adapter {
            adapter.disable()?;
        }
        self.adapter = None;
        Ok(json!({"restored":true}))
    }
    fn keep(&mut self, params: Value) -> Result<Value> {
        let selection: sharing::Keep = serde_json::from_value(params)
            .map_err(|_| failure("Invalid sharing recovery request."))?;
        if selection.expected_version.len() != 64
            || !selection
                .expected_version
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err(failure("Refresh sharing before keeping Windows changes."));
        }
        // The coordinator already retired host capture. Do not release a
        // shared adapter until Windows no longer assigns either ICS role to it.
        self.wait_host_release()?;
        self.sharing.keep(&selection.expected_version)?;
        if let Some(advertiser) = self.advertiser.take() {
            let _ = advertiser.withdraw();
        }
        if let Some(core) = &self.core {
            core.stop()?;
        }
        self.core = None;
        if let Some(adapter) = &mut self.adapter {
            adapter.disable()?;
        }
        self.adapter = None;
        Ok(json!({"kept":true}))
    }
    fn host_released(&self) -> Result<bool> {
        let Some(luid) = self.host_luid else {
            return Ok(true);
        };
        // Stable LUID, never an interface index that Windows can reuse.
        let mut row = windows_sys::Win32::NetworkManagement::IpHelper::MIB_IF_ROW2 {
            InterfaceLuid: luid,
            ..Default::default()
        };
        let code =
            unsafe { windows_sys::Win32::NetworkManagement::IpHelper::GetIfEntry2(&mut row) };
        if code == 0 && row.AdminStatus == 2 {
            return Ok(true);
        }
        if code != 0 && ![ERROR_FILE_NOT_FOUND, ERROR_NOT_FOUND].contains(&code) {
            return Err(ApiError::io(
                "Verify host TUN administrative state",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        for family in [
            windows_sys::Win32::Networking::WinSock::AF_INET,
            windows_sys::Win32::Networking::WinSock::AF_INET6,
        ] {
            let mut row = windows_sys::Win32::NetworkManagement::IpHelper::MIB_IPINTERFACE_ROW {
                Family: family,
                InterfaceLuid: luid,
                ..Default::default()
            };
            match unsafe {
                windows_sys::Win32::NetworkManagement::IpHelper::GetIpInterfaceEntry(&mut row)
            } {
                0 => return Ok(false),
                ERROR_FILE_NOT_FOUND | ERROR_NOT_FOUND => {}
                code => {
                    return Err(ApiError::io(
                        "Verify host capture release",
                        std::io::Error::from_raw_os_error(code as i32),
                    ))
                }
            }
        }
        Ok(true)
    }
    fn release_host_capture(&self) -> Result<()> {
        if self.host_released()? {
            return Ok(());
        }
        // Parent death releases its lease; an alive parent parks capture but
        // keeps that lease until this native owner has drained. Do not turn a
        // read-only release proof into a circular exclusive-lock dependency.
        super::adapters::Store::new(&self.data)
            .disable(super::adapters::Kind::Host, self.host_luid)?;
        self.wait_host_release()
    }
    fn wait_host_release(&self) -> Result<()> {
        let until = Instant::now() + Duration::from_secs(8);
        loop {
            if self.host_released()? {
                return Ok(());
            }
            if Instant::now() >= until {
                return Err(ApiError::new("ICS_HOST_CAPTURE","The owned host TUN is still present. Uplink forwarding and sharing were not restored while host capture may remain active."));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
fn same_sharing(previous: Option<&sharing::Options>, next: &sharing::Options) -> bool {
    let key = |options: &sharing::Options| {
        let mut value = serde_json::to_value(options).unwrap();
        value.as_object_mut().unwrap().remove("upstreamTags");
        value
    };
    previous.is_some_and(|previous| key(previous) == key(next))
}

fn valid_logging(log: &Value) -> bool {
    if *log == json!({"loglevel":"warning"}) {
        return true;
    }
    // Allow only generated memory-only routing telemetry. No path, access log,
    // arbitrary diagnostic level, or new privileged file operation is accepted.
    let mut expected = json!({"loglevel":"info","access":"none","error":""});
    if let Some(mask) = log.get("maskAddress") {
        if !mask
            .as_str()
            .is_some_and(|m| ["", "quarter", "half", "full"].contains(&m))
        {
            return false;
        }
        expected["maskAddress"] = mask.clone();
    }
    *log == expected
}
fn validate_fake_dns(endpoint: Option<&str>) -> Result<()> {
    if endpoint.is_some_and(|endpoint| !crate::fakedns::valid_endpoint(endpoint)) {
        return Err(failure("Invalid sharing FakeDNS endpoint."));
    }
    Ok(())
}
fn validate_worker(config: &Value) -> Result<()> {
    wayrill_protocol::validate_udp_listener_environment(config)?;
    super::validate(config)?;
    let inbounds = config["inbounds"]
        .as_array()
        .ok_or_else(|| failure("Missing sharing capture."))?;
    if !(1..=2).contains(&inbounds.len())
        || inbounds.iter().skip(1).any(|i| {
            i["protocol"] != "dokodemo-door"
                || i["listen"] != "127.0.0.1"
                || i["port"].as_u64().is_none_or(|p| !(1..=65535).contains(&p))
                || i["settings"] != json!({"address":"1.1.1.1","port":53,"network":"tcp"})
                || i.get("streamSettings").is_some()
        })
        || !valid_logging(&config["log"])
    {
        return Err(failure(
            "Sharing capture accepts only its owned TUN and local resolver, without file logging.",
        ));
    }
    if config["inbounds"][0]["protocol"] != "tun"
        || config["inbounds"][0]["settings"]["autoSystemRoutingTable"]
            .as_array()
            .is_none_or(|a| !a.is_empty())
    {
        return Err(failure(
            "Sharing capture cannot change this PC's capture routes.",
        ));
    }
    let outbounds = config["outbounds"]
        .as_array()
        .ok_or_else(|| failure("Sharing relays are missing."))?;
    if outbounds.is_empty()
        || outbounds.iter().any(|o| {
            if o["protocol"] == "dns" {
                o["settings"] != json!({})
            } else {
                o["protocol"] != "socks"
                    || o["settings"]["address"] != "127.0.0.1"
                    || o["settings"]["port"]
                        .as_u64()
                        .is_none_or(|p| !(1..=65535).contains(&p))
                    || o["settings"]["pass"].as_str().is_none_or(|p| p.len() != 64)
            }
        })
    {
        return Err(failure(
            "The elevated sharing worker accepts only generated loopback relays and its native DNS dispatcher.",
        ));
    }
    if config.as_object().is_none_or(|o| {
        o.keys().any(|k| {
            ![
                "log",
                "inbounds",
                "outbounds",
                "routing",
                "dns",
                "fakedns",
                "policy",
                "env",
            ]
            .contains(&k.as_str())
        })
    }) {
        return Err(failure("Unexpected sharing worker settings."));
    }
    Ok(())
}

pub(crate) fn run() -> Result<()> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(native::os_error("Identify recovery component"));
    }
    let token = Handle(token);
    if native::token_sid(token.0)? != "S-1-5-18" {
        return Err(ApiError::new(
            "UNAUTHORIZED",
            "The ICS recovery component runs only as LocalSystem.",
        ));
    }
    let root = std::env::current_exe()
        .map_err(|e| ApiError::io("Locate sharing assets", e))?
        .parent()
        .unwrap()
        .to_path_buf();
    let data =
        PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()))
            .join("Wayrill");
    // Held on this thread while capture or recovery can mutate the journal.
    // A replacement service stays available but cannot race this keeper.
    let lease = keeper_lease()?.ok_or_else(busy)?;
    let mut runtime = Runtime {
        sharing: sharing::Manager::for_keeper(&data, root.join("attribution"))?,
        adapter: None,
        core: None,
        host_index: None,
        host_luid: None,
        root,
        data: data.clone(),
        advertiser: None,
        poll_failure: None,
        worker: None,
        control: None,
        options: None,
    };
    let (send, incoming) = mpsc::channel();
    std::thread::spawn(move || {
        let mut input = BufReader::new(std::io::stdin());
        loop {
            let mut bytes = Vec::new();
            if (&mut input)
                .take((wayrill_protocol::MAX_FRAME + 1) as u64)
                .read_until(b'\n', &mut bytes)
                .ok()
                .is_none_or(|n| n == 0)
            {
                break;
            }
            if bytes.len() > wayrill_protocol::MAX_FRAME || bytes.last() != Some(&b'\n') {
                break;
            }
            let request = serde_json::from_slice::<Request>(&bytes)
                .map_err(|_| failure("Invalid recovery request."));
            if send.send(request).is_err() {
                break;
            }
        }
    });
    loop {
        match incoming.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(request)) => {
                let progress_id = request.id;
                let result = crate::activity::observe(
                    move |progress| {
                        let frame = serde_json::to_string(&Response {
                            id: progress_id,
                            reply: Reply::Progress { activity: progress },
                        })
                        .unwrap();
                        // A missing parent cannot interrupt an in-flight Windows
                        // mutation. EOF recovery runs after this owned operation.
                        let _ = writeln!(std::io::stdout(), "{frame}")
                            .and_then(|_| std::io::stdout().flush());
                    },
                    || match request.method.as_str() {
                        "start" => serde_json::from_value(request.params)
                            .map_err(|_| failure("Invalid sharing plan."))
                            .and_then(|p| runtime.start(p)),
                        "replaceWorker" => serde_json::from_value(request.params)
                            .map_err(|_| failure("Invalid worker replacement."))
                            .and_then(|next| runtime.replace_worker(next)),
                        "routing.probe" if request.params == json!({}) => {
                            runtime.live_routing(None, false)
                        }
                        "routing.prepare" => runtime.live_routing(Some(request.params), false),
                        "routing.replace" => runtime.live_routing(Some(request.params), true),
                        "rename" => serde_json::from_value(request.params)
                            .map_err(|_| failure("Invalid owned adapter rename."))
                            .and_then(|next| runtime.rename(next)),
                        "prepareStop" if request.params == json!({}) => {
                            runtime.acknowledge_disable().map(|_| runtime.status())
                        }
                        "canReplace" if request.params == json!({}) => runtime.can_replace(),
                        "inspect" if request.params == json!({}) => runtime.sharing.inspect(),
                        "preflight" => serde_json::from_value::<sharing::Options>(request.params)
                            .map_err(|_| failure("Invalid sharing selection."))
                            .and_then(|options| runtime.sharing.selection(&options))
                            .map(|name| json!({"uplink":name})),
                        "ipv6.enable" => runtime.enable_ipv6(&request.params),
                        "status" if request.params == json!({}) => {
                            runtime.poll().map(|_| runtime.status())
                        }
                        "stop" => serde_json::from_value::<Stop>(request.params)
                            .map_err(|_| failure("Invalid sharing retirement."))
                            .and_then(|p| runtime.stop(p.sharing)),
                        "keep" => runtime.keep(request.params),
                        _ => Err(failure("Unsupported recovery request.")),
                    },
                );
                let finished = matches!(request.method.as_str(), "stop" | "keep") && result.is_ok();
                let reply = serde_json::to_string(&Response {
                    id: request.id,
                    reply: Reply::Complete(Box::new(Completion {
                        state: runtime.state(),
                        outcome: result,
                    })),
                })
                .unwrap();
                let written =
                    writeln!(std::io::stdout(), "{reply}").and_then(|_| std::io::stdout().flush());
                if finished {
                    // Retirement is complete, even if its acknowledgement was
                    // lost. EOF recovery must not retire again after success.
                    return Ok(());
                }
                if written.is_err() {
                    break;
                }
            }
            Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Err(error) = runtime.poll() {
                    runtime.poll_failure = Some(error);
                    if let Some(advertiser) = runtime.advertiser.take() {
                        if let Err(error) = advertiser.withdraw() {
                            crate::diagnostics::error!(
                                "Withdraw failed sharing IPv6 advertisement: {}",
                                error.message
                            );
                        }
                    }
                    // Do not restore uplink forwarding while the host TUN is
                    // still capturing. The next status fails; the coordinator
                    // releases its routes, or EOF triggers guarded recovery.
                }
            }
        }
    }
    if let Some(advertiser) = runtime.advertiser.take() {
        let _ = advertiser.withdraw();
    }
    // EOF is not permission to restore forwarding after a fixed timeout. Keep
    // ownership until the host adapter is actually absent, including read errors.
    // A persistent device survives coordinator death. Disable only the recorded
    // owned host, matching the LUID captured at Start, before retiring sharing.
    while runtime
        .sharing
        .pause(true)
        .and_then(|()| runtime.release_host_capture())
        .is_err()
    {
        std::thread::sleep(Duration::from_secs(2));
    }
    let stopped = runtime.stop(SharingExit::Suspend);
    drop(lease); // Native mutation ended; an authorized new service may retry.
    if stopped.is_err() {
        // Preserve the still-shared adapter on recovery failure. A new service can
        // retry the guarded journal; this process performs no concurrent mutation.
        while let Some(adapter) = &runtime.adapter {
            if runtime.sharing.released(&adapter.guid).unwrap_or(false) {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exited_keeper_does_not_require_an_impossible_stop_reply() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(child.wait().unwrap().success());
        let (_sender, replies) = mpsc::channel();
        let mut client = Client {
            child,
            writes: None,
            replies,
            next_id: 0,
            in_flight: None,
            draining: false,
            state: None,
            uncertain: None,
            events: Events::new(),
            generation: 0,
        };
        client.prepare_stop().unwrap();
        client.prepare_stop().unwrap();
        client.stop(SharingExit::Native).unwrap();
        client.stop(SharingExit::Native).unwrap();
        assert_eq!(client.next_id, 0);
        // Death still fails active health checks; shutdown success here is
        // permission for guarded journal recovery, not a claim of live capture.
        assert!(client.call("status", json!({})).is_err());
    }
    #[test]
    fn live_keeper_transport_failure_is_not_retirement_permission() {
        const CHILD: &str = "WAYRILL_KEEPER_TRANSPORT_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            // The parent owns stdin. Closing it ends this harmless fixture.
            std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
            return;
        }
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tun::keeper::tests::live_keeper_transport_failure_is_not_retirement_permission",
            ])
            .env(CHILD, "1")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (_sender, replies) = mpsc::channel();
        let mut client = Client {
            child,
            writes: None,
            replies,
            next_id: 0,
            in_flight: None,
            draining: false,
            state: None,
            uncertain: None,
            events: Events::new(),
            generation: 0,
        };
        assert_eq!(client.prepare_stop().unwrap_err().code, "ICS_KEEPER");
        assert_eq!(
            client.stop(SharingExit::Native).unwrap_err().code,
            "ICS_KEEPER"
        );
        assert!(!client.exited().unwrap());
        drop(client.child.stdin.take());
        assert!(client.child.wait().unwrap().success());
        client.prepare_stop().unwrap();
        client.stop(SharingExit::Native).unwrap();
    }
    fn test_state(pending: bool) -> State {
        serde_json::from_value(
            json!({"pid":123,"name":"owned","adapterId":"owned","interfaceIndex":7,
            "sharing":{"managed":true,"recoveryPending":pending,"lastError":null,
                "monitorError":null,"restoreNativeOnBoot":true,"upstream":null,"private":null,
                "ipv6Forwarding":null,"ipv6Clients":null}}),
        )
        .unwrap()
    }
    #[test]
    fn malformed_progress_and_completions_never_establish_observed_state() {
        for outcome in [
            Ok(json!({"uplink":"Ethernet"})),
            Err(failure("native failure")),
        ] {
            let encoded = serde_json::to_vec(&Response {
                id: 9,
                reply: Reply::Complete(Box::new(Completion {
                    state: test_state(true),
                    outcome,
                })),
            })
            .unwrap();
            let decoded: Response = serde_json::from_slice(&encoded).unwrap();
            assert_eq!(decoded.id, 9);
            assert!(matches!(decoded.reply, Reply::Complete(_)));
        }
        for frame in [
            json!({"id":1,"reply":{"kind":"progress","activity":{},"state":test_state(false)}}),
            json!({"id":1,"reply":{"kind":"complete","state":{},"outcome":{"Ok":{}}}}),
            json!({"id":1,"reply":{"kind":"complete","state":test_state(false),"outcome":{"Err":{}}}}),
            json!({"id":1,"reply":{"kind":"complete","state":test_state(false),"outcome":{"Ok":{}},"activity":{}}}),
        ] {
            assert!(serde_json::from_value::<Response>(frame).is_err());
        }
    }
    #[test]
    fn every_completion_refreshes_state_and_only_transport_loss_is_uncertain() {
        const CHILD: &str = "WAYRILL_KEEPER_REPLY_STATE_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
            return;
        }
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tun::keeper::tests::every_completion_refreshes_state_and_only_transport_loss_is_uncertain"])
            .env(CHILD, "1").creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let (replies, received) = mpsc::channel();
        let (writes, requests) = mpsc::channel::<WriteRequest>();
        let writer = std::thread::spawn(move || {
            for _ in 0..3 {
                let (_, completed) = requests.recv().unwrap();
                completed.send(Ok(())).unwrap();
            }
        });
        let mut client = Client {
            child,
            writes: Some(writes),
            replies: received,
            next_id: 0,
            in_flight: None,
            draining: false,
            state: Some(test_state(false)),
            uncertain: None,
            events: Events::new(),
            generation: 0,
        };
        replies.send(Err(failure("Malformed reply"))).unwrap();
        let invalid = client.stop(SharingExit::Native).unwrap_err();
        let uncertain = client.sharing_status();
        let still_pending = client.stop(SharingExit::Native).unwrap_err();
        let requests_before_completion = client.next_id;
        replies
            .send(Ok(Response {
                id: 1,
                reply: Reply::Complete(Box::new(Completion {
                    state: test_state(true),
                    outcome: Err(failure("old native operation completed")),
                })),
            }))
            .unwrap();
        let error = ApiError::new("ICS_CONFLICT", "private settings changed");
        let mut actual = test_state(true);
        actual.sharing.last_error = Some(error.clone());
        replies
            .send(Ok(Response {
                id: 2,
                reply: Reply::Complete(Box::new(Completion {
                    state: actual,
                    outcome: Err(error),
                })),
            }))
            .unwrap();
        let failed = client.stop(SharingExit::Native).unwrap_err();
        let observed = client.sharing_status();
        let certain_failure = client.uncertain.is_none();
        // Commands returning something other than status still carry the same
        // observation. A late completion must not clear an uncertain command.
        replies
            .send(Ok(Response {
                id: 2,
                reply: Reply::Complete(Box::new(Completion {
                    state: test_state(true),
                    outcome: Ok(json!({})),
                })),
            }))
            .unwrap();
        replies
            .send(Ok(Response {
                id: 3,
                reply: Reply::Complete(Box::new(Completion {
                    state: test_state(false),
                    outcome: Ok(json!({"uplink":"Ethernet"})),
                })),
            }))
            .unwrap();
        let preflight = client.call("preflight", json!({}));
        let recovered = client.sharing_status();
        let alive = !client.exited().unwrap();
        drop(client.child.stdin.take());
        assert!(client.child.wait().unwrap().success());
        writer.join().unwrap();
        assert_eq!(invalid.code, "ICS_KEEPER");
        assert_eq!(still_pending.code, "ICS_KEEPER");
        assert_eq!(
            requests_before_completion, 1,
            "An uncertain operation must not queue another mutation"
        );
        assert_eq!(uncertain["recoveryPending"], true);
        assert_eq!(uncertain["lastError"]["code"], "ICS_KEEPER");
        assert_eq!(failed.code, "ICS_CONFLICT");
        assert!(certain_failure && alive);
        assert_eq!(observed["recoveryPending"], true);
        assert_eq!(observed["lastError"]["code"], "ICS_CONFLICT");
        assert_eq!(preflight.unwrap()["uplink"], "Ethernet");
        assert_eq!(recovered["recoveryPending"], false);
        assert_eq!(client.adapter_id(), Some("owned"));
    }
    #[test]
    fn replacement_keeps_allocated_transit_gateway_instead_of_the_authored_template() {
        let old = json!({"name":"Owned ICS", "gateway":["198.18.229.2/32"],"mtu":1500,"autoSystemRoutingTable":[],"autoOutboundsInterface":"Ethernet"});
        let mut next = old.clone();
        next["gateway"] = json!(["198.18.0.1/32"]);
        next["name"] = json!("Template");
        next["autoOutboundsInterface"] = json!("auto");
        retain_worker_settings(&mut next, &old, "Owned ICS", "Ethernet");
        assert!(super::super::reusable_settings(&old, &next));
        next["mtu"] = json!(1420);
        assert!(!super::super::reusable_settings(&old, &next));
    }
    fn options() -> sharing::Options {
        serde_json::from_value(json!({"tag":"shared","expectedVersion":"a".repeat(64),"publicId":"22944640-3598-4b5d-aa13-06ea38f26fb0","privateId":"830b3b6e-fa82-4103-8ff5-66f93d1dafa4","upstreamTags":["direct"],"ipv6":true})).unwrap()
    }
    #[test]
    fn replacement_cannot_change_native_sharing_but_can_change_direct_targets() {
        let original = options();
        let mut next = original.clone();
        next.upstream_tags = vec!["new-direct".into()];
        assert!(same_sharing(Some(&original), &next));
        assert!(!same_sharing(None, &next));
        for property in ["tag", "publicId", "privateId", "expectedVersion", "ipv6"] {
            let mut value = serde_json::to_value(&original).unwrap();
            value[property] = if property == "ipv6" {
                json!(false)
            } else {
                json!("different")
            };
            let next = serde_json::from_value(value).unwrap();
            assert!(!same_sharing(Some(&original), &next), "{property}");
        }
    }
    #[test]
    fn worker_replacement_is_a_bounded_operation_with_no_new_privileged_fields() {
        let base = json!({"options":options(),"worker":{}});
        assert!(serde_json::from_value::<ReplaceWorker>(base.clone()).is_ok());
        for field in ["hostIndex", "hostIpv6", "command", "path", "adapterId"] {
            let mut value = base.clone();
            value[field] = json!("arbitrary");
            assert!(
                serde_json::from_value::<ReplaceWorker>(value).is_err(),
                "{field}"
            );
        }
        for method in [
            json!([]),
            json!({"options":null,"worker":{}}),
            json!({"options":options()}),
        ] {
            assert!(serde_json::from_value::<ReplaceWorker>(method).is_err());
        }
    }
    #[test]
    fn generated_routing_logging_preserves_privileged_file_boundaries() {
        let mut config = json!({"log":{"loglevel":"warning"},"inbounds":[{"protocol":"tun","tag":"shared","settings":{"autoSystemRoutingTable":[]}}],"outbounds":[{"protocol":"socks","settings":{"address":"127.0.0.1","port":2345,"pass":"0".repeat(64)}}]});
        crate::routing_log::enable(&mut config);
        let generated = config["log"].clone();
        assert!(validate_worker(&config).is_ok());
        for mask in ["", "quarter", "half", "full"] {
            config["log"]["maskAddress"] = json!(mask);
            assert!(validate_worker(&config).is_ok(), "{mask}");
        }
        for (key, value) in [
            ("access", json!("C:\\access.log")),
            ("error", json!("C:\\error.log")),
            ("loglevel", json!("debug")),
            ("dnsLog", json!(true)),
            ("maskAddress", json!("unknown")),
            ("maskAddress", json!({"path":"C:\\file"})),
        ] {
            config["log"] = generated.clone();
            config["log"][key] = value;
            assert!(validate_worker(&config).is_err(), "{key}");
        }
    }
    #[test]
    fn privileged_worker_cannot_receive_remote_profiles_or_host_capture_routes() {
        let mut config = json!({"log":{"loglevel":"warning"},"inbounds":[{"protocol":"tun","tag":"shared","settings":{"autoSystemRoutingTable":[]}}],"outbounds":[{"protocol":"socks","settings":{"address":"127.0.0.1","port":2345,"pass":"0".repeat(64)}}]});
        assert!(validate_worker(&config).is_ok());
        config["env"] = json!({"WAYRILL_UDP_LISTENER_RECEIVE_BYTES":"524288"});
        assert!(validate_worker(&config).is_ok());
        config["env"]["WAYRILL_FAKEDNS"] = json!("not-allowed");
        assert!(validate_worker(&config).is_err());
        config["env"]
            .as_object_mut()
            .unwrap()
            .remove("WAYRILL_FAKEDNS");
        config["outbounds"][0]["protocol"] = json!("vless");
        assert!(validate_worker(&config).is_err());
        config["outbounds"][0]["protocol"] = json!("socks");
        assert!(validate_worker(&config).is_ok());
        config["log"]["access"] = json!("C:\\unsafe.log");
        assert!(validate_worker(&config).is_err());
        config["log"].as_object_mut().unwrap().remove("access");
        config["inbounds"]
            .as_array_mut()
            .unwrap()
            .push(json!({"protocol":"socks","listen":"0.0.0.0","port":1080,"settings":{}}));
        assert!(validate_worker(&config).is_err());
        config["inbounds"].as_array_mut().unwrap().pop();
        assert!(validate_worker(&config).is_ok());
        config["inbounds"][0]["settings"]["autoSystemRoutingTable"] = json!(["0.0.0.0/0"]);
        assert!(validate_worker(&config).is_err());
    }
    #[test]
    fn lost_reply_drains_over_eof_without_replay_or_premature_retirement() {
        const CHILD: &str = "WAYRILL_KEEPER_EOF_TEST_GATE";
        if let Some(gate) = std::env::var_os(CHILD) {
            std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
            let until = Instant::now() + Duration::from_secs(5);
            while !std::path::Path::new(&gate).exists() {
                assert!(
                    Instant::now() < until,
                    "parent did not release the harmless fixture"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            return;
        }
        let gate = std::env::temp_dir().join(format!(
            "wayrill-eof-drain-{}",
            super::super::random_id().unwrap()
        ));
        let mut child=Command::new(std::env::current_exe().unwrap())
            .args(["--exact","tun::keeper::tests::lost_reply_drains_over_eof_without_replay_or_premature_retirement"])
            .env(CHILD,&gate).creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        let (writes, requests) = mpsc::channel::<WriteRequest>();
        let writer = std::thread::spawn(move || {
            let mut count = 0;
            for (bytes, completed) in requests {
                input.write_all(&bytes).unwrap();
                completed.send(Ok(())).unwrap();
                count += 1;
            }
            count
        });
        let (send, replies) = mpsc::channel();
        send.send(Err(failure("lost response"))).unwrap();
        drop(send);
        let mut client = Client {
            child,
            writes: Some(writes),
            replies,
            next_id: 1,
            in_flight: Some(1),
            draining: false,
            state: None,
            uncertain: None,
            events: Events::new(),
            generation: 0,
        };
        assert!(client.prepare_stop().is_err());
        assert!(client.draining() && !client.exited().unwrap());
        assert!(
            client.prepare_stop().is_err(),
            "EOF is not proof that the owner drained"
        );
        assert!(client.call("start", json!({})).is_err());
        assert_eq!(
            client.next_id, 1,
            "no new native request while a reply is uncertain"
        );
        assert_eq!(
            writer.join().unwrap(),
            0,
            "the pending command must not be replayed"
        );
        std::fs::write(&gate, b"release").unwrap();
        assert!(client.child.wait().unwrap().success());
        client.prepare_stop().unwrap();
        std::fs::remove_file(gate).unwrap();
    }
}
