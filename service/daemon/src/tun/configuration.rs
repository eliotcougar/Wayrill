//! Configuration proofs and stale-family cleanup for an already owned vNIC.
use super::{address_prefix, invalid, prefixes, routes_ready};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, net::IpAddr, ptr};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{Foundation::*, NetworkManagement::IpHelper::*, Networking::WinSock::*};
fn checked(code: u32, action: &str) -> Result<()> {
    if code == 0 || [ERROR_NOT_FOUND, ERROR_FILE_NOT_FOUND].contains(&code) {
        Ok(())
    } else {
        Err(ApiError::io(
            action,
            std::io::Error::from_raw_os_error(code as i32),
        ))
    }
}
fn ip(address: &SOCKADDR_INET) -> IpAddr {
    unsafe {
        if address.si_family == AF_INET {
            IpAddr::from(address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes())
        } else {
            IpAddr::from(address.Ipv6.sin6_addr.u.Byte)
        }
    }
}
fn configured_families(settings: &Value) -> Result<BTreeSet<u16>> {
    Ok(prefixes(settings, "gateway")?
        .into_iter()
        .chain(prefixes(settings, "autoSystemRoutingTable")?)
        .map(|(ip, _)| if ip.is_ipv4() { AF_INET } else { AF_INET6 })
        .collect())
}
fn expected_dns(settings: &Value) -> Result<BTreeSet<IpAddr>> {
    match settings.get("dns") {
        None => Ok(BTreeSet::new()),
        Some(value) => value
            .as_array()
            .ok_or_else(|| invalid("TUN DNS must be a list of IP addresses."))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| invalid("Invalid TUN DNS address."))
            })
            .collect(),
    }
}
fn resolver_matches(mut actual: BTreeSet<IpAddr>, expected: &BTreeSet<IpAddr>) -> bool {
    // Windows publishes this complete legacy site-local trio after clearing
    // IPv6 NameServer. It is the native empty-list representation, not three
    // configured resolvers. Never hide a partial trio or an authored IPv6 list.
    let defaults: BTreeSet<IpAddr> = ["fec0:0:0:ffff::1", "fec0:0:0:ffff::2", "fec0:0:0:ffff::3"]
        .into_iter()
        .map(|ip| ip.parse().unwrap())
        .collect();
    if !expected.iter().any(IpAddr::is_ipv6) && defaults.is_subset(&actual) {
        actual.retain(|ip| !defaults.contains(ip));
    }
    &actual == expected
}
fn effective_mtu(settings: &Value) -> Option<u32> {
    // Pinned infra/conf/tun.go turns an omitted/zero MTU into 1500.
    match settings.get("mtu") {
        None | Some(Value::Null) => Some(1500),
        Some(value) => value.as_u64().filter(|m| *m <= u32::MAX as u64).map(|m| {
            if m == 0 {
                1500
            } else {
                m as u32
            }
        }),
    }
}
fn dns_ready(index: u32, expected: &BTreeSet<IpAddr>) -> Result<bool> {
    let mut luid = Default::default();
    checked(
        unsafe { ConvertInterfaceIndexToLuid(index, &mut luid) },
        "Identify owned TUN resolver",
    )?;
    let mut size = 16 * 1024;
    loop {
        if size > 4 * 1024 * 1024 {
            return Err(invalid("Owned TUN resolver inventory exceeded its limit."));
        }
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let rows = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let code = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                GAA_FLAG_SKIP_UNICAST | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST,
                ptr::null(),
                rows,
                &mut size,
            )
        };
        if code == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        checked(code, "Read owned TUN resolver")?;
        let mut row = rows;
        while !row.is_null() {
            let adapter = unsafe { &*row };
            if unsafe { adapter.Luid.Value == luid.Value } {
                let mut actual = BTreeSet::new();
                let mut server = adapter.FirstDnsServerAddress;
                while !server.is_null() {
                    let value = unsafe { &*server };
                    let address = value.Address;
                    if address.lpSockaddr.is_null() {
                        return Ok(false);
                    }
                    unsafe {
                        match (*address.lpSockaddr).sa_family {
                            AF_INET
                                if address.iSockaddrLength as usize
                                    >= std::mem::size_of::<SOCKADDR_IN>() =>
                            {
                                actual.insert(IpAddr::from(
                                    (*address.lpSockaddr.cast::<SOCKADDR_IN>())
                                        .sin_addr
                                        .S_un
                                        .S_addr
                                        .to_ne_bytes(),
                                ));
                            }
                            AF_INET6
                                if address.iSockaddrLength as usize
                                    >= std::mem::size_of::<SOCKADDR_IN6>() =>
                            {
                                actual.insert(IpAddr::from(
                                    (*address.lpSockaddr.cast::<SOCKADDR_IN6>())
                                        .sin6_addr
                                        .u
                                        .Byte,
                                ));
                            }
                            _ => return Ok(false),
                        }
                    }
                    server = value.Next;
                }
                return Ok(resolver_matches(actual, expected));
            }
            row = adapter.Next;
        }
        return Ok(false);
    }
}
pub(super) fn ready(index: u32, settings: &Value) -> Result<bool> {
    prefixes(settings, "gateway")?;
    // Interface addresses retain host bits; route prefixes are network-masked.
    let gateways = settings["gateway"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| address_prefix(v.as_str().ok_or_else(|| invalid("Invalid TUN gateway."))?))
        .collect::<Result<BTreeSet<_>>>()?;
    let Some(mtu) = effective_mtu(settings) else {
        return Ok(false);
    };
    if gateways.is_empty() || !routes_ready(index, &prefixes(settings, "autoSystemRoutingTable")?)?
    {
        return Ok(false);
    }
    let mut table = ptr::null_mut();
    checked(
        unsafe { GetUnicastIpAddressTable(AF_UNSPEC, &mut table) },
        "Read owned TUN addresses",
    )?;
    if table.is_null() {
        return Ok(false);
    }
    let addresses = unsafe {
        let rows =
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let result = rows
            .iter()
            .filter(|r| {
                r.InterfaceIndex == index && [AF_INET, AF_INET6].contains(&r.Address.si_family)
            })
            .map(|r| (ip(&r.Address), r.OnLinkPrefixLength))
            .collect::<BTreeSet<_>>();
        FreeMibTable(table.cast());
        result
    };
    if !gateways.is_subset(&addresses) {
        return Ok(false);
    }
    for family in configured_families(settings)? {
        let mut row = MIB_IPINTERFACE_ROW {
            Family: family,
            InterfaceIndex: index,
            ..Default::default()
        };
        checked(
            unsafe { GetIpInterfaceEntry(&mut row) },
            "Read owned TUN MTU",
        )?;
        if row.NlMtu != mtu {
            return Ok(false);
        }
    }
    dns_ready(index, &expected_dns(settings)?)
}
// Stored before capture can start, under the adapter's protected GUID/token
// record. Destination alone is not a Windows route key: the next hop matters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CaptureRoute {
    destination: IpAddr,
    prefix: u8,
    next_hop: IpAddr,
    metric: u32,
}
impl CaptureRoute {
    pub(super) fn valid(&self) -> bool {
        self.destination.is_ipv4() == self.next_hop.is_ipv4()
            && super::prefix(&format!("{}/{}", self.destination, self.prefix))
                .is_ok_and(|value| value == (self.destination, self.prefix))
    }
    pub(super) fn on_link(destination: IpAddr, prefix: u8, metric: u32) -> Self {
        Self {
            destination,
            prefix,
            next_hop: if destination.is_ipv4() {
                "0.0.0.0".parse().unwrap()
            } else {
                "::".parse().unwrap()
            },
            metric,
        }
    }
    fn row(&self, index: u32) -> MIB_IPFORWARD_ROW2 {
        let mut row = MIB_IPFORWARD_ROW2::default();
        unsafe { InitializeIpForwardEntry(&mut row) };
        row.InterfaceIndex = index;
        row.Protocol = MIB_IPPROTO_NETMGMT;
        row.DestinationPrefix = IP_ADDRESS_PREFIX {
            Prefix: super::socket_address(self.destination),
            PrefixLength: self.prefix,
        };
        row.NextHop = super::socket_address(self.next_hop);
        row.Metric = self.metric;
        row
    }
    fn matches(&self, row: &MIB_IPFORWARD_ROW2) -> bool {
        ip(&row.DestinationPrefix.Prefix) == self.destination
            && row.DestinationPrefix.PrefixLength == self.prefix
            && ip(&row.NextHop) == self.next_hop
            && row.Metric == self.metric
            && row.Protocol == MIB_IPPROTO_NETMGMT
    }
}
pub(super) fn capture_routes(settings: &Value) -> Result<Vec<CaptureRoute>> {
    let peer = super::ipv4_peer(settings)?;
    let mut result = Vec::new();
    for (ip, prefix) in prefixes(settings, "autoSystemRoutingTable")? {
        // Xray first publishes an on-link row with metric zero. Journal it too
        // so a worker/start failure cannot strand the intermediate route.
        let initial = CaptureRoute::on_link(ip, prefix, 0);
        let mut final_route = initial.clone();
        final_route.metric = super::capture_route_metric(prefix);
        if let Some(peer) = peer.filter(|_| ip.is_ipv4()) {
            final_route.next_hop = peer.into();
        }
        if initial != final_route {
            result.push(initial);
        }
        result.push(final_route);
    }
    Ok(result)
}
pub(super) fn retire_routes(index: u32, routes: &[CaptureRoute]) -> Result<()> {
    for route in routes {
        let mut current = route.row(index);
        let code = unsafe { GetIpForwardEntry2(&mut current) };
        if [ERROR_NOT_FOUND, ERROR_FILE_NOT_FOUND].contains(&code) {
            continue;
        }
        checked(code, "Inspect owned TUN capture route")?;
        // External metric/protocol changes, different next hops and routes on
        // other interfaces never become ours just because a prefix matches.
        if route.matches(&current) {
            checked(
                unsafe { DeleteIpForwardEntry2(&current) },
                "Retire owned TUN capture route",
            )?;
        }
    }
    Ok(())
}
pub(super) fn retire_capture_routes(index: u32, settings: &Value) -> Result<()> {
    retire_routes(index, &capture_routes(settings)?)
}
pub(super) fn retire_unused(index: u32, settings: &Value) -> Result<()> {
    // The upstream Windows setup only flushes populated IP families. Clear an
    // inactive family so switching from dual stack to IPv4 cannot leave stale
    // IPv6 capture active on a retained interface. Other interfaces are untouched.
    let families = configured_families(settings)?;
    for family in [AF_INET, AF_INET6] {
        if families.contains(&family) {
            continue;
        }
        let mut table = ptr::null_mut();
        checked(
            unsafe { GetIpForwardTable2(family, &mut table) },
            "Read stale TUN routes",
        )?;
        let rows = if table.is_null() {
            Vec::new()
        } else {
            unsafe {
                let rows = std::slice::from_raw_parts(
                    (*table).Table.as_ptr(),
                    (*table).NumEntries as usize,
                )
                .iter()
                .filter(|r| r.InterfaceIndex == index)
                .copied()
                .collect::<Vec<_>>();
                FreeMibTable(table.cast());
                rows
            }
        };
        for row in rows {
            checked(
                unsafe { DeleteIpForwardEntry2(&row) },
                "Remove stale owned TUN route",
            )?;
        }
        let mut table = ptr::null_mut();
        checked(
            unsafe { GetUnicastIpAddressTable(family, &mut table) },
            "Read stale TUN addresses",
        )?;
        let rows = if table.is_null() {
            Vec::new()
        } else {
            unsafe {
                let rows = std::slice::from_raw_parts(
                    (*table).Table.as_ptr(),
                    (*table).NumEntries as usize,
                )
                .iter()
                .filter(|r| r.InterfaceIndex == index && r.PrefixOrigin == IpPrefixOriginManual)
                .copied()
                .collect::<Vec<_>>();
                FreeMibTable(table.cast());
                rows
            }
        };
        for row in rows {
            checked(
                unsafe { DeleteUnicastIpAddressEntry(&row) },
                "Remove stale owned TUN address",
            )?;
        }
    }
    Ok(())
}
pub(super) fn reset_forwarding(index: u32) -> Result<()> {
    for family in [AF_INET, AF_INET6] {
        let mut row = MIB_IPINTERFACE_ROW {
            Family: family,
            InterfaceIndex: index,
            ..Default::default()
        };
        let code = unsafe { GetIpInterfaceEntry(&mut row) };
        if [ERROR_NOT_FOUND, ERROR_FILE_NOT_FOUND].contains(&code) {
            continue;
        }
        checked(code, "Read owned TUN forwarding")?;
        if row.ForwardingEnabled {
            row.ForwardingEnabled = false;
            // Get can return a nonzero IPv4 SitePrefixLength, but Set requires
            // zero even for a read-modify-write of another field (netioapi).
            if family == AF_INET {
                row.SitePrefixLength = 0;
            }
            checked(
                unsafe { SetIpInterfaceEntry(&mut row) },
                "Reset owned TUN forwarding",
            )?;
        }
    }
    Ok(())
}
pub(super) fn active(index: u32, enabled: bool) -> Result<()> {
    checked(
        unsafe {
            SetIfEntry(&MIB_IFROW {
                dwIndex: index,
                dwAdminStatus: if enabled { 1 } else { 2 },
                ..Default::default()
            })
        },
        "Set owned TUN capture state",
    )?;
    let mut row = MIB_IF_ROW2 {
        InterfaceIndex: index,
        ..Default::default()
    };
    checked(
        unsafe { GetIfEntry2(&mut row) },
        "Verify owned TUN capture state",
    )?;
    if row.AdminStatus != if enabled { 1 } else { 2 } {
        return Err(invalid(
            "Windows did not apply the owned TUN administrative state.",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::super::socket_address;
    use super::*;
    use serde_json::json;
    #[test]
    fn readiness_resolves_the_pinned_core_mtu_default_without_populating_the_graph() {
        for value in [
            json!({}),
            json!({"mtu":null}),
            json!({"mtu":0}),
            json!({"mtu":1500}),
        ] {
            assert_eq!(effective_mtu(&value), Some(1500));
        }
        assert_eq!(effective_mtu(&json!({"mtu":1420})), Some(1420));
        for value in [
            json!({"mtu":-1}),
            json!({"mtu":1.5}),
            json!({"mtu":"1500"}),
            json!({"mtu":4294967296u64}),
        ] {
            assert_eq!(effective_mtu(&value), None);
        }
    }
    #[test]
    fn resolver_proof_uses_effective_ip_values_and_rejects_malformed_lists() {
        assert!(expected_dns(&json!({})).unwrap().is_empty());
        assert!(expected_dns(&json!({"dns":[]})).unwrap().is_empty());
        assert_eq!(
            expected_dns(&json!({"dns":["1.1.1.1","2001:0db8::1","2001:db8::1"]})).unwrap(),
            BTreeSet::from(["1.1.1.1".parse().unwrap(), "2001:db8::1".parse().unwrap()])
        );
        for value in [
            json!({"dns":null}),
            json!({"dns":"1.1.1.1"}),
            json!({"dns":["resolver.example"]}),
            json!({"dns":[1]}),
        ] {
            assert!(expected_dns(&value).is_err());
        }
    }
    #[test]
    fn native_empty_ipv6_dns_trio_does_not_hide_external_resolver_changes() {
        let trio: BTreeSet<IpAddr> = ["fec0:0:0:ffff::1", "fec0:0:0:ffff::2", "fec0:0:0:ffff::3"]
            .into_iter()
            .map(|ip| ip.parse().unwrap())
            .collect();
        assert!(resolver_matches(trio.clone(), &BTreeSet::new()));
        let expected = BTreeSet::from(["1.1.1.1".parse().unwrap()]);
        let mut actual = trio.clone();
        actual.extend(&expected);
        assert!(resolver_matches(actual.clone(), &expected));
        actual.insert("9.9.9.9".parse().unwrap());
        assert!(!resolver_matches(actual, &expected));
        assert!(!resolver_matches(
            BTreeSet::from(["fec0:0:0:ffff::1".parse().unwrap()]),
            &BTreeSet::new()
        ));
        assert!(resolver_matches(trio.clone(), &trio));
        let mut explicit = BTreeSet::from(["2001:db8::1".parse().unwrap()]);
        explicit.extend(&trio);
        assert!(!resolver_matches(
            explicit,
            &BTreeSet::from(["2001:db8::1".parse().unwrap()])
        ));
    }
    #[test]
    fn gateway_proof_retains_host_bits_in_both_families() {
        for (cidr, host, network, bits) in [
            ("10.90.0.1/24", "10.90.0.1", "10.90.0.0", 24),
            ("fd90::1/64", "fd90::1", "fd90::", 64),
        ] {
            assert_eq!(address_prefix(cidr).unwrap(), (host.parse().unwrap(), bits));
            assert_eq!(
                super::super::prefix(cidr).unwrap(),
                (network.parse().unwrap(), bits)
            );
        }
        for invalid in ["10.90.0.1/33", "fd90::1/129", "fd90::1", "wrong/24"] {
            assert!(address_prefix(invalid).is_err());
        }
    }
    #[test]
    fn capture_inventory_covers_worker_staging_and_exact_final_route_keys() {
        let settings = serde_json::json!({"gateway":["10.90.0.1/24","fd90::1/64"],
            "autoSystemRoutingTable":["198.51.100.8/32","2001:db8::8/128"]});
        let routes = capture_routes(&settings).unwrap();
        assert_eq!(routes.len(), 4);
        assert!(routes.iter().all(CaptureRoute::valid));
        let route = routes
            .iter()
            .find(|r| r.next_hop == "10.90.0.2".parse::<IpAddr>().unwrap())
            .unwrap();
        let mut row = route.row(12);
        assert!(route.matches(&row));
        row.Metric += 1;
        assert!(!route.matches(&row));
        row.Metric = route.metric;
        row.Protocol = MIB_IPPROTO_OTHER;
        assert!(!route.matches(&row));
        row.Protocol = MIB_IPPROTO_NETMGMT;
        row.NextHop = super::super::socket_address("10.90.0.3".parse().unwrap());
        assert!(!route.matches(&row));
        let mut invalid = route.clone();
        invalid.prefix = 33;
        assert!(!invalid.valid());
        invalid.prefix = 24; // unnormalized host bits are not an owned route
        assert!(!invalid.valid());
        invalid = route.clone();
        invalid.next_hop = "::".parse().unwrap();
        assert!(!invalid.valid());
    }
    #[test]
    fn scope_includes_address_and_route_families() {
        assert_eq!(
            configured_families(
                &json!({"gateway":["10.90.0.1/24"],"autoSystemRoutingTable":["::/1"]})
            )
            .unwrap(),
            BTreeSet::from([AF_INET, AF_INET6])
        );
        assert_eq!(
            configured_families(&json!({"gateway":["10.90.0.1/24"]})).unwrap(),
            BTreeSet::from([AF_INET])
        );
        for address in ["10.90.0.1".parse().unwrap(), "fd90::1".parse().unwrap()] {
            assert_eq!(ip(&socket_address(address)), address);
        }
    }
}
