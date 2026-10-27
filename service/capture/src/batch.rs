// SPDX-License-Identifier: GPL-3.0-only
use crate::{address::DivertAddress, Error, Result};
pub const CAPACITY: usize = 128;
pub const MAX_PACKET_LENGTH: usize = 65575;
pub const BUFFER_LENGTH: usize = MAX_PACKET_LENGTH * 4;

/// Storage is borrowed by the sink only for the synchronous call. Clearing the
/// count before injection prevents retrying a partially injected native batch.
pub struct PacketBatch {
    packets: Vec<u8>,
    addresses: Vec<DivertAddress>,
}
impl Default for PacketBatch {
    fn default() -> Self {
        Self {
            packets: Vec::with_capacity(BUFFER_LENGTH),
            addresses: Vec::with_capacity(CAPACITY),
        }
    }
}
impl PacketBatch {
    pub fn add(
        &mut self,
        packet: &[u8],
        address: DivertAddress,
        send: &mut impl FnMut(&[u8], &[DivertAddress]) -> Result<()>,
    ) -> Result<()> {
        if packet.len() > MAX_PACKET_LENGTH {
            return Err(Error::invalid("Packet exceeds the WinDivert buffer size."));
        }
        let result = if self.addresses.len() == CAPACITY
            || self.packets.len() + packet.len() > BUFFER_LENGTH
        {
            self.flush(send)
        } else {
            Ok(())
        };
        // A failed flush concerns previous packets. The new packet belongs to
        // the next batch; its caller must still receive the injection error.
        self.packets.extend_from_slice(packet);
        self.addresses.push(address);
        result
    }
    pub fn flush(
        &mut self,
        send: &mut impl FnMut(&[u8], &[DivertAddress]) -> Result<()>,
    ) -> Result<()> {
        if self.addresses.is_empty() {
            return Ok(());
        }
        let result = send(&self.packets, &self.addresses);
        self.discard();
        result
    }
    pub fn discard(&mut self) {
        self.packets.clear();
        self.addresses.clear();
    }
}

/// Validate the entire packed receive before exposing any slices to routing.
pub fn read_lengths(
    packets: &[u8],
    address_length: usize,
    lengths: &mut [usize; CAPACITY],
) -> Result<usize> {
    if address_length == 0 || !address_length.is_multiple_of(80) || address_length / 80 > CAPACITY {
        return Err(Error::invalid("Invalid WinDivert batch address length."));
    }
    let mut remaining = packets;
    for slot in lengths.iter_mut().take(address_length / 80) {
        let version = remaining.first().map(|b| b >> 4).unwrap_or(0);
        let minimum = match version {
            4 => 20,
            6 => 40,
            _ => return Err(Error::invalid("Invalid IP version in WinDivert batch.")),
        };
        if remaining.len() < minimum {
            return Err(Error::invalid("Truncated IP packet in WinDivert batch."));
        }
        let length = if version == 4 {
            u16::from_be_bytes([remaining[2], remaining[3]]) as usize
        } else {
            40 + u16::from_be_bytes([remaining[4], remaining[5]]) as usize
        };
        if length < minimum || length > remaining.len() {
            return Err(Error::invalid(
                "Invalid IP packet length in WinDivert batch.",
            ));
        }
        *slot = length;
        remaining = &remaining[length..];
    }
    if !remaining.is_empty() {
        return Err(Error::invalid(
            "WinDivert packet and address counts do not match.",
        ));
    }
    Ok(address_length / 80)
}
