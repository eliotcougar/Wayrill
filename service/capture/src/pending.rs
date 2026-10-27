// SPDX-License-Identifier: GPL-3.0-only
use crate::address::DivertAddress;
use std::collections::VecDeque;

pub const WAIT_MILLISECONDS: u64 = 250;
pub type Original = (Vec<u8>, DivertAddress);
pub struct PendingPacket {
    pub bytes: Vec<u8>,
    pub address: DivertAddress,
    pub arrived: u64,
    pub fragments: Vec<Original>,
}
impl PendingPacket {
    pub fn size(&self) -> usize {
        self.bytes.len() + self.fragments.iter().map(|p| p.0.len()).sum::<usize>()
    }
}
#[derive(Default)]
pub struct PendingPackets {
    packets: VecDeque<PendingPacket>,
    bytes: usize,
}
impl PendingPackets {
    pub fn push(&mut self, packet: PendingPacket) -> bool {
        let size = packet.size();
        if self.packets.len() >= 512 || size > 4 * 1024 * 1024 - self.bytes {
            return false;
        }
        self.bytes += size;
        self.packets.push_back(packet);
        true
    }
    pub fn pop(&mut self) -> Option<PendingPacket> {
        let packet = self.packets.pop_front()?;
        self.bytes -= packet.size();
        Some(packet)
    }
    pub fn len(&self) -> usize {
        self.packets.len()
    }
    pub fn is_empty(&self) -> bool {
        self.packets.is_empty()
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}
