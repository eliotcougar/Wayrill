//! Publishing writes a single encrypted recipient file under the desktop user's
//! permissions. A static web server can serve the same directory unchanged.
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Component, Path, Prefix},
};

#[tauri::command]
pub async fn pool_publish(
    folder: String,
    recipient: String,
    text: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || publish(&folder, &recipient, text.as_deref()))
        .await
        .map_err(|_| "The Pool publishing task ended unexpectedly.".to_owned())?
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

fn publish(folder: &str, recipient: &str, text: Option<&str>) -> Result<(), String> {
    let root = validate_folder(folder)?;
    if recipient.len() != 32
        || !recipient
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid Pool recipient.".into());
    }
    let file = root.join(format!("{recipient}.wayrill-pool.json"));
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
            crate::export::write_export(&file, |output| output.write_all(text.as_bytes()))
                .map_err(|error| format!("Could not publish this user's access file: {error}"))
        }
        None => match fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Could not withdraw this user's access file: {error}"
            )),
        },
    }
}
