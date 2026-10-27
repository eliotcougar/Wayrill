//! Opt-in real-core matrix. Run only inside the authorized QA guest.
use super::*;
use std::{io::Write, net::UdpSocket};

#[test]
#[ignore = "Requires WAYRILL_VM_UDP_TESTS=1, guest interface/address and the pinned test core"]
fn udp_uses_selected_direct_socks_policy_and_chain_without_native_fallback() {
    assert_eq!(std::env::var("WAYRILL_VM_UDP_TESTS").as_deref(), Ok("1"));
    let exe = PathBuf::from(std::env::var_os("WAYRILL_XRAY_TEST_EXE").expect("Pinned core"));
    let ip = std::env::var("WAYRILL_VM_TEST_ADDRESS").expect("Guest address");
    let interface = std::env::var("WAYRILL_VM_TEST_INTERFACE").expect("Guest interface");
    assert!(ip.parse::<std::net::IpAddr>().is_ok());
    let tcp = TcpListener::bind((ip.as_str(), 0)).unwrap();
    tcp.set_nonblocking(true).unwrap();
    let test_url = format!("http://{}:{}/health", ip, tcp.local_addr().unwrap().port());
    let udp = UdpSocket::bind((ip.as_str(), 0)).unwrap();
    udp.set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let udp_port = udp.local_addr().unwrap().port();
    let stop_peer = Arc::new(AtomicBool::new(false));
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let tcp_stop = stop_peer.clone();
    let tcp_thread = std::thread::spawn(move || {
        while !tcp_stop.load(Ordering::SeqCst) {
            match tcp.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut bytes = [0; 4096];
                    let _ = stream.read(&mut bytes);
                    let _ =
                        stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => panic!("HTTP fixture: {e}"),
            }
        }
    });
    let udp_stop = stop_peer.clone();
    let udp_count = count.clone();
    let udp_thread = std::thread::spawn(move || {
        let mut bytes = [0; 4096];
        while !udp_stop.load(Ordering::SeqCst) {
            match udp.recv_from(&mut bytes) {
                Ok((n, from)) => {
                    udp_count.fetch_add(1, Ordering::SeqCst);
                    let reply = if n == 20 && bytes[..4] == [0, 1, 0, 0] {
                        [
                            &[1, 1, 0, 12][..],
                            &bytes[4..20],
                            &[0, 0x20, 0, 8, 0, 1, 0x12, 0x34, 1, 2, 3, 4],
                        ]
                        .concat()
                    } else if n >= 12 {
                        let mut response = bytes[..n].to_vec();
                        response[2] = 0x81;
                        response[3] = 0x80;
                        response[7] = 1;
                        response.extend_from_slice(&[
                            0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 0, 2, 1,
                        ]);
                        response
                    } else {
                        continue;
                    };
                    udp.send_to(&reply, from).unwrap();
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(e) => panic!("UDP fixture: {e}"),
            }
        }
    });
    // RAII keeps failed assertions from stranding fixture threads or sockets.
    struct Peers(Arc<AtomicBool>, Vec<std::thread::JoinHandle<()>>);
    impl Drop for Peers {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
            for worker in self.1.drain(..) {
                let _ = worker.join();
            }
        }
    }
    let _peers = Peers(stop_peer, vec![tcp_thread, udp_thread]);
    let http_reserve = TcpListener::bind((ip.as_str(), 0)).unwrap();
    let http_port = http_reserve.local_addr().unwrap().port();
    let socks_reserve = TcpListener::bind((ip.as_str(), 0)).unwrap();
    let socks_port = socks_reserve.local_addr().unwrap().port();
    let direct = json!({"tag":"root","protocol":"freedom","streamSettings":{"sockopt":{"interface":interface}}});
    let relay_config = json!({"log":{"loglevel":"none","access":"none"},
        "inbounds":[{"tag":"http","protocol":"http","listen":ip,"port":http_port},
            {"tag":"socks","protocol":"socks","listen":ip,"port":socks_port,"settings":{"auth":"noauth","udp":true}}],
        "outbounds":[direct.clone()]});
    drop(http_reserve);
    drop(socks_reserve);
    let relay = spawn_core(
        &exe,
        CoreIdentity::LocalService,
        &relay_config,
        false,
        None,
        0,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !crate::sockets::listeners()
        .unwrap()
        .iter()
        .any(|e| e.pid == relay.pid && e.endpoint.address.port() == socks_port)
    {
        assert!(
            Instant::now() < deadline && relay.exit_code().unwrap().is_none(),
            "Relay did not start"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let stop = AtomicBool::new(false);
    let stun = format!("stun://{ip}:{udp_port}");
    let dns = format!("dns://{ip}:{udp_port}");
    let mut probe = Probe {
        test: &test_url,
        country: "",
        exe: &exe,
        owner: "",
        stop: &stop,
        egress: None,
        mode: Mode::Latency,
        speed_url: "",
        active: None,
        udp_url: &stun,
    };
    let mut target = Target {
        id: "direct".into(),
        outbound_tag: "root".into(),
        config: json!({"outbounds":[direct.clone()]}),
    };
    let result = run(&target, &probe).unwrap();
    assert!(
        result.latency_ms.is_some() && result.udp.as_ref().unwrap().reachable,
        "Direct STUN: {}",
        serde_json::to_string(&result).unwrap()
    );
    probe.udp_url = &dns;
    assert!(
        run(&target, &probe).unwrap().udp.unwrap().reachable,
        "Direct DNS"
    );
    probe.udp_url = "";
    assert!(
        run(&target, &probe).unwrap().udp.is_none(),
        "Unrequested UDP check"
    );
    probe.udp_url = &stun;
    let socks = json!({"tag":"root","protocol":"socks","settings":{"address":ip,"port":socks_port},"streamSettings":{"sockopt":{"interface":interface}}});
    target.id = "socks".into();
    target.config = json!({"outbounds":[socks.clone()]});
    let result = run(&target, &probe).unwrap();
    assert!(
        result.latency_ms.is_some() && result.udp.as_ref().unwrap().reachable,
        "SOCKS: {}",
        serde_json::to_string(&result).unwrap()
    );
    let mut hop = socks.clone();
    hop["tag"] = json!("hop");
    let mut chain = direct.clone();
    chain["streamSettings"]["sockopt"]["dialerProxy"] = json!("hop");
    target.id = "chain".into();
    target.config = json!({"outbounds":[chain,hop]});
    let result = run(&target, &probe).unwrap();
    assert!(
        result.latency_ms.is_some() && result.udp.as_ref().unwrap().reachable,
        "Chain: {}",
        serde_json::to_string(&result).unwrap()
    );
    target.id = "policy".into();
    target.config = json!({"outbounds":[direct.clone(),{"tag":"policy","protocol":"loopback","settings":{"inboundTag":"policy-input"}}],
        "routing":{"balancers":[{"tag":"pool","selector":["root"],"strategy":{"type":"roundRobin"}}],
            "rules":[{"type":"field","inboundTag":["policy-input"],"balancerTag":"pool"}]}});
    target.outbound_tag = "policy".into();
    let result = run(&target, &probe).unwrap();
    assert!(
        result.latency_ms.is_some() && result.udp.as_ref().unwrap().reachable,
        "Policy: {}",
        serde_json::to_string(&result).unwrap()
    );
    target.id = "tcp-only".into();
    target.outbound_tag = "root".into();
    target.config = json!({"outbounds":[{"tag":"root","protocol":"http","settings":{"address":ip,"port":http_port},"streamSettings":{"sockopt":{"interface":interface}}}]});
    let before = count.load(Ordering::SeqCst);
    let result = run(&target, &probe).unwrap();
    assert!(
        result.latency_ms.is_some() && !result.udp.as_ref().unwrap().reachable,
        "TCP-only: {}",
        serde_json::to_string(&result).unwrap()
    );
    assert_eq!(
        count.load(Ordering::SeqCst),
        before,
        "Unsupported UDP escaped through Direct"
    );
    target.id = "block".into();
    target.config = json!({"outbounds":[{"tag":"root","protocol":"blackhole"}]});
    let result = run(&target, &probe).unwrap();
    assert!(
        result.latency_ms.is_none() && !result.udp.as_ref().unwrap().reachable,
        "Block"
    );
    assert_eq!(
        count.load(Ordering::SeqCst),
        before,
        "Block escaped through Direct"
    );
    // UDP remains independently useful when the HTTP endpoint is down.
    let unused = TcpListener::bind((ip.as_str(), 0)).unwrap();
    let dead_url = format!(
        "http://{ip}:{}/unavailable",
        unused.local_addr().unwrap().port()
    );
    drop(unused);
    probe.test = &dead_url;
    target.config = json!({"outbounds":[direct]});
    let result = run(&target, &probe).unwrap();
    assert!(
        result.latency_ms.is_none() && result.udp.as_ref().unwrap().reachable,
        "UDP with failed HTTP"
    );
    println!("Direct STUN/DNS, SOCKS, chain, policy, optional-off, TCP-only, Block and independent HTTP/UDP results passed; unsupported paths sent zero UDP packets to the peer.");
}
