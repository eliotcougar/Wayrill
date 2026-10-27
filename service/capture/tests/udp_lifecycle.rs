// SPDX-License-Identifier: GPL-3.0-only
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{mpsc, watch},
};
use wayrill_capture::{
    buffers::BufferPool,
    policy::{Endpoint, Identity, Input, InterfaceOptions, Plan, SharedPolicy, Target},
    socks,
    udp::{Owner, Session},
    Error, Result,
};

struct IdentityOwner {
    allowed: AtomicBool,
    fresh: AtomicBool,
    invalid: AtomicBool,
    refreshes: AtomicUsize,
    updates: watch::Sender<u64>,
    replies: mpsc::UnboundedSender<(SocketAddr, Vec<u8>)>,
}
impl IdentityOwner {
    fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>) {
        let (updates, _) = watch::channel(0);
        let (replies, rx) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                allowed: AtomicBool::new(true),
                fresh: AtomicBool::new(true),
                invalid: AtomicBool::new(false),
                refreshes: AtomicUsize::new(0),
                updates,
                replies,
            }),
            rx,
        )
    }
    fn fresh(&self, value: bool) {
        self.fresh.store(value, Ordering::Release);
        self.updates.send_modify(|n| *n += 1);
    }
}
impl Owner for IdentityOwner {
    fn can_send(&self) -> Result<bool> {
        Ok(self.allowed.load(Ordering::Acquire))
    }
    fn current(&self) -> Result<bool> {
        Ok(self.fresh.load(Ordering::Acquire)
            && self.allowed.load(Ordering::Acquire)
            && !self.invalid.load(Ordering::Acquire))
    }
    fn invalidated(&self) -> Result<bool> {
        Ok(self.invalid.load(Ordering::Acquire))
    }
    fn updates(&self) -> watch::Receiver<u64> {
        self.updates.subscribe()
    }
    fn refresh(&self) {
        self.refreshes.fetch_add(1, Ordering::Relaxed);
    }
    fn deliver(self: Arc<Self>, peer: SocketAddr, payload: &[u8]) -> Result<()> {
        self.replies
            .send((peer, payload.to_vec()))
            .map_err(|_| Error::invalid("Test receiver closed"))
    }
}
fn target(port: u16) -> Arc<Target> {
    let policy = SharedPolicy::new(Plan {
        inputs: vec![Input {
            tag: "QA".into(),
            selectors: vec![],
            ports: String::new(),
            networks: vec!["udp".into()],
            endpoint: Endpoint {
                port,
                username: "fixture".into(),
                password: "secret".into(),
            },
            predicates: vec![],
            masks: vec!["0".into()],
        }],
        interfaces: InterfaceOptions::default(),
        bypass_local_traffic: true,
    })
    .unwrap();
    policy
        .select(&[Identity::new("fixture.exe", None, Some(""))], None)
        .unwrap()
        .unwrap()
}
async fn association(listener: TcpListener) -> (TcpStream, UdpSocket) {
    let (mut control, _) = listener.accept().await.unwrap();
    let mut greeting = [0; 3];
    control.read_exact(&mut greeting).await.unwrap();
    assert_eq!(greeting, [5, 1, 2]);
    control.write_all(&[5, 2]).await.unwrap();
    assert_eq!(control.read_u8().await.unwrap(), 1);
    let n = control.read_u8().await.unwrap();
    let mut user = vec![0; n as usize];
    control.read_exact(&mut user).await.unwrap();
    assert_eq!(user, b"wr-0-fixture");
    let n = control.read_u8().await.unwrap();
    let mut password = vec![0; n as usize];
    control.read_exact(&mut password).await.unwrap();
    assert_eq!(password, b"secret");
    control.write_all(&[1, 0]).await.unwrap();
    let mut request = [0; 10];
    control.read_exact(&mut request).await.unwrap();
    assert_eq!(&request[..4], &[5, 3, 0, 1]);
    let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = udp.local_addr().unwrap().port();
    let mut reply = vec![5, 0, 0, 1, 127, 0, 0, 1];
    reply.extend(port.to_be_bytes());
    control.write_all(&reply).await.unwrap();
    (control, udp)
}
async fn send_reply(socket: &UdpSocket, client: SocketAddr, peer: SocketAddr, payload: &[u8]) {
    let mut reply = vec![0; socks::datagram_header_length(peer) + payload.len()];
    socks::write_datagram(&mut reply, peer, payload).unwrap();
    socket.send_to(&reply, client).await.unwrap();
}
#[tokio::test]
async fn ipv4_and_ipv6_payloads_relay_and_control_eof_closes_association() {
    for peer in ["203.0.113.8:7", "[2001:db8::8]:7"] {
        let peer: SocketAddr = peer.parse().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rule = target(listener.local_addr().unwrap().port());
        let (owner, mut replies) = IdentityOwner::new();
        let (_stop, stopping) = watch::channel(false);
        let errors = Arc::new(Mutex::new(Vec::new()));
        let reported = errors.clone();
        let (session, task) = Session::start(
            &tokio::runtime::Handle::current(),
            rule,
            peer,
            owner,
            stopping,
            Arc::new(BufferPool::default()),
            Arc::new(move |e| reported.lock().unwrap().push(e)),
        );
        assert!(session.send(peer, b"payload").unwrap());
        let (mut control, udp) =
            tokio::time::timeout(Duration::from_secs(2), association(listener))
                .await
                .unwrap();
        let mut data = [0; 256];
        let (n, client) = udp.recv_from(&mut data).await.unwrap();
        assert_eq!(
            socks::unwrap_datagram(&data[..n]),
            Some((peer, b"payload".as_slice()))
        );
        send_reply(&udp, client, peer, b"answer").await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), replies.recv())
                .await
                .unwrap()
                .unwrap(),
            (peer, b"answer".to_vec())
        );
        control.shutdown().await.unwrap();
        drop(control);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!session.usable().unwrap());
        assert!(!session.send(peer, b"late").unwrap());
        assert_eq!(errors.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn stale_owner_waits_for_publication_but_revocation_never_releases_a_reply() {
    let peer: SocketAddr = "203.0.113.8:7".parse().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rule = target(listener.local_addr().unwrap().port());
    let (owner, mut replies) = IdentityOwner::new();
    let (stop, stopping) = watch::channel(false);
    let (session, task) = Session::start(
        &tokio::runtime::Handle::current(),
        rule,
        peer,
        owner.clone(),
        stopping,
        Arc::new(BufferPool::default()),
        Arc::new(|e| panic!("Unexpected relay error: {e}")),
    );
    assert!(session.send(peer, b"first").unwrap());
    let (control, udp) = association(listener).await;
    let mut data = [0; 256];
    let (_, client) = udp.recv_from(&mut data).await.unwrap();
    owner.fresh(false);
    send_reply(&udp, client, peer, b"waiting").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(70), replies.recv())
            .await
            .is_err()
    );
    assert!(owner.refreshes.load(Ordering::Acquire) > 0);
    assert!(!session.can_retire().unwrap());
    owner.fresh(true);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), replies.recv())
            .await
            .unwrap()
            .unwrap()
            .1,
        b"waiting"
    );
    owner.fresh(false);
    send_reply(&udp, client, peer, b"revoked").await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    owner.allowed.store(false, Ordering::Release);
    owner.invalid.store(true, Ordering::Release);
    owner.updates.send_modify(|n| *n += 1);
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert!(replies.try_recv().is_err());
    assert!(!session.usable().unwrap());
    stop.send_replace(true);
    drop(control);
}
#[tokio::test]
async fn queue_bytes_stay_bounded_during_stalled_setup_and_prior_cancellation_is_seen() {
    let peer: SocketAddr = "203.0.113.8:7".parse().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rule = target(listener.local_addr().unwrap().port());
    let (owner, _) = IdentityOwner::new();
    let (stop, stopping) = watch::channel(false);
    let (session, task) = Session::start(
        &tokio::runtime::Handle::current(),
        rule.clone(),
        peer,
        owner.clone(),
        stopping,
        Arc::new(BufferPool::default()),
        Arc::new(|e| panic!("Unexpected relay error: {e}")),
    );
    let payload = vec![7; 2000];
    for _ in 0..65 {
        assert!(session.send(peer, &payload).unwrap());
    }
    assert!(!session.send(peer, &payload).unwrap());
    stop.send_replace(true);
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert!(!session.usable().unwrap());
    let (_stop, stopping) = watch::channel(true);
    let (session, task) = Session::start(
        &tokio::runtime::Handle::current(),
        rule,
        peer,
        owner,
        stopping,
        Arc::new(BufferPool::default()),
        Arc::new(|e| panic!("Unexpected relay error: {e}")),
    );
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert!(!session.usable().unwrap());
}

#[tokio::test(flavor = "current_thread")]
async fn abort_before_first_poll_marks_the_session_finished() {
    let peer = "203.0.113.8:7".parse().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (owner, _) = IdentityOwner::new();
    let (_stop, stopping) = watch::channel(false);
    let (session, task) = Session::start(
        &tokio::runtime::Handle::current(),
        target(listener.local_addr().unwrap().port()),
        peer,
        owner,
        stopping,
        Arc::new(BufferPool::default()),
        Arc::new(|_| {}),
    );
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(
        session.can_retire().unwrap(),
        "An unpolled cancelled task must release its session slot"
    );
    assert!(!session.usable().unwrap());
    assert!(!session.send(peer, b"late").unwrap());
}

#[tokio::test(flavor = "current_thread")]
async fn already_cancelled_sessions_never_open_a_relay_connection() {
    let peer = "203.0.113.8:7".parse().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rule = target(listener.local_addr().unwrap().port());
    let (owner, _) = IdentityOwner::new();
    let (_stop, stopping) = watch::channel(true);
    for _ in 0..64 {
        let (session, task) = Session::start(
            &tokio::runtime::Handle::current(),
            rule.clone(),
            peer,
            owner.clone(),
            stopping.clone(),
            Arc::new(BufferPool::default()),
            Arc::new(|_| {}),
        );
        task.await.unwrap();
        assert!(session.can_retire().unwrap());
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err(),
        "Cancellation must win over starting socket work"
    );
}
