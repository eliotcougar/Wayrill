//! Native IP notifications are hints, never authoritative sharing intent.
//! Callbacks only advance a process-lifetime counter. The serialized manager
//! reconciles Windows state; no COM, allocation, locks or mutations run here.
use std::sync::atomic::{AtomicU64, Ordering};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::HANDLE, NetworkManagement::IpHelper::*, Networking::WinSock::AF_UNSPEC,
};

static GENERATION: AtomicU64 = AtomicU64::new(0);

unsafe extern "system" fn interface_changed(
    _: *const std::ffi::c_void,
    _: *const MIB_IPINTERFACE_ROW,
    _: MIB_NOTIFICATION_TYPE,
) {
    GENERATION.fetch_add(1, Ordering::Relaxed);
}
unsafe extern "system" fn address_changed(
    _: *const std::ffi::c_void,
    _: *const MIB_UNICASTIPADDRESS_ROW,
    _: MIB_NOTIFICATION_TYPE,
) {
    GENERATION.fetch_add(1, Ordering::Relaxed);
}

pub(super) struct Changes {
    handles: [HANDLE; 2],
    seen: u64,
}
// Registrations can be canceled from any non-callback thread. The callback's
// only state is a static atomic, which outlives every manager/registration.
unsafe impl Send for Changes {}
impl Changes {
    pub fn new() -> Result<Self> {
        let mut changes = Self {
            handles: [std::ptr::null_mut(); 2],
            seen: GENERATION.load(Ordering::Relaxed),
        };
        let codes = unsafe {
            [
                NotifyIpInterfaceChange(
                    AF_UNSPEC,
                    Some(interface_changed),
                    std::ptr::null(),
                    false,
                    &mut changes.handles[0],
                ),
                NotifyUnicastIpAddressChange(
                    AF_UNSPEC,
                    Some(address_changed),
                    std::ptr::null(),
                    false,
                    &mut changes.handles[1],
                ),
            ]
        };
        for code in codes {
            if code != 0 {
                return Err(ApiError::io(
                    "Watch sharing interfaces",
                    std::io::Error::from_raw_os_error(code as i32),
                ));
            }
        }
        Ok(changes)
    }
    pub fn take(&mut self) -> bool {
        let current = GENERATION.load(Ordering::Relaxed);
        let changed = current != self.seen;
        self.seen = current;
        changed
    }
}
impl Drop for Changes {
    fn drop(&mut self) {
        for handle in self.handles {
            if !handle.is_null() {
                // Never called by a notification callback, and no callback
                // needs manager locks. Cancellation cannot deadlock teardown.
                let code = unsafe { CancelMibChangeNotify2(handle) };
                if code != 0 {
                    crate::diagnostics::error!(
                        "Cancel sharing interface notification failed ({code})."
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_watchers_register_and_cancel_without_system_changes() {
        for _ in 0..8 {
            let mut changes = Changes::new().unwrap();
            assert!(changes.handles.iter().all(|handle| !handle.is_null()));
            unsafe {
                interface_changed(std::ptr::null(), std::ptr::null(), MibParameterNotification);
            }
            assert!(changes.take());
            unsafe {
                address_changed(std::ptr::null(), std::ptr::null(), MibDeleteInstance);
            }
            assert!(changes.take());
        }
    }
}
