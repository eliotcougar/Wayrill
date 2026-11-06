use crate::remote::{RemoteError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::ERROR_SUCCESS,
    Globalization::{MultiByteToWideChar, CP_ACP},
    Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    },
    System::{
        Environment::ExpandEnvironmentStringsW,
        Registry::{
            RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
            HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_SZ,
        },
    },
    UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, OFN_DONTADDTORECENT, OFN_EXPLORER,
        OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    },
};

const REGISTRY: &str = "Software\\Martin Prikryl\\WinSCP 2\\Sessions";
const MAX_INI: u64 = 16 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: String,
    pub port: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub sessions: Vec<SavedSession>,
    pub executable: Option<String>,
    pub executable_version: Option<String>,
    pub compatibility_error: Option<String>,
    pub source: String,
    pub selected_config: String,
    pub configs: Vec<String>,
    pub windows_user: String,
    pub warnings: Vec<String>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    executable: Option<PathBuf>,
    ini: Option<PathBuf>,
}
#[derive(Clone, PartialEq, Eq)]
pub struct Connection {
    pub name: String,
    pub executable: PathBuf,
    pub ini: Option<PathBuf>,
    pub host: String,
    pub user: String,
    pub port: u32,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn file_version(path: &Path) -> Option<[u16; 4]> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: terminated path and an owned buffer sized by the version API.
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
    if size == 0 || size > 1024 * 1024 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let mut info = std::ptr::null_mut();
    let mut len = 0;
    // SAFETY: the populated version buffer stays alive through the query.
    let found = unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            wide("\\").as_ptr(),
            &mut info,
            &mut len,
        )
    };
    if found == 0 || info.is_null() {
        return None;
    }
    // VerQueryValue returns a view into data. Resolve it back to our owned
    // bytes so parsing never dereferences a foreign pointer.
    let offset = (info as usize).checked_sub(data.as_ptr() as usize)?;
    fixed_version(data.get(offset..)?.get(..len as usize)?)
}
fn fixed_version(data: &[u8]) -> Option<[u16; 4]> {
    let data = data.get(..std::mem::size_of::<VS_FIXEDFILEINFO>())?;
    let dword = |offset| {
        Some(u32::from_le_bytes(
            data.get(offset..offset + 4)?.try_into().ok()?,
        ))
    };
    if dword(std::mem::offset_of!(VS_FIXEDFILEINFO, dwSignature))? != 0xfeef04bd {
        return None;
    }
    let ms = dword(std::mem::offset_of!(VS_FIXEDFILEINFO, dwFileVersionMS))?;
    let ls = dword(std::mem::offset_of!(VS_FIXEDFILEINFO, dwFileVersionLS))?;
    Some([(ms >> 16) as u16, ms as u16, (ls >> 16) as u16, ls as u16])
}
fn version_text(version: [u16; 4]) -> String {
    format!(
        "{}.{}.{}.{}",
        version[0], version[1], version[2], version[3]
    )
}
fn compatibility_error(version: Option<[u16; 4]>) -> Option<String> {
    match version {
        Some(version) if version >= [5, 18, 0, 0] => None,
        Some(version) => Some(format!(
            "WinSCP {} cannot stream configuration files. Update WinSCP to the current release (5.18 or newer is required), then refresh detection or select the updated executable. Your saved sessions can still be listed.",
            version_text(version)
        )),
        None => Some("Cannot determine this WinSCP executable's version. Select an official WinSCP 5.18 or newer executable.".into()),
    }
}
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn open_key(parent: HKEY, name: &str) -> Result<Key> {
    let mut key = std::ptr::null_mut();
    let status = unsafe { RegOpenKeyExW(parent, wide(name).as_ptr(), 0, KEY_READ, &mut key) };
    if status != ERROR_SUCCESS {
        return Err(RemoteError::new("WINSCP_SESSIONS", "Cannot read saved WinSCP sessions for this Windows user. Open WinSCP and save an SSH session first."));
    }
    Ok(Key(key))
}
fn value(key: &Key, name: &str) -> Option<String> {
    let mut bytes = 0;
    let mut kind = 0;
    let name = wide(name);
    unsafe {
        if RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut bytes,
        ) != ERROR_SUCCESS
            || (kind != REG_SZ && kind != REG_EXPAND_SZ)
            || bytes > 65536
            || !bytes.is_multiple_of(2)
        {
            return None;
        }
        let mut buffer = vec![0u16; (bytes as usize / 2) + 1];
        if RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let end = buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len());
        String::from_utf16(&buffer[..end])
            .ok()
            .map(|s| decode_registry(&s))
    }
}
fn dword(key: &Key, name: &str) -> Option<u32> {
    let mut number = 0u32;
    let mut kind = 0;
    let mut size = 4;
    let result = unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            std::ptr::null(),
            &mut kind,
            (&mut number as *mut u32).cast(),
            &mut size,
        )
    };
    (result == ERROR_SUCCESS && kind == 4 && size == 4).then_some(number)
}
fn decode_registry(input: &str) -> String {
    let raw = input.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(hex) = std::str::from_utf8(&raw[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    bytes.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else if bytes.is_ascii() || !input.is_ascii() {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        ansi(&bytes)
    }
}

fn ansi(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let mut output = vec![0u16; bytes.len() * 2];
    let count = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            output.as_mut_ptr(),
            output.len() as i32,
        )
    };
    if count > 0 {
        String::from_utf16_lossy(&output[..count as usize])
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}
fn preference_path() -> Result<PathBuf> {
    crate::app_data::path("winscp.json").ok_or_else(|| {
        RemoteError::new(
            "WINSCP_SETUP",
            "Windows did not provide a local user folder.",
        )
    })
}
fn preferences() -> Result<Preferences> {
    let path = crate::app_data::readable("winscp.json").ok_or_else(|| {
        RemoteError::new(
            "WINSCP_SETUP",
            "Windows did not provide a local user folder.",
        )
    })?;
    if !path.exists() {
        return Ok(Preferences::default());
    }
    let bytes = std::fs::read(path).map_err(|_| {
        RemoteError::new(
            "WINSCP_SETUP",
            "Cannot read the saved WinSCP location. Use Reset detection.",
        )
    })?;
    if bytes.len() > 65536 {
        return Err(RemoteError::new(
            "WINSCP_SETUP",
            "Saved WinSCP locations are invalid. Use Reset detection.",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        RemoteError::new(
            "WINSCP_SETUP",
            "Saved WinSCP locations are invalid. Use Reset detection.",
        )
    })
}
fn save(preferences: &Preferences) -> Result<()> {
    let path = preference_path()?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| {
        RemoteError::new(
            "WINSCP_SETUP",
            "Cannot save WinSCP locations in the user folder.",
        )
    })?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(preferences).unwrap())
        .and_then(|_| std::fs::rename(temporary, path))
        .map_err(|_| {
            RemoteError::new(
                "WINSCP_SETUP",
                "Cannot save WinSCP locations in the user folder.",
            )
        })
}
fn expand(path: &str) -> PathBuf {
    let text = wide(path.trim_matches('"'));
    let mut result = vec![0u16; 32768];
    let len = unsafe {
        ExpandEnvironmentStringsW(text.as_ptr(), result.as_mut_ptr(), result.len() as u32)
    };
    if len > 0 && len <= result.len() as u32 {
        PathBuf::from(String::from_utf16_lossy(&result[..len as usize - 1]))
    } else {
        PathBuf::from(path)
    }
}
fn executable(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    if !name.eq_ignore_ascii_case("WinSCP.exe") && !name.eq_ignore_ascii_case("WinSCP.com") {
        return None;
    }
    let parent = path.parent()?;
    let exe = parent.join("WinSCP.exe");
    exe.is_file().then_some(exe)
}
fn app_path(hive: HKEY) -> Option<PathBuf> {
    let key = open_key(
        hive,
        "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WinSCP.exe",
    )
    .ok()?;
    value(&key, "").map(|path| expand(&path))
}
fn detect_executable(preferences: &Preferences) -> Option<PathBuf> {
    if let Some(explicit) = &preferences.executable {
        return executable(explicit);
    }
    let mut paths = Vec::new();
    for (variable, suffix) in [
        ("LOCALAPPDATA", "Programs/WinSCP/WinSCP.exe"),
        ("LOCALAPPDATA", "WinSCP/WinSCP.exe"),
        ("USERPROFILE", "WinSCP/WinSCP.exe"),
    ] {
        if let Some(root) = std::env::var_os(variable) {
            paths.push(PathBuf::from(root).join(suffix));
        }
    }
    paths.extend(app_path(HKEY_CURRENT_USER));
    paths.extend(app_path(HKEY_LOCAL_MACHINE));
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(root) = std::env::var_os(variable) {
            paths.push(PathBuf::from(root).join("WinSCP/WinSCP.exe"));
        }
    }
    paths.iter().find_map(|path| executable(path))
}

pub fn console_helper(executable: &Path) -> Result<PathBuf> {
    let sibling = executable.with_extension("com");
    if sibling.is_file() {
        return Ok(sibling);
    }
    Err(RemoteError::new(
        "WINSCP_HELPER",
        "WinSCP.com is missing beside the selected WinSCP.exe. Install WinSCP or extract both executables from its portable package, then refresh detection.",
    ))
}
fn ini_candidates(executable: Option<&Path>, preferences: &Preferences) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = &preferences.ini {
        paths.push(path.clone());
    }
    if let Ok(key) = open_key(
        HKEY_CURRENT_USER,
        "Software\\Martin Prikryl\\WinSCP 2 Override",
    ) {
        if let Some(path) = value(&key, "IniFile").filter(|s| !s.is_empty()) {
            paths.push(expand(&path));
        }
    }
    if let Some(executable) = executable {
        paths.push(executable.with_extension("ini"));
    }
    for (variable, suffix) in [
        ("APPDATA", "WinSCP.ini"),
        ("APPDATA", "WinSCP/WinSCP.ini"),
        ("USERPROFILE", "WinSCP/WinSCP.ini"),
        ("LOCALAPPDATA", "Programs/WinSCP/WinSCP.ini"),
        ("LOCALAPPDATA", "WinSCP/WinSCP.ini"),
    ] {
        if let Some(root) = std::env::var_os(variable) {
            paths.push(PathBuf::from(root).join(suffix));
        }
    }
    // Store installations can redirect Roaming into their package's user cache.
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        if let Ok(entries) = std::fs::read_dir(PathBuf::from(root).join("Packages")) {
            for entry in entries
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .to_ascii_lowercase()
                        .contains("winscp")
                })
                .take(16)
            {
                paths.push(entry.path().join("LocalCache/Roaming/WinSCP.ini"));
            }
        }
    }
    let mut found = Vec::new();
    for path in paths.into_iter().filter(|p| p.is_file()) {
        if !found.iter().any(|p: &PathBuf| {
            p.to_string_lossy()
                .eq_ignore_ascii_case(&path.to_string_lossy())
        }) {
            found.push(path);
        }
    }
    found
}
fn ini_text(bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_INI as usize {
        return Err(RemoteError::new(
            "WINSCP_INI",
            "The WinSCP INI exceeds 16 MiB.",
        ));
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return Err(RemoteError::new(
                "WINSCP_INI",
                "The WinSCP INI has an incomplete UTF-16 character.",
            ));
        }
        let be = bytes[0] == 0xfe;
        let chars: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| {
                if be {
                    u16::from_be_bytes([c[0], c[1]])
                } else {
                    u16::from_le_bytes([c[0], c[1]])
                }
            })
            .collect();
        return String::from_utf16(&chars).map_err(|_| {
            RemoteError::new("WINSCP_INI", "The WinSCP INI has invalid UTF-16 text.")
        });
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.trim_start_matches('\u{feff}').to_owned()),
        Err(_) => Ok(ansi(bytes)),
    }
}
#[derive(Default)]
struct Site {
    name: String,
    host: Option<String>,
    user: Option<String>,
    port: Option<u32>,
    protocol: Option<u32>,
    workspace: bool,
}
fn parse_ini(bytes: &[u8]) -> Result<Vec<Site>> {
    let text = ini_text(bytes)?;
    let mut sections: BTreeMap<String, Site> = BTreeMap::new();
    let mut section = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with([';', '#']) || line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = None;
            let header = &line[1..line.len() - 1];
            if header
                .get(..9)
                .is_some_and(|p| p.eq_ignore_ascii_case("Sessions\\"))
            {
                if sections.len() >= 4096 {
                    return Err(RemoteError::new(
                        "WINSCP_INI",
                        "The WinSCP INI has more than 4,096 sites.",
                    ));
                }
                let name = decode_registry(&header[9..]);
                if sections.contains_key(&name.to_lowercase()) {
                    return Err(RemoteError::new(
                        "WINSCP_INI",
                        "The WinSCP INI contains duplicate session sections.",
                    ));
                }
                section = Some(name.to_lowercase());
                sections.insert(
                    name.to_lowercase(),
                    Site {
                        name,
                        ..Site::default()
                    },
                );
            }
        } else if let (Some(key), Some((field, value))) = (&section, line.split_once('=')) {
            let site = sections.get_mut(key).unwrap();
            match field.trim().to_ascii_lowercase().as_str() {
                "hostname" => site.host = Some(decode_registry(value)),
                "username" => site.user = Some(decode_registry(value)),
                "portnumber" => site.port = value.trim().parse().ok(),
                "fsprotocol" => site.protocol = value.trim().parse().ok(),
                "isworkspace" => site.workspace = value.trim() == "1",
                _ => (),
            }
        }
    }
    Ok(sections.into_values().collect())
}
fn registry_sites() -> Result<Vec<Site>> {
    let root = open_key(HKEY_CURRENT_USER, REGISTRY)?;
    let mut sites = Vec::new();
    for index in 0..4096 {
        let mut name = vec![0u16; 1024];
        let mut len = name.len() as u32;
        let result = unsafe {
            RegEnumKeyExW(
                root.0,
                index,
                name.as_mut_ptr(),
                &mut len,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result == 259 {
            break;
        }
        if result != ERROR_SUCCESS {
            continue;
        }
        let raw = String::from_utf16_lossy(&name[..len as usize]);
        let key = open_key(root.0, &raw)?;
        sites.push(Site {
            name: decode_registry(&raw),
            host: value(&key, "HostName"),
            user: value(&key, "UserName"),
            port: dword(&key, "PortNumber"),
            protocol: dword(&key, "FSProtocol"),
            workspace: dword(&key, "IsWorkspace") == Some(1),
        });
    }
    Ok(sites)
}
fn sessions_from(sites: Vec<Site>, source: &str, executable: Option<&Path>) -> Vec<SavedSession> {
    let default = sites
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case("Default Settings"));
    let mut sessions = Vec::new();
    for site in &sites {
        let host = site
            .host
            .as_ref()
            .or_else(|| default.and_then(|d| d.host.as_ref()))
            .filter(|s| !s.is_empty());
        if site.name.eq_ignore_ascii_case("Default Settings")
            || site.workspace
            || host.is_none()
            || site
                .protocol
                .or_else(|| default.and_then(|d| d.protocol))
                .unwrap_or(0)
                > 2
        {
            continue;
        }
        let host = host.unwrap().clone();
        let user = site
            .user
            .clone()
            .or_else(|| default.and_then(|d| d.user.clone()))
            .unwrap_or_default();
        let port = site
            .port
            .or_else(|| default.and_then(|d| d.port))
            .unwrap_or(22);
        let identity = format!(
            "{}\0{source}\0{}\0{host}\0{user}\0{port}",
            executable.map_or(String::new(), |p| p.display().to_string()),
            site.name
        );
        sessions.push(SavedSession {
            id: hex::encode(Sha256::digest(identity.as_bytes())),
            name: site.name.clone(),
            host,
            user,
            port,
        });
    }
    sessions.sort_by_key(|s| s.name.to_lowercase());
    sessions
}
fn inspect(preferences: &Preferences) -> Result<Inventory> {
    let executable = detect_executable(preferences);
    let configs = ini_candidates(executable.as_deref(), preferences);
    let ini = if let Some(explicit) = &preferences.ini {
        if !explicit.is_file() {
            return Err(RemoteError::new(
                "WINSCP_INI",
                "The selected WinSCP INI is missing. Choose another file or Reset detection.",
            ));
        }
        Some(explicit.clone())
    } else {
        configs.first().cloned()
    };
    let source = ini
        .as_ref()
        .map_or("Windows registry · current user".into(), |p| {
            p.display().to_string()
        });
    let mut warnings = Vec::new();
    if executable.is_none() {
        warnings.push(
            "WinSCP was not found. Use Locate WinSCP to select WinSCP.exe or WinSCP.com.".into(),
        );
    }
    let sites = if let Some(ini) = &ini {
        let file = std::fs::File::open(ini)
            .map_err(|_| RemoteError::new("WINSCP_INI", "Cannot read the selected WinSCP INI."))?;
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(MAX_INI + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| RemoteError::new("WINSCP_INI", "Cannot read the selected WinSCP INI."))?;
        parse_ini(&bytes)?
    } else {
        match registry_sites() {
            Ok(sites) => sites,
            Err(_) => {
                warnings.push("No WinSCP session registry was found for this Windows user. Choose its INI file if WinSCP is portable.".into());
                Vec::new()
            }
        }
    };
    let sessions = sessions_from(sites, &source, executable.as_deref());
    if sessions.is_empty() {
        warnings.push("No saved SSH sessions were found in this source. Use the same Windows account as WinSCP, or choose its INI file.".into());
    }
    let version = executable.as_deref().and_then(file_version);
    let compatibility_error = executable.as_deref().and_then(|path| {
        console_helper(path)
            .err()
            .map(|error| error.message)
            .or_else(|| compatibility_error(version))
    });
    Ok(Inventory {
        sessions,
        executable: executable.map(|p| p.display().to_string()),
        executable_version: version.map(version_text),
        compatibility_error,
        source,
        selected_config: preferences
            .ini
            .as_ref()
            .map_or("auto".into(), |p| p.display().to_string()),
        configs: configs.iter().map(|p| p.display().to_string()).collect(),
        windows_user: format!(
            "{}\\{}",
            std::env::var("USERDOMAIN").unwrap_or_default(),
            std::env::var("USERNAME").unwrap_or_default()
        ),
        warnings,
    })
}
pub fn inventory() -> Result<Inventory> {
    inspect(&preferences()?)
}
pub fn resolve(id: &str) -> Result<Connection> {
    let inventory = inventory()?;
    if let Some(message) = inventory.compatibility_error {
        return Err(RemoteError::new("WINSCP_SETUP", message));
    }
    let session = inventory
        .sessions
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| {
            RemoteError::new(
                "SESSION",
                "The session source or details changed. Refresh the session list.",
            )
        })?;
    if session.name.is_empty()
        || session.name.chars().any(char::is_control)
        || session.name.contains('"')
        || session.name.starts_with('-')
    {
        return Err(RemoteError::new(
            "SESSION",
            "This saved session name cannot be used in a WinSCP script.",
        ));
    }
    let executable = inventory
        .executable
        .ok_or_else(|| RemoteError::new("WINSCP_MISSING", "Locate WinSCP before connecting."))?;
    Ok(Connection {
        name: session.name,
        host: session.host,
        user: session.user,
        port: session.port,
        executable: PathBuf::from(executable),
        ini: if inventory.source == "Windows registry · current user" {
            None
        } else {
            Some(PathBuf::from(inventory.source))
        },
    })
}
pub fn set_config(config: &str) -> Result<Inventory> {
    let mut prefs = preferences()?;
    if config == "auto" {
        prefs.ini = None;
    } else {
        if !inventory()?.configs.iter().any(|c| c == config) {
            return Err(RemoteError::new(
                "WINSCP_SETUP",
                "Choose an existing WinSCP configuration source.",
            ));
        }
        prefs.ini = Some(PathBuf::from(config));
    }
    let result = inspect(&prefs)?;
    save(&prefs)?;
    Ok(result)
}
pub fn reset() -> Result<Inventory> {
    let prefs = Preferences::default();
    let result = inspect(&prefs)?;
    save(&prefs)?;
    Ok(result)
}
pub fn choose(kind: &str, owner: usize) -> Result<Option<Inventory>> {
    let (title, filter) = match kind {
        "executable" => (
            "Locate WinSCP",
            "WinSCP executable\0WinSCP.exe;WinSCP.com\0\0",
        ),
        "ini" => (
            "Choose WinSCP configuration",
            "WinSCP configuration\0*.ini\0\0",
        ),
        _ => {
            return Err(RemoteError::new(
                "WINSCP_SETUP",
                "Choose a WinSCP executable or INI file.",
            ))
        }
    };
    let mut filename = vec![0u16; 32768];
    let filter = wide(filter);
    let title = wide(title);
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of_val(&dialog) as u32;
    dialog.hwndOwner = owner as _;
    dialog.lpstrFile = filename.as_mut_ptr();
    dialog.nMaxFile = filename.len() as u32;
    dialog.lpstrTitle = title.as_ptr();
    dialog.lpstrFilter = filter.as_ptr();
    dialog.Flags = OFN_EXPLORER
        | OFN_FILEMUSTEXIST
        | OFN_PATHMUSTEXIST
        | OFN_NOCHANGEDIR
        | OFN_DONTADDTORECENT;
    if unsafe { GetOpenFileNameW(&mut dialog) } == 0 {
        if unsafe { CommDlgExtendedError() } != 0 {
            return Err(RemoteError::new(
                "WINSCP_SETUP",
                "The file picker could not be opened.",
            ));
        }
        return Ok(None);
    }
    let end = filename.iter().position(|v| *v == 0).unwrap();
    let path = PathBuf::from(String::from_utf16_lossy(&filename[..end]));
    let mut prefs = preferences()?;
    if kind == "executable" {
        prefs.executable = Some(executable(&path).ok_or_else(|| {
            RemoteError::new(
                "WINSCP_SETUP",
                "Select WinSCP.exe or WinSCP.com from a WinSCP installation containing both executables.",
            )
        })?);
    } else {
        prefs.ini = Some(path);
    }
    let result = inspect(&prefs)?;
    save(&prefs)?;
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_version_uses_bounded_bytes_without_alignment_assumptions() {
        let mut data = vec![0; 1 + std::mem::size_of::<VS_FIXEDFILEINFO>()];
        for (offset, value) in [
            (
                std::mem::offset_of!(VS_FIXEDFILEINFO, dwSignature),
                0xfeef04bdu32,
            ),
            (
                std::mem::offset_of!(VS_FIXEDFILEINFO, dwFileVersionMS),
                0x0006_0005,
            ),
            (
                std::mem::offset_of!(VS_FIXEDFILEINFO, dwFileVersionLS),
                0x0007_ffff,
            ),
        ] {
            data[1 + offset..1 + offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        let info = &data[1..];
        assert_eq!(fixed_version(info), Some([6, 5, 7, u16::MAX]));
        for size in 0..info.len() {
            assert_eq!(fixed_version(&info[..size]), None);
        }
        data[1] = 0;
        assert_eq!(fixed_version(&data[1..]), None);
    }
    #[test]
    fn streaming_requires_a_version_that_supports_it() {
        for version in [None, Some([5, 13, 9, 9343]), Some([5, 17, 10, 9999])] {
            assert!(compatibility_error(version).is_some());
        }
        for version in [[5, 18, 0, 0], [5, 19, 0, 0], [6, 7, 0, 0]] {
            assert!(compatibility_error(Some(version)).is_none());
        }
    }
    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "wayrill-winscp-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn uses_only_the_selected_installations_console_without_creating_files() {
        let folder = Folder::new();
        let user_install = folder.0.join("User folder/Сервер/WinSCP");
        std::fs::create_dir_all(&user_install).unwrap();
        let exe = user_install.join("WinSCP.exe");
        std::fs::write(&exe, b"test executable path").unwrap();
        let ini = user_install.join("WinSCP.ini");
        std::fs::write(&ini, b"[Sessions\\Example]\nHostName=example.org\n").unwrap();
        assert_eq!(executable(&exe), Some(exe.clone()));
        assert_eq!(
            executable(&user_install.join("WinSCP.com")),
            Some(exe.clone())
        );
        let prefs = Preferences {
            executable: Some(exe.clone()),
            ini: Some(ini),
        };
        let inventory = inspect(&prefs).unwrap();
        assert_eq!(inventory.executable, Some(exe.display().to_string()));
        assert_eq!(inventory.sessions.len(), 1);
        assert!(inventory
            .compatibility_error
            .unwrap()
            .contains("WinSCP.com"));
        assert_eq!(console_helper(&exe).unwrap_err().code, "WINSCP_HELPER");
        assert!(!user_install.join("WinSCP.com").exists());
        assert_eq!(std::fs::read_dir(&user_install).unwrap().count(), 2);
        let console = user_install.join("WinSCP.com");
        std::fs::write(&console, b"external console").unwrap();
        assert_eq!(console_helper(&exe).unwrap(), console);
        assert_eq!(std::fs::read(&console).unwrap(), b"external console");
        assert_eq!(std::fs::read(&exe).unwrap(), b"test executable path");
        assert!(executable(&folder.0.join("missing/WinSCP.exe")).is_none());
    }
    #[test]
    fn decodes_utf8_bom_marked_names_and_literal_percent_once() {
        assert_eq!(
            decode_registry("%EF%BB%BF%D0%A1%D0%B5%D1%80%D0%B2%D0%B5%D1%80"),
            "Сервер"
        );
        assert_eq!(decode_registry("folder%2FSite%20one"), "folder/Site one");
        assert_eq!(decode_registry("%2520"), "%20");
        assert_eq!(decode_registry("%🤦"), "%🤦");
    }
    #[test]
    fn reads_only_metadata_and_preserves_folder_names() {
        let sites=parse_ini(b"[Sessions\\Default%20Settings]\nPortNumber=2222\n[Sessions\\Folder%2FExample]\nHostName=example.org\nUserName=alice\nPassword=do-not-expose\n[Sessions\\FTP]\nHostName=ftp.example.org\nFSProtocol=5\n").unwrap();
        let sessions = sessions_from(sites, "test.ini", None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "Folder/Example");
        assert_eq!(sessions[0].port, 2222);
        assert!(!serde_json::to_string(&sessions)
            .unwrap()
            .contains("do-not-expose"));
    }
    #[test]
    fn utf16_files_and_unicode_names_work() {
        let text = "[Sessions\\Сервер]\nHostName=example.org\nUserName=пользователь\n";
        let bytes: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let sites = parse_ini(&bytes).unwrap();
        assert_eq!(sites[0].name, "Сервер");
        assert_eq!(sites[0].user.as_deref(), Some("пользователь"));
    }
    #[test]
    fn different_sources_do_not_share_session_ids() {
        let sites = || parse_ini(b"[Sessions\\Same]\nHostName=example.org\n").unwrap();
        assert_ne!(
            sessions_from(sites(), "one.ini", None)[0].id,
            sessions_from(sites(), "two.ini", None)[0].id
        );
    }
    #[test]
    fn duplicate_sessions_and_oversized_files_fail() {
        assert!(parse_ini(b"[Sessions\\Same]\nHostName=a\n[Sessions\\same]\nHostName=b").is_err());
        assert!(ini_text(&vec![b' '; MAX_INI as usize + 1]).is_err());
        assert!(ini_text(&[0xff, 0xfe, 1]).is_err());
    }
}
