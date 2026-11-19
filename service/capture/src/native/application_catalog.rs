// SPDX-License-Identifier: GPL-3.0-only
//! Local, read-only discovery of portable Pool executable identities.
use super::{application_metadata, processes::ProcessSnapshot, read_wide, wide};
use crate::{text, Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    io::Read,
    os::windows::fs::MetadataExt,
    path::{Component, Path, PathBuf, Prefix},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS},
    Storage::FileSystem::{GetDriveTypeW, FILE_ATTRIBUTE_REPARSE_POINT},
    System::Registry::*,
};

const APP_PATHS: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const VIEWS: [u32; 2] = [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY];

pub(crate) fn registry(root: HKEY, key: &str, name: &str, flags: u32) -> Option<String> {
    let mut data = [0u16; 1024];
    let mut size = (data.len() * 2) as u32;
    // SAFETY: key and value are terminated and the writable buffer has the
    // specified capacity. The registry never retains these pointers.
    let status = unsafe {
        RegGetValueW(
            root,
            wide(key).as_ptr(),
            wide(name).as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | flags,
            std::ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut size,
        )
    };
    (status == ERROR_SUCCESS).then(|| read_wide(&data))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Executable {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    company: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relative_path: Option<String>,
}

impl Executable {
    fn valid(&self) -> bool {
        valid_component(&self.name)
            && self.name.encode_utf16().count() <= 255
            && self.name.to_ascii_lowercase().ends_with(".exe")
            && [
                &self.original_name,
                &self.product,
                &self.company,
                &self.signer,
                &self.relative_path,
            ]
            .into_iter()
            .flatten()
            .all(|field| {
                field.encode_utf16().count() <= 512
                    && !field.is_empty()
                    && !field.chars().any(char::is_control)
            })
            && self.relative_path.as_ref().is_none_or(|value| {
                value.split('/').all(valid_component)
                    && value
                        .rsplit('/')
                        .next()
                        .is_some_and(|name| text::equal(name, &self.name))
            })
    }

    fn inspect(path: &Path, roots: &[PathBuf]) -> Result<Self> {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Error::invalid("Missing executable filename."))?
            .to_owned();
        let mut metadata = application_metadata::version_strings(path);
        let relative_path = roots
            .iter()
            .filter_map(|root| {
                let path_lower = path.to_string_lossy().to_lowercase();
                let root_lower = root.to_string_lossy().to_lowercase();
                if !Path::new(&path_lower).starts_with(Path::new(&root_lower)) {
                    return None;
                }
                let relative = path
                    .components()
                    .skip(root.components().count())
                    .collect::<PathBuf>();
                (relative.components().count() > 1)
                    .then(|| relative.to_string_lossy().replace('\\', "/"))
            })
            .min_by_key(String::len);
        let result = Self {
            name,
            original_name: metadata.remove("OriginalFilename"),
            product: metadata.remove("ProductName"),
            company: metadata.remove("CompanyName"),
            signer: application_metadata::verified_signer(path),
            relative_path,
        };
        if !result.valid() {
            return Err(Error::invalid("Invalid executable identity."));
        }
        Ok(result)
    }
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && !value.ends_with(['.', ' '])
        && !value.contains(['<', '>', ':', '"', '\\', '|', '?', '*', '/'])
        && !value.chars().any(char::is_control)
}

struct Locations {
    profile: Option<String>,
    local: Option<String>,
    global: Vec<PathBuf>,
}
impl Locations {
    fn for_owner(owner: &str) -> Self {
        let profile = registry(
            HKEY_LOCAL_MACHINE,
            &format!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{owner}"),
            "ProfileImagePath",
            0,
        );
        let local = registry(
            HKEY_USERS,
            &format!(
                r"{owner}\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
            ),
            "Local AppData",
            RRF_NOEXPAND,
        )
        .and_then(|value| expand(&value, profile.as_deref(), None))
        .or_else(|| {
            profile
                .as_ref()
                .map(|path| format!(r"{path}\AppData\Local"))
        });
        let global = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Self {
            profile,
            local,
            global,
        }
    }
    fn program_roots(&self) -> Vec<PathBuf> {
        self.global
            .iter()
            .cloned()
            .chain(
                self.local
                    .iter()
                    .map(|path| Path::new(path).join("Programs")),
            )
            .collect()
    }
    fn hint_roots(&self) -> Vec<PathBuf> {
        self.program_roots()
            .into_iter()
            .chain(self.local.iter().map(PathBuf::from))
            .collect()
    }
    fn path(&self, input: &str) -> Option<PathBuf> {
        expand(
            input.trim().trim_matches('"'),
            self.profile.as_deref(),
            self.local.as_deref(),
        )
        .map(PathBuf::from)
    }
}
fn expand(value: &str, profile: Option<&str>, local: Option<&str>) -> Option<String> {
    let mut output = String::new();
    for (i, chunk) in value.split('%').enumerate() {
        if i % 2 == 0 {
            output.push_str(chunk);
        } else {
            let resolved = match chunk.to_ascii_lowercase().as_str() {
                "userprofile" => profile?.to_owned(),
                "localappdata" => local?.to_owned(),
                "programfiles" | "programfiles(x86)" | "programw6432" | "systemdrive"
                | "systemroot" | "windir" | "programdata" => std::env::var(chunk).ok()?,
                _ => return None,
            };
            output.push_str(&resolved);
        }
    }
    Some(output)
}

fn safe_local(path: &Path) -> bool {
    if !path.is_absolute() || path.as_os_str().len() > 32767 ||
        !matches!(path.components().next(), Some(Component::Prefix(root)) if matches!(root.kind(), Prefix::Disk(_))) ||
        !path.components().skip(2).all(|part| matches!(part, Component::Normal(name) if name.to_str().is_some_and(valid_component))) {
        return false;
    }
    let Some(root) = path.ancestors().last() else {
        return false;
    };
    // SAFETY: root is a terminated, ordinary drive-letter path.
    if unsafe { GetDriveTypeW(wide(&root.to_string_lossy()).as_ptr()) } != 3 {
        return false;
    }
    // Inspect from the volume root down so following a junction never opens
    // another volume, a network share or an unrelated installation.
    path.ancestors()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .all(|entry| {
            fs::symlink_metadata(entry)
                .is_ok_and(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0)
        })
}

fn executable_file(path: &Path) -> bool {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        || !safe_local(path)
        || !path.is_file()
    {
        return false;
    }
    let mut magic = [0; 2];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
        && magic == *b"MZ"
}

pub fn describe(owner: &str, path: &str) -> Result<Executable> {
    let path = Path::new(path);
    if !executable_file(path) {
        return Err(Error::invalid(
            "Choose an executable on a local fixed drive.",
        ));
    }
    Executable::inspect(path, &Locations::for_owner(owner).hint_roots())
}

#[derive(Default, Serialize)]
pub struct Detection {
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    candidates: Vec<String>,
}
struct Candidate {
    path: PathBuf,
    registered: bool,
}
type Candidates = BTreeMap<String, Candidate>;

fn candidate(paths: &mut Candidates, path: PathBuf, name: &str, registered: bool) {
    if paths.len() >= 24
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|value| text::equal(value, name))
        || !executable_file(&path)
    {
        return;
    }
    let item = paths
        .entry(path.to_string_lossy().to_lowercase())
        .or_insert(Candidate {
            path,
            registered: false,
        });
    item.registered |= registered;
}

fn subkeys(root: HKEY, path: &str, view: u32, deadline: Instant) -> Vec<String> {
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: Key exclusively owns this opened registry handle.
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    let mut handle = std::ptr::null_mut();
    // SAFETY: the subkey string and the writable output handle are valid.
    if unsafe {
        RegOpenKeyExW(
            root,
            wide(path).as_ptr(),
            0,
            KEY_ENUMERATE_SUB_KEYS | view,
            &mut handle,
        )
    } != ERROR_SUCCESS
    {
        return Vec::new();
    }
    let key = Key(handle);
    let mut names = Vec::new();
    let mut buf = [0u16; 256];
    for i in 0..2048 {
        if Instant::now() >= deadline {
            break;
        }
        let mut len = buf.len() as u32;
        // SAFETY: the handle stays open and the buffer has the declared capacity.
        let result = unsafe {
            RegEnumKeyExW(
                key.0,
                i,
                buf.as_mut_ptr(),
                &mut len,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result == ERROR_NO_MORE_ITEMS {
            break;
        }
        if result == ERROR_SUCCESS && (len as usize) <= buf.len() {
            names.push(read_wide(&buf[..len as usize]));
        }
    }
    names
}

fn installed_roots(
    owner: &str,
    locations: &Locations,
    products: &BTreeSet<String>,
    deadline: Instant,
) -> BTreeMap<String, Vec<PathBuf>> {
    let mut result = BTreeMap::<String, Vec<PathBuf>>::new();
    if products.is_empty() {
        return result;
    }
    for (root, prefix) in [
        (HKEY_LOCAL_MACHINE, String::new()),
        (HKEY_USERS, format!("{owner}\\")),
    ] {
        let base = format!("{prefix}{UNINSTALL}");
        for (open_view, read_view) in [KEY_WOW64_64KEY, KEY_WOW64_32KEY].into_iter().zip(VIEWS) {
            for key in subkeys(root, &base, open_view, deadline) {
                if Instant::now() >= deadline {
                    return result;
                }
                let key = format!("{base}\\{key}");
                let Some(product) = registry(root, &key, "DisplayName", read_view)
                    .map(|value| value.to_lowercase())
                else {
                    continue;
                };
                if products.contains(&product) {
                    if let Some(path) =
                        registry(root, &key, "InstallLocation", read_view | RRF_NOEXPAND)
                            .and_then(|path| locations.path(&path))
                    {
                        let paths = result.entry(product).or_default();
                        if paths.len() < 16 && !paths.contains(&path) {
                            paths.push(path);
                        }
                    }
                }
            }
        }
    }
    result
}

fn scan(
    roots: impl IntoIterator<Item = PathBuf>,
    names: &mut BTreeMap<String, Candidates>,
    deadline: Instant,
    limit: usize,
) -> bool {
    let mut queue: VecDeque<_> = roots
        .into_iter()
        .filter(|path| safe_local(path))
        .map(|path| (path, 0u8))
        .collect();
    let mut remaining = limit;
    while let Some((directory, depth)) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if remaining == 0 || Instant::now() >= deadline {
                return false;
            }
            remaining -= 1;
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if kind.is_dir()
                && depth < 3
                && name != "windowsapps"
                && entry
                    .metadata()
                    .is_ok_and(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0)
            {
                queue.push_back((entry.path(), depth + 1));
            } else if kind.is_file() {
                if let Some(paths) = names.get_mut(&name) {
                    candidate(paths, entry.path(), &name, false);
                }
            }
        }
    }
    true
}

fn matches(wanted: &Executable, item: &Candidate, roots: &[PathBuf]) -> bool {
    let file = application_metadata::version_strings(&item.path);
    for (wanted, actual) in [
        (&wanted.original_name, "OriginalFilename"),
        (&wanted.product, "ProductName"),
        (&wanted.company, "CompanyName"),
    ] {
        if wanted.as_ref().is_some_and(|value| {
            !file
                .get(actual)
                .is_some_and(|actual| text::equal(value, actual))
        }) {
            return false;
        }
    }
    if let Some(signer) = &wanted.signer {
        return application_metadata::verified_signer(&item.path)
            .is_some_and(|actual| text::equal(signer, &actual));
    }
    let distinctive = ![
        "app.exe",
        "update.exe",
        "launcher.exe",
        "main.exe",
        "setup.exe",
        "client.exe",
    ]
    .iter()
    .any(|name| text::equal(name, &wanted.name));
    let exact_hint = wanted.relative_path.as_ref().is_some_and(|relative| {
        roots.iter().any(|root| {
            text::equal(
                &root.join(relative).to_string_lossy().replace('/', "\\"),
                &item.path.to_string_lossy().replace('/', "\\"),
            )
        })
    });
    (wanted.product.is_some() && (wanted.company.is_some() || wanted.original_name.is_some()))
        || exact_hint
        || (item.registered && distinctive)
}

pub fn detect(
    owner: &str,
    descriptors: BTreeMap<String, Executable>,
) -> Result<BTreeMap<String, Detection>> {
    if descriptors.len() > 256 || descriptors.values().any(|app| !app.valid()) {
        return Err(Error::invalid("Invalid portable executable descriptors."));
    }
    if descriptors.is_empty() {
        return Ok(BTreeMap::new());
    }
    let locations = Locations::for_owner(owner);
    let roots = locations.hint_roots();
    let products = descriptors
        .values()
        .filter_map(|app| app.product.as_ref().map(|name| name.to_lowercase()))
        .collect::<BTreeSet<_>>();
    let installed = installed_roots(
        owner,
        &locations,
        &products,
        Instant::now() + Duration::from_secs(3),
    );
    let mut paths = BTreeMap::<String, Candidates>::new();
    for app in descriptors.values() {
        let name = app.name.to_lowercase();
        let paths = paths.entry(name.clone()).or_default();
        for (root, prefix) in [
            (HKEY_LOCAL_MACHINE, String::new()),
            (HKEY_USERS, format!("{owner}\\")),
        ] {
            for view in VIEWS {
                if let Some(path) = registry(
                    root,
                    &format!("{prefix}{APP_PATHS}\\{}", app.name),
                    "",
                    view | RRF_NOEXPAND,
                )
                .and_then(|path| locations.path(&path))
                {
                    candidate(paths, path, &name, true);
                }
            }
        }
        if let Some(relative) = &app.relative_path {
            for root in &roots {
                candidate(paths, root.join(relative), &name, false);
            }
        }
        if let Some(installations) = app
            .product
            .as_ref()
            .and_then(|product| installed.get(&product.to_lowercase()))
        {
            for root in installations {
                candidate(paths, root.join(&name), &name, true);
            }
        }
    }
    if let Ok(running) = ProcessSnapshot::default().read(false) {
        for process in running {
            let name = process.name.to_lowercase();
            if let (Some(paths), Some(path)) = (paths.get_mut(&name), process.path) {
                if process.exited.is_none() && crate::timezone::owns_process(process.key, owner) {
                    candidate(paths, path.into(), &name, false);
                }
            }
        }
    }
    let complete = scan(
        locations
            .program_roots()
            .into_iter()
            .chain(installed.into_values().flatten()),
        &mut paths,
        Instant::now() + Duration::from_secs(12),
        20000,
    );
    let verification_deadline = Instant::now() + Duration::from_secs(8);
    Ok(descriptors
        .into_iter()
        .map(|(id, app)| {
            let items = &paths[&app.name.to_lowercase()];
            let mut accepted = Vec::new();
            let candidates: Vec<_> = items
                .values()
                .map(|item| item.path.to_string_lossy().into_owned())
                .collect();
            let mut verified = 0;
            for (item, path) in items.values().zip(&candidates) {
                if Instant::now() >= verification_deadline {
                    break;
                }
                if matches(&app, item, &roots) {
                    accepted.push(path.clone());
                }
                verified += 1;
            }
            // A timeout cannot turn a partially verified list into a unique match.
            let path = (verified == items.len()
                && accepted.len() == 1
                && items.len() < 24
                && (complete
                    || candidates.len() == 1 && items.values().any(|item| item.registered)))
            .then(|| accepted.remove(0));
            (
                id,
                Detection {
                    path,
                    candidates: if verified != items.len() || accepted.is_empty() {
                        candidates
                    } else {
                        accepted
                    },
                },
            )
        })
        .collect())
}
