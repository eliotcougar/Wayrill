// SPDX-License-Identifier: GPL-3.0-only
use super::{adapters::NativeBuffer, from_win32, win32};
use crate::{services::ServiceInfo, Error, Result};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_MORE_DATA},
    System::Services::{
        CloseServiceHandle, EnumServicesStatusExW, OpenSCManagerW, ENUM_SERVICE_STATUS_PROCESSW,
        SC_ENUM_PROCESS_INFO, SC_HANDLE, SC_MANAGER_ENUMERATE_SERVICE, SERVICE_STATE_ALL,
        SERVICE_WIN32,
    },
};
struct Manager(SC_HANDLE);
impl Drop for Manager {
    fn drop(&mut self) {
        // SAFETY: this is the sole owned SCM handle from OpenSCManagerW.
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}
/// Reads only. No service start, stop, reconfiguration or localized text parsing.
pub fn read() -> Result<Vec<ServiceInfo>> {
    // SAFETY: null machine/database selects local SCM; rights allow enumeration only.
    let manager = Manager(unsafe {
        OpenSCManagerW(
            std::ptr::null(),
            std::ptr::null(),
            SC_MANAGER_ENUMERATE_SERVICE,
        )
    });
    if manager.0.is_null() {
        return Err(win32());
    }
    read_pages(|buffer, resume| {
        let (mut needed, mut returned) = (0, 0);
        // SAFETY: SCM writes at most capacity bytes into the aligned allocation.
        let success = unsafe {
            EnumServicesStatusExW(
                manager.0,
                SC_ENUM_PROCESS_INFO,
                SERVICE_WIN32,
                SERVICE_STATE_ALL,
                buffer.as_mut_ptr(),
                PAGE_BYTES as u32,
                &mut needed,
                &mut returned,
                resume,
                std::ptr::null(),
            )
        };
        if success == 0 {
            // SAFETY: capture last-error immediately after the failed native call.
            let error = unsafe { GetLastError() };
            if error == ERROR_MORE_DATA {
                return Ok((returned, true));
            }
            return Err(from_win32(error));
        }
        Ok((returned, false))
    })
}

// EnumServicesStatusExW accepts at most 256 KiB. ERROR_MORE_DATA returns a
// populated page and a continuation token, not a request to restart/grow it.
const PAGE_BYTES: usize = 256 * 1024;
fn read_pages(
    mut query: impl FnMut(&mut NativeBuffer, &mut u32) -> Result<(u32, bool)>,
) -> Result<Vec<ServiceInfo>> {
    let mut buffer = NativeBuffer::new(PAGE_BYTES);
    let mut result = Vec::new();
    let mut resume = 0;
    let mut total = 0;
    loop {
        let before = resume;
        let (returned, more) = query(&mut buffer, &mut resume)?;
        let row_size = std::mem::size_of::<ENUM_SERVICE_STATUS_PROCESSW>();
        if returned as usize > PAGE_BYTES / row_size || total + returned as usize > 65536 {
            return Err(Error::invalid("Invalid Windows service inventory length."));
        }
        total += returned as usize;
        // SAFETY: u64 storage is sufficiently aligned; returned rows were checked
        // against the supplied allocation capacity and remain borrowed locally.
        let rows = unsafe {
            std::slice::from_raw_parts(
                buffer.as_mut_ptr().cast::<ENUM_SERVICE_STATUS_PROCESSW>(),
                returned as usize,
            )
        };
        for row in rows {
            if row.ServiceStatusProcess.dwProcessId > i32::MAX as u32 {
                return Err(Error::invalid("Service process ID overflow."));
            }
            let name = buffer.unicode(row.lpServiceName)?;
            if name.trim().is_empty() {
                continue;
            }
            let display = buffer.unicode(row.lpDisplayName)?;
            result.push(ServiceInfo {
                display_name: if display.is_empty() {
                    name.clone()
                } else {
                    display
                },
                name,
                pid: row.ServiceStatusProcess.dwProcessId,
            });
        }
        if !more {
            return Ok(result);
        }
        if resume == before || returned == 0 {
            return Err(Error::invalid(
                "Windows service enumeration did not advance.",
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(buffer: &mut NativeBuffer, name: &str, pid: u32) {
        let text = super::super::wide(name);
        let pointer = buffer.as_mut_ptr();
        let mut row = ENUM_SERVICE_STATUS_PROCESSW::default();
        // SAFETY: the fixture allocation is aligned and large enough for one
        // row plus its owned UTF-16 string; no pointer outlives the query.
        unsafe {
            let string = pointer.add(128).cast::<u16>();
            std::ptr::copy_nonoverlapping(text.as_ptr(), string, text.len());
            row.lpServiceName = string;
            row.ServiceStatusProcess.dwProcessId = pid;
            pointer.cast::<ENUM_SERVICE_STATUS_PROCESSW>().write(row);
        }
    }

    #[test]
    fn partial_service_pages_resume_without_losing_previous_rows() {
        let mut calls = 0;
        let rows = read_pages(|buffer, resume| {
            calls += 1;
            assert_eq!(*resume, if calls == 1 { 0 } else { 77 });
            page(buffer, if calls == 1 { "First" } else { "Second" }, calls);
            *resume = if calls == 1 { 77 } else { 0 };
            Ok((1, calls == 1))
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(
            rows.iter()
                .map(|r| (r.name.as_str(), r.pid))
                .collect::<Vec<_>>(),
            [("First", 1), ("Second", 2)]
        );
        assert_eq!(rows[1].display_name, "Second");
    }

    #[test]
    fn pagination_rejects_stalled_or_invalid_native_pages() {
        assert!(read_pages(|_, _| Ok((0, true))).is_err());
        assert!(read_pages(|buffer, _| {
            page(buffer, "Stalled", 1);
            Ok((1, true))
        })
        .is_err());
        assert!(read_pages(|_, _| Ok((u32::MAX, false))).is_err());
        assert!(read_pages(|buffer, _| {
            page(buffer, "Invalid", u32::MAX);
            Ok((1, false))
        })
        .is_err());
        let mut calls = 0;
        assert!(read_pages(|_, resume| {
            calls += 1;
            assert!(
                calls <= 20,
                "blank native rows bypassed the inventory limit"
            );
            *resume += 1;
            Ok((
                (PAGE_BYTES / std::mem::size_of::<ENUM_SERVICE_STATUS_PROCESSW>()) as u32,
                true,
            ))
        })
        .is_err());
    }
}
