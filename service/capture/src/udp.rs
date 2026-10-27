// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    buffers::{cancelled, Buffer, BufferPool, Envelope, Queue},
    policy::Target,
    socks::{self, BoundAddress},
    Error, Result,
};
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    net::{TcpStream, UdpSocket},
    runtime::Handle,
    sync::{mpsc, watch},
    task::JoinHandle,
};

pub trait Owner: Send + Sync {
    fn can_send(&self) -> Result<bool>;
    fn current(&self) -> Result<bool>;
    fn invalidated(&self) -> Result<bool>;
    fn updates(&self) -> watch::Receiver<u64>;
    fn refresh(&self);
    fn deliver(self: Arc<Self>, peer: SocketAddr, payload: &[u8]) -> Result<()>;
}
pub type Report = Arc<dyn Fn(Error) + Send + Sync>;
struct Datagram {
    bytes: Buffer,
}
pub struct Session {
    pub rule: Arc<Target>,
    queue: Queue<Datagram>,
    stop: watch::Sender<bool>,
    done: Arc<AtomicBool>,
    owner: Arc<dyn Owner>,
    pool: Arc<BufferPool>,
}
impl Session {
    pub fn start(
        runtime: &Handle,
        rule: Arc<Target>,
        destination: SocketAddr,
        owner: Arc<dyn Owner>,
        mut engine_stop: watch::Receiver<bool>,
        pool: Arc<BufferPool>,
        report: Report,
    ) -> (Arc<Self>, JoinHandle<()>) {
        let (queue, receiver) = Queue::new(128, 128 * 1024);
        let (stop, mut stopping) = watch::channel(false);
        let done = Arc::new(AtomicBool::new(false));
        let session = Arc::new(Self {
            rule: rule.clone(),
            queue,
            stop,
            done: done.clone(),
            owner: owner.clone(),
            pool,
        });
        struct Finished(Arc<AtomicBool>);
        impl Drop for Finished {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        // Capture the guard in the future itself: aborting before its first
        // poll must still publish completion and allow the slot to be reaped.
        let finished = Finished(done);
        let task = runtime.spawn(async move {
            let _finished = finished;
            let result = tokio::select! {
                biased;
                _=cancelled(&mut engine_stop)=>Ok(()),
                _=cancelled(&mut stopping)=>Ok(()),
                result=run(rule,destination,owner,receiver,report.clone())=>result,
            };
            if let Err(error) = result {
                report(error);
            }
        });
        (session, task)
    }
    pub fn usable(&self) -> Result<bool> {
        Ok(!*self.stop.borrow()
            && !self.done.load(Ordering::Acquire)
            && self.owner.can_send()?
            && !self.owner.invalidated()?)
    }
    pub fn can_retire(&self) -> Result<bool> {
        if self.done.load(Ordering::Acquire) || !self.owner.can_send()? {
            return Ok(true);
        }
        self.owner.current()?;
        self.owner.invalidated()
    }
    pub fn send(&self, peer: SocketAddr, payload: &[u8]) -> Result<bool> {
        if !self.usable()? {
            self.cancel();
            return Ok(false);
        }
        if self.queue.queued_bytes().saturating_add(payload.len()) > 128 * 1024 {
            return Ok(false);
        }
        let mut bytes = self
            .pool
            .rent(socks::datagram_header_length(peer) + payload.len())?;
        socks::write_datagram(bytes.bytes_mut(), peer, payload)?;
        Ok(self.queue.try_send(Datagram { bytes }, payload.len()))
    }
    pub fn cancel(&self) {
        self.stop.send_replace(true);
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.cancel();
    }
}
async fn connect(rule: &Target) -> Result<(TcpStream, UdpSocket)> {
    let endpoint = rule
        .endpoint
        .as_ref()
        .ok_or_else(|| Error::invalid("UDP route lacks a concrete relay."))?;
    let mut control = socks::connect_proxy(endpoint).await?;
    let local = control.local_addr()?.ip();
    let socket = UdpSocket::bind(SocketAddr::new(local, 0)).await?;
    let options = socket2::SockRef::from(&socket);
    options.set_recv_buffer_size(256 * 1024)?;
    options.set_send_buffer_size(256 * 1024)?;
    let relay = match socks::request(&mut control, 3, socket.local_addr()?).await? {
        BoundAddress::Ip(address) => address,
        BoundAddress::Domain(name, port) => tokio::net::lookup_host((name.as_str(), port))
            .await?
            .find(|a| a.is_ipv6() == local.is_ipv6())
            .ok_or_else(|| Error::invalid("Invalid SOCKS5 UDP relay family."))?,
    };
    if relay.is_ipv6() != local.is_ipv6() {
        return Err(Error::invalid("Invalid SOCKS5 UDP relay family."));
    }
    socket.connect(relay).await?;
    Ok((control, socket))
}
async fn wait_owner(owner: &dyn Owner) -> Result<bool> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
    let mut changed = owner.updates();
    loop {
        if owner.current()? {
            return Ok(true);
        }
        if owner.invalidated()? {
            return Ok(false);
        }
        owner.refresh();
        if tokio::time::timeout_at(deadline, changed.changed())
            .await
            .is_err()
        {
            return Ok(false);
        }
        if changed.has_changed().is_err() {
            return Ok(false);
        }
    }
}
async fn run(
    rule: Arc<Target>,
    destination: SocketAddr,
    owner: Arc<dyn Owner>,
    mut queue: mpsc::Receiver<Envelope<Datagram>>,
    report: Report,
) -> Result<()> {
    let (mut control, socket) = tokio::time::timeout(Duration::from_secs(15), connect(&rule))
        .await
        .map_err(|_| Error::invalid("UDP route connection timed out."))??;
    let receive = async {
        let mut bytes = vec![0; 65535];
        loop {
            let count = socket.recv(&mut bytes).await?;
            let Some((peer, payload)) = socks::unwrap_datagram(&bytes[..count]) else {
                continue;
            };
            if peer.is_ipv6() != destination.is_ipv6() {
                continue;
            }
            if !owner.current()? && !wait_owner(owner.as_ref()).await? {
                if !owner.can_send()? {
                    return Ok(());
                }
                continue;
            }
            if let Err(error) = owner.clone().deliver(peer, payload) {
                report(error);
            }
        }
    };
    let send = async {
        while let Some(item) = queue.recv().await {
            let item = item.take();
            if !owner.can_send()? {
                return Ok(());
            }
            match socket.send(item.bytes.bytes()).await {
                Ok(count) if count == item.bytes.length => {}
                Ok(_) => return Err(Error::invalid("SOCKS5 datagram send was incomplete.")),
                Err(error) if error.raw_os_error() == Some(10040) => report(error.into()),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    };
    let watch = async {
        let _count = control.read(&mut [0]).await?;
        Err(Error::invalid("SOCKS5 UDP association closed."))
    };
    tokio::select! {result=receive=>result,result=send=>result,result=watch=>result}
}
