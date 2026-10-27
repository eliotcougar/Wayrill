// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    address::{Address, DivertAddress},
    Error, Result,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Flow {
    pub protocol: u8,
    pub local: Address,
    pub local_port: u16,
    pub remote: Address,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Packet {
    pub flow: Flow,
    pub transport: usize,
    pub source: usize,
    pub destination: usize,
    pub address_len: usize,
    pub total: usize,
    pub tcp_flags: u8,
    pub tcp_sequence: u32,
}
fn be16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
}
fn put16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}
fn be32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

impl Packet {
    pub fn parse(bytes: &[u8], interface: u32) -> Option<Self> {
        if bytes.len() < 20 {
            return None;
        }
        let (mut transport, source, destination, address_len, total, mut protocol) =
            match bytes[0] >> 4 {
                4 => {
                    let header = usize::from(bytes[0] & 15) * 4;
                    let total = usize::from(be16(bytes, 2));
                    if header < 20
                        || total < header
                        || total > bytes.len()
                        || be16(bytes, 6) & 0x3fff != 0
                    {
                        return None;
                    }
                    (header, 12, 16, 4, total, bytes[9])
                }
                6 => {
                    if bytes.len() < 40 {
                        return None;
                    }
                    let total = 40 + usize::from(be16(bytes, 4));
                    if total > bytes.len() {
                        return None;
                    }
                    (40, 8, 24, 16, total, bytes[6])
                }
                _ => return None,
            };
        if address_len == 16 {
            let mut count = 0;
            while matches!(protocol, 0 | 43 | 60) {
                if count == 8 || transport + 2 > total {
                    return None;
                }
                let next = bytes[transport];
                transport += (usize::from(bytes[transport + 1]) + 1) * 8;
                if transport > total {
                    return None;
                }
                protocol = next;
                count += 1;
            }
        }
        let minimum = match protocol {
            6 => 20,
            17 => 8,
            _ => return None,
        };
        if total.checked_sub(transport)? < minimum {
            return None;
        }
        if protocol == 6 {
            let size = usize::from(bytes[transport + 12] >> 4) * 4;
            if size < 20 || size > total - transport {
                return None;
            }
        } else {
            let size = usize::from(be16(bytes, transport + 4));
            if size < 8 || size > total - transport {
                return None;
            }
        }
        Some(Self {
            flow: Flow {
                protocol,
                local: Address::read(&bytes[source..source + address_len], interface)?,
                local_port: be16(bytes, transport),
                remote: Address::read(&bytes[destination..destination + address_len], interface)?,
                remote_port: be16(bytes, transport + 2),
            },
            transport,
            source,
            destination,
            address_len,
            total,
            tcp_flags: if protocol == 6 {
                bytes[transport + 13]
            } else {
                0
            },
            tcp_sequence: if protocol == 6 {
                be32(bytes, transport + 4)
            } else {
                0
            },
        })
    }
    pub fn is_tcp_syn(self) -> bool {
        self.flow.protocol == 6 && self.tcp_flags & 0x12 == 2
    }
    pub fn rewrite(
        self,
        bytes: &mut [u8],
        source: Address,
        source_port: u16,
        destination: Address,
        destination_port: u16,
    ) -> Result<()> {
        if bytes.len() < self.total
            || source.ip.is_ipv6() != (self.address_len == 16)
            || destination.ip.is_ipv6() != (self.address_len == 16)
        {
            return Err(Error::invalid(
                "Packet address families or buffer size must match.",
            ));
        }
        source.write(&mut bytes[self.source..self.source + self.address_len]);
        destination.write(&mut bytes[self.destination..self.destination + self.address_len]);
        put16(bytes, self.transport, source_port);
        put16(bytes, self.transport + 2, destination_port);
        Ok(())
    }
    /// Return true only when RFC 1624 permits avoiding a full checksum scan.
    pub fn reflect(
        self,
        bytes: &mut [u8],
        source_port: u16,
        destination_port: u16,
        address: DivertAddress,
    ) -> Result<bool> {
        if bytes.len() < self.total {
            return Err(Error::invalid("Truncated reflection buffer."));
        }
        let valid = self.flow.protocol == 6
            && self.transport == if self.address_len == 16 { 40 } else { 20 }
            && address.tcp_checksum()
            && (self.address_len == 16 || address.ip_checksum());
        let checksum = if valid {
            be16(bytes, self.transport + 16)
        } else {
            0
        };
        self.rewrite(
            bytes,
            self.flow.remote,
            source_port,
            self.flow.local,
            destination_port,
        )?;
        if !valid {
            return Ok(false);
        }
        let mut sum = u32::from(!checksum)
            + u32::from(!self.flow.local_port)
            + u32::from(source_port)
            + u32::from(!self.flow.remote_port)
            + u32::from(destination_port);
        sum = (sum & 0xffff) + (sum >> 16);
        sum = (sum & 0xffff) + (sum >> 16);
        put16(bytes, self.transport + 16, !(sum as u16));
        Ok(true)
    }
    pub fn tcp_reset(self, bytes: &[u8]) -> Result<Option<Vec<u8>>> {
        if self.flow.protocol != 6 || bytes.len() < self.total {
            return Err(Error::invalid("Invalid TCP reset source."));
        }
        if self.tcp_flags & 4 != 0 {
            return Ok(None);
        }
        if self.tcp_flags & 16 != 0 {
            return Ok(Some(tcp_reset(
                self.flow,
                be32(bytes, self.transport + 8),
                None,
            )?));
        }
        let size = self.total - self.transport - usize::from(bytes[self.transport + 12] >> 4) * 4
            + usize::from(self.tcp_flags & 2 != 0)
            + usize::from(self.tcp_flags & 1 != 0);
        Ok(Some(tcp_reset(
            self.flow,
            0,
            Some(self.tcp_sequence.wrapping_add(size as u32)),
        )?))
    }
}

fn reply_header(bytes: &mut [u8], flow: Flow, protocol: u8) -> Result<usize> {
    let six = flow.local.ip.is_ipv6();
    if six != flow.remote.ip.is_ipv6() {
        return Err(Error::invalid("Mixed reply address families."));
    }
    let header = if six { 40 } else { 20 };
    if bytes.len() < header || bytes.len() > if six { 65575 } else { 65535 } {
        return Err(Error::invalid("Invalid reply size."));
    }
    bytes[0] = if six { 0x60 } else { 0x45 };
    if six {
        bytes[6] = protocol;
        bytes[7] = 64;
        put16(bytes, 4, (bytes.len() - header) as u16);
    } else {
        bytes[8] = 64;
        bytes[9] = protocol;
        put16(bytes, 2, bytes.len() as u16);
    }
    let source = if six { 8 } else { 12 };
    let destination = if six { 24 } else { 16 };
    let length = if six { 16 } else { 4 };
    flow.remote.write(&mut bytes[source..source + length]);
    flow.local
        .write(&mut bytes[destination..destination + length]);
    Ok(header)
}
pub fn tcp_reset(flow: Flow, sequence: u32, acknowledgement: Option<u32>) -> Result<Vec<u8>> {
    let mut bytes = vec![0; if flow.local.ip.is_ipv6() { 60 } else { 40 }];
    let header = reply_header(&mut bytes, flow, 6)?;
    put16(&mut bytes, header, flow.remote_port);
    put16(&mut bytes, header + 2, flow.local_port);
    bytes[header + 4..header + 8].copy_from_slice(&sequence.to_be_bytes());
    bytes[header + 8..header + 12].copy_from_slice(&acknowledgement.unwrap_or(0).to_be_bytes());
    bytes[header + 12] = 0x50;
    bytes[header + 13] = if acknowledgement.is_some() { 0x14 } else { 4 };
    Ok(bytes)
}
pub fn udp_reply(flow: Flow, payload: &[u8]) -> Result<Vec<u8>> {
    let mut bytes = vec![0; (if flow.local.ip.is_ipv6() { 48 } else { 28 }) + payload.len()];
    write_udp_reply(&mut bytes, flow, payload)?;
    Ok(bytes)
}
pub fn write_udp_reply<'a>(
    bytes: &'a mut [u8],
    flow: Flow,
    payload: &[u8],
) -> Result<&'a mut [u8]> {
    let header = if flow.local.ip.is_ipv6() { 40 } else { 20 };
    if payload.len() > if header == 40 { 65527 } else { 65507 } {
        return Err(Error::invalid("UDP payload too large."));
    }
    let length = header + 8 + payload.len();
    let bytes = bytes
        .get_mut(..length)
        .ok_or_else(|| Error::invalid("UDP reply buffer too small."))?;
    bytes[..header + 8].fill(0);
    reply_header(bytes, flow, 17)?;
    put16(bytes, header, flow.remote_port);
    put16(bytes, header + 2, flow.local_port);
    put16(bytes, header + 4, (payload.len() + 8) as u16);
    bytes[header + 8..].copy_from_slice(payload);
    Ok(bytes)
}
