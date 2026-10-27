//! Query actual Windows listener owners. Binding a probe is not a UDP readiness
//! test: Go's wildcard dual-stack socket may coexist with an IPv4 probe bind.
use std::{
    mem::size_of,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener},
};
use wayrill_protocol::{ApiError, ListenerEndpoint, ListenerNetwork, Result};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_NOT_SUPPORTED},
    NetworkManagement::IpHelper::*,
    Networking::WinSock::{AF_INET, AF_INET6},
};

// Internal relays are service-owned; scope burst buffers to Windows UDP.
pub fn udp_buffer_options(config: &serde_json::Value) -> serde_json::Value {
    let options: Vec<_> = [
        ("WAYRILL_UDP_LISTENER_RECEIVE_BYTES", "4098"),
        ("WAYRILL_UDP_LISTENER_SEND_BYTES", "4097"),
    ].into_iter().filter_map(|(key, option)| {
        let value = config["env"][key].as_str()?;
        if value.parse::<u32>().ok()? == 0 { return None; }
        Some(serde_json::json!({"system":"windows","network":"udp","level":"65535","opt":option,"value":value,"type":"int"}))
    }).collect();
    serde_json::json!({"customSockopt":options})
}

/// A port may be free in Windows but already assigned in the runtime being
/// assembled. Keep selection separate from the eventual socket handoff.
pub(crate) fn reserve_loopback(config: &serde_json::Value) -> Result<TcpListener> {
    reserve_loopback_with(config, || TcpListener::bind(("127.0.0.1", 0)))
}
fn reserve_loopback_with(
    config: &serde_json::Value,
    mut bind: impl FnMut() -> std::io::Result<TcpListener>,
) -> Result<TcpListener> {
    let assigned = wayrill_protocol::listener_endpoints(config);
    for _ in 0..32 {
        let socket = bind().map_err(|e| ApiError::io("Reserve private loopback listener", e))?;
        let endpoint = ListenerEndpoint {
            address: socket
                .local_addr()
                .map_err(|e| ApiError::io("Read private loopback listener", e))?,
            network: ListenerNetwork::Tcp,
        };
        if !assigned.iter().any(|old| old.overlaps(endpoint)) {
            return Ok(socket);
        }
    }
    Err(ApiError::new(
        "PRIVATE_PORT_UNAVAILABLE",
        "Cannot allocate a distinct private listener for this configuration.",
    ))
}

pub struct OwnedEndpoint {
    pub endpoint: ListenerEndpoint,
    pub pid: u32,
}
type TableCall =
    unsafe extern "system" fn(*mut core::ffi::c_void, *mut u32, i32, u32, i32, u32) -> u32;

fn rows<T: Copy>(family: u32, class: i32, call: TableCall) -> Result<Vec<T>> {
    let mut size = 0u32;
    for _ in 0..4 {
        if size > 8 * 1024 * 1024 {
            return Err(ApiError::new(
                "SOCKET_TABLE_FAILED",
                "Windows socket table exceeds 8 MiB.",
            ));
        }
        let mut buffer = vec![0u8; size as usize];
        let code = unsafe {
            call(
                if buffer.is_empty() {
                    std::ptr::null_mut()
                } else {
                    buffer.as_mut_ptr().cast()
                },
                &mut size,
                0,
                family,
                class,
                0,
            )
        };
        if code == ERROR_NOT_SUPPORTED {
            return Ok(Vec::new());
        }
        if code == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if code != 0 {
            return Err(ApiError::io(
                "Read Windows listener table",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        return decode_rows(&buffer);
    }
    Err(ApiError::new(
        "SOCKET_TABLE_FAILED",
        "Windows listener table kept changing.",
    ))
}
fn decode_rows<T: Copy>(buffer: &[u8]) -> Result<Vec<T>> {
    let count = buffer
        .get(..4)
        .map(|bytes| u32::from_ne_bytes(bytes.try_into().unwrap()) as usize)
        .ok_or_else(|| ApiError::new("SOCKET_TABLE_FAILED", "Truncated listener table."))?;
    if size_of::<T>() == 0 || count > (buffer.len() - 4) / size_of::<T>() {
        return Err(ApiError::new(
            "SOCKET_TABLE_FAILED",
            "Truncated listener rows.",
        ));
    }
    // All four Windows owner-table row layouts have DWORD alignment and start
    // after the DWORD count. read_unaligned avoids assuming Vec<u8> alignment.
    Ok((0..count)
        .map(|index| unsafe {
            buffer
                .as_ptr()
                .add(4 + index * size_of::<T>())
                .cast::<T>()
                .read_unaligned()
        })
        .collect())
}
fn endpoint(ip: IpAddr, port: u32, pid: u32, network: ListenerNetwork) -> OwnedEndpoint {
    OwnedEndpoint {
        endpoint: ListenerEndpoint {
            address: SocketAddr::new(ip, u16::from_be(port as u16)),
            network,
        },
        pid,
    }
}
pub fn listeners() -> Result<Vec<OwnedEndpoint>> {
    let mut result = Vec::new();
    for row in rows::<MIB_TCPROW_OWNER_PID>(
        AF_INET as u32,
        TCP_TABLE_OWNER_PID_LISTENER,
        GetExtendedTcpTable,
    )? {
        result.push(endpoint(
            Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).into(),
            row.dwLocalPort,
            row.dwOwningPid,
            ListenerNetwork::Tcp,
        ));
    }
    for row in rows::<MIB_TCP6ROW_OWNER_PID>(
        AF_INET6 as u32,
        TCP_TABLE_OWNER_PID_LISTENER,
        GetExtendedTcpTable,
    )? {
        result.push(endpoint(
            Ipv6Addr::from(row.ucLocalAddr).into(),
            row.dwLocalPort,
            row.dwOwningPid,
            ListenerNetwork::Tcp,
        ));
    }
    for row in
        rows::<MIB_UDPROW_OWNER_PID>(AF_INET as u32, UDP_TABLE_OWNER_PID, GetExtendedUdpTable)?
    {
        result.push(endpoint(
            Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).into(),
            row.dwLocalPort,
            row.dwOwningPid,
            ListenerNetwork::Udp,
        ));
    }
    for row in
        rows::<MIB_UDP6ROW_OWNER_PID>(AF_INET6 as u32, UDP_TABLE_OWNER_PID, GetExtendedUdpTable)?
    {
        result.push(endpoint(
            Ipv6Addr::from(row.ucLocalAddr).into(),
            row.dwLocalPort,
            row.dwOwningPid,
            ListenerNetwork::Udp,
        ));
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    #[test]
    fn private_udp_buffers_follow_configured_values_and_system_omission() {
        use serde_json::json;
        assert_eq!(
            super::udp_buffer_options(&json!({})),
            json!({"customSockopt":[]})
        );
        let options = super::udp_buffer_options(&json!({"env":{
            "WAYRILL_UDP_LISTENER_RECEIVE_BYTES":"524288",
            "WAYRILL_UDP_LISTENER_SEND_BYTES":"0"
        }}));
        assert_eq!(options["customSockopt"].as_array().unwrap().len(), 1);
        assert_eq!(options["customSockopt"][0]["opt"], "4098");
        assert_eq!(options["customSockopt"][0]["value"], "524288");
    }
    #[test]
    fn private_ports_skip_configured_tcp_but_allow_independent_udp_ports() {
        let first = TcpListener::bind("127.0.0.1:0").unwrap();
        let first_address = first.local_addr().unwrap();
        let second = TcpListener::bind("127.0.0.1:0").unwrap();
        let second_address = second.local_addr().unwrap();
        let config = serde_json::json!({"inbounds":[
            {"listen":"::ffff:127.0.0.1","port":first_address.port(),"protocol":"socks"},
            {"listen":"127.0.0.1","port":second_address.port(),"protocol":"wireguard"}
        ]});
        let mut candidates = [first, second].into_iter();
        let chosen = reserve_loopback_with(&config, || Ok(candidates.next().unwrap())).unwrap();
        assert_eq!(chosen.local_addr().unwrap(), second_address);
        // Rejected candidates and the selected reservation have normal RAII ownership.
        TcpListener::bind(first_address).unwrap();
        assert!(TcpListener::bind(second_address).is_err());
        drop(chosen);
        TcpListener::bind(second_address).unwrap();
    }
    #[test]
    fn private_port_exhaustion_is_bounded_and_releases_rejected_sockets() {
        let sockets: Vec<_> = (0..32)
            .map(|_| TcpListener::bind("127.0.0.1:0").unwrap())
            .collect();
        let addresses: Vec<_> = sockets.iter().map(|s| s.local_addr().unwrap()).collect();
        let config = serde_json::json!({"inbounds": addresses.iter().map(|a|
            serde_json::json!({"listen":"0.0.0.0","port":a.port(),"protocol":"socks"})).collect::<Vec<_>>()});
        let mut candidates = sockets.into_iter();
        let error = reserve_loopback_with(&config, || Ok(candidates.next().unwrap())).unwrap_err();
        assert_eq!(error.code, "PRIVATE_PORT_UNAVAILABLE");
        assert!(candidates.next().is_none());
        for address in addresses {
            TcpListener::bind(address).unwrap();
        }
    }

    use super::*;
    #[test]
    fn finds_real_tcp_and_udp_owners() {
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let result = listeners().unwrap();
        for (address, network) in [
            (tcp.local_addr().unwrap(), ListenerNetwork::Tcp),
            (udp.local_addr().unwrap(), ListenerNetwork::Udp),
        ] {
            assert!(result.iter().any(|row| row.pid == std::process::id()
                && row.endpoint.address == address
                && row.endpoint.network == network));
            assert!(!result
                .iter()
                .any(|row| row.pid == 0 && row.endpoint.address == address));
        }
    }
    #[test]
    fn rejects_truncated_native_tables() {
        assert!(decode_rows::<MIB_UDP6ROW_OWNER_PID>(&[]).is_err());
        assert!(decode_rows::<MIB_UDP6ROW_OWNER_PID>(&[1, 0, 0, 0]).is_err());
        assert!(decode_rows::<MIB_UDP6ROW_OWNER_PID>(&[0, 0, 0, 0])
            .unwrap()
            .is_empty());
    }
}
