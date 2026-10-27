use crate::{
    native::{os_error, restrict_token, spawn_owned, spawn_with_token, token_sid, wide, Handle},
    storage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    ptr,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::{GlobalFree, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND},
    Networking::WinInet::*,
    Security::{
        TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_QUERY,
    },
    System::{
        Registry::*,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    #[default]
    User,
    Machine,
}
impl Scope {
    fn policy_value(self) -> u32 {
        match self {
            Self::User => 1,
            Self::Machine => 0,
        }
    }
    fn is_user(&self) -> bool {
        *self == Self::User
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxySettings {
    // Existing user-only leases and upgrade handoff versions already imply
    // user scope. Preserve their digest; machine snapshots carry an explicit scope.
    #[serde(default, skip_serializing_if = "Scope::is_user")]
    pub scope: Scope,
    pub flags: u32,
    pub server: String,
    pub bypass: String,
    pub auto_config_url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeChange {
    scope: Scope,
    expected_version: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Lease {
    before: ProxySettings,
    applied: ProxySettings,
    #[serde(default)]
    binding: Option<crate::system_settings::Request>,
}
fn owned_snapshot(
    lease: &Lease,
    scope: Scope,
    read: impl FnOnce() -> Result<ProxySettings>,
    deferred: &mut bool,
) -> Result<Option<ProxySettings>> {
    check_scope(scope, lease.applied.scope)?;
    let current = crate::system_settings::routing_read(scope == Scope::User, read(), deferred)?;
    if current
        .as_ref()
        .is_some_and(|current| *current != lease.applied)
    {
        return Err(ApiError::new("PROXY_CONFLICT", "External Windows proxy changes were preserved. Restore or keep external settings first."));
    }
    Ok(current)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperRequest {
    scope: Scope,
    operation: String,
    #[serde(default)]
    settings: Option<ProxySettings>,
}

/// A fresh contained process selects the policy's exact LAN store. User scope
/// runs as the restricted owner; machine scope runs as restricted LocalSystem.
pub fn helper() -> Result<Value> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|e| ApiError::io("Read settings helper", e))?;
    if bytes.len() > 16384 {
        return Err(ApiError::new(
            "INVALID_PARAMS",
            "Settings input is too large.",
        ));
    }
    let request: HelperRequest = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::new("INVALID_PARAMS", "Invalid settings helper request."))?;
    ensure_scope(request.scope)?;
    if request.scope == Scope::Machine {
        // Machine settings are never sent through the unprivileged owner helper.
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(os_error("Read proxy helper identity"));
        }
        let token = Handle(token);
        if token_sid(token.0)? != "S-1-5-18" {
            return Err(ApiError::new(
                "UNAUTHORIZED",
                "Machine proxy settings require the networking service.",
            ));
        }
    }
    if request.operation == "refresh" {
        unsafe {
            for option in [
                INTERNET_OPTION_SETTINGS_CHANGED,
                INTERNET_OPTION_REFRESH,
                INTERNET_OPTION_PROXY_SETTINGS_CHANGED,
            ] {
                InternetSetOptionW(ptr::null_mut(), option, ptr::null_mut(), 0);
            }
        }
    }
    if matches!(request.operation.as_str(), "get" | "refresh") {
        return serde_json::to_value(query(request.scope)?)
            .map_err(|e| ApiError::io("Encode settings", e));
    }
    if request.operation == "set" {
        let settings = request
            .settings
            .ok_or_else(|| ApiError::new("INVALID_PARAMS", "Missing proxy settings."))?;
        check_scope(request.scope, settings.scope)?;
        set(&settings)?;
        return serde_json::to_value(query(request.scope)?)
            .map_err(|e| ApiError::io("Encode settings", e));
    }
    Err(ApiError::new(
        "INVALID_PARAMS",
        "Unknown settings helper operation.",
    ))
}
unsafe fn string(pointer: *mut u16) -> String {
    if pointer.is_null() {
        return String::new();
    }
    let mut n = 0;
    while *pointer.add(n) != 0 {
        n += 1;
    }
    let value = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, n));
    GlobalFree(pointer.cast());
    value
}
// The active policy selects the store, but every snapshot and lease pins that
// scope. A policy change must never redirect recovery into a different store.
fn policy_scope(policy: Option<u32>) -> Result<Scope> {
    match policy {
        None | Some(1) => Ok(Scope::User),
        Some(0) => Ok(Scope::Machine),
        Some(_) => Err(ApiError::new(
            "PROXY_POLICY",
            "Windows returned an unfamiliar proxy scope policy; settings were left unchanged.",
        )),
    }
}
fn check_scope(actual: Scope, expected: Scope) -> Result<()> {
    if actual != expected {
        return Err(ApiError::new("PROXY_SCOPE_CHANGED", "Windows changed the proxy scope. Refresh the settings; the previous assignment remains tied to its original scope."));
    }
    Ok(())
}
const POLICY_PATH: &str =
    "SOFTWARE\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const POLICY_NAME: &str = "ProxySettingsPerUser";
fn read_policy() -> Result<Option<u32>> {
    let mut policy = 0u32;
    let mut bytes = std::mem::size_of_val(&policy) as u32;
    let code = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            wide(POLICY_PATH).as_ptr(),
            wide(POLICY_NAME).as_ptr(),
            RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
            ptr::null_mut(),
            (&mut policy as *mut u32).cast(),
            &mut bytes,
        )
    };
    if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND {
        return Ok(None);
    }
    if code != 0 {
        return Err(ApiError::io(
            "Read Windows proxy scope policy",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    Ok(Some(policy))
}
fn active_scope() -> Result<Scope> {
    policy_scope(read_policy()?)
}
struct PolicyKey(HKEY);
impl Drop for PolicyKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
// One fixed policy value, never a caller-supplied registry path. The policy is
// an explicit persistent Windows preference, separate from proxy setting leases.
fn replace_policy(expected: Option<u32>, next: Option<u32>) -> Result<()> {
    if read_policy()? != expected {
        return Err(ApiError::new(
            "SETTINGS_CONFLICT",
            "Windows proxy scope changed; refresh before switching.",
        ));
    }
    let mut key = ptr::null_mut();
    let code = unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(POLICY_PATH).as_ptr(),
            0,
            ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE | KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            ptr::null(),
            &mut key,
            ptr::null_mut(),
        )
    };
    if code != 0 {
        return Err(ApiError::io(
            "Open Windows proxy scope policy",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    let key = PolicyKey(key);
    if read_policy()? != expected {
        return Err(ApiError::new(
            "SETTINGS_CONFLICT",
            "Windows proxy scope changed; refresh before switching.",
        ));
    }
    let code = unsafe {
        match next {
            Some(value) => RegSetValueExW(
                key.0,
                wide(POLICY_NAME).as_ptr(),
                0,
                REG_DWORD,
                (&value as *const u32).cast(),
                std::mem::size_of_val(&value) as u32,
            ),
            None => RegDeleteValueW(key.0, wide(POLICY_NAME).as_ptr()),
        }
    };
    if code != 0 && !(next.is_none() && code == ERROR_FILE_NOT_FOUND) {
        return Err(ApiError::io(
            "Set Windows proxy scope",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    Ok(())
}
fn ensure_scope(expected: Scope) -> Result<()> {
    check_scope(active_scope()?, expected)
}
fn query(scope: Scope) -> Result<ProxySettings> {
    ensure_scope(scope)?;
    unsafe {
        let mut options: [INTERNET_PER_CONN_OPTIONW; 4] = std::mem::zeroed();
        for (i, id) in [
            // Read the configured UI flags; discovery results can differ.
            INTERNET_PER_CONN_FLAGS_UI,
            INTERNET_PER_CONN_PROXY_SERVER,
            INTERNET_PER_CONN_PROXY_BYPASS,
            INTERNET_PER_CONN_AUTOCONFIG_URL,
        ]
        .iter()
        .enumerate()
        {
            options[i].dwOption = *id;
        }
        let mut list = INTERNET_PER_CONN_OPTION_LISTW {
            dwSize: std::mem::size_of::<INTERNET_PER_CONN_OPTION_LISTW>() as u32,
            pszConnection: ptr::null_mut(),
            dwOptionCount: 4,
            dwOptionError: 0,
            pOptions: options.as_mut_ptr(),
        };
        let mut bytes = std::mem::size_of_val(&list) as u32;
        if InternetQueryOptionW(
            ptr::null_mut(),
            INTERNET_OPTION_PER_CONNECTION_OPTION,
            (&mut list as *mut INTERNET_PER_CONN_OPTION_LISTW).cast(),
            &mut bytes,
        ) == 0
        {
            return Err(os_error("Read Windows LAN proxy settings"));
        }
        let settings = ProxySettings {
            scope,
            flags: options[0].Value.dwValue,
            server: string(options[1].Value.pszValue),
            bypass: string(options[2].Value.pszValue),
            auto_config_url: string(options[3].Value.pszValue),
        };
        ensure_scope(scope)?;
        Ok(settings)
    }
}
fn set(settings: &ProxySettings) -> Result<()> {
    ensure_scope(settings.scope)?;
    // Preserve opaque/ASCII baselines; encode international URI text on the
    // native write boundary. WinINet returns its IDN host in Unicode afterward.
    let auto_config_url = if settings.auto_config_url.is_ascii() {
        settings.auto_config_url.clone()
    } else {
        url::Url::parse(&settings.auto_config_url)
            .map(|url| url.to_string())
            .unwrap_or_else(|_| settings.auto_config_url.clone())
    };
    unsafe {
        let mut server = wide(&settings.server);
        let mut bypass = wide(&settings.bypass);
        let mut auto = wide(&auto_config_url);
        let mut options: [INTERNET_PER_CONN_OPTIONW; 4] = std::mem::zeroed();
        for (i, id) in [
            INTERNET_PER_CONN_FLAGS,
            INTERNET_PER_CONN_PROXY_SERVER,
            INTERNET_PER_CONN_PROXY_BYPASS,
            INTERNET_PER_CONN_AUTOCONFIG_URL,
        ]
        .iter()
        .enumerate()
        {
            options[i].dwOption = *id;
        }
        options[0].Value.dwValue = settings.flags;
        options[1].Value.pszValue = server.as_mut_ptr();
        options[2].Value.pszValue = bypass.as_mut_ptr();
        options[3].Value.pszValue = auto.as_mut_ptr();
        let mut list = INTERNET_PER_CONN_OPTION_LISTW {
            dwSize: std::mem::size_of::<INTERNET_PER_CONN_OPTION_LISTW>() as u32,
            pszConnection: ptr::null_mut(),
            dwOptionCount: 4,
            dwOptionError: 0,
            pOptions: options.as_mut_ptr(),
        };
        if InternetSetOptionW(
            ptr::null_mut(),
            INTERNET_OPTION_PER_CONNECTION_OPTION,
            (&mut list as *mut INTERNET_PER_CONN_OPTION_LISTW).cast(),
            std::mem::size_of_val(&list) as u32,
        ) == 0
        {
            return Err(os_error("Set Windows LAN proxy settings"));
        }
        InternetSetOptionW(
            ptr::null_mut(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            ptr::null_mut(),
            0,
        );
        InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_REFRESH, ptr::null_mut(), 0);
        Ok(())
    }
}
fn run_helper(
    exe: &Path,
    owner: &str,
    operation: &str,
    settings: Option<&ProxySettings>,
) -> Result<ProxySettings> {
    let scope = settings.map_or_else(active_scope, |s| Ok(s.scope))?;
    ensure_scope(scope)?;
    let input = json!({"scope":scope,"operation":operation,"settings":settings});
    let process = match scope {
        Scope::User => spawn_owned(exe, owner, &input, "--proxy-helper", None, 0)?,
        Scope::Machine => {
            // Fixed self-executable/operation, privilege-stripped token, bounded
            // pipes, eight-second deadline and the existing one-process job.
            let mut token = ptr::null_mut();
            if unsafe {
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY
                        | TOKEN_DUPLICATE
                        | TOKEN_ASSIGN_PRIMARY
                        | TOKEN_ADJUST_DEFAULT
                        | TOKEN_ADJUST_SESSIONID,
                    &mut token,
                )
            } == 0
            {
                return Err(os_error("Obtain machine proxy helper token"));
            }
            let token = Handle(token);
            if token_sid(token.0)? != "S-1-5-18" {
                return Err(ApiError::new(
                    "UNAUTHORIZED",
                    "Machine proxy settings require the networking service.",
                ));
            }
            spawn_with_token(
                exe,
                restrict_token(token)?,
                &input,
                "--proxy-helper",
                None,
                0,
            )?
        }
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(code) = process.exit_code()? {
            // The pipe reader can finish after process exit, including errors.
            for _ in 0..30 {
                let output = process.lines.lock().unwrap().join("");
                if code == 0 {
                    if let Ok(settings) = serde_json::from_str(&output) {
                        return Ok(settings);
                    }
                } else if let Ok(error) = serde_json::from_str::<ApiError>(&output) {
                    return Err(error);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            return Err(ApiError::new(
                "PROXY_ERROR",
                "Settings helper did not return valid settings.",
            ));
        }
        if Instant::now() >= deadline {
            return Err(ApiError::new(
                "TIMEOUT",
                "Settings helper exceeded eight seconds.",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
pub struct ProxyManager {
    owner: String,
    exe: PathBuf,
    journal: PathBuf,
    pub extras: crate::system_settings::Manager,
    pub conflict: bool,
    pub recovery_pending: bool,
    user_deferred: bool,
}
impl ProxyManager {
    pub fn new(owner: &str, exe: PathBuf, data: &Path) -> Self {
        Self {
            owner: owner.into(),
            extras: crate::system_settings::Manager::new(owner, exe.clone(), data),
            exe,
            journal: data.join("proxy-lease.json"),
            conflict: false,
            recovery_pending: false,
            user_deferred: false,
        }
    }

    pub fn capture_status(&self) -> Result<Vec<Value>> {
        let lease = storage::read::<Lease>(&self.journal)?;
        let mut rows = vec![capture_row(self.current(), lease.as_ref())];
        rows.extend(self.extras.rows()?);
        Ok(rows)
    }
    pub fn switch_scope(&mut self, request: ScopeChange) -> Result<bool> {
        let current = self.current()?;
        if crate::system_settings::version(&current) != request.expected_version {
            return Err(ApiError::new(
                "SETTINGS_CONFLICT",
                "Windows proxy changed; refresh before switching scope.",
            ));
        }
        if current.scope == request.scope {
            return Ok(false);
        }
        let original_policy = read_policy()?;
        check_scope(policy_scope(original_policy)?, current.scope)?;
        let lease = storage::read::<Lease>(&self.journal)?;
        let recover_target = recovery_after_switch(&current, lease.as_ref(), request.scope)?;
        if !recover_target {
            self.restore()?;
        }
        let next_policy = Some(request.scope.policy_value());
        let mut written = false;
        let result = (|| {
            replace_policy(original_policy, next_policy)?;
            written = true;
            if read_policy()? != next_policy {
                return Err(ApiError::new(
                    "PROXY_POLICY",
                    "Windows changed the proxy scope again; refresh the settings.",
                ));
            }
            let actual = run_helper(&self.exe, &self.owner, "refresh", None)?;
            check_scope(actual.scope, request.scope)?;
            if recover_target {
                self.restore()?;
            }
            Ok(())
        })();
        if let Err(mut error) = result {
            if written {
                let rollback = (|| {
                    let actual = read_policy()?;
                    if actual == original_policy {
                        return Ok(());
                    }
                    replace_policy(next_policy, original_policy)?;
                    run_helper(&self.exe, &self.owner, "refresh", None)?;
                    Ok::<(), ApiError>(())
                })();
                if let Err(rollback) = rollback {
                    error
                        .message
                        .push_str(&format!(" Scope recovery: {}", rollback.message));
                }
            }
            if lease.is_some() && !recover_target {
                error
                    .message
                    .push_str(" The previous Wayrill proxy assignment was restored.");
            }
            return Err(error);
        }
        Ok(true)
    }
    pub fn requests(&self) -> Result<Vec<crate::system_settings::Request>> {
        let mut requests = self.extras.requests()?;
        if let Some(lease) = storage::read::<Lease>(&self.journal)? {
            if let Some(request) = lease.binding {
                requests.push(request);
            }
        }
        Ok(requests)
    }
    pub fn requested(
        request: &crate::system_settings::Request,
        config: &Value,
        plan: Option<&crate::capture::Plan>,
    ) -> Result<ProxySettings> {
        crate::system_settings::validate(request)?;
        let manual = request.mode == "proxy";
        Ok(ProxySettings {
            scope: Scope::User,
            flags: 1
                | if manual { 2 } else { 0 }
                | if request.pac_url.is_empty() { 0 } else { 4 }
                | if request.auto_detect { 8 } else { 0 },
            server: if manual {
                format!(
                    "127.0.0.1:{}",
                    crate::system_settings::port(config, plan, &request.input_tag, false)?
                )
            } else {
                String::new()
            },
            bypass: if manual {
                crate::system_settings::wininet_bypass(&request.bypass)?
            } else {
                String::new()
            },
            auto_config_url: crate::system_settings::wininet_pac(&request.pac_url)?,
        })
    }
    pub fn check_owned(&mut self) -> Result<()> {
        if let Some(lease) = storage::read::<Lease>(&self.journal)? {
            let mut deferred = self.user_deferred;
            let result = owned_snapshot(&lease, active_scope()?, || self.current(), &mut deferred);
            self.user_deferred = deferred;
            result?;
        }
        self.extras.check_owned()
    }
    pub fn preflight_requests(
        &mut self,
        requests: &[crate::system_settings::Request],
        config: &Value,
        plan: Option<&crate::capture::Plan>,
    ) -> Result<()> {
        self.check_owned()?;
        for request in requests {
            if request.channel == crate::system_native::Channel::Wininet {
                Self::requested(request, config, plan)?;
            } else {
                self.extras
                    .preflight(std::slice::from_ref(request), config, plan)?;
            }
        }
        Ok(())
    }
    pub fn set_capture(
        &mut self,
        request: crate::system_settings::Request,
        config: &Value,
        plan: Option<&crate::capture::Plan>,
    ) -> Result<()> {
        if request.channel != crate::system_native::Channel::Wininet {
            return self.extras.set(request, config, plan);
        }
        let current = self.current()?;
        if crate::system_settings::version(&current) != request.expected_version {
            return Err(ApiError::new(
                "SETTINGS_CONFLICT",
                "Windows proxy changed; refresh before applying.",
            ));
        }
        let previous = storage::read::<Lease>(&self.journal)?;
        if previous.as_ref().is_some_and(|l| current != l.applied) {
            return Err(ApiError::new(
                "PROXY_CONFLICT",
                "External Windows proxy changes were preserved. Restore or keep external settings first.",
            ));
        }
        let mut next = Self::requested(&request, config, plan)?;
        next.scope = current.scope;
        self.replace(current, next, previous, Some(request))
    }
    fn replace(
        &mut self,
        current: ProxySettings,
        next: ProxySettings,
        previous: Option<Lease>,
        binding: Option<crate::system_settings::Request>,
    ) -> Result<()> {
        if let Some(lease) = &previous {
            check_scope(current.scope, lease.applied.scope)?;
        }
        let before = previous
            .as_ref()
            .map(|l| l.before.clone())
            .unwrap_or_else(|| current.clone());
        if serde_json::to_vec(&before).unwrap().len() > 8192 {
            return Err(ApiError::new(
                "PROXY_SETTINGS_TOO_LARGE",
                "Existing proxy settings exceed the safe recovery limit.",
            ));
        }
        storage::write(
            &self.journal,
            &Lease {
                before,
                applied: next.clone(),
                binding,
            },
        )?;
        // Reconcile the binding journal without rewriting identical Windows
        // settings or broadcasting another change to proxy consumers.
        let applied = if current == next {
            Ok(current.clone())
        } else {
            run_helper(&self.exe, &self.owner, "set", Some(&next))
        };
        if crate::system_settings::recover_unstarted_user_write(
            next.scope == Scope::User,
            &applied,
            || {
                if let Some(lease) = &previous {
                    storage::write(&self.journal, lease)
                } else {
                    storage::remove(&self.journal)
                }
            },
        )? {
            self.user_deferred = true;
            return Err(applied.unwrap_err());
        }
        match applied {
            Ok(actual) if actual == next => {}
            result => {
                let rollback = self.current().and_then(|actual| {
                    if actual == current {
                        return Ok(());
                    }
                    if actual != next {
                        return Err(ApiError::new(
                            "PROXY_CONFLICT",
                            "External settings were preserved during rollback.",
                        ));
                    }
                    if run_helper(&self.exe, &self.owner, "set", Some(&current))? != current {
                        return Err(ApiError::new("PROXY_ERROR", "Rollback did not verify."));
                    }
                    Ok(())
                });
                if rollback.is_ok() {
                    if let Some(lease) = previous {
                        storage::write(&self.journal, &lease)?;
                    } else {
                        storage::remove(&self.journal)?;
                    }
                } else {
                    self.recovery_pending = true;
                }
                return Err(result.err().unwrap_or_else(|| {
                    ApiError::new(
                        "PROXY_ERROR",
                        "Windows did not retain the requested proxy settings.",
                    )
                }));
            }
        }
        self.conflict = false;
        self.recovery_pending = false;
        self.user_deferred = false;
        Ok(())
    }
    pub fn capture_action(
        &mut self,
        action: &crate::system_settings::Action,
        method: &str,
    ) -> Result<()> {
        if action.channel != crate::system_native::Channel::Wininet {
            return self.extras.action(action, method);
        }
        if crate::system_settings::version(&self.current()?) != action.expected_version {
            return Err(ApiError::new(
                "SETTINGS_CONFLICT",
                "Windows proxy changed; refresh before continuing.",
            ));
        }
        match method {
            "restore" => self.restore(),
            "keepExternal" => {
                let lease = storage::read::<Lease>(&self.journal)?
                    .ok_or_else(|| ApiError::new("INVALID_STATE", "No proxy journal exists."))?;
                if recovery_decision(&self.current()?, &lease.before, &lease.applied)
                    != Recovery::Conflict
                {
                    return Err(ApiError::new(
                        "INVALID_STATE",
                        "Only an external conflict can be acknowledged.",
                    ));
                }
                self.conflict = true;
                self.discard()
            }
            "clear" => {
                let current = self.current()?;
                let previous = storage::read::<Lease>(&self.journal)?;
                let next = ProxySettings {
                    scope: current.scope,
                    flags: 1,
                    server: String::new(),
                    bypass: String::new(),
                    auto_config_url: String::new(),
                };
                self.replace(current, next, previous, None)?;
                storage::remove(&self.journal)
            }
            _ => Err(ApiError::new(
                "INVALID_PARAMS",
                "Unknown traffic settings action.",
            )),
        }
    }
    pub fn restore_all(&mut self) -> Result<()> {
        let mut cleanup = crate::lifecycle::Cleanup::default();
        cleanup.record("Windows proxy restoration", self.restore());
        cleanup.record(
            "environment and WinHTTP restoration",
            self.extras.restore_all(),
        );
        cleanup.finish()
    }
    pub fn reapply(
        &mut self,
        requests: &[crate::system_settings::Request],
        config: &Value,
        plan: Option<&crate::capture::Plan>,
    ) -> Result<()> {
        for request in requests {
            if request.channel == crate::system_native::Channel::Wininet {
                let mut request = request.clone();
                let lease = storage::read::<Lease>(&self.journal)?;
                if let Some(lease) = &lease {
                    check_scope(active_scope()?, lease.applied.scope)?;
                }
                let user = lease.is_some_and(|l| l.applied.scope == Scope::User);
                let current = self.current();
                let Some(current) =
                    crate::system_settings::routing_read(user, current, &mut self.user_deferred)?
                else {
                    continue;
                };
                request.expected_version = crate::system_settings::version(&current);
                let result = self.set_capture(request, config, plan);
                crate::system_settings::routing_read(user, result, &mut self.user_deferred)?;
            } else {
                self.extras
                    .reapply(std::slice::from_ref(request), config, plan)?;
            }
        }
        Ok(())
    }

    pub(crate) fn user_deferred(&self) -> bool {
        self.user_deferred || self.extras.user_deferred
    }
    pub(crate) fn reconcile_user(
        &mut self,
        config: &Value,
        plan: Option<&crate::capture::Plan>,
    ) -> Result<()> {
        let own = (|| {
            if !self.user_deferred {
                return Ok(());
            }
            let Some(lease) = storage::read::<Lease>(&self.journal)? else {
                self.user_deferred = false;
                return Ok(());
            };
            let mut deferred = self.user_deferred;
            let current = owned_snapshot(&lease, active_scope()?, || self.current(), &mut deferred);
            self.user_deferred = deferred;
            let Some(current) = current? else {
                return Ok(());
            };
            if let Some(mut request) = lease.binding.clone() {
                request.expected_version = crate::system_settings::version(&current);
                self.set_capture(request, config, plan)?;
            }
            self.user_deferred = false;
            Ok(())
        })();
        let extra = self.extras.reconcile_user(config, plan);
        let mut cleanup = crate::lifecycle::Cleanup::default();
        cleanup.record("deferred Windows proxy", own);
        cleanup.record("deferred user settings", extra);
        cleanup.finish()
    }

    pub fn status(&self) -> Value {
        json!({"managed":self.journal.exists(),"conflict":self.conflict,"recoveryPending":self.recovery_pending,"waitingForUser":self.user_deferred})
    }
    pub fn current(&self) -> Result<ProxySettings> {
        run_helper(&self.exe, &self.owner, "get", None)
    }
    pub fn restore(&mut self) -> Result<()> {
        let result = self.restore_assignment();
        self.conflict = result
            .as_ref()
            .is_err_and(|error| error.code == "PROXY_CONFLICT");
        // Journal I/O, helper writes and readback can fail independently of the
        // initial query. Every incomplete non-conflicting recovery must retry.
        self.recovery_pending = result.is_err() && !self.conflict;
        if result.is_ok() {
            self.user_deferred = false;
        }
        result
    }
    fn restore_assignment(&self) -> Result<()> {
        let Some(lease) = storage::read::<Lease>(&self.journal)? else {
            return Ok(());
        };
        let current = self.current()?;
        match recovery_decision(&current, &lease.before, &lease.applied) {
            Recovery::AlreadyRestored => {}
            Recovery::Restore => {
                if run_helper(&self.exe, &self.owner, "set", Some(&lease.before))? != lease.before {
                    return Err(ApiError::new(
                        "PROXY_ERROR",
                        "Restored proxy settings did not match the baseline.",
                    ));
                }
            }
            Recovery::Conflict => {
                return Err(ApiError::new(
                    "PROXY_CONFLICT",
                    "Windows proxy settings or their scope changed. They were preserved. Restore the original scope or keep external settings to release the previous assignment.",
                ));
            }
        }
        storage::remove(&self.journal)
    }
    pub fn discard(&mut self) -> Result<()> {
        if !self.conflict {
            return Err(ApiError::new(
                "INVALID_STATE",
                "Only a conflicting lease may be acknowledged.",
            ));
        }
        storage::remove(&self.journal)?;
        self.conflict = false;
        self.recovery_pending = false;
        self.user_deferred = false;
        Ok(())
    }
}
// Recovery must happen while its original store is active. Switching back to
// an inactive lease's scope can recover it without copying settings between stores.
fn recovery_after_switch(
    current: &ProxySettings,
    lease: Option<&Lease>,
    target: Scope,
) -> Result<bool> {
    let Some(lease) = lease else {
        return Ok(false);
    };
    check_scope(lease.before.scope, lease.applied.scope)?;
    if lease.applied.scope == current.scope {
        if recovery_decision(current, &lease.before, &lease.applied) == Recovery::Conflict {
            return Err(ApiError::new("PROXY_CONFLICT", "External Windows proxy changes were preserved. Restore or keep external settings before switching scope."));
        }
        Ok(false)
    } else {
        check_scope(target, lease.applied.scope)?;
        Ok(true)
    }
}
fn capture_row(current: Result<ProxySettings>, lease: Option<&Lease>) -> Value {
    match current {
        Ok(current) => json!({"channel":"wininet","supported":true,"advancedSupported":true,
            "scope":current.scope,"scopeSwitchSupported":true,
            "scopeConflict":lease.is_some_and(|l| l.applied.scope != current.scope),
            "version":crate::system_settings::version(&current),"managed":lease.is_some(),
            "restoreVersion":lease.map(|l|crate::system_settings::version(&l.before)),
            "conflict":lease.is_some_and(|l|recovery_decision(&current,&l.before,&l.applied)==Recovery::Conflict),
            "values":{"enabled":current.flags&PROXY_TYPE_PROXY!=0,
                "server":if current.flags&PROXY_TYPE_PROXY!=0 {&current.server} else {""},
                "bypass":if current.flags&PROXY_TYPE_PROXY!=0 {&current.bypass} else {""},
                "pacUrl":if current.flags&PROXY_TYPE_AUTO_PROXY_URL!=0 {&current.auto_config_url} else {""},
                "autoDetect":current.flags&PROXY_TYPE_AUTO_DETECT!=0},
            "request":lease.filter(|l| l.applied.scope == current.scope).and_then(|l|l.binding.as_ref())}),
        Err(error) => {
            json!({"channel":"wininet","supported":false,"managed":lease.is_some(),"error":error})
        }
    }
}
#[derive(PartialEq, Debug)]
enum Recovery {
    AlreadyRestored,
    Restore,
    Conflict,
}
fn recovery_decision(
    current: &ProxySettings,
    before: &ProxySettings,
    applied: &ProxySettings,
) -> Recovery {
    if current == before {
        Recovery::AlreadyRestored
    } else if current == applied {
        Recovery::Restore
    } else {
        Recovery::Conflict
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locked_proxy_journal_remains_pending_until_recovery_can_complete() {
        use std::os::windows::fs::OpenOptionsExt;
        let data = std::env::temp_dir().join(format!(
            "wayrill-proxy-recovery-lock-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&data).unwrap();
        let mut manager = ProxyManager::new("owner", PathBuf::new(), &data);
        let lease = Lease {
            before: settings("original"),
            applied: settings("wayrill"),
            binding: None,
        };
        storage::write(&manager.journal, &lease).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&manager.journal)
            .unwrap();
        // The journal cannot be read, so the native helper must never run.
        // Startup must retain this recovery obligation for its next tick.
        assert!(manager.restore().is_err());
        assert!(manager.recovery_pending);
        assert!(!manager.conflict);
        drop(lock);
        assert!(storage::read::<Lease>(&manager.journal).unwrap().is_some());
        // Model a completed recovery observed after the lock is released.
        // No native Windows settings are used by this regression.
        storage::remove(&manager.journal).unwrap();
        manager.restore().unwrap();
        assert!(!manager.recovery_pending && !manager.conflict);
        std::fs::remove_dir(&data).unwrap();
    }
    #[test]
    fn deferred_user_proxy_keeps_scope_and_expected_value_proofs_after_sign_in() {
        let settings = ProxySettings {
            scope: Scope::User,
            flags: 3,
            server: "127.0.0.1:10808".into(),
            bypass: "localhost".into(),
            auto_config_url: String::new(),
        };
        let lease = Lease {
            before: settings.clone(),
            applied: settings.clone(),
            binding: None,
        };
        let mut deferred = false;
        let absent = || Err(ApiError::new("OWNER_NOT_LOGGED_ON", "No owner session"));
        assert!(owned_snapshot(&lease, Scope::User, absent, &mut deferred)
            .unwrap()
            .is_none());
        assert!(deferred);
        assert!(
            owned_snapshot(&lease, Scope::User, || Ok(settings.clone()), &mut deferred)
                .unwrap()
                .is_some()
        );
        let mut external = settings.clone();
        external.server = "127.0.0.1:20808".into();
        assert_eq!(
            owned_snapshot(&lease, Scope::User, || Ok(external), &mut deferred)
                .unwrap_err()
                .code,
            "PROXY_CONFLICT"
        );
        let mut read = false;
        assert!(owned_snapshot(
            &lease,
            Scope::Machine,
            || {
                read = true;
                absent()
            },
            &mut false
        )
        .is_err());
        assert!(
            !read,
            "A scope-policy change is rejected before any owner-store access"
        );
        let mut machine = lease;
        machine.before.scope = Scope::Machine;
        machine.applied.scope = Scope::Machine;
        assert_eq!(
            owned_snapshot(&machine, Scope::Machine, absent, &mut false)
                .unwrap_err()
                .code,
            "OWNER_NOT_LOGGED_ON"
        );
    }
    fn settings(server: &str) -> ProxySettings {
        ProxySettings {
            scope: Scope::User,
            flags: 3,
            server: server.into(),
            bypass: String::new(),
            auto_config_url: String::new(),
        }
    }
    #[test]
    fn wininet_bypass_is_canonical_for_manual_proxy_and_absent_for_pac() {
        let mut request:crate::system_settings::Request=serde_json::from_value(json!({"channel":"wininet","inputTag":"local-http","bypass":"localhost, 例子.test;*.пример.test"})).unwrap();
        let manual =
            ProxyManager::requested(&request, &wayrill_protocol::direct_example(), None).unwrap();
        assert_eq!(manual.bypass, "localhost;例子.test;*.пример.test");
        request.mode = "automatic".into();
        request.auto_detect = true;
        assert!(ProxyManager::requested(&request, &json!({}), None)
            .unwrap()
            .bypass
            .is_empty());
    }
    #[test]
    fn requested_pac_is_safe_for_the_native_windows_code_page() {
        let request=serde_json::from_value(json!({"channel":"wininet","mode":"automatic","pacUrl":"http://пример.example/代理-тест.pac","autoDetect":true})).unwrap();
        let settings = ProxyManager::requested(&request, &json!({}), None).unwrap();
        assert!(settings
            .auto_config_url
            .starts_with("http://пример.example/"));
        assert!(settings.auto_config_url.contains("%E4%BB%A3%E7%90%86"));
        assert_eq!(settings.flags, 13);
    }
    #[test]
    fn policy_selects_an_explicit_scope_and_rejects_unknown_values() {
        assert_eq!(policy_scope(None).unwrap(), Scope::User);
        assert_eq!(policy_scope(Some(1)).unwrap(), Scope::User);
        assert_eq!(policy_scope(Some(0)).unwrap(), Scope::Machine);
        assert_eq!(policy_scope(Some(2)).unwrap_err().code, "PROXY_POLICY");
        assert!(check_scope(Scope::Machine, Scope::Machine).is_ok());
        assert_eq!(
            check_scope(Scope::Machine, Scope::User).unwrap_err().code,
            "PROXY_SCOPE_CHANGED"
        );
        assert_eq!(
            check_scope(Scope::User, Scope::Machine).unwrap_err().code,
            "PROXY_SCOPE_CHANGED"
        );
    }
    #[test]
    fn matching_values_in_a_different_scope_never_authorize_recovery() {
        let before = settings("before");
        let applied = settings("applied");
        for mut current in [before.clone(), applied.clone()] {
            current.scope = Scope::Machine;
            assert_eq!(
                recovery_decision(&current, &before, &applied),
                Recovery::Conflict
            );
            let lease = Lease {
                before: before.clone(),
                applied: applied.clone(),
                binding: None,
            };
            let row = capture_row(Ok(current.clone()), Some(&lease));
            assert_eq!(row["scope"], "machine");
            assert_eq!(row["scopeConflict"], true);
            assert_eq!(row["conflict"], true);
            assert_ne!(
                crate::system_settings::version(&current),
                crate::system_settings::version(&applied)
            );
            assert_ne!(
                crate::system_settings::version(&current),
                crate::system_settings::version(&before)
            );
        }
    }
    #[test]
    fn machine_snapshot_supports_all_actions_without_redirecting_a_user_lease() {
        let mut before = settings("before");
        before.scope = Scope::Machine;
        let mut applied = settings("applied");
        applied.scope = Scope::Machine;
        assert_eq!(
            recovery_decision(&applied, &before, &applied),
            Recovery::Restore
        );
        assert_eq!(
            recovery_decision(&before, &before, &applied),
            Recovery::AlreadyRestored
        );
        let row = capture_row(
            Ok(applied.clone()),
            Some(&Lease {
                before,
                applied,
                binding: None,
            }),
        );
        assert_eq!(row["supported"], true);
        assert_eq!(row["managed"], true);
        assert_eq!(row["scope"], "machine");
        assert_eq!(row["scopeConflict"], false);
    }
    #[test]
    fn preexisting_proxy_snapshots_remain_tied_to_the_owner_scope() {
        let snapshot: ProxySettings =
            serde_json::from_value(json!({"flags":1,"server":"","bypass":"","autoConfigUrl":""}))
                .unwrap();
        assert_eq!(snapshot.scope, Scope::User);
        assert_eq!(
            serde_json::to_string(&snapshot).unwrap(),
            r#"{"flags":1,"server":"","bypass":"","autoConfigUrl":""}"#
        );
    }
    #[test]
    fn wininet_effective_fields_follow_flags_without_losing_recovery_cache() {
        for flags in 0..16 {
            let current = ProxySettings {
                scope: Scope::User,
                flags,
                server: "cached.example:8080".into(),
                bypass: "*.cached.example".into(),
                auto_config_url: "https://пример.example/代理.pac".into(),
            };
            let row = capture_row(Ok(current.clone()), None);
            assert_eq!(row["values"]["enabled"], flags & PROXY_TYPE_PROXY != 0);
            assert_eq!(
                row["values"]["server"],
                if flags & PROXY_TYPE_PROXY != 0 {
                    current.server.as_str()
                } else {
                    ""
                }
            );
            assert_eq!(
                row["values"]["bypass"],
                if flags & PROXY_TYPE_PROXY != 0 {
                    current.bypass.as_str()
                } else {
                    ""
                }
            );
            assert_eq!(
                row["values"]["pacUrl"],
                if flags & PROXY_TYPE_AUTO_PROXY_URL != 0 {
                    current.auto_config_url.as_str()
                } else {
                    ""
                }
            );
            assert_eq!(
                row["values"]["autoDetect"],
                flags & PROXY_TYPE_AUTO_DETECT != 0
            );
            assert_eq!(row["version"], crate::system_settings::version(&current));
        }
    }
    #[test]
    fn unavailable_user_scope_remains_an_individual_row_with_its_recovery_lease() {
        let lease = Lease {
            before: settings("before"),
            applied: settings("applied"),
            binding: None,
        };
        let row = capture_row(Err(policy_scope(Some(2)).unwrap_err()), Some(&lease));
        assert_eq!(row["channel"], "wininet");
        assert_eq!(row["supported"], false);
        assert_eq!(row["managed"], true);
        assert_eq!(row["error"]["code"], "PROXY_POLICY");
        assert!(row.get("version").is_none());
    }
    #[test]
    fn scope_change_rejects_arbitrary_or_unknown_policy_inputs() {
        for invalid in [
            json!({"scope":"system","expectedVersion":"x"}),
            json!({"scope":"machine","expectedVersion":"x","path":"HKLM"}),
            json!({"scope":0,"expectedVersion":"x"}),
        ] {
            assert!(serde_json::from_value::<ScopeChange>(invalid).is_err());
        }
        assert_eq!(Scope::User.policy_value(), 1);
        assert_eq!(Scope::Machine.policy_value(), 0);
    }
    #[test]
    fn scope_switch_restores_active_leases_before_changing_policy() {
        for scope in [Scope::User, Scope::Machine] {
            let mut before = settings("before");
            before.scope = scope;
            let mut applied = settings("applied");
            applied.scope = scope;
            let target = if scope == Scope::User {
                Scope::Machine
            } else {
                Scope::User
            };
            let lease = Lease {
                before: before.clone(),
                applied: applied.clone(),
                binding: None,
            };
            assert!(!recovery_after_switch(&applied, Some(&lease), target).unwrap());
            assert!(!recovery_after_switch(&before, Some(&lease), target).unwrap());
            let mut external = settings("external");
            external.scope = scope;
            assert_eq!(
                recovery_after_switch(&external, Some(&lease), target)
                    .unwrap_err()
                    .code,
                "PROXY_CONFLICT"
            );
        }
    }
    #[test]
    fn switching_back_recovers_inactive_lease_only_in_its_original_store() {
        let lease = Lease {
            before: settings("before"),
            applied: settings("applied"),
            binding: None,
        };
        let mut current = settings("machine");
        current.scope = Scope::Machine;
        assert!(recovery_after_switch(&current, Some(&lease), Scope::User).unwrap());
        assert!(recovery_after_switch(&current, Some(&lease), Scope::Machine).is_err());
        assert!(!recovery_after_switch(&current, None, Scope::User).unwrap());
    }
    #[test]
    fn releasing_a_conflict_clears_all_recovery_flags() {
        let data =
            std::env::temp_dir().join(format!("wayrill-scope-release-{}", std::process::id()));
        let mut manager = ProxyManager::new("owner", PathBuf::new(), &data);
        manager.conflict = true;
        manager.recovery_pending = true;
        manager.discard().unwrap();
        assert!(!manager.conflict && !manager.recovery_pending);
    }
    #[test]
    fn restores_only_owned_values() {
        let before = settings("original");
        let applied = settings("wayrill");
        assert_eq!(
            recovery_decision(&applied, &before, &applied),
            Recovery::Restore
        );
    }
    #[test]
    fn never_overwrites_external_change() {
        let before = settings("original");
        let applied = settings("wayrill");
        assert_eq!(
            recovery_decision(&settings("another-app"), &before, &applied),
            Recovery::Conflict
        );
    }
    #[test]
    fn recognizes_crash_after_restore() {
        let before = settings("original");
        assert_eq!(
            recovery_decision(&before, &before, &settings("wayrill")),
            Recovery::AlreadyRestored
        );
    }
}
