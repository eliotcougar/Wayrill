//! UDP probes always traverse the isolated core's authenticated SOCKS relay.
//! No native destination socket, system resolver or TCP fallback is used.
use super::invalid;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, UdpSocket},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use wayrill_protocol::Result;

const TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);
const COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];

#[derive(Clone, Copy)]
enum Kind {
    Stun,
    Dns,
}
pub(super) struct Endpoint {
    kind: Kind,
    host: url::Host<String>,
    port: u16,
}
impl Endpoint {
    pub fn parse(text: &str) -> Result<Self> {
        let url =
            url::Url::parse(text).map_err(|_| invalid("Enter a valid UDP test destination."))?;
        let (kind, default_port) = match url.scheme() {
            "stun" => (Kind::Stun, 3478),
            "dns" => (Kind::Dns, 53),
            _ => return Err(invalid("Use stun://host:port or dns://host:port.")),
        };
        let host = url::Host::parse(
            url.host_str()
                .ok_or_else(|| invalid("UDP destination has no host."))?,
        )
        .map_err(|_| invalid("UDP destination has an invalid host."))?;
        if text.len() > 2048
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !["", "/"].contains(&url.path())
            || url.port() == Some(0)
            || matches!(&host, url::Host::Domain(h) if h.is_empty() || h.len() > 253 || !h.is_ascii() || h.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace()))
        {
            return Err(invalid(
                "Use stun://host:port or dns://host:port, without credentials, a path or query.",
            ));
        }
        Ok(Self {
            kind,
            host,
            port: url.port().unwrap_or(default_port),
        })
    }
    fn address(&self) -> Vec<u8> {
        let mut bytes = match &self.host {
            url::Host::Ipv4(ip) => [&[1][..], &ip.octets()].concat(),
            url::Host::Ipv6(ip) => [&[4][..], &ip.octets()].concat(),
            url::Host::Domain(host) => [&[3, host.len() as u8][..], host.as_bytes()].concat(),
        };
        bytes.extend_from_slice(&self.port.to_be_bytes());
        bytes
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Measurement {
    pub reachable: bool,
    pub error: Option<String>,
}

pub(super) fn add_inbound(config: &mut Value, port: u16, password: &str, tag: &str) {
    config["inbounds"].as_array_mut().unwrap().push(json!({
        "tag":"wayrill-test-udp", "listen":"127.0.0.1", "port":port,
        "protocol":"socks", "settings":{"auth":"password", "udp":true,
            "accounts":[{"user":"wayrill-test","pass":password}]}
    }));
    config["routing"]["rules"].as_array_mut().unwrap().insert(
        0,
        json!({"type":"field","inboundTag":["wayrill-test-udp"],"outboundTag":tag}),
    );
}

fn cancelled(stop: &AtomicBool, deadline: Instant) -> Result<()> {
    if stop.load(Ordering::SeqCst) {
        Err(invalid("Test cancelled."))
    } else if Instant::now() >= deadline {
        Err(invalid("No valid UDP reply within 5 seconds."))
    } else {
        Ok(())
    }
}
fn read(
    stream: &mut TcpStream,
    mut bytes: &mut [u8],
    stop: &AtomicBool,
    deadline: Instant,
) -> Result<()> {
    while !bytes.is_empty() {
        cancelled(stop, deadline)?;
        match stream.read(bytes) {
            Ok(0) => return Err(invalid("The private UDP relay closed the connection.")),
            Ok(n) => bytes = &mut bytes[n..],
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return Err(invalid("Cannot read from the private UDP relay.")),
        }
    }
    Ok(())
}
// Parse SOCKS address framing without trusting packet lengths. Domain names in
// replies are retained as names; the service must never resolve them natively.
fn address(bytes: &[u8]) -> Option<(Option<IpAddr>, u16, usize)> {
    let (ip, end) = match *bytes.first()? {
        1 => (
            Some(IpAddr::from(<[u8; 4]>::try_from(bytes.get(1..5)?).ok()?)),
            5,
        ),
        4 => (
            Some(IpAddr::from(<[u8; 16]>::try_from(bytes.get(1..17)?).ok()?)),
            17,
        ),
        3 => {
            let n = usize::from(*bytes.get(1)?);
            bytes.get(2..2 + n)?;
            (None, 2 + n)
        }
        _ => return None,
    };
    let port = u16::from_be_bytes(bytes.get(end..end + 2)?.try_into().ok()?);
    Some((ip, port, end + 2))
}

pub(super) fn test(
    port: u16,
    password: &str,
    endpoint: &Endpoint,
    nonce: &[u8; 12],
    stop: &AtomicBool,
) -> Result<Measurement> {
    let checked = exchange(port, password, endpoint, nonce, stop);
    if stop.load(Ordering::SeqCst) {
        return Err(invalid("Test cancelled."));
    }
    Ok(Measurement {
        reachable: checked.is_ok(),
        error: checked.err().map(|e| e.message),
    })
}
fn exchange(
    port: u16,
    password: &str,
    endpoint: &Endpoint,
    nonce: &[u8; 12],
    stop: &AtomicBool,
) -> Result<()> {
    let deadline = Instant::now() + TIMEOUT;
    cancelled(stop, deadline)?;
    let mut control = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), POLL)
        .map_err(|_| invalid("Cannot connect to the private UDP relay."))?;
    control
        .set_read_timeout(Some(POLL))
        .map_err(|_| invalid("Cannot configure the private UDP relay."))?;
    control
        .set_write_timeout(Some(POLL))
        .map_err(|_| invalid("Cannot configure the private UDP relay."))?;
    let write = |stream: &mut TcpStream, bytes: &[u8]| {
        stream
            .write_all(bytes)
            .map_err(|_| invalid("Cannot write to the private UDP relay."))
    };
    write(&mut control, &[5, 1, 2])?;
    let mut reply = [0; 2];
    read(&mut control, &mut reply, stop, deadline)?;
    if reply != [5, 2] {
        return Err(invalid("The private UDP relay refused authentication."));
    }
    let mut auth = vec![1, 12];
    auth.extend_from_slice(b"wayrill-test");
    auth.push(password.len() as u8);
    auth.extend_from_slice(password.as_bytes());
    write(&mut control, &auth)?;
    read(&mut control, &mut reply, stop, deadline)?;
    if reply != [1, 0] {
        return Err(invalid("The private UDP relay refused authentication."));
    }
    let socket = UdpSocket::bind("127.0.0.1:0")
        .map_err(|_| invalid("No local UDP test port is available."))?;
    let mut associate = vec![5, 3, 0, 1, 127, 0, 0, 1];
    associate.extend_from_slice(
        &socket
            .local_addr()
            .map_err(|_| invalid("Cannot read the UDP test port."))?
            .port()
            .to_be_bytes(),
    );
    write(&mut control, &associate)?;
    let mut head = [0; 4];
    read(&mut control, &mut head, stop, deadline)?;
    if head[..3] != [5, 0, 0] {
        return Err(invalid("The private relay does not accept UDP."));
    }
    let size = match head[3] {
        1 => 6,
        4 => 18,
        _ => {
            return Err(invalid(
                "The private UDP relay returned an invalid address.",
            ))
        }
    };
    let mut relay = vec![head[3]];
    relay.resize(size + 1, 0);
    read(&mut control, &mut relay[1..], stop, deadline)?;
    let (Some(ip), relay_port, _) =
        address(&relay).ok_or_else(|| invalid("Invalid UDP relay address."))?
    else {
        return Err(invalid("Invalid UDP relay address."));
    };
    // Only our authenticated local relay may receive the probe. Never accept an
    // arbitrary remote relay address or fall back to sending to the target.
    if !ip.is_loopback() || relay_port == 0 {
        return Err(invalid("The UDP test relay is not local."));
    }
    socket
        .connect(SocketAddr::new(ip, relay_port))
        .map_err(|_| invalid("Cannot select the local UDP relay."))?;
    socket
        .set_read_timeout(Some(POLL))
        .map_err(|_| invalid("Cannot configure the UDP test socket."))?;
    socket
        .set_write_timeout(Some(POLL))
        .map_err(|_| invalid("Cannot configure the UDP test socket."))?;
    let request = request(endpoint.kind, nonce);
    let packet = [&[0, 0, 0][..], &endpoint.address(), &request].concat();
    let start = Instant::now();
    let mut sent = 0;
    let mut bytes = [0; 4096];
    loop {
        cancelled(stop, deadline)?;
        if sent < 3
            && start.elapsed()
                >= [
                    Duration::ZERO,
                    Duration::from_millis(500),
                    Duration::from_millis(1500),
                ][sent]
        {
            socket
                .send(&packet)
                .map_err(|_| invalid("Cannot send through the private UDP relay."))?;
            sent += 1;
        }
        match socket.recv(&mut bytes) {
            Ok(n) if valid_reply(&bytes[..n], endpoint, nonce) => return Ok(()),
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return Err(invalid("The UDP test path closed without a valid reply.")),
        }
    }
}

fn request(kind: Kind, nonce: &[u8; 12]) -> Vec<u8> {
    match kind {
        Kind::Stun => [&[0, 1, 0, 0][..], &COOKIE, nonce].concat(),
        // A small ordinary A query, with a fresh transaction ID. No TCP fallback.
        Kind::Dns => [
            &nonce[..2],
            &[1, 0, 0, 1, 0, 0, 0, 0, 0, 0],
            b"\x07example\x03com\0\0\x01\0\x01",
        ]
        .concat(),
    }
}
fn valid_reply(packet: &[u8], endpoint: &Endpoint, nonce: &[u8; 12]) -> bool {
    if packet.get(..3) != Some(&[0, 0, 0]) {
        return false;
    }
    let Some((ip, port, end)) = address(&packet[3..]) else {
        return false;
    };
    if port != endpoint.port {
        return false;
    }
    let literal = match endpoint.host {
        url::Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
        url::Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
        _ => None,
    };
    if literal.is_some() && literal != ip {
        return false;
    }
    let data = &packet[3 + end..];
    match endpoint.kind {
        Kind::Stun => stun_reply(data, nonce),
        Kind::Dns => dns_reply(data, nonce),
    }
}
fn stun_reply(data: &[u8], nonce: &[u8; 12]) -> bool {
    if data.len() < 20 || data[..2] != [1, 1] || data[4..8] != COOKIE || data[8..20] != *nonce {
        return false;
    }
    let length = usize::from(u16::from_be_bytes([data[2], data[3]]));
    if length % 4 != 0 || length + 20 != data.len() {
        return false;
    }
    let mut pos = 20;
    let mut mapped = false;
    while pos + 4 <= data.len() {
        let kind = u16::from_be_bytes([data[pos], data[pos + 1]]);
        let len = usize::from(u16::from_be_bytes([data[pos + 2], data[pos + 3]]));
        let Some(value) = data.get(pos + 4..pos + 4 + len) else {
            return false;
        };
        if kind == 0x20 {
            mapped |= (len == 8 && value[1] == 1) || (len == 20 && value[1] == 2);
        }
        pos += 4 + len.next_multiple_of(4);
    }
    mapped && pos == data.len()
}
fn dns_name(data: &[u8], pos: &mut usize) -> Option<Vec<u8>> {
    let mut at = *pos;
    let mut jumped = false;
    let mut name = Vec::new();
    for _ in 0..128 {
        let len = *data.get(at)?;
        if len & 0xc0 == 0xc0 {
            let next = ((usize::from(len & 0x3f)) << 8) | usize::from(*data.get(at + 1)?);
            if next >= at {
                return None;
            }
            if !jumped {
                *pos = at + 2;
                jumped = true;
            }
            at = next;
        } else {
            if len > 63 {
                return None;
            }
            at += 1;
            if len == 0 {
                if !jumped {
                    *pos = at;
                }
                return Some(name);
            }
            if !name.is_empty() {
                name.push(b'.');
            }
            name.extend_from_slice(data.get(at..at + usize::from(len))?);
            if name.len() > 253 {
                return None;
            }
            at += usize::from(len);
        }
    }
    None
}
fn dns_reply(data: &[u8], nonce: &[u8; 12]) -> bool {
    if data.len() < 12
        || data[..2] != nonce[..2]
        || data[2] & 0xfa != 0x80
        || data[3] & 0xf != 0
        || data[4..6] != [0, 1]
    {
        return false;
    }
    let mut pos = 12;
    if !dns_name(data, &mut pos).is_some_and(|name| name.eq_ignore_ascii_case(b"example.com"))
        || data.get(pos..pos + 4) != Some(&[0, 1, 0, 1])
    {
        return false;
    }
    pos += 4;
    let mut found = false;
    for _ in 0..u16::from_be_bytes([data[6], data[7]]) {
        if dns_name(data, &mut pos).is_none() {
            return false;
        }
        let Some(record) = data.get(pos..pos + 10) else {
            return false;
        };
        let len = usize::from(u16::from_be_bytes([record[8], record[9]]));
        pos += 10;
        if data.get(pos..pos + len).is_none() {
            return false;
        }
        found |= record[..4] == [0, 1, 0, 1] && len == 4;
        pos += len;
    }
    found
}

#[cfg(test)]
mod tests;
