//! DPAPI-protected handoff between the two desktop applications.
use crate::vault;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const IDENTIFIER: &str = "app.wayrill.pool";
const MAX_PENDING: usize = 64;

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}

fn path(base: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid Pool export identity.".into());
    }
    Ok(base.join("Inbox").join(format!("{id}.dpapi")))
}

pub fn list(base: &Path) -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(base.join("Inbox")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read incoming Pool exports.".into()),
    };
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "Could not read incoming Pool exports.")?;
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let name = entry.file_name();
        if let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".dpapi"))
            .filter(|id| valid_id(id))
        {
            let modified = entry.metadata().and_then(|info| info.modified()).ok();
            found.push((modified, id.to_owned()));
        }
    }
    found.sort_unstable();
    Ok(found.into_iter().rev().map(|(_, id)| id).collect())
}

pub fn stage(base: &Path, id: &str, text: &str) -> Result<(), String> {
    let file = path(base, id)?;
    if list(base)?.len() >= MAX_PENDING {
        return Err("Open Wayrill Pool and review its pending imports first.".into());
    }
    vault::write_document(&file, text, wayrill_protocol::MAX_CONFIG)
}

pub fn read(base: &Path, id: &str) -> Result<String, String> {
    vault::read_document(&path(base, id)?, wayrill_protocol::MAX_CONFIG)?
        .ok_or_else(|| "This Pool export is no longer available.".into())
}

pub fn discard(base: &Path, id: &str) -> Result<(), String> {
    match fs::remove_file(path(base, id)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not remove this Pool export from the inbox.".into()),
    }
}
