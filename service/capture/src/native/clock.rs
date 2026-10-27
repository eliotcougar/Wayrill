// SPDX-License-Identifier: GPL-3.0-only
use crate::{Error, Result};
use std::sync::OnceLock;
use windows_sys::Win32::System::{
    Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
    SystemInformation::GetTickCount64,
};
pub fn milliseconds() -> u64 {
    // SAFETY: no arguments, monotonic system uptime; not wall-clock time.
    unsafe { GetTickCount64() }
}
pub fn ticks() -> i64 {
    let mut value = 0;
    // SAFETY: Windows 10+ guarantees QPC availability and initializes this i64.
    unsafe {
        QueryPerformanceCounter(&mut value);
    }
    value
}
pub fn frequency() -> Result<i64> {
    static FREQUENCY: OnceLock<i64> = OnceLock::new();
    let value = *FREQUENCY.get_or_init(|| {
        let mut value = 0;
        // SAFETY: initialized writable frequency output, no retained pointers.
        unsafe {
            QueryPerformanceFrequency(&mut value);
        }
        value
    });
    if value <= 0 {
        Err(Error::invalid("Windows performance clock unavailable."))
    } else {
        Ok(value)
    }
}
