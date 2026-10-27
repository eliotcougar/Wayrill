// SPDX-License-Identifier: GPL-3.0-only
use super::{owned_handle, wide};
use crate::{Error, Result};
use std::os::windows::io::OwnedHandle;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND},
    System::Threading::{CreateEventW, OpenEventW},
};
pub const NAME: &str = "Global\\v2rayN.ApplicationRouting";
pub struct CaptureLease {
    _handle: OwnedHandle,
}
fn conflict() -> Error {
    Error::invalid("WINDIVERT_CONFLICT: v2rayN or another application router already owns capture. Wayrill capture remains off. Stop the other app's capture, then retry.")
}
impl CaptureLease {
    pub fn check_available(owned_capture_pid: Option<u32>) -> Result<()> {
        Self::check_named(NAME, owned_capture_pid)
    }
    pub fn acquire() -> Result<Self> {
        Self::acquire_named(NAME)
    }
    pub fn check_named(name: &str, owned_capture_pid: Option<u32>) -> Result<()> {
        if owned_capture_pid.is_some() {
            return Ok(());
        }
        let name = wide(name);
        // SAFETY: fixed SYNCHRONIZE-only access and a live NUL-terminated name;
        // opening an existing event never creates, resets or signals it.
        let handle = unsafe { OpenEventW(0x00100000, 0, name.as_ptr()) };
        if !handle.is_null() {
            let _reference = owned_handle(handle)?;
            return Err(conflict());
        }
        // SAFETY: capture last-error immediately after the failed OpenEventW.
        let error = unsafe { GetLastError() };
        if error == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        Err(Error::invalid(format!("WINDIVERT_CONFLICT: Another application router may own capture (Windows error {error}). Wayrill capture remains off. Stop the other app's capture, then retry.")))
    }
    pub fn acquire_named(name: &str) -> Result<Self> {
        let name = wide(name);
        // SAFETY: fixed unnamed-security, manual-reset, initially nonsignaled
        // event; the returned reference is adopted once and never signaled.
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
        // SAFETY: creation reports existing-name ownership through last-error;
        // capture it before wrapping/closing any handle can change that value.
        let error = unsafe { GetLastError() };
        let handle = owned_handle(handle)?;
        if error == ERROR_ALREADY_EXISTS {
            return Err(conflict());
        }
        Ok(Self { _handle: handle })
    }
}
