// SPDX-License-Identifier: GPL-3.0-only
use super::divert::{Api, Handle};
use crate::{events::EventQueue, sockets::SocketEvent, Error, Result};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
};
use tokio::sync::Notify;

pub struct SocketEvents {
    queue: Arc<EventQueue<SocketEvent>>,
    handle: Arc<Handle>,
    stopping: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}
impl SocketEvents {
    /// Call only after the capture ownership/driver checks and lease acquisition.
    pub fn open(api: &Arc<Api>, changed: Arc<Notify>) -> Result<Self> {
        let handle = Arc::new(api.open_socket()?);
        handle.set_param(0, 16384)?;
        let queue = Arc::new(EventQueue::new("socket"));
        let stopping = Arc::new(AtomicBool::new(false));
        let (worker_queue, worker_stop, worker_handle) =
            (queue.clone(), stopping.clone(), handle.clone());
        let reader = thread::Builder::new()
            .name("capture-sockets".into())
            .spawn(move || {
                let run = || -> Result<()> {
                    while !worker_stop.load(Ordering::Acquire) {
                        let address = match worker_handle.receive_one(&mut []) {
                            Ok((_, address)) => address,
                            Err(_) if worker_stop.load(Ordering::Acquire) => return Ok(()),
                            Err(error) => return Err(error),
                        };
                        if !matches!(address.event(), 3 | 4 | 6 | 7)
                            || !matches!(address.protocol(), 6 | 17)
                        {
                            return Err(Error::invalid("Unexpected WinDivert socket metadata."));
                        }
                        worker_queue.add(SocketEvent::from_address(address)?)?;
                        changed.notify_one();
                    }
                    Ok(())
                };
                let result = catch_unwind(AssertUnwindSafe(run))
                    .unwrap_or_else(|_| Err(Error::invalid("Socket observer thread panicked.")));
                if let Err(error) = result {
                    let _ = worker_queue.fail(error);
                    changed.notify_one();
                }
            })?;
        Ok(Self {
            queue,
            handle,
            stopping,
            reader: Some(reader),
        })
    }
    pub fn drain(&self) -> Result<Vec<SocketEvent>> {
        self.queue.drain(|| Ok(()))
    }
    pub fn close(&mut self) -> Result<()> {
        let Some(reader) = self.reader.take() else {
            return Ok(());
        };
        self.stopping.store(true, Ordering::Release);
        let shutdown = self.handle.shutdown(1);
        reader
            .join()
            .map_err(|_| Error::invalid("Socket observer thread panicked."))?;
        shutdown
    }
}
impl Drop for SocketEvents {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
