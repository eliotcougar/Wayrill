//! Explicit maintenance of only the bundled, pinned WinDivert registration.
use crate::{
    native::{os_error, verify_hash, wide},
    system_settings::version,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    ptr,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_MARKED_FOR_DELETE},
    System::Services::*,
};
const SYS_SHA: &str = "8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2";
struct Sc(SC_HANDLE);
impl Drop for Sc {
    fn drop(&mut self) {
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}
fn manager(write: bool) -> Result<Sc> {
    let h = unsafe {
        OpenSCManagerW(
            ptr::null(),
            ptr::null(),
            SC_MANAGER_CONNECT | if write { SC_MANAGER_CREATE_SERVICE } else { 0 },
        )
    };
    if h.is_null() {
        Err(os_error("Open driver service manager"))
    } else {
        Ok(Sc(h))
    }
}
fn open(manager: &Sc, access: u32) -> Result<Option<Sc>> {
    let h = unsafe { OpenServiceW(manager.0, wide("WinDivert").as_ptr(), access) };
    if h.is_null() {
        if unsafe { GetLastError() } == ERROR_SERVICE_DOES_NOT_EXIST {
            Ok(None)
        } else if unsafe { GetLastError() } == ERROR_SERVICE_MARKED_FOR_DELETE {
            Err(ApiError::new(
                "DRIVER_REMOVING",
                "WinDivert registration removal is pending.",
            ))
        } else {
            Err(os_error("Open WinDivert registration"))
        }
    } else {
        Ok(Some(Sc(h)))
    }
}
fn same_path(image: &str, bundled: &Path) -> bool {
    let text = image
        .trim()
        .trim_matches('"')
        .strip_prefix("\\??\\")
        .unwrap_or(image.trim().trim_matches('"'));
    if text.contains('"') || text.contains('\0') {
        return false;
    }
    let path = PathBuf::from(text);
    match (path.canonicalize(), bundled.canonicalize()) {
        (Ok(a), Ok(b)) => a
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy()),
        _ => false,
    }
}
pub struct Driver {
    root: PathBuf,
}
impl Driver {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn image(&self) -> PathBuf {
        self.root.join("WinDivert64.sys")
    }
    pub fn status(&self) -> Result<Value> {
        let manager = manager(false)?;
        let registration = match open(&manager, SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS) {
            Err(error) if error.code == "DRIVER_REMOVING" => {
                return Ok(
                    json!({"registered":true,"state":"removing","owned":false,"version":version(&json!({"removing":true}))}),
                )
            }
            result => result?,
        };
        let Some(service) = registration else {
            return Ok(
                json!({"registered":false,"state":"absent","owned":false,"version":version(&json!({"registered":false}))}),
            );
        };
        let mut required = 0;
        unsafe {
            QueryServiceConfigW(service.0, ptr::null_mut(), 0, &mut required);
        }
        if required == 0 || required > 65536 {
            return Err(ApiError::new(
                "DRIVER_STATE",
                "Invalid driver registration size.",
            ));
        }
        let mut buffer = vec![0u64; (required as usize).div_ceil(8)];
        let config = buffer.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>();
        if unsafe { QueryServiceConfigW(service.0, config, required, &mut required) } == 0 {
            return Err(os_error("Read WinDivert registration"));
        }
        let config = unsafe { &*config };
        let mut n = 0;
        unsafe {
            while *config.lpBinaryPathName.add(n) != 0 && n < 32768 {
                n += 1;
            }
        }
        let image = unsafe {
            String::from_utf16_lossy(std::slice::from_raw_parts(config.lpBinaryPathName, n))
        };
        let mut state: SERVICE_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { QueryServiceStatus(service.0, &mut state) } == 0 {
            return Err(os_error("Read WinDivert driver state"));
        }
        let owned = config.dwServiceType == SERVICE_KERNEL_DRIVER
            && same_path(&image, &self.image())
            && verify_hash(&self.image(), SYS_SHA).is_ok();
        let state_text = match state.dwCurrentState {
            SERVICE_RUNNING => "running",
            SERVICE_STOPPED => "stopped",
            _ => "transitioning",
        };
        Ok(
            json!({"registered":true,"state":state_text,"owned":owned,"version":version(&json!({"image":image,"state":state.dwCurrentState,"type":config.dwServiceType,"start":config.dwStartType}))}),
        )
    }
    pub fn install(&self, expected: &str) -> Result<Value> {
        let current = self.status()?;
        if current["version"] != expected {
            return Err(ApiError::new(
                "DRIVER_CONFLICT",
                "Driver registration changed; refresh.",
            ));
        }
        if current["registered"] == true {
            if current["owned"] == true {
                return Ok(current);
            }
            return Err(ApiError::new(
                "WINDIVERT_CONFLICT",
                "A foreign WinDivert registration exists. It was preserved.",
            ));
        }
        verify_hash(&self.image(), SYS_SHA)?;
        let manager = manager(true)?;
        // SCM kernel-driver paths are file paths, not executable command lines.
        let path = self.image().to_string_lossy().into_owned();
        let h = unsafe {
            CreateServiceW(
                manager.0,
                wide("WinDivert").as_ptr(),
                wide("WinDivert").as_ptr(),
                SERVICE_QUERY_STATUS,
                SERVICE_KERNEL_DRIVER,
                SERVICE_DEMAND_START,
                SERVICE_ERROR_NORMAL,
                wide(&path).as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
            )
        };
        if h.is_null() {
            return Err(os_error("Register bundled WinDivert driver"));
        }
        let _service = Sc(h);
        self.status() // Registration alone never loads the driver or captures packets.
    }
    pub fn uninstall(&self, expected: &str) -> Result<Value> {
        let current = self.status()?;
        if current["version"] != expected {
            return Err(ApiError::new(
                "DRIVER_CONFLICT",
                "Driver registration changed; refresh.",
            ));
        }
        if current["registered"] == false {
            return Ok(current);
        }
        if current["owned"] != true {
            return Err(ApiError::new("WINDIVERT_CONFLICT","Only this installation's pinned WinDivert registration can be removed. Foreign registration was preserved."));
        }
        let manager = manager(false)?;
        let Some(service) = open(
            &manager,
            SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | SERVICE_STOP | 0x10000,
        )?
        else {
            return self.status();
        };
        let mut state: SERVICE_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { QueryServiceStatus(service.0, &mut state) } == 0 {
            return Err(os_error("Read driver maintenance state"));
        }
        if state.dwCurrentState != SERVICE_STOPPED {
            if state.dwCurrentState != SERVICE_RUNNING {
                return Err(ApiError::new(
                    "DRIVER_BUSY",
                    "Wait for the driver state to settle.",
                ));
            }
            if unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut state) } == 0 {
                return Err(os_error("Stop idle bundled WinDivert driver"));
            }
            let until = Instant::now() + Duration::from_secs(6);
            while state.dwCurrentState != SERVICE_STOPPED {
                if Instant::now() >= until {
                    return Err(ApiError::new(
                        "DRIVER_BUSY",
                        "Driver did not stop; registration was preserved.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
                if unsafe { QueryServiceStatus(service.0, &mut state) } == 0 {
                    return Err(os_error("Observe driver stop"));
                }
            }
        }
        if unsafe { DeleteService(service.0) } == 0
            && unsafe { GetLastError() } != ERROR_SERVICE_MARKED_FOR_DELETE
        {
            return Err(os_error("Remove bundled WinDivert registration"));
        }
        // The driver can mark its registration for deletion while stopping.
        // Release our handle before verifying, so we do not retain that record.
        drop(service);
        let until = Instant::now() + Duration::from_secs(6);
        loop {
            let status = self.status()?;
            if status["state"] != "removing" || Instant::now() >= until {
                return Ok(status);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_paths_require_exact_existing_bundled_file() {
        // A real existing file makes the positive and quoted-path cases
        // meaningful without installing or inspecting any Windows driver.
        let bundled = std::env::current_exe().unwrap();
        let image = bundled.to_str().unwrap();
        assert!(same_path(image, &bundled));
        assert!(same_path(&format!("\"{image}\""), &bundled));
        assert!(!same_path(
            bundled.parent().unwrap().to_str().unwrap(),
            &bundled
        ));
        assert!(!same_path(&format!("\"{image}\" --arg"), &bundled));
        assert!(!same_path(&format!("{image}.missing"), &bundled));
    }
}
