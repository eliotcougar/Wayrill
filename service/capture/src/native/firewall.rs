// SPDX-License-Identifier: GPL-3.0-only
use super::com::{Apartment, Enumeration, Variant};
use crate::{text, Error, Result};
use sha2::{Digest, Sha256};
use windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::{VARIANT_FALSE, VARIANT_TRUE},
        NetworkManagement::WindowsFirewall::{
            INetFwPolicy2, INetFwRule, INetFwRule3, INetFwRules, NetFwPolicy2, NetFwRule,
            NET_FW_ACTION_ALLOW, NET_FW_RULE_DIR_IN,
        },
        System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
    },
};

pub const NAME: &str = "Wayrill.Capture.Reflection.v1";
const GROUP: &str = "Wayrill capture runtime";
const PREFIX: &str = "Wayrill capture reflection v2; sha256=";
const LEGACY_PREFIX: &str = "Wayrill capture reflection v1; sha256=";
fn program() -> Result<String> {
    Ok(std::env::current_exe()?.to_string_lossy().into_owned())
}
fn rules() -> Result<INetFwRules> {
    // SAFETY: caller has a live COM apartment; only this fixed Windows class
    // and its typed read/manage-rules interface are instantiated.
    unsafe {
        let policy: INetFwPolicy2 = CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER)?;
        Ok(policy.Rules()?)
    }
}
fn signature(rule: &INetFwRule, legacy: bool) -> Result<String> {
    // SAFETY: the typed live interface stays borrowed in this COM apartment.
    // Getter outputs are owned BSTR/VARIANT values, released before returning.
    unsafe {
        let ports = rule.LocalPorts()?.to_string();
        let mut ports = ports.split(',').collect::<Vec<_>>();
        ports.sort();
        let names = Variant(rule.Interfaces()?).interface_names()?;
        let path = rule.ApplicationName()?.to_string();
        let mut values = vec![
            if legacy {
                legacy_lowercase(&path)?
            } else {
                path
            },
            ports.join(","),
            rule.LocalAddresses()?.to_string(),
            rule.RemoteAddresses()?.to_string(),
            rule.RemotePorts()?.to_string(),
            rule.InterfaceTypes()?.to_string(),
            names,
            rule.ServiceName()?.to_string(),
            rule.Protocol()?.to_string(),
            rule.Direction()?.0.to_string(),
            rule.Action()?.0.to_string(),
            rule.Profiles()?.to_string(),
            if rule.Enabled()?.as_bool() {
                "True"
            } else {
                "False"
            }
            .into(),
            if rule.EdgeTraversal()?.as_bool() {
                "True"
            } else {
                "False"
            }
            .into(),
        ];
        if !legacy {
            values.extend(advanced(rule)?);
        }
        Ok(Sha256::digest(values.join("\n").as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }
}
fn legacy_lowercase(value: &str) -> Result<String> {
    if value.is_ascii() {
        return Ok(value.to_ascii_lowercase());
    }
    let input = value.encode_utf16().collect::<Vec<_>>();
    let mut output = vec![0; input.len() * 3];
    // SAFETY: explicit initialized UTF-16 buffers, invariant Windows mapping.
    // Version 2 signs the exact returned path and needs no Unicode case mapping.
    let count = unsafe {
        windows_sys::Win32::Globalization::LCMapStringEx(
            windows_sys::Win32::Globalization::LOCALE_NAME_INVARIANT,
            windows_sys::Win32::Globalization::LCMAP_LOWERCASE,
            input.as_ptr(),
            input.len() as i32,
            output.as_mut_ptr(),
            output.len() as i32,
            std::ptr::null(),
            std::ptr::null(),
            0,
        )
    };
    if count == 0 {
        return Err(super::win32());
    }
    String::from_utf16(&output[..count as usize])
        .map_err(|_| Error::invalid("Invalid firewall application path."))
}
fn advanced(rule: &INetFwRule) -> Result<Vec<String>> {
    let rule: INetFwRule3 = rule.cast()?;
    // SAFETY: owned typed interface, fixed Windows 10/11 permission properties.
    unsafe {
        Ok(vec![
            rule.EdgeTraversalOptions()?.to_string(),
            rule.LocalAppPackageId()?.to_string(),
            rule.LocalUserOwner()?.to_string(),
            rule.LocalUserAuthorizedList()?.to_string(),
            rule.RemoteUserAuthorizedList()?.to_string(),
            rule.RemoteMachineAuthorizedList()?.to_string(),
            rule.SecureFlags()?.to_string(),
        ])
    }
}
pub fn clear_stale() -> Result<()> {
    let _apartment = Apartment::enter()?;
    let rules = rules()?;
    // SAFETY: live typed collection and fixed enumeration IID. Variants retain
    // their entries until each cloned rule interface has an independent AddRef.
    let entries = Enumeration::new(unsafe { rules._NewEnum()? })?;
    let mut matches = Vec::new();
    for entry in entries {
        let rule: INetFwRule = entry?.interface()?;
        // SAFETY: read a typed property from the owned live rule interface.
        if unsafe { rule.Name()? } == NAME {
            matches.push(rule);
        }
        if matches.len() > 1 {
            return Err(Error::invalid("FIREWALL_CONFLICT: Multiple reflection rules have this name. Inspect Windows Firewall."));
        }
    }
    let Some(rule) = matches.first() else {
        return Ok(());
    };
    // SAFETY: the rule/collection stay owned in this apartment. Compare every
    // signed permission property before removing only the fixed owned name.
    unsafe {
        let description = rule.Description()?.to_string();
        let owned = description == format!("{PREFIX}{}", signature(rule, false)?)
            || description.starts_with(LEGACY_PREFIX)
                && advanced(rule)?
                    .iter()
                    .all(|value| value.is_empty() || value == "0")
                && description == format!("{LEGACY_PREFIX}{}", signature(rule, true)?);
        if !text::equal(&rule.ApplicationName()?.to_string(), &program()?)
            || rule.Grouping()? != GROUP
            || !owned
        {
            return Err(Error::invalid("FIREWALL_CONFLICT: The reflection rule was changed externally. It has been preserved; inspect Windows Firewall."));
        }
        rules.Remove(&BSTR::from(NAME))?;
    }
    Ok(())
}
pub struct ReflectionFirewall {
    closed: bool,
}
impl ReflectionFirewall {
    pub fn new(ports: &[u16]) -> Result<Self> {
        let mut ports = ports.to_vec();
        ports.sort();
        ports.dedup();
        if ports.is_empty() || ports.contains(&0) {
            return Err(Error::invalid("No valid TCP reflection listeners."));
        }
        clear_stale()?;
        let _apartment = Apartment::enter()?;
        let rules = rules()?;
        let ports = ports
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(",");
        // SAFETY: fixed Windows rule class and constant permission shape, scoped
        // to this executable and the engine's existing ephemeral TCP listeners.
        // No input can supply another executable, firewall name or rule filter.
        unsafe {
            let rule: INetFwRule = CoCreateInstance(&NetFwRule, None, CLSCTX_INPROC_SERVER)?;
            rule.SetName(&BSTR::from(NAME))?;
            rule.SetGrouping(&BSTR::from(GROUP))?;
            rule.SetApplicationName(&BSTR::from(program()?))?;
            rule.SetProtocol(6)?;
            rule.SetLocalPorts(&BSTR::from(ports))?;
            rule.SetLocalAddresses(&BSTR::from("*"))?;
            rule.SetRemoteAddresses(&BSTR::from("*"))?;
            rule.SetRemotePorts(&BSTR::from("*"))?;
            rule.SetInterfaceTypes(&BSTR::from("All"))?;
            rule.SetProfiles(i32::MAX)?;
            rule.SetDirection(NET_FW_RULE_DIR_IN)?;
            rule.SetAction(NET_FW_ACTION_ALLOW)?;
            rule.SetEdgeTraversal(VARIANT_FALSE)?;
            rule.SetEnabled(VARIANT_TRUE)?;
            rule.SetDescription(&BSTR::from(format!("{PREFIX}{}", signature(&rule, false)?)))?;
            rules.Add(&rule)?;
        }
        Ok(Self { closed: false })
    }
    pub fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        clear_stale()
    }
}
impl Drop for ReflectionFirewall {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
