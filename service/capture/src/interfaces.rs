// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    packet::Flow,
    policy::{InterfaceItem, InterfaceOptions},
    text, Error, Result,
};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

#[derive(Clone, Debug)]
pub struct InterfaceInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: u32,
    pub ipv4_index: u32,
    pub ipv6_index: u32,
    pub addresses: Vec<(IpAddr, u8)>,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Network {
    prefix: IpAddr,
    length: u8,
    broadcast: Option<IpAddr>,
}
impl Network {
    fn new(ip: IpAddr, length: u8) -> Option<Self> {
        if length == 0 {
            return None;
        }
        let (prefix, broadcast) = match ip {
            IpAddr::V4(ip) if length <= 32 => {
                let mask = u32::MAX << (32 - length);
                let base = u32::from(ip) & mask;
                (
                    IpAddr::V4(Ipv4Addr::from(base)),
                    (length <= 30).then(|| IpAddr::V4(Ipv4Addr::from(base | !mask))),
                )
            }
            IpAddr::V6(ip) if length <= 128 => (
                IpAddr::V6(Ipv6Addr::from(
                    u128::from(ip) & (u128::MAX << (128 - length)),
                )),
                None,
            ),
            _ => return None,
        };
        Some(Self {
            prefix,
            length,
            broadcast,
        })
    }
    fn contains(&self, peer: IpAddr) -> bool {
        match (self.prefix, peer) {
            (IpAddr::V4(prefix), IpAddr::V4(peer)) => {
                (u32::from(prefix) ^ u32::from(peer)) >> (32 - self.length) == 0
            }
            (IpAddr::V6(prefix), IpAddr::V6(peer)) => {
                (u128::from(prefix) ^ u128::from(peer)) >> (128 - self.length) == 0
            }
            _ => false,
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub struct LocalTraffic {
    networks: HashMap<(u32, bool), Vec<Network>>,
}
impl LocalTraffic {
    pub fn new(adapters: &[InterfaceInfo]) -> Self {
        let mut networks: HashMap<(u32, bool), Vec<Network>> = HashMap::new();
        for adapter in adapters {
            for (ip, length) in &adapter.addresses {
                let six = ip.is_ipv6();
                let index = if six {
                    adapter.ipv6_index
                } else {
                    adapter.ipv4_index
                };
                if index != 0 {
                    // Remember even an empty list when the adapter had addresses,
                    // matching the baseline's normalized snapshot equality.
                    let values = networks.entry((index, six)).or_default();
                    if let Some(network) = Network::new(*ip, *length) {
                        values.push(network);
                    }
                }
            }
        }
        for values in networks.values_mut() {
            values.sort_unstable();
            values.dedup();
        }
        Self { networks }
    }
    pub fn bypasses_address(&self, index: u32, destination: IpAddr) -> bool {
        match destination {
            IpAddr::V6(ip) => ip.is_multicast() || ip.is_unicast_link_local(),
            IpAddr::V4(ip) => {
                ip.is_multicast()
                    || ip.is_link_local()
                    || ip == Ipv4Addr::BROADCAST
                    || self
                        .networks
                        .get(&(index, false))
                        .is_some_and(|nets| nets.iter().any(|n| n.broadcast == Some(destination)))
            }
        }
    }
    pub fn bypasses_flow(&self, index: u32, flow: Flow) -> bool {
        if self.bypasses_address(index, flow.remote.ip) {
            return true;
        }
        if flow.protocol != 17 {
            return false;
        }
        let six = flow.remote.ip.is_ipv6();
        let (client, server) = if six { (546, 547) } else { (68, 67) };
        if flow.local_port == client && flow.remote_port == server
            || flow.local_port == server
                && matches!(flow.remote_port, p if p == client || p == server)
        {
            return true;
        }
        let discovery = |port| matches!(port, 5353 | 5355 | 1900 | 3702 | 137 | 138);
        (discovery(flow.local_port) || discovery(flow.remote_port))
            && self
                .networks
                .get(&(index, six))
                .is_some_and(|nets| nets.iter().any(|n| n.contains(flow.remote.ip)))
    }
}
pub fn discover(options: &InterfaceOptions, adapters: &[InterfaceInfo]) -> InterfaceOptions {
    let mut result = options.clone();
    for adapter in adapters {
        if let Some(known) = result
            .interfaces
            .iter_mut()
            .find(|i| text::equal(&i.id, &adapter.id))
        {
            known.name.clone_from(&adapter.name);
        } else {
            result.interfaces.push(InterfaceItem {
                id: adapter.id.clone(),
                name: adapter.name.clone(),
                monitored: options.monitor_new_interfaces,
            });
        }
    }
    result
}
/// Parse identity, never infer ownership from a friendly name or an index.
pub(crate) fn guid(value: &str) -> Option<[u8; 16]> {
    let value = value
        .strip_prefix('{')
        .and_then(|v| v.strip_suffix('}'))
        .unwrap_or(value);
    if value.len() != 36
        || value.as_bytes().iter().enumerate().any(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b != b'-'
            } else {
                !b.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    let digits: Vec<u8> = value.bytes().filter(|b| *b != b'-').collect();
    let mut output = [0; 16];
    for (i, pair) in digits.as_chunks::<2>().0.iter().enumerate() {
        let digit = |b: u8| {
            if b.is_ascii_digit() {
                b - b'0'
            } else {
                b.to_ascii_lowercase() - b'a' + 10
            }
        };
        output[i] = digit(pair[0]) * 16 + digit(pair[1]);
    }
    Some(output)
}
#[derive(Debug, PartialEq, Eq)]
pub struct InterfacePolicy {
    interfaces: HashMap<(u32, bool), (String, bool)>,
    monitor_new: bool,
    bypass_local: bool,
    local: LocalTraffic,
}
impl InterfacePolicy {
    pub fn new(
        options: &InterfaceOptions,
        adapters: &[InterfaceInfo],
        bypass_local: bool,
        excluded: &[String],
    ) -> Result<Self> {
        let excluded = excluded
            .iter()
            .map(|id| {
                guid(id).ok_or_else(|| Error::invalid("Invalid owned capture interface identity."))
            })
            .collect::<Result<Vec<_>>>()?;
        for (i, item) in options.interfaces.iter().enumerate() {
            if options.interfaces[..i]
                .iter()
                .any(|other| text::equal(&item.id, &other.id))
            {
                return Err(Error::invalid("Duplicate capture interface identity."));
            }
        }
        let mut interfaces = HashMap::new();
        for adapter in adapters {
            let owned = guid(&adapter.id).is_some_and(|id| excluded.contains(&id));
            let monitored = !owned
                && options
                    .interfaces
                    .iter()
                    .find(|i| text::equal(&i.id, &adapter.id))
                    .map(|i| i.monitored)
                    .unwrap_or(options.monitor_new_interfaces);
            for (index, six) in [(adapter.ipv4_index, false), (adapter.ipv6_index, true)] {
                if index != 0 {
                    interfaces.insert((index, six), (adapter.id.clone(), monitored));
                }
            }
        }
        Ok(Self {
            interfaces,
            monitor_new: options.monitor_new_interfaces,
            bypass_local,
            local: LocalTraffic::new(adapters),
        })
    }
    pub fn monitors(&self, index: u32, six: bool) -> bool {
        self.interfaces
            .get(&(index, six))
            .map(|p| p.1)
            .unwrap_or(self.monitor_new)
    }
    pub fn bypasses_address(&self, index: u32, destination: IpAddr) -> bool {
        self.bypass_local && self.local.bypasses_address(index, destination)
    }
    pub fn bypasses_flow(&self, index: u32, flow: Flow) -> bool {
        self.bypass_local && self.local.bypasses_flow(index, flow)
    }
    pub fn retains(&self, previous: &Self, index: u32, six: bool) -> bool {
        self.monitors(index, six)
            && match (
                self.interfaces.get(&(index, six)),
                previous.interfaces.get(&(index, six)),
            ) {
                (Some(a), Some(b)) => text::equal(&a.0, &b.0),
                (None, None) => true,
                _ => false,
            }
    }
}
