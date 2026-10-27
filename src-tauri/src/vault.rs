// Fixed per-user storage slots. No caller-supplied filesystem paths.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    ptr,
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
};
// Share read access, but deny another writer before it can load stale drafts.
// Windows releases the lease on process exit; the file is intentionally retained.
pub fn lock_workspace(base: &Path) -> std::io::Result<File> {
    fs::create_dir_all(base)?;
    OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(base.join("desktop.lock"))
        .map_err(|error| if error.raw_os_error() == Some(32) {
            std::io::Error::new(std::io::ErrorKind::AlreadyExists,
                "Wayrill is already using this workspace in another process. Close that instance first.")
        } else { error })
}
const MAX: usize = 64 * 1024 * 1024;
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn slot(key: &str) -> Result<(&'static str, usize), String> {
    match key {
        "workspace" => Ok(("workspace.dpapi", MAX)),
        "stash" => Ok(("stash.dpapi", MAX)),
        _ => Err("Unknown protected storage slot.".into()),
    }
}
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX + 65536 {
        return Err("Protected data is too large.".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(
            "Windows could not protect or unlock this user's data. The saved file was preserved."
                .into(),
        );
    }
    let result = if output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}
pub fn read(base: &Path, key: &str) -> Result<Option<String>, String> {
    let (name, limit) = slot(key)?;
    let path = base.join(name);
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read protected storage.".into()),
    };
    if meta.len() > (limit + 65536) as u64 {
        return Err("Protected storage exceeds its limit.".into());
    }
    let encrypted = fs::read(&path).map_err(|_| "Cannot read protected storage.")?;
    let clear = crypt(&encrypted, false)?;
    if clear.len() > limit {
        return Err("Protected storage exceeds its limit.".into());
    }
    String::from_utf8(clear)
        .map(Some)
        .map_err(|_| "Protected storage is not valid text.".into())
}
pub fn write(base: &Path, key: &str, text: &str) -> Result<(), String> {
    let (name, limit) = slot(key)?;
    if text.len() > limit {
        return Err("Protected storage exceeds its limit.".into());
    }
    let encrypted = crypt(text.as_bytes(), true)?;
    fs::create_dir_all(base).map_err(|_| "Cannot create protected storage.")?;
    let path = base.join(name);
    let temporary = base.join(format!(
        "{name}.{}.{}.tmp",
        std::process::id(),
        WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "Cannot write protected storage.")?;
    let _cleanup = TemporaryFile(temporary.clone());
    file.write_all(&encrypted)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot flush protected storage.")?;
    drop(file);
    let wide = |p: &Path| {
        p.as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    if unsafe {
        MoveFileExW(
            wide(&temporary).as_ptr(),
            wide(&path).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err("Cannot commit protected storage. Previous data was preserved.".into());
    }
    // Confirm that the committed ciphertext decrypts to this exact document.
    if read(base, key)?.as_deref() != Some(text) {
        return Err("Protected storage verification failed.".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stores_large_workspace_with_internal_subscription_snapshots() {
        let base = std::env::temp_dir().join(format!("wayrill-vault-pool-{}", std::process::id()));
        let document = "fictional-policy-profile".repeat(140000);
        assert!(document.len() > 2 * 1024 * 1024);
        write(&base, "workspace", &document).unwrap();
        assert_eq!(
            read(&base, "workspace").unwrap().as_deref(),
            Some(document.as_str())
        );
        fs::remove_dir_all(&base).unwrap();
    }
    #[test]
    fn protects_round_trip_and_rejects_corruption() {
        let plain = b"fictional-secret-configuration";
        let mut ciphertext = crypt(plain, true).unwrap();
        assert!(!ciphertext.windows(plain.len()).any(|w| w == plain));
        assert_eq!(crypt(&ciphertext, false).unwrap(), plain);
        let last = ciphertext.len() - 1;
        ciphertext[last] ^= 0xff;
        assert!(crypt(&ciphertext, false).is_err());
    }
    #[test]
    fn independent_writers_never_interleave_ciphertext() {
        let base = std::env::temp_dir().join(format!(
            "wayrill-vault-qa-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let values: Vec<_> = (1..=8)
            .map(|n| format!("fictional-{n}-{}", "x".repeat(n * 4096)))
            .collect();
        let workers: Vec<_> = values
            .iter()
            .cloned()
            .map(|value| {
                let folder = base.clone();
                std::thread::spawn(move || {
                    let _ = write(&folder, "stash", &value);
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let last = read(&base, "stash").unwrap().unwrap();
        assert!(values.contains(&last));
        assert!(fs::read_dir(&base).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        fs::remove_dir_all(&base).unwrap();
    }
    #[test]
    fn only_one_desktop_writer_can_hold_a_workspace_lease() {
        let base =
            std::env::temp_dir().join(format!("wayrill-desktop-lease-{}", std::process::id()));
        let lease = lock_workspace(&base).unwrap();
        assert_eq!(
            lock_workspace(&base).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        drop(lease);
        let next = lock_workspace(&base).unwrap();
        drop(next);
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn fixed_slots_do_not_allow_paths() {
        for bad in ["../workspace", "C:\\secret", "", "workspace.tmp"] {
            assert!(slot(bad).is_err());
        }
    }
}
