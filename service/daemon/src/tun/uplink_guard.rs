//! Read-only checks for Windows modes that defeat Xray's socket interface pin.
//! Never disable sharing/forwarding or rewrite a foreign adapter's settings.
use super::{prefixes, Result};
use serde_json::Value;
use wayrill_protocol::ApiError;
use windows_sys::Win32::{
    Foundation::ERROR_NOT_FOUND,
    NetworkManagement::{IpHelper::*, Ndis::NET_LUID_LH},
    Networking::WinSock::{AF_INET, AF_INET6},
};

pub(super) struct Guard {
    name: String,
    luid: NET_LUID_LH,
    families: Vec<u16>,
}

fn families(settings: &Value) -> Result<Vec<u16>> {
    let routes = prefixes(settings, "autoSystemRoutingTable")?;
    Ok([(AF_INET, true), (AF_INET6, false)]
        .into_iter()
        .filter(|(_, ipv4)| routes.iter().any(|(ip, _)| ip.is_ipv4() == *ipv4))
        .map(|(family, _)| family)
        .collect())
}

fn check_mode(name: &str, family: u16, forwarding: bool, weak_send: bool) -> Result<()> {
    let ip = if family == AF_INET { "IPv4" } else { "IPv6" };
    let remedy = if forwarding {
        "Forwarding is enabled, commonly by Internet Connection Sharing or Mobile Hotspot. Add or enable an ICS TUN node, turn off sharing on this uplink, or choose another uplink."
    } else if weak_send {
        "WeakHostSend is enabled. Disable it on this uplink or choose another uplink."
    } else {
        return Ok(());
    };
    Err(ApiError::new("TUN_UPLINK_ROUTING", format!(
        "TUN cannot safely use '{name}' for {ip}: {remedy} Windows can ignore Xray's interface binding and route its outbound connections back into TUN. Wayrill leaves these Windows settings unchanged."
    )))
}

fn check_capture_mode(
    name: &str,
    family: u16,
    forwarding: bool,
    weak_send: bool,
    sharing: bool,
) -> Result<()> {
    // A confirmed ICS handoff clears IPv4 forwarding. The keeper journals and
    // disables IPv6 forwarding before the host capture routes are installed.
    // This is preflight only; readiness/runtime still require both flags off.
    check_mode(name, family, forwarding && !sharing, weak_send)
}

impl Guard {
    pub(super) fn new(name: &str, settings: &Value) -> Result<Self> {
        Self::preflight(name, settings, false)
    }
    pub(super) fn preflight(name: &str, settings: &Value, allow_forwarding: bool) -> Result<Self> {
        let mut luid = NET_LUID_LH::default();
        let code =
            unsafe { ConvertInterfaceAliasToLuid(crate::native::wide(name).as_ptr(), &mut luid) };
        if code != 0 {
            return Err(ApiError::io(
                "Read TUN uplink",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        let guard = Self {
            name: name.into(),
            luid,
            families: families(settings)?,
        };
        guard.check_with(allow_forwarding)?;
        Ok(guard)
    }

    pub(super) fn check(&self) -> Result<()> {
        self.check_with(false)
    }
    fn check_with(&self, allow_forwarding: bool) -> Result<()> {
        let mut link = MIB_IF_ROW2 {
            InterfaceLuid: self.luid,
            ..Default::default()
        };
        let code = unsafe { GetIfEntry2(&mut link) };
        if code == ERROR_NOT_FOUND
            || code == windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND
            || (code == 0 && link.OperStatus != 1)
        {
            return Ok(()); // Offline: keep capture, the uplink monitor waits.
        }
        if code != 0 {
            return Err(ApiError::io(
                "Read TUN uplink state",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        for &family in &self.families {
            let mut row = MIB_IPINTERFACE_ROW {
                Family: family,
                InterfaceLuid: self.luid,
                ..Default::default()
            };
            let code = unsafe { GetIpInterfaceEntry(&mut row) };
            if code == ERROR_NOT_FOUND {
                continue;
            } // This IP version is not configured on the uplink.
            if code != 0 {
                return Err(ApiError::io(
                    "Read TUN uplink routing mode",
                    std::io::Error::from_raw_os_error(code as i32),
                ));
            }
            check_capture_mode(
                &self.name,
                family,
                row.ForwardingEnabled,
                row.WeakHostSend,
                allow_forwarding,
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_only_ip_versions_with_captured_routes() {
        assert_eq!(families(&json!({})).unwrap(), Vec::<u16>::new());
        assert_eq!(
            families(&json!({"autoSystemRoutingTable":["0.0.0.0/1","128.0.0.0/1"]})).unwrap(),
            vec![AF_INET]
        );
        assert_eq!(
            families(&json!({"autoSystemRoutingTable":["::/1","8000::/1"]})).unwrap(),
            vec![AF_INET6]
        );
        assert_eq!(
            families(&json!({"autoSystemRoutingTable":["203.0.113.0/24","::/1"]})).unwrap(),
            vec![AF_INET, AF_INET6]
        );
        assert!(families(&json!({"autoSystemRoutingTable":["bad"]})).is_err());
    }

    #[test]
    fn rejects_both_loop_modes_with_an_actionable_error() {
        for family in [AF_INET, AF_INET6] {
            assert!(check_mode("Uplink", family, false, false).is_ok());
            for (forwarding, weak_send, reason) in [
                (true, false, "Internet Connection Sharing"),
                (false, true, "WeakHostSend"),
                (true, true, "Internet Connection Sharing"),
            ] {
                let error = check_mode("Uplink", family, forwarding, weak_send).unwrap_err();
                assert_eq!(error.code, "TUN_UPLINK_ROUTING");
                assert!(error.message.contains(reason) && error.message.contains("Uplink"));
                assert!(error
                    .message
                    .contains(if family == AF_INET { "IPv4" } else { "IPv6" }));
            }
        }
    }
    #[test]
    fn confirmed_sharing_preflight_defers_forwarding_but_keeps_weak_host_guard() {
        assert!(check_capture_mode("Uplink", AF_INET, true, false, true).is_ok());
        assert!(check_capture_mode("Uplink", AF_INET6, false, false, true).is_ok());
        assert!(check_capture_mode("Uplink", AF_INET6, true, false, true).is_ok());
        assert!(check_mode("Uplink", AF_INET6, true, false).is_err());
        assert!(check_capture_mode("Uplink", AF_INET6, true, true, true).is_err());
        assert!(check_capture_mode("Uplink", AF_INET6, true, false, false).is_err());
        assert!(check_capture_mode("Uplink", AF_INET, true, true, true).is_err());
        assert!(check_capture_mode("Uplink", AF_INET, true, false, false).is_err());
    }
}
