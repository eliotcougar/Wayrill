use super::*;
use std::net::TcpListener;

fn stun(nonce: &[u8; 12]) -> Vec<u8> {
    [
        &[1, 1, 0, 12][..],
        &COOKIE,
        nonce,
        &[0, 0x20, 0, 8, 0, 1, 0x12, 0x34, 1, 2, 3, 4],
    ]
    .concat()
}
fn framed(endpoint: &Endpoint, data: &[u8]) -> Vec<u8> {
    [&[0, 0, 0][..], &endpoint.address(), data].concat()
}

#[test]
fn destinations_are_protocol_specific_and_preserve_ipv6_and_custom_ports() {
    for text in [
        "stun://stun.cloudflare.com:3478",
        "dns://9.9.9.9:9953",
        "dns://[::1]:53",
        "stun://localhost",
    ] {
        assert!(Endpoint::parse(text).is_ok(), "{text}");
    }
    for text in [
        "https://example.com",
        "stun://user:pass@host",
        "dns://host/path",
        "dns://host?secret",
        "dns://host#x",
        "stun://host:0",
        "stun://",
        "dns://host:70000",
    ] {
        assert!(Endpoint::parse(text).is_err(), "{text}");
    }
    assert_eq!(
        Endpoint::parse("dns://[::1]:9953").unwrap().address(),
        [&[4][..], &[0; 15], &[1], &9953u16.to_be_bytes()].concat()
    );
}

#[test]
fn stun_requires_a_matching_complete_binding_response_and_unfragmented_source() {
    let endpoint = Endpoint::parse("stun://192.0.2.1:3478").unwrap();
    let nonce = [0x54; 12];
    let good = framed(&endpoint, &stun(&nonce));
    assert!(valid_reply(&good, &endpoint, &nonce));
    for cut in 0..good.len() {
        assert!(!valid_reply(&good[..cut], &endpoint, &nonce));
    }
    for offset in [0, 1, 2, 4, 8, 9, 10, 11, 12, 14, 18, 22, 30] {
        let mut bad = good.clone();
        bad[offset] ^= 1;
        assert!(
            !valid_reply(&bad, &endpoint, &nonce),
            "accepted altered byte {offset}"
        );
    }
    let mut too_long = good.clone();
    too_long.push(0);
    assert!(!valid_reply(&too_long, &endpoint, &nonce));
}

#[test]
fn dns_requires_the_matching_question_and_a_valid_answer_without_tcp_fallback() {
    let nonce = [0x43; 12];
    let mut good = request(Kind::Dns, &nonce);
    good[2] = 0x81;
    good[3] = 0x80;
    good[7] = 1;
    good.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 0, 2, 1]);
    assert!(dns_reply(&good, &nonce));
    for cut in 0..good.len() {
        assert!(!dns_reply(&good[..cut], &nonce));
    }
    for offset in [0, 1, 4, 5, 13, 31, 33, 40] {
        let mut bad = good.clone();
        bad[offset] ^= 1;
        assert!(!dns_reply(&bad, &nonce), "accepted altered byte {offset}");
    }
    let mut truncated = good.clone();
    truncated[2] |= 2;
    assert!(!dns_reply(&truncated, &nonce));
    let mut error = good.clone();
    error[3] |= 3;
    assert!(!dns_reply(&error, &nonce));
    let mut pos = 0;
    assert!(dns_name(&[0xc0, 0], &mut pos).is_none());
}

#[test]
fn exchange_authenticates_and_sends_only_to_the_private_relay() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let endpoint = Endpoint::parse("stun://192.0.2.1:3478").unwrap();
    let nonce = [0x62; 12];
    let response = framed(&endpoint, &stun(&nonce));
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut hello = [0; 3];
        stream.read_exact(&mut hello).unwrap();
        assert_eq!(hello, [5, 1, 2]);
        stream.write_all(&[5, 2]).unwrap();
        let mut auth = [0; 21];
        stream.read_exact(&mut auth).unwrap();
        assert_eq!(&auth, b"\x01\x0cwayrill-test\x06secret");
        stream.write_all(&[1, 0]).unwrap();
        let mut assoc = [0; 10];
        stream.read_exact(&mut assoc).unwrap();
        assert_eq!(&assoc[..8], &[5, 3, 0, 1, 127, 0, 0, 1]);
        let relay = UdpSocket::bind("127.0.0.1:0").unwrap();
        relay
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(
                &[
                    &[5, 0, 0, 1, 127, 0, 0, 1][..],
                    &relay.local_addr().unwrap().port().to_be_bytes(),
                ]
                .concat(),
            )
            .unwrap();
        let mut packet = [0; 128];
        let (n, from) = relay.recv_from(&mut packet).unwrap();
        assert_eq!(from.port(), u16::from_be_bytes([assoc[8], assoc[9]]));
        assert_eq!(
            &packet[..n],
            framed(
                &Endpoint::parse("stun://192.0.2.1:3478").unwrap(),
                &request(Kind::Stun, &nonce)
            )
        );
        let mut wrong = response.clone();
        wrong[18] ^= 1;
        relay.send_to(&wrong, from).unwrap();
        relay.send_to(&response, from).unwrap();
    });
    let result = test(port, "secret", &endpoint, &nonce, &AtomicBool::new(false)).unwrap();
    server.join().unwrap();
    assert!(result.reachable, "{:?}", result.error);
}

#[test]
fn cancellation_interrupts_a_stalled_local_handshake() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let (_stream, _) = listener.accept().unwrap();
            stop.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(250));
        });
        let start = Instant::now();
        let result = test(
            port,
            "secret",
            &Endpoint::parse("stun://192.0.2.1").unwrap(),
            &[0; 12],
            &stop,
        );
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    });
}
