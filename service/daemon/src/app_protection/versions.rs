//! Follow sibling version directories within the selected installation only.
use super::Target;
use std::{collections::BTreeSet, fs, path::Path, time::SystemTime};
use wayrill_protocol::{ApiError, Result};

pub(super) struct Resolved {
    pub applications: Vec<Target>,
    pub targets: Vec<Target>,
}

#[derive(PartialEq, Eq)]
enum Folder {
    Number { prefix: String, version: Vec<u64> },
    Hash(usize),
}
fn folder(name: &str) -> Option<Folder> {
    if name.len() >= 12 && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(Folder::Hash(name.len()));
    }
    let (prefix, number) = name
        .strip_prefix("app-")
        .map_or(("", name), |n| ("app-", n));
    let version = number
        .split('.')
        .map(str::parse::<u64>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()?;
    (version.len() >= 2 && version.len() <= 4).then(|| Folder::Number {
        prefix: prefix.into(),
        version,
    })
}
impl Folder {
    fn compatible(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Number { prefix: a, .. }, Self::Number { prefix: b, .. }) => a == b,
            (Self::Hash(a), Self::Hash(b)) => a == b,
            _ => false,
        }
    }
    fn version(&self) -> Vec<u64> {
        match self {
            Self::Number { version, .. } => version.clone(),
            Self::Hash(_) => vec![],
        }
    }
}

pub(super) fn resolve(applications: &[Target]) -> Result<Resolved> {
    let mut resolved = Resolved {
        applications: applications.to_vec(),
        targets: Vec::new(),
    };
    let mut seen = BTreeSet::new();
    for application in &mut resolved.applications {
        let mut candidates = vec![application.clone()];
        if let Target::Executable { value } = application {
            let path = Path::new(value);
            let layout = path.ancestors().skip(1).find_map(|ancestor| {
                let version = folder(ancestor.file_name()?.to_str()?)?;
                Some((ancestor, version))
            });
            if let Some((version_dir, selected)) = layout {
                let parent = version_dir.parent().unwrap();
                let relative = path.strip_prefix(version_dir).unwrap();
                let entries = match fs::read_dir(parent) {
                    Ok(entries) => Some(entries),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => {
                        return Err(ApiError::io("Find protected application's versions", error))
                    }
                };
                let mut newest = None;
                for entry in entries.into_iter().flatten() {
                    let entry = entry.map_err(|error| {
                        ApiError::io("Read protected application's version", error)
                    })?;
                    let Some(version) = entry.file_name().to_str().and_then(folder) else {
                        continue;
                    };
                    if !selected.compatible(&version) {
                        continue;
                    }
                    let metadata = match fs::symlink_metadata(entry.path()) {
                        Ok(metadata) => metadata,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => {
                            return Err(ApiError::io(
                                "Inspect protected application's version",
                                error,
                            ))
                        }
                    };
                    // Never follow a newly added junction outside this installation.
                    use std::os::windows::fs::MetadataExt;
                    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
                        continue;
                    }
                    let candidate = entry.path().join(relative);
                    let metadata = match fs::metadata(&candidate) {
                        Ok(metadata) if metadata.is_file() => metadata,
                        Ok(_) => continue,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => {
                            return Err(ApiError::io("Inspect protected executable", error))
                        }
                    };
                    let rank = (
                        version.version(),
                        metadata
                            .created()
                            .or_else(|_| metadata.modified())
                            .unwrap_or(SystemTime::UNIX_EPOCH),
                        candidate.to_string_lossy().to_ascii_lowercase(),
                    );
                    let candidate = candidate.to_string_lossy().into_owned();
                    if newest.as_ref().is_none_or(|(current, _)| rank > *current) {
                        newest = Some((rank, candidate.clone()));
                    }
                    candidates.push(Target::Executable { value: candidate });
                }
                if let Some((_, newest)) = newest {
                    *value = newest;
                }
            }
        }
        for target in candidates {
            let key = (
                matches!(target, Target::Package { .. }),
                target.value().to_ascii_lowercase(),
            );
            if seen.insert(key) {
                resolved.targets.push(target);
            }
        }
        if resolved.targets.len() > 1024 {
            return Err(ApiError::new(
                "APP_PROTECTION",
                "Too many installed versions of protected applications.",
            ));
        }
    }
    resolved.targets.sort_by_key(|target| {
        (
            matches!(target, Target::Package { .. }),
            target.value().to_ascii_lowercase(),
        )
    });
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn follows_only_the_same_installation_and_covers_old_and_new_versions() {
        let root =
            std::env::temp_dir().join(format!("wayrill-version-tracking-{}", std::process::id()));
        for name in ["app-1.2.0", "app-1.10.0", "unrelated", "abcdef123456"] {
            fs::create_dir_all(root.join(name).join("bin")).unwrap();
            fs::write(root.join(name).join("bin/app.exe"), name).unwrap();
        }
        let original = root
            .join("app-1.2.0")
            .join("bin")
            .join("app.exe")
            .to_string_lossy()
            .into_owned();
        let selected = vec![Target::Executable {
            value: original.clone(),
        }];
        let first = resolve(&selected).unwrap();
        assert!(first.applications[0].value().contains("app-1.10.0"));
        assert_eq!(first.targets.len(), 2);
        assert!(first
            .targets
            .iter()
            .any(|target| target.value() == original));
        fs::remove_dir_all(root.join("app-1.2.0")).unwrap();
        let next = resolve(&selected).unwrap();
        assert_eq!(next.applications, first.applications);
        assert_eq!(
            next.targets.len(),
            2,
            "the removed original path remains protected"
        );
        let plain = resolve(&[Target::Executable {
            value: root
                .join("unrelated")
                .join("bin")
                .join("app.exe")
                .to_string_lossy()
                .into_owned(),
        }])
        .unwrap();
        assert_eq!(plain.targets.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recognizes_bounded_version_layouts() {
        for value in ["app-1.0.123", "120.0.1.2", "2993767bd1dfb009"] {
            assert!(folder(value).is_some(), "{value}");
        }
        for value in ["bin", "2026", "my-app", "app-1", "1.2.invalid", "abcdef"] {
            assert!(folder(value).is_none(), "{value}");
        }
    }
}
