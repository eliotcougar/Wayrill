//! Routing intent and a single serialized retry schedule. Managers keep their
//! native leases/journals; this supervisor never overrides their ownership checks.
use crate::storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use wayrill_protocol::{ApiError, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Manual,
    Boot,
    ServiceRecovery,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Desired {
    Unknown,
    Stopped,
    Running,
}
enum State {
    Stopped,
    Healthy(Instant),
    Waiting { at: Instant, error: ApiError },
    Blocked(ApiError),
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedIntent {
    owner_sid: String,
    running: bool,
}
pub struct Supervisor {
    desired: Desired,
    state: State,
    origin: Origin,
    attempts: u32,
    owner: String,
    intent: Option<PathBuf>,
}
impl Supervisor {
    pub fn new(owner: &str, path: PathBuf) -> Result<Self> {
        let previous = storage::read::<SavedIntent>(&path);
        let (desired, state) = match previous {
            Ok(Some(saved)) if saved.owner_sid != owner => (
                Desired::Unknown,
                State::Waiting {
                    at: Instant::now(),
                    error: ApiError::new(
                        "OWNER_MISMATCH",
                        "Routing intent belongs to another installation owner.",
                    ),
                },
            ),
            Ok(Some(saved)) if saved.running => (
                Desired::Running,
                State::Waiting {
                    at: Instant::now(),
                    error: ApiError::new(
                        "SERVICE_RESTARTED",
                        "Restoring the previously running configuration.",
                    ),
                },
            ),
            Ok(_) => (Desired::Stopped, State::Stopped),
            Err(error) => (
                Desired::Unknown,
                State::Waiting {
                    at: Instant::now(),
                    error,
                },
            ),
        };
        Ok(Self {
            desired,
            state,
            origin: Origin::ServiceRecovery,
            attempts: 0,
            owner: owner.into(),
            intent: Some(path),
        })
    }
    fn persist(&self, running: bool) -> Result<()> {
        let Some(path) = &self.intent else {
            return Ok(());
        };
        storage::write(
            path,
            &SavedIntent {
                owner_sid: self.owner.clone(),
                running,
            },
        )
    }
    pub fn resolve_intent(&mut self, now: Instant) -> Result<()> {
        if self.desired != Desired::Unknown {
            return Ok(());
        }
        let result = (|| {
            let path = self.intent.as_ref().ok_or_else(|| {
                ApiError::new("STATE_INTEGRITY", "Routing intent is unavailable.")
            })?;
            let saved = storage::read::<SavedIntent>(path)?;
            if saved.as_ref().is_some_and(|s| s.owner_sid != self.owner) {
                return Err(ApiError::new(
                    "OWNER_MISMATCH",
                    "Routing intent belongs to another installation owner.",
                ));
            }
            Ok(saved.is_some_and(|s| s.running))
        })();
        match result {
            Ok(true) => {
                self.desired = Desired::Running;
                self.state = State::Waiting {
                    at: now,
                    error: ApiError::new(
                        "SERVICE_RESTARTED",
                        "Resuming the previously running configuration.",
                    ),
                };
                Ok(())
            }
            Ok(false) => {
                self.stopped();
                Ok(())
            }
            Err(error) => {
                self.state = State::Waiting {
                    at: self.retry_at(now),
                    error: error.clone(),
                };
                Err(error)
            }
        }
    }
    fn retry_at(&self, now: Instant) -> Instant {
        now + Duration::from_secs([1, 2, 5, 10, 20, 30, 60][self.attempts.min(6) as usize])
    }
    pub fn retain_assignments(&self) -> bool {
        self.desired != Desired::Stopped
    }
    pub fn wants_running(&self) -> bool {
        self.desired == Desired::Running
    }
    pub fn boot_waiting(&self) -> bool {
        self.origin == Origin::Boot && matches!(self.state, State::Waiting { .. })
    }
    pub fn is_boot(&self) -> bool {
        self.origin == Origin::Boot
    }
    pub fn request(&mut self, origin: Origin) -> Result<()> {
        self.persist(true)?;
        self.desired = Desired::Running;
        self.origin = origin;
        self.attempts = 0;
        self.state = State::Waiting {
            at: Instant::now(),
            error: ApiError::new("ROUTING_PENDING", "Waiting for routing readiness."),
        };
        Ok(())
    }
    pub fn stop(&mut self) -> Result<()> {
        self.desired = Desired::Stopped;
        self.state = State::Stopped;
        self.attempts = 0;
        let result = self.persist_stop();
        if let Err(error) = &result {
            self.retirement_failed(error.clone(), Instant::now());
        }
        result
    }
    /// Cleanup can succeed even if the first durable cancellation failed. Retry
    /// the cancellation with retirement, without resetting its backoff.
    pub fn persist_stop(&self) -> Result<()> {
        self.persist(false)
    }
    pub fn healthy(&mut self, now: Instant) -> Result<()> {
        if !self.wants_running() {
            self.persist(true)?;
            self.origin = Origin::Manual;
        }
        self.desired = Desired::Running;
        if !matches!(self.state, State::Healthy(_)) {
            self.state = State::Healthy(now);
        }
        if matches!(self.state, State::Healthy(since) if now.saturating_duration_since(since) >= Duration::from_secs(30))
        {
            self.attempts = 0;
        }
        Ok(())
    }
    pub fn fail(&mut self, error: ApiError, now: Instant) {
        if !self.wants_running() {
            return;
        }
        self.schedule(error, now);
    }
    pub fn retirement_failed(&mut self, error: ApiError, now: Instant) {
        if self.desired == Desired::Stopped {
            self.schedule(error, now);
        }
    }
    pub fn stopped(&mut self) {
        self.desired = Desired::Stopped;
        self.state = State::Stopped;
        self.attempts = 0;
    }
    fn schedule(&mut self, error: ApiError, now: Instant) {
        // Explicit disable and untrusted state require a corrected intent or
        // authenticated profile. Availability/conflict errors may clear later;
        // retrying their guarded inspection never authorizes overwriting edits.
        if matches!(
            error.code.as_str(),
            "ICS_DISABLED" | "OWNER_MISMATCH" | "STATE_INTEGRITY" | "NO_CONFIG"
        ) {
            self.state = State::Blocked(error);
        } else {
            self.state = State::Waiting {
                at: self.retry_at(now),
                error,
            };
        }
    }
    pub fn due(&mut self, now: Instant) -> bool {
        if !matches!(self.state, State::Waiting { at,.. } if now>=at) {
            return false;
        }
        self.attempts = self.attempts.saturating_add(1);
        true
    }
    pub fn snapshot(&self) -> Value {
        let (state, error, next) = match &self.state {
            State::Stopped => ("stopped", None, None),
            State::Healthy(_) => ("healthy", None, None),
            State::Waiting { at, error } => (
                "waiting",
                Some(error),
                Some(crate::traffic::timestamp_ms().saturating_add(
                    at.saturating_duration_since(Instant::now()).as_millis() as u64,
                )),
            ),
            State::Blocked(error) => ("blocked", Some(error), None),
        };
        json!({"desiredState":match self.desired { Desired::Running=>"running",Desired::Stopped=>"stopped",Desired::Unknown=>"unknown" },"state":state,"attempts":self.attempts,"nextAttemptMs":next,"lastError":error})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn supervisor() -> Supervisor {
        Supervisor {
            desired: Desired::Stopped,
            state: State::Stopped,
            origin: Origin::Manual,
            attempts: 0,
            owner: "test".into(),
            intent: None,
        }
    }
    #[test]
    fn intermittent_failures_back_off_without_expiring_and_success_needs_stability() {
        let mut s = supervisor();
        s.request(Origin::Manual).unwrap();
        let now = Instant::now();
        s.healthy(now).unwrap();
        let failure = ApiError::new("ICS_CONFLICT", "native service is temporarily unavailable");
        let mut at = now;
        for _ in 0..100 {
            s.fail(failure.clone(), at);
            assert!(!s.due(at));
            at += Duration::from_secs(61);
            assert!(s.due(at));
        }
        assert!(s.attempts >= 100);
        s.healthy(at).unwrap();
        s.fail(failure.clone(), at + Duration::from_secs(1));
        assert!(!s.due(at + Duration::from_secs(59)));
        s.healthy(at + Duration::from_secs(70)).unwrap();
        s.healthy(at + Duration::from_secs(101)).unwrap();
        assert_eq!(s.attempts, 0);
        s.fail(failure, at + Duration::from_secs(102));
        assert!(s.due(at + Duration::from_secs(103)));
    }
    #[test]
    fn explicit_stop_cancels_even_a_very_late_retry() {
        let mut s = supervisor();
        s.request(Origin::Boot).unwrap();
        s.fail(
            ApiError::new("TUN_UPLINK_UNAVAILABLE", "offline"),
            Instant::now(),
        );
        assert!(s.boot_waiting());
        s.stop().unwrap();
        assert!(!s.due(Instant::now() + Duration::from_secs(86400)) && !s.wants_running());
        s.fail(ApiError::new("XRAY_EXITED", "stale fault"), Instant::now());
        assert!(!s.wants_running());
    }
    #[test]
    fn explicit_intent_and_integrity_failures_do_not_restart_in_a_loop() {
        for code in [
            "ICS_DISABLED",
            "STATE_INTEGRITY",
            "OWNER_MISMATCH",
            "NO_CONFIG",
        ] {
            let mut s = supervisor();
            s.request(Origin::Manual).unwrap();
            s.fail(ApiError::new(code, "blocked"), Instant::now());
            assert!(!s.due(Instant::now() + Duration::from_secs(86400)));
            assert_eq!(s.snapshot()["state"], "blocked");
        }
    }
    #[test]
    fn incomplete_stop_retries_cleanup_without_rearming_running_intent() {
        let mut s = supervisor();
        s.request(Origin::Manual).unwrap();
        s.stop().unwrap();
        let now = Instant::now();
        s.retirement_failed(ApiError::new("ICS_BUSY", "still draining"), now);
        assert!(!s.wants_running());
        assert_eq!(s.snapshot()["desiredState"], "stopped");
        assert!(s.due(now + Duration::from_secs(2)));
        s.stopped();
        assert!(!s.due(now + Duration::from_secs(86400)));
    }
    #[test]
    fn failed_stop_persistence_is_retried_without_resetting_retirement_backoff() {
        let dir = std::env::temp_dir().join(format!(
            "wayrill-stop-intent-{}",
            crate::tun::random_id().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("intent.json");
        let mut s = Supervisor::new("owner", path.clone()).unwrap();
        s.request(Origin::Manual).unwrap();
        // An unavailable atomic-write destination must not turn an explicit
        // Stop into a durable Running intent after cleanup has completed.
        let temporary = path.with_extension("tmp");
        std::fs::create_dir(&temporary).unwrap();
        s.stop().unwrap_err();
        let now = Instant::now();
        assert!(!s.wants_running());
        assert_eq!(s.snapshot()["state"], "waiting");
        assert!(s.due(now + Duration::from_secs(2)));
        let error = s.persist_stop().unwrap_err();
        assert_eq!(s.attempts, 1);
        s.retirement_failed(error, now + Duration::from_secs(2));
        assert!(!s.due(now + Duration::from_secs(3)));
        assert!(s.due(now + Duration::from_secs(4)));
        std::fs::remove_dir(&temporary).unwrap();
        s.persist_stop().unwrap();
        assert_eq!(s.attempts, 2);
        s.stopped();
        assert!(!Supervisor::new("owner", path.clone())
            .unwrap()
            .wants_running());

        // A subsequent explicit Start supersedes the successfully retired Stop.
        s.request(Origin::Manual).unwrap();
        assert!(Supervisor::new("owner", path).unwrap().wants_running());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn running_intent_survives_service_and_windows_restart_until_explicit_stop() {
        let dir = std::env::temp_dir().join(format!(
            "wayrill-supervisor-{}-{}",
            std::process::id(),
            crate::traffic::timestamp_ms()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("intent.json");
        let mut first = Supervisor::new("owner", path.clone()).unwrap();
        assert!(!first.wants_running());
        assert!(!first.retain_assignments());
        first.healthy(Instant::now()).unwrap();
        assert!(first.retain_assignments());
        drop(first);
        let mut resumed = Supervisor::new("owner", path.clone()).unwrap();
        assert!(resumed.wants_running());
        assert!(resumed.due(Instant::now()));
        resumed.stop().unwrap();
        assert!(!resumed.retain_assignments());
        drop(resumed);
        assert!(!Supervisor::new("owner", path.clone())
            .unwrap()
            .wants_running());
        std::fs::write(&path, b"invalid JSON").unwrap();
        let mut invalid = Supervisor::new("owner", path.clone()).unwrap();
        assert_eq!(invalid.snapshot()["desiredState"], "unknown");
        assert!(
            invalid.retain_assignments(),
            "Unknown intent cannot authorize discarding owned assignments"
        );
        assert!(invalid.resolve_intent(Instant::now()).is_err());
        assert_eq!(invalid.snapshot()["state"], "waiting");
        storage::write(
            &path,
            &SavedIntent {
                owner_sid: "owner".into(),
                running: true,
            },
        )
        .unwrap();
        invalid.resolve_intent(Instant::now()).unwrap();
        assert!(
            invalid.wants_running(),
            "Restored trusted metadata must resume without operator input"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
