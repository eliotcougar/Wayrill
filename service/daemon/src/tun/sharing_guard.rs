//! Persistent forwarding boundary: shared clients may enter only the owned ICS
//! TUN. Socket traffic originated by Xray is unaffected. Only explicit handback
//! records permission to remove the boundary, across coordinator replacement.
use crate::{lifecycle::SharingExit, native::wide, storage};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    ptr::{null, null_mut},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::{FWP_E_FILTER_NOT_FOUND, HANDLE},
        NetworkManagement::WindowsFilteringPlatform::*,
    },
};

const PROVIDER: GUID = GUID::from_u128(0x9d290f3c_c9d5_485a_a0c0_4bb5da50cfa8);
const SUBLAYER: GUID = GUID::from_u128(0xd0ab4dd3_4878_4d79_aeb2_cda68327f95a);
const FILTERS: [(GUID, GUID, bool); 4] = [
    (
        GUID::from_u128(0x0fb71e56_7a04_4912_a9ab_7822583e9221),
        FWPM_LAYER_IPFORWARD_V4,
        false,
    ),
    (
        GUID::from_u128(0x0fb71e56_7a04_4912_a9ab_7822583e9222),
        FWPM_LAYER_IPFORWARD_V6,
        false,
    ),
    (
        GUID::from_u128(0x0fb71e56_7a04_4912_a9ab_7822583e9223),
        FWPM_LAYER_INBOUND_IPPACKET_V4,
        true,
    ),
    (
        GUID::from_u128(0x0fb71e56_7a04_4912_a9ab_7822583e9224),
        FWPM_LAYER_INBOUND_IPPACKET_V6,
        true,
    ),
];
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Guard {
    private: String,
    capture: String,
    #[serde(default)]
    release: Option<SharingExit>,
}
fn path(data: &Path) -> std::path::PathBuf {
    data.join("tun-sharing-barrier.json")
}
fn load(data: &Path) -> Result<Option<Guard>> {
    let value: Option<Guard> = storage::read(&path(data))?;
    if value.as_ref().is_some_and(|g| {
        !super::sharing::valid_guid(&g.private)
            || !super::sharing::valid_guid(&g.capture)
            || g.private == g.capture
    }) {
        return Err(error("Invalid protected sharing barrier identities."));
    }
    Ok(value)
}
fn capture_luid(id: &str) -> u64 {
    // A disposable TUN may have disappeared on failure. Zero permits no real
    // forwarding interface, so recovery remains blocked until its replacement.
    super::guid_luid(id)
        .map(|l| unsafe { l.Value })
        .unwrap_or(0)
}
pub(super) fn active(data: &Path) -> bool {
    path(data).is_file()
}
pub(super) fn requested(data: &Path) -> Result<Option<SharingExit>> {
    let value = load(data)?.and_then(|g| g.release);
    if value == Some(SharingExit::Suspend) {
        return Err(error("Invalid sharing handback intent."));
    }
    Ok(value)
}
pub(super) fn request_release(data: &Path, sharing: SharingExit) -> Result<()> {
    if sharing == SharingExit::Suspend {
        return Err(error("Suspension does not authorize native handback."));
    }
    if let Some(mut guard) = load(data)? {
        guard.release = Some(sharing);
        storage::write(&path(data), &guard)?;
    }
    Ok(())
}

pub(super) fn arm(data: &Path, private: &str, capture: &str) -> Result<()> {
    let guard = Guard {
        private: private.into(),
        capture: capture.into(),
        release: None,
    };
    // Resolve first; a missing adapter cannot replace an intact barrier.
    let private = unsafe { super::guid_luid(private)?.Value };
    let capture = capture_luid(capture);
    storage::write(&path(data), &guard)?;
    replace(Some((private, capture, true)))
}
pub(super) fn set_paused(data: &Path, paused: bool) -> Result<()> {
    if let Some(guard) = load(data)? {
        let private = unsafe { super::guid_luid(&guard.private)?.Value };
        let capture = capture_luid(&guard.capture);
        replace(Some((private, capture, paused)))?;
    }
    Ok(())
}
pub(super) fn finish_release(data: &Path) -> Result<()> {
    if requested(data)?.is_some() {
        replace(None)?;
        storage::remove(&path(data))?;
    }
    Ok(())
}
fn error(message: impl Into<String>) -> ApiError {
    ApiError::new("ICS_PROTECTION", message)
}
fn check(code: u32) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(error(format!("Windows sharing protection failed (0x{code:08X}). The previous forwarding barrier was preserved.")))
    }
}
struct Engine(HANDLE);
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}
fn equal(a: GUID, b: GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}
fn replace(interfaces: Option<(u64, u64, bool)>) -> Result<()> {
    let mut handle = null_mut();
    // All pointers below refer to live local storage through synchronous WFP
    // calls; WFP copies each condition. The transaction replaces both families.
    unsafe {
        check(FwpmEngineOpen0(null(), 10, null(), null(), &mut handle))?;
    }
    let engine = Engine(handle);
    unsafe {
        check(FwpmTransactionBegin0(engine.0, 0))?;
    }
    let result = (|| {
        let mut name = wide("Wayrill sharing protection");
        let mut provider_key = PROVIDER;
        if interfaces.is_some() {
            let provider = FWPM_PROVIDER0 {
                providerKey: PROVIDER,
                flags: FWPM_PROVIDER_FLAG_PERSISTENT,
                displayData: FWPM_DISPLAY_DATA0 {
                    name: name.as_mut_ptr(),
                    ..Default::default()
                },
                ..Default::default()
            };
            let code = unsafe { FwpmProviderAdd0(engine.0, &provider, null_mut()) };
            if code != 0x80320009 {
                check(code)?;
            }
            let sublayer = FWPM_SUBLAYER0 {
                subLayerKey: SUBLAYER,
                flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
                providerKey: &mut provider_key,
                weight: u16::MAX,
                displayData: FWPM_DISPLAY_DATA0 {
                    name: name.as_mut_ptr(),
                    ..Default::default()
                },
                ..Default::default()
            };
            let code = unsafe { FwpmSubLayerAdd0(engine.0, &sublayer, null_mut()) };
            if code != 0x80320009 {
                check(code)?;
            }
        }
        for (key, layer, ingress) in FILTERS {
            let mut old = null_mut();
            let code = unsafe { FwpmFilterGetByKey0(engine.0, &key, &mut old) };
            if code != FWP_E_FILTER_NOT_FOUND as u32 {
                check(code)?;
                let owned = unsafe {
                    !(*old).providerKey.is_null()
                        && equal(*(*old).providerKey, PROVIDER)
                        && equal((*old).subLayerKey, SUBLAYER)
                        && equal((*old).layerKey, layer)
                        && (*old).action.r#type == FWP_ACTION_BLOCK
                };
                unsafe {
                    FwpmFreeMemory0((&mut old as *mut *mut FWPM_FILTER0).cast());
                }
                if !owned {
                    return Err(error(
                        "Sharing protection filters changed outside Wayrill; they were preserved.",
                    ));
                }
                unsafe {
                    check(FwpmFilterDeleteByKey0(engine.0, &key))?;
                }
            }
            if let Some((mut private, mut capture, paused)) = interfaces {
                // During cutover also stop local delivery to Windows' ICS DNS
                // proxy. A forwarding-only filter cannot contain that relay.
                if ingress && !paused {
                    continue;
                }
                let mut conditions = [
                    FWPM_FILTER_CONDITION0 {
                        fieldKey: FWPM_CONDITION_IP_LOCAL_INTERFACE,
                        matchType: FWP_MATCH_EQUAL,
                        ..Default::default()
                    },
                    FWPM_FILTER_CONDITION0 {
                        fieldKey: FWPM_CONDITION_IP_FORWARD_INTERFACE,
                        matchType: FWP_MATCH_NOT_EQUAL,
                        ..Default::default()
                    },
                ];
                conditions[0].conditionValue.r#type = FWP_UINT64;
                conditions[0].conditionValue.Anonymous.uint64 = &mut private;
                conditions[1].conditionValue.r#type = FWP_UINT64;
                conditions[1].conditionValue.Anonymous.uint64 = &mut capture;
                let mut filter = FWPM_FILTER0 {
                    filterKey: key,
                    flags: FWPM_FILTER_FLAG_PERSISTENT,
                    providerKey: &mut provider_key,
                    layerKey: layer,
                    subLayerKey: SUBLAYER,
                    numFilterConditions: if ingress { 1 } else { 2 },
                    filterCondition: conditions.as_mut_ptr(),
                    displayData: FWPM_DISPLAY_DATA0 {
                        name: name.as_mut_ptr(),
                        ..Default::default()
                    },
                    ..Default::default()
                };
                filter.action.r#type = FWP_ACTION_BLOCK;
                filter.weight.r#type = FWP_UINT8;
                filter.weight.Anonymous.uint8 = 15;
                unsafe {
                    check(FwpmFilterAdd0(engine.0, &filter, null_mut(), null_mut()))?;
                }
            }
        }
        unsafe { check(FwpmTransactionCommit0(engine.0)) }
    })();
    if result.is_err() {
        unsafe {
            FwpmTransactionAbort0(engine.0);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handback_permission_survives_restart_and_suspension_cannot_grant_it() {
        let data = std::env::temp_dir().join(format!(
            "wayrill-sharing-{}",
            crate::tun::random_id().unwrap()
        ));
        std::fs::create_dir_all(&data).unwrap();
        let guard = Guard {
            private: "11111111-1111-4111-8111-111111111111".into(),
            capture: "22222222-2222-4222-8222-222222222222".into(),
            release: None,
        };
        storage::write(&path(&data), &guard).unwrap();
        assert_eq!(requested(&data).unwrap(), None);
        assert!(request_release(&data, SharingExit::Suspend).is_err());
        assert_eq!(requested(&data).unwrap(), None);
        request_release(&data, SharingExit::Native).unwrap();
        assert_eq!(requested(&data).unwrap(), Some(SharingExit::Native));
        request_release(&data, SharingExit::Disable).unwrap();
        assert_eq!(requested(&data).unwrap(), Some(SharingExit::Disable));
        std::fs::remove_dir_all(data).unwrap();
    }
}
