use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use wayrill_protocol::{Message, API_VERSION};
pub struct Events {
    pub instance_id: String,
    pub routing: crate::routing_log::Log,
    state: Mutex<(u64, VecDeque<Message>)>,
    activity: Mutex<(Value, Value, std::time::Instant)>,
    tx: broadcast::Sender<Message>,
}
impl Events {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Self {
            instance_id: format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            routing: crate::routing_log::Log::default(),
            state: Mutex::new((0, VecDeque::new())),
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
        state.0 += 1;
        let message = Message::Event {
            api_version: API_VERSION,
            instance_id: self.instance_id.clone(),
            sequence: state.0,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            kind: kind.into(),
            payload,
        };
        state.1.push_back(message.clone());
        if state.1.len() > 256 {
            state.1.pop_front();
        }
        let _ = self.tx.send(message);
    }
    pub fn sequence(&self) -> u64 {
        self.state.lock().unwrap().0
    }
    pub fn subscribe(
        &self,
        after: u64,
        instance: Option<&str>,
    ) -> (u64, bool, Vec<Message>, broadcast::Receiver<Message>) {
        let state = self.state.lock().unwrap();
        let restarted = instance.is_some_and(|id| id != self.instance_id);
        let after = if restarted { 0 } else { after };
        let gap = restarted
            || after > state.0
            || state.1.front().is_some_and(
                |m| matches!(m,Message::Event{sequence,..} if after.saturating_add(1)<*sequence),
            );
        let replay = state
            .1
            .iter()
            .filter(|m| matches!(m,Message::Event{sequence,..} if *sequence>after))
            .cloned()
            .collect();
        (state.0, gap, replay, self.tx.subscribe())
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
}
