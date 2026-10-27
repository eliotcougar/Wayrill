//! A service restart is not a Windows boot. This volatile machine marker lives
//! across process death but not hive unload. It contains no credentials or config.
use crate::native::wide;
use std::{io, ptr};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
    System::Registry::*,
};
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        // Owned, non-predefined registry handle.
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn checked(code: u32, context: &str) -> Result<()> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(ApiError::io(
            context,
            io::Error::from_raw_os_error(code as i32),
        ))
    }
}
fn open(parent: HKEY, name: &str, options: u32) -> Result<Key> {
    let name = wide(name);
    let mut key = ptr::null_mut();
    // Fixed path, live UTF-16 buffer, non-inherited handle; parent remains live.
    checked(
        unsafe {
            RegCreateKeyExW(
                parent,
                name.as_ptr(),
                0,
                ptr::null(),
                options,
                KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_CREATE_SUB_KEY,
                ptr::null(),
                &mut key,
                ptr::null_mut(),
            )
        },
        "Open Windows boot marker",
    )?;
    Ok(Key(key))
}
pub struct Session {
    key: Key,
    pub is_new: bool,
}
impl Session {
    pub fn open() -> Result<Self> {
        let parent = open(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Wayrill",
            REG_OPTION_NON_VOLATILE,
        )?;
        let key = open(parent.0, "RuntimeBoot", REG_OPTION_VOLATILE)?;
        let mut value = 0u32;
        let mut kind = 0;
        let mut size = 4u32;
        let name = wide("Observed");
        // The output buffer is aligned and exactly one DWORD; Windows bounds it.
        let code = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                ptr::null(),
                &mut kind,
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        let is_new = if code == ERROR_FILE_NOT_FOUND {
            true
        } else {
            checked(code, "Read Windows boot marker")?;
            if kind != REG_DWORD || size != 4 || value > 1 {
                return Err(ApiError::new(
                    "STATE_INTEGRITY",
                    "Invalid Windows boot marker.",
                ));
            }
            value == 0
        };
        Ok(Self { key, is_new })
    }
    pub fn acknowledge(&self) -> Result<()> {
        self.write(true)
    }
    pub fn prepare_shutdown() -> Result<()> {
        Self::open()?.write(false)
    }
    fn write(&self, observed: bool) -> Result<()> {
        let value = u32::from(observed);
        let name = wide("Observed");
        // Fixed DWORD value with a live four-byte input buffer and owned key.
        checked(
            unsafe {
                RegSetValueExW(
                    self.key.0,
                    name.as_ptr(),
                    0,
                    REG_DWORD,
                    (&value as *const u32).cast(),
                    4,
                )
            },
            "Record Windows boot observation",
        )
    }
}
