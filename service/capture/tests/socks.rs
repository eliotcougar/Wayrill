// SPDX-License-Identifier: GPL-3.0-only
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use wayrill_capture::{
    policy::Endpoint,
    socks::{self, BoundAddress},
};

#[test]
fn datagrams_preserve_canonical_destination_payload_and_buffer_tail() {
    for (address, expected) in [
        ("203.0.113.7:443", "203.0.113.7:443"),
        ("[2001:db8::7]:443", "[2001:db8::7]:443"),
        // Mapped IPv4 addresses use SOCKS' IPv4 representation.
        ("[::ffff:203.0.113.7]:443", "203.0.113.7:443"),
    ] {
        let destination = address.parse().unwrap();
        let mut buffer = [0xa5; 200];
        let output = socks::write_datagram(&mut buffer, destination, &[0, 1, 255]).unwrap();
        let length = output.len();
        let (peer, payload) = socks::unwrap_datagram(output).unwrap();
        assert_eq!(payload, &[0, 1, 255]);
        assert_eq!(peer, expected.parse().unwrap());
        assert_eq!(length, socks::datagram_header_length(destination) + 3);
        assert!(buffer[length..].iter().all(|b| *b == 0xa5));
        buffer[2] = 1;
        assert!(socks::unwrap_datagram(&buffer[..length]).is_none());
    }
}
#[tokio::test]
async fn fragmented_authentication_and_connect_reply_keep_application_bytes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        stream.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 1, 2]);
        stream.write_all(&[5]).await.unwrap();
        stream.write_all(&[2]).await.unwrap();
        assert_eq!(stream.read_u8().await.unwrap(), 1);
        let length = stream.read_u8().await.unwrap();
        let mut user = vec![0; length as usize];
        stream.read_exact(&mut user).await.unwrap();
        assert_eq!(user, "wr-1-🌍".as_bytes());
        let length = stream.read_u8().await.unwrap();
        let mut password = vec![0; length as usize];
        stream.read_exact(&mut password).await.unwrap();
        assert_eq!(password, b"secret");
        stream.write_all(&[1, 0]).await.unwrap();
        let mut request = [0; 10];
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(&request[..4], &[5, 1, 0, 1]);
        // No domain resolution is needed for CONNECT. Reserved .invalid must
        // not make the otherwise successful handshake fail.
        stream.write_all(&[5, 0, 0, 3, 7]).await.unwrap();
        stream.write_all(b"invalid").await.unwrap();
        stream.write_all(&[0, 0, 42]).await.unwrap();
    });
    let endpoint = Endpoint {
        port,
        username: "wr-1-🌍".into(),
        password: "secret".into(),
    };
    let mut stream = socks::connect_tcp(&endpoint, "203.0.113.7:443".parse().unwrap())
        .await
        .unwrap();
    assert_eq!(stream.read_u8().await.unwrap(), 42);
    server.await.unwrap();
}
#[tokio::test]
async fn wrong_authentication_method_and_zero_udp_relay_are_rejected() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        stream.read_exact(&mut greeting).await.unwrap();
        stream.write_all(&[5, 2]).await.unwrap();
    });
    let endpoint = Endpoint {
        port,
        username: String::new(),
        password: String::new(),
    };
    assert!(socks::connect_proxy(&endpoint)
        .await
        .unwrap_err()
        .0
        .contains("method rejected"));
    server.await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        stream.read_exact(&mut greeting).await.unwrap();
        stream.write_all(&[5, 0]).await.unwrap();
        let mut request = [0; 10];
        stream.read_exact(&mut request).await.unwrap();
        stream
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
            .await
            .unwrap();
    });
    let mut stream = socks::connect_proxy(&Endpoint {
        port,
        username: String::new(),
        password: String::new(),
    })
    .await
    .unwrap();
    assert!(
        socks::request(&mut stream, 3, "0.0.0.0:12345".parse().unwrap())
            .await
            .unwrap_err()
            .0
            .contains("UDP relay")
    );
    server.await.unwrap();
}
#[tokio::test]
async fn unspecified_bound_address_uses_owned_relay_peer() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        stream.read_exact(&mut greeting).await.unwrap();
        stream.write_all(&[5, 0]).await.unwrap();
        let mut request = [0; 10];
        stream.read_exact(&mut request).await.unwrap();
        stream
            .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0x30, 0x39])
            .await
            .unwrap();
    });
    let mut stream = socks::connect_proxy(&Endpoint {
        port,
        username: String::new(),
        password: String::new(),
    })
    .await
    .unwrap();
    assert_eq!(
        socks::request(&mut stream, 3, "0.0.0.0:12345".parse().unwrap())
            .await
            .unwrap(),
        BoundAddress::Ip("127.0.0.1:12345".parse().unwrap())
    );
    server.await.unwrap();
}
#[tokio::test]
async fn stalled_handshake_can_be_cancelled_without_leaking_the_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        stream.read_exact(&mut greeting).await.unwrap();
        let mut byte = [0];
        assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
    });
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        socks::connect_proxy(&Endpoint {
            port,
            username: String::new(),
            password: String::new()
        })
    )
    .await
    .is_err());
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}
