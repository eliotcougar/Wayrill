// SPDX-License-Identifier: GPL-3.0-only
use std::{
    os::windows::io::{FromRawHandle, OwnedHandle},
    sync::atomic::{AtomicU32, Ordering},
};
use wayrill_capture::native::lease::CaptureLease;

fn name() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    format!(
        "Local\\Wayrill.RustPort.Test.{}.{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
#[test]
fn only_owned_event_reference_is_closed_and_an_existing_router_is_not_signalled() {
    let name = name();
    CaptureLease::check_named(&name, None).unwrap();
    let lease = CaptureLease::acquire_named(&name).unwrap();
    assert!(CaptureLease::check_named(&name, None)
        .unwrap_err()
        .0
        .starts_with("WINDIVERT_CONFLICT:"));
    assert!(CaptureLease::acquire_named(&name).is_err());
    CaptureLease::check_named(&name, Some(std::process::id())).unwrap();
    drop(lease);
    CaptureLease::check_named(&name, None).unwrap();
}
#[test]
fn wrong_kernel_object_type_is_a_conflict_not_absence() {
    let name = name();
    let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
    // SAFETY: unique per-test name, no initial ownership, and a new owned mutex
    // reference. This never uses the production global application-router name.
    let raw = unsafe {
        windows_sys::Win32::System::Threading::CreateMutexW(std::ptr::null(), 0, wide.as_ptr())
    };
    assert!(!raw.is_null());
    // SAFETY: creation succeeded and transfers one kernel handle to this scope.
    let mutex = unsafe { OwnedHandle::from_raw_handle(raw) };
    assert!(CaptureLease::check_named(&name, None).is_err());
    assert!(CaptureLease::acquire_named(&name).is_err());
    drop(mutex);
    CaptureLease::check_named(&name, None).unwrap();
}
