// SPDX-License-Identifier: GPL-3.0-only
use super::{divert::Api, divert_monitor::Monitor, drivers, lease, processes};
use crate::{divert_monitor::HandleInfo, Error, Result};
use std::sync::Arc;

pub fn conflict_message(handle: &HandleInfo) -> Error {
    let name = processes::process_name(handle.pid).unwrap_or_else(|| "Another application".into());
    Error::invalid(format!("WINDIVERT_CONFLICT: {name} (PID {}) is using WinDivert. Wayrill capture remains off. Stop that app's capture, then retry.",handle.pid))
}
/// NO_INSTALL observation first. WinDivert marks its own running SCM entry for
/// deletion (reported Disabled); SCM configuration matters only when its device
/// is absent and a later open would need to start a registration.
pub fn check(
    api: &Arc<Api>,
    owned_capture_pid: Option<u32>,
    service_pid: Option<u32>,
) -> Result<()> {
    lease::CaptureLease::check_available(owned_capture_pid)?;
    drivers::check_loaded()?;
    let monitor = Monitor::snapshot(api)?;
    drivers::check_loaded()?;
    match monitor {
        None => drivers::check_registered(),
        Some(monitor) => {
            if let Some(handle) = monitor.conflict(owned_capture_pid, service_pid)? {
                return Err(conflict_message(&handle));
            }
            Ok(())
        }
    }
}
