//! Per-user exchange of observed server accounts from Aquifer to Pool.
use crate::vault;
use std::{fs, path::PathBuf};

const MAX: usize = 16 * 1024 * 1024;

fn folder() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| {
            PathBuf::from(root)
                .join("app.wayrill.aquifer")
                .join("PoolAccounts")
        })
        .ok_or_else(|| "Windows did not provide a local user folder.".into())
}

fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[allow(dead_code)]
pub fn write(key: &str, text: &str) -> Result<(), String> {
    if !valid_key(key) {
        return Err("Invalid observed server identity.".into());
    }
    vault::write_document(&folder()?.join(format!("{key}.dpapi")), text, MAX)
}

#[allow(dead_code)]
pub fn read_all() -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(folder()?) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read the Aquifer account cache.".into()),
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "Could not read an Aquifer cache entry.")?;
        let path = entry.path();
        if path.extension().and_then(|part| part.to_str()) != Some("dpapi")
            || !path
                .file_stem()
                .and_then(|part| part.to_str())
                .is_some_and(valid_key)
        {
            continue;
        }
        if let Some(text) = vault::read_document(&path, MAX)? {
            result.push(text);
        }
    }
    Ok(result)
}
