// Fixed per-user storage slots. No caller-supplied filesystem paths.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    ptr,
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, ERROR_BUSY, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION},
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
const MAX_WORKSPACE: usize = 2 * MAX + 1024;
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn slot(key: &str) -> Result<(&'static str, usize), String> {
    match key {
        "workspace" => Ok(("workspace.dpapi", MAX_WORKSPACE)),
        "pool-base" => Ok(("pool-base.dpapi", MAX)),
        "pool-previous" => Ok(("pool-previous.dpapi", MAX)),
        "stash" => Ok(("stash.dpapi", MAX)),
        "pools" => Ok(("pools.dpapi", MAX)),
        "restore" => Ok(("restore.dpapi", 128 * 1024)),
        "restore-workspace" => Ok(("restore-workspace.dpapi", MAX_WORKSPACE)),
        "restore-stash" => Ok(("restore-stash.dpapi", MAX)),
        "restore-base" => Ok(("restore-base.dpapi", MAX)),
        _ => Err("Unknown protected storage slot.".into()),
    }
}
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_WORKSPACE + 65536 {
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
#[derive(Debug, serde::Serialize)]
pub struct ReadError {
    pub code: &'static str,
    pub message: String,
}

impl ReadError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "PROTECTED_STORAGE_READ",
            message: message.into(),
        }
    }

    fn from_io(error: io::Error) -> Self {
        let temporary = matches!(
            error.kind(),
            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
        ) || matches!(
            error.raw_os_error().map(|code| code as u32),
            Some(ERROR_BUSY | ERROR_LOCK_VIOLATION | ERROR_SHARING_VIOLATION)
        );
        if temporary {
            Self {
                code: "PROTECTED_STORAGE_BUSY",
                message: "Saved data is temporarily in use. Wayrill will try again.".into(),
            }
        } else {
            Self::invalid("Cannot read protected storage.")
        }
    }
}

impl From<ReadError> for String {
    fn from(error: ReadError) -> Self {
        error.message
    }
}

pub fn read(base: &Path, key: &str) -> Result<Option<String>, ReadError> {
    let (name, limit) = slot(key).map_err(ReadError::invalid)?;
    read_document(&base.join(name), limit)
}
pub fn read_document(path: &Path, limit: usize) -> Result<Option<String>, ReadError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ReadError::from_io(error)),
    };
    let max_bytes = limit + 65536;
    let metadata = file.metadata().map_err(ReadError::from_io)?;
    if metadata.len() > max_bytes as u64 {
        return Err(ReadError::invalid("Protected storage exceeds its limit."));
    }
    let mut encrypted = Vec::with_capacity(metadata.len() as usize);
    file.take((max_bytes + 1) as u64)
        .read_to_end(&mut encrypted)
        .map_err(ReadError::from_io)?;
    if encrypted.len() > max_bytes {
        return Err(ReadError::invalid("Protected storage exceeds its limit."));
    }
    let clear = crypt(&encrypted, false).map_err(ReadError::invalid)?;
    if clear.len() > limit {
        return Err(ReadError::invalid("Protected storage exceeds its limit."));
    }
    String::from_utf8(clear)
        .map(Some)
        .map_err(|_| ReadError::invalid("Protected storage is not valid text."))
}
pub fn write(base: &Path, key: &str, text: &str) -> Result<(), String> {
    let (name, limit) = slot(key)?;
    write_document(&base.join(name), text, limit)
}

pub fn write_document(path: &Path, text: &str, limit: usize) -> Result<(), String> {
    let base = path
        .parent()
        .ok_or("Invalid protected storage directory.")?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid protected storage name.")?;
    if text.len() > limit {
        return Err("Protected storage exceeds its limit.".into());
    }
    let encrypted = crypt(text.as_bytes(), true)?;
    fs::create_dir_all(base).map_err(|_| "Cannot create protected storage.")?;

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
            wide(path).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err("Cannot commit protected storage. Previous data was preserved.".into());
    }
    // Confirm that the committed ciphertext decrypts to this exact document.
    if read_document(path, limit)?.as_deref() != Some(text) {
        return Err("Protected storage verification failed.".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_sharing_violation_is_retryable_and_corrupt_ciphertext_is_terminal() {
        let base = std::env::temp_dir().join(format!("wayrill-vault-read-{}", std::process::id()));
        write(&base, "workspace", "saved draft").unwrap();
        let path = base.join("workspace.dpapi");
        let exclusive = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert_eq!(
            read(&base, "workspace").unwrap_err().code,
            "PROTECTED_STORAGE_BUSY"
        );
        drop(exclusive);
        assert_eq!(
            read(&base, "workspace").unwrap().as_deref(),
            Some("saved draft")
        );
        fs::write(&path, b"not ciphertext").unwrap();
        assert_eq!(
            read(&base, "workspace").unwrap_err().code,
            "PROTECTED_STORAGE_READ"
        );
        assert_eq!(fs::read(&path).unwrap(), b"not ciphertext");
        fs::remove_dir_all(&base).unwrap();
    }

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
