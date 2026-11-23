//! A service-owned restart barrier. WFP policy outlives every routing process.
mod packages;
mod versions;
mod wfp;
use crate::{storage, system_settings::version};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};

const MAX_TARGETS: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    Executable { value: String },
    Package { value: String },
}
impl Target {
    fn value(&self) -> &str {
        match self {
            Self::Executable { value } | Self::Package { value } => value,
        }
    }
}
#[derive(Clone, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub applications: Vec<Target>,
}
impl Config {
    pub(crate) fn validate(&mut self) -> Result<()> {
        if self.applications.len() > 256 || self.enabled && self.applications.is_empty() {
            return Err(invalid("Choose between 1 and 256 applications to protect."));
        }
        for target in &self.applications {
            let value = target.value();
            let valid =
                !value.is_empty() && value.len() <= 32767 && !value.chars().any(char::is_control);
            let valid = valid
                && match target {
                    Target::Executable { .. } => {
                        let bytes = value.as_bytes();
                        bytes.len() > 3
                            && bytes[0].is_ascii_alphabetic()
                            && bytes[1] == b':'
                            && bytes[2] == b'\\'
                            && value.to_ascii_lowercase().ends_with(".exe")
                            && !value.contains(['*', '?', '"', '/'])
                            && !value.split('\\').any(|s| matches!(s, "." | ".."))
                    }
                    Target::Package { .. } => {
                        value.len() <= 255
                            && value.contains('_')
                            && value
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                    }
                };
            if !valid {
                return Err(invalid(
                    "Choose a full executable path or a Windows package family.",
                ));
            }
        }
        self.applications.sort_by_key(|t| {
            (
                matches!(t, Target::Package { .. }),
                t.value().to_lowercase(),
            )
        });
        self.applications.dedup_by(|a, b| {
            std::mem::discriminant(a) == std::mem::discriminant(b)
                && a.value().eq_ignore_ascii_case(b.value())
        });
        Ok(())
    }
}
fn invalid(message: &str) -> ApiError {
    ApiError::new("INVALID_PARAMS", message)
}

fn too_many_targets() -> ApiError {
    ApiError::new(
        "APP_PROTECTION",
        "Too many protected executable and package identities.",
    )
}

fn normalize_targets(targets: &mut Vec<Target>) -> Result<()> {
    targets.sort_by_cached_key(|target| {
        (
            matches!(target, Target::Package { .. }),
            target.value().to_ascii_lowercase(),
        )
    });
    targets.dedup_by(|a, b| {
        std::mem::discriminant(a) == std::mem::discriminant(b)
            && a.value().eq_ignore_ascii_case(b.value())
    });
    if targets.len() > MAX_TARGETS {
        return Err(too_many_targets());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Clearing,
    Restart,
    Recovery,
    Upgrade,
}

impl Phase {
    fn armed(self) -> bool {
        matches!(self, Self::Restart | Self::Recovery | Self::Upgrade)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    owner_sid: String,
    config: Config,
    #[serde(default, skip_serializing_if = "pool_empty")]
    pool: Config,
    phase: Phase,
    #[serde(default)]
    targets: Vec<Target>,
}

fn pool_empty(config: &Config) -> bool {
    !config.enabled && config.applications.is_empty()
}

impl State {
    fn enabled(&self) -> bool {
        self.config.enabled || self.pool.enabled
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Set {
    expected_version: String,
    config: Config,
}

pub trait Backend {
    fn package_executables(&self, applications: &[Target]) -> Result<Vec<Target>>;
    fn validate(&self, applications: &[Target]) -> Result<()>;
    fn replace(&self, applications: &[Target]) -> Result<()>;
}
pub struct Windows;
impl Backend for Windows {
    fn package_executables(&self, applications: &[Target]) -> Result<Vec<Target>> {
        packages::executables(applications)
    }
    fn validate(&self, applications: &[Target]) -> Result<()> {
        wfp::validate(applications)
    }
    fn replace(&self, applications: &[Target]) -> Result<()> {
        wfp::replace(applications)
    }
}

fn resolve(backend: &impl Backend, applications: &[Target]) -> Result<versions::Resolved> {
    let mut result = versions::resolve(applications)?;
    result
        .targets
        .extend(backend.package_executables(applications)?);
    normalize_targets(&mut result.targets)?;
    Ok(result)
}
pub struct Manager<B = Windows> {
    path: PathBuf,
    state: State,
    error: Option<ApiError>,
    retry_at: Option<Instant>,
    refresh_at: Instant,
    backend: B,
}
impl Manager<Windows> {
    pub fn open(owner: &str, path: PathBuf) -> Result<Self> {
        Self::open_with(owner, path, Windows)
    }
}
impl<B: Backend> Manager<B> {
    fn open_with(owner: &str, path: PathBuf, backend: B) -> Result<Self> {
        let mut state = storage::read::<State>(&path)?.unwrap_or(State {
            owner_sid: owner.into(),
            config: Config::default(),
            pool: Config::default(),
            phase: Phase::Idle,
            targets: Vec::new(),
        });
        if state.owner_sid != owner {
            return Err(ApiError::new(
                "OWNER_MISMATCH",
                "App protection belongs to another installation owner.",
            ));
        }
        state.config.validate()?;
        state.pool.validate()?;
        // Upgrade pause belongs only to the retiring service. A new instance
        // adopts the same durable barrier while its normal recovery runs.
        if state.phase == Phase::Upgrade {
            state.phase = Phase::Recovery;
            storage::write(&path, &state)?;
        }
        let mut manager = Self {
            path,
            state,
            error: None,
            retry_at: None,
            refresh_at: Instant::now() + Duration::from_secs(30),
            backend,
        };
        let _ = manager.sync();
        Ok(manager)
    }
    pub fn snapshot(&self) -> Value {
        json!({"version":version(&self.state.config), "config":self.state.config,
            "poolApplicationCount":self.state.pool.applications.len(),
            "phase":self.state.phase,"blocked":self.armed() && self.error.is_none(),
            "error":self.error})
    }
    pub fn summary(&self) -> Value {
        json!({"enabled":self.enabled(),"applicationCount":self.state.config.applications.len(),
            "poolApplicationCount":self.state.pool.applications.len(),
            "phase":self.state.phase,"blocked":self.armed() && self.error.is_none(),"error":self.error})
    }
    pub fn upgrading(&self) -> bool {
        self.state.phase == Phase::Upgrade
    }
    pub fn armed(&self) -> bool {
        self.state.phase.armed()
    }
    pub fn enabled(&self) -> bool {
        self.state.enabled()
    }
    pub fn set(&mut self, request: Set, base: &Path) -> Result<Value> {
        if request.expected_version != version(&self.state.config) {
            return Err(ApiError::new(
                "REVISION_CONFLICT",
                "App protection changed. Refresh before saving.",
            ));
        }
        let mut config = request.config;
        config.validate()?;
        if self.armed() && (config.enabled || self.state.pool.enabled) {
            return Err(ApiError::new("BUSY", "Routing is recovering. Disable protection to release its applications, or wait before changing the list."));
        }
        let mut next = self.state.clone();
        next.config = config;
        self.update_config(next, base)?;
        Ok(self.snapshot())
    }
    pub fn set_pool(&mut self, mut config: Config, base: &Path) -> Result<bool> {
        config.validate()?;
        if self.state.pool == config {
            return Ok(false);
        }
        if self.armed() {
            return Err(ApiError::new(
                "BUSY",
                "Wait for routing recovery to finish before changing Pool protection.",
            ));
        }
        let mut next = self.state.clone();
        next.pool = config;
        self.update_config(next, base)?;
        Ok(true)
    }
    fn update_config(&mut self, mut next: State, base: &Path) -> Result<()> {
        let targets = if next.enabled() {
            self.resolve_targets(&mut next)?
        } else {
            Vec::new()
        };
        let base = format!(
            "{}\\",
            base.to_string_lossy().trim_end_matches('\\').to_lowercase()
        );
        for target in next
            .config
            .applications
            .iter()
            .chain(&next.pool.applications)
            .chain(&targets)
        {
            if let Target::Executable { value } = target {
                // Blocking a routing helper would prevent recovery itself.
                if value.to_lowercase().starts_with(&base) {
                    return Err(invalid("Wayrill's service and routing components cannot be protected applications."));
                }
            }
        }
        self.backend.validate(&targets)?;
        next.targets = targets;
        if !next.enabled() && next.phase.armed() {
            next.phase = Phase::Clearing;
        }
        self.save(next)?;
        if !self.enabled() {
            self.sync()?;
        }
        Ok(())
    }
    fn save(&mut self, state: State) -> Result<()> {
        storage::write(&self.path, &state)?;
        self.state = state;
        Ok(())
    }
    pub fn arm(&mut self, phase: Phase) -> Result<()> {
        if !self.enabled() {
            return Ok(());
        }
        let previous = self.state.clone();
        if !self.armed() || phase == Phase::Upgrade {
            self.save(State {
                phase,
                ..self.state.clone()
            })?;
        }
        if let Err(error) = self.sync() {
            // Native replacement is transactional: a failed arm has not changed
            // the prior barrier. Do not leave an intact runtime locked as an
            // upgrade that never began. Preserve write-ahead intent if restoring
            // the journal itself fails.
            return Err(crate::lifecycle::Cleanup::after_failure(
                error,
                "restore app-protection phase",
                self.save(previous),
            ));
        }
        Ok(())
    }
    pub fn release(&mut self) -> Result<()> {
        // Write-ahead intent: an interrupted explicit release is retried at
        // startup, while an interrupted arm never disappears with a process.
        if self.armed() {
            self.save(State {
                phase: Phase::Clearing,
                ..self.state.clone()
            })?;
        }
        self.sync()
    }
    pub fn ready(&mut self) -> Result<()> {
        self.release()
    }
    pub fn reconcile(&mut self, now: Instant) -> bool {
        // Complete pending firewall work before refreshing installation data.
        // Discovery failures must never postpone an already-requested clear.
        if self.state.phase == Phase::Clearing || self.retry_at.is_some() {
            if self.retry_at.is_some_and(|at| now < at) {
                return false;
            }
            let _ = self.sync_at(now);
            return true;
        }
        if !self.enabled() || now < self.refresh_at {
            return false;
        }
        self.refresh_at = now + Duration::from_secs(30);
        let result = match self.refresh_targets() {
            Ok(true) if self.armed() => self.backend.replace(&self.state.targets),
            Ok(false) if self.error.is_none() => return false,
            Ok(_) => Ok(()),
            Err(error) => {
                if self.armed() {
                    self.retry_at = Some(now + Duration::from_secs(30));
                }
                self.error = Some(error);
                return true;
            }
        };
        let _ = self.record_result(result, now);
        true
    }
    fn sync(&mut self) -> Result<()> {
        self.sync_at(Instant::now())
    }
    fn sync_at(&mut self, now: Instant) -> Result<()> {
        // Releasing protection must remain possible even if an installation or
        // drive has disappeared. Discovery is a prerequisite only for arming.
        let result = if self.armed() && self.enabled() {
            self.refresh_targets()
                .and_then(|_| self.backend.replace(&self.state.targets))
        } else {
            self.backend.replace(&[]).and_then(|()| self.finish_clear())
        };
        self.record_result(result, now)
    }
    fn finish_clear(&mut self) -> Result<()> {
        if self.state.phase != Phase::Clearing {
            return Ok(());
        }
        self.save(State {
            phase: Phase::Idle,
            ..self.state.clone()
        })
    }
    fn refresh_targets(&mut self) -> Result<bool> {
        let mut next = self.state.clone();
        let mut targets = self.resolve_targets(&mut next)?;
        if self.armed() {
            targets.extend(self.state.targets.iter().cloned());
            normalize_targets(&mut targets)?;
        }
        next.targets = targets;
        if next == self.state {
            return Ok(false);
        }
        self.save(next)?;
        Ok(true)
    }
    fn resolve_targets(&self, state: &mut State) -> Result<Vec<Target>> {
        let mut targets = Vec::new();
        if state.config.enabled {
            let resolved = resolve(&self.backend, &state.config.applications)?;
            state.config.applications = resolved.applications;
            state.config.validate()?;
            targets.extend(resolved.targets);
        }
        if state.pool.enabled {
            targets.extend(resolve(&self.backend, &state.pool.applications)?.targets);
        }
        normalize_targets(&mut targets)?;
        Ok(targets)
    }
    fn record_result(&mut self, result: Result<()>, now: Instant) -> Result<()> {
        self.error = result.as_ref().err().cloned();
        // Windows can temporarily refuse a policy change. Retry the durable
        // phase on the serialized service tick, including a failed explicit
        // release, without rewriting a healthy barrier or reviving old intent.
        self.retry_at = self
            .error
            .as_ref()
            .filter(|error| error.retryable || self.state.phase != Phase::Idle)
            .map(|_| now + Duration::from_secs(30));
        result
    }
}

pub fn clear_installed() -> Result<()> {
    let path = PathBuf::from(
        std::env::var_os("ProgramData")
            .ok_or_else(|| invalid("Windows ProgramData is unavailable."))?,
    )
    .join("Wayrill/app-protection.json");
    // Explicit elevated removal remains usable even when saved settings are
    // damaged and the service cannot initialize. Never discard their evidence.
    wfp::replace(&[])?;
    match storage::read::<State>(&path) {
        Ok(Some(mut state)) => {
            state.phase = Phase::Idle;
            storage::write(&path, &state)
        }
        Ok(None) => Ok(()),
        Err(_) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            std::fs::rename(
                &path,
                path.with_file_name(format!("app-protection-invalid-{stamp}.json")),
            )
            .map_err(|e| ApiError::io("Preserve damaged app-protection settings", e))
        }
    }
}

pub fn prepare_installed_upgrade() -> Result<()> {
    // Installer-only bridge for an older coordinator whose failed arm left its
    // upgrade phase recorded. The installer verifies that state before it uses
    // explicit retirement; it never stops routing without a successful barrier.
    let path = PathBuf::from(
        std::env::var_os("ProgramData")
            .ok_or_else(|| invalid("Windows ProgramData is unavailable."))?,
    )
    .join("Wayrill/app-protection.json");
    let state = storage::read::<State>(&path)?
        .ok_or_else(|| invalid("App-protection settings are missing."))?;
    if state.phase != Phase::Upgrade || !state.enabled() {
        return Err(invalid(
            "The retiring service has not requested an app-protection upgrade barrier.",
        ));
    }
    let mut targets = state.targets;
    for mut config in [state.config, state.pool] {
        config.validate()?;
        if config.enabled {
            targets.extend(resolve(&Windows, &config.applications)?.targets);
        }
    }
    normalize_targets(&mut targets)?;
    wfp::replace(&targets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
        sync::atomic::{AtomicU64, Ordering},
    };
    #[derive(Clone, Default)]
    struct Fake(
        Rc<RefCell<(Vec<Target>, bool, usize)>>,
        Rc<RefCell<Vec<Target>>>,
        Rc<Cell<bool>>,
    );
    impl Backend for Fake {
        fn package_executables(&self, applications: &[Target]) -> Result<Vec<Target>> {
            if !applications
                .iter()
                .any(|target| matches!(target, Target::Package { .. }))
            {
                return Ok(Vec::new());
            }
            if self.2.get() {
                return Err(ApiError::new(
                    "APP_PROTECTION",
                    "Package inventory unavailable",
                ));
            }
            Ok(self.1.borrow().clone())
        }
        fn validate(&self, _: &[Target]) -> Result<()> {
            Ok(())
        }
        fn replace(&self, applications: &[Target]) -> Result<()> {
            let mut state = self.0.borrow_mut();
            state.2 += 1;
            if std::mem::take(&mut state.1) {
                let mut error = ApiError::new("APP_PROTECTION", "simulated native failure");
                error.retryable = true;
                return Err(error);
            }
            state.0 = applications.to_vec();
            Ok(())
        }
    }
    fn path() -> PathBuf {
        static ID: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "wayrill-protection-{}-{}.json",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn configured(path: &Path, backend: Fake) -> Manager<Fake> {
        let mut manager = Manager::open_with("owner", path.to_owned(), backend).unwrap();
        manager
            .set(
                Set {
                    expected_version: version(&manager.state.config),
                    config: Config {
                        enabled: true,
                        applications: vec![Target::Executable {
                            value: "C:\\Apps\\browser.exe".into(),
                        }],
                    },
                },
                Path::new("C:\\Wayrill"),
            )
            .unwrap();
        manager
    }
    #[test]
    fn pool_protection_survives_restart_and_withdrawing_it_preserves_local_targets() {
        let path = path();
        let native = Fake::default();
        let base = Path::new("C:\\Wayrill");
        let mut manager = configured(&path, native.clone());
        let local_version = manager.snapshot()["version"].clone();
        let pool = Config {
            enabled: true,
            applications: vec![Target::Package {
                value: "Example.App_123456789abcd".into(),
            }],
        };
        manager.set_pool(pool, base).unwrap();
        manager.arm(Phase::Upgrade).unwrap();
        drop(manager);
        let mut manager = Manager::open_with("owner", path.clone(), native.clone()).unwrap();
        assert_eq!(native.0.borrow().0.len(), 2);
        assert!(manager.set_pool(Config::default(), base).is_err());
        assert_eq!(native.0.borrow().0.len(), 2);
        manager.ready().unwrap();
        manager.set_pool(Config::default(), base).unwrap();
        assert_eq!(manager.snapshot()["version"], local_version);
        manager.arm(Phase::Restart).unwrap();
        assert_eq!(native.0.borrow().0, manager.state.config.applications);
        manager.ready().unwrap();
        storage::remove(&path).unwrap();
    }
    #[test]
    fn upgrade_barrier_survives_a_new_service_and_only_readiness_releases_it() {
        let path = path();
        let native = Fake::default();
        let mut manager = configured(&path, native.clone());
        manager.arm(Phase::Upgrade).unwrap();
        assert_eq!(native.0.borrow().0.len(), 1);
        assert_eq!(
            storage::read::<State>(&path).unwrap().unwrap().phase,
            Phase::Upgrade
        );
        drop(manager);
        let mut replacement = Manager::open_with("owner", path.clone(), native.clone()).unwrap();
        assert_eq!(replacement.state.phase, Phase::Recovery);
        assert!(!replacement.upgrading());
        replacement.arm(Phase::Restart).unwrap();
        assert_eq!(native.0.borrow().0.len(), 1);
        replacement.ready().unwrap();
        assert!(native.0.borrow().0.is_empty());
        assert_eq!(
            storage::read::<State>(&path).unwrap().unwrap().phase,
            Phase::Idle
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn package_policy_covers_new_installations_and_survives_service_handoff() {
        let path = path();
        let native = Fake::default();
        let executable = |value: &str| Target::Executable {
            value: value.into(),
        };
        let old = executable(r"C:\Packages\old\helper.exe");
        let new = executable(r"C:\Packages\new\helper.exe");
        let package = Target::Package {
            value: "Example.Desktop_publisher".into(),
        };
        *native.1.borrow_mut() = vec![old.clone()];
        let mut manager = Manager::open_with("owner", path.clone(), native.clone()).unwrap();
        manager
            .set(
                Set {
                    expected_version: version(&manager.state.config),
                    config: Config {
                        enabled: true,
                        applications: vec![package.clone()],
                    },
                },
                Path::new(r"C:\Wayrill"),
            )
            .unwrap();
        manager.arm(Phase::Upgrade).unwrap();
        assert_eq!(native.0.borrow().0, vec![old.clone(), package.clone()]);

        *native.1.borrow_mut() = vec![new.clone()];
        drop(manager);
        let mut manager = Manager::open_with("owner", path.clone(), native.clone()).unwrap();
        assert_eq!(native.0.borrow().0, vec![new, old, package.clone()]);
        assert_eq!(manager.state.config.applications, vec![package]);
        manager.ready().unwrap();
        assert!(native.0.borrow().0.is_empty());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn native_failure_cannot_erase_recovery_intent_or_existing_policy() {
        let path = path();
        let native = Fake::default();
        let mut manager = configured(&path, native.clone());
        native.0.borrow_mut().1 = true;
        assert!(manager.arm(Phase::Restart).is_err());
        assert_eq!(
            storage::read::<State>(&path).unwrap().unwrap().phase,
            Phase::Idle
        );
        manager.arm(Phase::Recovery).unwrap();
        native.0.borrow_mut().1 = true;
        assert!(manager.release().is_err());
        assert_eq!(native.0.borrow().0.len(), 1);
        assert!(manager.snapshot()["error"].is_object());
        assert_eq!(manager.snapshot()["phase"], "clearing");
        assert_eq!(
            storage::read::<State>(&path).unwrap().unwrap().phase,
            Phase::Clearing
        );
        drop(manager);
        let manager = Manager::open_with("owner", path.clone(), native.clone()).unwrap();
        assert!(native.0.borrow().0.is_empty());
        assert_eq!(manager.snapshot()["phase"], "idle");
        assert!(manager.error.is_none());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn failed_disable_is_retried_without_rearming_after_the_list_changes() {
        let path = path();
        let native = Fake::default();
        let mut manager = configured(&path, native.clone());
        manager.arm(Phase::Restart).unwrap();
        native.0.borrow_mut().1 = true;
        assert!(manager
            .set(
                Set {
                    expected_version: version(&manager.state.config),
                    config: Config {
                        enabled: false,
                        ..manager.state.config.clone()
                    },
                },
                Path::new("C:\\Wayrill"),
            )
            .is_err());
        assert_eq!(native.0.borrow().0.len(), 1);
        let saved = storage::read::<State>(&path).unwrap().unwrap();
        assert!(!saved.config.enabled);
        assert_eq!(saved.phase, Phase::Clearing);
        let retry_at = manager.retry_at.unwrap();
        let calls = native.0.borrow().2;
        assert!(!manager.reconcile(retry_at - Duration::from_millis(1)));
        assert_eq!(native.0.borrow().2, calls);

        // Re-enabling a changed list configures the next restart barrier; it
        // must not turn a pending removal into a block of the new applications.
        manager
            .set(
                Set {
                    expected_version: version(&manager.state.config),
                    config: Config {
                        enabled: true,
                        applications: vec![Target::Package {
                            value: "Example.App_123456789abcd".into(),
                        }],
                    },
                },
                Path::new("C:\\Wayrill"),
            )
            .unwrap();
        manager.refresh_at = retry_at;
        native.2.set(true);
        assert!(manager.reconcile(retry_at));
        assert!(native.0.borrow().0.is_empty());
        assert!(manager.error.is_none());
        native.2.set(false);
        assert_eq!(manager.state.phase, Phase::Idle);
        assert!(manager.state.config.enabled);
        let calls = native.0.borrow().2;
        assert!(!manager.reconcile(retry_at + Duration::from_secs(60)));
        assert_eq!(native.0.borrow().2, calls);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn reconciliation_keeps_the_upgrade_barrier_and_bounds_failed_retries() {
        let path = path();
        let native = Fake::default();
        let mut manager = configured(&path, native.clone());
        manager.arm(Phase::Restart).unwrap();
        native.0.borrow_mut().1 = true;
        assert!(manager.arm(Phase::Upgrade).is_err());
        assert!(!manager.upgrading());
        let retry_at = manager.retry_at.unwrap();
        native.0.borrow_mut().1 = true;
        assert!(manager.reconcile(retry_at));
        assert!(manager.error.is_some());
        assert_eq!(manager.retry_at, Some(retry_at + Duration::from_secs(30)));
        let calls = native.0.borrow().2;
        assert!(!manager.reconcile(retry_at + Duration::from_secs(1)));
        assert_eq!(native.0.borrow().2, calls);
        assert!(manager.reconcile(retry_at + Duration::from_secs(30)));
        assert!(manager.error.is_none());
        assert_eq!(native.0.borrow().0, manager.state.config.applications);
        assert_eq!(manager.state.phase, Phase::Restart);
        assert_eq!(
            storage::read::<State>(&path).unwrap().unwrap().phase,
            Phase::Restart
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn active_list_and_stale_saves_are_rejected_but_explicit_disable_works() {
        let path = path();
        let native = Fake::default();
        let mut manager = configured(&path, native.clone());
        manager.arm(Phase::Restart).unwrap();
        let config = manager.state.config.clone();
        assert_eq!(
            manager
                .set(
                    Set {
                        expected_version: "stale".into(),
                        config: config.clone()
                    },
                    Path::new("C:\\Wayrill")
                )
                .unwrap_err()
                .code,
            "REVISION_CONFLICT"
        );
        assert_eq!(
            manager
                .set(
                    Set {
                        expected_version: version(&config),
                        config: config.clone()
                    },
                    Path::new("C:\\Wayrill")
                )
                .unwrap_err()
                .code,
            "BUSY"
        );
        manager
            .set(
                Set {
                    expected_version: version(&config),
                    config: Config {
                        enabled: false,
                        ..config
                    },
                },
                Path::new("C:\\Wayrill"),
            )
            .unwrap();
        assert!(native.0.borrow().0.is_empty());
        assert_eq!(manager.state.phase, Phase::Idle);
        assert!(Manager::open_with("other-owner", path.clone(), native).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn installed_versions_refresh_without_rewriting_an_idle_barrier_and_persist_across_upgrade() {
        let path = path();
        let root = path.with_extension("versions");
        let old = root.join("app-1.0.0").join("browser.exe");
        let new = root.join("app-1.1.0").join("browser.exe");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"old").unwrap();
        let native = Fake::default();
        let mut manager = Manager::open_with("owner", path.clone(), native.clone()).unwrap();
        manager
            .set(
                Set {
                    expected_version: version(&manager.state.config),
                    config: Config {
                        enabled: true,
                        applications: vec![Target::Executable {
                            value: old.to_string_lossy().into_owned(),
                        }],
                    },
                },
                Path::new("C:\\Wayrill"),
            )
            .unwrap();
        let calls = native.0.borrow().2;
        std::fs::create_dir_all(new.parent().unwrap()).unwrap();
        std::fs::write(&new, b"new").unwrap();
        assert!(manager.reconcile(manager.refresh_at));
        assert_eq!(
            manager.state.config.applications[0].value(),
            new.to_string_lossy()
        );
        assert_eq!(
            native.0.borrow().2,
            calls,
            "idle discovery must not rewrite WFP"
        );
        assert!(
            !manager.reconcile(manager.refresh_at),
            "unchanged versions must be quiet"
        );
        manager.arm(Phase::Upgrade).unwrap();
        assert_eq!(
            native.0.borrow().0.len(),
            2,
            "old and new versions must both be blocked"
        );
        std::fs::remove_dir_all(old.parent().unwrap()).unwrap();
        manager.reconcile(manager.refresh_at);
        assert_eq!(
            native.0.borrow().0.len(),
            2,
            "an armed transition retains the old identity"
        );
        drop(manager);
        let mut replacement = Manager::open_with("owner", path.clone(), native.clone()).unwrap();
        assert_eq!(native.0.borrow().0.len(), 2);
        assert_eq!(
            replacement.state.config.applications[0].value(),
            new.to_string_lossy()
        );
        replacement.ready().unwrap();
        assert!(native.0.borrow().0.is_empty());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn selectors_are_exact_and_deduplicated() {
        let mut config = Config {
            enabled: true,
            applications: vec![
                Target::Executable {
                    value: "C:\\Apps\\a.exe".into(),
                },
                Target::Executable {
                    value: "c:\\apps\\A.EXE".into(),
                },
                Target::Package {
                    value: "OpenAI.Codex_2p2nqsd0c76g0".into(),
                },
            ],
        };
        config.validate().unwrap();
        assert_eq!(config.applications.len(), 2);
        for value in [
            "a.exe",
            "C:\\Apps\\*.exe",
            "C:\\Apps\\..\\a.exe",
            "C:\\Apps\\a.exe\0",
            "\\\\server\\a.exe",
        ] {
            config.applications = vec![Target::Executable {
                value: value.into(),
            }];
            assert!(config.validate().is_err(), "accepted {value:?}");
        }
    }
    #[test]
    fn empty_enabled_and_unknown_selector_fields_are_rejected() {
        assert!(Config {
            enabled: true,
            applications: vec![]
        }
        .validate()
        .is_err());
        assert!(serde_json::from_value::<Target>(
            json!({"kind":"executable","value":"C:\\a.exe","children":true})
        )
        .is_err());
    }
}
