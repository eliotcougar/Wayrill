//! Lifecycle policy shared by activation, health checks and orderly retirement.
//! Windows ownership remains in the individual managers and their journals.
use serde::{Deserialize, Serialize};
use wayrill_protocol::{ApiError, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CoreState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

/// A Windows reboot preserves desired routing; an explicit administrator Stop
/// cancels it. Unexpected service failure also keeps its durable recovery target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceExit {
    Stop,
    WindowsShutdown,
    Unexpected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkChange {
    Reconfigure,
    PreserveNetwork,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fault {
    Core,
    FakeDns,
    Capture,
    Tun,
    Network,
}
impl Fault {
    /// A main-core fault retains healthy capture, which must still be watched.
    /// Other faults have already retired that scope; retry recovery only through
    /// an explicit transition, not once per service tick.
    pub fn monitor_after_failure(self) -> bool {
        self == Self::Core
    }
    pub fn event(self) -> &'static str {
        match self {
            Self::Core | Self::FakeDns => "core.state",
            Self::Capture => "capture.failed",
            Self::Tun => "tun.failed",
            Self::Network => "network.failed",
        }
    }
}

/// Sharing off is durable user intent; suspension only retires a replacement
/// worker and keeps native handback armed for a later explicit Stop.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SharingExit {
    #[default]
    Native,
    Suspend,
    Disable,
}

/// A caller supplies intent, never independent teardown booleans. In particular,
/// no failure path can restore a proxy assignment and release clients natively.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retirement {
    Shutdown(ServiceExit),
    Stop(SharingExit),
    Replace(NetworkChange, SharingExit),
    Fault(Fault),
}
impl Retirement {
    pub fn sharing(self) -> SharingExit {
        match self {
            Self::Stop(sharing) | Self::Replace(_, sharing) => sharing,
            Self::Fault(_) | Self::Shutdown(ServiceExit::Unexpected) => SharingExit::Suspend,
            Self::Shutdown(ServiceExit::Stop | ServiceExit::WindowsShutdown) => SharingExit::Native,
        }
    }
    pub fn restore_settings(self) -> bool {
        matches!(self, Self::Stop(_) | Self::Shutdown(ServiceExit::Stop))
    }
    pub fn retain_capture(self) -> bool {
        matches!(self, Self::Replace(..) | Self::Fault(Fault::Core))
    }
    pub fn retain_network(self) -> bool {
        matches!(
            self,
            Self::Replace(NetworkChange::PreserveNetwork, _) | Self::Fault(Fault::Core)
        )
    }
    pub fn release_fake_dns(self) -> bool {
        matches!(
            self,
            Self::Stop(_) | Self::Shutdown(_) | Self::Fault(Fault::FakeDns)
        )
    }
}

/// Independent cleanup must all run. Keep the first error's API identity and
/// retain subsequent failures instead of hiding recovery work behind Result::and.
#[derive(Default)]
pub struct Cleanup {
    failures: Vec<(&'static str, ApiError)>,
}
impl Cleanup {
    pub fn record(&mut self, step: &'static str, result: Result<()>) {
        if let Err(error) = result {
            self.failures.push((step, error));
        }
    }
    pub fn finish(self) -> Result<()> {
        let mut failures = self.failures.into_iter();
        let Some((_, mut first)) = failures.next() else {
            return Ok(());
        };
        for (step, error) in failures {
            first.retryable &= error.retryable;
            first.message.push_str(&format!(
                " Additional failure during {step} ({}): {}",
                error.code, error.message
            ));
        }
        Err(first)
    }
    pub fn after_failure(error: ApiError, step: &'static str, cleanup: Result<()>) -> ApiError {
        let mut failures = Self::default();
        failures.record("operation", Err(error));
        failures.record(step, cleanup);
        failures.finish().unwrap_err()
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Start,
    Restart,
    ReloadResources,
    Apply,
    Stop,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Preflight,
    ProtectApps,
    Resolve,
    Validate,
    Checkpoint,
    RetireTun,
    RetireSharing,
    StartSharing,
    UpdateRules,
    RenameAdapters,
    DrainCapture,
    SaveCounters,
    RestoreSettings,
    StopCore,
    SaveProfile,
    Prepare,
    StartCore,
    WaitCore,
    StartTun,
    StartCapture,
    ApplySettings,
    Commit,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    operation: Operation,
    stage: Stage,
    percent: Option<u8>,
    recovering: bool,
}
impl Progress {
    pub fn new(operation: Operation) -> Self {
        Self {
            operation,
            stage: Stage::Preflight,
            percent: Some(0),
            recovering: false,
        }
    }
    pub fn action(&self) -> &'static str {
        match self.operation {
            Operation::Start => "Start",
            Operation::Restart => "Restart",
            Operation::ReloadResources => "Resource refresh",
            Operation::Apply => "Apply",
            Operation::Stop => "Stop",
        }
    }
    pub fn advance(&mut self, stage: Stage) {
        use Operation::*;
        use Stage::*;
        self.stage = stage;
        if self.recovering {
            return;
        }
        let percent = match (self.operation, stage) {
            (_, Preflight) => 0,
            (_, ProtectApps) => 22,
            (Stop, RetireTun | RetireSharing) => 10,
            (Stop, DrainCapture) => 35,
            (Stop, SaveCounters) => 50,
            (Stop, RestoreSettings) => 65,
            (Stop, StopCore) => 85,
            (_, Validate) => 10,
            (_, Resolve) => 15,
            (_, Checkpoint) => 20,
            (_, RetireTun | RetireSharing) => 25,
            (_, UpdateRules | RenameAdapters) => 70,
            (_, DrainCapture | SaveCounters | RestoreSettings | StopCore) => 30,
            (_, SaveProfile) => 35,
            (_, Prepare) => 40,
            (_, StartCore) => 50,
            (_, WaitCore) => 60,
            (_, StartTun | StartSharing) => 70,
            (_, StartCapture) => 85,
            (_, ApplySettings) => 93,
            (_, Commit) => 98,
        };
        self.percent = Some(self.percent.unwrap_or(0).max(percent));
    }
    pub fn recover(&mut self) {
        self.recovering = true;
        self.percent = None;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn sharing_intent_is_explicit_and_replacements_never_default_to_native_handback() {
        for network in [NetworkChange::Reconfigure, NetworkChange::PreserveNetwork] {
            assert_eq!(
                Retirement::Replace(network, SharingExit::Suspend).sharing(),
                SharingExit::Suspend
            );
            assert_eq!(
                Retirement::Replace(network, SharingExit::Disable).sharing(),
                SharingExit::Disable
            );
        }
        assert_eq!(
            Retirement::Stop(SharingExit::Native).sharing(),
            SharingExit::Native
        );
        assert_eq!(
            Retirement::Stop(SharingExit::Disable).sharing(),
            SharingExit::Disable
        );
        assert!(Retirement::Stop(SharingExit::Disable).restore_settings());
    }
    #[test]
    fn retirement_policy_covers_every_intent_without_releasing_settings_on_faults() {
        use NetworkChange::*;
        for (intent, settings, capture, network, dns) in [
            (
                Retirement::Stop(SharingExit::Native),
                true,
                false,
                false,
                true,
            ),
            (
                Retirement::Replace(Reconfigure, SharingExit::Suspend),
                false,
                true,
                false,
                false,
            ),
            (
                Retirement::Replace(PreserveNetwork, SharingExit::Suspend),
                false,
                true,
                true,
                false,
            ),
            (Retirement::Fault(Fault::Core), false, true, true, false),
            (
                Retirement::Fault(Fault::Capture),
                false,
                false,
                false,
                false,
            ),
            (Retirement::Fault(Fault::Tun), false, false, false, false),
            (
                Retirement::Fault(Fault::Network),
                false,
                false,
                false,
                false,
            ),
            (Retirement::Fault(Fault::FakeDns), false, false, false, true),
        ] {
            assert_eq!(
                (
                    intent.restore_settings(),
                    intent.retain_capture(),
                    intent.retain_network(),
                    intent.release_fake_dns()
                ),
                (settings, capture, network, dns),
                "{intent:?}"
            );
        }
    }
    #[test]
    fn cleanup_keeps_every_recorded_failure_in_order() {
        for mask in 0..16 {
            let mut cleanup = Cleanup::default();
            let steps = ["worker", "adapter", "sharing", "proxy"];
            for (index, step) in steps.into_iter().enumerate() {
                cleanup.record(
                    step,
                    if mask & (1 << index) != 0 {
                        Err(ApiError::new(step, format!("failed {step}")))
                    } else {
                        Ok(())
                    },
                );
            }
            match cleanup.finish() {
                Ok(()) => assert_eq!(mask, 0),
                Err(error) => {
                    let failed: Vec<_> = steps
                        .into_iter()
                        .enumerate()
                        .filter(|(i, _)| mask & (1 << i) != 0)
                        .map(|(_, step)| step)
                        .collect();
                    assert_eq!(error.code, failed[0]);
                    let mut offset = 0;
                    for step in failed {
                        let pos = error.message[offset..]
                            .find(&format!("failed {step}"))
                            .unwrap();
                        offset += pos + step.len();
                    }
                }
            }
        }
    }
    #[test]
    fn primary_fault_survives_cleanup_and_combined_errors_are_not_retryable_by_accident() {
        let mut first = ApiError::new("ORIGINAL", "initial fault");
        first.retryable = true;
        let combined = Cleanup::after_failure(
            first,
            "restoration",
            Err(ApiError::new("OWNERSHIP", "external change preserved")),
        );
        assert_eq!(combined.code, "ORIGINAL");
        assert!(combined.message.starts_with("initial fault"));
        assert!(combined.message.contains("OWNERSHIP"));
        assert!(!combined.retryable);
    }
    #[test]
    fn serialized_runtime_states_keep_the_api_contract() {
        assert_eq!(
            serde_json::to_value([
                CoreState::Stopped,
                CoreState::Starting,
                CoreState::Running,
                CoreState::Stopping,
                CoreState::Failed
            ])
            .unwrap(),
            json!(["stopped", "starting", "running", "stopping", "failed"])
        );
    }
    #[test]
    fn progress_tracks_actual_phases_without_regressing_on_restart_preparation() {
        let mut p = Progress::new(Operation::Restart);
        for stage in [
            Stage::Resolve,
            Stage::RetireTun,
            Stage::StopCore,
            Stage::Prepare,
            Stage::WaitCore,
        ] {
            p.advance(stage);
        }
        assert_eq!(serde_json::to_value(&p).unwrap()["percent"], 60);
        p.advance(Stage::Preflight);
        assert_eq!(serde_json::to_value(&p).unwrap()["percent"], 60);
    }
    #[test]
    fn rollback_is_named_but_indeterminate_even_when_restarting_previous_core() {
        let mut p = Progress::new(Operation::Apply);
        p.advance(Stage::StartTun);
        p.recover();
        p.advance(Stage::WaitCore);
        assert_eq!(
            serde_json::to_value(p).unwrap(),
            json!({"operation":"apply","stage":"waitCore","percent":null,"recovering":true})
        );
    }
    #[test]
    fn stop_reports_restoration_before_ending_the_core() {
        let mut p = Progress::new(Operation::Stop);
        p.advance(Stage::RestoreSettings);
        assert_eq!(p.percent, Some(65));
        p.advance(Stage::StopCore);
        assert_eq!(p.percent, Some(85));
    }
    #[test]
    fn shutdown_preserves_working_windows_assignments_until_an_explicit_stop() {
        for reason in [
            ServiceExit::Stop,
            ServiceExit::WindowsShutdown,
            ServiceExit::Unexpected,
        ] {
            let intent = Retirement::Shutdown(reason);
            assert_eq!(intent.restore_settings(), reason == ServiceExit::Stop);
            assert!(
                !intent.retain_capture() && !intent.retain_network() && intent.release_fake_dns()
            );
            assert_eq!(
                intent.sharing(),
                if reason == ServiceExit::Unexpected {
                    SharingExit::Suspend
                } else {
                    SharingExit::Native
                }
            );
        }
    }
}
