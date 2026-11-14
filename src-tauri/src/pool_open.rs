use std::{
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::Manager;

fn binary() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|_| "Cannot locate Wayrill.")?;
    let binary = current
        .parent()
        .ok_or("Cannot locate Wayrill.")?
        .join("Pool")
        .join("wayrill-pool.exe");
    if !binary.is_file() {
        return Err("Install the complete Wayrill bundle to open Wayrill Pool.".into());
    }
    Ok(binary)
}

fn launch(binary: PathBuf) -> Result<(), String> {
    Command::new(binary)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .map(|_| ())
        .map_err(|_| "Windows could not start Wayrill Pool.".into())
}

#[tauri::command]
pub async fn pool_open() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| launch(binary()?))
        .await
        .map_err(|_| "The Pool launcher stopped unexpectedly.")?
}

#[tauri::command]
pub async fn pool_send(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|_| "Cannot find Windows app data.")?
        .join(crate::pool_transfer::IDENTIFIER);
    tauri::async_runtime::spawn_blocking(move || {
        let binary = binary()?;
        crate::pool_transfer::stage(&base, &id, &text)?;
        launch(binary).map_err(|error| format!("{error} The export is in the Pool inbox."))
    })
    .await
    .map_err(|_| "The Pool export task ended unexpectedly.")?
}
