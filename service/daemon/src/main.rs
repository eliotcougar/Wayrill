mod activation;
mod activity;
mod app_protection;
mod capture;
mod diagnostics;
mod display_names;
mod divert;
mod driver;
mod events;
mod fakedns;
mod geodata;
mod kernel;
mod lifecycle;
mod live;
mod loopback;
mod native;
mod observation;
mod operation_gate;
mod outbound_tests;
mod proxy;
mod recovery;
mod resource_download;
mod resource_rules;
mod resources;
mod routing_diagnostics;
mod routing_log;
mod sockets;
mod startup;
mod storage;
mod subscription_engine;
#[path = "../../subscription_http.rs"]
mod subscription_http;
mod subscriptions;
mod system_native;
mod system_settings;
mod tags;
mod traffic;
mod tun;
mod upgrade;
use serde::Deserialize;
use serde_json::json;
use std::{
    ffi::OsString,
    os::windows::io::AsRawHandle,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::{
    io::BufReader,
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::{watch, Semaphore},
};
use wayrill_protocol::{ApiError, Message, Request, Result, PIPE_NAME, SERVICE_NAME};
use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};
static OWNER: OnceLock<String> = OnceLock::new();
static STOPPING: AtomicBool = AtomicBool::new(false);
static WINDOWS_SHUTDOWN: AtomicBool = AtomicBool::new(false);
const MAX_PIPE_CLIENTS: usize = 16;
const MAX_KERNEL_REQUESTS: usize = MAX_PIPE_CLIENTS / 2;
define_windows_service!(ffi_service_main, service_main);
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--subscription-worker" {
        use std::io::Read;
        let mut bytes = Vec::new();
        let result = std::io::stdin()
            .take(256 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| ApiError::io("Read subscription task", e))
            .and_then(|_| {
                if bytes.len() > 256 * 1024 * 1024 {
                    return Err(ApiError::new("LIMIT", "Subscription task is too large."));
                }
                let input: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|e| ApiError::io("Decode subscription task", e))?;
                if input["operation"] == "download" {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Download {
                        operation: String,
                        url: String,
                        allow_http: bool,
                        user_agent: String,
                        headers: std::collections::BTreeMap<String, String>,
                        proxy_port: Option<u16>,
                    }
                    let request: Download = wayrill_protocol::params(input)?;
                    if request.operation != "download" {
                        return Err(ApiError::new(
                            "INVALID_PARAMS",
                            "Invalid download operation.",
                        ));
                    }
                    subscription_http::fetch(
                        &request.url,
                        request.allow_http,
                        &request.user_agent,
                        &request.headers,
                        request.proxy_port,
                    )
                    .map(serde_json::Value::String)
                    .map_err(|message| ApiError::new("SUBSCRIPTION_DOWNLOAD", message))
                } else {
                    subscription_engine::execute(&input)
                }
            });
        println!(
            "{}",
            match result {
                Ok(value) => serde_json::json!({"ok":true,"result":value}),
                Err(error) => serde_json::json!({"ok":false,"error":error}),
            }
        );
        return;
    }
    if args.len() == 2 && args[1] == "--configure-service" {
        // Configure only our installed service. sc.exe has no preshutdown
        // command on supported Windows 10 builds; use SCM's native API.
        use windows_service::{service::ServiceAccess, service_manager::*};
        let configured =
            ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
                .and_then(|manager| {
                    manager.open_service(SERVICE_NAME, ServiceAccess::CHANGE_CONFIG)
                })
                .and_then(|service| service.set_preshutdown_timeout(Duration::from_secs(120)));
        if let Err(error) = configured {
            crate::diagnostics::error!("Configure Wayrill shutdown allowance: {error}");
            std::process::exit(1);
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("--version") {
        println!("Wayrill Service {} (API 1)", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.get(1).map(String::as_str) == Some("--proxy-helper") {
        match proxy::helper() {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", serde_json::to_string(&error).unwrap());
                std::process::exit(1);
            }
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("--system-settings-helper") {
        match system_native::user_helper() {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", serde_json::to_string(&error).unwrap());
                std::process::exit(1);
            }
        }
        return;
    }
    if args.len() == 2 && args[1] == "--clear-app-protection" {
        if let Err(error) = app_protection::clear_installed() {
            crate::diagnostics::error!("Release app protection: {}", error.message);
            std::process::exit(1);
        }
        return;
    }
    if args.len() == 2 && args[1] == "--prepare-upgrade-protection" {
        if let Err(error) = app_protection::prepare_installed_upgrade() {
            crate::diagnostics::error!("Prepare app protection: {}", error.message);
            std::process::exit(1);
        }
        return;
    }
    if args.len() == 2
        && matches!(
            args[1].as_str(),
            "--prepare-sharing-upgrade" | "--stop-sharing"
        )
    {
        let result = if args[1] == "--prepare-sharing-upgrade" {
            tun::sharing::prepare_installed_upgrade()
        } else {
            tun::sharing::stop_installed()
        };
        if let Err(error) = result {
            crate::diagnostics::error!("Sharing protection: {}", error.message);
            std::process::exit(1);
        }
        return;
    }
    if args.len() == 2 && args[1] == "--remove-tun-adapters" {
        if let Err(error) = tun::adapters::uninstall() {
            crate::diagnostics::error!("Remove owned TUN adapters: {}", error.message);
            std::process::exit(1);
        }
        return;
    }
    if args.len() == 2 && args[1] == "--ics-keeper" {
        diagnostics::initialize("sharing");
        diagnostics::log("sharing", "info", "Sharing keeper starting.");
        if let Err(e) = tun::keeper::run() {
            crate::diagnostics::error!("ICS keeper: {}", e.message);
            std::process::exit(1);
        }
        return;
    }
    let owner = if args.len() == 3 && args[1] == "--owner-sid" {
        args[2].clone()
    } else {
        crate::diagnostics::error!("Install this component with service/scripts/Install-Service.ps1; it runs through Windows SCM.");
        std::process::exit(2);
    };
    if !valid_owner(&owner) {
        crate::diagnostics::error!("Invalid owner SID.");
        std::process::exit(2);
    }
    diagnostics::initialize("service");
    let _ = OWNER.set(owner);
    if let Err(error) = service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
        crate::diagnostics::error!("SCM dispatcher: {error}");
        std::process::exit(1);
    }
}
fn valid_owner(owner: &str) -> bool {
    (owner.starts_with("S-1-5-21-") || owner.starts_with("S-1-12-1-"))
        && owner.len() < 184
        && owner
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'-' || b == b'S')
}
fn status(state: ServiceState, code: u32) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: if state == ServiceState::Running {
            // ICS must be handed back while Windows sharing/network services
            // are still running. Ordinary SHUTDOWN has no dependency ordering.
            ServiceControlAccept::STOP | ServiceControlAccept::PRESHUTDOWN
        } else {
            ServiceControlAccept::empty()
        },
        exit_code: if code == 0 {
            ServiceExitCode::Win32(0)
        } else {
            ServiceExitCode::ServiceSpecific(code)
        },
        checkpoint: if matches!(
            state,
            ServiceState::StartPending | ServiceState::StopPending
        ) {
            1
        } else {
            0
        },
        wait_hint: if matches!(
            state,
            ServiceState::StartPending | ServiceState::StopPending
        ) {
            Duration::from_secs(120)
        } else {
            Duration::ZERO
        },
        process_id: None,
    }
}
fn service_main(_: Vec<OsString>) {
    diagnostics::log("service", "info", "Windows service starting.");
    let (stop_tx, stop_rx) = watch::channel(false);
    let handle = match service_control_handler::register(SERVICE_NAME, move |control| match control
    {
        ServiceControl::Stop | ServiceControl::Preshutdown => {
            WINDOWS_SHUTDOWN.store(
                matches!(control, ServiceControl::Preshutdown),
                Ordering::SeqCst,
            );
            STOPPING.store(true, Ordering::SeqCst);
            diagnostics::log("service", "info", "Windows requested service shutdown.");
            let _ = stop_tx.send(true);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    }) {
        Ok(h) => h,
        Err(_) => return,
    };
    let _ = handle.set_service_status(status(ServiceState::StartPending, 0));
    let result = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| ApiError::io("Create service runtime", e))
        .and_then(|runtime| runtime.block_on(serve(OWNER.get().unwrap().clone(), handle, stop_rx)));
    if let Err(error) = &result {
        diagnostics::log(
            "service",
            "error",
            &format!("{}: {}", error.code, error.message),
        );
        let data = PathBuf::from(
            std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()),
        )
        .join("Wayrill");
        let _ = storage::write(&data.join("last-service-error.json"), error);
    }
    diagnostics::log("service", "info", "Windows service stopped.");
    diagnostics::flush();
    let _ = handle.set_service_status(status(
        ServiceState::Stopped,
        if result.is_ok() { 0 } else { 1 },
    ));
}
fn listener(owner: &str, first: bool) -> Result<NamedPipeServer> {
    let descriptor = native::SecurityDescriptor::pipe(owner)?;
    let mut attributes = descriptor.attributes();
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .max_instances(32)
            .create_with_security_attributes_raw(
                PIPE_NAME,
                (&mut attributes as *mut windows_sys::Win32::Security::SECURITY_ATTRIBUTES).cast(),
            )
            .map_err(|e| ApiError::io("Create protected local pipe", e))
    }
}
async fn serve(
    owner: String,
    status_handle: windows_service::service_control_handler::ServiceStatusHandle,
    stop: watch::Receiver<bool>,
) -> Result<()> {
    let base = std::env::current_exe()
        .map_err(|e| ApiError::io("Service location", e))?
        .parent()
        .unwrap()
        .to_path_buf();
    let data =
        PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()))
            .join("Wayrill");
    if !data.is_dir() {
        return Err(ApiError::new(
            "NOT_INSTALLED",
            "Protected data directory is missing. Run the installer.",
        ));
    }
    let events = events::Events::new();
    let init_owner = owner.clone();
    let init_events = events.clone();
    let kernel = pending_task(
        status_handle,
        ServiceState::StartPending,
        tokio::task::spawn_blocking(move || {
            kernel::Kernel::new(init_owner, base, data, init_events)
        }),
    )
    .await?;
    let kernel = Arc::new(Mutex::new(kernel));
    let requested_stop = stop.clone();
    let result = run_service(owner, status_handle, stop, kernel.clone(), events).await;
    let reason = if *requested_stop.borrow() {
        if WINDOWS_SHUTDOWN.load(Ordering::SeqCst) {
            lifecycle::ServiceExit::WindowsShutdown
        } else {
            lifecycle::ServiceExit::Stop
        }
    } else {
        lifecycle::ServiceExit::Unexpected
    };
    // All exits, including accept/listener/monitor errors, use the same drain.
    STOPPING.store(true, Ordering::SeqCst);
    let _ = status_handle.set_service_status(status(ServiceState::StopPending, 0));
    let cleanup = pending_task(
        status_handle,
        ServiceState::StopPending,
        tokio::task::spawn_blocking(move || {
            // Poisoned state is used solely to close owned jobs and recover journals;
            // no more commands may run against a partially completed transition.
            kernel
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .shutdown(reason)
        }),
    )
    .await;
    result.and(cleanup)
}
// SCM needs increasing checkpoints while native handoff/recovery is pending.
async fn pending_task<T>(
    handle: windows_service::service_control_handler::ServiceStatusHandle,
    state: ServiceState,
    mut task: tokio::task::JoinHandle<Result<T>>,
) -> Result<T> {
    let mut progress = tokio::time::interval(Duration::from_secs(10));
    let mut checkpoint = 1;
    loop {
        tokio::select! {
            result = &mut task => return result.map_err(|_| ApiError::new("SERVICE_FAULT", "Service lifecycle task failed."))?,
            _ = progress.tick() => {
                checkpoint += 1;
                let mut value = status(state, 0);
                value.checkpoint = checkpoint;
                // Do not abandon a blocking initialization/restore if SCM
                // reporting fails: it still owns native mutations and must drain.
                if let Err(error) = handle.set_service_status(value) {
                    crate::diagnostics::error!("Report service lifecycle progress: {error}");
                }
            }
        }
    }
}
fn lock_state<T>(state: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    state.lock().map_err(|_| {
        ApiError::new(
            "SERVICE_FAULT",
            "Service state failed; the coordinator must restart.",
        )
    })
}
async fn run_service(
    owner: String,
    status_handle: windows_service::service_control_handler::ServiceStatusHandle,
    mut stop: watch::Receiver<bool>,
    kernel: Arc<Mutex<kernel::Kernel>>,
    events: Arc<events::Events>,
) -> Result<()> {
    let server = listener(&owner, true)?;
    status_handle
        .set_service_status(status(ServiceState::Running, 0))
        .map_err(|e| ApiError::io("Report running service", e))?;
    // Successful initialization supersedes a previous startup failure.
    let error_path = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
    if let Err(error) =
        storage::remove(&PathBuf::from(error_path).join("Wayrill/last-service-error.json"))
    {
        diagnostics::log(
            "service",
            "warning",
            &format!(
                "Could not clear the previous startup diagnostic: {}",
                error.message
            ),
        );
    }
    events.publish("service.ready", lock_state(&kernel)?.snapshot());
    let manager = lock_state(&kernel)?.subscriptions.clone();
    let gate = manager.gate.clone();
    // Serve lock-free activity queries while native startup holds the kernel.
    // JoinSet owns the listener, including every early-return startup failure.
    let mut listeners = tokio::task::JoinSet::new();
    listeners.spawn(serve_clients(
        server,
        owner,
        kernel.clone(),
        events.clone(),
        gate,
        stop.clone(),
    ));
    let boot_kernel = kernel.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        if !STOPPING.load(Ordering::SeqCst) {
            let mut kernel = lock_state(&boot_kernel)?;
            let observed = kernel.events.clone();
            activity::with_events(observed, || {
                if !kernel.resume_upgrade() {
                    kernel.resume_routing();
                }
            });
        }
        Ok(())
    })
    .await
    .map_err(|_| ApiError::new("SERVICE_FAULT", "Startup task failed."))??;
    let subscriptions = subscriptions::Actor::start(kernel.clone(), manager)?;
    // Resource updates cannot race boot validation.
    let monitor_kernel = kernel.clone();
    let mut monitor_stop = stop.clone();
    let mut monitor = tokio::spawn(async move {
        let mut interval = tokio::time::interval(traffic::SAMPLE_INTERVAL);
        // Lifecycle work can delay the monitor. Missed polls are not measurements
        // and must not be replayed in a burst against cumulative counters.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = monitor_stop.changed() => return Ok::<(), ApiError>(()),
                _ = interval.tick() => {
                    let k = monitor_kernel.clone();
                    let request = tokio::task::spawn_blocking(move || -> Result<_> {
                        let mut k = lock_state(&k)?;
                        if STOPPING.load(Ordering::SeqCst) { return Ok(None); }
                        let observed = k.events.clone();
                        activity::with_events(observed, || k.tick());
                        Ok(k.traffic_request())
                    }).await.map_err(|_| ApiError::new("SERVICE_FAULT", "Lifecycle monitor failed."))??;
                    // Statistics faults remain independent of traffic routing.
                    let sample = if let Some((generation, counter_epoch, bridge)) = request {
                        tokio::task::spawn_blocking(move || (generation, counter_epoch, bridge.read())).await.ok()
                    } else { None };
                    let k = monitor_kernel.clone();
                    tokio::task::spawn_blocking(move || -> Result<()> {
                        let mut k = lock_state(&k)?;
                        if !STOPPING.load(Ordering::SeqCst) {
                            if let Some((generation, counter_epoch, sample)) = sample { k.accept_traffic(generation, counter_epoch, sample); }
                            k.events.publish("service.snapshot", k.snapshot());
                        }
                        Ok(())
                    }).await.map_err(|_| ApiError::new("SERVICE_FAULT", "Snapshot monitor failed."))??;
                }
            }
        }
    });
    let mut subscription_health = tokio::time::interval(Duration::from_secs(1));
    let result = async {
        loop {
            if *stop.borrow() { return Ok(()); }
            tokio::select! {
                _ = subscription_health.tick() => {
                    if subscriptions.failed(){return Err(ApiError::new("SERVICE_FAULT","Subscription maintenance ended unexpectedly; the coordinator must restart."));}
                },
                _ = stop.changed() => return Ok(()),
                result = &mut monitor => return result.map_err(|_| ApiError::new("SERVICE_FAULT", "Service monitor failed."))?,
                result = listeners.join_next() => return result
                    .ok_or_else(|| ApiError::new("SERVICE_FAULT", "Service listener ended unexpectedly."))?
                    .map_err(|_| ApiError::new("SERVICE_FAULT", "Service listener failed."))?,
            }
        }
    }.await;
    STOPPING.store(true, Ordering::SeqCst);
    drop(listeners);
    monitor.abort();
    drop(subscriptions);
    result
}
async fn serve_clients(
    mut server: NamedPipeServer,
    owner: String,
    kernel: Arc<Mutex<kernel::Kernel>>,
    events: Arc<events::Events>,
    gate: operation_gate::Gate,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let slots = Arc::new(Semaphore::new(MAX_PIPE_CLIENTS));
    // Kernel work may wait for a slow native transition after its observer has
    // timed out. Keep that work bounded without consuming every connection:
    // lock-free activity queries must remain reachable during recovery.
    let requests = Arc::new(Semaphore::new(MAX_KERNEL_REQUESTS));
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        tokio::select! {
            _ = stop.changed() => return Ok(()),
            connected = server.connect() => {
                connected.map_err(|e| ApiError::io("Accept local client", e))?;
                let next = listener(&owner, false)?;
                let connected = std::mem::replace(&mut server, next);
                if let Ok(slot) = slots.clone().try_acquire_owned() {
                    let (k,e,o,g,r) = (kernel.clone(), events.clone(), owner.clone(), gate.clone(), requests.clone());
                    tokio::spawn(async move { let _slot = slot; let _ = client(connected,o,k,e,g,r).await; });
                }
            }
        }
    }
}
fn reserve_request(
    method: &str,
    requests: &Arc<Semaphore>,
) -> Result<Option<tokio::sync::OwnedSemaphorePermit>> {
    if method == "service.activity" {
        return Ok(None);
    }
    requests.clone().try_acquire_owned().map(Some).map_err(|_| {
        let mut error = ApiError::new(
            "BUSY",
            "The service is busy. Wait for the current operation to finish.",
        );
        error.retryable = true;
        error
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Subscribe {
    after_sequence: u64,
    #[serde(default)]
    after_instance_id: Option<String>,
}
async fn client(
    pipe: NamedPipeServer,
    owner: String,
    kernel: Arc<Mutex<kernel::Kernel>>,
    events: Arc<events::Events>,
    gate: operation_gate::Gate,
    requests: Arc<Semaphore>,
) -> Result<()> {
    let raw = pipe.as_raw_handle() as usize;
    let mut pipe = BufReader::new(pipe);
    let mut first = true;
    loop {
        let frame = tokio::time::timeout(
            Duration::from_secs(if first { 10 } else { 120 }),
            wayrill_ipc::read_frame(&mut pipe),
        )
        .await
        .map_err(|_| ApiError::new("TIMEOUT", "Idle client timed out."))??;
        let Some(frame) = frame else {
            return Ok(());
        };
        if STOPPING.load(Ordering::SeqCst) {
            return Err(ApiError::new(
                "SERVICE_STOPPING",
                "The service is shutting down.",
            ));
        }
        if first {
            native::authorize_pipe(raw as windows_sys::Win32::Foundation::HANDLE, &owner)?;
            first = false;
        }
        let request: Request = match serde_json::from_slice(&frame) {
            Ok(r) => r,
            Err(_) => {
                wayrill_ipc::write_message(
                    pipe.get_mut(),
                    &Message::response(
                        0,
                        Err(ApiError::new(
                            "INVALID_REQUEST",
                            "Invalid request envelope.",
                        )),
                    ),
                )
                .await?;
                return Ok(());
            }
        };
        if let Err(error) = wayrill_protocol::check_request(&request) {
            wayrill_ipc::write_message(pipe.get_mut(), &Message::response(request.id, Err(error)))
                .await?;
            continue;
        }
        let slot = match reserve_request(&request.method, &requests) {
            Ok(slot) => slot,
            Err(error) => {
                wayrill_ipc::write_message(
                    pipe.get_mut(),
                    &Message::response(request.id, Err(error)),
                )
                .await?;
                continue;
            }
        };
        if request.method == "service.activity" {
            let result = if request.params == json!({}) {
                Ok(events.activity())
            } else {
                Err(ApiError::new(
                    "INVALID_PARAMS",
                    "Progress query takes no parameters.",
                ))
            };
            wayrill_ipc::write_message(pipe.get_mut(), &Message::response(request.id, result))
                .await?;
            continue;
        }
        if request.method == "events.subscribe" {
            let p: Subscribe = match wayrill_protocol::params(request.params) {
                Ok(p) => p,
                Err(error) => {
                    wayrill_ipc::write_message(
                        pipe.get_mut(),
                        &Message::response(request.id, Err(error)),
                    )
                    .await?;
                    continue;
                }
            };
            let k = kernel.clone();
            let e = events.clone();
            // Capture routing and library state under their respective locks. Capture
            // the cursor and snapshot together so queued state events cannot predate
            // the acknowledged snapshot while appearing newer than its cursor.
            let (snapshot, subscriptions, sequence, gap, replay, mut receiver) =
                tokio::task::spawn_blocking(move || {
                    let _slot = slot;
                    let k = lock_state(&k)?;
                    Ok::<_, ApiError>(k.subscriptions.synchronized(|subscriptions| {
                        let (sequence, gap, replay, receiver) =
                            e.subscribe(p.after_sequence, p.after_instance_id.as_deref());
                        (k.snapshot(), subscriptions, sequence, gap, replay, receiver)
                    }))
                })
                .await
                .map_err(|_| ApiError::new("SERVICE_FAULT", "Snapshot task failed."))??;
            wayrill_ipc::write_message(
                pipe.get_mut(),
                &Message::response(
                    request.id,
                    Ok(json!({"instanceId":events.instance_id,"sequence":sequence,"replayGap":gap,"snapshot":snapshot,"subscriptions":subscriptions})),
                ),
            )
            .await?;
            for message in replay {
                wayrill_ipc::write_message(pipe.get_mut(), &message).await?;
            }
            loop {
                match receiver.recv().await {
                    Ok(message) => wayrill_ipc::write_message(pipe.get_mut(), &message).await?,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        return Err(ApiError::new(
                            "EVENT_GAP",
                            "Slow event subscriber disconnected. Reconnect and refresh status.",
                        ))
                    }
                    Err(_) => return Ok(()),
                }
            }
        }
        let id = request.id;
        let command_name = request.method.clone();
        let command_started = std::time::Instant::now();
        let k = kernel.clone();
        let gate = gate.clone();
        // Bounded latest-value channel: a slow/disconnected observer cannot
        // block the native operation or grow an unbounded progress queue.
        let (progress, mut activities) = tokio::sync::watch::channel(None);
        let mut operation = tokio::task::spawn_blocking(move || {
            // The permit follows the operation, not the response observer. A
            // disconnected client cannot make uncertain work stop counting.
            let _slot = slot;
            // Admission must precede the kernel lock: draining a background
            // probe or commit can itself need the kernel.
            let mut reservation = operation_gate::requires_foreground(&request.method)
                .then(|| gate.foreground(&STOPPING))
                .transpose()?;
            let mut k = lock_state(&k)?;
            if STOPPING.load(Ordering::SeqCst) {
                Err(ApiError::new(
                    "SERVICE_STOPPING",
                    "The service is shutting down; queued commands were not executed.",
                ))
            } else {
                let result = activity::observe(
                    move |a| {
                        progress.send_replace(Some(a));
                    },
                    || k.handle(&request.method, request.params),
                );
                if result.is_ok() && request.method == "outbounds.testStart" {
                    k.retain_test_reservation(reservation.take());
                }
                if result.is_ok() && request.method == "routing.diagnosticStart" {
                    k.retain_diagnostic_reservation(reservation.take());
                }
                result
            }
        });
        let result = loop {
            tokio::select! {
                result = &mut operation => break result.map_err(|e| ApiError::io("Service operation", e))?,
                Ok(()) = activities.changed() => {
                    let activity = activities.borrow_and_update().clone();
                    if let Some(activity) = activity {
                        wayrill_ipc::write_message(pipe.get_mut(), &Message::Progress { api_version: wayrill_protocol::API_VERSION, id, activity }).await?;
                    }
                }
            }
        };
        if let Err(error) = &result {
            diagnostics::log(
                "command",
                "error",
                &format!(
                    "{command_name} failed after {} ms: {}: {}",
                    command_started.elapsed().as_millis(),
                    error.code,
                    error.message
                ),
            );
        }
        wayrill_ipc::write_message(pipe.get_mut(), &Message::response(id, result)).await?;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saturated_request_admission_rejects_kernel_dispatch_but_keeps_progress_available() {
        let requests = Arc::new(Semaphore::new(MAX_KERNEL_REQUESTS));
        let held: Vec<_> = (0..MAX_KERNEL_REQUESTS)
            .map(|_| reserve_request("service.sync", &requests).unwrap().unwrap())
            .collect();
        for method in [
            "service.sync",
            "service.status",
            "events.subscribe",
            "config.applyAndStart",
            "core.stop",
        ] {
            let error = reserve_request(method, &requests).unwrap_err();
            assert_eq!(error.code, "BUSY");
            assert!(error.retryable);
        }
        assert!(reserve_request("service.activity", &requests)
            .unwrap()
            .is_none());
        assert_eq!(requests.available_permits(), 0);
        drop(held);
        assert!(reserve_request("events.subscribe", &requests)
            .unwrap()
            .is_some());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnected_observer_cannot_admit_more_blocked_kernel_work() {
        let requests = Arc::new(Semaphore::new(MAX_KERNEL_REQUESTS));
        let clients = Arc::new(Semaphore::new(MAX_PIPE_CLIENTS));
        let mut waiting = Vec::new();
        let mut connections = Vec::new();
        for _ in 1..MAX_KERNEL_REQUESTS {
            waiting.push(reserve_request("service.sync", &requests).unwrap());
            connections.push(clients.clone().try_acquire_owned().unwrap());
        }
        let permit = reserve_request("service.sync", &requests).unwrap();
        let connection = clients.clone().try_acquire_owned().unwrap();
        let (release, released) = std::sync::mpsc::channel();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let operation = tokio::task::spawn_blocking(move || {
            let slot = permit;
            started.send(()).unwrap();
            released.recv().unwrap();
            drop(slot);
            finished.send(()).unwrap();
        });
        let observer = tokio::spawn(async move {
            let _connection = connection;
            operation.await.unwrap();
        });
        entered.await.unwrap();
        observer.abort();
        assert!(observer.await.unwrap_err().is_cancelled());
        for _ in 0..MAX_PIPE_CLIENTS * 2 {
            // Reconnecting readers are rejected before spawning more blocking
            // work. Their response does not need the occupied kernel lock.
            let _connection = clients.clone().try_acquire_owned().unwrap();
            assert_eq!(
                reserve_request("service.sync", &requests).unwrap_err().code,
                "BUSY"
            );
        }
        assert_eq!(
            clients.available_permits(),
            MAX_PIPE_CLIENTS - MAX_KERNEL_REQUESTS + 1
        );
        assert_eq!(requests.available_permits(), 0);
        release.send(()).unwrap();
        done.await.unwrap();
        assert!(reserve_request("service.sync", &requests).is_ok());
        drop(waiting);
        assert_eq!(requests.available_permits(), MAX_KERNEL_REQUESTS);
    }
    #[tokio::test]
    async fn kernel_admission_is_released_after_operation_error_or_panic() {
        let requests = Arc::new(Semaphore::new(1));
        for panic in [false, true] {
            let slot = reserve_request("service.sync", &requests).unwrap();
            let operation = tokio::task::spawn_blocking(move || -> Result<()> {
                let _slot = slot;
                assert!(!panic, "test worker panic");
                Err(ApiError::new("TEST_FAILURE", "test operation error"))
            });
            if panic {
                assert!(operation.await.unwrap_err().is_panic());
            } else {
                assert_eq!(operation.await.unwrap().unwrap_err().code, "TEST_FAILURE");
            }
            assert!(reserve_request("service.sync", &requests).is_ok());
        }
    }
    #[test]
    fn poisoned_state_is_rejected_instead_of_reused() {
        let state = Mutex::new(0);
        let _ = std::panic::catch_unwind(|| {
            let _guard = state.lock().unwrap();
            panic!("test transition");
        });
        assert_eq!(lock_state(&state).unwrap_err().code, "SERVICE_FAULT");
    }
    #[test]
    fn owner_sid_is_not_sddl_injection() {
        assert!(valid_owner("S-1-5-21-1-2-3-1001"));
        assert!(!valid_owner("S-1-5-21-1)(A;;GA;;;WD)"));
        assert!(!valid_owner("S-1-5-18"));
    }
    #[test]
    fn networking_restoration_precedes_ordinary_windows_service_shutdown() {
        let controls = status(ServiceState::Running, 0).controls_accepted;
        assert!(controls.contains(ServiceControlAccept::STOP | ServiceControlAccept::PRESHUTDOWN));
        assert!(!controls.contains(ServiceControlAccept::SHUTDOWN));
        assert!(status(ServiceState::StopPending, 0)
            .controls_accepted
            .is_empty());
    }
}
