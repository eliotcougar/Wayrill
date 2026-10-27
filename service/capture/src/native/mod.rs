// SPDX-License-Identifier: GPL-3.0-only
pub mod adapters;
pub mod attribution_source;
#[cfg(feature = "windivert")]
pub mod capture_availability;
pub mod clock;
mod com;
#[cfg(feature = "windivert")]
pub mod divert;
#[cfg(feature = "windivert")]
pub mod divert_monitor;
#[cfg(feature = "windivert")]
pub mod drivers;
#[cfg(feature = "windivert")]
pub mod firewall;
#[cfg(feature = "windivert")]
pub mod lease;
pub mod loopback;
pub mod nat_sessions;
pub mod observation;
pub mod owners;
pub mod packages;
pub mod process_events;
pub mod processes;
pub mod service_catalog;
pub mod sharing;
#[cfg(feature = "windivert")]
pub mod socket_events;

use crate::{Error, Result};
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{FILETIME, HANDLE, INVALID_HANDLE_VALUE},
    System::SystemInformation::GetSystemTimePreciseAsFileTime,
};

fn win32() -> Error {
    std::io::Error::last_os_error().into()
}
fn from_win32(code: u32) -> Error {
    std::io::Error::from_raw_os_error(code as i32).into()
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}
fn read_wide(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())])
}
fn filetime(value: FILETIME) -> i64 {
    (u64::from(value.dwLowDateTime) | (u64::from(value.dwHighDateTime) << 32)) as i64
}
pub fn now_filetime() -> i64 {
    let mut value = FILETIME::default();
    // SAFETY: the API initializes the provided valid FILETIME output.
    unsafe {
        GetSystemTimePreciseAsFileTime(&mut value);
    }
    filetime(value)
}
fn owned_handle(value: HANDLE) -> Result<OwnedHandle> {
    if value.is_null() || value == INVALID_HANDLE_VALUE {
        return Err(win32());
    }
    // SAFETY: the caller transfers a newly returned owned kernel handle. Null
    // and INVALID_HANDLE_VALUE are rejected, and OwnedHandle closes it once.
    Ok(unsafe { OwnedHandle::from_raw_handle(value) })
}
