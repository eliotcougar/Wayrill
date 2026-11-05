//! User-scoped DPAPI storage. Portable JSON is written only by an explicit export.
use crate::remote::{RemoteError, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
    UI::Controls::Dialogs::{
        CommDlgExtendedError, GetSaveFileNameW, OFN_DONTADDTORECENT, OFN_EXPLORER, OFN_NOCHANGEDIR,
        OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    },
};

const MAX_LIBRARY: usize = 8 * 1024 * 1024;
const MAX_EXPORT: usize = 16 * 1024 * 1024;
static STORE: Mutex<()> = Mutex::new(());
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

fn error(message: &str) -> RemoteError {
    RemoteError::new("USER_LIBRARY", message)
}
fn path() -> Result<PathBuf> {
    crate::app_data::path("user-sets.dpapi")
        .ok_or_else(|| error("Windows did not provide a local user folder."))
}
fn valid_library(text: &str) -> Result<()> {
    if text.len() > MAX_LIBRARY {
        return Err(error("The user library exceeds 8 MiB."));
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| error("The user library is not valid JSON."))?;
    if value["format"] != "wayrill-user-sets"
        || value["version"] != 1
        || value["sets"].as_array().is_none_or(|sets| sets.len() > 512)
    {
        return Err(error("The user library format is invalid."));
    }
    Ok(())
}
fn crypt(input: &[u8], protect: bool) -> Result<Vec<u8>> {
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let success = unsafe {
        if protect {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err(error(if protect {
            "Windows could not protect the user library. The previous file was kept."
        } else {
            "Windows could not unlock the user library with this Windows account; the existing file was kept."
        }));
    }
    let bytes = unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
    let result = bytes.to_vec();
    // DPAPI owns this allocation; clear plaintext before releasing it.
    for byte in bytes {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error("The destination folder is invalid."))?;
    let temporary = parent.join(format!(
        ".wayrill-{}-{}.tmp",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut created = false;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        created = true;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if unsafe {
            MoveFileExW(
                wide(&temporary).as_ptr(),
                wide(path).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() && created {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| error("Cannot save this file. The previous file was kept."))
}
fn load_from(path: &Path) -> Result<Option<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("Cannot read the saved user library.")),
    };
    let mut bytes = Vec::new();
    file.take((MAX_LIBRARY + 65537) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Cannot read the saved user library."))?;
    if bytes.len() > MAX_LIBRARY + 65536 {
        return Err(error("The saved user library is too large."));
    }
    let plaintext = crypt(&bytes, false)?;
    let text =
        String::from_utf8(plaintext).map_err(|_| error("The saved user library is not UTF-8."))?;
    valid_library(&text)?;
    Ok(Some(text))
}
fn save_to(path: &Path, text: String) -> Result<()> {
    valid_library(&text)?;
    let mut plaintext = text.into_bytes();
    let encrypted = crypt(&plaintext, true);
    for byte in &mut plaintext {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    let encrypted = encrypted?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| error("The library folder is invalid."))?,
    )
    .map_err(|_| error("Cannot create the user library folder."))?;
    atomic_write(path, &encrypted)
}
pub fn load() -> Result<Option<String>> {
    let _guard = STORE
        .lock()
        .map_err(|_| error("The user library is busy. Restart the app."))?;
    load_from(
        &crate::app_data::readable("user-sets.dpapi")
            .ok_or_else(|| error("Windows did not provide a local user folder."))?,
    )
}
pub fn save(text: String) -> Result<()> {
    let _guard = STORE
        .lock()
        .map_err(|_| error("The user library is busy. Restart the app."))?;
    let location = path()?;
    // A corrupt/inaccessible library must never be replaced by an empty new one.
    load_from(&location)?;
    save_to(&location, text)
}
pub fn export(filename: &str, text: &str, owner: usize) -> Result<bool> {
    if text.len() > MAX_EXPORT
        || !filename.ends_with(".json")
        || filename.len() > 128
        || !filename
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(error("The JSON export is invalid or exceeds 16 MiB."));
    }
    let _: serde_json::Value =
        serde_json::from_str(text).map_err(|_| error("Cannot export invalid JSON."))?;
    let mut output = vec![0u16; 32768];
    let initial: Vec<u16> = filename.encode_utf16().collect();
    output[..initial.len()].copy_from_slice(&initial);
    let filter: Vec<u16> = "JSON files (*.json)\0*.json\0\0".encode_utf16().collect();
    let extension: Vec<u16> = "json\0".encode_utf16().collect();
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of_val(&dialog) as u32;
    dialog.hwndOwner = owner as _;
    dialog.lpstrFile = output.as_mut_ptr();
    dialog.nMaxFile = output.len() as u32;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.lpstrDefExt = extension.as_ptr();
    dialog.Flags = OFN_EXPLORER
        | OFN_OVERWRITEPROMPT
        | OFN_PATHMUSTEXIST
        | OFN_NOCHANGEDIR
        | OFN_DONTADDTORECENT;
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        if unsafe { CommDlgExtendedError() } != 0 {
            return Err(error("The Save dialog could not be opened."));
        }
        return Ok(false);
    }
    let end = output
        .iter()
        .position(|v| *v == 0)
        .ok_or_else(|| error("The selected filename is invalid."))?;
    atomic_write(
        &PathBuf::from(String::from_utf16_lossy(&output[..end])),
        text.as_bytes(),
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    const LIBRARY: &str =
        r#"{"format":"wayrill-user-sets","version":1,"sets":[{"secret":"fictional credential"}]}"#;
    #[test]
    fn dpapi_round_trip_and_corruption_fail_closed() {
        let encrypted = crypt(LIBRARY.as_bytes(), true).unwrap();
        assert!(!encrypted.windows(10).any(|part| part == b"fictional "));
        assert_eq!(crypt(&encrypted, false).unwrap(), LIBRARY.as_bytes());
        let mut damaged = encrypted;
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        assert!(crypt(&damaged, false).is_err());
    }
    #[test]
    fn saves_atomically_and_rejects_malformed_data_without_replacing_file() {
        let folder = std::env::temp_dir().join(format!("wayrill-users-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("Пользователи.dpapi");
        assert!(load_from(&path).unwrap().is_none());
        save_to(&path, LIBRARY.into()).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(save_to(&path, "{}".into()).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let empty = r#"{"format":"wayrill-user-sets","version":1,"sets":[]}"#;
        save_to(&path, empty.into()).unwrap();
        assert_eq!(load_from(&path).unwrap().unwrap(), empty);
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        fs::remove_file(path).unwrap();
        fs::remove_dir(folder).unwrap();
    }
}
