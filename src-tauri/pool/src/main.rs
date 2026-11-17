#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../../src/export.rs"]
mod export;
#[path = "../../src/picker.rs"]
mod picker;
#[path = "../../../service/pool_access.rs"]
mod pool_access;
#[path = "../../src/pool_accounts.rs"]
mod pool_accounts;
#[path = "../../src/pool_publisher.rs"]
mod pool_publisher;
#[path = "../../src/pool_transfer.rs"]
#[allow(dead_code)]
mod pool_transfer;
#[path = "../../src/routing_source.rs"]
mod routing_source;
mod simulation;
#[path = "../../src/vault.rs"]
mod vault;

use routing_source::http as subscription_http;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

struct Store {
    base: PathBuf,
    legacy: PathBuf,
    serial: Mutex<()>,
    _lease: std::fs::File,
}

async fn task<T: Send + 'static>(
    store: tauri::State<'_, Arc<Store>>,
    operation: impl FnOnce(&Store) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store.serial.lock().map_err(|_| "Pool storage is busy.")?;
        operation(&store)
    })
    .await
    .map_err(|_| "The Pool storage task ended unexpectedly.")?
}

#[tauri::command]
async fn export_json(
    window: tauri::WebviewWindow,
    name: String,
    text: String,
) -> Result<bool, String> {
    let owner = window.hwnd().map_err(|_| "Cannot find the Pool window.")?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || export::save(owner, &name, &text))
        .await
        .map_err(|_| "Export task failed.")?
}

#[tauri::command]
async fn pool_accounts_read() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(pool_accounts::read_all)
        .await
        .map_err(|_| "Could not open the Aquifer account cache.")?
}

#[tauri::command]
async fn pool_read(store: tauri::State<'_, Arc<Store>>) -> Result<Option<String>, String> {
    task(store, |store| {
        if let Some(text) = vault::read(&store.base, "pools")? {
            return Ok(Some(text));
        }
        let legacy = vault::read(&store.legacy, "pools")?;
        if let Some(text) = &legacy {
            vault::write(&store.base, "pools", text)?;
        }
        Ok(legacy)
    })
    .await
}

#[tauri::command]
async fn pool_write(store: tauri::State<'_, Arc<Store>>, text: String) -> Result<(), String> {
    task(store, move |store| {
        vault::write(&store.base, "pools", &text)
    })
    .await
}

#[tauri::command]
async fn pool_inbox(store: tauri::State<'_, Arc<Store>>) -> Result<Vec<String>, String> {
    task(store, |store| pool_transfer::list(&store.base)).await
}

#[tauri::command]
async fn pool_import(store: tauri::State<'_, Arc<Store>>, id: String) -> Result<String, String> {
    task(store, move |store| pool_transfer::read(&store.base, &id)).await
}

#[tauri::command]
async fn pool_discard(store: tauri::State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    task(store, move |store| pool_transfer::discard(&store.base, &id)).await
}

#[tauri::command]
async fn pool_folder(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let owner = window.hwnd().map_err(|_| "Cannot find the Pool window.")?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::spawn(move || picker::choose(owner, "pool-folder"))
            .join()
            .map_err(|_| "Pool folder picker failed.")?
    })
    .await
    .map_err(|_| "The Pool folder task ended unexpectedly.")?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit("pool-inbox-changed", ());
        }))
        .setup(|app| {
            let base = app.path().app_local_data_dir()?;
            let legacy = base.with_file_name("app.wayrill.desktop");
            let lease = vault::lock_workspace(&base)?;
            app.manage(Arc::new(Store {
                base,
                legacy,
                serial: Mutex::new(()),
                _lease: lease,
            }));
            app.manage(simulation::Invitation::default());
            Ok(())
        })
        .on_window_event(simulation::window_event)
        .invoke_handler(tauri::generate_handler![
            pool_read,
            pool_accounts_read,
            export_json,
            pool_write,
            pool_folder,
            pool_inbox,
            pool_import,
            pool_discard,
            routing_source::routing_source_file,
            routing_source::routing_source_download,
            pool_publisher::pool_publish,
            pool_publisher::pool_validate_folder,
            simulation::pool_simulation_open,
            simulation::pool_simulation_invitation,
            simulation::pool_simulation_download,
            simulation::pool_simulation_route,
        ])
        .run(tauri::generate_context!())
        .expect("Could not start Wayrill Pool");
}
