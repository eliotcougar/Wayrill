//! Publishing writes a single encrypted recipient file under the desktop user's
//! permissions. A static web server can serve the same directory unchanged.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Component, Path, PathBuf, Prefix},
};
use windows_sys::Win32::{
    Foundation::GENERIC_READ,
    Storage::FileSystem::{
        FileDispositionInfo, FileRenameInfo, MoveFileExW, SetFileInformationByHandle, DELETE,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_RENAME_INFO, FILE_SHARE_READ, MOVEFILE_WRITE_THROUGH,
    },
};

#[tauri::command]
pub async fn pool_publish(
    folder: String,
    recipient: String,
    text: Option<String>,
    expected: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        publish(
            &delivery_path(&folder, &recipient)?,
            &recipient,
            text.as_deref(),
            expected.as_deref(),
        )
    })
    .await
    .map_err(|_| "The Pool publishing task ended unexpectedly.".to_owned())?
}

#[tauri::command]
pub async fn pool_delivery_digest(
    folder: String,
    recipient: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = delivery_path(&folder, &recipient)?;
        let observed = || {
            let stage = Publication::lock(&path)?;
            stage.recover(&path)?;
            delivery_digest(&path)
        };
        observed().map_err(|error| format!("Could not verify this user's access file: {error}"))
    })
    .await
    .map_err(|_| "The delivery check ended unexpectedly.")?
}

#[tauri::command]
pub async fn pool_validate_folder(folder: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || validate_folder(&folder).map(|_| ()))
        .await
        .map_err(|_| "The folder check ended unexpectedly.")?
}

fn validate_folder(folder: &str) -> Result<&Path, String> {
    let root = Path::new(folder);
    if folder.len() > 2048
        || folder.contains('\0')
        || !root.is_absolute()
        || !matches!(root.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
        || folder.get(2..).is_some_and(|rest| rest.contains(':'))
        || !root.is_dir()
    {
        return Err("Choose an existing local folder for publishing.".into());
    }
    Ok(root)
}

fn delivery_path(folder: &str, recipient: &str) -> Result<PathBuf, String> {
    let root = validate_folder(folder)?;
    if recipient.len() != 32
        || !recipient
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid Pool recipient.".into());
    }
    Ok(root.join(format!("{recipient}.wayrill-pool.json")))
}

fn delivery_digest(path: &Path) -> io::Result<Option<String>> {
    open_delivery(path, false)?.map(digest).transpose()
}

fn regular(metadata: &fs::Metadata) -> bool {
    metadata.is_file() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

fn open_delivery(path: &Path, edit: bool) -> io::Result<Option<File>> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    if edit {
        // Exclude writes and renames until we mutate the verified handle.
        options
            .access_mode(GENERIC_READ | DELETE)
            .share_mode(FILE_SHARE_READ);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !regular(&metadata) || metadata.len() > wayrill_protocol::MAX_CONFIG as u64 {
        return Err(io::Error::other(
            "Expected a regular Pool access file of at most 16 MiB.",
        ));
    }
    Ok(Some(file))
}

fn digest(file: impl Read) -> io::Result<String> {
    let mut file = file.take(wayrill_protocol::MAX_CONFIG as u64 + 1);
    let mut hash = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if file.limit() == 0 {
        return Err(io::Error::other("The Pool access file exceeds 16 MiB."));
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn verified_delivery(path: &Path, expected: Option<&str>) -> io::Result<Option<File>> {
    let file = open_delivery(path, true)?;
    if file.as_ref().map(digest).transpose()?.as_deref() != expected {
        return Err(io::Error::other(
            "The access file changed in the publishing folder. Check the file before retrying.",
        ));
    }
    Ok(file)
}

struct Publication {
    _lease: File,
    previous: PathBuf,
    next: PathBuf,
}

impl Publication {
    fn lock(path: &Path) -> io::Result<Self> {
        let name = path
            .file_name()
            .expect("recipient file has a name")
            .to_string_lossy();
        let directory = path.with_file_name(format!(".{name}.publish"));
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        let metadata = fs::symlink_metadata(&directory)?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("Invalid Pool publication directory."));
        }
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(directory.join("lease"))?;
        let metadata = lease.metadata()?;
        if !regular(&metadata) || metadata.len() != 0 {
            return Err(io::Error::other("Invalid Pool publication lease."));
        }
        Ok(Self {
            _lease: lease,
            previous: directory.join("previous"),
            next: directory.join("next"),
        })
    }

    fn recover(&self, path: &Path) -> io::Result<()> {
        let previous = open_delivery(&self.previous, false)?.is_some();
        let next = open_delivery(&self.next, false)?.is_some();
        // An existing stage proves replacement never consumed it. Restore the
        // predecessor only into a vacant name, even if a writer arrives now.
        if previous && next {
            match move_new(&self.previous, path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        // Retire the predecessor before deleting the proof of non-commit.
        remove_staged(&self.previous)?;
        remove_staged(&self.next)
    }

    fn replace(&self, path: &Path, text: &str, expected: Option<&str>) -> io::Result<()> {
        crate::export::write_export(&self.next, |output| output.write_all(text.as_bytes()))?;
        let result = (|| {
            if let Some(previous) = verified_delivery(path, expected)? {
                crate::export::preserve_access(path, &self.next)?;
                rename_handle(&previous, &self.previous)?;
            }
            move_new(&self.next, path)
        })();
        let cleanup = self.recover(path);
        result.and(cleanup)
    }
}

fn remove_staged(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn move_new(source: &Path, destination: &Path) -> io::Result<()> {
    // SAFETY: both terminated UTF-16 strings live throughout the call.
    if unsafe {
        MoveFileExW(
            wide(source).as_ptr(),
            wide(destination).as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn rename_handle(file: &File, destination: &Path) -> io::Result<()> {
    let name = wide(destination);
    let length = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
    let mut buffer = vec![0usize; length.div_ceil(std::mem::size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: the aligned buffer holds the fixed header and entire terminated
    // filename. Zero flags forbid replacement, and RootDirectory is null.
    let result = unsafe {
        (*info).FileNameLength = ((name.len() - 1) * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast(),
            name.len(),
        );
        SetFileInformationByHandle(
            file.as_raw_handle().cast(),
            FileRenameInfo,
            info.cast(),
            length as u32,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn withdraw(file: File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: the live handle has DELETE access and the disposition is fixed size.
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle().cast(),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of_val(&disposition) as u32,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn publish(
    file: &Path,
    recipient: &str,
    text: Option<&str>,
    expected: Option<&str>,
) -> Result<(), String> {
    if let Some(text) = text {
        if text.len() > wayrill_protocol::MAX_CONFIG {
            return Err("The Pool access file exceeds 16 MiB.".into());
        }
        let header: Value = serde_json::from_str(text).map_err(|_| "Invalid Pool access file.")?;
        if header["format"] != "wayrill.pool.access"
            || header["version"] != 1
            || header["recipient"] != recipient
            || !header["data"].is_string()
            || !header["nonce"].is_string()
        {
            return Err("Only an encrypted Pool access file can be published.".into());
        }
    }
    let commit = || {
        let stage = Publication::lock(file)?;
        stage.recover(file)?;
        match text {
            Some(text) => stage.replace(file, text, expected),
            None => match verified_delivery(file, expected)? {
                Some(file) => withdraw(file),
                None => Ok(()),
            },
        }
    };
    commit().map_err(|error| format!("Could not change this user's Pool access file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishing_and_withdrawing_preserve_a_file_changed_after_planning() {
        let dir =
            std::env::temp_dir().join(format!("wayrill-pool-delivery-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let recipient = "a".repeat(32);
        let file = dir.join("delivery.json");
        let text = serde_json::json!({"format":"wayrill.pool.access","version":1,
            "recipient":recipient,"data":"encrypted","nonce":"nonce"})
        .to_string();
        publish(&file, &recipient, Some(&text), None).unwrap();
        let approved = delivery_digest(&file).unwrap();
        fs::write(&file, "replacement from another writer").unwrap();
        assert!(publish(&file, &recipient, Some(&text), approved.as_deref()).is_err());
        assert!(publish(&file, &recipient, None, approved.as_deref()).is_err());
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "replacement from another writer"
        );
        let current = delivery_digest(&file).unwrap();
        publish(&file, &recipient, None, current.as_deref()).unwrap();
        assert_eq!(delivery_digest(&file).unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn verified_replacement_recovers_interruption_and_never_overwrites_a_concurrent_file() {
        let dir = std::env::temp_dir().join(format!(
            "wayrill-pool-publish-recovery-{}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("delivery.json");
        let recipient = "b".repeat(32);
        let envelope = |data| {
            serde_json::json!({
                "format":"wayrill.pool.access","version":1,"recipient":recipient,
                "data":data,"nonce":"nonce",
            })
            .to_string()
        };
        let before = envelope("first");
        let after = envelope("second");
        publish(&path, &recipient, Some(&before), None).unwrap();

        let expected = delivery_digest(&path).unwrap().unwrap();
        for concurrent in [false, true] {
            let stage = Publication::lock(&path).unwrap();
            fs::write(&stage.next, &after).unwrap();
            let verified = verified_delivery(&path, Some(&expected)).unwrap().unwrap();
            assert!(fs::write(&path, "foreign edit").is_err());
            assert!(fs::rename(&path, dir.join("foreign")).is_err());
            rename_handle(&verified, &stage.previous).unwrap();
            drop(verified);
            assert!(!path.exists());
            if concurrent {
                fs::write(&path, "concurrent replacement").unwrap();
                assert!(move_new(&stage.next, &path).is_err());
            }
            // The next invocation sees the same durable state after a crash.
            drop(stage);
            let reopened = Publication::lock(&path).unwrap();
            reopened.recover(&path).unwrap();
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                if concurrent {
                    "concurrent replacement"
                } else {
                    &before
                }
            );
        }
        let expected = delivery_digest(&path).unwrap().unwrap();
        publish(&path, &recipient, Some(&after), Some(&expected)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), after);
        fs::remove_dir_all(&dir).unwrap();
    }
}
