// SPDX-License-Identifier: GPL-3.0-only
//! Fixed ICS operations on a dedicated STA. No service restart, script,
//! caller-selected execution, firewall-profile mutation or generic COM endpoint.
use super::{
    adapters::{self, NativeBuffer},
    clock,
    com::{Apartment, Enumeration},
};
use crate::{
    sharing::{self, Address, Change, Connection, Mapping, Snapshot},
    text, Error, Result,
};
use std::{
    collections::{HashMap, HashSet},
    net::Ipv4Addr,
    thread,
    time::Duration,
};
use windows::Win32::{
    NetworkManagement::WindowsFirewall::{
        INetConnection, INetSharingConfiguration, INetSharingManager, INetSharingPortMapping,
        INetSharingPortMappingProps, NetSharingManager, SHARINGCONNECTIONTYPE,
        SHARINGCONNECTION_ENUM_FLAGS,
    },
    System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    IP_ADAPTER_ADDRESSES_LH, IP_ADAPTER_DNS_SERVER_ADDRESS_XP, IP_ADAPTER_UNICAST_ADDRESS_LH,
};

struct Network {
    ipv4: Vec<Address>,
    dns: Vec<String>,
    dhcp: bool,
}
fn ipv4(buffer: &NativeBuffer, pointer: *const u8, length: i32) -> Result<Option<Ipv4Addr>> {
    if length < 2 {
        return Err(Error::invalid("Invalid sharing socket address."));
    }
    let raw = buffer.bytes(pointer, length as usize)?;
    if u16::from_ne_bytes(raw[..2].try_into().unwrap()) != 2 {
        return Ok(None);
    }
    if raw.len() < 16 {
        return Err(Error::invalid("Truncated sharing IPv4 address."));
    }
    Ok(Some(Ipv4Addr::from(
        <[u8; 4]>::try_from(&raw[4..8]).unwrap(),
    )))
}
fn networks() -> Result<HashMap<String, Network>> {
    let Some(mut buffer) = adapters::inventory(true)? else {
        return Ok(HashMap::new());
    };
    let mut result = HashMap::new();
    let mut pointer = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    let mut seen = HashSet::new();
    while !pointer.is_null() {
        buffer.validate(pointer)?;
        if !seen.insert(pointer as usize) || seen.len() > 65536 {
            return Err(Error::invalid("Invalid sharing adapter chain."));
        }
        // SAFETY: aligned complete native record inside the retained allocation.
        let row = unsafe { &*pointer };
        let raw_id = buffer.ansi(row.AdapterName)?;
        let Some(id) = sharing::canonical_id(&raw_id) else {
            pointer = row.Next;
            continue;
        };
        let mut addresses = Vec::new();
        let mut unicast = row.FirstUnicastAddress;
        let mut visited = HashSet::new();
        while !unicast.is_null() {
            buffer.validate::<IP_ADAPTER_UNICAST_ADDRESS_LH>(unicast)?;
            if !visited.insert(unicast as usize) || visited.len() > 65536 {
                return Err(Error::invalid("Invalid sharing address chain."));
            }
            // SAFETY: complete checked native unicast record in this allocation.
            let value = unsafe { &*unicast };
            if let Some(address) = ipv4(
                &buffer,
                value.Address.lpSockaddr.cast(),
                value.Address.iSockaddrLength,
            )? {
                if sharing::keep_address(address, value.PrefixOrigin == 1) {
                    addresses.push(Address {
                        address: address.to_string(),
                        prefix: i32::from(value.OnLinkPrefixLength),
                    });
                }
            }
            unicast = value.Next;
        }
        addresses.sort_by(|a, b| a.address.cmp(&b.address));
        let mut dns = Vec::new();
        let mut server = row.FirstDnsServerAddress;
        visited.clear();
        while !server.is_null() {
            buffer.validate::<IP_ADAPTER_DNS_SERVER_ADDRESS_XP>(server)?;
            if !visited.insert(server as usize) || visited.len() > 65536 {
                return Err(Error::invalid("Invalid sharing DNS chain."));
            }
            // SAFETY: complete checked native DNS record in the same allocation.
            let value = unsafe { &*server };
            if let Some(address) = ipv4(
                &buffer,
                value.Address.lpSockaddr.cast(),
                value.Address.iSockaddrLength,
            )? {
                dns.push(address.to_string());
            }
            server = value.Next;
        }
        dns.sort();
        // SAFETY: documented flags union, populated by GetAdaptersAddresses.
        let flags = unsafe { row.Anonymous2.Flags };
        if result
            .insert(
                id,
                Network {
                    ipv4: addresses,
                    dns,
                    dhcp: flags & 0x84 == 0x84,
                },
            )
            .is_some()
        {
            return Err(Error::invalid("Duplicate sharing adapter identity."));
        }
        pointer = row.Next;
    }
    Ok(result)
}
fn with_manager<T: Send + 'static>(
    operation: impl FnOnce(&INetSharingManager, &dyn Fn(sharing::Phase)) -> Result<T> + Send + 'static,
    report: &mut sharing::Report<'_>,
) -> Result<T> {
    sharing::track(
        move |phase| {
            let _apartment = Apartment::sta()?;
            phase(sharing::Phase::CheckSharing);
            // SAFETY: fixed Windows ICS class, created/released on this STA.
            let manager: INetSharingManager =
                unsafe { CoCreateInstance(&NetSharingManager, None, CLSCTX_INPROC_SERVER)? };
            operation(&manager, phase)
        },
        report,
    )
}
fn connections(manager: &INetSharingManager) -> Result<Enumeration> {
    // SAFETY: typed live manager, used only on its owning STA.
    Enumeration::new(unsafe { manager.EnumEveryConnection()?._NewEnum()? })
}
fn mappings(config: &INetSharingConfiguration) -> Result<Enumeration> {
    // SAFETY: fixed flag zero enumerates mappings without changing them.
    Enumeration::new(unsafe {
        config
            .get_EnumPortMappings(SHARINGCONNECTION_ENUM_FLAGS(0))?
            ._NewEnum()?
    })
}
fn mapping(props: &INetSharingPortMappingProps) -> Result<Mapping> {
    // SAFETY: getters on one owned native mapping, with owned BSTR outputs.
    let value = unsafe {
        Mapping {
            name: props.Name()?.to_string(),
            protocol: i32::from(props.IPProtocol()?),
            external_port: props.ExternalPort()?,
            internal_port: props.InternalPort()?,
            target: props.TargetIPAddress()?.to_string(),
            target_name: props.TargetName()?.to_string(),
        }
    };
    value.validate_size()?;
    Ok(value)
}
fn read_mappings(config: &INetSharingConfiguration) -> Result<Vec<Mapping>> {
    let mut result = Vec::new();
    for (count, entry) in mappings(config)?.enumerate() {
        if count >= 1024 {
            return Err(Error::invalid(
                "Sharing mapping inventory exceeds capacity.",
            ));
        }
        let entry: INetSharingPortMapping = entry?.interface()?;
        // SAFETY: read owned typed properties on the current STA.
        let props = unsafe { entry.Properties()? };
        // SAFETY: this property does not enable the mapping.
        if unsafe { props.Enabled()? }.as_bool() {
            result.push(mapping(&props)?);
        }
    }
    result.sort_by(|a, b| {
        (a.protocol, a.external_port, a.internal_port)
            .cmp(&(b.protocol, b.external_port, b.internal_port))
            .then_with(|| text::ordinal_compare(&a.name, &b.name))
            .then_with(|| text::ordinal_compare(&a.target, &b.target))
            .then_with(|| text::ordinal_compare(&a.target_name, &b.target_name))
    });
    Ok(result)
}
fn read(manager: &INetSharingManager) -> Result<Snapshot> {
    let mut networks = networks()?;
    let mut result = Vec::new();
    for entry in connections(manager)? {
        let connection: INetConnection = entry?.interface()?;
        // SAFETY: fixed typed connection-property/configuration queries, no changes.
        let (props, config) = unsafe {
            (
                manager.get_NetConnectionProps(&connection)?,
                manager.get_INetSharingConfigurationForINetConnection(&connection)?,
            )
        };
        // SAFETY: owned BSTR output from live typed properties.
        let id = sharing::canonical_id(&unsafe { props.Guid()? }.to_string())
            .ok_or_else(|| Error::invalid("Invalid native sharing adapter identity."))?;
        let Some(network) = networks.remove(&id) else {
            continue;
        };
        // SAFETY: read enabled state before consulting its valid connection type.
        let role = unsafe {
            if config.SharingEnabled()?.as_bool() {
                Some(config.SharingConnectionType()?.0)
            } else {
                None
            }
        };
        let mut port_mappings = Vec::new();
        let mut private_services = Vec::new();
        if role.is_some() {
            for item in read_mappings(&config)? {
                if role == Some(1) && item.is_private_service() {
                    private_services.push(item);
                } else {
                    port_mappings.push(item);
                }
            }
        }
        // SAFETY: name is an owned BSTR copied before properties are released.
        let name = unsafe { props.Name()? }.to_string();
        result.push(Connection {
            id,
            name,
            role,
            ipv4: network.ipv4,
            dns: network.dns,
            dhcp: network.dhcp,
            has_port_mappings: !port_mappings.is_empty(),
            port_mappings,
            private_services,
        });
        if result.len() > 1024 {
            return Err(Error::invalid("Sharing inventory exceeds capacity."));
        }
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Snapshot {
        connections: result,
    })
}
pub fn inspect(report: &mut sharing::Report<'_>) -> Result<Snapshot> {
    with_manager(|manager, _| read(manager), report)
}
fn restore_services(config: &INetSharingConfiguration, expected: &[Mapping]) -> Result<()> {
    if expected.is_empty() {
        return Ok(());
    }
    let mut restored = HashSet::new();
    for (count, entry) in mappings(config)?.enumerate() {
        if count >= 1024 {
            return Err(Error::invalid(
                "Sharing mapping inventory exceeds capacity.",
            ));
        }
        let entry: INetSharingPortMapping = entry?.interface()?;
        // SAFETY: live typed properties used only on the current STA.
        let props = unsafe { entry.Properties()? };
        let value = mapping(&props)?;
        if !expected.contains(&value) {
            continue;
        }
        if !restored.insert(value) {
            return Err(Error::invalid("Private sharing service is ambiguous."));
        }
        // SAFETY: only a checkpoint-approved exact Windows private gateway
        // mapping is reenabled; arbitrary custom forwarding is never created.
        unsafe {
            if !props.Enabled()?.as_bool() {
                entry.Enable()?;
            }
        }
    }
    if expected.iter().any(|m| !restored.contains(m)) {
        return Err(Error::invalid(
            "A saved private sharing service is unavailable; recovery is pending.",
        ));
    }
    Ok(())
}
pub fn change(request: Change, report: &mut sharing::Report<'_>) -> Result<Snapshot> {
    request.validate()?;
    let id = sharing::canonical_id(&request.id)
        .ok_or_else(|| Error::invalid("Invalid sharing adapter identity."))?;
    with_manager(
        move |manager, phase| {
            request.validate_expected(&read(manager)?)?;
            let (mut found, mut private_transition) = (false, false);
            for entry in connections(manager)? {
                let connection: INetConnection = entry?.interface()?;
                // SAFETY: read fixed typed properties/configuration for this connection.
                let props = unsafe { manager.get_NetConnectionProps(&connection)? };
                // SAFETY: copy owned GUID BSTR, no caller path/COM name is used.
                if sharing::canonical_id(&unsafe { props.Guid()? }.to_string()).as_deref()
                    != Some(&id)
                {
                    continue;
                }
                found = true;
                // SAFETY: this is the exact adapter checked against the checkpoint.
                let config =
                    unsafe { manager.get_INetSharingConfigurationForINetConnection(&connection)? };
                // SAFETY: fixed role query, preceded by a complete checkpoint read.
                let current = unsafe {
                    if config.SharingEnabled()?.as_bool() {
                        Some(config.SharingConnectionType()?.0)
                    } else {
                        None
                    }
                };
                private_transition = id == request.private.id;
                if current != request.role {
                    phase(match request.role {
                        Some(0) => sharing::Phase::EnablePublic,
                        Some(1) => sharing::Phase::EnablePrivate,
                        _ => sharing::Phase::DisableSharing,
                    });
                    // SAFETY: change exactly one known adapter to only none/public/
                    // private; no driver, service, profile or arbitrary setting API.
                    unsafe {
                        match request.role {
                            None => config.DisableSharing()?,
                            Some(role) => config.EnableSharing(SHARINGCONNECTIONTYPE(role))?,
                        }
                    }
                }
                if request.role == Some(1) {
                    phase(sharing::Phase::RestoreServices);
                    restore_services(&config, &request.restore_private_services)?;
                }
                break;
            }
            if !found && request.role.is_some() {
                return Err(Error::invalid("The sharing adapter is unavailable."));
            }
            let after = if private_transition {
                phase(sharing::Phase::WaitAdapter);
                let mut settling = sharing::PrivateSettling::default();
                loop {
                    let snapshot = read(manager)?;
                    if settling.observe(&request, &snapshot, clock::milliseconds())? {
                        break snapshot;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            } else {
                read(manager)?
            };
            phase(sharing::Phase::VerifySharing);
            request.validate_result(&after, true)?;
            Ok(after)
        },
        report,
    )
}
