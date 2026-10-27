// SPDX-License-Identifier: GPL-3.0-only
use super::{from_win32, owned_handle, wide, win32};
use crate::Result;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::{
    Foundation::{GetLastError, SetLastError},
    Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
        TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

/// Enable only the fixed observation privilege already assigned to this worker
/// token. No account rights, process ACLs or other process tokens are modified.
pub fn enable() -> Result<()> {
    let mut raw = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess is a borrowed pseudo-handle; OpenProcessToken
    // creates a separate owned token with only the fixed query/adjust access.
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut raw,
        )
    } == 0
    {
        return Err(win32());
    }
    let token = owned_handle(raw)?;
    let mut luid = Default::default();
    let name = wide("SeDebugPrivilege");
    // SAFETY: local-system lookup of the fixed NUL-terminated privilege name and
    // a valid writable LUID, with no caller-controlled privilege string.
    if unsafe { LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid) } == 0 {
        return Err(win32());
    }
    let value = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    // SAFETY: token is live; the single populated privilege describes exactly
    // TOKEN_PRIVILEGES. No previous-state buffer is requested. Last-error is
    // explicitly reset and read immediately because TRUE can mean partial grant.
    let (success, error) = unsafe {
        SetLastError(0);
        let success = AdjustTokenPrivileges(
            token.as_raw_handle(),
            0,
            &value,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        (success, GetLastError())
    };
    if success == 0 || error != 0 {
        return Err(from_win32(error));
    }
    Ok(())
}
