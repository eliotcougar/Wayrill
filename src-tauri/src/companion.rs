//! Normal-user browser integration. Fixed bundled helper, no service activation.
use serde_json::Value;
use std::{os::windows::process::CommandExt, path::PathBuf, process::Command};

fn run(
    action: &str,
    extension: Option<&str>,
    target: Option<&str>,
    browser: Option<&str>,
) -> Result<Value, String> {
    if extension.is_some_and(|id| id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
    {
        return Err("Extension IDs must contain 32 lowercase letters from a to p.".into());
    }
    let base = std::env::current_exe()
        .map_err(|_| "Cannot locate Wayrill.")?
        .parent()
        .ok_or("Cannot locate Wayrill.")?
        .join("Service");
    let (helper, package) = if cfg!(debug_assertions) {
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        (
            project.join("service/scripts/Companion-Setup.ps1"),
            project.join(".tools/installer-service"),
        )
    } else {
        (base.join("scripts/Companion-Setup.ps1"), base)
    };
    if !helper.is_file() {
        return Err("Companion setup is unavailable. Repair the Wayrill installation.".into());
    }
    let powershell =
        PathBuf::from(std::env::var_os("WINDIR").ok_or("Windows directory is unavailable.")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(powershell);
    command
        .creation_flags(0x08000000)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(helper)
        .args(["-Action", action, "-PackageRoot"])
        .arg(package);
    if let Some(id) = extension {
        command.args(["-ExtensionId", id]);
    }
    if let Some(target) = target {
        command.args(["-Target", target]);
    }
    if let Some(browser) = browser {
        command.args(["-Browser", browser]);
    }
    let output = command
        .output()
        .map_err(|_| "Cannot start Companion setup.")?;
    if output.stdout.len() > 512 * 1024 {
        return Err("Companion setup returned an oversized response.".into());
    }
    let reply: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Companion setup failed to return a readable result.")?;
    if reply["ok"] != true || !output.status.success() {
        return Err(reply["error"]
            .as_str()
            .unwrap_or("Companion setup failed.")
            .into());
    }
    Ok(reply["result"].clone())
}
#[tauri::command]
pub async fn companion_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| run("Status", None, None, None))
        .await
        .map_err(|_| "Companion setup task failed.")?
}
#[tauri::command]
pub async fn companion_register(extension_id: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run("Register", extension_id.as_deref(), None, None)
    })
    .await
    .map_err(|_| "Companion setup task failed.")?
}
#[tauri::command]
pub async fn companion_unregister() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| run("Unregister", None, None, None))
        .await
        .map_err(|_| "Companion setup task failed.")?
}
#[tauri::command]
pub async fn companion_open(target: String, browser: Option<String>) -> Result<(), String> {
    if !matches!(target.as_str(), "folder" | "browser")
        || browser.as_ref().is_some_and(|b| {
            !matches!(
                b.as_str(),
                "edge" | "chrome" | "opera" | "brave" | "vivaldi" | "chromium"
            )
        })
    {
        return Err("Unknown Companion setup destination.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run("Open", None, Some(&target), browser.as_deref())
    })
    .await
    .map_err(|_| "Companion setup task failed.")??;
    Ok(())
}
