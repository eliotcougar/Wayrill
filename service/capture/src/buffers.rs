// SPDX-License-Identifier: GPL-3.0-only
//! Bounded reusable packet storage and byte accounting. Queue rejection and
//! cancellation release rentals automatically; no packet payload is cloned.
use crate::{Error, Result};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::mpsc;
#[cfg(feature = "windivert")]
use tokio::sync::watch;
const CLASSES: usize = 12; // 64 .. 131072 bytes
pub struct BufferPool {
    free: Mutex<[Vec<Vec<u8>>; CLASSES]>,
}
impl Default for BufferPool {
    fn default() -> Self {
        Self {
            free: Mutex::new(std::array::from_fn(|_| Vec::new())),
        }
    }
}
impl BufferPool {
    pub fn rent(self: &Arc<Self>, length: usize) -> Result<Buffer> {
        if length > 131072 {
            return Err(Error::invalid("Packet rental exceeds capacity."));
        }
        let capacity = length.max(64).next_power_of_two();
        let class = (capacity.trailing_zeros() - 6) as usize;
        let storage = self
            .free
            .lock()
            .map_err(|_| Error::invalid("Packet pool poisoned."))?[class]
            .pop()
            .unwrap_or_else(|| vec![0; capacity]);
        Ok(Buffer {
            pool: self.clone(),
            storage: Some(storage),
            class,
            length,
        })
    }
}
pub struct Buffer {
    pool: Arc<BufferPool>,
    storage: Option<Vec<u8>>,
    class: usize,
    pub length: usize,
}
impl Buffer {
    pub fn bytes(&self) -> &[u8] {
        &self.storage.as_ref().unwrap()[..self.length]
    }
    pub fn bytes_mut(&mut self) -> &mut [u8] {
        &mut self.storage.as_mut().unwrap()[..self.length]
    }
}
impl Drop for Buffer {
    fn drop(&mut self) {
        if let (Ok(mut free), Some(storage)) = (self.pool.free.lock(), self.storage.take()) {
            if free[self.class].len() < 32 {
                free[self.class].push(storage);
            }
        }
    }
}
struct Permit {
    bytes: Arc<AtomicUsize>,
    length: usize,
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.bytes.fetch_sub(self.length, Ordering::AcqRel);
    }
}
pub struct Envelope<T> {
    value: T,
    _permit: Permit,
}
impl<T> Envelope<T> {
    pub fn value(&self) -> &T {
        &self.value
    }
    pub fn take(self) -> T {
        self.value
    }
}
pub struct Queue<T> {
    sender: mpsc::Sender<Envelope<T>>,
    bytes: Arc<AtomicUsize>,
    limit: usize,
}
impl<T> Clone for Queue<T> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
            bytes: self.bytes.clone(),
            limit: self.limit,
        }
    }
}
impl<T> Queue<T> {
    pub fn new(capacity: usize, byte_limit: usize) -> (Self, mpsc::Receiver<Envelope<T>>) {
        let (sender, receiver) = mpsc::channel(capacity);
        (
            Self {
                sender,
                bytes: Arc::new(AtomicUsize::new(0)),
                limit: byte_limit,
            },
            receiver,
        )
    }
    pub fn try_send(&self, value: T, length: usize) -> bool {
        if self
            .bytes
            .try_update(Ordering::AcqRel, Ordering::Acquire, |bytes| {
                bytes.checked_add(length).filter(|n| *n <= self.limit)
            })
            .is_err()
        {
            return false;
        }
        self.sender
            .try_send(Envelope {
                value,
                _permit: Permit {
                    bytes: self.bytes.clone(),
                    length,
                },
            })
            .is_ok()
    }
    pub fn queued_bytes(&self) -> usize {
        self.bytes.load(Ordering::Acquire)
    }
}
#[cfg(feature = "windivert")]
pub(crate) async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    if !*receiver.borrow() {
        let _ = receiver.changed().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_limits_count_rejection_and_drain_without_leaks() {
        let (queue, mut receiver) = Queue::new(2, 10);
        assert!(queue.try_send(1, 6));
        assert!(!queue.try_send(2, 5));
        assert!(queue.try_send(3, 4));
        assert!(!queue.try_send(4, 0));
        assert_eq!(queue.queued_bytes(), 10);
        assert_eq!(receiver.try_recv().unwrap().take(), 1);
        assert_eq!(queue.queued_bytes(), 4);
        drop(receiver);
        assert_eq!(queue.queued_bytes(), 0);
        assert!(!queue.try_send(5, 2));
        assert_eq!(queue.queued_bytes(), 0);
    }
    #[test]
    fn rental_reuses_initialized_storage_but_never_exposes_its_tail() {
        let pool = Arc::new(BufferPool::default());
        let mut a = pool.rent(1200).unwrap();
        a.bytes_mut().fill(7);
        let pointer = a.bytes().as_ptr();
        drop(a);
        let b = pool.rent(1100).unwrap();
        assert_eq!(pointer, b.bytes().as_ptr());
        assert_eq!(b.bytes().len(), 1100);
        assert!(pool.rent(131073).is_err());
    }
}
