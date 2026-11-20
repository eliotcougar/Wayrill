//! UDP probes always traverse the isolated core's authenticated SOCKS relay.
//! No native destination socket, system resolver or TCP fallback is used.
use super::invalid;
use serde::Serialize;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
    time::{timeout, timeout_at, Instant},
};
use wayrill_protocol::Result;

const ASSOCIATION_TIMEOUT: Duration = Duration::from_secs(10);
const REPLY_WINDOWS_MS: [u64; 5] = [500, 1500, 3500, 7500, 10000];
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
pub(super) struct Reachability {
    pub reachable: bool,
    pub error: Option<String>,
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

pub(super) async fn test(
    port: u16,
    password: &str,
    endpoint: &Endpoint,
    nonce: &[u8; 12],
) -> Reachability {
    let checked = exchange(port, password, endpoint, nonce).await;
    Reachability {
        reachable: checked.is_ok(),
        error: checked.err().map(|e| e.message),
    }
}

async fn exchange(port: u16, password: &str, endpoint: &Endpoint, nonce: &[u8; 12]) -> Result<()> {
    let (mut control, socket) = timeout(ASSOCIATION_TIMEOUT, associate(port, password))
        .await
        .map_err(|_| invalid("The private UDP relay took too long to open an association."))??;
    // SOCKS uses a TCP control connection to keep the UDP association open.
    tokio::select! {
        biased;
        result = probe(&socket, endpoint, nonce) => result,
        _ = control.read_u8() => Err(invalid("The private UDP relay closed the association.")),
    }
}

async fn associate(port: u16, password: &str) -> Result<(TcpStream, UdpSocket)> {
    let mut control = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port)))
        .await
        .map_err(|_| invalid("Cannot connect to the private UDP relay."))?;
    write(&mut control, &[5, 1, 2]).await?;
    let mut reply = [0; 2];
    read(&mut control, &mut reply).await?;
    if reply != [5, 2] {
        return Err(invalid("The private UDP relay refused authentication."));
    }
    let mut auth = vec![1, 12];
    auth.extend_from_slice(b"wayrill-test");
    auth.push(password.len() as u8);
    auth.extend_from_slice(password.as_bytes());
    write(&mut control, &auth).await?;
    read(&mut control, &mut reply).await?;
    if reply != [1, 0] {
        return Err(invalid("The private UDP relay refused authentication."));
    }
    let socket = UdpSocket::bind("127.0.0.1:0")
        .await
        .map_err(|_| invalid("No local UDP test port is available."))?;
    let mut associate = vec![5, 3, 0, 1, 127, 0, 0, 1];
    associate.extend_from_slice(
        &socket
            .local_addr()
            .map_err(|_| invalid("Cannot read the UDP test port."))?
            .port()
            .to_be_bytes(),
    );
    write(&mut control, &associate).await?;
    let mut head = [0; 4];
    read(&mut control, &mut head).await?;
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
    read(&mut control, &mut relay[1..]).await?;
    let Some((Some(ip), relay_port, _)) = address(&relay) else {
        return Err(invalid("Invalid UDP relay address."));
    };
    // Only our authenticated local relay may receive the probe.
    if !ip.is_loopback() || relay_port == 0 {
        return Err(invalid("The UDP test relay is not local."));
    }
    socket
        .connect(SocketAddr::new(ip, relay_port))
        .await
        .map_err(|_| invalid("Cannot select the local UDP relay."))?;
    Ok((control, socket))
}

async fn read(control: &mut TcpStream, bytes: &mut [u8]) -> Result<()> {
    control
        .read_exact(bytes)
        .await
        .map_err(|_| invalid("Cannot read from the private UDP relay."))?;
    Ok(())
}

async fn write(control: &mut TcpStream, bytes: &[u8]) -> Result<()> {
    control
        .write_all(bytes)
        .await
        .map_err(|_| invalid("Cannot write to the private UDP relay."))
}

async fn probe(socket: &UdpSocket, endpoint: &Endpoint, nonce: &[u8; 12]) -> Result<()> {
    let packet = [
        &[0, 0, 0][..],
        &endpoint.address(),
        &request(endpoint.kind, nonce),
    ]
    .concat();
    let start = Instant::now();
    let mut bytes = [0; 4096];
    // Reuse the transaction ID across retries so a late reply can still pass.
    for elapsed in REPLY_WINDOWS_MS {
        let deadline = start + Duration::from_millis(elapsed);
        match timeout_at(deadline, socket.send(&packet)).await {
            Ok(Ok(_)) => {}
            Ok(Err(_)) => return Err(invalid("Cannot send through the private UDP relay.")),
            Err(_) => continue,
        }
        while Instant::now() < deadline {
            let Ok(received) = timeout_at(deadline, socket.recv(&mut bytes)).await else {
                break;
            };
            let size =
                received.map_err(|_| invalid("The UDP test path closed without a valid reply."))?;
            if valid_reply(&bytes[..size], endpoint, nonce) {
                return Ok(());
            }
        }
    }
    Err(invalid("No valid UDP reply within 10 seconds."))
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
    if data.len() < 20
        || !matches!(data[..2], [1, 1] | [1, 0x11])
        || data[4..8] != COOKIE
        || data[8..20] != *nonce
    {
        return false;
    }
    let length = usize::from(u16::from_be_bytes([data[2], data[3]]));
    if length % 4 != 0 || length + 20 != data.len() {
        return false;
    }
    let mut pos = 20;
    let mut mapped = false;
    let mut error = false;
    while pos + 4 <= data.len() {
        let kind = u16::from_be_bytes([data[pos], data[pos + 1]]);
        let len = usize::from(u16::from_be_bytes([data[pos + 2], data[pos + 3]]));
        let Some(value) = data.get(pos + 4..pos + 4 + len) else {
            return false;
        };
        if kind == 0x20 {
            mapped |= (len == 8 && value[1] == 1) || (len == 20 && value[1] == 2);
        }
        if kind == 0x09 && len >= 4 {
            error |= (3..=6).contains(&(value[2] & 7)) && value[3] < 100;
        }
        pos += 4 + len.next_multiple_of(4);
    }
    pos == data.len() && if data[1] == 1 { mapped } else { error }
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
    if data.len() < 12 || data[..2] != nonce[..2] || data[2] & 0xf8 != 0x80 || data[4..6] != [0, 1]
    {
        return false;
    }
    let mut pos = 12;
    if !dns_name(data, &mut pos).is_some_and(|name| name.eq_ignore_ascii_case(b"example.com"))
        || data.get(pos..pos + 4) != Some(&[0, 1, 0, 1])
    {
        return false;
    }
    // A truncated reply or a DNS error still demonstrates UDP reachability.
    if data[2] & 2 != 0 {
        return true;
    }
    pos += 4;
    let records: usize = data[6..12]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|count| usize::from(u16::from_be_bytes(*count)))
        .sum();
    for _ in 0..records {
        if dns_name(data, &mut pos).is_none() {
            return false;
        }
        let Some(record) = data.get(pos..pos + 10) else {
            return false;
        };
        let len = usize::from(u16::from_be_bytes([record[8], record[9]]));
        pos += 10 + len;
        if pos > data.len() {
            return false;
        }
    }
    pos == data.len()
}

#[cfg(test)]
mod tests;
