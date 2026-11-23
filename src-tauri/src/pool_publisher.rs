//! Publishing writes a single encrypted recipient file under the desktop user's
//! permissions. A static web server can serve the same directory unchanged.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf, Prefix},
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
        delivery_digest(&delivery_path(&folder, &recipient)?)
            .map_err(|error| format!("Could not verify this user's access file: {error}"))
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
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    use std::os::windows::fs::MetadataExt;
    const REPARSE_POINT: u32 = 0x400;
    if !metadata.is_file()
        || metadata.file_attributes() & REPARSE_POINT != 0
        || metadata.len() > wayrill_protocol::MAX_CONFIG as u64
    {
        return Err(io::Error::other(
            "Expected a regular Pool access file of at most 16 MiB.",
        ));
    }
    let mut file = fs::File::open(path)?.take(wayrill_protocol::MAX_CONFIG as u64 + 1);
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
    Ok(Some(
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    ))
}

fn check_delivery(path: &Path, expected: Option<&str>) -> io::Result<()> {
    if delivery_digest(path)?.as_deref() != expected {
        return Err(io::Error::other(
            "The access file changed in the publishing folder. Check the file before retrying.",
        ));
    }
    Ok(())
}

fn publish(
    file: &Path,
    recipient: &str,
    text: Option<&str>,
    expected: Option<&str>,
) -> Result<(), String> {
    match text {
        Some(text) => {
            if text.len() > wayrill_protocol::MAX_CONFIG {
                return Err("The Pool access file exceeds 16 MiB.".into());
            }
            let header: Value =
                serde_json::from_str(text).map_err(|_| "Invalid Pool access file.")?;
            if header["format"] != "wayrill.pool.access"
                || header["version"] != 1
                || header["recipient"] != recipient
                || !header["data"].is_string()
                || !header["nonce"].is_string()
            {
                return Err("Only an encrypted Pool access file can be published.".into());
            }
            crate::export::write_export(file, |output| {
                output.write_all(text.as_bytes())?;
                check_delivery(file, expected)
            })
            .map_err(|error| format!("Could not publish this user's access file: {error}"))
        }
        None => match check_delivery(file, expected).and_then(|()| {
            if expected.is_some() {
                fs::remove_file(file)
            } else {
                Ok(())
            }
        }) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Could not withdraw this user's access file: {error}"
            )),
        },
    }
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
        fs::remove_dir(&dir).unwrap();
    }
}
