//! A narrow active IPv6 forwarding lease on the confirmed original ICS uplink.
//! The sharing journal durably checkpoints each phase before Windows is changed.
use super::guid_luid;
use serde::{Deserialize, Serialize};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::ERROR_NOT_FOUND,
    NetworkManagement::IpHelper::{GetIpInterfaceEntry, SetIpInterfaceEntry, MIB_IPINTERFACE_ROW},
    Networking::WinSock::AF_INET6,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Phase {
    Captured,
    Disabling,
    Active,
    Restoring,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Lease {
    pub original: bool,
    pub phase: Phase,
}
impl Lease {
    pub(super) fn capture(id: &str) -> Result<Option<Self>> {
        Ok(read(id)?.map(|original| Self {
            original,
            phase: Phase::Captured,
        }))
    }
    pub(super) fn check_restore(&self, observed: bool) -> Result<()> {
        // An already restored value is harmless. Accept both sides of a durable
        // pending operation, but never adopt a new value during active capture.
        if self.phase == Phase::Active && observed && !self.original {
            return Err(ApiError::new(
                "TUN_FORWARDING_CONFLICT",
                "IPv6 forwarding on the ICS uplink changed while TUN was running. Its newer setting was preserved; inspect sharing recovery before retrying.",
            ));
        }
        Ok(())
    }
}

fn row(id: &str) -> Result<Option<MIB_IPINTERFACE_ROW>> {
    let mut row = MIB_IPINTERFACE_ROW {
        Family: AF_INET6,
        InterfaceLuid: guid_luid(id)?,
        ..Default::default()
    };
    let code = unsafe { GetIpInterfaceEntry(&mut row) };
    if code == ERROR_NOT_FOUND {
        return Ok(None); // IPv6 is not configured; never enable it implicitly.
    }
    if code != 0 {
        return Err(ApiError::io(
            "Read ICS uplink IPv6 forwarding",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    Ok(Some(row))
}
pub(super) fn read(id: &str) -> Result<Option<bool>> {
    Ok(row(id)?.map(|r| r.ForwardingEnabled))
}
pub(super) fn required(id: &str) -> Result<bool> {
    read(id)?.ok_or_else(|| {
        ApiError::new(
            "TUN_FORWARDING_ADAPTER",
            "The recorded ICS uplink IPv6 interface is unavailable. Restore it or keep the current sharing settings; Wayrill did not enable IPv6 or alter another adapter.",
        )
    })
}
pub(super) fn set(id: &str, forwarding: bool) -> Result<()> {
    let mut row = row(id)?.ok_or_else(|| {
        ApiError::new(
            "TUN_FORWARDING_ADAPTER",
            "The recorded ICS uplink IPv6 interface is unavailable.",
        )
    })?;
    if row.ForwardingEnabled != forwarding {
        // Read-modify-write the current row; preserve MTU, metrics, discovery,
        // weak-host flags and all other configurable fields. No persistent store.
        row.ForwardingEnabled = forwarding;
        let code = unsafe { SetIpInterfaceEntry(&mut row) };
        if code != 0 {
            return Err(ApiError::io(
                "Set ICS uplink IPv6 forwarding",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
    }
    if required(id)? != forwarding {
        return Err(ApiError::new(
            "TUN_FORWARDING_VERIFY",
            "Windows did not retain the requested ICS uplink IPv6 forwarding setting. Its recovery record was retained.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_accepts_only_owned_or_already_restored_active_values() {
        for original in [false, true] {
            let lease = Lease {
                original,
                phase: Phase::Active,
            };
            assert!(lease.check_restore(false).is_ok());
            assert_eq!(lease.check_restore(true).is_ok(), original);
        }
    }

    #[test]
    fn crash_at_either_side_of_a_durable_mutation_retains_the_original_value() {
        for original in [false, true] {
            for phase in [Phase::Captured, Phase::Disabling, Phase::Restoring] {
                let lease = Lease { original, phase };
                let restored: Lease =
                    serde_json::from_slice(&serde_json::to_vec(&lease).unwrap()).unwrap();
                for observed in [false, true] {
                    assert!(restored.check_restore(observed).is_ok());
                    assert_eq!(restored.original, original);
                }
            }
        }
    }

    #[test]
    fn journal_rejects_unknown_phases_and_injected_adapter_or_family_fields() {
        for bad in [
            r#"{"original":true,"phase":"unknown"}"#,
            r#"{"original":true,"phase":"active","adapter":"other"}"#,
            r#"{"original":true,"phase":"active","family":2}"#,
            r#"{"original":"true","phase":"active"}"#,
        ] {
            assert!(serde_json::from_str::<Lease>(bad).is_err());
        }
    }
}
