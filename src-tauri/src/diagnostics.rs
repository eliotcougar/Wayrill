use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tauri::Manager;

fn directory(app: &tauri::AppHandle, source: &str) -> Result<PathBuf, String> {
    match source {
        "service" | "sharing" => Ok(wayrill_diagnostics::service_directory()),
        "desktop" => app
            .path()
            .app_local_data_dir()
            .map(|p| p.join("Logs"))
            .map_err(|e| e.to_string()),
        _ => Err("Unknown log source.".into()),
    }
}
pub fn initialize(app: &tauri::AppHandle) {
    if let Ok(path) = directory(app, "desktop") {
        let result = fs::create_dir_all(&path)
            .and_then(|()| wayrill_diagnostics::initialize(&path, "desktop"));
        if let Err(error) = result {
            eprintln!("Desktop logging unavailable: {error}");
        }
    }
    wayrill_diagnostics::panic_hook("desktop");
}
#[tauri::command]
pub async fn diagnostics_read(
    app: tauri::AppHandle,
    retained: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        wayrill_diagnostics::flush();
        let mut sources = Vec::new();
        for source in ["service", "sharing", "desktop"] {
            let folder = directory(&app, source)?;
            let mut text = String::new();
            let mut error = None;
            // Newest retained copy plus current file; bounded even for a corrupt
            // oversized file. Missing files are normal before a component runs.
            for copy in (0..if retained == Some(true) {
                wayrill_diagnostics::COPIES
            } else {
                2
            })
                .rev()
            {
                let path = folder.join(wayrill_diagnostics::filename(source, copy));
                match wayrill_diagnostics::tail(
                    &path,
                    if retained == Some(true) {
                        wayrill_diagnostics::FILE_BYTES as usize
                    } else {
                        128 * 1024
                    },
                ) {
                    Ok(tail) => text.push_str(&tail),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => error = Some(e.to_string()),
                }
            }
            sources.push(json!({"source":source,"folder":folder,"text":text,"error":error}));
        }
        Ok(json!({"sources":sources}))
    })
    .await
    .map_err(|_| "Log reader failed.".to_owned())?
}
#[tauri::command]
pub fn diagnostics_open(app: tauri::AppHandle, source: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let folder = directory(&app, &source)?;
    if !folder.is_dir() {
        return Err("This component has not created its log folder yet.".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(folder)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn diagnostics_record(message: String) {
    wayrill_diagnostics::log("renderer", "error", &message);
}
