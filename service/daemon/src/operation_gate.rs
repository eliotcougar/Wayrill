//! Admission for work competing with subscription maintenance. The kernel still
//! serializes routing mutations; this gate drains background work before a
//! foreground command takes that lock. Reservations live as long as the work,
//! including an asynchronous outbound-test job, never as long as a UI timer.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::Duration;
use wayrill_protocol::{ApiError, Result};

#[derive(Default)]
struct State {
    foreground: usize,
    background: Option<Arc<AtomicBool>>,
}
#[derive(Clone, Default)]
pub(crate) struct Gate(Arc<Inner>);
#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    wake: Condvar,
}
pub(crate) struct Foreground(Gate);
pub(crate) struct Background {
    gate: Gate,
    pub(crate) stop: Arc<AtomicBool>,
}
impl Gate {
    pub(crate) fn foreground(&self, shutdown: &AtomicBool) -> Result<Foreground> {
        let mut state = self.0.state.lock().unwrap();
        state.foreground += 1;
        let reservation = Foreground(self.clone());
        if let Some(stop) = &state.background {
            stop.store(true, Ordering::Release);
        }
        while state.background.is_some() && !shutdown.load(Ordering::Acquire) {
            state = self
                .0
                .wake
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap()
                .0;
        }
        drop(state);
        if shutdown.load(Ordering::Acquire) {
            return Err(ApiError::new(
                "SERVICE_STOPPING",
                "The service is shutting down.",
            ));
        }
        Ok(reservation)
    }
    pub(crate) fn background(&self) -> Option<Background> {
        let mut state = self.0.state.lock().unwrap();
        if state.foreground != 0 || state.background.is_some() {
            return None;
        }
        let stop = Arc::new(AtomicBool::new(false));
        state.background = Some(stop.clone());
        Some(Background {
            gate: self.clone(),
            stop,
        })
    }
}
impl Drop for Foreground {
    fn drop(&mut self) {
        let mut state = self.0 .0.state.lock().unwrap();
        state.foreground -= 1;
        self.0 .0.wake.notify_all();
    }
}
impl Drop for Background {
    fn drop(&mut self) {
        self.gate.0.state.lock().unwrap().background = None;
        self.gate.0.wake.notify_all();
    }
}

pub(crate) fn requires_foreground(method: &str) -> bool {
    matches!(
        method,
        "config.validate"
            | "config.apply"
            | "config.applyAndStart"
            | "config.refreshOutbounds"
            | "core.start"
            | "core.restart"
            | "core.stop"
            | "core.stopForUpgrade"
            | "appProtection.set"
            | "startup.set"
            | "outbounds.testStart"
            | "resources.update"
            | "resources.ensure"
            | "resources.uploadCommit"
            | "tun.sharing.keep"
            | "tun.sharing.restore"
            | "tun.adapters.set"
            | "tun.adapters.remove"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread};
    #[test]
    fn foreground_drains_background_and_reserves_the_lane_until_completion() {
        let gate = Gate::default();
        let background = gate.background().unwrap();
        let other = gate.clone();
        let (started, wait) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let command = thread::spawn(move || {
            let _reservation = other.foreground(&AtomicBool::new(false)).unwrap();
            started.send(()).unwrap();
            released.recv().unwrap();
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !background.stop.load(Ordering::Acquire) {
            assert!(
                std::time::Instant::now() < deadline,
                "foreground did not request cancellation"
            );
            thread::yield_now();
        }
        assert!(wait.try_recv().is_err());
        drop(background);
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(gate.background().is_none());
        release.send(()).unwrap();
        command.join().unwrap();
        assert!(gate.background().is_some());
    }
    #[test]
    fn nested_foreground_reservations_and_shutdown_release_the_lane() {
        let gate = Gate::default();
        let first = gate.foreground(&AtomicBool::new(false)).unwrap();
        let second = gate.foreground(&AtomicBool::new(false)).unwrap();
        drop(first);
        assert!(gate.background().is_none());
        drop(second);
        assert!(gate.foreground(&AtomicBool::new(true)).is_err());
        assert!(gate.background().is_some());
    }
}
