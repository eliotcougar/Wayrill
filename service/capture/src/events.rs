// SPDX-License-Identifier: GPL-3.0-only
use crate::{Error, Result};
use std::{collections::VecDeque, sync::Mutex};
const CAPACITY: usize = 32768;
const BYTE_CAPACITY: usize = 16 * 1024 * 1024;
struct State<T> {
    items: VecDeque<(T, usize)>,
    bytes: usize,
    failure: Option<Error>,
    overflowed: bool,
}
#[derive(Debug)]
pub struct EventBatch<T> {
    pub items: Vec<T>,
    pub discontinuity: bool,
}
/// Loss is fatal unless the consumer explicitly reconciles native identity
/// history. Health/flush callbacks run outside the ingress lock.
pub struct EventQueue<T> {
    name: &'static str,
    state: Mutex<State<T>>,
}

impl<T> EventQueue<T> {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            state: Mutex::new(State {
                items: VecDeque::new(),
                bytes: 0,
                failure: None,
                overflowed: false,
            }),
        }
    }
    pub fn add(&self, item: T) -> Result<()> {
        self.add_sized(item, std::mem::size_of::<T>())
    }
    pub fn add_sized(&self, item: T, bytes: usize) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("Attribution event ingress poisoned."))?;
        if state.failure.is_none() {
            if state.items.len() == CAPACITY || bytes > BYTE_CAPACITY.saturating_sub(state.bytes) {
                state.overflowed = true;
            } else {
                state.bytes += bytes;
                state.items.push_back((item, bytes));
            }
        }
        Ok(())
    }
    pub fn fail(&self, error: Error) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("Attribution event ingress poisoned."))?;
        if state.failure.is_none() {
            state.failure = Some(error);
        }
        Ok(())
    }
    pub fn drain(&self, check_health: impl FnOnce() -> Result<()>) -> Result<Vec<T>> {
        self.drain_inner(|| check_health().map(|()| false), false)
            .map(|batch| batch.items)
    }
    /// Only a consumer that rebuilds a complete native snapshot may acknowledge
    /// lost events. Malformed input/native failures remain terminal.
    pub fn drain_reconciling(
        &self,
        check_health: impl FnOnce() -> Result<bool>,
    ) -> Result<EventBatch<T>> {
        self.drain_inner(check_health, true)
    }
    fn drain_inner(
        &self,
        check_health: impl FnOnce() -> Result<bool>,
        reconcile: bool,
    ) -> Result<EventBatch<T>> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| Error::invalid("Attribution event ingress poisoned."))?;
            if let Some(error) = &state.failure {
                return Err(self.observation_error(error));
            }
        }
        let discontinuity = match check_health() {
            Ok(discontinuity) => discontinuity,
            Err(error) => {
                self.fail(error)?;
                false
            }
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::invalid("Attribution event ingress poisoned."))?;
        if let Some(error) = &state.failure {
            return Err(self.observation_error(error));
        }
        let discontinuity = discontinuity || state.overflowed;
        if discontinuity && !reconcile {
            let error = Error::invalid("Application-routing event queue overflowed.");
            state.failure = Some(error.clone());
            return Err(self.observation_error(&error));
        }
        state.overflowed = false;
        state.bytes = 0;
        Ok(EventBatch {
            items: state.items.drain(..).map(|(item, _)| item).collect(),
            discontinuity,
        })
    }
    fn observation_error(&self, error: &Error) -> Error {
        Error::invalid(format!(
            "Application-routing {} observation failed: {error}",
            self.name
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loss_requires_reconciliation_and_is_acknowledged_once() {
        let queue = EventQueue::new("process");
        for value in 0..=CAPACITY {
            queue.add(value).unwrap();
        }
        let batch = queue.drain_reconciling(|| Ok(false)).unwrap();
        assert!(batch.discontinuity);
        assert_eq!(batch.items.len(), CAPACITY);
        queue.add(42).unwrap();
        let batch = queue.drain_reconciling(|| Ok(false)).unwrap();
        assert!(!batch.discontinuity);
        assert_eq!(batch.items, [42]);
    }

    #[test]
    fn non_reconciling_consumers_and_malformed_events_still_fail_closed() {
        let queue = EventQueue::new("socket");
        for _ in 0..=CAPACITY {
            queue.add(()).unwrap();
        }
        assert!(queue.drain(|| Ok(())).is_err());
        assert!(queue.drain_reconciling(|| Ok(false)).is_err());
        let queue = EventQueue::<()>::new("process");
        queue.fail(Error::invalid("Malformed event")).unwrap();
        assert!(queue
            .drain_reconciling(|| Ok(true))
            .unwrap_err()
            .to_string()
            .contains("Malformed event"));
    }

    #[test]
    fn health_callback_can_deliver_events_while_reporting_loss() {
        let queue = EventQueue::new("process");
        let batch = queue
            .drain_reconciling(|| {
                queue.add(7)?;
                Ok(true)
            })
            .unwrap();
        assert!(batch.discontinuity);
        assert_eq!(batch.items, [7]);
    }
    #[test]
    fn variable_size_events_are_bounded_by_bytes_before_the_count_limit() {
        let queue = EventQueue::new("process");
        queue.add_sized(1, BYTE_CAPACITY).unwrap();
        queue.add_sized(2, 1).unwrap();
        let batch = queue.drain_reconciling(|| Ok(false)).unwrap();
        assert!(batch.discontinuity);
        assert_eq!(batch.items, [1]);
        queue.add_sized(3, 1).unwrap();
        let batch = queue.drain_reconciling(|| Ok(false)).unwrap();
        assert!(!batch.discontinuity);
        assert_eq!(batch.items, [3]);
    }
}
