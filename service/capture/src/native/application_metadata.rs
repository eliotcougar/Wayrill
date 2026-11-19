// SPDX-License-Identifier: GPL-3.0-only
use super::{read_wide, wide};
use std::{collections::BTreeMap, ffi::c_void, path::Path, ptr};
use windows_sys::Win32::{
    Security::{
        Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE},
        WinTrust::*,
    },
    Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
};

pub fn version_strings(path: &Path) -> BTreeMap<&'static str, String> {
    let path = wide(&path.to_string_lossy());
    let mut ignored = 0;
    // SAFETY: path is NUL terminated and the reserved size pointer is writable.
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if size == 0 || size > 1024 * 1024 {
        return BTreeMap::new();
    }
    let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
    // SAFETY: the initialized, aligned buffer holds at least size bytes.
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) } == 0 {
        return BTreeMap::new();
    }
    let mut result = BTreeMap::new();
    // Windows returns translation IDs and strings as pointers into this buffer.
    let query = |key: &str, width: usize| {
        let mut value: *mut c_void = ptr::null_mut();
        let mut len = 0;
        let key = wide(key);
        // SAFETY: the buffer contains a complete resource; returned pointers
        // are checked against the allocation before creating a slice.
        if unsafe { VerQueryValueW(buffer.as_ptr().cast(), key.as_ptr(), &mut value, &mut len) }
            == 0
        {
            return None;
        }
        let start = (value as usize).checked_sub(buffer.as_ptr() as usize)?;
        let bytes = (len as usize).checked_mul(width)?;
        if start.checked_add(bytes)? > size as usize || start % width != 0 {
            return None;
        }
        // SAFETY: the entire returned slice is within the initialized buffer.
        Some(unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>().add(start), bytes) })
    };
    let Some(translations) = query("\\VarFileInfo\\Translation", 1) else {
        return result;
    };
    for pair in translations.as_chunks::<4>().0.iter().take(32) {
        let lang = u16::from_le_bytes([pair[0], pair[1]]);
        let code = u16::from_le_bytes([pair[2], pair[3]]);
        for key in ["OriginalFilename", "ProductName", "CompanyName"] {
            if result.contains_key(key) {
                continue;
            }
            if let Some(raw) = query(&format!("\\StringFileInfo\\{lang:04x}{code:04x}\\{key}"), 2)
                .filter(|raw| (2..=1026).contains(&raw.len()))
            {
                let value = raw
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect::<Vec<_>>();
                let value = read_wide(&value);
                if !value.trim().is_empty() && !value.chars().any(char::is_control) {
                    result.insert(key, value.trim().to_owned());
                }
            }
        }
    }
    result
}

pub fn verified_signer(path: &Path) -> Option<String> {
    let path = wide(&path.to_string_lossy());
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: path.as_ptr(),
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE,
        ..Default::default()
    };
    // SAFETY: the verification structures and path stay live through
    // verification and closure. Provider pointers are used only before CLOSE.
    unsafe {
        let success = WinVerifyTrustEx(ptr::null_mut(), &mut action, &mut data) == 0;
        let signer = success
            .then(|| {
                let provider = WTHelperProvDataFromStateData(data.hWVTStateData);
                if provider.is_null() {
                    return None;
                }
                let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
                if signer.is_null() {
                    return None;
                }
                let cert = WTHelperGetProvCertFromChain(signer, 0).as_ref()?.pCert;
                if cert.is_null() {
                    return None;
                }
                let mut name = [0u16; 513];
                let len = CertGetNameStringW(
                    cert,
                    CERT_NAME_SIMPLE_DISPLAY_TYPE,
                    0,
                    ptr::null(),
                    name.as_mut_ptr(),
                    name.len() as u32,
                );
                (1 < len && len < name.len() as u32).then(|| read_wide(&name))
            })
            .flatten();
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrustEx(ptr::null_mut(), &mut action, &mut data);
        signer
    }
}
