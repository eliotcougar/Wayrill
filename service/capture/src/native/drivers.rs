// SPDX-License-Identifier: GPL-3.0-only
//! Read-only WinDivert compatibility guard. The only driver path accepted as
//! expected is the fixed sibling shipped payload; no command supplies a path.
use super::{adapters::NativeBuffer, from_win32, processes, read_wide, wide, win32};
use crate::{text, Error, Result};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    io::Read,
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_SERVICE_DOES_NOT_EXIST},
    Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
    System::{
        Environment::ExpandEnvironmentStringsW,
        ProcessStatus::{EnumDeviceDrivers, GetDeviceDriverBaseNameW, GetDeviceDriverFileNameW},
        Services::{
            CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceConfigW,
            QUERY_SERVICE_CONFIGW, SC_HANDLE, SC_MANAGER_CONNECT, SERVICE_DISABLED,
            SERVICE_KERNEL_DRIVER, SERVICE_QUERY_CONFIG,
        },
    },
};

fn expected_path() -> Result<PathBuf> {
    let path = std::env::current_exe()?;
    let parent = path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| Error::invalid("Capture dependency directory unavailable."))?;
    Ok(parent.join("windivert/WinDivert64.sys"))
}
fn hash(path: &Path) -> Result<[u8; 32]> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut block = [0; 65536];
    loop {
        let count = file.read(&mut block)?;
        if count == 0 {
            return Ok(digest.finalize().into());
        }
        digest.update(&block[..count]);
    }
}
fn normalize(path: &str) -> Result<PathBuf> {
    let result = if text::starts_with(path, "\\SystemRoot\\") {
        PathBuf::from(processes::windows_directory()?).join(&path[12..])
    } else {
        PathBuf::from(path.strip_prefix("\\??\\").unwrap_or(path))
    };
    Ok(result)
}
fn expand(path: &str) -> Result<String> {
    let path = wide(path);
    let mut buffer = vec![0u16; 32768];
    // SAFETY: NUL-terminated input and initialized output of the stated length.
    let count = unsafe {
        ExpandEnvironmentStringsW(path.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32)
    };
    if count == 0 {
        return Err(win32());
    }
    if count as usize > buffer.len() {
        return Err(Error::invalid("Registered driver path exceeds capacity."));
    }
    Ok(read_wide(&buffer))
}
fn contains_divert(value: &str) -> bool {
    value.to_ascii_lowercase().contains("windivert")
}

/// Resource translations are numeric language/code-page identifiers. Probe
/// every advertised translation instead of depending on the Windows UI locale.
fn is_renamed_divert(path: &Path) -> Result<bool> {
    let path = wide(&path.to_string_lossy());
    let mut ignored = 0;
    // SAFETY: fixed NUL-terminated file path; handle output is not a kernel handle.
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if size == 0 {
        return Ok(false);
    }
    if size > 16 * 1024 * 1024 {
        return Err(Error::invalid("Driver version resource exceeds capacity."));
    }
    let mut buffer = NativeBuffer::new(size as usize);
    // SAFETY: initialized, aligned output storage with exactly the supplied size.
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) } == 0 {
        return Err(win32());
    }
    let mut translations = std::ptr::null_mut();
    let mut length = 0;
    let query = wide("\\VarFileInfo\\Translation");
    // SAFETY: buffer contains the complete native version resource. Returned
    // pointers are validated against that allocation before dereferencing.
    if unsafe {
        VerQueryValueW(
            buffer.as_mut_ptr().cast(),
            query.as_ptr(),
            &mut translations,
            &mut length,
        )
    } == 0
    {
        return Ok(false);
    }
    if !length.is_multiple_of(4) {
        return Err(Error::invalid("Invalid driver version translations."));
    }
    let pairs = buffer
        .bytes(translations.cast(), length as usize)?
        .as_chunks::<4>()
        .0
        .to_vec();
    for pair in pairs {
        let lang = u16::from_le_bytes([pair[0], pair[1]]);
        let page = u16::from_le_bytes([pair[2], pair[3]]);
        for key in ["OriginalFilename", "ProductName"] {
            let query = wide(&format!("\\StringFileInfo\\{lang:04x}{page:04x}\\{key}"));
            let mut value: *mut c_void = std::ptr::null_mut();
            let mut length = 0;
            // SAFETY: same validated version allocation, fixed resource-key query.
            if unsafe {
                VerQueryValueW(
                    buffer.as_mut_ptr().cast(),
                    query.as_ptr(),
                    &mut value,
                    &mut length,
                )
            } != 0
                && length != 0
            {
                let bytes = buffer.bytes(value.cast(), length as usize * 2)?;
                let words = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|p| u16::from_ne_bytes(*p))
                    .collect::<Vec<_>>();
                if contains_divert(&read_wide(&words)) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}
struct Service(SC_HANDLE);
impl Drop for Service {
    fn drop(&mut self) {
        // SAFETY: sole owned SCM/service reference returned by its open call.
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}
pub fn check_registered() -> Result<()> {
    // SAFETY: local SCM connection with read-only rights.
    let manager =
        Service(unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) });
    if manager.0.is_null() {
        return Err(win32());
    }
    let name = wide("WinDivert");
    // SAFETY: local manager and fixed service name, configuration-query only.
    let raw = unsafe { OpenServiceW(manager.0, name.as_ptr(), SERVICE_QUERY_CONFIG) };
    if raw.is_null() {
        // SAFETY: read immediately after the failed service lookup.
        let code = unsafe { GetLastError() };
        return if code == ERROR_SERVICE_DOES_NOT_EXIST {
            Ok(())
        } else {
            Err(from_win32(code))
        };
    }
    let service = Service(raw);
    let mut size = 0;
    // SAFETY: documented size-query call; no data buffer is dereferenced.
    unsafe {
        QueryServiceConfigW(service.0, std::ptr::null_mut(), 0, &mut size);
    }
    // SAFETY: immediate last-error read for the sizing call.
    let code = unsafe { GetLastError() };
    if code != ERROR_INSUFFICIENT_BUFFER
        || (size as usize) < std::mem::size_of::<QUERY_SERVICE_CONFIGW>()
        || size > 65536
    {
        return Err(Error::invalid(
            "Cannot verify the registered WinDivert driver.",
        ));
    }
    let mut buffer = NativeBuffer::new(size as usize);
    // SAFETY: aligned initialized allocation of the exact returned size.
    if unsafe { QueryServiceConfigW(service.0, buffer.as_mut_ptr().cast(), size, &mut size) } == 0 {
        return Err(win32());
    }
    let pointer = buffer.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>();
    buffer.validate(pointer)?;
    // SAFETY: alignment/size checked above; the structure remains in this buffer.
    let config = unsafe { &*pointer };
    let path = buffer.unicode(config.lpBinaryPathName)?;
    let path = normalize(&expand(path.trim().trim_matches('"'))?)?;
    let compatible = config.dwServiceType == SERVICE_KERNEL_DRIVER
        && config.dwStartType != SERVICE_DISABLED
        && hash(&path).ok() == Some(hash(&expected_path()?)?);
    if !compatible {
        return Err(Error::invalid("WINDIVERT_CONFLICT: The existing WinDivert registration is incompatible or disabled. The registration was preserved."));
    }
    Ok(())
}
pub fn check_loaded() -> Result<usize> {
    super::observation::enable()?;
    let mut images = [std::ptr::null_mut(); 4096];
    let mut needed = 0;
    // SAFETY: initialized output array and exact writable byte capacity.
    if unsafe {
        EnumDeviceDrivers(
            images.as_mut_ptr(),
            std::mem::size_of_val(&images) as u32,
            &mut needed,
        )
    } == 0
    {
        return Err(win32());
    }
    if needed as usize > std::mem::size_of_val(&images)
        || !(needed as usize).is_multiple_of(std::mem::size_of::<*mut c_void>())
    {
        return Err(Error::invalid(
            "Cannot verify loaded WinDivert driver ownership.",
        ));
    }
    let images = &images[..needed as usize / std::mem::size_of::<*mut c_void>()];
    if images.is_empty() || images.iter().all(|p| p.is_null()) {
        return Err(Error::invalid(
            "Loaded driver inventory is unavailable; capture ownership cannot be verified.",
        ));
    }
    let expected = hash(&expected_path()?)?;
    let mut count = 0;
    for image in images.iter().copied().filter(|p| !p.is_null()) {
        let mut name = [0u16; 1024];
        let mut path = [0u16; 4096];
        // SAFETY: scalar loaded module base and arrays of the advertised capacities.
        let name_length =
            unsafe { GetDeviceDriverBaseNameW(image, name.as_mut_ptr(), name.len() as u32) };
        if name_length == 0 {
            continue;
        }
        if name_length as usize >= name.len() {
            return Err(Error::invalid("Loaded driver name exceeds capacity."));
        }
        // SAFETY: same loaded module base and bounded initialized path array.
        let path_length =
            unsafe { GetDeviceDriverFileNameW(image, path.as_mut_ptr(), path.len() as u32) };
        let path = if path_length > 0 && (path_length as usize) < path.len() {
            Some(normalize(&read_wide(&path))?)
        } else {
            None
        };
        let name = read_wide(&name);
        let is_divert = contains_divert(&name)
            || path
                .as_ref()
                .is_some_and(|p| is_renamed_divert(p).unwrap_or(false));
        if !is_divert {
            continue;
        }
        count += 1;
        if path.and_then(|p| hash(&p).ok()) != Some(expected) {
            return Err(Error::invalid(format!("WINDIVERT_CONFLICT: Loaded driver {name} differs from Wayrill's driver. Resolve the overlap before starting capture.")));
        }
    }
    Ok(count)
}
