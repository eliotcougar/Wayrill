use wayrill_protocol::{ApiError, Result};
/// Candidate validation precedes retirement. Native preflight may finish recovery
/// of previously owned resources; it must not retire a healthy runtime. Candidate
/// mutations run under the kernel lock after a durable checkpoint.
pub trait Activation {
    fn action(&self) -> &'static str {
        "Apply"
    }
    fn validate(&mut self) -> Result<()>;
    fn checkpoint(&mut self) -> Result<()>;
    fn stop(&mut self) -> Result<()>;
    fn apply(&mut self) -> Result<()>;
    fn start(&mut self) -> Result<()>;
    fn proxy(&mut self) -> Result<()>;
    fn commit(&mut self) -> Result<()>;
    fn restore(&mut self) -> Result<()>;
}
#[derive(Clone, Copy, Debug)]
enum Phase {
    Retire,
    Persist,
    Activate,
    Settings,
    Commit,
}
impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Retire => "runtime retirement",
            Self::Persist => "profile persistence",
            Self::Activate => "runtime activation",
            Self::Settings => "Windows settings",
            Self::Commit => "commit",
        }
    }
    fn run(self, a: &mut impl Activation) -> Result<()> {
        match self {
            Self::Retire => a.stop(),
            Self::Persist => a.apply(),
            Self::Activate => a.start(),
            Self::Settings => a.proxy(),
            Self::Commit => a.commit(),
        }
    }
}
pub fn execute(a: &mut impl Activation) -> Result<()> {
    a.validate()?;
    a.checkpoint()?;
    for phase in [
        Phase::Retire,
        Phase::Persist,
        Phase::Activate,
        Phase::Settings,
        Phase::Commit,
    ] {
        if let Err(original) = phase.run(a) {
            return match a.restore() {
                Ok(()) => Err(ApiError::new("ACTIVATION_ROLLED_BACK", format!("{} failed ({}) during {}. Previous configuration and runtime state were restored. {}", a.action(), original.code, phase.name(), original.message))),
                Err(recovery) => Err(ApiError::new("ACTIVATION_RECOVERY_FAILED", format!("{} failed ({}) during {}: {} Recovery needs attention ({}): {} The protected recovery checkpoint was retained.", a.action(), original.code, phase.name(), original.message, recovery.code, recovery.message))),
            };
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        fail: &'static str,
        action: &'static str,
        recovery_fail: bool,
        calls: Vec<&'static str>,
    }
    impl Fake {
        fn step(&mut self, name: &'static str) -> Result<()> {
            self.calls.push(name);
            if self.fail == name {
                Err(ApiError::new("TEST_FAILURE", name))
            } else {
                Ok(())
            }
        }
    }
    impl Activation for Fake {
        fn action(&self) -> &'static str {
            if self.action.is_empty() {
                "Apply"
            } else {
                self.action
            }
        }
        fn validate(&mut self) -> Result<()> {
            self.step("validate")
        }
        fn checkpoint(&mut self) -> Result<()> {
            self.step("checkpoint")
        }
        fn stop(&mut self) -> Result<()> {
            self.step("stop")
        }
        fn apply(&mut self) -> Result<()> {
            self.step("apply")
        }
        fn start(&mut self) -> Result<()> {
            self.step("start")
        }
        fn proxy(&mut self) -> Result<()> {
            self.step("proxy")
        }
        fn commit(&mut self) -> Result<()> {
            self.step("commit")
        }
        fn restore(&mut self) -> Result<()> {
            self.calls.push("restore");
            if self.recovery_fail {
                Err(ApiError::new("TEST_RECOVERY", "failure"))
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn failure_diagnostics_keep_the_failed_phase_and_both_causes() {
        for fail in ["stop", "apply", "start", "proxy", "commit"] {
            let mut a = Fake {
                fail,
                recovery_fail: true,
                ..Default::default()
            };
            let error = execute(&mut a).unwrap_err();
            assert_eq!(error.code, "ACTIVATION_RECOVERY_FAILED");
            assert!(error.message.contains("TEST_FAILURE"));
            assert!(error.message.contains(fail));
            assert!(error.message.contains("TEST_RECOVERY"));
            assert!(error.message.contains("checkpoint was retained"));
            assert_eq!(a.calls.iter().filter(|call| **call == "restore").count(), 1);
        }
    }
    #[test]
    fn rejection_never_stops_the_running_core() {
        for fail in ["validate", "checkpoint"] {
            let mut a = Fake {
                fail,
                ..Default::default()
            };
            assert_eq!(execute(&mut a).unwrap_err().code, "TEST_FAILURE");
            assert!(!a.calls.contains(&"stop"));
            assert!(!a.calls.contains(&"restore"));
        }
    }
    #[test]
    fn each_mutating_failure_restores_the_checkpoint() {
        for fail in ["stop", "apply", "start", "proxy", "commit"] {
            let mut a = Fake {
                fail,
                ..Default::default()
            };
            assert_eq!(execute(&mut a).unwrap_err().code, "ACTIVATION_ROLLED_BACK");
            assert_eq!(a.calls.last(), Some(&"restore"));
        }
    }
    #[test]
    fn successful_activation_orders_readiness_before_proxy() {
        let mut a = Fake::default();
        execute(&mut a).unwrap();
        assert_eq!(
            a.calls,
            vec![
                "validate",
                "checkpoint",
                "stop",
                "apply",
                "start",
                "proxy",
                "commit"
            ]
        );
    }
    #[test]
    fn restart_failure_uses_its_actual_action() {
        let mut a = Fake {
            fail: "start",
            action: "Restart",
            ..Default::default()
        };
        assert!(execute(&mut a)
            .unwrap_err()
            .message
            .starts_with("Restart failed"));
    }
}
