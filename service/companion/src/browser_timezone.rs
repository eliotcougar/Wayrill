use serde::Deserialize;
use serde_json::{json, Value};
use std::{os::windows::process::CommandExt, path::PathBuf, process::Command};
use wayrill_protocol::{ApiError, Result};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Set {
    pub policy: wayrill_protocol::companion::Policy,
    pub expected_revision: u64,
}
impl Set {
    pub fn validate(&self) -> Result<()> {
        self.policy.validate()
    }
}
fn helper() -> Result<PathBuf> {
    let own = std::env::current_exe().map_err(|e| ApiError::io("Locate native bridge", e))?;
    if let Some(path) = own
        .parent()
        .map(|p| p.join("timezone/wayrill-timezone.exe"))
        .filter(|p| p.is_file())
    {
        return Ok(path);
    }
    let program = std::env::var_os("ProgramW6432").or_else(|| std::env::var_os("ProgramFiles"));
    program
        .map(PathBuf::from)
        .map(|p| p.join("Wayrill/Service/timezone/wayrill-timezone.exe"))
        .filter(|p| p.is_file())
        .ok_or_else(|| {
            ApiError::new(
                "TIMEZONE_UNAVAILABLE",
                "Update Wayrill to use native browser timezones.",
            )
        })
}
fn native(args: &[&str]) -> Result<Value> {
    let output = Command::new(helper()?)
        .args(args)
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| ApiError::io("Run native timezone bridge", e))?;
    if !output.status.success() {
        return Err(ApiError::new("TIMEZONE_UNAVAILABLE", format!("Native browser timezone could not be applied (Windows error {}). Restart the browser and try again.", output.status.code().unwrap_or(-1))));
    }
    if output.stdout.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_slice(&output.stdout)
            .map_err(|_| ApiError::new("TIMEZONE_UNAVAILABLE", "Invalid native browser identity."))
    }
}
pub async fn request(method: &str, params: Value) -> Result<Value> {
    if method == "timezoneNotify" {
        return native(&["--notify"]);
    }
    let browser = native(&["--identify"])?;
    let (method, input) = if method == "timezoneSet" {
        let input: Set = wayrill_protocol::params(params)?;
        input.validate()?;
        (
            "companion.timezoneSet",
            json!({"browser":browser,"policy":input.policy,"expectedRevision":input.expected_revision}),
        )
    } else {
        ("companion.timezoneGet", json!({"browser":browser}))
    };
    // Saving intent is quick; native reconciliation runs independently. Keep
    // the response within the browser's deadline if the service is unavailable.
    let mut state = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        wayrill_ipc::windows::request(method, input),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            "TIMEZONE_UNAVAILABLE",
            "Wayrill is busy. The saved preference will be retried automatically.",
        )
    })??;
    // The service supervises applications even when Companion is absent.
    // This read-only query supports confirmation of the Off choice.
    if state["mode"] == "off" {
        state["systemZone"] = native(&["--system-zone"])?["systemZone"].clone();
    }
    Ok(state)
}
