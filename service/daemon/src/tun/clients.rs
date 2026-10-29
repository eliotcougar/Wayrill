//! IPv6 service on the existing ICS private link. IPv4 DHCP/NAT stays in Windows.
//! Only a generated ULA address and two journaled private-interface flags are owned.
use super::{guid_luid, socket_address};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, Ipv6Addr, SocketAddrV6, UdpSocket},
    os::windows::io::FromRawSocket,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::{ERROR_NOT_FOUND, ERROR_OBJECT_ALREADY_EXISTS},
    NetworkManagement::IpHelper::*,
    Networking::WinSock::*,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Flags {
    forwarding: bool,
    advertising: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Phase {
    Captured,
    Activating,
    Active,
    Restoring,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Lease {
    original: Flags,
    pub phase: Phase,
}

fn failure(message: impl Into<String>) -> ApiError {
    ApiError::new("ICS_IPV6", message)
}
pub(super) fn prefix(id: &str) -> Ipv6Addr {
    // RFC 4193 locally assigned /64, stable for this private adapter. No global
    // address/prefix, DHCPv6-PD or upstream reachability is implied by this ULA.
    let hash = Sha256::digest(id.as_bytes());
    let mut bytes = [0; 16];
    bytes[0] = 0xfd;
    bytes[1..6].copy_from_slice(&hash[..5]);
    Ipv6Addr::from(bytes)
}
fn gateway(id: &str) -> Ipv6Addr {
    Ipv6Addr::from(u128::from(prefix(id)) | 1)
}
fn interface(id: &str) -> Result<MIB_IPINTERFACE_ROW> {
    let mut row = MIB_IPINTERFACE_ROW {
        Family: AF_INET6,
        InterfaceLuid: guid_luid(id)?,
        ..Default::default()
    };
    let code = unsafe { GetIpInterfaceEntry(&mut row) };
    if code != 0 {
        return Err(failure(format!("The ICS private adapter's IPv6 interface is unavailable ({code}). Enable IPv6 on that adapter before sharing IPv6.")));
    }
    Ok(row)
}
fn flags(row: &MIB_IPINTERFACE_ROW) -> Flags {
    Flags {
        forwarding: row.ForwardingEnabled,
        advertising: row.AdvertisingEnabled,
    }
}
fn set_flags(id: &str, value: Flags) -> Result<()> {
    let mut row = interface(id)?;
    if flags(&row) != value {
        row.ForwardingEnabled = value.forwarding;
        row.AdvertisingEnabled = value.advertising;
        let code = unsafe { SetIpInterfaceEntry(&mut row) };
        if code != 0 {
            return Err(failure(format!(
                "Set the recorded ICS private IPv6 settings failed ({code})."
            )));
        }
    }
    if flags(&interface(id)?) != value {
        return Err(failure(
            "Windows did not retain the recorded ICS private IPv6 settings.",
        ));
    }
    Ok(())
}
fn addresses() -> Result<Vec<MIB_UNICASTIPADDRESS_ROW>> {
    let mut table = std::ptr::null_mut();
    let code = unsafe { GetUnicastIpAddressTable(AF_INET6, &mut table) };
    if code != 0 {
        return Err(failure(format!("Inspect IPv6 addresses failed ({code}).")));
    }
    struct Table(*mut MIB_UNICASTIPADDRESS_TABLE);
    impl Drop for Table {
        fn drop(&mut self) {
            unsafe {
                FreeMibTable(self.0.cast());
            }
        }
    }
    let table = Table(table);
    Ok(unsafe {
        std::slice::from_raw_parts((*table.0).Table.as_ptr(), (*table.0).NumEntries as usize)
    }
    .to_vec())
}
fn ip(row: &MIB_UNICASTIPADDRESS_ROW) -> Ipv6Addr {
    unsafe { Ipv6Addr::from(row.Address.Ipv6.sin6_addr.u.Byte) }
}
fn address(id: &str) -> Result<Option<MIB_UNICASTIPADDRESS_ROW>> {
    let mut row = MIB_UNICASTIPADDRESS_ROW {
        InterfaceLuid: guid_luid(id)?,
        Address: socket_address(IpAddr::V6(gateway(id))),
        ..Default::default()
    };
    let code = unsafe { GetUnicastIpAddressEntry(&mut row) };
    if code == ERROR_NOT_FOUND {
        return Ok(None);
    }
    if code != 0 {
        return Err(failure(format!(
            "Read the shared IPv6 gateway failed ({code})."
        )));
    }
    Ok(Some(row))
}
fn owned(row: &MIB_UNICASTIPADDRESS_ROW) -> bool {
    row.OnLinkPrefixLength == 64
        && row.PrefixOrigin == IpPrefixOriginManual
        && row.SuffixOrigin == IpSuffixOriginManual
        && row.ValidLifetime == u32::MAX
        && row.PreferredLifetime == u32::MAX
        && row.SkipAsSource
}
pub(super) fn preflight(id: &str) -> Result<()> {
    let row = interface(id)?;
    if row.NlMtu < 1280 {
        return Err(failure(
            "The ICS private IPv6 adapter needs an MTU of at least 1280.",
        ));
    }
    let local = addresses()?;
    if !local.iter().any(|a| {
        a.InterfaceIndex == row.InterfaceIndex
            && ip(a).is_unicast_link_local()
            && a.DadState == IpDadStatePreferred
    }) {
        return Err(failure(
            "The ICS private adapter needs an active IPv6 link-local address before sharing IPv6.",
        ));
    }
    let ula = prefix(id).octets();
    if local.iter().any(|a| {
        let v = ip(a);
        let same = v.octets()[..8] == ula[..8];
        (same && (a.InterfaceIndex != row.InterfaceIndex || v != gateway(id)))
            || (a.InterfaceIndex == row.InterfaceIndex
                && !v.is_unicast_link_local()
                && v != gateway(id))
    }) {
        return Err(failure("The private adapter already has another IPv6 network, or the generated sharing prefix is in use. Existing IPv6 networks were left unchanged; automatic IPv6 sharing currently requires a private link with only link-local IPv6 addressing."));
    }
    Ok(())
}
fn restore_flags_allowed(phase: Phase, original: Flags, observed: Flags) -> bool {
    observed == original || observed == (Flags { forwarding: true, advertising: false })
        // A handoff can clear native flags before client activation, as can
        // role handback after its durable restoration checkpoint.
        || (matches!(phase, Phase::Captured | Phase::Restoring)
            && observed == (Flags { forwarding: false, advertising: false }))
}
impl Lease {
    pub(super) fn capture(id: &str) -> Result<Self> {
        preflight(id)?;
        if address(id)?.is_some() {
            return Err(failure("The shared IPv6 gateway already exists without this ownership lease. It was left unchanged."));
        }
        Ok(Self {
            original: flags(&interface(id)?),
            phase: Phase::Captured,
        })
    }
    pub(super) fn check_restore(&self, id: &str) -> Result<()> {
        // Captured means no gateway was created by this lease. Do not
        // claim a concurrent external address, but still guard the flags
        // against external changes before restoring the captured baseline.
        if self.phase != Phase::Captured {
            if let Some(row) = address(id)? {
                if !owned(&row) {
                    return Err(failure("The shared IPv6 gateway address was changed externally; it was preserved. Review sharing recovery."));
                }
            }
        }
        let observed = flags(&interface(id)?);
        if !restore_flags_allowed(self.phase, self.original, observed) {
            return Err(failure("Private IPv6 forwarding/advertising changed externally; those settings were preserved. Review sharing recovery."));
        }
        Ok(())
    }
    pub(super) fn activate(&self, id: &str) -> Result<()> {
        if self.phase != Phase::Activating {
            return Err(failure("IPv6 activation has no durable checkpoint."));
        }
        let mut row = MIB_UNICASTIPADDRESS_ROW::default();
        unsafe {
            InitializeUnicastIpAddressEntry(&mut row);
        }
        row.InterfaceLuid = guid_luid(id)?;
        row.Address = socket_address(IpAddr::V6(gateway(id)));
        row.OnLinkPrefixLength = 64;
        row.PrefixOrigin = IpPrefixOriginManual;
        row.SuffixOrigin = IpSuffixOriginManual;
        row.ValidLifetime = u32::MAX;
        row.PreferredLifetime = u32::MAX;
        row.SkipAsSource = true;
        let code = unsafe { CreateUnicastIpAddressEntry(&row) };
        if code != 0 {
            let reason = if code == ERROR_OBJECT_ALREADY_EXISTS {
                "A different operation created the IPv6 gateway during activation."
            } else {
                "Create the shared IPv6 gateway failed."
            };
            return Err(ApiError::new(
                "ICS_IPV6_CREATE",
                format!("{reason} Windows error {code}."),
            ));
        }
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let current = address(id)?
                .ok_or_else(|| failure("The shared IPv6 gateway disappeared during activation."))?;
            if !owned(&current) {
                return Err(failure(
                    "The shared IPv6 gateway changed during activation.",
                ));
            }
            if current.DadState == IpDadStatePreferred {
                break;
            }
            if current.DadState == IpDadStateDuplicate || Instant::now() >= deadline {
                return Err(failure(
                    "The shared IPv6 gateway failed duplicate-address detection.",
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        set_flags(
            id,
            Flags {
                forwarding: true,
                advertising: false,
            },
        )
    }
    pub(super) fn restore(&self, id: &str) -> Result<()> {
        self.check_restore(id)?;
        // Role handback can change these native flags; the pre-handoff ownership
        // check and durable Restoring phase authorize this exact restoration.
        if self.phase != Phase::Captured {
            if let Some(row) = address(id)? {
                if !owned(&row) {
                    return Err(failure(
                        "The shared IPv6 gateway changed externally; it was preserved.",
                    ));
                }
                let code = unsafe { DeleteUnicastIpAddressEntry(&row) };
                if code != 0 {
                    return Err(failure(format!(
                        "Remove the owned IPv6 gateway failed ({code})."
                    )));
                }
            }
            if address(id)?.is_some() {
                return Err(failure("The owned IPv6 gateway did not disappear."));
            }
        }
        set_flags(id, self.original)?;
        Ok(())
    }
    pub(super) fn poll(&self, id: &str) -> Result<()> {
        if self.phase == Phase::Active
            && (flags(&interface(id)?)
                != (Flags {
                    forwarding: true,
                    advertising: false,
                })
                || address(id)?.is_none_or(|r| !owned(&r) || r.DadState != IpDadStatePreferred))
        {
            return Err(failure("The active shared IPv6 gateway changed or disappeared. Capture must stop and restore sharing."));
        }
        Ok(())
    }
    pub(super) fn release_owned(&self, id: &str) -> Result<()> {
        // Keep current sharing deliberately preserves external changes. Release
        // only our exact gateway and flags that still have our active values.
        if self.phase == Phase::Captured {
            return Ok(());
        }
        if let Some(row) = address(id)? {
            if owned(&row) {
                let code = unsafe { DeleteUnicastIpAddressEntry(&row) };
                if code != 0 {
                    return Err(failure(format!(
                        "Release the owned IPv6 gateway failed ({code})."
                    )));
                }
            }
        }
        if flags(&interface(id)?)
            == (Flags {
                forwarding: true,
                advertising: false,
            })
        {
            set_flags(id, self.original)?;
        }
        Ok(())
    }
}

/// Short, unsolicited RFC 4861/4862 RAs. No packet receiver or client parser,
/// DHCP replacement, WinDivert handle, native IPv6 prefix delegation or NAT66.
pub(super) struct Advertiser {
    socket: UdpSocket,
    target: SocketAddrV6,
    prefix: Ipv6Addr,
    mtu: u32,
    original_mtu: u32,
    last: Instant,
}
fn ra(prefix: Ipv6Addr, mtu: u32, withdraw: bool) -> Vec<u8> {
    let mut bytes = vec![0; 56];
    bytes[0] = 134;
    bytes[4] = 64;
    bytes[6..8].copy_from_slice(&(if withdraw { 0u16 } else { 30 }).to_be_bytes());
    bytes[16] = 3;
    bytes[17] = 4;
    bytes[18] = 64;
    bytes[19] = 0xc0; // on-link + autonomous
    bytes[20..24].copy_from_slice(&(if withdraw { 0u32 } else { 120 }).to_be_bytes());
    bytes[24..28].copy_from_slice(&(if withdraw { 0u32 } else { 60 }).to_be_bytes());
    bytes[32..48].copy_from_slice(&prefix.octets());
    bytes[48] = 5;
    bytes[49] = 1;
    bytes[52..56].copy_from_slice(&mtu.to_be_bytes());
    bytes
}
impl Advertiser {
    pub(super) fn new(id: &str, mtu: u32) -> Result<Self> {
        let row = interface(id)?;
        let source = addresses()?
            .into_iter()
            .find(|a| {
                a.InterfaceIndex == row.InterfaceIndex
                    && ip(a).is_unicast_link_local()
                    && a.DadState == IpDadStatePreferred
            })
            .ok_or_else(|| failure("The private IPv6 link-local gateway is unavailable."))?;
        // Initialize Winsock through std even during cold journal recovery.
        let _init = UdpSocket::bind((Ipv6Addr::LOCALHOST, 0))
            .map_err(|e| ApiError::io("Initialize IPv6 advertisements", e))?;
        let raw = unsafe { socket(AF_INET6 as i32, SOCK_RAW, IPPROTO_ICMPV6) };
        if raw == INVALID_SOCKET {
            return Err(failure(format!(
                "Open IPv6 router advertisements failed ({}).",
                unsafe { WSAGetLastError() }
            )));
        }
        let socket = unsafe { UdpSocket::from_raw_socket(raw as u64) };
        for (option, value) in [
            (IPV6_MULTICAST_IF, row.InterfaceIndex),
            (IPV6_MULTICAST_HOPS, 255),
        ] {
            if unsafe { setsockopt(raw, IPPROTO_IPV6, option, (&value as *const u32).cast(), 4) }
                != 0
            {
                return Err(failure(format!(
                    "Scope IPv6 advertisements failed ({}).",
                    unsafe { WSAGetLastError() }
                )));
            }
        }
        let mut addr = unsafe { socket_address(IpAddr::V6(ip(&source))).Ipv6 };
        addr.Anonymous.sin6_scope_id = row.InterfaceIndex;
        if unsafe {
            bind(
                raw,
                (&addr as *const SOCKADDR_IN6).cast(),
                std::mem::size_of::<SOCKADDR_IN6>() as i32,
            )
        } != 0
        {
            return Err(failure(format!(
                "Bind IPv6 advertisements failed ({}).",
                unsafe { WSAGetLastError() }
            )));
        }
        socket
            .set_write_timeout(Some(Duration::from_millis(500)))
            .map_err(|e| ApiError::io("Bound IPv6 advertisements", e))?;
        Ok(Self {
            socket,
            target: SocketAddrV6::new("ff02::1".parse().unwrap(), 0, 0, row.InterfaceIndex),
            prefix: prefix(id),
            mtu: mtu.min(row.NlMtu).clamp(1280, 65535),
            original_mtu: row.NlMtu.clamp(1280, 65535),
            last: Instant::now() - Duration::from_secs(10),
        })
    }
    fn send(&self, withdraw: bool) -> Result<()> {
        let packet = ra(
            self.prefix,
            if withdraw {
                self.original_mtu
            } else {
                self.mtu
            },
            withdraw,
        );
        let n = self
            .socket
            .send_to(&packet, self.target)
            .map_err(|e| ApiError::io("Send private IPv6 router advertisement", e))?;
        if n != packet.len() {
            return Err(failure("Incomplete IPv6 router advertisement."));
        }
        Ok(())
    }
    pub(super) fn poll(&mut self) -> Result<()> {
        if self.last.elapsed() >= Duration::from_secs(10) {
            self.send(false)?;
            self.last = Instant::now();
        }
        Ok(())
    }
    pub(super) fn withdraw(&self) -> Result<()> {
        self.send(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restoration_accepts_only_original_owned_or_known_handback_flags() {
        let original = Flags {
            forwarding: false,
            advertising: true,
        };
        let active = Flags {
            forwarding: true,
            advertising: false,
        };
        let cleared = Flags {
            forwarding: false,
            advertising: false,
        };
        let foreign = Flags {
            forwarding: true,
            advertising: true,
        };
        for phase in [
            Phase::Captured,
            Phase::Activating,
            Phase::Active,
            Phase::Restoring,
        ] {
            assert!(restore_flags_allowed(phase, original, original));
            assert!(restore_flags_allowed(phase, original, active));
            assert!(!restore_flags_allowed(phase, original, foreign));
            assert_eq!(
                restore_flags_allowed(phase, original, cleared),
                matches!(phase, Phase::Captured | Phase::Restoring)
            );
        }
    }
    #[test]
    fn generated_prefix_is_stable_adapter_specific_ula() {
        let id = "22944640-3598-4b5d-aa13-06ea38f26fb0";
        assert_eq!(prefix(id), "fdd8:3e4a:2e07::".parse::<Ipv6Addr>().unwrap());
        assert_eq!(prefix(id).octets()[0], 0xfd);
        assert_ne!(prefix(id), prefix("830b3b6e-fa82-4103-8ff5-66f93d1dafa4"));
    }
    #[test]
    fn advertisement_and_withdrawal_have_bounded_slaac_lifetimes_and_mtu() {
        let p = "fd28:14:137::".parse().unwrap();
        let active = ra(p, 1420, false);
        assert_eq!(active.len(), 56);
        assert_eq!(&active[..2], &[134, 0]);
        assert_eq!(&active[6..8], &30u16.to_be_bytes());
        assert_eq!(&active[16..20], &[3, 4, 64, 0xc0]);
        assert_eq!(&active[20..24], &120u32.to_be_bytes());
        assert_eq!(&active[24..28], &60u32.to_be_bytes());
        assert_eq!(&active[32..48], &p.octets());
        assert_eq!(&active[52..56], &1420u32.to_be_bytes());
        let stopped = ra(p, 1420, true);
        assert_eq!(&stopped[6..8], &[0, 0]);
        assert_eq!(&stopped[20..28], &[0; 8]);
    }
}
