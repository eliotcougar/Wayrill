// SPDX-License-Identifier: GPL-3.0-only
use crate::{policy::Endpoint, Error, Result};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

#[derive(Debug, PartialEq, Eq)]
pub enum BoundAddress {
    Ip(SocketAddr),
    Domain(String, u16),
}

/// The service can supply only an authenticated relay port on IPv4 loopback.
/// Dropping an in-flight connect/request future closes the owned stream.
pub async fn connect_proxy(endpoint: &Endpoint) -> Result<TcpStream> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, endpoint.port)).await?;
    let method = if endpoint.username.is_empty() { 0 } else { 2 };
    stream.write_all(&[5, 1, method]).await?;
    let mut reply = [0; 2];
    stream.read_exact(&mut reply).await?;
    if reply != [5, method] {
        return Err(Error::invalid("SOCKS5 authentication method rejected."));
    }
    if method == 2 {
        let user = endpoint.username.as_bytes();
        let password = endpoint.password.as_bytes();
        if user.is_empty() || user.len() > 255 || password.is_empty() || password.len() > 255 {
            return Err(Error::invalid(
                "SOCKS5 credentials must be 1–255 UTF-8 bytes.",
            ));
        }
        let mut message = Vec::with_capacity(3 + user.len() + password.len());
        message.extend_from_slice(&[1, user.len() as u8]);
        message.extend_from_slice(user);
        message.push(password.len() as u8);
        message.extend_from_slice(password);
        stream.write_all(&message).await?;
        stream.read_exact(&mut reply).await?;
        if reply != [1, 0] {
            return Err(Error::invalid("SOCKS5 authentication failed."));
        }
    }
    Ok(stream)
}
pub async fn request(
    stream: &mut TcpStream,
    command: u8,
    destination: SocketAddr,
) -> Result<BoundAddress> {
    let mut message = [0; 22];
    message[..3].copy_from_slice(&[5, command, 0]);
    let length = 3 + write_address(destination, &mut message[3..])?;
    stream.write_all(&message[..length]).await?;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    if header[0] != 5 || header[1] != 0 || header[2] != 0 {
        return Err(Error::invalid(format!(
            "SOCKS5 request rejected ({}).",
            header[1]
        )));
    }
    let length = match header[3] {
        1 => 4,
        4 => 16,
        3 => {
            let length = stream.read_u8().await?;
            if length == 0 {
                return Err(Error::invalid("Invalid SOCKS5 domain length."));
            }
            usize::from(length)
        }
        _ => return Err(Error::invalid("Invalid SOCKS5 address type.")),
    };
    let mut raw = [0; 255];
    stream.read_exact(&mut raw[..length]).await?;
    let port = stream.read_u16().await?;
    if command == 3 && port == 0 {
        return Err(Error::invalid("Invalid SOCKS5 UDP relay endpoint."));
    }
    if header[3] == 3 {
        // CONNECT consumes the reply without a DNS query; only UDP association
        // setup resolves a returned domain if its socket actually needs it.
        let domain = raw[..length]
            .iter()
            .map(|b| if b.is_ascii() { char::from(*b) } else { '?' })
            .collect();
        return Ok(BoundAddress::Domain(domain, port));
    }
    let mut ip = if length == 4 {
        IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(&raw[..4]).unwrap()))
    } else {
        IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&raw[..16]).unwrap()))
    };
    if ip.is_unspecified() {
        ip = stream.peer_addr()?.ip();
    }
    if let IpAddr::V6(v6) = ip {
        if let Some(v4) = v6.to_ipv4_mapped() {
            ip = IpAddr::V4(v4);
        }
    }
    Ok(BoundAddress::Ip(SocketAddr::new(ip, port)))
}
pub async fn connect_tcp(endpoint: &Endpoint, destination: SocketAddr) -> Result<TcpStream> {
    let mut stream = connect_proxy(endpoint).await?;
    request(&mut stream, 1, destination).await?;
    Ok(stream)
}
pub fn encoded_address_length(destination: SocketAddr) -> usize {
    if destination.is_ipv4()
        || matches!(destination.ip(),IpAddr::V6(v6) if v6.to_ipv4_mapped().is_some())
    {
        7
    } else {
        19
    }
}
pub fn datagram_header_length(destination: SocketAddr) -> usize {
    3 + encoded_address_length(destination)
}
pub fn write_address(destination: SocketAddr, output: &mut [u8]) -> Result<usize> {
    let ip = match destination.ip() {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        ip => ip,
    };
    let length = encoded_address_length(destination);
    let output = output
        .get_mut(..length)
        .ok_or_else(|| Error::invalid("SOCKS5 address buffer too small."))?;
    match ip {
        IpAddr::V4(ip) => {
            output[0] = 1;
            output[1..5].copy_from_slice(&ip.octets());
        }
        IpAddr::V6(ip) => {
            output[0] = 4;
            output[1..17].copy_from_slice(&ip.octets());
        }
    }
    output[length - 2..].copy_from_slice(&destination.port().to_be_bytes());
    Ok(length)
}
pub fn write_datagram<'a>(
    output: &'a mut [u8],
    destination: SocketAddr,
    payload: &[u8],
) -> Result<&'a [u8]> {
    let header = datagram_header_length(destination);
    let output = output
        .get_mut(..header + payload.len())
        .ok_or_else(|| Error::invalid("SOCKS5 datagram buffer too small."))?;
    output[..3].fill(0);
    write_address(destination, &mut output[3..header])?;
    output[header..].copy_from_slice(payload);
    Ok(output)
}
pub fn unwrap_datagram(packet: &[u8]) -> Option<(SocketAddr, &[u8])> {
    if packet.len() < 4 || packet[..3] != [0, 0, 0] {
        return None;
    }
    let length = match packet[3] {
        1 => 4,
        4 => 16,
        _ => return None,
    };
    if packet.len() < length + 6 {
        return None;
    }
    let ip = if length == 4 {
        IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(&packet[4..8]).ok()?))
    } else {
        IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&packet[4..20]).ok()?))
    };
    let port = u16::from_be_bytes(packet[4 + length..6 + length].try_into().ok()?);
    Some((SocketAddr::new(ip, port), &packet[length + 6..]))
}
