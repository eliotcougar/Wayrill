// SPDX-License-Identifier: GPL-3.0-only
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};

/// IPv6 link scope is part of a flow's identity; IPv4 and IPv6-mapped addresses
/// retain their wire family. Value storage needs no per-packet address cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Address {
    pub ip: IpAddr,
    pub scope: u32,
}
impl Address {
    pub fn read(bytes: &[u8], interface: u32) -> Option<Self> {
        let ip = match bytes.len() {
            4 => IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(bytes).ok()?)),
            16 => IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(bytes).ok()?)),
            _ => return None,
        };
        let scope = if matches!(ip, IpAddr::V6(ip) if ip.is_unicast_link_local()) {
            interface
        } else {
            0
        };
        Some(Self { ip, scope })
    }
    pub fn socket(self, port: u16) -> SocketAddr {
        match self.ip {
            IpAddr::V4(ip) => SocketAddr::from((ip, port)),
            IpAddr::V6(ip) => SocketAddr::V6(SocketAddrV6::new(ip, port, 0, self.scope)),
        }
    }
    pub fn write(self, output: &mut [u8]) -> bool {
        match (self.ip, output.len()) {
            (IpAddr::V4(ip), 4) => output.copy_from_slice(&ip.octets()),
            (IpAddr::V6(ip), 16) => output.copy_from_slice(&ip.octets()),
            _ => return false,
        }
        true
    }
    pub fn wire_equals(self, other: Self) -> bool {
        self.ip == other.ip
    }
}

/// WinDivert 2.2's 80-byte, eight-byte-aligned address. The NETWORK, REFLECT
/// and SOCKET views overlap the same 64-byte union; no view changes its size.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DivertAddress {
    pub timestamp: i64,
    pub flags: u32,
    pub reserved: u32,
    pub data: [u8; 64],
}
impl Default for DivertAddress {
    fn default() -> Self {
        Self {
            timestamp: 0,
            flags: 0,
            reserved: 0,
            data: [0; 64],
        }
    }
}
impl DivertAddress {
    pub fn event(self) -> u8 {
        (self.flags >> 8) as u8
    }
    pub fn outbound(self) -> bool {
        self.flags & (1 << 17) != 0
    }
    pub fn set_outbound(&mut self, value: bool) {
        self.flags = (self.flags & !(1 << 17)) | ((value as u32) << 17);
    }
    pub fn ip_checksum(self) -> bool {
        self.flags & (1 << 21) != 0
    }
    pub fn tcp_checksum(self) -> bool {
        self.flags & (1 << 22) != 0
    }
    pub fn clear_checksums(&mut self) {
        self.flags &= !(7 << 21);
    }
    pub fn interface(self) -> u32 {
        u32::from_ne_bytes(self.data[..4].try_into().unwrap())
    }
    pub fn set_interface(&mut self, value: u32) {
        self.data[..4].copy_from_slice(&value.to_ne_bytes());
    }
    pub fn sub_interface(self) -> u32 {
        u32::from_ne_bytes(self.data[4..8].try_into().unwrap())
    }
    pub fn set_sub_interface(&mut self, value: u32) {
        self.data[4..8].copy_from_slice(&value.to_ne_bytes());
    }
    pub fn reflect_pid(self) -> u32 {
        u32::from_ne_bytes(self.data[8..12].try_into().unwrap())
    }
    pub fn reflect_timestamp(self) -> i64 {
        i64::from_ne_bytes(self.data[..8].try_into().unwrap())
    }
    pub fn reflect_layer(self) -> i32 {
        i32::from_ne_bytes(self.data[12..16].try_into().unwrap())
    }
    pub fn reflect_flags(self) -> u64 {
        u64::from_ne_bytes(self.data[16..24].try_into().unwrap())
    }
    pub fn reflect_priority(self) -> i16 {
        i16::from_ne_bytes(self.data[24..26].try_into().unwrap())
    }
    pub fn endpoint(self) -> u64 {
        u64::from_ne_bytes(self.data[..8].try_into().unwrap())
    }
    pub fn process_id(self) -> u32 {
        u32::from_ne_bytes(self.data[16..20].try_into().unwrap())
    }
    pub fn local_port(self) -> u16 {
        u16::from_ne_bytes(self.data[52..54].try_into().unwrap())
    }
    pub fn remote_port(self) -> u16 {
        u16::from_ne_bytes(self.data[54..56].try_into().unwrap())
    }
    pub fn protocol(self) -> u8 {
        self.data[56]
    }
    pub fn socket_address(self, remote: bool) -> Address {
        let start = if remote { 36 } else { 20 };
        let mut bytes = [0; 16];
        for i in 0..4 {
            let offset = start + (3 - i) * 4;
            let word = u32::from_ne_bytes(self.data[offset..offset + 4].try_into().unwrap());
            bytes[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        let ip = Ipv6Addr::from(bytes);
        Address {
            ip: ip
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(ip)),
            scope: 0,
        }
    }
}
