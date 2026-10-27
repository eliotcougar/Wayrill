// SPDX-License-Identifier: GPL-3.0-only
//! REFLECT-only observations. Neither snapshot nor live inventory intercepts,
//! injects, stops, reconfigures, or unloads another application's packet handle.
use super::divert::{Api, Handle};
use crate::{
    divert_monitor::{HandleInfo, HandleSnapshot},
    Error, Result,
};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Default)]
struct State {
    snapshot: HandleSnapshot,
    failure: Option<Error>,
}
pub struct Monitor {
    state: Arc<Mutex<State>>,
    stopping: Arc<AtomicBool>,
    handle: Arc<Handle>,
    reader: Option<JoinHandle<()>>,
    completed: mpsc::Receiver<()>,
}
impl Monitor {
    fn new(api: &Arc<Api>, allow_install: bool, snapshot_only: bool) -> Result<Self> {
        let handle = Arc::new(api.open_monitor(allow_install)?);
        if snapshot_only {
            handle.shutdown(3)?;
        }
        handle.set_param(0, 8192)?;
        handle.set_param(1, 16000)?;
        handle.set_param(2, 33554432)?;
        let state = Arc::new(Mutex::new(State::default()));
        let stopping = Arc::new(AtomicBool::new(false));
        let (sent, completed) = mpsc::sync_channel(1);
        let (worker_state, worker_stop, worker_handle) =
            (state.clone(), stopping.clone(), handle.clone());
        let reader = thread::Builder::new()
            .name("capture-ownership".into())
            .spawn(move || {
                let read = || -> Result<()> {
                    let mut packet = vec![0; 65536];
                    while !worker_stop.load(Ordering::Acquire) {
                        let address = match worker_handle.receive_one(&mut packet) {
                            Ok((_, address)) => address,
                            Err(error)
                                if worker_stop.load(Ordering::Acquire)
                                    || snapshot_only && error.os_code() == Some(232) =>
                            {
                                return Ok(())
                            }
                            Err(error) => return Err(error),
                        };
                        if address.reflect_pid() == std::process::id()
                            || !matches!(address.event(), 8 | 9)
                        {
                            continue;
                        }
                        let mut state = worker_state
                            .lock()
                            .map_err(|_| Error::invalid("WinDivert observation state poisoned."))?;
                        state
                            .snapshot
                            .observe(HandleInfo::from_address(address), address.event() == 8)?;
                    }
                    Ok(())
                };
                let result = catch_unwind(AssertUnwindSafe(read)).unwrap_or_else(|_| {
                    Err(Error::invalid("WinDivert ownership reader panicked."))
                });
                if let Err(error) = result {
                    if let Ok(mut state) = worker_state.lock() {
                        state.failure = Some(Error::invalid(format!(
                            "WinDivert ownership observation failed: {error}"
                        )));
                    }
                }
                let _ = sent.send(());
            })?;
        Ok(Self {
            state,
            stopping,
            handle,
            reader: Some(reader),
            completed,
        })
    }
    pub fn snapshot(api: &Arc<Api>) -> Result<Option<Self>> {
        let monitor = match Self::new(api, false, true) {
            Ok(monitor) => monitor,
            Err(error) if error.os_code() == Some(1060) => return Ok(None),
            Err(error) => return Err(error),
        };
        monitor
            .completed
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| Error::invalid("WinDivert ownership snapshot timed out."))?;
        monitor.check_health()?;
        Ok(Some(monitor))
    }
    pub fn open(api: &Arc<Api>, allow_install: bool) -> Result<Option<Self>> {
        let monitor = match Self::new(api, allow_install, false) {
            Ok(monitor) => monitor,
            Err(error) if !allow_install && error.os_code() == Some(1060) => return Ok(None),
            Err(error) => return Err(error),
        };
        let snapshot = Self::snapshot(api)?
            .ok_or_else(|| Error::invalid("WinDivert disappeared during ownership observation."))?;
        let initial = snapshot.handles()?;
        {
            let mut state = monitor
                .state
                .lock()
                .map_err(|_| Error::invalid("WinDivert observation state poisoned."))?;
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            state.snapshot.merge_initial(initial)?;
        }
        Ok(Some(monitor))
    }
    pub fn check_health(&self) -> Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("WinDivert observation state poisoned."))?;
        match &state.failure {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
    pub fn handles(&self) -> Result<Vec<HandleInfo>> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("WinDivert observation state poisoned."))?;
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        Ok(state.snapshot.handles.values().cloned().collect())
    }
    pub fn conflict(
        &self,
        owned_capture_pid: Option<u32>,
        service_pid: Option<u32>,
    ) -> Result<Option<HandleInfo>> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("WinDivert observation state poisoned."))?;
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        Ok(state
            .snapshot
            .foreign(std::process::id(), owned_capture_pid, service_pid)
            .cloned())
    }
    /// Explicit close reports a stuck reader to the containing worker, which
    /// must exit rather than accumulate unobservable native resources.
    pub fn close(&mut self) -> Result<()> {
        let Some(reader) = self.reader.take() else {
            return Ok(());
        };
        self.stopping.store(true, Ordering::Release);
        let shutdown = self.handle.shutdown(1);
        // A snapshot may have consumed its completion token; is_finished still
        // makes joining it safe. Never wait indefinitely on a broken driver.
        if !reader.is_finished() && self.completed.recv_timeout(Duration::from_secs(1)).is_err() {
            drop(reader);
            return Err(Error::invalid(
                "WinDivert ownership reader did not stop; capture worker must exit.",
            ));
        }
        reader
            .join()
            .map_err(|_| Error::invalid("WinDivert ownership reader panicked."))?;
        shutdown
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
