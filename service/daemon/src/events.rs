use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use wayrill_protocol::{Message, API_VERSION};

const REPLAY_CAPACITY: usize = 256;

#[derive(Clone)]
pub enum Delivery {
    Event(Arc<Message>),
    Snapshot(u64),
}

#[derive(Default)]
struct State {
    sequence: u64,
    evicted_through: u64,
    replay: VecDeque<(u64, Arc<Message>)>,
    latest: Option<(u64, Arc<Message>)>,
}

pub struct Events {
    pub instance_id: String,
    pub started_at_ms: u64,
    pub routing: crate::routing_log::Log,
    state: Mutex<State>,
    activity: Mutex<(Value, Value, std::time::Instant)>,
    tx: broadcast::Sender<Delivery>,
}
impl Events {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(REPLAY_CAPACITY);
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        Arc::new(Self {
            instance_id: format!("{}-{}", std::process::id(), started_at.as_nanos()),
            started_at_ms: started_at.as_millis() as u64,
            routing: crate::routing_log::Log::default(),
            state: Mutex::new(State::default()),
            activity: Mutex::new((Value::Null, Value::Null, std::time::Instant::now())),
            tx,
        })
    }
    /// Available without the kernel lock, including during slow native work.
    pub fn activity(&self) -> Value {
        let activity = self.activity.lock().unwrap();
        serde_json::json!({"instanceId":self.instance_id,"lifecycle":activity.0,"nativeActivity":activity.1,"idleMs":activity.2.elapsed().as_millis() as u64})
    }
    pub fn publish(&self, kind: &str, payload: Value) {
        crate::diagnostics::event(kind, &payload);
        let mut state = self.state.lock().unwrap();
        if kind == "runtime.activity"
            || (payload.get("core").is_some() && payload.get("lifecycle").is_some())
        {
            let mut activity = self.activity.lock().unwrap();
            if kind == "runtime.activity" {
                activity.1 = payload.clone();
            } else {
                activity.0 = payload["lifecycle"].clone();
                activity.1 = Value::Null;
            }
            activity.2 = std::time::Instant::now();
        }
        state.sequence += 1;
        let sequence = state.sequence;
        let message = self.message(sequence, kind, payload);
        state.replay.push_back((sequence, message.clone()));
        if state.replay.len() > REPLAY_CAPACITY {
            state.evicted_through = state.replay.pop_front().unwrap().0;
        }
        let _ = self.tx.send(Delivery::Event(message));
    }

    pub fn has_subscribers(&self) -> bool {
        self.tx.receiver_count() != 0
    }

    pub fn publish_snapshot(&self, payload: Value) {
        let mut state = self.state.lock().unwrap();
        state.sequence += 1;
        let sequence = state.sequence;
        state.latest = Some((
            sequence,
            self.message(sequence, "service.snapshot", payload),
        ));
        // A slot preserves wire order without keeping an obsolete payload alive.
        let _ = self.tx.send(Delivery::Snapshot(sequence));
    }

    pub fn resolve(&self, delivery: Delivery) -> Option<Arc<Message>> {
        match delivery {
            Delivery::Event(message) => Some(message),
            Delivery::Snapshot(sequence) => self
                .state
                .lock()
                .unwrap()
                .latest
                .as_ref()
                .filter(|(latest, _)| *latest == sequence)
                .map(|(_, message)| message.clone()),
        }
    }

    fn message(&self, sequence: u64, kind: &str, payload: Value) -> Arc<Message> {
        Arc::new(Message::Event {
            api_version: API_VERSION,
            instance_id: self.instance_id.clone(),
            sequence,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            kind: kind.into(),
            payload,
        })
    }
    pub fn sequence(&self) -> u64 {
        self.state.lock().unwrap().sequence
    }
    pub fn subscribe(
        &self,
        after: u64,
        instance: Option<&str>,
    ) -> (u64, bool, Vec<Arc<Message>>, broadcast::Receiver<Delivery>) {
        let state = self.state.lock().unwrap();
        let restarted = instance.is_some_and(|id| id != self.instance_id);
        let after = if restarted { 0 } else { after };
        let gap = restarted || after > state.sequence || after < state.evicted_through;
        let replay = state
            .replay
            .iter()
            .filter(|(sequence, _)| *sequence > after)
            .map(|(_, message)| message.clone())
            .collect();
        (state.sequence, gap, replay, self.tx.subscribe())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn native_progress_query_is_independent_of_kernel_and_cleared_by_stage_changes() {
        let events = Events::new();
        events.publish(
            "runtime.progress",
            json!({"core":{},"lifecycle":{"operation":"start"}}),
        );
        events.publish(
            "runtime.activity",
            json!({"phase":"enablePublic","elapsedMs":31000}),
        );
        let view = events.activity();
        assert_eq!(view["nativeActivity"]["elapsedMs"], 31000);
        assert_eq!(view["lifecycle"]["operation"], "start");
        events.publish("core.log", json!({"text":"unrelated"}));
        assert_eq!(events.activity()["nativeActivity"], view["nativeActivity"]);
        events.publish("runtime.progress", json!({"core":{},"lifecycle":null}));
        assert!(events.activity()["nativeActivity"].is_null());
        assert!(events.activity()["lifecycle"].is_null());
    }
    #[test]
    fn bounded_replay_reports_gap() {
        let e = Events::new();
        for _ in 0..300 {
            e.publish("test", json!({}));
        }
        let (seq, gap, events, _) = e.subscribe(1, Some(&e.instance_id));
        assert_eq!(seq, 300);
        assert!(gap);
        assert_eq!(events.len(), 256);
    }
    #[test]
    fn exact_cursor_has_no_duplicates() {
        let e = Events::new();
        e.publish("test", json!({}));
        let (_, gap, events, _) = e.subscribe(1, Some(&e.instance_id));
        assert!(!gap);
        assert!(events.is_empty());
    }
    #[test]
    fn new_instance_replays_even_if_old_cursor_is_lower() {
        let e = Events::new();
        for _ in 0..3 {
            e.publish("test", json!({}));
        }
        let (_, gap, replay, _) = e.subscribe(1, Some("previous-service-instance"));
        assert!(gap);
        assert_eq!(replay.len(), 3);
    }

    #[test]
    fn periodic_snapshots_coalesce_without_creating_a_replay_gap() {
        let e = Events::new();
        for _ in 0..300 {
            e.publish_snapshot(json!({"sample":"old"}));
        }
        let (_, _, _, mut live) = e.subscribe(0, None);
        e.publish_snapshot(json!({"sample":"superseded"}));
        e.publish("core.state", json!({"state":"running"}));
        e.publish_snapshot(json!({"sample":"latest"}));
        e.publish("core.log", json!({"message":"finished"}));

        assert!(e.resolve(live.try_recv().unwrap()).is_none());
        for (sequence, kind) in [
            (302, "core.state"),
            (303, "service.snapshot"),
            (304, "core.log"),
        ] {
            let message = e.resolve(live.try_recv().unwrap()).unwrap();
            assert!(matches!(message.as_ref(), Message::Event {
                sequence: actual, kind: name, ..
            } if *actual == sequence && name == kind));
        }
        let (sequence, gap, replay, _) = e.subscribe(1, Some(&e.instance_id));
        assert_eq!(sequence, 304);
        assert!(!gap);
        assert_eq!(replay.len(), 2);
        assert!(matches!(
            replay[0].as_ref(),
            Message::Event { sequence: 302, .. }
        ));
        assert!(matches!(
            replay[1].as_ref(),
            Message::Event { sequence: 304, .. }
        ));
    }
}
