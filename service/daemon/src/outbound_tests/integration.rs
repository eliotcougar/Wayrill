//! VM-only real-core regression. All listeners and both test cores are private;
//! no applied configuration, adapter, sharing or Windows setting is changed.
use super::*;
use std::io::Write;

#[test]
#[ignore = "Requires WAYRILL_VM_SPEED_TESTS=1 and the pinned WAYRILL_XRAY_TEST_EXE in the QA guest"]
fn speed_uses_the_running_policy_winner_without_changing_its_selection() {
    assert_eq!(std::env::var("WAYRILL_VM_SPEED_TESTS").as_deref(), Ok("1"));
    let exe = PathBuf::from(std::env::var_os("WAYRILL_XRAY_TEST_EXE").expect("Pinned test core"));
    let loopback = crate::tun::loopback_interface().unwrap();
    let target = Target {
        id: "policy".into(),
        outbound_tag: "test-policy".into(),
        config: json!({
            "outbounds":[
                {"tag":"blocked","protocol":"blackhole"},
                {"tag":"winner","protocol":"freedom","streamSettings":{"sockopt":{"interface":loopback}}},
                {"tag":"test-policy","protocol":"loopback","settings":{"inboundTag":"policy-route"}}
            ],
            "routing":{"rules":[{"type":"field","inboundTag":["policy-route"],"balancerTag":"pool"}],
                "balancers":[{"tag":"pool","selector":["blocked","winner"],"strategy":{"type":"roundRobin"}}]}
        }),
    };
    let port = TcpListener::bind("127.0.0.1:0").unwrap();
    let authored = test_config(&target, port.local_addr().unwrap().port(), "fixture").unwrap();
    let mut projected = authored.clone();
    crate::loopback::Policy::apply(&mut projected, &loopback).unwrap();
    let control = crate::live::Control::new(&projected).unwrap();
    drop(port);
    let core = spawn_core(
        &exe,
        CoreIdentity::LocalService,
        &control.config,
        false,
        None,
        0,
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        assert!(
            core.exit_code().unwrap().is_none(),
            "Active fixture core exited"
        );
        if runtime.block_on(control.balancer_selection("pool")).is_ok() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Private RoutingService did not become ready"
        );
        std::thread::sleep(Duration::from_millis(30));
    }
    runtime
        .block_on(control.pin_test_balancer("pool", "winner"))
        .unwrap();
    let active = ActivePolicy {
        control: control.clone(),
        config: Arc::new(authored),
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/download",
        listener.local_addr().unwrap().port()
    );
    listener.set_nonblocking(true).unwrap();
    let peer = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(25);
        let mut stream = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => panic!("Selected member did not reach the peer: {e}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 2048];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buffer).unwrap();
            assert!(n > 0 && request.len() < 16384);
            request.extend_from_slice(&buffer[..n]);
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 262144\r\nConnection: close\r\n\r\n")
            .unwrap();
        for _ in 0..8 {
            stream.write_all(&[0x55; 32768]).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let stop = AtomicBool::new(false);
    let mut probe = Probe {
        test: "",
        country: "",
        exe: &exe,
        owner: "",
        stop: &stop,
        egress: None,
        mode: Mode::Speed,
        speed_url: &url,
        active: None,
        udp_url: "",
    };
    // A fresh round-robin group starts at Block. Passing this control establishes
    // that success below comes from the live winner, not native loopback bypass.
    assert!(
        run(&target, &probe).is_err(),
        "An explicit Block unexpectedly passed the test"
    );
    probe.active = Some(&active);
    let result = run(&target, &probe).unwrap();
    peer.join().unwrap();
    assert_eq!(result.speed.unwrap().bytes, 262144);
    assert!(result.error.is_none());
    assert_eq!(
        runtime
            .block_on(control.balancer_selection("pool"))
            .unwrap()
            .override_target,
        "winner"
    );
    assert!(core.exit_code().unwrap().is_none());
}
