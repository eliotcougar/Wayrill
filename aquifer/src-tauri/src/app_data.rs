use std::path::{Path, PathBuf};

pub fn path(name: &str) -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("app.wayrill.aquifer").join(name))
}

pub fn readable(name: &str) -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|root| readable_in(Path::new(&root), name))
}

fn readable_in(root: &Path, name: &str) -> PathBuf {
    let current = root.join("app.wayrill.aquifer").join(name);
    // Do not hide unreadable or malformed new stores behind older data.
    if !matches!(std::fs::metadata(&current), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        return current;
    }
    let old = root.join("app.wayrill.remote.poc").join(name);
    match std::fs::metadata(&old) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => current,
        _ => old,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_reads_never_overwrite_or_hide_current_data() {
        let root = std::env::temp_dir().join(format!("aquifer-store-{}", std::process::id()));
        let old = root.join("app.wayrill.remote.poc");
        let new = root.join("app.wayrill.aquifer");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("winscp.json"), b"legacy").unwrap();
        assert_eq!(readable_in(&root, "winscp.json"), old.join("winscp.json"));
        std::fs::write(new.join("winscp.json"), b"current").unwrap();
        assert_eq!(readable_in(&root, "winscp.json"), new.join("winscp.json"));
        assert_eq!(readable_in(&root, "missing"), new.join("missing"));
        assert_eq!(std::fs::read(old.join("winscp.json")).unwrap(), b"legacy");
        std::fs::remove_dir_all(root).unwrap();
    }
}
