//! Installation identity shared by the controller and native app component.
use sha2::{Digest, Sha256};

pub fn key(path: &str) -> String {
    let path = path.replace('/', "\\").to_lowercase();
    let (parent, name) = path.rsplit_once('\\').unwrap_or(("", &path));
    let parent = parent.rsplit_once('\\').map_or(parent, |(base, version)| {
        let version = version.strip_prefix("app-").unwrap_or(version);
        if version.contains('.') && version.bytes().all(|v| v.is_ascii_digit() || v == b'.') {
            base
        } else {
            parent
        }
    });
    Sha256::digest(format!("{parent}\\{name}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
