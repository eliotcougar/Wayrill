// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    address::{Address, DivertAddress},
    pending::Original,
    Error, Result,
};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
    source: Address,
    destination: Address,
    id: u32,
    protocol: u8,
    interface: u32,
}
struct Assembly {
    created: u64,
    prefix: Option<Vec<u8>>,
    address: DivertAddress,
    length: Option<usize>,
    received: usize,
    rejected: bool,
    parts: BTreeMap<usize, Vec<u8>>,
    originals: Vec<Original>,
}
impl Assembly {
    fn new(now: u64) -> Self {
        Self {
            created: now,
            prefix: None,
            address: DivertAddress::default(),
            length: None,
            received: 0,
            rejected: false,
            parts: BTreeMap::new(),
            originals: Vec::new(),
        }
    }
    fn size(&self) -> usize {
        self.received + self.originals.iter().map(|p| p.0.len()).sum::<usize>()
    }
}
pub struct Batch {
    pub packet: Vec<u8>,
    pub address: DivertAddress,
    pub originals: Vec<Original>,
    pub pass_through: bool,
}
pub enum FragmentResult {
    Ordinary,
    Buffered,
    Complete(Batch),
}
#[derive(Default)]
pub struct FragmentBuffer {
    pending: HashMap<Key, Assembly>,
    bytes: usize,
}

impl FragmentBuffer {
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
    /// Interface/local bypass is checked even for a noninitial fragment. A TCP
    /// reflector reply must be excluded from that bypass by the engine callback.
    pub fn add(
        &mut self,
        packet: &[u8],
        address: DivertAddress,
        now: u64,
        bypass: impl FnOnce(DivertAddress, u8, Address, Address) -> bool,
    ) -> Result<FragmentResult> {
        if packet.len() < 20 {
            return Ok(FragmentResult::Ordinary);
        }
        let six = packet[0] >> 4 == 6;
        let (mut start, prefix_length, previous_next, total, offset, more, id, protocol) =
            match packet[0] >> 4 {
                4 => {
                    let flags = u16::from_be_bytes([packet[6], packet[7]]);
                    if flags & 0x3fff == 0 {
                        return Ok(FragmentResult::Ordinary);
                    }
                    let header = usize::from(packet[0] & 15) * 4;
                    (
                        header,
                        header,
                        6,
                        usize::from(u16::from_be_bytes([packet[2], packet[3]])),
                        usize::from(flags & 0x1fff) * 8,
                        flags & 0x2000 != 0,
                        u32::from(u16::from_be_bytes([packet[4], packet[5]])),
                        packet[9],
                    )
                }
                6 => {
                    if packet.len() < 40 {
                        return Ok(FragmentResult::Ordinary);
                    }
                    let total = 40 + usize::from(u16::from_be_bytes([packet[4], packet[5]]));
                    let mut protocol = packet[6];
                    let (mut start, mut previous, mut count) = (40, 6, 0);
                    while matches!(protocol, 0 | 43 | 60) {
                        if count == 8 || start + 2 > packet.len() {
                            return Err(Error::invalid("Invalid IPv6 extension header."));
                        }
                        previous = start;
                        protocol = packet[start];
                        start += (usize::from(packet[start + 1]) + 1) * 8;
                        count += 1;
                    }
                    if protocol != 44 {
                        return Ok(FragmentResult::Ordinary);
                    }
                    if start + 8 > packet.len() {
                        return Err(Error::invalid("Truncated IPv6 fragment header."));
                    }
                    let flags = u16::from_be_bytes([packet[start + 2], packet[start + 3]]);
                    (
                        start + 8,
                        start,
                        previous,
                        total,
                        usize::from(flags & 0xfff8),
                        flags & 1 != 0,
                        u32::from_be_bytes(packet[start + 4..start + 8].try_into().unwrap()),
                        packet[start],
                    )
                }
                _ => return Ok(FragmentResult::Ordinary),
            };
        if !matches!(protocol, 6 | 17) && !(six && protocol == 60) {
            return Ok(FragmentResult::Ordinary);
        }
        if prefix_length < 20
            || total > packet.len()
            || start >= total
            || more && !(total - start).is_multiple_of(8)
            || offset + total - start > 65535
        {
            return Err(Error::invalid("Invalid IP fragment length."));
        }
        let packet = &packet[..total];
        // Fragment keys deliberately ignore IPv6 scope (the interface is a
        // separate field), as do the C# assembly keys.
        let key = Key {
            source: Address::read(&packet[if six { 8..24 } else { 12..16 }], 0).unwrap(),
            destination: Address::read(&packet[if six { 24..40 } else { 16..20 }], 0).unwrap(),
            id,
            protocol,
            interface: address.interface(),
        };
        self.expire(now);
        if bypass(address, protocol, key.source, key.destination) {
            let mut originals = self.remove(&key).map(|a| a.originals).unwrap_or_default();
            originals.push((packet.to_vec(), address));
            return Ok(FragmentResult::Complete(Batch {
                packet: Vec::new(),
                address,
                originals,
                pass_through: true,
            }));
        }
        if !self.pending.contains_key(&key) && self.pending.len() >= 256 {
            return Err(Error::invalid("IP fragment assembly limit reached."));
        }
        let assembly = self
            .pending
            .entry(key)
            .or_insert_with(|| Assembly::new(now));
        if assembly.rejected {
            return Ok(FragmentResult::Buffered);
        }
        let payload = &packet[start..];
        for (&at, part) in &assembly.parts {
            if at == offset && payload == part {
                return Ok(FragmentResult::Buffered);
            }
            if at < offset + payload.len() && offset < at + part.len() {
                Self::reject(&mut self.bytes, assembly);
                return Err(Error::invalid("Overlapping IP fragments blocked."));
            }
        }
        if self.bytes + packet.len() + payload.len() > 16 * 1024 * 1024
            || assembly.parts.len() >= 1024
        {
            Self::reject(&mut self.bytes, assembly);
            return Err(Error::invalid("IP fragment buffer limit reached."));
        }
        if !more {
            assembly.length = Some(offset + payload.len());
        }
        if assembly.length.is_some_and(|length| {
            offset + payload.len() > length
                || assembly
                    .parts
                    .iter()
                    .any(|(at, part)| at + part.len() > length)
        }) {
            Self::reject(&mut self.bytes, assembly);
            return Err(Error::invalid("Inconsistent IP fragment length."));
        }
        assembly.parts.insert(offset, payload.to_vec());
        assembly.originals.push((packet.to_vec(), address));
        assembly.received += payload.len();
        self.bytes += packet.len() + payload.len();
        if offset == 0 {
            let mut prefix = packet[..prefix_length].to_vec();
            assembly.address = address;
            if six {
                prefix[previous_next] = protocol;
            } else {
                prefix[6..8].fill(0);
            }
            assembly.prefix = Some(prefix);
        }
        if assembly.prefix.is_none() || assembly.length != Some(assembly.received) {
            return Ok(FragmentResult::Buffered);
        }
        let header = assembly.prefix.as_ref().unwrap();
        let length = header.len() + assembly.received;
        if length > if six { 65575 } else { 65535 } {
            Self::reject(&mut self.bytes, assembly);
            return Err(Error::invalid("Reassembled IP packet is too large."));
        }
        let mut result = vec![0; length];
        result[..header.len()].copy_from_slice(header);
        for (at, part) in &assembly.parts {
            result[header.len() + at..header.len() + at + part.len()].copy_from_slice(part);
        }
        start = if six { 4 } else { 2 };
        result[start..start + 2]
            .copy_from_slice(&((if six { length - 40 } else { length }) as u16).to_be_bytes());
        let mut assembly = self.remove(&key).unwrap();
        assembly.address.clear_checksums();
        Ok(FragmentResult::Complete(Batch {
            packet: result,
            address: assembly.address,
            originals: assembly.originals,
            pass_through: false,
        }))
    }
    fn remove(&mut self, key: &Key) -> Option<Assembly> {
        let assembly = self.pending.remove(key)?;
        self.bytes -= assembly.size();
        Some(assembly)
    }
    fn reject(bytes: &mut usize, assembly: &mut Assembly) {
        *bytes -= assembly.size();
        assembly.originals.clear();
        assembly.parts.clear();
        assembly.received = 0;
        assembly.prefix = None;
        assembly.rejected = true;
    }
    pub fn expire(&mut self, now: u64) {
        self.pending.retain(|_, a| {
            if now.saturating_sub(a.created) > 15_000 {
                self.bytes -= a.size();
                false
            } else {
                true
            }
        });
    }
    pub fn retain_interfaces(&mut self, retain: impl Fn(u32, bool) -> bool) {
        self.pending.retain(|key, a| {
            if retain(key.interface, key.source.ip.is_ipv6()) {
                true
            } else {
                self.bytes -= a.size();
                false
            }
        });
    }
}
