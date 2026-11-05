use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
};

#[tauri::command]
pub async fn aquifer_open() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = std::env::current_exe().map_err(|_| "Cannot locate Wayrill.")?;
        let binary = current.parent().ok_or("Cannot locate Wayrill.")?
            .join("Aquifer").join("wayrill-aquifer.exe");
        if !binary.is_file() {
            return Err("Wayrill Aquifer is not included in this installation. Install the complete Wayrill bundle.".to_owned());
        }
        Command::new(binary).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(0x08000000).spawn()
            .map(|_| ()).map_err(|_| "Windows could not start Wayrill Aquifer.".to_owned())
    }).await.map_err(|_| "The Aquifer launcher stopped unexpectedly.".to_owned())?
}
