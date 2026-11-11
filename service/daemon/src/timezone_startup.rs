//! Exact-image startup registrations, separate from saved timezone intent.
//! Foreign verifier/debugger settings are never overwritten.
use crate::native::wide;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    ptr,
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::{CommitTransaction, CreateTransaction},
    System::{
        Registry::*,
        SystemInformation::{
            GetSystemDirectoryW, GetSystemWow64DirectoryW, IMAGE_FILE_MACHINE_AMD64,
            IMAGE_FILE_MACHINE_I386, IMAGE_FILE_MACHINE_UNKNOWN,
        },
        Threading::{IsWow64Process2, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};
mod image;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Architecture {
    X64,
    X86,
}
impl Architecture {
    fn package_directory(self, root: &Path) -> PathBuf {
        match self {
            Self::X64 => root.join("timezone"),
            Self::X86 => root.join("timezone/x86"),
        }
    }

    fn system_directory(self) -> Result<PathBuf> {
        let mut path = [0; 260];
        let length = unsafe {
            match self {
                Self::X64 => GetSystemDirectoryW(path.as_mut_ptr(), path.len() as u32),
                Self::X86 => GetSystemWow64DirectoryW(path.as_mut_ptr(), path.len() as u32),
            }
        };
        if length == 0 || length as usize >= path.len() {
            return Err(crate::native::os_error("Find Windows system directory"));
        }
        Ok(String::from_utf16_lossy(&path[..length as usize]).into())
    }
}

fn unsupported_application() -> ApiError {
    ApiError::new(
        "TIMEZONE_APPLICATION",
        "Application timezone overrides support x86 and x64 applications on x64 Windows.",
    )
}

pub fn live_adapter(root: &Path, pid: u32) -> Result<PathBuf> {
    let process =
        crate::native::Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
    let mut machine = 0;
    let mut native = 0;
    if process.0.is_null() || unsafe { IsWow64Process2(process.0, &mut machine, &mut native) } == 0
    {
        return Err(crate::native::os_error("Read application architecture"));
    }
    let architecture = match (native, machine) {
        (IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_UNKNOWN) => Architecture::X64,
        (IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_I386) => Architecture::X86,
        _ => return Err(unsupported_application()),
    };
    Ok(architecture
        .package_directory(root)
        .join("wayrill-timezone.exe"))
}

#[derive(Clone, PartialEq, Eq)]
pub struct Target {
    pub path: String,
    pub package: Option<String>,
    pub node: bool,
}
pub fn detect(path: &str) -> Option<Target> {
    let node = image::node(Path::new(path));
    (node || required(path) || image::cached(Path::new(path))).then(|| Target {
        path: path.into(),
        package: None,
        node,
    })
}
fn registration(path: &str) -> String {
    // Unlike policy identity, an IFEO filter identifies one exact image path.
    let hash = Sha256::digest(path.replace('/', "\\").to_lowercase().as_bytes());
    let hex: String = hash.iter().map(|v| format!("{v:02x}")).collect();
    format!("{PREFIX}{hex}")
}

const IFEO: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options";
const PREFIX: &str = "WayrillTimezone-";
const USE_FILTER: &str = "WayrillTimezoneUseFilter";
const OWNER: &str = "WayrillTimezoneOwner";
const POLICY: &str = r"Software\Wayrill\ApplicationTimezones";

pub fn required(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .is_some_and(|v| v.eq_ignore_ascii_case("firefox.exe"))
}
struct Key(HKEY, HANDLE);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn check(code: u32) -> Result<()> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(ApiError::io(
            "Configure application startup timezone",
            std::io::Error::from_raw_os_error(code as i32),
        ))
    }
}
impl Key {
    fn open(root: HKEY, path: &str, create: bool, transaction: HANDLE) -> Result<Option<Self>> {
        Self::access(root, path, create, transaction, KEY_READ | KEY_WRITE)
    }
    fn read(root: HKEY, path: &str, transaction: HANDLE) -> Result<Option<Self>> {
        Self::access(root, path, false, transaction, KEY_READ)
    }
    fn access(
        root: HKEY,
        path: &str,
        create: bool,
        transaction: HANDLE,
        access: u32,
    ) -> Result<Option<Self>> {
        let mut key = ptr::null_mut();
        let access = access | KEY_WOW64_64KEY;
        let code = unsafe {
            if create {
                RegCreateKeyTransactedW(
                    root,
                    wide(path).as_ptr(),
                    0,
                    ptr::null(),
                    REG_OPTION_NON_VOLATILE,
                    access,
                    ptr::null(),
                    &mut key,
                    ptr::null_mut(),
                    transaction,
                    ptr::null(),
                )
            } else {
                RegOpenKeyTransactedW(
                    root,
                    wide(path).as_ptr(),
                    0,
                    access,
                    &mut key,
                    transaction,
                    ptr::null(),
                )
            }
        };
        if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND {
            return Ok(None);
        }
        check(code)?;
        Ok(Some(Self(key, transaction)))
    }
    fn get(&self, name: &str) -> Result<Option<(u32, Vec<u8>)>> {
        let mut data = vec![0; 4096];
        let mut size = data.len() as u32;
        let mut kind = 0;
        let code = unsafe {
            RegQueryValueExW(
                self.0,
                wide(name).as_ptr(),
                ptr::null(),
                &mut kind,
                data.as_mut_ptr(),
                &mut size,
            )
        };
        if code == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        check(code)?;
        data.truncate(size as usize);
        Ok(Some((kind, data)))
    }
    fn set(&self, name: &str, value: &(u32, Vec<u8>)) -> Result<()> {
        check(unsafe {
            RegSetValueExW(
                self.0,
                wide(name).as_ptr(),
                0,
                value.0,
                value.1.as_ptr(),
                value.1.len() as u32,
            )
        })
    }
    fn delete_value(&self, name: &str) -> Result<()> {
        let code = unsafe { RegDeleteValueW(self.0, wide(name).as_ptr()) };
        if code == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            check(code)
        }
    }
    fn children(&self) -> Result<Vec<String>> {
        let mut result = Vec::new();
        loop {
            let mut name = [0; 256];
            let mut size = name.len() as u32;
            let code = unsafe {
                RegEnumKeyExW(
                    self.0,
                    result.len() as u32,
                    name.as_mut_ptr(),
                    &mut size,
                    ptr::null(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if code == ERROR_NO_MORE_ITEMS {
                return Ok(result);
            }
            check(code)?;
            result.push(String::from_utf16_lossy(&name[..size as usize]));
        }
    }
    fn delete_child(&self, name: &str) -> Result<()> {
        // Registrations contain values only; never recursively remove foreign data.
        check(unsafe {
            RegDeleteKeyTransactedW(
                self.0,
                wide(name).as_ptr(),
                KEY_WOW64_64KEY,
                0,
                self.1,
                ptr::null(),
            )
        })
    }
    fn value_count(&self) -> Result<u32> {
        let mut count = 0;
        check(unsafe {
            RegQueryInfoKeyW(
                self.0,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut count,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        })?;
        Ok(count)
    }
}
struct Transaction(crate::native::Handle);
impl Transaction {
    fn new() -> Result<Self> {
        let handle = unsafe {
            CreateTransaction(
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                0,
                0,
                30000,
                wide("Wayrill application timezone").as_ptr(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(crate::native::os_error(
                "Begin application timezone transaction",
            ));
        }
        Ok(Self(crate::native::Handle(handle)))
    }
    fn commit(self) -> Result<()> {
        if unsafe { CommitTransaction(self.0 .0) } == 0 {
            Err(crate::native::os_error(
                "Commit application timezone transaction",
            ))
        } else {
            Ok(())
        }
    }
}
fn string(value: &str) -> (u32, Vec<u8>) {
    (
        REG_SZ,
        wide(value).iter().flat_map(|v| v.to_le_bytes()).collect(),
    )
}
fn dword(value: u32) -> (u32, Vec<u8>) {
    (REG_DWORD, value.to_le_bytes().to_vec())
}
fn text(value: Option<(u32, Vec<u8>)>) -> Option<String> {
    let (kind, bytes) = value?;
    if kind != REG_SZ || bytes.len() % 2 != 0 {
        return None;
    }
    let mut units: Vec<_> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|v| u16::from_le_bytes([v[0], v[1]]))
        .collect();
    if units.pop() != Some(0) || units.contains(&0) {
        return None;
    }
    String::from_utf16(&units).ok()
}
fn asset(name: &str) -> bool {
    name.strip_prefix("wayrill-timezone-")
        .and_then(|v| v.strip_suffix(".dll"))
        .is_some_and(|v| v.len() == 16 && v.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn conflict() -> ApiError {
    ApiError::new(
        "TIMEZONE_CONFLICT",
        "Application startup settings were changed outside Wayrill. They were left unchanged.",
    )
}
fn install_asset(root: &Path, architecture: Architecture) -> Result<String> {
    let directory = architecture.package_directory(root);
    let name = fs::read_to_string(directory.join("asset.txt"))
        .map_err(|e| ApiError::io("Read timezone component", e))?;
    let name = name.trim();
    if !asset(name) {
        return Err(ApiError::new(
            "TIMEZONE_ASSET",
            "Invalid native timezone asset.",
        ));
    }
    let bytes =
        fs::read(directory.join(name)).map_err(|e| ApiError::io("Read timezone component", e))?;
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect();
    if name != format!("wayrill-timezone-{}.dll", &hash[..16]) {
        return Err(ApiError::new(
            "TIMEZONE_ASSET",
            "Native timezone asset hash mismatch.",
        ));
    }
    let target = architecture.system_directory()?.join(name);
    if target.exists() {
        if fs::read(&target).map_err(|e| ApiError::io("Verify startup component", e))? != bytes {
            return Err(conflict());
        }
    } else {
        // System32 supplies a protected inherited ACL; immutable filenames keep
        // an upgrade from replacing a DLL mapped by a still-running browser.
        // Publish only a completely flushed image. A failed write or power loss
        // must not leave a truncated immutable DLL that blocks every retry.
        crate::storage::write_bytes(&target, &bytes)?;
    }
    Ok(name.into())
}
pub struct Resolved {
    key: String,
    data: Vec<u8>,
}
impl Resolved {
    pub fn from_reply(reply: &serde_json::Value) -> Result<Self> {
        let key = reply["windowsZone"]
            .as_str()
            .ok_or_else(conflict)?
            .to_owned();
        let data: Vec<u8> =
            serde_json::from_value(reply["nativeZone"].clone()).map_err(|_| conflict())?;
        if data.len()
            != std::mem::size_of::<windows_sys::Win32::System::Time::DYNAMIC_TIME_ZONE_INFORMATION>(
            )
        {
            return Err(conflict());
        }
        Ok(Self { key, data })
    }
}
fn owned(key: &Key, owner: &str, path: &str) -> Result<bool> {
    let extra = u32::from(key.get("WayrillTimezonePackage")?.is_some())
        + u32::from(key.get("WayrillTimezoneNode")?.is_some());
    Ok(key.get(OWNER)? == Some(string(owner))
        && key.get("FilterFullPath")? == Some(string(path))
        && key.get("GlobalFlag")? == Some(dword(256))
        && key.get("VerifierFlags")? == Some(dword(0))
        && text(key.get("VerifierDlls")?).is_some_and(|v| asset(&v))
        && key.children()?.is_empty()
        && key.value_count()? == 5 + extra)
}
pub fn configure(
    root: &Path,
    owner: &str,
    target: &Target,
    windows_zone: Option<&Resolved>,
    iana_zone: &str,
    revision: u64,
) -> Result<()> {
    let path = &target.path;
    let transaction = Transaction::new()?;
    let tx = transaction.0 .0;
    let id = wayrill_protocol::application_identity::key(path);
    let image = Path::new(path)
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(conflict)?;
    let name = registration(path);
    let policy_path = format!("{owner}\\{POLICY}\\{id}");
    let Some(image_key) = Key::open(
        HKEY_LOCAL_MACHINE,
        &format!("{IFEO}\\{image}"),
        windows_zone.is_some(),
        tx,
    )?
    else {
        return Ok(());
    };
    // Upgrade the older identity-named filter only when its exact image and
    // ownership match. Other installed versions have separate filters.
    let legacy = format!("{PREFIX}{id}");
    if let Some(key) = Key::open(image_key.0, &legacy, false, tx)? {
        if owned(&key, owner, path)? {
            drop(key);
            image_key.delete_child(&legacy)?;
        }
    }
    let existing = Key::open(image_key.0, &name, false, tx)?;
    if let Some(key) = &existing {
        if !owned(key, owner, path)? {
            return Err(conflict());
        }
    }
    if let Some(zone) = windows_zone {
        let architecture =
            image::architecture(Path::new(path)).ok_or_else(unsupported_application)?;
        let data = &zone.data;
        let zone = &zone.key;
        if zone.is_empty()
            || zone.len() > 127
            || zone.contains(['\\', '/', ':'])
            || zone.chars().any(char::is_control)
        {
            return Err(conflict());
        }
        if image_key.get("UseFilter")? != Some(dword(1)) {
            if image_key.get("UseFilter")?.is_some() {
                return Err(conflict());
            }
            for value in ["GlobalFlag", "VerifierFlags", "VerifierDlls", "Debugger"] {
                if image_key.get(value)?.is_some() {
                    return Err(conflict());
                }
            }
            image_key.set(USE_FILTER, &dword(1))?;
        }
        for sibling in image_key.children()? {
            if sibling != name {
                if let Some(other) = Key::open(image_key.0, &sibling, false, tx)? {
                    if text(other.get("FilterFullPath")?)
                        .is_some_and(|v| v.eq_ignore_ascii_case(path))
                    {
                        return Err(conflict());
                    }
                }
            }
        }
        let dll = install_asset(root, architecture)?;
        let policy = Key::open(HKEY_USERS, &policy_path, true, tx)?.ok_or_else(conflict)?;
        let iana = if target.node { iana_zone } else { "" };
        if iana.len() > 127 || iana.contains(':') || iana.chars().any(char::is_control) {
            return Err(conflict());
        }
        policy.set("Policy", &string(&format!("3:{revision}:{zone}:{iana}")))?;
        policy.set("Zone", &(REG_BINARY, data.clone()))?;
        let key = Key::open(image_key.0, &name, true, tx)?.ok_or_else(conflict)?;
        // One registry transaction publishes policy and registration together.
        // A crash or a concurrent external edit leaves the previous state intact.
        key.set(OWNER, &string(owner))?;
        key.set("FilterFullPath", &string(path))?;
        key.set("VerifierFlags", &dword(0))?;
        key.set("VerifierDlls", &string(&dll))?;
        key.set("GlobalFlag", &dword(256))?;
        key.set("WayrillTimezoneNode", &dword(u32::from(target.node)))?;
        if let Some(package) = &target.package {
            key.set("WayrillTimezonePackage", &string(package))?;
        } else {
            key.delete_value("WayrillTimezonePackage")?;
        }
        image_key.set("UseFilter", &dword(1))?;
    } else {
        if existing.is_some() {
            drop(existing);
            image_key.delete_child(&name)?;
        }
        let mut another_version = false;
        for sibling in image_key.children()? {
            if sibling.starts_with(PREFIX) {
                if let Some(key) = Key::open(image_key.0, &sibling, false, tx)? {
                    if text(key.get(OWNER)?).as_deref() == Some(owner)
                        && text(key.get("FilterFullPath")?)
                            .is_some_and(|p| wayrill_protocol::application_identity::key(&p) == id)
                    {
                        another_version = true;
                    }
                }
            }
        }
        if !another_version {
            if let Some(policy) = Key::open(HKEY_USERS, &policy_path, false, tx)? {
                policy.delete_value("Policy")?;
                policy.delete_value("Zone")?;
            }
        }
        if image_key.get(USE_FILTER)? == Some(dword(1)) && image_key.children()?.is_empty() {
            if image_key.get("UseFilter")? == Some(dword(1)) {
                image_key.delete_value("UseFilter")?;
            }
            image_key.delete_value(USE_FILTER)?;
        }
    }
    transaction.commit()
}

pub fn targets(owner_filter: Option<&str>) -> Result<Vec<(String, Target)>> {
    let mut registrations = Vec::new();
    let transaction = Transaction::new()?;
    if let Some(root) = Key::read(HKEY_LOCAL_MACHINE, IFEO, transaction.0 .0)? {
        for image in root.children()? {
            let image_key = Key::read(root.0, &image, transaction.0 .0)?.ok_or_else(conflict)?;
            for child in image_key
                .children()?
                .into_iter()
                .filter(|v| v.starts_with(PREFIX))
            {
                let key = Key::read(image_key.0, &child, transaction.0 .0)?.ok_or_else(conflict)?;
                let Some(owner) = text(key.get(OWNER)?) else {
                    continue;
                };
                if owner_filter.is_some_and(|v| v != owner) {
                    continue;
                }
                let path = text(key.get("FilterFullPath")?).ok_or_else(conflict)?;
                if !crate::valid_owner(&owner)
                    || (child != registration(&path)
                        && child
                            != format!(
                                "{PREFIX}{}",
                                wayrill_protocol::application_identity::key(&path)
                            ))
                {
                    return Err(conflict());
                }
                let target = Target {
                    path,
                    package: text(key.get("WayrillTimezonePackage")?),
                    node: key.get("WayrillTimezoneNode")? == Some(dword(1)),
                };
                // Keep externally edited registrations discoverable. Configure
                // checks ownership per target, so one conflict does not stop
                // reconciliation for every other application owned by the user.
                registrations.push((owner, target));
            }
        }
    }
    Ok(registrations)
}
pub fn uninstall() -> Result<()> {
    for (owner, target) in targets(None)? {
        configure(Path::new(""), &owner, &target, None, "", 0)?;
    }
    // A running app may still map an immutable component. Locked files stay
    // harmlessly in place; never schedule deletion that could break a reinstall.
    let installed = std::env::current_exe()
        .map_err(|e| ApiError::io("Find installed timezone component", e))?;
    let root = installed.parent().ok_or_else(conflict)?;
    for architecture in [Architecture::X64, Architecture::X86] {
        let files = match fs::read_dir(architecture.package_directory(root)) {
            Ok(files) => files,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(ApiError::io("Find startup components", error)),
        };
        let system = architecture.system_directory()?;
        for file in files {
            let file = file.map_err(|e| ApiError::io("Find startup component", e))?;
            if file.file_name().to_str().is_some_and(asset) {
                let target = system.join(file.file_name());
                if fs::read(file.path())
                    .ok()
                    .zip(fs::read(&target).ok())
                    .is_some_and(|(source, current)| source == current)
                {
                    let _ = fs::remove_file(target);
                }
            }
        }
    }
    Ok(())
}
