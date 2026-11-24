//! Normal-user browser integration. Fixed bundled helper, no service activation.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use std::{os::windows::process::CommandExt, path::PathBuf, process::Command};
use tauri::{Emitter, Manager};
use wayrill_protocol::companion::RuleRequest;

#[derive(Clone, Serialize)]
pub struct PendingRule {
    id: u32,
    #[serde(flatten)]
    rule: RuleRequest,
}

#[derive(Default)]
struct Queue {
    next_id: u32,
    items: VecDeque<PendingRule>,
}

#[derive(Default)]
pub struct Requests(Mutex<Queue>);

impl Requests {
    pub fn finish_with(
        &self,
        id: u32,
        save: impl FnOnce(bool) -> Result<(), String>,
    ) -> Result<(), String> {
        let active = self.front(None)?.is_some_and(|request| request.id == id);
        save(active)?;
        self.front(Some(id))?;
        Ok(())
    }

    fn front(&self, completed: Option<u32>) -> Result<Option<PendingRule>, String> {
        let mut queue = self
            .0
            .lock()
            .map_err(|_| "Cannot read the Companion request.")?;
        if completed.is_some() && queue.items.front().map(|request| request.id) == completed {
            queue.items.pop_front();
        }
        Ok(queue.items.front().cloned())
    }
}

#[cfg(test)]
mod request_tests {
    use super::*;

    #[test]
    fn a_failed_save_keeps_the_request_and_success_retires_only_that_request() {
        let requests = Requests::default();
        let request = |id| PendingRule {
            id,
            rule: RuleRequest {
                host: "example.test".into(),
                filter_ids: vec![],
            },
        };
        requests
            .0
            .lock()
            .unwrap()
            .items
            .extend([request(1), request(2)]);
        assert!(requests
            .finish_with(1, |active| {
                assert!(active);
                Err("locked workspace".into())
            })
            .is_err());
        assert_eq!(requests.front(None).unwrap().unwrap().id, 1);

        requests
            .finish_with(1, |active| {
                assert!(active);
                Ok(())
            })
            .unwrap();
        requests
            .finish_with(1, |active| {
                assert!(!active);
                Ok(())
            })
            .unwrap();
        assert_eq!(requests.front(None).unwrap().unwrap().id, 2);
    }
}

pub fn receive(app: &tauri::AppHandle, args: &[String]) {
    let Some(raw) = args
        .windows(2)
        .find(|pair| pair[0] == "--companion-domain")
        .map(|pair| &pair[1])
    else {
        return;
    };
    let request = serde_json::from_str::<RuleRequest>(raw)
        .ok()
        .and_then(|r| r.normalized().ok());
    let Some(request) = request else {
        wayrill_diagnostics::log(
            "companion",
            "warn",
            "Rejected an invalid domain edit request.",
        );
        return;
    };
    let state = app.state::<Requests>();
    if let Ok(mut queue) = state.inner().0.lock() {
        if queue.items.len() < 16 && !queue.items.iter().any(|item| item.rule == request) {
            queue.next_id = queue.next_id.wrapping_add(1);
            let id = queue.next_id;
            queue.items.push_back(PendingRule { id, rule: request });
        }
    }
    let _ = app.emit("wayrill-companion-request", ());
}

#[tauri::command]
pub async fn companion_rule_request(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Arc<crate::VaultLock>>,
    completed: Option<u32>,
) -> Result<Option<PendingRule>, String> {
    let lock = lock.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Order peeks and dismissals with the protected workspace save.
        let _guard = lock.write.lock().map_err(|_| "Storage is busy.")?;
        app.state::<Requests>().front(completed)
    })
    .await
    .map_err(|_| "Companion request task failed.")?
}

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
                "edge" | "chrome" | "opera" | "brave" | "vivaldi" | "chromium" | "firefox"
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
