//! Owner-authorized, reversible proxy settings for Windows' separate consumers.
use crate::{
    capture, storage,
    system_native::{self, Advanced, Channel, NativeValue, ENV_NAMES},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use wayrill_protocol::{ApiError, Result};

// An absent interactive owner cannot authorize a different user's store. Keep
// its journal untouched while independent machine settings and routing recover.
pub(crate) fn routing_read<T>(
    user: bool,
    result: Result<T>,
    deferred: &mut bool,
) -> Result<Option<T>> {
    match result {
        Err(error) if user && error.code == "OWNER_NOT_LOGGED_ON" => {
            *deferred = true;
            Ok(None)
        }
        result => result.map(Some),
    }
}
// This exact error is produced before creating the owner helper. If logout
// races its launch, no native write began: recover the old expected-value CAS.
pub(crate) fn recover_unstarted_user_write<T>(
    user: bool,
    result: &Result<T>,
    restore_journal: impl FnOnce() -> Result<()>,
) -> Result<bool> {
    if user
        && result
            .as_ref()
            .is_err_and(|e| e.code == "OWNER_NOT_LOGGED_ON")
    {
        restore_journal()?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub channel: Channel,
    #[serde(default)]
    pub expected_version: String,
    #[serde(default = "manual")]
    pub mode: String,
    #[serde(default)]
    pub input_tag: String,
    #[serde(default)]
    pub all_input_tag: String,
    #[serde(default = "all_protocol")]
    pub all_protocol: String,
    #[serde(default)]
    pub http: bool,
    #[serde(default)]
    pub https: bool,
    #[serde(default)]
    pub ftp: bool,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub bypass: String,
    #[serde(default)]
    pub pac_url: String,
    #[serde(default)]
    pub auto_detect: bool,
}
fn manual() -> String {
    "proxy".into()
}
fn all_protocol() -> String {
    "socks5h".into()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub channel: Channel,
    pub expected_version: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lease {
    before: NativeValue,
    applied: NativeValue,
    request: Option<Request>,
}
fn check_leases(
    leases: BTreeMap<Channel, Lease>,
    deferred: &mut bool,
    mut current: impl FnMut(Channel) -> Result<NativeValue>,
) -> Result<()> {
    for (channel, lease) in leases {
        let Some(current) = routing_read(channel.user(), current(channel), deferred)? else {
            continue;
        };
        if current != lease.applied {
            return Err(ApiError::new("SETTINGS_CONFLICT", "External Windows settings changes were preserved. Restore or keep external settings first."));
        }
    }
    Ok(())
}
// Older services used the machine channel for the legacy backend on Windows 10.
// Keep those recovery snapshots tied to the same native store after exposing it
// separately. Reads do not rewrite the journal; the next save commits the key.
fn normalize_leases(mut leases: BTreeMap<Channel, Lease>) -> Result<BTreeMap<Channel, Lease>> {
    if leases.get(&Channel::WinhttpMachine).is_some_and(|lease| {
        matches!(lease.before, NativeValue::Winhttp { .. })
            || matches!(lease.applied, NativeValue::Winhttp { .. })
    }) {
        let mut lease = leases.remove(&Channel::WinhttpMachine).unwrap();
        if !matches!(
            (&lease.before, &lease.applied),
            (NativeValue::Winhttp { .. }, NativeValue::Winhttp { .. })
        ) || leases.contains_key(&Channel::WinhttpLegacy)
            || lease
                .request
                .as_ref()
                .is_some_and(|r| r.channel != Channel::WinhttpMachine)
        {
            return Err(ApiError::new(
                "STATE_INTEGRITY",
                "Conflicting legacy WinHTTP recovery snapshots were preserved.",
            ));
        }
        if let Some(request) = &mut lease.request {
            request.channel = Channel::WinhttpLegacy;
        }
        leases.insert(Channel::WinhttpLegacy, lease);
    }
    Ok(leases)
}
pub fn version<T: Serialize>(value: &T) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
}
fn invalid(message: &str) -> ApiError {
    ApiError::new("INVALID_PARAMS", message)
}
pub fn inputs(config: &Value, plan: Option<&capture::Plan>) -> Vec<Value> {
    config["inbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|input| capture::public_proxy_input(input, plan))
        .map(|input| {
            json!({
                "tag": input["tag"],
                "port": input["port"],
                "http": true,
                "socks": matches!(input["protocol"].as_str(), Some("socks" | "mixed")),
            })
        })
        .collect()
}
pub fn port(config: &Value, plan: Option<&capture::Plan>, tag: &str, socks: bool) -> Result<u16> {
    config["inbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|input| input["tag"].as_str() == Some(tag))
        .filter(|input| {
            capture::public_proxy_input(input, plan)
                && (!socks || matches!(input["protocol"].as_str(), Some("socks" | "mixed")))
        })
        .and_then(|input| input["port"].as_u64())
        .map(|port| port as u16)
        .ok_or_else(|| invalid("Choose a plain, unauthenticated running loopback proxy input, separate from a WinDivert relay."))
}
// Windows proxy bypass lists use semicolons; NO_PROXY retains its own grammar.
pub fn windows_bypass(value: &str) -> Result<String> {
    normalize_windows_bypass(value, false)
}
pub fn wininet_bypass(value: &str) -> Result<String> {
    normalize_windows_bypass(value, true)
}
fn normalize_windows_bypass(value: &str, unicode: bool) -> Result<String> {
    value
        .split([',', ';'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            if entry.is_ascii() && !(unicode && entry.to_ascii_lowercase().contains("xn--")) {
                return Ok(entry.to_owned());
            }
            let (prefix, host) = entry.strip_prefix("*.").map_or(("", entry), |host| ("*.", host));
            let (host, port) = host.rsplit_once(':')
                .filter(|(_, port)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
                .map_or((host, ""), |(host, port)| (host, port));
            if host.contains(['*', '/', '\\', '?', '#', '@']) {
                return Err(invalid("International bypass entries need a hostname or *.hostname, with an optional port."));
            }
            let host = url::Host::parse(host)
                .map_err(|_| invalid("Invalid international bypass hostname."))?.to_string();
            let host = if unicode {
                let (host, result) = idna::domain_to_unicode(&host);
                result.map_err(|_| invalid("Invalid international bypass hostname."))?;
                host
            } else {
                host
            };
            let port = if port.is_empty() { String::new() } else { format!(":{port}") };
            Ok(format!("{prefix}{host}{port}"))
        })
        .collect::<Result<Vec<_>>>()
        .map(|entries| entries.join(";"))
}
// Native WinINet can reinterpret raw non-ASCII PAC URL bytes through the
// Windows code page. An ASCII URL also gives WinHTTP stable write/readback.
pub fn canonical_pac(value: &str) -> Result<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let url = url::Url::parse(value).map_err(|_| invalid("Invalid PAC URL."))?;
    if value.len() > 2000
        || value.chars().any(char::is_control)
        || !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "PAC needs an HTTP/HTTPS URL without credentials or a fragment.",
        ));
    }
    Ok(url.to_string())
}
// WinINet reads IDN hosts back as Unicode while URL paths stay escaped.
pub fn wininet_pac(value: &str) -> Result<String> {
    let encoded = canonical_pac(value)?;
    if encoded.is_empty() {
        return Ok(encoded);
    }
    let url = url::Url::parse(&encoded).map_err(|_| invalid("Invalid PAC URL."))?;
    if let Some(domain) = url.domain() {
        let (host, result) = idna::domain_to_unicode(domain);
        result.map_err(|_| invalid("Invalid PAC hostname."))?;
        Ok(format!(
            "{}{}{}",
            &url[..url::Position::BeforeHost],
            host,
            &url[url::Position::AfterHost..]
        ))
    } else {
        Ok(encoded)
    }
}
pub fn validate(request: &Request) -> Result<()> {
    if !["proxy", "automatic"].contains(&request.mode.as_str())
        || !["http", "socks5", "socks5h"].contains(&request.all_protocol.as_str())
    {
        return Err(invalid("Invalid proxy mode."));
    }
    if request.bypass.len() > 1000
        || request.bypass.chars().any(char::is_control)
        || request.input_tag.len() > 256
        || request.all_input_tag.len() > 256
    {
        return Err(invalid(
            "Proxy settings exceed their limit or contain control characters.",
        ));
    }
    if request.mode == "automatic" {
        if matches!(request.channel, Channel::EnvUser | Channel::EnvMachine) {
            return Err(invalid(
                "Environment variables do not implement PAC or automatic discovery.",
            ));
        }
        if !request.auto_detect && request.pac_url.is_empty() {
            return Err(invalid("Supply a PAC URL or enable automatic discovery."));
        }
        if !request.pac_url.is_empty() {
            canonical_pac(&request.pac_url)?;
        }
    } else if !request.pac_url.is_empty() || request.auto_detect {
        return Err(invalid("PAC/discovery options require automatic mode."));
    }
    if matches!(request.channel, Channel::EnvUser | Channel::EnvMachine)
        && !(request.http || request.https || request.ftp || request.all)
    {
        return Err(invalid("Select at least one proxy environment variable."));
    }
    Ok(())
}
pub fn build(
    request: &Request,
    current: &NativeValue,
    config: &Value,
    plan: Option<&capture::Plan>,
) -> Result<NativeValue> {
    validate(request)?;
    match current {
        NativeValue::Environment { .. } => {
            let main = if request.http || request.https || request.ftp {
                Some(format!(
                    "http://127.0.0.1:{}",
                    port(config, plan, &request.input_tag, false)?
                ))
            } else {
                None
            };
            let all = if request.all {
                Some(format!(
                    "{}://127.0.0.1:{}",
                    request.all_protocol,
                    port(
                        config,
                        plan,
                        &request.all_input_tag,
                        request.all_protocol != "http"
                    )?
                ))
            } else {
                None
            };
            let values = ENV_NAMES
                .into_iter()
                .map(|name| {
                    let value = match name {
                        "http_proxy" if request.http => main.clone(),
                        "https_proxy" if request.https => main.clone(),
                        "ftp_proxy" if request.ftp => main.clone(),
                        "all_proxy" => all.clone(),
                        "no_proxy" if !request.bypass.is_empty() => Some(request.bypass.clone()),
                        _ => None,
                    };
                    (name.into(), value.map(|s| system_native::reg_text(&s)))
                })
                .collect();
            Ok(NativeValue::Environment { values })
        }
        NativeValue::Advanced { settings: current } => Ok(NativeValue::Advanced {
            settings: Advanced {
                proxy: if request.mode == "proxy" {
                    format!(
                        "127.0.0.1:{}",
                        port(config, plan, &request.input_tag, false)?
                    )
                } else {
                    String::new()
                },
                bypass: if request.mode == "proxy" {
                    windows_bypass(&request.bypass)?
                } else {
                    String::new()
                },
                pac: canonical_pac(&request.pac_url)?,
                auto: request.auto_detect,
                per_user: current.per_user,
            },
        }),
        NativeValue::Winhttp { .. } => {
            if request.mode != "proxy" {
                return Err(ApiError::new(
                    "ADVPROXY_UNAVAILABLE",
                    "The legacy machine proxy supports manual settings only.",
                ));
            }
            Ok(NativeValue::Winhttp {
                access: 3,
                proxy: format!(
                    "127.0.0.1:{}",
                    port(config, plan, &request.input_tag, false)?
                ),
                bypass: windows_bypass(&request.bypass)?,
            })
        }
    }
}
pub fn empty(value: &NativeValue) -> NativeValue {
    match value {
        NativeValue::Environment { .. } => NativeValue::Environment {
            values: ENV_NAMES.into_iter().map(|n| (n.into(), None)).collect(),
        },
        NativeValue::Winhttp { .. } => NativeValue::Winhttp {
            access: 1,
            proxy: String::new(),
            bypass: String::new(),
        },
        NativeValue::Advanced { settings: current } => NativeValue::Advanced {
            settings: Advanced {
                proxy: String::new(),
                bypass: String::new(),
                pac: String::new(),
                auto: false,
                per_user: current.per_user,
            },
        },
    }
}
/// Restore environment fields independently: an external NO_PROXY change must
/// neither be overwritten nor strand all the other owned variables.
fn recovery(
    current: &NativeValue,
    before: &NativeValue,
    applied: &NativeValue,
) -> (NativeValue, bool) {
    if let (
        NativeValue::Environment { values: c },
        NativeValue::Environment { values: b },
        NativeValue::Environment { values: a },
    ) = (current, before, applied)
    {
        let mut next = c.clone();
        let mut conflict = false;
        for name in ENV_NAMES {
            if c.get(name) == a.get(name) {
                next.insert(name.into(), b.get(name).cloned().flatten());
            } else if c.get(name) != b.get(name) {
                conflict = true;
            }
        }
        (NativeValue::Environment { values: next }, conflict)
    } else if current == applied {
        (before.clone(), false)
    } else {
        (current.clone(), current != before)
    }
}
fn environment_expansions(value: &NativeValue) -> Vec<&str> {
    match value {
        NativeValue::Environment { values } => ENV_NAMES
            .into_iter()
            .filter(|name| {
                values
                    .get(*name)
                    .and_then(Option::as_ref)
                    .is_some_and(|value| {
                        value.kind == windows_sys::Win32::System::Registry::REG_EXPAND_SZ
                    })
            })
            .collect(),
        _ => Vec::new(),
    }
}
pub struct Manager {
    owner: String,
    exe: PathBuf,
    journal: PathBuf,
    pub recovery_pending: bool,
    pub(crate) user_deferred: bool,
}
impl Manager {
    pub fn new(owner: &str, exe: PathBuf, data: &Path) -> Self {
        Self {
            owner: owner.into(),
            exe,
            journal: data.join("traffic-settings-leases.json"),
            recovery_pending: false,
            user_deferred: false,
        }
    }
    fn leases(&self) -> Result<BTreeMap<Channel, Lease>> {
        normalize_leases(storage::read(&self.journal)?.unwrap_or_default())
    }
    fn save(&mut self, leases: &BTreeMap<Channel, Lease>) -> Result<()> {
        if leases.is_empty() {
            storage::remove(&self.journal)
        } else {
            storage::write(&self.journal, leases)
        }?;
        if !leases.keys().any(|channel| channel.user()) {
            self.user_deferred = false;
        }
        Ok(())
    }
    fn current(&self, channel: Channel) -> Result<NativeValue> {
        if channel.user() {
            system_native::owner_call(&self.exe, &self.owner, channel, None)
        } else {
            system_native::query(channel)
        }
    }
    fn write(&self, channel: Channel, value: &NativeValue) -> Result<NativeValue> {
        if channel.user() {
            system_native::owner_call(&self.exe, &self.owner, channel, Some(value))
        } else {
            system_native::write(channel, value)?;
            self.current(channel)
        }
    }
    pub fn diagnose(&self, channel: Channel) -> Result<Value> {
        if channel == Channel::WinhttpUser {
            system_native::owner_diagnose(&self.exe, &self.owner, channel)
        } else {
            system_native::diagnose(channel)
        }
    }
    pub fn summary(&self) -> Value {
        match self.leases() {
            Ok(l) => {
                json!({"managed":!l.is_empty(),"channels":l.keys().collect::<Vec<_>>(),"recoveryPending":self.recovery_pending,"waitingForUser":self.user_deferred})
            }
            Err(_) => json!({"managed":true,"error":"Protected settings journal needs attention."}),
        }
    }
    pub fn rows(&self) -> Result<Vec<Value>> {
        let leases = self.leases()?;
        Ok([Channel::EnvUser,Channel::EnvMachine,Channel::WinhttpLegacy,Channel::WinhttpMachine,Channel::WinhttpUser].into_iter().map(|channel| {
            match self.current(channel) {
                Ok(current)=>{
                    let lease=leases.get(&channel);
                    let (display,advanced)=match &current {
                        NativeValue::Environment{values}=>(json!(values.iter().map(|(n,v)|(n.clone(),v.as_ref().map(system_native::display))).collect::<BTreeMap<_,_>>()),false),
                        NativeValue::Winhttp{access,proxy,bypass}=>(json!({"server":proxy,"bypass":bypass,"enabled":*access==3,"autoDetect":false,"pacUrl":""}),false),
                        NativeValue::Advanced{settings}=>(json!({"server":settings.proxy,"bypass":settings.bypass,"enabled":!settings.proxy.is_empty(),"autoDetect":settings.auto,"pacUrl":settings.pac}),true),
                    };
                    json!({"channel":channel,"supported":true,"advancedSupported":advanced,"version":version(&current),"restoreVersion":lease.map(|l|version(&l.before)),"values":display,"expandVariables":environment_expansions(&current),"managed":lease.is_some(),"conflict":lease.is_some_and(|l|recovery(&current,&l.before,&l.applied).1),"request":lease.and_then(|l|l.request.as_ref())})
                },
                Err(error)=>json!({"channel":channel,"supported":false,"managed":leases.contains_key(&channel),"error":error}),
            }
        }).collect())
    }
    pub fn requests(&self) -> Result<Vec<Request>> {
        Ok(self
            .leases()?
            .values()
            .filter_map(|l| l.request.clone())
            .collect())
    }
    pub fn check_owned(&mut self) -> Result<()> {
        let mut deferred = self.user_deferred;
        let result = check_leases(self.leases()?, &mut deferred, |channel| {
            self.current(channel)
        });
        self.user_deferred = deferred;
        result
    }
    pub fn preflight(
        &mut self,
        requests: &[Request],
        config: &Value,
        plan: Option<&capture::Plan>,
    ) -> Result<()> {
        let baseline = self.leases()?;
        for request in requests {
            let current = self.current(request.channel);
            let current = routing_read(
                request.channel.user() && baseline.contains_key(&request.channel),
                current,
                &mut self.user_deferred,
            )?;
            // Still validate the graph binding without touching an unavailable
            // owner store. Every deferred request belongs to an existing lease.
            if let Some(current) = current
                .as_ref()
                .or_else(|| baseline.get(&request.channel).map(|l| &l.applied))
            {
                build(request, current, config, plan)?;
            }
        }
        Ok(())
    }
    fn replace(
        &mut self,
        channel: Channel,
        expected: &str,
        next: NativeValue,
        request: Option<Request>,
        clear: bool,
    ) -> Result<()> {
        let current = self.current(channel)?;
        if version(&current) != expected {
            return Err(ApiError::new(
                "SETTINGS_CONFLICT",
                "Windows settings changed; refresh before applying.",
            ));
        }
        let mut leases = self.leases()?;
        let previous = leases.clone();
        if let Some(lease) = leases.get(&channel) {
            if !clear && current != lease.applied {
                return Err(ApiError::new(
                    "SETTINGS_CONFLICT",
                    "Another application changed these settings. Restore owned values or keep external settings first.",
                ));
            }
        }
        let before = leases
            .get(&channel)
            .map(|l| l.before.clone())
            .unwrap_or_else(|| current.clone());
        leases.insert(
            channel,
            Lease {
                before,
                applied: next.clone(),
                request,
            },
        );
        self.save(&leases)?; // Journal before any native mutation.
        if current == next {
            return Ok(()); // Keep the lease; avoid redundant registry/netsh writes.
        }
        let written = self.write(channel, &next);
        if recover_unstarted_user_write(channel.user(), &written, || self.save(&previous))? {
            self.user_deferred = true;
            return Err(written.unwrap_err());
        }
        match written {
            Ok(actual) if actual == next => Ok(()),
            result => {
                // Undo only this attempted operation, preserving both external edits
                // and the earlier lease when rollback verifies.
                let rolled_back = self.current(channel).and_then(|actual| {
                    let (rollback, conflict) = recovery(&actual, &current, &next);
                    if conflict {
                        return Err(ApiError::new(
                            "SETTINGS_CONFLICT",
                            "External settings were preserved during rollback.",
                        ));
                    }
                    if actual != rollback && self.write(channel, &rollback)? != rollback {
                        return Err(ApiError::new("SETTINGS_ERROR", "Rollback did not verify."));
                    }
                    Ok(())
                });
                if rolled_back.is_ok() {
                    self.save(&previous)?;
                } else {
                    self.recovery_pending = true;
                }
                Err(result.err().unwrap_or_else(|| {
                    ApiError::new(
                        "SETTINGS_ERROR",
                        "Windows did not retain the requested settings.",
                    )
                }))
            }
        }
    }
    pub fn set(
        &mut self,
        request: Request,
        config: &Value,
        plan: Option<&capture::Plan>,
    ) -> Result<()> {
        let current = self.current(request.channel)?;
        let next = build(&request, &current, config, plan)?;
        self.replace(
            request.channel,
            &request.expected_version,
            next,
            Some(request.clone()),
            false,
        )
    }
    pub fn clear(&mut self, action: &Action) -> Result<()> {
        let current = self.current(action.channel)?;
        // Clear is deliberate reset, not recovery; refresh guards external writes.
        if version(&current) != action.expected_version {
            return Err(ApiError::new(
                "SETTINGS_CONFLICT",
                "Windows settings changed; refresh before clearing.",
            ));
        }
        self.replace(
            action.channel,
            &action.expected_version,
            empty(&current),
            None,
            true,
        )?;
        let mut leases = self.leases()?;
        leases.remove(&action.channel);
        self.save(&leases)
    }
    pub fn restore(&mut self, channel: Channel) -> Result<()> {
        let mut leases = self.leases()?;
        let Some(lease) = leases.get(&channel) else {
            return Ok(());
        };
        let current = self.current(channel)?;
        let (next, conflict) = recovery(&current, &lease.before, &lease.applied);
        if next != current && self.write(channel, &next)? != next {
            return Err(ApiError::new(
                "SETTINGS_ERROR",
                "Windows settings recovery did not verify.",
            ));
        }
        if conflict {
            return Err(ApiError::new(
                "SETTINGS_CONFLICT",
                "Owned settings were restored where possible. External changes were preserved; keep external settings to release the remaining journal.",
            ));
        }
        leases.remove(&channel);
        self.save(&leases)
    }
    pub fn action(&mut self, action: &Action, method: &str) -> Result<()> {
        if version(&self.current(action.channel)?) != action.expected_version {
            return Err(ApiError::new(
                "SETTINGS_CONFLICT",
                "Windows settings changed; refresh before continuing.",
            ));
        }
        match method {
            "restore" => self.restore(action.channel),
            "clear" => self.clear(action),
            "keepExternal" => {
                let mut leases = self.leases()?;
                let Some(lease) = leases.get(&action.channel) else {
                    return Err(invalid("No settings journal exists."));
                };
                if !recovery(
                    &self.current(action.channel)?,
                    &lease.before,
                    &lease.applied,
                )
                .1
                {
                    return Err(invalid(
                        "Only an external settings conflict can be acknowledged.",
                    ));
                }
                if let Err(error) = self.restore(action.channel) {
                    if error.code != "SETTINGS_CONFLICT" {
                        return Err(error);
                    }
                }
                leases = self.leases()?;
                leases.remove(&action.channel);
                self.save(&leases)
            }
            _ => Err(invalid("Unknown settings action.")),
        }
    }
    pub fn restore_all(&mut self) -> Result<()> {
        let leases = self
            .leases()
            .inspect_err(|_| self.recovery_pending = true)?;
        let mut cleanup = crate::lifecycle::Cleanup::default();
        self.recovery_pending = false;
        for channel in leases.keys().copied() {
            let result = self.restore(channel);
            if result
                .as_ref()
                .is_err_and(|error| error.code != "SETTINGS_CONFLICT")
            {
                self.recovery_pending = true;
            }
            let step = match channel {
                Channel::Wininet => "Windows proxy",
                Channel::EnvUser => "per-user environment",
                Channel::EnvMachine => "machine environment",
                Channel::WinhttpLegacy => "legacy WinHTTP",
                Channel::WinhttpMachine => "machine WinHTTP",
                Channel::WinhttpUser => "per-user WinHTTP",
            };
            cleanup.record(step, result);
        }
        cleanup.finish()
    }
    pub fn reapply(
        &mut self,
        requests: &[Request],
        config: &Value,
        plan: Option<&capture::Plan>,
    ) -> Result<()> {
        let leases = self.leases()?;
        for request in requests {
            let mut request = request.clone();
            let user = request.channel.user() && leases.contains_key(&request.channel);
            let current = self.current(request.channel);
            let Some(current) = routing_read(user, current, &mut self.user_deferred)? else {
                continue;
            };
            request.expected_version = version(&current);
            let result = self.set(request, config, plan);
            routing_read(user, result, &mut self.user_deferred)?;
        }
        Ok(())
    }
    pub(crate) fn reconcile_user(
        &mut self,
        config: &Value,
        plan: Option<&capture::Plan>,
    ) -> Result<()> {
        if !self.user_deferred {
            return Ok(());
        }
        self.user_deferred = false;
        let result = (|| {
            // Ownership must be proved against the old applied value before
            // rebuilding a binding for the current committed graph.
            self.check_owned()?;
            let requests = self
                .requests()?
                .into_iter()
                .filter(|r| r.channel.user())
                .collect::<Vec<_>>();
            self.reapply(&requests, config, plan)
        })();
        if result.is_err() {
            self.user_deferred = true;
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn environment_lease(request: Option<Request>) -> Lease {
        let value = NativeValue::Environment {
            values: ENV_NAMES
                .into_iter()
                .map(|name| (name.into(), None))
                .collect(),
        };
        Lease {
            before: value.clone(),
            applied: value,
            request,
        }
    }
    #[test]
    fn logout_before_helper_launch_restores_the_previous_journal_but_uncertain_writes_do_not() {
        let root = std::env::temp_dir().join(format!(
            "wayrill-owner-write-{}-{}",
            std::process::id(),
            crate::tun::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let mut manager = Manager::new("test-owner", PathBuf::from("unused.exe"), &root);
        let previous = BTreeMap::from([(Channel::EnvUser, environment_lease(None))]);
        manager.save(&previous).unwrap();
        let original = std::fs::read(&manager.journal).unwrap();
        let mut candidate = previous.clone();
        candidate.get_mut(&Channel::EnvUser).unwrap().request = Some(req());
        manager.save(&candidate).unwrap();
        let proposed = std::fs::read(&manager.journal).unwrap();
        assert_ne!(proposed, original);
        for (user, code) in [
            (true, "TIMEOUT"),
            (true, "ACCESS_DENIED"),
            (false, "OWNER_NOT_LOGGED_ON"),
        ] {
            let result: Result<()> = Err(ApiError::new(code, "write failure"));
            assert!(
                !recover_unstarted_user_write(user, &result, || manager.save(&previous)).unwrap()
            );
            assert_eq!(std::fs::read(&manager.journal).unwrap(), proposed);
        }
        let result: Result<()> = Err(ApiError::new(
            "OWNER_NOT_LOGGED_ON",
            "before owner helper launch",
        ));
        assert!(recover_unstarted_user_write(true, &result, || manager.save(&previous)).unwrap());
        assert_eq!(std::fs::read(&manager.journal).unwrap(), original);
        // Login now verifies against the real old applied snapshot, not the
        // unstarted candidate that would falsely look like an external edit.
        check_leases(manager.leases().unwrap(), &mut false, |_| {
            Ok(environment_lease(None).applied)
        })
        .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn absent_owner_defers_existing_user_bindings_without_touching_their_journal() {
        let root = std::env::temp_dir().join(format!(
            "wayrill-owner-deferred-{}-{}",
            std::process::id(),
            crate::tun::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let mut manager = Manager::new(
            "S-1-5-21-0-0-0-4294967294",
            PathBuf::from("unused.exe"),
            &root,
        );
        let request = req();
        let leases = BTreeMap::from([(Channel::EnvUser, environment_lease(Some(request.clone())))]);
        manager.save(&leases).unwrap();
        let original = std::fs::read(&manager.journal).unwrap();
        manager.check_owned().unwrap();
        assert!(manager.user_deferred);
        let config = json!({"inbounds":[{"tag":"local-http","protocol":"http","listen":"127.0.0.1","port":20808},{"tag":"local-socks","protocol":"socks","listen":"127.0.0.1","port":20809,"settings":{}}]});
        manager
            .preflight(std::slice::from_ref(&request), &config, None)
            .unwrap();
        manager
            .reapply(std::slice::from_ref(&request), &config, None)
            .unwrap();
        manager.reconcile_user(&config, None).unwrap();
        assert!(manager.user_deferred);
        assert_eq!(std::fs::read(&manager.journal).unwrap(), original);
        assert!(
            manager
                .preflight(
                    std::slice::from_ref(&request),
                    &json!({"inbounds":[]}),
                    None
                )
                .is_err(),
            "Deferred reads must still validate the graph binding"
        );
        assert_eq!(
            manager.restore_all().unwrap_err().code,
            "OWNER_NOT_LOGGED_ON",
            "Stop must retain a strict, retryable restoration obligation"
        );
        assert!(manager.recovery_pending);
        assert_eq!(std::fs::read(&manager.journal).unwrap(), original);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn deferred_owner_checks_continue_with_machine_scopes_and_reject_external_values_after_login() {
        let leases = || {
            BTreeMap::from([
                (Channel::EnvUser, environment_lease(None)),
                (Channel::EnvMachine, environment_lease(None)),
            ])
        };
        let mut deferred = false;
        let mut seen = Vec::new();
        let result = check_leases(leases(), &mut deferred, |channel| {
            seen.push(channel);
            Err(ApiError::new(
                if channel.user() {
                    "OWNER_NOT_LOGGED_ON"
                } else {
                    "MACHINE_FAILURE"
                },
                "test read",
            ))
        });
        assert_eq!(result.unwrap_err().code, "MACHINE_FAILURE");
        assert_eq!(seen, vec![Channel::EnvUser, Channel::EnvMachine]);
        assert!(deferred);
        let mut foreign = environment_lease(None).applied;
        if let NativeValue::Environment { values } = &mut foreign {
            values.insert(
                "http_proxy".into(),
                Some(system_native::reg_text("http://127.0.0.1:9999")),
            );
        }
        assert_eq!(
            check_leases(leases(), &mut false, |channel| Ok(if channel.user() {
                foreign.clone()
            } else {
                environment_lease(None).applied
            }))
            .unwrap_err()
            .code,
            "SETTINGS_CONFLICT"
        );
        assert!(check_leases(
            leases(),
            &mut false,
            |_| Ok(environment_lease(None).applied)
        )
        .is_ok());
        assert_eq!(
            routing_read::<()>(
                false,
                Err(ApiError::new("OWNER_NOT_LOGGED_ON", "machine")),
                &mut false
            )
            .unwrap_err()
            .code,
            "OWNER_NOT_LOGGED_ON"
        );
        assert_eq!(
            routing_read::<()>(
                true,
                Err(ApiError::new("ACCESS_DENIED", "owner")),
                &mut false
            )
            .unwrap_err()
            .code,
            "ACCESS_DENIED"
        );
    }
    fn req() -> Request {
        serde_json::from_value(json!({"channel":"envUser","http":true,"https":true,"all":true,"inputTag":"local-http","allInputTag":"local-socks","bypass":"localhost,127.0.0.1"})).unwrap()
    }
    #[test]
    fn unreadable_leases_remain_pending_and_are_not_discarded() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("wayrill-leases-{}-{unique}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let mut manager = Manager::new("test-owner", PathBuf::from("unused.exe"), &root);
        let invalid = b"not valid JSON";
        std::fs::write(&manager.journal, invalid).unwrap();
        assert!(manager.restore_all().is_err());
        assert!(manager.recovery_pending);
        assert_eq!(std::fs::read(&manager.journal).unwrap(), invalid);
        std::fs::remove_file(&manager.journal).unwrap();
        manager.restore_all().unwrap();
        assert!(!manager.recovery_pending);
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn wininet_pac_matches_native_idn_host_and_escaped_path_readback() {
        for input in [
            "http://пример.example/代理-тест.pac",
            "http://xn--e1afmkfd.example/%E4%BB%A3%E7%90%86-%D1%82%D0%B5%D1%81%D1%82.pac",
        ] {
            assert_eq!(
                wininet_pac(input).unwrap(),
                "http://пример.example/%E4%BB%A3%E7%90%86-%D1%82%D0%B5%D1%81%D1%82.pac"
            );
        }
    }
    #[test]
    fn wininet_readback_uses_unicode_for_either_idn_input_representation() {
        for input in [
            "localhost,*.пример.test;例子.test:443",
            "localhost;*.xn--e1afmkfd.test;xn--fsqu00a.test:443",
        ] {
            assert_eq!(
                wininet_bypass(input).unwrap(),
                "localhost;*.пример.test;例子.test:443"
            );
        }
    }
    #[test]
    fn international_windows_bypass_preserves_wildcard_and_port_semantics() {
        assert_eq!(
            windows_bypass("*.пример.test:443,例子.test,127.*,<local>").unwrap(),
            "*.xn--e1afmkfd.test:443;xn--fsqu00a.test;127.*;<local>"
        );
        assert!(windows_bypass("прим*.test").is_err());
        assert!(windows_bypass("http://пример.test/path").is_err());
    }
    #[test]
    fn environment_metadata_distinguishes_expanding_and_literal_percent_values() {
        let mut literal = system_native::reg_text("%USERPROFILE%");
        let mut expanding = literal.clone();
        expanding.kind = windows_sys::Win32::System::Registry::REG_EXPAND_SZ;
        let value = NativeValue::Environment {
            values: BTreeMap::from([
                ("http_proxy".into(), Some(expanding)),
                ("no_proxy".into(), Some(literal.clone())),
            ]),
        };
        assert_eq!(environment_expansions(&value), vec!["http_proxy"]);
        literal.kind = windows_sys::Win32::System::Registry::REG_EXPAND_SZ;
        assert_eq!(system_native::display(&literal), "%USERPROFILE%");
    }
    #[test]
    fn windows_bypass_normalizes_separators_without_changing_environment_syntax() {
        assert_eq!(
            windows_bypass(" localhost, *.пример.test ; 例子.test;; [::1] ").unwrap(),
            "localhost;*.xn--e1afmkfd.test;xn--fsqu00a.test;[::1]"
        );
        let mut request = req();
        request.bypass = "localhost,例子.test".into();
        let environment = build(
            &request,
            &NativeValue::Environment {
                values: BTreeMap::new(),
            },
            &wayrill_protocol::direct_example(),
            None,
        )
        .unwrap();
        if let NativeValue::Environment { values } = environment {
            assert_eq!(
                system_native::display(values["no_proxy"].as_ref().unwrap()),
                "localhost,例子.test"
            );
        } else {
            panic!()
        }
    }
    #[test]
    fn pac_write_uses_ascii_url_without_altering_the_raw_recovery_baseline() {
        let raw = "http://пример.example/代理-тест.pac";
        let encoded = canonical_pac(raw).unwrap();
        assert!(encoded.is_ascii());
        assert!(encoded.contains("xn--"));
        assert!(encoded.contains("%E4%BB%A3%E7%90%86-%D1%82%D0%B5%D1%81%D1%82.pac"));
        let current = NativeValue::Advanced {
            settings: Advanced {
                proxy: String::new(),
                bypass: String::new(),
                pac: "http://existing.example/原始.pac".into(),
                auto: false,
                per_user: Some(true),
            },
        };
        let mut request = req();
        request.channel = Channel::WinhttpUser;
        request.mode = "automatic".into();
        request.pac_url = raw.into();
        let next = build(&request, &current, &json!({}), None).unwrap();
        if let NativeValue::Advanced { settings } = &next {
            assert_eq!(settings.pac, encoded);
        } else {
            panic!()
        }
        assert_eq!(recovery(&next, &current, &next), (current, false));
    }
    #[test]
    fn derives_separate_http_and_remote_dns_socks_environment() {
        let value = build(
            &req(),
            &NativeValue::Environment {
                values: BTreeMap::new(),
            },
            &wayrill_protocol::direct_example(),
            None,
        )
        .unwrap();
        let NativeValue::Environment { values } = value else {
            panic!()
        };
        assert_eq!(
            system_native::display(values["https_proxy"].as_ref().unwrap()),
            "http://127.0.0.1:2081"
        );
        assert_eq!(
            system_native::display(values["all_proxy"].as_ref().unwrap()),
            "socks5h://127.0.0.1:2080"
        );
        assert!(values["ftp_proxy"].is_none());
    }
    #[test]
    fn private_or_authenticated_inputs_cannot_be_adopted() {
        let mut config = wayrill_protocol::direct_example();
        config["inbounds"][1]["settings"]["accounts"] = json!([{"user":"u","pass":"p"}]);
        assert!(build(
            &req(),
            &NativeValue::Environment {
                values: BTreeMap::new()
            },
            &config,
            None
        )
        .is_err());
        assert!(port(&config, None, "local-http", true).is_err());
    }
    #[test]
    fn a_shared_port_does_not_make_an_incompatible_tag_a_proxy() {
        for patch in [
            json!({"listen":"127.0.0.2"}),
            json!({"listen":"::1"}),
            json!({"protocol":"tunnel","settings":{"network":"udp","address":"127.0.0.1","port":9001}}),
        ] {
            let mut config = wayrill_protocol::direct_example();
            config["inbounds"][1]["port"] = json!(2080);
            for (key, value) in patch.as_object().unwrap() {
                config["inbounds"][1][key] = value.clone();
            }
            let config = wayrill_protocol::normalize_config(config).unwrap();
            assert!(wayrill_protocol::http_proxy_port(&config, 2080));
            assert_eq!(
                inputs(&config, None)
                    .iter()
                    .map(|input| input["tag"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["local-socks"]
            );
            assert_eq!(port(&config, None, "local-socks", true).unwrap(), 2080);
            assert_eq!(
                port(&config, None, "local-http", false).unwrap_err().code,
                "INVALID_PARAMS"
            );
            assert!(build(
                &req(),
                &NativeValue::Environment {
                    values: BTreeMap::new()
                },
                &config,
                None
            )
            .is_err());
        }
    }
    #[test]
    fn validates_pac_and_environment_modes() {
        let mut r = req();
        r.mode = "automatic".into();
        r.pac_url = "https://example.org/a.pac".into();
        assert!(validate(&r).is_err());
        r.channel = Channel::Wininet;
        assert!(validate(&r).is_ok());
        r.pac_url = "https://user:password@example.org/a.pac".into();
        assert!(validate(&r).is_err());
    }
    #[test]
    fn legacy_machine_does_not_silently_discard_pac() {
        let mut r = req();
        r.channel = Channel::WinhttpLegacy;
        r.mode = "automatic".into();
        r.auto_detect = true;
        let v = NativeValue::Winhttp {
            access: 1,
            proxy: String::new(),
            bypass: String::new(),
        };
        assert_eq!(
            build(&r, &v, &wayrill_protocol::direct_example(), None)
                .unwrap_err()
                .code,
            "ADVPROXY_UNAVAILABLE"
        );
    }
    #[test]
    fn recovery_preserves_external_no_proxy_and_restores_owned_values() {
        let before = NativeValue::Environment {
            values: ENV_NAMES.into_iter().map(|n| (n.into(), None)).collect(),
        };
        let applied = build(&req(), &before, &wayrill_protocol::direct_example(), None).unwrap();
        let mut external = applied.clone();
        let NativeValue::Environment { values } = &mut external else {
            panic!()
        };
        values.insert(
            "no_proxy".into(),
            Some(system_native::reg_text("external.local")),
        );
        let (restored, conflict) = recovery(&external, &before, &applied);
        assert!(conflict);
        let NativeValue::Environment { values } = restored else {
            panic!()
        };
        assert!(values["http_proxy"].is_none());
        assert_eq!(
            system_native::display(values["no_proxy"].as_ref().unwrap()),
            "external.local"
        );
    }
    #[test]
    fn wrong_target_is_rejected_before_mutation() {
        let mut r = req();
        r.input_tag = "missing".into();
        assert!(build(
            &r,
            &NativeValue::Environment {
                values: BTreeMap::new()
            },
            &wayrill_protocol::direct_example(),
            None
        )
        .is_err());
    }

    fn advanced_baseline() -> NativeValue {
        NativeValue::Advanced {
            settings: system_native::parse_advanced(include_str!(
                "../fixtures/winhttp-windows11-autodetect.txt"
            ))
            .unwrap(),
        }
    }
    #[test]
    fn advanced_set_clear_and_restore_preserve_discovery_and_scope_policy() {
        let before = advanced_baseline();
        let mut request = req();
        request.channel = Channel::WinhttpMachine;
        let applied = build(&request, &before, &wayrill_protocol::direct_example(), None).unwrap();
        let NativeValue::Advanced { settings } = &applied else {
            panic!()
        };
        assert_eq!(settings.proxy, "127.0.0.1:2081");
        assert!(!settings.auto);
        assert_eq!(settings.per_user, Some(true));
        let observed = NativeValue::Advanced { settings: system_native::parse_advanced(&json!({"ProxyIsEnabled":true,"Proxy":settings.proxy,"ProxyBypass":settings.bypass,"AutoConfigIsEnabled":false,"AutoDetect":false,"PerUserProxySettings":true}).to_string()).unwrap() };
        assert_eq!(observed, applied);
        assert_eq!(
            recovery(&observed, &before, &applied),
            (before.clone(), false)
        );
        let cleared = empty(&before);
        let observed_clear = NativeValue::Advanced { settings: system_native::parse_advanced(r#"{"ProxyIsEnabled":false,"AutoConfigIsEnabled":false,"AutoDetect":false,"PerUserProxySettings":true}"#).unwrap() };
        assert_eq!(cleared, observed_clear);
        assert_eq!(
            recovery(&observed_clear, &before, &cleared),
            (before, false)
        );
    }
    #[test]
    fn advanced_recovery_preserves_external_scope_and_discovery_changes() {
        let before = advanced_baseline();
        let mut request = req();
        request.channel = Channel::WinhttpMachine;
        let applied = build(&request, &before, &wayrill_protocol::direct_example(), None).unwrap();
        for field in ["policy", "discovery"] {
            let mut external = applied.clone();
            let NativeValue::Advanced { settings } = &mut external else {
                panic!()
            };
            if field == "policy" {
                settings.per_user = Some(false);
            } else {
                settings.auto = true;
            }
            assert_ne!(version(&external), version(&applied));
            assert_eq!(recovery(&external, &before, &applied), (external, true));
        }
    }

    #[test]
    fn cached_disabled_endpoints_are_not_reenabled_by_set_clear_or_recovery() {
        let before = NativeValue::Advanced {
            settings: system_native::parse_advanced(include_str!(
                "../fixtures/winhttp-windows11-disabled-cached.txt"
            ))
            .unwrap(),
        };
        let mut request = req();
        request.channel = Channel::WinhttpMachine;
        let applied = build(&request, &before, &wayrill_protocol::direct_example(), None).unwrap();
        assert_eq!(
            recovery(&applied, &before, &applied),
            (before.clone(), false)
        );
        let (NativeValue::Advanced { settings: restored }, false) =
            recovery(&applied, &before, &applied)
        else {
            panic!()
        };
        assert_eq!(
            restored.writable(),
            json!({"Proxy":"","ProxyBypass":"","AutoconfigUrl":"","AutoDetect":false})
        );
        assert_eq!(restored.per_user, Some(false));
        let cleared = empty(&before);
        assert_eq!(cleared, before);
        request.mode = "automatic".into();
        request.auto_detect = true;
        let automatic =
            build(&request, &before, &wayrill_protocol::direct_example(), None).unwrap();
        let observed = NativeValue::Advanced { settings: system_native::parse_advanced(r#"{"ProxyIsEnabled":false,"Proxy":"proxy.example:8080","ProxyBypass":"<local>","AutoConfigIsEnabled":false,"AutoconfigUrl":"https://example.org/cached.pac","AutoDetect":true,"PerUserProxySettings":false}"#).unwrap() };
        assert_eq!(automatic, observed);
        assert_eq!(
            recovery(&observed, &before, &automatic),
            (before.clone(), false)
        );
        let external = NativeValue::Advanced { settings: system_native::parse_advanced(r#"{"ProxyIsEnabled":true,"Proxy":"external.example:8080","AutoConfigIsEnabled":false,"AutoDetect":false,"PerUserProxySettings":false}"#).unwrap() };
        assert_eq!(recovery(&external, &before, &applied), (external, true));
    }
    fn legacy_lease() -> Lease {
        let mut request = req();
        request.channel = Channel::WinhttpMachine;
        Lease {
            before: NativeValue::Winhttp {
                access: 1,
                proxy: String::new(),
                bypass: String::new(),
            },
            applied: NativeValue::Winhttp {
                access: 3,
                proxy: "127.0.0.1:2081".into(),
                bypass: "<local>".into(),
            },
            request: Some(request),
        }
    }
    #[test]
    fn legacy_journal_keeps_native_baseline_and_request_after_scope_split() {
        let old = legacy_lease();
        let json =
            serde_json::to_value(BTreeMap::from([(Channel::WinhttpMachine, old.clone())])).unwrap();
        let migrated = normalize_leases(serde_json::from_value(json).unwrap()).unwrap();
        assert!(!migrated.contains_key(&Channel::WinhttpMachine));
        let lease = &migrated[&Channel::WinhttpLegacy];
        assert_eq!(lease.before, old.before);
        assert_eq!(lease.applied, old.applied);
        assert_eq!(
            lease.request.as_ref().unwrap().channel,
            Channel::WinhttpLegacy
        );
        assert_eq!(
            recovery(&lease.applied, &lease.before, &lease.applied),
            (old.before, false)
        );
        let stored = serde_json::to_value(&migrated).unwrap();
        assert_eq!(
            stored["winhttpLegacy"]["request"]["channel"],
            "winhttpLegacy"
        );
        assert!(normalize_leases(migrated).is_ok());
    }
    #[test]
    fn advanced_machine_journal_remains_independent_from_legacy() {
        let advanced = NativeValue::Advanced {
            settings: Advanced {
                proxy: "proxy.example:8080".into(),
                bypass: String::new(),
                pac: String::new(),
                auto: false,
                per_user: Some(false),
            },
        };
        let lease = Lease {
            before: empty(&advanced),
            applied: advanced.clone(),
            request: None,
        };
        let current = normalize_leases(BTreeMap::from([
            (Channel::WinhttpMachine, lease),
            (Channel::WinhttpLegacy, legacy_lease()),
        ]))
        .unwrap();
        assert_eq!(current.len(), 2);
        assert_eq!(current[&Channel::WinhttpMachine].applied, advanced);
    }
    #[test]
    fn conflicting_or_mixed_legacy_journals_fail_before_native_changes() {
        let old = legacy_lease();
        assert_eq!(
            normalize_leases(BTreeMap::from([
                (Channel::WinhttpMachine, old.clone()),
                (Channel::WinhttpLegacy, old.clone())
            ]))
            .err()
            .unwrap()
            .code,
            "STATE_INTEGRITY"
        );
        let mut mixed = old;
        mixed.applied = NativeValue::Environment {
            values: BTreeMap::new(),
        };
        assert_eq!(
            normalize_leases(BTreeMap::from([(Channel::WinhttpMachine, mixed)]))
                .err()
                .unwrap()
                .code,
            "STATE_INTEGRITY"
        );
    }
    #[test]
    fn legacy_set_clear_and_restore_preserve_their_native_snapshot() {
        let mut request = req();
        request.channel = Channel::WinhttpLegacy;
        let current = legacy_lease().applied;
        let applied = build(
            &request,
            &current,
            &wayrill_protocol::direct_example(),
            None,
        )
        .unwrap();
        assert_eq!(
            applied,
            NativeValue::Winhttp {
                access: 3,
                proxy: "127.0.0.1:2081".into(),
                bypass: "localhost;127.0.0.1".into()
            }
        );
        assert_eq!(
            empty(&current),
            NativeValue::Winhttp {
                access: 1,
                proxy: String::new(),
                bypass: String::new()
            }
        );
        assert_eq!(recovery(&applied, &current, &applied), (current, false));
    }
}
