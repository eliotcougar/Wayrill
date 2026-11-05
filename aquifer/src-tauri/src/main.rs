#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod app_data;
mod remote;
mod transport;
mod user_library;
mod winscp;
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
async fn ssh_sessions(
    state: State<'_, Arc<remote::Operation>>,
) -> Result<winscp::Inventory, remote::RemoteError> {
    state.disconnect();
    tauri::async_runtime::spawn_blocking(winscp::inventory)
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_choose_winscp(
    kind: String,
    window: tauri::Window,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<Option<winscp::Inventory>, remote::RemoteError> {
    let owner = window.hwnd().map_err(|_| worker_error())?.0 as usize;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = winscp::choose(&kind, owner)?;
        if result.is_some() {
            state.disconnect();
        }
        Ok(result)
    })
    .await
    .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_set_config(
    config: String,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<winscp::Inventory, remote::RemoteError> {
    state.disconnect();
    tauri::async_runtime::spawn_blocking(move || winscp::set_config(&config))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_reset_setup(
    state: State<'_, Arc<remote::Operation>>,
) -> Result<winscp::Inventory, remote::RemoteError> {
    state.disconnect();
    tauri::async_runtime::spawn_blocking(winscp::reset)
        .await
        .map_err(|_| worker_error())?
}
fn worker_error() -> remote::RemoteError {
    remote::RemoteError {
        code: "WORKER",
        message: "The SSH reader stopped unexpectedly. Retry the read.".into(),
    }
}
#[tauri::command]
async fn ssh_discover(
    session: String,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<remote::Discovery, remote::RemoteError> {
    let state = state.acquire()?;
    tauri::async_runtime::spawn_blocking(move || remote::discover(state, &session))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_read_config(
    session: String,
    path: String,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<remote::ConfigSnapshot, remote::RemoteError> {
    let state = state.acquire()?;
    tauri::async_runtime::spawn_blocking(move || remote::read_config(state, &session, &path))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_server_status(
    session: String,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<remote::ServerStatus, remote::RemoteError> {
    let state = state.acquire()?;
    tauri::async_runtime::spawn_blocking(move || remote::server_status(state, &session))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_preview_upgrade(
    session: String,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<remote::UpgradePlan, remote::RemoteError> {
    let state = state.acquire()?;
    tauri::async_runtime::spawn_blocking(move || remote::preview_upgrade(state, &session))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_start_action(
    session: String,
    request: remote::ActionRequest,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<remote::ServerJob, remote::RemoteError> {
    let state = state.acquire()?;
    tauri::async_runtime::spawn_blocking(move || remote::start_action(state, &session, request))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_validate_config(
    session: String,
    request: remote::ConfigValidationRequest,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<remote::ConfigValidation, remote::RemoteError> {
    let state = state.acquire()?;
    tauri::async_runtime::spawn_blocking(move || remote::validate_config(state, &session, request))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn ssh_poll_action(
    session: String,
    id: String,
    state: State<'_, Arc<remote::Operation>>,
) -> Result<remote::ServerJob, remote::RemoteError> {
    let state = state.acquire()?;
    tauri::async_runtime::spawn_blocking(move || remote::poll_action(state, &session, &id))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
fn ssh_cancel(state: State<'_, Arc<remote::Operation>>) {
    state.cancel();
}
#[tauri::command]
fn ssh_disconnect(state: State<'_, Arc<remote::Operation>>) {
    state.disconnect();
}

#[tauri::command]
async fn user_library_load() -> Result<Option<String>, remote::RemoteError> {
    tauri::async_runtime::spawn_blocking(user_library::load)
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn user_library_save(text: String) -> Result<(), remote::RemoteError> {
    tauri::async_runtime::spawn_blocking(move || user_library::save(text))
        .await
        .map_err(|_| worker_error())?
}
#[tauri::command]
async fn export_json(
    filename: String,
    text: String,
    window: tauri::Window,
) -> Result<bool, remote::RemoteError> {
    let owner = window.hwnd().map_err(|_| worker_error())?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || user_library::export(&filename, &text, owner))
        .await
        .map_err(|_| worker_error())?
}

fn main() {
    // A read-only native smoke test uses the same implementation as the GUI.
    // Receipts contain paths/counts/hashes, never configuration JSON or credentials.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|v| {
        matches!(
            v.as_str(),
            "--verify-server"
                | "--verify-status"
                | "--server-action"
                | "--server-job"
                | "--preview-upgrade"
                | "--verify-config"
        )
    }) {
        let result = args.get(2).ok_or_else(worker_error).and_then(|session| {
            let state = Arc::new(remote::Operation::default());
            let inventory = winscp::inventory()?;
            let chosen = inventory
                .sessions
                .iter()
                .find(|s| s.id == *session || s.name == *session)
                .ok_or_else(worker_error)?;
            if args[1] == "--verify-status" {
                let status = remote::server_status(state.acquire()?, &chosen.id)?;
                return Ok(serde_json::json!({"passed": true, "status": status}));
            }
            if args[1] == "--preview-upgrade" {
                let plan = remote::preview_upgrade(state.acquire()?, &chosen.id)?;
                return Ok(serde_json::json!({"passed":true,"plan":plan}));
            }
            if args[1] == "--server-action" {
                let request: remote::ActionRequest = serde_json::from_slice(
                    &std::fs::read(args.get(4).ok_or_else(worker_error)?)
                        .map_err(|_| worker_error())?,
                )
                .map_err(|_| worker_error())?;
                let job = remote::start_action(state.acquire()?, &chosen.id, request)?;
                return Ok(serde_json::json!({"passed":true,"job":job}));
            }
            if args[1] == "--server-job" {
                let job = remote::poll_action(
                    state.acquire()?,
                    &chosen.id,
                    args.get(4).ok_or_else(worker_error)?,
                )?;
                return Ok(serde_json::json!({"passed":true,"job":job}));
            }
            let discovery = remote::discover(state.acquire()?, &chosen.id)?;
            let serialized = serde_json::to_value(&discovery).map_err(|_| worker_error())?;
            let file = serialized["files"]
                .as_array()
                .and_then(|a| {
                    a.iter()
                        .find(|v| v["running"] == true && v["readable"] == true)
                })
                .and_then(|v| v["path"].as_str())
                .ok_or_else(worker_error)?;
            let config = remote::read_config(state.acquire()?, &chosen.id, file)?;
            if args[1] == "--verify-config" {
                let service = serialized["files"]
                    .as_array()
                    .and_then(|files| files.iter().find(|item| item["path"] == file))
                    .and_then(|item| item["services"].as_array())
                    .and_then(|items| items.first())
                    .and_then(|item| item.as_str())
                    .unwrap_or("xray.service");
                let validation = remote::validate_config(
                    state.acquire()?,
                    &chosen.id,
                    remote::ConfigValidationRequest {
                        path: config.path,
                        service: service.to_owned(),
                        expected_sha256: config.sha256,
                        config_text: config.text,
                        wayrill_text: None,
                        expected_wayrill_sha256: None,
                        stage: false,
                    },
                )?;
                return Ok(serde_json::json!({"passed":validation.valid,"validation":validation}));
            }
            Ok(serde_json::json!({
                "passed": true,
                "files": serialized["files"].as_array().map_or(0, Vec::len),
                "processes": serialized["processes"].as_array().map_or(0, Vec::len),
                "bytes": config.bytes,
                "sha256": config.sha256,
                "winscpExecutable": inventory.executable,
                "sessionSource": inventory.source,
            }))
        });
        if let Some(path) = args.get(3) {
            let receipt = match &result {
                Ok(value) => value.clone(),
                Err(error) => serde_json::json!({ "passed": false, "error": error }),
            };
            let _ = std::fs::write(path, serde_json::to_vec_pretty(&receipt).unwrap());
        }
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    let state = Arc::new(remote::Operation::default());
    let closing = state.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            ssh_sessions,
            ssh_discover,
            ssh_read_config,
            ssh_server_status,
            ssh_preview_upgrade,
            ssh_start_action,
            ssh_validate_config,
            ssh_poll_action,
            ssh_cancel,
            ssh_disconnect,
            user_library_load,
            user_library_save,
            export_json,
            ssh_choose_winscp,
            ssh_set_config,
            ssh_reset_setup
        ])
        .build(tauri::generate_context!())
        .expect("Wayrill Aquifer initialization failed")
        .run(move |_, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                closing.shutdown();
            }
        });
}
