#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
mod companion;
mod diagnostics;
mod export;
mod picker;
mod routing_source;
// Reuse the bounded WinHTTP reader; manual rule downloads run under the desktop token.
#[path = "../../service/subscription_http.rs"]
mod routing_http;
mod shutdown;
mod tray;
mod vault;

#[tauri::command]
async fn export_json(
    window: tauri::WebviewWindow,
    name: String,
    text: String,
) -> Result<bool, String> {
    let owner = window.hwnd().map_err(|_| "Cannot find the app window.")?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || export::save(owner, &name, &text))
        .await
        .map_err(|_| "Export task failed.")?
}

#[tauri::command]
async fn process_picker(
    window: tauri::WebviewWindow,
    mode: String,
) -> Result<Option<String>, String> {
    let owner = window.hwnd().map_err(|_| "Cannot find the app window.")?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        // A dedicated STA thread avoids inheriting COM mode from an unrelated runtime task.
        std::thread::spawn(move || picker::choose(owner, &mode))
            .join()
            .map_err(|_| "Process picker failed.")?
    })
    .await
    .map_err(|_| "Process picker task failed.")?
}

#[tauri::command]
async fn routing_source_file(
    window: tauri::WebviewWindow,
    path: Option<String>,
) -> Result<Option<Value>, String> {
    let owner = window.hwnd().map_err(|_| "Cannot find the app window.")?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let path = match path {
            Some(path) => Some(path),
            None => std::thread::spawn(move || picker::choose(owner, "routing"))
                .join()
                .map_err(|_| "Routing file picker failed.")??,
        };
        path.map(|path| routing_source::read(&path).map(|text| json!({"path": path, "text": text})))
            .transpose()
    })
    .await
    .map_err(|_| "Routing file task failed.")?
}

#[tauri::command]
async fn routing_source_download(
    url: String,
    allow_http: bool,
    proxy_port: Option<u16>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = routing_http::fetch(
            &url,
            allow_http,
            "",
            &std::collections::BTreeMap::new(),
            proxy_port,
        )?;
        if text.len() > wayrill_protocol::MAX_CONFIG {
            return Err("Routing files must be at most 16 MiB.".into());
        }
        Ok(text)
    })
    .await
    .map_err(|_| "Routing download task failed.")?
}

use tauri::{Emitter, Manager};
struct VaultLock {
    write: Mutex<()>,
    // Held for the process lifetime, including across Windows sessions.
    _lease: std::fs::File,
}

#[tauri::command]
async fn protected_read(
    app: tauri::AppHandle,
    key: String,
    lock: tauri::State<'_, Arc<VaultLock>>,
) -> Result<Option<String>, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot find app storage.")?;
    let lock = lock.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.write.lock().map_err(|_| "Storage is busy.")?;
        vault::read(&base, &key)
    })
    .await
    .map_err(|_| "Storage task failed.")?
}
#[tauri::command]
async fn protected_write(
    app: tauri::AppHandle,
    key: String,
    text: String,
    lock: tauri::State<'_, Arc<VaultLock>>,
) -> Result<(), String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot find app storage.")?;
    let lock = lock.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.write.lock().map_err(|_| "Storage is busy.")?;
        vault::write(&base, &key, &text)
    })
    .await
    .map_err(|_| "Storage task failed.")?
}
use wayrill_protocol::{ApiError, Message};

#[tauri::command]
async fn service_request(method: String, params: Value) -> Result<Value, ApiError> {
    let result = wayrill_ipc::windows::request(&method, params).await;
    if let Err(error) = &result {
        wayrill_diagnostics::log(
            "ipc",
            "error",
            &format!("{method}: {}: {}", error.code, error.message),
        );
    }
    if method == "system.capture.setScope" && result.is_ok() {
        wayrill_ipc::windows::notify_proxy_scope();
    }
    if result.is_ok()
        && ((method.starts_with("system.capture.") && method != "system.capture.diagnose")
            || method == "core.stop"
            || method == "core.restart"
            || method == "config.applyAndStart"
            || method == "config.refreshOutbounds")
    {
        wayrill_ipc::windows::refresh_environment();
    }
    if (method.starts_with("system.capture.") && method != "system.capture.diagnose")
        || method == "core.stop"
        || method == "core.restart"
        || method == "config.applyAndStart"
        || method == "config.refreshOutbounds"
    {
        wayrill_ipc::windows::refresh_proxy_cache();
    }
    result
}
#[tauri::command]
fn service_events_start(app: tauri::AppHandle, worker: tauri::State<shutdown::Shutdown>) {
    worker.start_events(|| {
        tauri::async_runtime::spawn(async move {
            let sequence = Arc::new(AtomicU64::new(0));
            let instance = Arc::new(Mutex::new(None::<String>));
            let mut delay = 1;
            loop {
                let cursor = sequence.load(Ordering::SeqCst);
                let previous_instance = instance.lock().unwrap().clone();
                let event_app = app.clone();
                let event_sequence = sequence.clone();
                let event_instance = instance.clone();
                let established = Arc::new(AtomicBool::new(false));
                let event_established = established.clone();
                let result =
                    wayrill_ipc::windows::subscribe(cursor, previous_instance, move |message| {
                        tray::message(&event_app, &message);
                        match &message {
                            Message::Event { sequence, kind, .. } => {
                                event_sequence.fetch_max(*sequence, Ordering::SeqCst);
                                if kind == "system.captureScopeChanged" {
                                    wayrill_ipc::windows::notify_proxy_scope();
                                }
                                if kind.starts_with("system.capture") || kind == "core.state" {
                                    wayrill_ipc::windows::refresh_environment();
                                    wayrill_ipc::windows::refresh_proxy_cache();
                                }
                            }
                            Message::Response {
                                ok: true, result, ..
                            } => {
                                let next = result["instanceId"].as_str().map(String::from);
                                let mut last = event_instance.lock().unwrap();
                                if *last != next || result["replayGap"] == true {
                                    event_sequence.store(0, Ordering::SeqCst);
                                }
                                *last = next;
                                event_established.store(true, Ordering::SeqCst);
                                wayrill_ipc::windows::refresh_environment();
                                wayrill_ipc::windows::refresh_proxy_cache();
                                let _ = event_app
                                    .emit("wayrill-service-transport", json!({"connected":true}));
                            }
                            _ => {}
                        }
                        let _ = event_app.emit("wayrill-service-event", message);
                    })
                    .await;
                if established.load(Ordering::SeqCst) {
                    delay = 1;
                }
                tray::disconnected(&app);
                let _ = app.emit(
                    "wayrill-service-transport",
                    json!({"connected":false,"error":result.err()}),
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                delay = (delay * 2).min(10);
            }
        })
    });
}
fn main() {
    let exit_only = std::env::args().skip(1).any(|arg| arg == "--exit");
    let mut context = tauri::generate_context!();
    if exit_only {
        context.config_mut().app.windows.clear();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().skip(1).any(|arg| arg == "--exit") {
                if let Err(error) = shutdown::desktop_exit(app.clone()) {
                    wayrill_diagnostics::log("shutdown", "error", &error);
                }
            } else {
                tray::show(app);
            }
        }))
        .setup(move |app| {
            // Installer shutdown must also be harmless if the old desktop
            // exited between process enumeration and this launch.
            if exit_only {
                app.handle().exit(0);
                return Ok(());
            }
            // The plugin activates the existing window in the usual session.
            // The file lease also prevents concurrent vault writers in another
            // session or during the plugin's first-window startup race.
            diagnostics::initialize(app.handle());
            let base = app.path().app_local_data_dir()?;
            app.manage(Arc::new(VaultLock {
                write: Mutex::new(()),
                _lease: vault::lock_workspace(&base)?,
            }));
            if let Some(window) = app.get_webview_window("main") {
                let dependencies: Value =
                    serde_json::from_str(include_str!("../../service/dependencies.json"))?;
                let core_version = dependencies["xray"]["version"]
                    .as_str()
                    .ok_or("Missing embedded Xray version")?;
                window.set_title(&format!(
                    "Wayrill {} · Xray {core_version}",
                    app.package_info().version
                ))?;
                if let (Ok(Some(monitor)), Ok(size)) =
                    (window.current_monitor(), window.outer_size())
                {
                    let available = monitor.work_area().size;
                    // The configured logical size can exceed a scaled laptop work area.
                    if size.width > available.width || size.height > available.height {
                        let _ = window.maximize();
                    }
                }
            }
            if let Err(error) = tray::install(app.handle()) {
                // Keep normal close/save available if the notification area
                // cannot be initialized; never hide an inaccessible app.
                wayrill_diagnostics::log("desktop", "error", &format!("Tray unavailable: {error}"));
            }
            Ok(())
        })
        .manage(shutdown::Shutdown::default())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                if window.app_handle().tray_by_id(tray::ID).is_some() {
                    if let Err(error) = window.hide() {
                        wayrill_diagnostics::log("desktop", "error", &error.to_string());
                    }
                } else if let Err(error) = shutdown::desktop_exit(window.app_handle().clone()) {
                    wayrill_diagnostics::log("shutdown", "error", &error);
                }
            }
            tauri::WindowEvent::Destroyed => {
                window.state::<shutdown::Shutdown>().stop();
                wayrill_diagnostics::log("shutdown", "info", "Desktop window closed.");
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            companion::companion_status,
            companion::companion_register,
            companion::companion_unregister,
            companion::companion_open,
            service_request,
            service_events_start,
            tray::tray_quick_switch,
            shutdown::desktop_close_cancel,
            shutdown::desktop_exit,
            shutdown::desktop_ready,
            protected_read,
            protected_write,
            export_json,
            process_picker,
            routing_source_file,
            routing_source_download,
            diagnostics::diagnostics_read,
            diagnostics::diagnostics_open,
            diagnostics::diagnostics_record
        ])
        .build(context)
        .expect("could not start Wayrill")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<shutdown::Shutdown>().stop();
                wayrill_diagnostics::flush();
            }
        });
}
