//! A tray is a view of committed service state, never of the graph draft.
use serde_json::Value;
use wayrill_protocol::Message;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Shade {
    Offline,
    Stopped,
    Running,
    Busy,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct View {
    pub label: &'static str,
    pub shade: Shade,
    pub start: bool,
    pub stop: bool,
}
impl View {
    fn new(label: &'static str, shade: Shade) -> Self {
        Self {
            label,
            shade,
            start: false,
            stop: false,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Action {
    Start,
    Stop,
}
impl Action {
    pub fn label(self) -> &'static str {
        match self {
            Self::Start => "Start routing",
            Self::Stop => "Stop routing",
        }
    }
    pub fn method(self) -> &'static str {
        match self {
            Self::Start => "core.start",
            Self::Stop => "core.stop",
        }
    }
}
struct Status {
    view: View,
    revision: u64,
}
impl Status {
    fn read(s: &Value) -> Option<Self> {
        let core = s["core"]["state"].as_str()?;
        let revision = s["config"]["revision"].as_u64()?;
        let progress = &s["lifecycle"];
        let recovering = s["recovery"]["desiredState"] == "running";
        let (label, shade) = if !progress.is_null() {
            if progress["recovering"] == true {
                ("Restoring routing", Shade::Busy)
            } else {
                match progress["operation"].as_str() {
                    Some("stop") => ("Stopping routing", Shade::Busy),
                    Some("start") => ("Starting routing", Shade::Busy),
                    Some("restart") => ("Restarting routing", Shade::Busy),
                    _ => ("Updating routing", Shade::Busy),
                }
            }
        } else if recovering && s["recovery"]["state"] == "waiting" {
            ("Recovering routing", Shade::Busy)
        } else if s["recovery"]["state"] == "blocked" {
            ("Routing needs attention", Shade::Failed)
        } else if recovering
            && matches!(
                s["network"]["state"].as_str(),
                Some("waiting" | "settling" | "reconnecting")
            )
        {
            ("Waiting for network", Shade::Busy)
        } else {
            match core {
                "running" => ("Routing running", Shade::Running),
                "stopped" => (
                    if s["config"]["present"] == true {
                        "Routing stopped"
                    } else {
                        "Routing stopped — no applied configuration"
                    },
                    Shade::Stopped,
                ),
                "starting" => ("Starting routing", Shade::Busy),
                "stopping" => ("Stopping routing", Shade::Busy),
                "failed" => ("Routing failed", Shade::Failed),
                _ => return None,
            }
        };
        let transition = !progress.is_null() || matches!(core, "starting" | "stopping");
        let mut view = View::new(label, shade);
        view.start = !transition
            && !recovering
            && s["config"]["present"] == true
            && s["config"]["recoveryError"].is_null()
            && matches!(core, "stopped" | "failed");
        view.stop = !transition
            && (core != "stopped"
                || recovering
                || s["capture"]["state"] == "running"
                || s["capture"]["firewallManaged"] == true
                || s["systemProxy"]["managed"] == true
                || s["systemProxy"]["recoveryPending"] == true
                || s["systemCapture"]["managed"] == true
                || s["tun"]["sharing"]["managed"] == true
                || s["tun"]["sharing"]["recoveryPending"] == true);
        Some(Self { view, revision })
    }
}

#[derive(Default)]
pub(super) struct Model {
    // None until the first subscription attempt finishes.
    connected: Option<bool>,
    status: Option<Status>,
    instance: String,
    sequence: u64,
    epoch: u64,
    pending: Option<(Action, u64)>,
}
impl Model {
    pub fn can_switch(&self) -> bool {
        self.connected == Some(true)
            && self.pending.is_none()
            && matches!(
                self.view().shade,
                Shade::Running | Shade::Stopped | Shade::Failed
            )
    }
    pub fn view(&self) -> View {
        if self.connected != Some(true) {
            return View::new(
                if self.connected.is_none() {
                    "Connecting to service…"
                } else {
                    "Service offline — routing state unknown"
                },
                Shade::Offline,
            );
        }
        if let Some((action, epoch)) = self.pending {
            if self.epoch != epoch {
                if let Some(status) = &self.status {
                    let mut view = status.view;
                    view.start = false;
                    view.stop = false;
                    return view;
                }
            }
            return View::new(
                match action {
                    Action::Start => "Starting routing",
                    Action::Stop => "Stopping routing",
                },
                Shade::Busy,
            );
        }
        self.status
            .as_ref()
            .map(|s| s.view)
            .unwrap_or_else(|| View::new("Routing state unavailable", Shade::Offline))
    }
    pub fn disconnected(&mut self) {
        self.connected = Some(false);
        self.epoch += 1;
    }
    fn snapshot(&mut self, snapshot: &Value) {
        self.status = Status::read(snapshot);
        self.connected = Some(self.status.is_some());
        self.epoch += 1;
    }
    pub fn message(&mut self, message: &Message) {
        match message {
            Message::Response {
                ok: true, result, ..
            } => {
                let Some(instance) = result["instanceId"].as_str() else {
                    self.disconnected();
                    return;
                };
                let Some(sequence) = result["sequence"].as_u64() else {
                    self.disconnected();
                    return;
                };
                if instance == self.instance && sequence < self.sequence {
                    return;
                }
                self.instance = instance.into();
                self.sequence = sequence;
                self.snapshot(&result["snapshot"]);
            }
            Message::Event {
                instance_id,
                sequence,
                payload,
                ..
            } if *instance_id == self.instance && *sequence > self.sequence => {
                self.sequence = *sequence;
                if payload.get("core").is_some() {
                    self.snapshot(payload);
                }
            }
            _ => {}
        }
    }
    pub fn begin(&mut self, action: Action) -> Option<(u64, u64)> {
        let view = self.view();
        if !(match action {
            Action::Start => view.start,
            Action::Stop => view.stop,
        }) {
            return None;
        }
        let revision = self.status.as_ref()?.revision;
        self.pending = Some((action, self.epoch));
        Some((revision, self.epoch))
    }
    pub fn finish(&mut self, epoch: u64, snapshot: Option<&Value>) {
        // The service publishes sequenced events independently of command replies.
        // A late response must not replace a newer snapshot or reconnection state.
        if self.epoch == epoch && self.connected == Some(true) {
            if let Some(snapshot) = snapshot {
                self.snapshot(snapshot);
            }
        }
        self.pending = None;
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn snapshot(core: &str) -> Value {
        json!({"core":{"state":core},"config":{"present":true,"revision":7},"lifecycle":null,
            "recovery":{"desiredState":if core == "running" {"running"} else {"stopped"},"state":"healthy"}})
    }
    fn ack(model: &mut Model, instance: &str, sequence: u64, snapshot: Value) {
        model.message(&Message::response(
            1,
            Ok(json!({"instanceId":instance,"sequence":sequence,"snapshot":snapshot})),
        ));
    }
    fn event(model: &mut Model, instance: &str, sequence: u64, snapshot: Value) {
        model.message(&Message::Event {
            api_version: 1,
            instance_id: instance.into(),
            sequence,
            timestamp_ms: 0,
            kind: "core.state".into(),
            payload: snapshot,
        });
    }
    #[test]
    fn controls_require_a_live_service_and_an_applied_profile() {
        let mut m = Model::default();
        assert_eq!(m.view().label, "Connecting to service…");
        m.disconnected();
        assert_eq!(m.view().label, "Service offline — routing state unknown");
        ack(&mut m, "a", 1, snapshot("stopped"));
        assert!(m.view().start);
        assert!(!m.view().stop);
        let mut empty = snapshot("stopped");
        empty["config"]["present"] = json!(false);
        event(&mut m, "a", 2, empty);
        assert!(!m.view().start);
        event(&mut m, "a", 3, snapshot("running"));
        assert!(m.view().stop);
        assert!(!m.view().start);
        m.disconnected();
        assert!(!m.view().stop);
        assert_eq!(m.view().shade, Shade::Offline);
        ack(&mut m, "b", 0, json!({}));
        assert!(!m.view().start);
        assert!(!m.view().stop);
    }
    #[test]
    fn progress_and_recovery_override_a_still_running_core() {
        let mut m = Model::default();
        let mut s = snapshot("running");
        s["lifecycle"] = json!({"operation":"restart","recovering":false});
        ack(&mut m, "a", 1, s);
        assert_eq!(m.view().label, "Restarting routing");
        assert!(!m.view().stop);
        let mut s = snapshot("failed");
        s["recovery"] = json!({"desiredState":"running","state":"waiting"});
        event(&mut m, "a", 2, s);
        assert_eq!(m.view().label, "Recovering routing");
        assert!(m.view().stop);
        assert!(!m.view().start);
        let mut s = snapshot("running");
        s["network"] = json!({"state":"waiting"});
        event(&mut m, "a", 3, s);
        assert_eq!(m.view().label, "Waiting for network");
    }
    #[test]
    fn stop_remains_available_for_pending_windows_restoration() {
        let mut m = Model::default();
        let mut s = snapshot("stopped");
        s["tun"] = json!({"sharing":{"recoveryPending":true}});
        ack(&mut m, "a", 1, s);
        assert!(m.view().stop);
    }
    #[test]
    fn replay_and_late_command_replies_cannot_regress_live_state() {
        let mut m = Model::default();
        ack(&mut m, "a", 100, snapshot("stopped"));
        let (_, epoch) = m.begin(Action::Start).unwrap();
        assert!(m.begin(Action::Start).is_none());
        event(&mut m, "a", 101, snapshot("running"));
        m.finish(epoch, Some(&snapshot("stopped")));
        assert_eq!(m.view().shade, Shade::Running);
        event(&mut m, "a", 99, snapshot("stopped"));
        event(&mut m, "old", 999, snapshot("stopped"));
        assert_eq!(m.view().shade, Shade::Running);
        ack(&mut m, "b", 1, snapshot("stopped"));
        event(&mut m, "a", 9999, snapshot("running"));
        assert_eq!(m.view().shade, Shade::Stopped);
    }
    #[test]
    fn disconnection_during_a_command_cannot_be_overwritten_by_its_reply() {
        let mut m = Model::default();
        ack(&mut m, "a", 1, snapshot("stopped"));
        let (_, epoch) = m.begin(Action::Start).unwrap();
        m.disconnected();
        m.finish(epoch, Some(&snapshot("running")));
        assert_eq!(m.view().shade, Shade::Offline);
        ack(&mut m, "b", 1, snapshot("running"));
        assert!(m.view().stop);
    }

    #[test]
    fn start_uses_the_latest_revision_without_repainting_an_unchanged_state() {
        let mut model = Model::default();
        for revision in [4, 9] {
            let mut s = snapshot("stopped");
            s["config"]["revision"] = json!(revision);
            ack(&mut model, "a", revision, s);
        }
        assert_eq!(model.begin(Action::Start).unwrap().0, 9);
    }
    #[test]
    fn pending_commands_follow_observed_rollback_and_terminal_states() {
        let mut model = Model::default();
        ack(&mut model, "a", 1, snapshot("stopped"));
        let (_, epoch) = model.begin(Action::Start).unwrap();
        assert_eq!(model.view().label, "Starting routing");
        let mut rolling_back = snapshot("running");
        rolling_back["lifecycle"] = json!({"operation":"start","recovering":true});
        event(&mut model, "a", 2, rolling_back);
        assert_eq!(model.view().label, "Restoring routing");
        assert!(!model.view().start && !model.view().stop);
        event(&mut model, "a", 3, snapshot("failed"));
        assert_eq!(model.view().shade, Shade::Failed);
        assert!(!model.view().start);
        model.finish(epoch, None);
        assert!(model.view().start);
    }
    #[test]
    fn switching_is_unavailable_during_native_commands_and_recovery() {
        let mut model = Model::default();
        assert!(!model.can_switch());
        ack(&mut model, "a", 1, snapshot("stopped"));
        assert!(model.can_switch());
        let (_, epoch) = model.begin(Action::Start).unwrap();
        event(&mut model, "a", 2, snapshot("running"));
        assert!(!model.can_switch());
        model.finish(epoch, None);
        assert!(model.can_switch());
        let mut recovering = snapshot("running");
        recovering["lifecycle"] = json!({"operation":"restart"});
        event(&mut model, "a", 3, recovering);
        assert!(!model.can_switch());
        model.disconnected();
        assert!(!model.can_switch());
    }
}
