//! Fixed Windows proxy backends. No caller-supplied executable, registry key or value name.
use crate::native::{os_error, spawn_owned, wide};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Read,
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    ptr,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::{GlobalFree, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
    Networking::WinHttp::*,
    System::Registry::*,
};

pub const ENV_NAMES: [&str; 5] = [
    "http_proxy",
    "https_proxy",
    "ftp_proxy",
    "all_proxy",
    "no_proxy",
];
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    Wininet,
    EnvUser,
    EnvMachine,
    WinhttpLegacy,
    WinhttpMachine,
    WinhttpUser,
}
impl Channel {
    pub fn user(self) -> bool {
        matches!(self, Self::EnvUser | Self::WinhttpUser)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegValue {
    pub kind: u32,
    pub hex: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum NativeValue {
    Environment {
        values: BTreeMap<String, Option<RegValue>>,
    },
    Winhttp {
        access: u32,
        proxy: String,
        bypass: String,
    },
    Advanced {
        settings: Advanced,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Advanced {
    #[serde(rename = "Proxy")]
    pub proxy: String,
    #[serde(rename = "ProxyBypass")]
    pub bypass: String,
    #[serde(rename = "AutoconfigUrl")]
    pub pac: String,
    #[serde(rename = "AutoDetect")]
    pub auto: bool,
    // Policy metadata from show advproxy participates in ownership/version checks,
    // but must never be passed to set advproxy as an editable setting.
    #[serde(
        rename = "PerUserProxySettings",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub per_user: Option<bool>,
}
impl Advanced {
    pub fn writable(&self) -> Value {
        json!({"Proxy":self.proxy,"ProxyBypass":self.bypass,
            "AutoconfigUrl":self.pac,"AutoDetect":self.auto})
    }
}
// Windows' show schema differs from the four-field set schema. Inactive strings
// may be omitted or cached. Flags determine active settings; never replay a
// cached endpoint as an enabled proxy/PAC during restoration.
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
struct AdvancedReadback {
    proxy_is_enabled: bool,
    #[serde(default)]
    proxy: String,
    #[serde(default)]
    proxy_bypass: String,
    auto_config_is_enabled: bool,
    #[serde(rename = "AutoconfigUrl", default)]
    pac: String,
    auto_detect: bool,
    per_user_proxy_settings: bool,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum AdvancedOutput {
    Settings(Advanced),
    Readback(AdvancedReadback),
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(text: &str) -> Result<Vec<u8>> {
    if text.len() > 4096 || !text.len().is_multiple_of(2) || !text.is_ascii() {
        return Err(ApiError::new(
            "STATE_INTEGRITY",
            "Invalid environment snapshot.",
        ));
    }
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| {
            u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16)
                .map_err(|_| ApiError::new("STATE_INTEGRITY", "Invalid environment snapshot."))
        })
        .collect()
}
pub fn reg_text(value: &str) -> RegValue {
    RegValue {
        kind: REG_SZ,
        hex: hex(&wide(value)
            .iter()
            .flat_map(|c| c.to_le_bytes())
            .collect::<Vec<_>>()),
    }
}
pub fn display(value: &RegValue) -> String {
    let bytes = unhex(&value.hex).unwrap_or_default();
    let chars: Vec<_> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .take_while(|c| *c != 0)
        .collect();
    String::from_utf16_lossy(&chars)
}
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn environment_key(machine: bool, write: bool) -> Result<Key> {
    let (root, path) = if machine {
        (
            HKEY_LOCAL_MACHINE,
            "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        )
    } else {
        (HKEY_CURRENT_USER, "Environment")
    };
    let mut key = ptr::null_mut();
    let code = unsafe {
        RegOpenKeyExW(
            root,
            wide(path).as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY | if write { KEY_SET_VALUE } else { 0 },
            &mut key,
        )
    };
    if code != 0 {
        return Err(ApiError::io(
            "Open proxy environment",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    Ok(Key(key))
}
fn env_query(machine: bool) -> Result<NativeValue> {
    let key = environment_key(machine, false)?;
    let mut values = BTreeMap::new();
    for name in ENV_NAMES {
        let mut bytes = 0;
        let mut kind = 0;
        let code = unsafe {
            RegQueryValueExW(
                key.0,
                wide(name).as_ptr(),
                ptr::null(),
                &mut kind,
                ptr::null_mut(),
                &mut bytes,
            )
        };
        if code == ERROR_FILE_NOT_FOUND {
            values.insert(name.into(), None);
            continue;
        }
        if code != ERROR_SUCCESS {
            return Err(ApiError::io(
                "Read proxy environment",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        if bytes > 2048 || ![REG_SZ, REG_EXPAND_SZ].contains(&kind) {
            return Err(ApiError::new(
                "SETTINGS_TOO_LARGE",
                "A proxy environment value is oversized or has an unsupported registry type; it was left unchanged.",
            ));
        }
        let mut data = vec![0; bytes as usize];
        let code = unsafe {
            RegQueryValueExW(
                key.0,
                wide(name).as_ptr(),
                ptr::null(),
                &mut kind,
                data.as_mut_ptr(),
                &mut bytes,
            )
        };
        if code != 0 || bytes as usize > data.len() {
            return Err(ApiError::new(
                "SETTINGS_CONFLICT",
                "Environment changed while reading; refresh.",
            ));
        }
        data.truncate(bytes as usize);
        values.insert(
            name.into(),
            Some(RegValue {
                kind,
                hex: hex(&data),
            }),
        );
    }
    Ok(NativeValue::Environment { values })
}
fn env_write(machine: bool, values: &BTreeMap<String, Option<RegValue>>) -> Result<()> {
    if values.len() != ENV_NAMES.len() || values.keys().any(|n| !ENV_NAMES.contains(&n.as_str())) {
        return Err(ApiError::new(
            "INVALID_PARAMS",
            "Only the five proxy environment variables can be changed.",
        ));
    }
    // Validate all entries before the first registry mutation.
    let mut bytes = BTreeMap::new();
    for (name, value) in values {
        if let Some(v) = value {
            if ![REG_SZ, REG_EXPAND_SZ].contains(&v.kind) {
                return Err(ApiError::new(
                    "STATE_INTEGRITY",
                    "Unsupported environment snapshot type.",
                ));
            }
            bytes.insert(name.clone(), unhex(&v.hex)?);
        }
    }
    let key = environment_key(machine, true)?;
    for (name, value) in values {
        let code = unsafe {
            match value {
                Some(v) => RegSetValueExW(
                    key.0,
                    wide(name).as_ptr(),
                    0,
                    v.kind,
                    bytes[name].as_ptr(),
                    bytes[name].len() as u32,
                ),
                None => RegDeleteValueW(key.0, wide(name).as_ptr()),
            }
        };
        if code != 0 && !(value.is_none() && code == ERROR_FILE_NOT_FOUND) {
            return Err(ApiError::io(
                "Change proxy environment",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
    }
    Ok(())
}
unsafe fn take_string(value: *mut u16) -> String {
    if value.is_null() {
        return String::new();
    }
    let mut length = 0;
    while *value.add(length) != 0 && length < 32768 {
        length += 1;
    }
    let text = String::from_utf16_lossy(std::slice::from_raw_parts(value, length));
    GlobalFree(value.cast());
    text
}
fn classic_query() -> Result<NativeValue> {
    unsafe {
        let mut info: WINHTTP_PROXY_INFO = std::mem::zeroed();
        if WinHttpGetDefaultProxyConfiguration(&mut info) == 0 {
            return Err(os_error("Read WinHTTP proxy"));
        }
        Ok(NativeValue::Winhttp {
            access: info.dwAccessType,
            proxy: take_string(info.lpszProxy),
            bypass: take_string(info.lpszProxyBypass),
        })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetshOutput {
    command: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_encoding: String,
    stderr_encoding: String,
    stdout_hex_prefix: String,
}
fn decode_output(bytes: &[u8]) -> (String, String) {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let chars = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>();
        return (String::from_utf16_lossy(&chars), "UTF-16LE".into());
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.trim_start_matches('\u{feff}').into(), "UTF-8".into());
    }
    // Redirected netsh output on localized Windows commonly uses the OEM code page.
    let page = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
    let count = unsafe {
        windows_sys::Win32::Globalization::MultiByteToWideChar(
            page,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            ptr::null_mut(),
            0,
        )
    };
    if count > 0 {
        let mut chars = vec![0u16; count as usize];
        let written = unsafe {
            windows_sys::Win32::Globalization::MultiByteToWideChar(
                page,
                0,
                bytes.as_ptr(),
                bytes.len() as i32,
                chars.as_mut_ptr(),
                count,
            )
        };
        if written == count {
            return (String::from_utf16_lossy(&chars), format!("OEM {page}"));
        }
    }
    (
        String::from_utf8_lossy(bytes).into(),
        "Unknown (replacement characters)".into(),
    )
}
fn netsh_output(args: &[String]) -> Result<NetshOutput> {
    let path = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "C:\\Windows".into())
        .join("System32/netsh.exe");
    let mut child = Command::new(path)
        .args(["winhttp"])
        .args(args)
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ApiError::io("Run Windows WinHTTP command", e))?;
    let read = |input: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = input.take(65537).read_to_end(&mut bytes);
            (bytes, result)
        })
    };
    let stdout = read(Box::new(child.stdout.take().unwrap()));
    let stderr = read(Box::new(child.stderr.take().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(6);
    let code = loop {
        if let Some(code) = child
            .try_wait()
            .map_err(|e| ApiError::io("Observe WinHTTP command", e))?
        {
            break code;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(ApiError::new(
                "TIMEOUT",
                "Windows WinHTTP command timed out.",
            ));
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    let collect =
        |reader: std::thread::JoinHandle<(Vec<u8>, std::io::Result<usize>)>| -> Result<Vec<u8>> {
            let (bytes, result) = reader
                .join()
                .map_err(|_| ApiError::new("SETTINGS_ERROR", "WinHTTP output reader failed."))?;
            result.map_err(|e| ApiError::io("Read WinHTTP command", e))?;
            if bytes.len() > 65536 {
                return Err(ApiError::new(
                    "SETTINGS_TOO_LARGE",
                    "Windows WinHTTP output exceeded its limit.",
                ));
            }
            Ok(bytes)
        };
    let stdout_bytes = collect(stdout)?;
    let stderr_bytes = collect(stderr)?;
    let (stdout, stdout_encoding) = decode_output(&stdout_bytes);
    let (stderr, stderr_encoding) = decode_output(&stderr_bytes);
    Ok(NetshOutput {
        command: format!("netsh winhttp {}", args.join(" ")),
        exit_code: code.code(),
        stdout,
        stderr,
        stdout_encoding,
        stderr_encoding,
        stdout_hex_prefix: hex(&stdout_bytes[..stdout_bytes.len().min(1024)]),
    })
}
fn netsh(args: &[String]) -> Result<String> {
    let output = netsh_output(args)?;
    if output.exit_code != Some(0) {
        return Err(ApiError::new(
            "ADVPROXY_UNAVAILABLE",
            "Advanced WinHTTP settings are unavailable or cannot be read/changed on this Windows installation.",
        ));
    }
    Ok(output.stdout)
}
pub fn diagnose(channel: Channel) -> Result<Value> {
    if !matches!(
        channel,
        Channel::WinhttpLegacy | Channel::WinhttpMachine | Channel::WinhttpUser
    ) {
        return Err(ApiError::new(
            "INVALID_PARAMS",
            "Diagnostics accepts only a WinHTTP scope.",
        ));
    }
    let scope = if channel == Channel::WinhttpUser {
        "user"
    } else {
        "machine"
    };
    let advanced = netsh_output(&[
        "show".into(),
        "advproxy".into(),
        format!("setting-scope={scope}"),
    ]);
    let parse_error = advanced
        .as_ref()
        .ok()
        .filter(|o| o.exit_code == Some(0))
        .and_then(|o| parse_advanced(&o.stdout).err());
    let classic = netsh_output(&["show".into(), "proxy".into()]);
    let (legacy, legacy_error) = match classic_query() {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    // Fixed read-only commands only. Returned on demand to the authorized owner;
    // raw settings never enter events, service logs or persistent diagnostics.
    let (advanced, advanced_error) = match advanced {
        Ok(v) => (Some(v), None),
        Err(e) => (None, Some(e)),
    };
    let (classic, classic_error) = match classic {
        Ok(v) => (Some(v), None),
        Err(e) => (None, Some(e)),
    };
    Ok(
        json!({"channel":channel,"advanced":advanced,"advancedError":advanced_error,
        "parseError":parse_error,"classic":classic,"classicError":classic_error,
        "legacy":legacy,"legacyError":legacy_error}),
    )
}

pub fn parse_advanced(text: &str) -> Result<Advanced> {
    let start = text.find('{').ok_or_else(|| {
        ApiError::new(
            "SETTINGS_FORMAT",
            "Windows did not provide an advanced proxy snapshot.",
        )
    })?;
    let end = text.rfind('}').filter(|end| *end >= start).ok_or_else(|| {
        ApiError::new(
            "SETTINGS_FORMAT",
            "Windows returned an incomplete advanced proxy snapshot; settings were left unchanged.",
        )
    })? + 1;
    let invalid = || {
        ApiError::new(
            "SETTINGS_FORMAT",
            "Windows returned an unfamiliar advanced proxy format; settings were left unchanged.",
        )
    };
    match serde_json::from_str::<AdvancedOutput>(&text[start..end]).map_err(|_| invalid())? {
        AdvancedOutput::Settings(mut settings) => {
            if settings.proxy.is_empty() {
                settings.bypass.clear();
            }
            Ok(settings)
        }
        AdvancedOutput::Readback(mut snapshot) => {
            if (snapshot.proxy_is_enabled && snapshot.proxy.is_empty())
                || (snapshot.auto_config_is_enabled && snapshot.pac.is_empty())
            {
                return Err(invalid());
            }
            if !snapshot.proxy_is_enabled {
                snapshot.proxy.clear();
                snapshot.proxy_bypass.clear();
            }
            if !snapshot.auto_config_is_enabled {
                snapshot.pac.clear();
            }
            Ok(Advanced {
                proxy: snapshot.proxy,
                bypass: snapshot.proxy_bypass,
                pac: snapshot.pac,
                auto: snapshot.auto_detect,
                per_user: Some(snapshot.per_user_proxy_settings),
            })
        }
    }
}
fn advanced_query(user: bool) -> Result<NativeValue> {
    let output = netsh(&[
        "show".into(),
        "advproxy".into(),
        format!("setting-scope={}", if user { "user" } else { "machine" }),
    ])?;
    Ok(NativeValue::Advanced {
        settings: parse_advanced(&output)?,
    })
}
pub fn query(channel: Channel) -> Result<NativeValue> {
    match channel {
        Channel::EnvUser => env_query(false),
        Channel::EnvMachine => env_query(true),
        Channel::WinhttpLegacy => classic_query(),
        Channel::WinhttpMachine => advanced_query(false),
        Channel::WinhttpUser => advanced_query(true),
        Channel::Wininet => Err(ApiError::new(
            "INVALID_PARAMS",
            "WinINet uses the owner settings helper.",
        )),
    }
}
pub fn write(channel: Channel, value: &NativeValue) -> Result<()> {
    match (channel, value) {
        (Channel::EnvUser, NativeValue::Environment { values }) => env_write(false, values),
        (Channel::EnvMachine, NativeValue::Environment { values }) => env_write(true, values),
        (
            Channel::WinhttpLegacy,
            NativeValue::Winhttp {
                access,
                proxy,
                bypass,
            },
        ) => unsafe {
            let mut p = wide(proxy);
            let mut b = wide(bypass);
            let mut info = WINHTTP_PROXY_INFO {
                dwAccessType: *access,
                lpszProxy: if proxy.is_empty() {
                    ptr::null_mut()
                } else {
                    p.as_mut_ptr()
                },
                lpszProxyBypass: if bypass.is_empty() {
                    ptr::null_mut()
                } else {
                    b.as_mut_ptr()
                },
            };
            if WinHttpSetDefaultProxyConfiguration(&mut info) == 0 {
                Err(os_error("Set WinHTTP proxy"))
            } else {
                Ok(())
            }
        },
        (Channel::WinhttpMachine | Channel::WinhttpUser, NativeValue::Advanced { settings }) => {
            let encoded = serde_json::to_string(&settings.writable()).unwrap();
            netsh(&[
                "set".into(),
                "advproxy".into(),
                format!(
                    "setting-scope={}",
                    if channel == Channel::WinhttpUser {
                        "user"
                    } else {
                        "machine"
                    }
                ),
                format!("settings={encoded}"),
            ])
            .map(|_| ())
        }
        _ => Err(ApiError::new(
            "STATE_INTEGRITY",
            "Proxy snapshot does not match its scope.",
        )),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Helper {
    channel: Channel,
    operation: String,
    #[serde(default)]
    value: Option<NativeValue>,
}
pub fn user_helper() -> Result<Value> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|e| ApiError::io("Read user settings request", e))?;
    if bytes.len() > 65536 {
        return Err(ApiError::new(
            "INVALID_PARAMS",
            "Settings helper input exceeded its limit.",
        ));
    }
    let request: Helper = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::new("INVALID_PARAMS", "Invalid user settings request."))?;
    if !request.channel.user() {
        return Err(ApiError::new(
            "INVALID_PARAMS",
            "Owner helper accepts only user settings.",
        ));
    }
    if request.operation == "diagnose" && request.value.is_none() {
        return diagnose(request.channel);
    }
    if request.operation == "set" {
        write(
            request.channel,
            &request
                .value
                .ok_or_else(|| ApiError::new("INVALID_PARAMS", "Missing user settings."))?,
        )?;
    } else if request.operation != "get" {
        return Err(ApiError::new(
            "INVALID_PARAMS",
            "Invalid user settings operation.",
        ));
    }
    serde_json::to_value(query(request.channel)?)
        .map_err(|e| ApiError::io("Encode user settings", e))
}
fn owner_request(
    exe: &Path,
    owner: &str,
    channel: Channel,
    value: Option<&NativeValue>,
    operation: &str,
) -> Result<Value> {
    let process = spawn_owned(
        exe,
        owner,
        &json!({"channel":channel,"operation":operation,"value":value}),
        "--system-settings-helper",
        None,
        0,
    )?;
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(code) = process.exit_code()? {
            for _ in 0..30 {
                let output = process.lines.lock().unwrap().join("");
                if code == 0 {
                    if let Ok(value) = serde_json::from_str(&output) {
                        return Ok(value);
                    }
                } else if let Ok(error) = serde_json::from_str::<ApiError>(&output) {
                    return Err(error);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            return Err(ApiError::new(
                "SETTINGS_ERROR",
                "Owner settings helper did not return a valid result.",
            ));
        }
        if Instant::now() > until {
            return Err(ApiError::new("TIMEOUT", "Owner settings helper timed out."));
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}
pub fn owner_call(
    exe: &Path,
    owner: &str,
    channel: Channel,
    value: Option<&NativeValue>,
) -> Result<NativeValue> {
    serde_json::from_value(owner_request(
        exe,
        owner,
        channel,
        value,
        if value.is_some() { "set" } else { "get" },
    )?)
    .map_err(|_| ApiError::new("SETTINGS_ERROR", "Invalid owner settings snapshot."))
}
pub fn owner_diagnose(exe: &Path, owner: &str, channel: Channel) -> Result<Value> {
    owner_request(exe, owner, channel, None, "diagnose")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn environment_round_trip_preserves_unicode_and_type() {
        let value = reg_text("http://127.0.0.1:2080,тест");
        assert_eq!(value.kind, REG_SZ);
        assert_eq!(display(&value), "http://127.0.0.1:2080,тест");
    }
    #[test]
    fn validates_advanced_snapshot_independent_of_headers() {
        let value=parse_advanced("Localized header\n{\"Proxy\":\"http=127.0.0.1:2080;https=127.0.0.1:2080\",\"ProxyBypass\":\"<local>\",\"AutoconfigUrl\":\"\",\"AutoDetect\":false}\n").unwrap();
        assert!(!value.auto);
        assert!(value.proxy.contains("https="));
    }
    #[test]
    fn unfamiliar_advanced_output_is_not_guessed() {
        assert!(parse_advanced("Proxy: DIRECT").is_err());
        assert!(parse_advanced("{incomplete").is_err());
        assert!(parse_advanced("} out of order {").is_err());
        assert!(parse_advanced("{\"Proxy\":\"\",\"extra\":1}").is_err());
    }
    #[test]
    fn corrupt_registry_snapshot_cannot_be_replayed() {
        for v in ["x", "gg", "\0\0"] {
            assert!(unhex(v).is_err());
        }
    }

    #[test]
    fn diagnostics_rejects_other_scopes_without_running_commands() {
        for channel in [Channel::Wininet, Channel::EnvUser, Channel::EnvMachine] {
            assert_eq!(diagnose(channel).unwrap_err().code, "INVALID_PARAMS");
        }
    }
    #[test]
    fn command_output_decodes_utf8_and_utf16_without_losing_json() {
        let text = "{\"Proxy\":\"тест\"}";
        assert_eq!(decode_output(text.as_bytes()).0, text);
        let bytes = [
            vec![0xff, 0xfe],
            text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        ]
        .concat();
        assert_eq!(decode_output(&bytes).0, text);
    }

    #[test]
    fn windows11_autodetect_only_readback_is_supported() {
        // Exact stdout supplied by the user, including the localized header.
        let snapshot =
            parse_advanced(include_str!("../fixtures/winhttp-windows11-autodetect.txt")).unwrap();
        assert_eq!(
            snapshot.writable(),
            json!({"Proxy":"","ProxyBypass":"","AutoconfigUrl":"","AutoDetect":true})
        );
        assert_eq!(snapshot.per_user, Some(true));
    }
    #[test]
    fn windows11_disabled_cached_readback_is_direct_and_safe_to_restore() {
        let settings = parse_advanced(include_str!(
            "../fixtures/winhttp-windows11-disabled-cached.txt"
        ))
        .unwrap();
        assert_eq!(
            settings.writable(),
            json!({"Proxy":"","ProxyBypass":"","AutoconfigUrl":"","AutoDetect":false})
        );
        assert_eq!(settings.per_user, Some(false));
    }
    #[test]
    fn windows11_flags_select_active_endpoints_independently_of_cached_strings() {
        for proxy_enabled in [false, true] {
            for pac_enabled in [false, true] {
                for auto in [false, true] {
                    let raw = json!({"ProxyIsEnabled":proxy_enabled,"Proxy":"proxy.example:8080","ProxyBypass":"<local>","AutoConfigIsEnabled":pac_enabled,"AutoconfigUrl":"https://example.org/proxy.pac","AutoDetect":auto,"PerUserProxySettings":true});
                    let settings = parse_advanced(&raw.to_string()).unwrap();
                    assert_eq!(
                        settings.writable(),
                        json!({"Proxy":if proxy_enabled {"proxy.example:8080"} else {""},"ProxyBypass":if proxy_enabled {"<local>"} else {""},"AutoconfigUrl":if pac_enabled {"https://example.org/proxy.pac"} else {""},"AutoDetect":auto})
                    );
                    assert_eq!(settings.per_user, Some(true));
                }
            }
        }
    }
    #[test]
    fn windows11_manual_and_pac_readbacks_preserve_active_settings() {
        for (proxy, bypass, pac, auto, per_user) in [
            (
                "http=proxy.example:8080;https=proxy.example:8443",
                "<local>;*.example",
                "",
                true,
                true,
            ),
            ("", "", "https://example.org/proxy.pac", false, false),
            (
                "proxy.example:8080",
                "",
                "https://example.org/proxy.pac",
                true,
                false,
            ),
        ] {
            let mut output = json!({"ProxyIsEnabled":!proxy.is_empty(),"AutoConfigIsEnabled":!pac.is_empty(),"AutoDetect":auto,"PerUserProxySettings":per_user});
            if !proxy.is_empty() {
                output["Proxy"] = proxy.into();
            }
            if !bypass.is_empty() {
                output["ProxyBypass"] = bypass.into();
            }
            if !pac.is_empty() {
                output["AutoconfigUrl"] = pac.into();
            }
            let snapshot = parse_advanced(&output.to_string()).unwrap();
            assert_eq!(
                snapshot.writable(),
                json!({"Proxy":proxy,"ProxyBypass":bypass,"AutoconfigUrl":pac,"AutoDetect":auto})
            );
            assert_eq!(snapshot.per_user, Some(per_user));
        }
    }
    #[test]
    fn malformed_or_unknown_readback_cannot_be_used_as_a_baseline() {
        for output in [
            json!({"ProxyIsEnabled":true,"AutoConfigIsEnabled":false,"AutoDetect":true,"PerUserProxySettings":true}),
            json!({"ProxyIsEnabled":false,"AutoConfigIsEnabled":true,"AutoDetect":false,"PerUserProxySettings":true}),
            json!({"ProxyIsEnabled":false,"AutoConfigIsEnabled":false,"AutoDetect":"true","PerUserProxySettings":true}),
            json!({"ProxyIsEnabled":false,"AutoConfigIsEnabled":false,"AutoDetect":true,"PerUserProxySettings":"true"}),
            json!({"ProxyIsEnabled":false,"AutoConfigIsEnabled":false,"AutoDetect":true,"PerUserProxySettings":true,"UnknownPolicy":true}),
            json!({"ProxyIsEnabled":false,"AutoDetect":true,"PerUserProxySettings":true}),
        ] {
            assert_eq!(
                parse_advanced(&output.to_string()).unwrap_err().code,
                "SETTINGS_FORMAT",
                "{output}"
            );
        }
    }
    #[test]
    fn native_snapshot_preserves_policy_but_write_payload_excludes_readback_flags() {
        let settings =
            parse_advanced(include_str!("../fixtures/winhttp-windows11-autodetect.txt")).unwrap();
        let before = NativeValue::Advanced {
            settings: settings.clone(),
        };
        let encoded = serde_json::to_value(&before).unwrap();
        assert_eq!(encoded["settings"]["PerUserProxySettings"], true);
        assert_eq!(
            serde_json::from_value::<NativeValue>(encoded).unwrap(),
            before
        );
        let writable = settings.writable();
        assert_eq!(writable.as_object().unwrap().len(), 4);
        assert!(writable.get("PerUserProxySettings").is_none());
        assert!(writable.get("ProxyIsEnabled").is_none());
        assert!(writable.get("AutoConfigIsEnabled").is_none());
    }
    #[test]
    fn russian_user_scope_can_be_off_while_legacy_machine_proxy_is_active() {
        let user = parse_advanced(r#"Дополнительные параметры прокси-сервера WinHTTP:
        {"ProxyIsEnabled":false,"AutoConfigIsEnabled":false,"AutoDetect":false,"PerUserProxySettings":true}"#).unwrap();
        assert!(user.proxy.is_empty() && user.pac.is_empty() && !user.auto);
        assert_eq!(user.per_user, Some(true));
        let legacy = NativeValue::Winhttp {
            access: WINHTTP_ACCESS_TYPE_NAMED_PROXY,
            proxy: "http=127.0.0.1:10808;https=127.0.0.1:10808".into(),
            bypass: "localhost;127.*;10.*".into(),
        };
        assert_ne!(
            serde_json::to_value(&legacy).unwrap(),
            serde_json::to_value(NativeValue::Advanced { settings: user }).unwrap()
        );
        assert!(!Channel::WinhttpLegacy.user());
        assert_eq!(
            serde_json::to_string(&Channel::WinhttpLegacy).unwrap(),
            "\"winhttpLegacy\""
        );
    }
}
