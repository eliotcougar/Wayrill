//! User-selected exports run with the desktop token, never through the service.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::Win32::{
    Security::{
        GetFileSecurityW, GetSecurityDescriptorControl, SetFileSecurityW,
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        UNPROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
    System::Com::CoTaskMemFree,
    UI::{
        Controls::Dialogs::*,
        Shell::{FOLDERID_Documents, SHGetKnownFolderPath},
    },
};
fn documents_folder() -> Vec<u16> {
    let mut path = std::ptr::null_mut();
    let mut result = Vec::new();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_Documents, 0, std::ptr::null_mut(), &mut path) } == 0
        && !path.is_null()
    {
        let mut i = 0;
        while i < 32767 {
            let ch = unsafe { *path.add(i) };
            result.push(ch);
            if ch == 0 {
                break;
            }
            i += 1;
        }
    }
    if !path.is_null() {
        unsafe { CoTaskMemFree(path.cast()) };
    }
    if result.last() != Some(&0) {
        result.clear();
    }
    result
}
pub fn save(owner: usize, name: &str, text: &str) -> Result<bool, String> {
    if text.len() > 192 * 1024 * 1024
        || name.len() > 240
        || name.is_empty()
        || name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    {
        return Err("Invalid export name or content size.".into());
    }
    let mut file = vec![0u16; 32768];
    let initial: Vec<_> = name.encode_utf16().collect();
    file[..initial.len()].copy_from_slice(&initial);
    let filter: Vec<_> = "JSON files (*.json)\0*.json\0All files (*.*)\0*.*\0\0"
        .encode_utf16()
        .collect();
    let extension: Vec<_> = "json\0".encode_utf16().collect();
    let title: Vec<_> = "Export — Wayrill\0".encode_utf16().collect();
    let initial_dir = documents_folder();
    let mut dialog = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: owner as _,
        lpstrFile: file.as_mut_ptr(),
        nMaxFile: file.len() as u32,
        lpstrFilter: filter.as_ptr(),
        nFilterIndex: 1,
        lpstrDefExt: extension.as_ptr(),
        lpstrTitle: title.as_ptr(),
        lpstrInitialDir: if initial_dir.is_empty() {
            std::ptr::null()
        } else {
            initial_dir.as_ptr()
        },
        Flags: OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR,
        ..Default::default()
    };
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 {
            Ok(false)
        } else {
            Err("The Save dialog could not be opened.".into())
        };
    }
    let end = file.iter().position(|v| *v == 0).unwrap_or(file.len());
    let path = String::from_utf16(&file[..end]).map_err(|_| "Invalid export path.")?;
    write_export(Path::new(&path), |file| file.write_all(text.as_bytes()))
        .map_err(|e| format!("Could not save the export. Previous file was preserved: {e}"))?;
    Ok(true)
}

static EXPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct TemporaryExport(PathBuf);
impl Drop for TemporaryExport {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
// Copy a selected existing file's DACL before writing plaintext into its replacement.
// A new export uses the chosen directory's normal inherited access permissions.
fn preserve_access(path: &Path, temporary: &Path) -> io::Result<()> {
    match fs::metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_file() => {
            return Err(io::Error::other("The export destination is not a file."))
        }
        Ok(_) => {}
    }
    let path = wide(path);
    let mut needed = 0;
    unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut needed,
        );
    }
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut descriptor = vec![0u32; (needed as usize).div_ceil(4)];
    let security = descriptor.as_mut_ptr().cast();
    if unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION,
            security,
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(security, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let protection = if control & SE_DACL_PROTECTED != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    if unsafe {
        SetFileSecurityW(
            wide(temporary).as_ptr(),
            DACL_SECURITY_INFORMATION | protection,
            security,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn write_export(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::other("The export has no directory."))?;
    let temporary = directory.join(format!(
        ".wayrill-export-{}-{}.tmp",
        std::process::id(),
        EXPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(0)
        .open(&temporary)?;
    let cleanup = TemporaryExport(temporary);
    // Drop the denied-share handle before attempting cleanup on every error path.
    let mut file = file;
    preserve_access(path, &cleanup.0)?;
    write(&mut file)?;
    file.sync_all()?;
    drop(file);
    if unsafe {
        MoveFileExW(
            wide(&cleanup.0).as_ptr(),
            wide(path).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "wayrill-export-test-{}-{}",
            std::process::id(),
            EXPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    fn no_temporary_files(path: &Path) {
        assert!(fs::read_dir(path).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }
    #[test]
    fn partial_write_failure_preserves_an_existing_export() {
        let directory = directory();
        let path = directory.join("previous.json");
        fs::write(&path, "old export").unwrap();
        let result = write_export(&path, |file| {
            file.write_all(b"partial replacement")?;
            Err(io::Error::other("Injected disk failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "old export");
        no_temporary_files(&directory);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn locked_destination_preserves_old_content_and_cleans_staging() {
        let directory = directory();
        let path = directory.join("locked.json");
        fs::write(&path, "old export").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(write_export(&path, |file| file.write_all(b"replacement")).is_err());
        drop(lock);
        assert_eq!(fs::read_to_string(&path).unwrap(), "old export");
        no_temporary_files(&directory);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn creates_and_replaces_a_unicode_export_without_partial_content() {
        let directory = directory();
        let path = directory.join("Пример 日本語.json");
        write_export(&path, |file| file.write_all(b"first")).unwrap();
        write_export(&path, |file| file.write_all(b"complete second")).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "complete second");
        no_temporary_files(&directory);
        fs::remove_dir_all(directory).unwrap();
    }
}
