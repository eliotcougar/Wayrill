//! Boot auto-start policy and the validated pre-sign-in runtime identity.
pub mod session;
use crate::storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use wayrill_protocol::{ApiError, Result};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    owner_sid: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub enabled: bool,
    pub expected_revision: u64,
}
pub struct Startup {
    path: PathBuf,
    settings: Settings,
    last_attempt_ms: Option<u64>,
    last_error: Option<ApiError>,
    attempts: u32,
}
impl Startup {
    pub fn new(owner: &str, path: PathBuf) -> Result<Self> {
        let settings = storage::read::<Settings>(&path)?.unwrap_or(Settings {
            owner_sid: owner.into(),
            enabled: false,
        });
        if settings.owner_sid != owner {
            return Err(ApiError::new(
                "OWNER_MISMATCH",
                "Startup settings belong to another installation owner.",
            ));
        }
        Ok(Self {
            path,
            settings,
            last_attempt_ms: None,
            last_error: None,
            attempts: 0,
        })
    }
    pub fn requests_boot_start(&self, new_session: bool, upgrading: bool) -> bool {
        self.enabled() && new_session && !upgrading
    }
    pub fn enabled(&self) -> bool {
        self.settings.enabled
    }
    pub fn set(&mut self, enabled: bool) -> Result<()> {
        let settings = Settings {
            owner_sid: self.settings.owner_sid.clone(),
            enabled,
        };
        storage::write(&self.path, &settings)?;
        self.settings = settings;
        Ok(())
    }
    pub fn attempted(&mut self, result: &Result<()>) {
        self.last_attempt_ms = Some(crate::traffic::timestamp_ms());
        self.last_error = result.as_ref().err().cloned();
        self.attempts = self.attempts.saturating_add(1);
        self.save_result();
    }
    fn save_result(&self) {
        if let Err(error) = storage::write(
            &self.path.with_file_name("startup-result.json"),
            &self.snapshot(false),
        ) {
            crate::diagnostics::error!("Save startup diagnostic: {}", error.message);
        }
    }
    pub fn snapshot(&self, waiting: bool) -> Value {
        json!({"enabled":self.enabled(),"runtimeAccount":"LocalService","lastAttemptMs":self.last_attempt_ms,"lastError":self.last_error,"waitingForNetwork":waiting,"attempts":self.attempts})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "S-1-5-21-1-2-3-1001";
    fn fixture() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "wayrill-startup-{}-{}-{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn absent_settings_are_off_and_explicit_changes_survive_restart() {
        let dir = fixture();
        let path = dir.join("startup.json");
        let mut prefs = Startup::new(OWNER, path.clone()).unwrap();
        assert!(!prefs.enabled());
        assert!(!path.exists());
        prefs.set(true).unwrap();
        assert!(Startup::new(OWNER, path.clone()).unwrap().enabled());
        prefs.set(false).unwrap();
        assert!(!Startup::new(OWNER, path).unwrap().enabled());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn a_failed_commit_does_not_enable_startup() {
        let dir = fixture();
        let mut prefs = Startup::new(OWNER, dir.join("missing/startup.json")).unwrap();
        assert!(prefs.set(true).is_err());
        assert!(!prefs.enabled());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn owner_and_strict_request_boundaries_are_enforced() {
        let dir = fixture();
        let path = dir.join("startup.json");
        Startup::new(OWNER, path.clone())
            .unwrap()
            .set(true)
            .unwrap();
        assert_eq!(
            Startup::new("S-1-5-21-1-2-3-1002", path)
                .err()
                .unwrap()
                .code,
            "OWNER_MISMATCH"
        );
        for input in [
            json!({"enabled":true}),
            json!({"enabled":"true","expectedRevision":1}),
            json!({"enabled":true,"expectedRevision":1,"command":"bad"}),
        ] {
            assert!(serde_json::from_value::<Change>(input).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn boot_failure_is_visible_and_never_disables_the_users_preference() {
        let dir = fixture();
        let mut prefs = Startup::new(OWNER, dir.join("startup.json")).unwrap();
        prefs.set(true).unwrap();
        prefs.attempted(&Err(ApiError::new("PORT_IN_USE", "Occupied")));
        assert!(prefs.enabled());
        assert_eq!(prefs.snapshot(false)["lastError"]["code"], "PORT_IN_USE");
        prefs.attempted(&Ok(()));
        assert!(prefs.snapshot(false)["lastError"].is_null());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn boot_preference_rearms_after_windows_restart_but_not_service_restart_or_upgrade() {
        let dir = fixture();
        let mut prefs = Startup::new(OWNER, dir.join("startup.json")).unwrap();
        assert!(!prefs.requests_boot_start(true, false));
        prefs.set(true).unwrap();
        assert!(prefs.requests_boot_start(true, false));
        assert!(!prefs.requests_boot_start(false, false));
        assert!(!prefs.requests_boot_start(true, true));
        assert!(!prefs.requests_boot_start(false, true));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
