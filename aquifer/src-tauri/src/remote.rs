use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

const DISCOVERY: &str = include_str!("../resources/remote_probe.py");
const STATUS: &str = include_str!("../resources/server_status.py");
const ACTIONS: &str = include_str!("../resources/server_actions.py");
const UPGRADE: &str = include_str!("../resources/apt_upgrade.py");
const CONFIG_DEPLOY: &str = include_str!("../resources/config_deploy.py");
const CONFIG_UPLOAD: &str = include_str!("../resources/config_upload.py");

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteError {
    pub code: &'static str,
    pub message: String,
}
impl RemoteError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
pub(crate) type Result<T> = std::result::Result<T, RemoteError>;

#[derive(Default)]
pub struct Operation {
    busy: AtomicBool,
    cancel: AtomicBool,
    closed: AtomicBool,
    pub(crate) console: Mutex<Option<crate::transport::Console>>,
}
pub struct Permit(Arc<Operation>);
impl std::ops::Deref for Permit {
    type Target = Operation;
    fn deref(&self) -> &Operation {
        &self.0
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}
impl Operation {
    pub fn acquire(self: &Arc<Self>) -> Result<Permit> {
        if self.closed.load(Ordering::Acquire) {
            return Err(RemoteError::new("CANCELLED", "The application is closing."));
        }
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| RemoteError::new("BUSY", "Another SSH request is still finishing."))?;
        self.cancel.store(false, Ordering::Release);
        Ok(Permit(self.clone()))
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
    pub(crate) fn check_cancelled(&self) -> Result<()> {
        if self.cancel.load(Ordering::Acquire) || self.closed.load(Ordering::Acquire) {
            return Err(RemoteError::new("CANCELLED", "SSH request cancelled."));
        }
        Ok(())
    }
    pub fn disconnect(&self) {
        self.cancel();
        // An active reader observes cancellation without blocking the UI thread.
        if let Ok(mut slot) = self.console.try_lock() {
            if let Some(mut console) = slot.take() {
                console.close();
            }
        }
    }
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.disconnect();
    }
}

fn validate_path(path: &str) -> Result<()> {
    if !path.starts_with('/')
        || path.len() > 4096
        || path.chars().any(char::is_control)
        || path.contains(['*', '?', '[', ']', '"'])
    {
        return Err(RemoteError::new(
            "PATH",
            "Enter one absolute Linux file path without wildcards, quotes or control characters.",
        ));
    }
    Ok(())
}
fn run(operation: &Operation, session: &str, command: &str, stream: bool) -> Result<Vec<u8>> {
    crate::transport::run(operation, session, &[command.to_owned()], stream)
}
pub(crate) fn connection_error(output: &[u8]) -> RemoteError {
    // WinSCP suggests an `open ... -hostkey=...` command even on a normal
    // connection. That recommendation is not a host-key verification error.
    let diagnostic = String::from_utf8_lossy(output)
        .lines()
        .filter(|line| {
            let line = line.trim_start();
            !line.starts_with("open ") && !line.starts_with("winscp> ")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    let (code, message) = if diagnostic.lines().any(|line| {
        (line.contains("host key") || line.contains("hostkey"))
            && ["not", "mismatch", "changed", "unknown", "missing", "failed"]
                .iter()
                .any(|word| line.contains(word))
    }) {
        ("HOST_KEY", "The SSH host key is missing or changed. Verify this server in WinSCP, then retry. This app never accepts an unverified key.")
    } else if [
        "network error",
        "server unexpectedly closed network connection",
        "connection failed",
        "connection refused",
        "timeout detected",
    ]
    .iter()
    .any(|text| diagnostic.contains(text))
    {
        ("CONNECT", "The SSH connection failed or was closed by the server. Check connectivity and the saved session in WinSCP.")
    } else if diagnostic.contains("authentication")
        || diagnostic.contains("passphrase")
        || diagnostic.contains("password")
        || diagnostic.contains("access denied")
    {
        ("AUTH", "Authentication failed or requires interaction. Open the saved WinSCP session and configure a saved credential or an SSH agent.")
    } else if diagnostic.contains("no such file") || diagnostic.contains("not found") {
        ("NOT_FOUND", "The remote file or command was not found. Check the configuration path or use Read file to skip discovery.")
    } else {
        ("SSH", "The SSH request failed. Check connectivity, permissions and the saved session in WinSCP. Reconnect to check any server job already started.")
    };
    // Never expose raw console output, key paths or command-line credentials.
    RemoteError::new(code, message)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pid: u32,
    executable: String,
    config_paths: Vec<String>,
    config_directories: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigFile {
    path: String,
    size: u64,
    modified: u64,
    running: bool,
    source: String,
    readable: bool,
    #[serde(default)]
    services: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Discovery {
    version: u8,
    hostname: String,
    processes: Vec<Process>,
    files: Vec<ConfigFile>,
    warnings: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WayrillCompanion {
    path: String,
    sha256: Option<String>,
    text: Option<String>,
    error: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    companion: WayrillCompanion,
    pub path: String,
    pub text: String,
    pub sha256: String,
    pub bytes: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    version: u8,
    hostname: String,
    checked_at: u64,
    user: String,
    uid: u32,
    boot_id: Option<String>,
    reboot: RebootStatus,
    xray: XrayStatus,
    apt: AptStatus,
}
#[derive(Debug, Serialize, Deserialize)]
struct RebootStatus {
    required: Option<bool>,
    packages: Vec<String>,
    error: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct XrayStatus {
    installed_version: Option<String>,
    binary: Option<String>,
    version_error: Option<String>,
    processes: Vec<XrayProcess>,
    services: Vec<XrayService>,
    error: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct XrayProcess {
    pid: u32,
    executable: String,
    replaced_executable: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct XrayService {
    name: String,
    active_state: String,
    sub_state: String,
    main_pid: Option<u32>,
    started_at: Option<String>,
    unit_file_state: Option<String>,
    needs_daemon_reload: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AptStatus {
    available: bool,
    packages: Vec<AptPackage>,
    upgraded: Option<u32>,
    held_back: Option<u32>,
    indexes_updated_at: Option<u64>,
    error: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AptPackage {
    name: String,
    installed_version: Option<String>,
    candidate_version: String,
    source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServerAction {
    RefreshApt,
    UpgradeAll,
    DistUpgrade,
    UpgradePackage,
    RestartXray,
    Reboot,
    ApplyConfig,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRequest {
    pub id: String,
    pub action: ServerAction,
    pub package: Option<String>,
    pub candidate_version: Option<String>,
    pub service: Option<String>,
    pub plan_id: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerJob {
    version: u8,
    pub id: String,
    action: ServerAction,
    pub state: JobState,
    stage: String,
    percent: Option<u8>,
    message: String,
    logs: Vec<String>,
    created_at: u64,
    updated_at: u64,
    boot_id: String,
    error_code: Option<String>,
    config_result: Option<ConfigApplyResult>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigApplyResult {
    path: String,
    service: String,
    plan_id: String,
    backup_path: String,
    original_sha256: String,
    installed_sha256: String,
    wayrill_sha256: Option<String>,
    rollback: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigValidationRequest {
    pub path: String,
    pub service: String,
    pub expected_sha256: String,
    pub config_text: String,
    pub wayrill_text: Option<String>,
    pub expected_wayrill_sha256: Option<String>,
    pub stage: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigValidation {
    version: u8,
    id: Option<String>,
    pub valid: bool,
    path: String,
    service: String,
    config_sha256: String,
    source_sha256: String,
    core_version: Option<String>,
    checked_at: u64,
    expires_at: u64,
    logs: Vec<String>,
    message: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradePlan {
    version: u8,
    id: String,
    hostname: String,
    created_at: u64,
    expires_at: u64,
    installs: Vec<PackageChange>,
    upgrades: Vec<PackageChange>,
    removals: Vec<PackageChange>,
    held_back: u32,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageChange {
    name: String,
    architecture: String,
    installed_version: Option<String>,
    candidate_version: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Running,
    Succeeded,
    Failed,
    Interrupted,
}
fn validate_job_id(id: &str) -> Result<()> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(RemoteError::new("ACTION", "Invalid server job identifier."));
    }
    Ok(())
}
fn validate_action(request: &ActionRequest) -> Result<()> {
    validate_job_id(&request.id)?;
    if matches!(
        request.action,
        ServerAction::DistUpgrade | ServerAction::ApplyConfig
    ) {
        validate_job_id(request.plan_id.as_deref().unwrap_or_default())?;
    }
    // JSON is base64-encoded, never interpolated into a shell command. Also
    // bound all arguments before crossing SSH; the worker validates semantics.
    for value in [
        &request.package,
        &request.candidate_version,
        &request.service,
    ]
    .into_iter()
    .flatten()
    {
        if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
            return Err(RemoteError::new(
                "ACTION",
                "Invalid server action parameter.",
            ));
        }
    }
    Ok(())
}
fn action_call(
    operation: Permit,
    session: &str,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    let payload = serde_json::json!({"source":format!("{UPGRADE}\n{CONFIG_DEPLOY}\n{ACTIONS}"),"request":request});
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(payload.to_string().as_bytes())
        .map_err(|_| RemoteError::new("ACTION", "Cannot encode server request."))?;
    let payload = base64::engine::general_purpose::STANDARD.encode(
        encoder
            .finish()
            .map_err(|_| RemoteError::new("ACTION", "Cannot encode server request."))?,
    );
    let mut commands = Vec::new();
    for (index, chunk) in payload.as_bytes().chunks(6000).enumerate() {
        let prefix = if index == 0 {
            ""
        } else {
            "\"$WAYRILL_REQUEST_DATA\""
        };
        commands.push(format!(
            "call WAYRILL_REQUEST_DATA={prefix}'{}'",
            std::str::from_utf8(chunk).unwrap()
        ));
    }
    commands.push("call python3 -c \"import base64,zlib,json,sys;d=json.loads(zlib.decompress(base64.b64decode(sys.argv[1])));s=d['source'].encode();exec(compile(s,'<wayrill>','exec'),dict(__name__='__main__',SOURCE=s,REQUEST=d['request']))\" \"$WAYRILL_REQUEST_DATA\"".into());
    commands.push("call unset WAYRILL_REQUEST_DATA".into());
    let output = crate::transport::run(&operation, session, &commands, false)?;
    action_response(&output)
}

fn python_command(source: &str) -> Result<String> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(source.as_bytes())
        .map_err(|_| RemoteError::new("COMMAND", "Cannot encode the SSH request."))?;
    let code = base64::engine::general_purpose::STANDARD.encode(
        encoder
            .finish()
            .map_err(|_| RemoteError::new("COMMAND", "Cannot encode the SSH request."))?,
    );
    Ok(format!(
        "call python3 -c \"import base64,zlib;exec(zlib.decompress(base64.b64decode('{code}')))\""
    ))
}
pub fn start_action(operation: Permit, session: &str, request: ActionRequest) -> Result<ServerJob> {
    validate_action(&request)?;
    let mut value = serde_json::to_value(request)
        .map_err(|_| RemoteError::new("ACTION", "Cannot encode server action."))?;
    value["mode"] = serde_json::json!("start");
    parse_job_value(action_call(operation, session, value)?)
}
pub fn poll_action(operation: Permit, session: &str, id: &str) -> Result<ServerJob> {
    validate_job_id(id)?;
    parse_job_value(action_call(
        operation,
        session,
        serde_json::json!({"mode":"poll","id":id}),
    )?)
}
pub fn preview_upgrade(operation: Permit, session: &str) -> Result<UpgradePlan> {
    parse_plan(action_call(
        operation,
        session,
        serde_json::json!({"mode":"preview"}),
    )?)
}
pub fn validate_config(
    operation: Permit,
    session: &str,
    request: ConfigValidationRequest,
) -> Result<ConfigValidation> {
    validate_path(&request.path)?;
    if request.config_text.is_empty()
        || request.config_text.len() > 16 * 1024 * 1024
        || request.expected_sha256.len() != 64
        || !request
            .expected_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || request.service.is_empty()
        || request.service.len() > 188
        || request.service.chars().any(char::is_control)
    {
        return Err(RemoteError::new(
            "CONFIG_FILE",
            "Invalid configuration validation request.",
        ));
    }
    let upload_data = if let Some(text) = &request.wayrill_text {
        if text.is_empty()
            || text.len() > 16 * 1024 * 1024
            || request
                .expected_wayrill_sha256
                .as_ref()
                .is_some_and(|hash| {
                    hash.len() != 64
                        || !hash
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                })
        {
            return Err(RemoteError::new(
                "CONFIG_FILE",
                "Invalid companion document or source hash.",
            ));
        }
        serde_json::to_vec(
            &serde_json::json!({"configText":request.config_text,"wayrillText":text}),
        )
        .map_err(|_| RemoteError::new("CONFIG_FILE", "Cannot encode graph upload."))?
    } else {
        request.config_text.as_bytes().to_vec()
    };
    if upload_data.len() > 64 * 1024 * 1024 {
        return Err(RemoteError::new(
            "CONFIG_FILE",
            "The encoded Xray and Wayrill upload exceeds 64 MiB.",
        ));
    }
    let prepared = run(&operation, session, &python_command(CONFIG_UPLOAD)?, false)?;
    let content = frame(
        &prepared,
        b"WAYRILL_REMOTE_UPLOAD_V1_BEGIN",
        b"WAYRILL_REMOTE_UPLOAD_V1_END",
    )
    .ok_or_else(|| {
        RemoteError::new(
            "CONFIG_UPLOAD",
            "The server could not prepare a private configuration upload.",
        )
    })?;
    let upload: serde_json::Value = serde_json::from_slice(content)
        .map_err(|_| RemoteError::new("CONFIG_UPLOAD", "Invalid upload response."))?;
    let upload_path = upload["path"].as_str().unwrap_or_default();
    if !upload_path.starts_with("/tmp/wayrill-config-")
        || !upload_path.ends_with("/candidate.json")
        || upload_path.len() > 256
        || upload_path.contains("..")
        || !upload_path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
    {
        return Err(RemoteError::new(
            "CONFIG_UPLOAD",
            "Invalid private upload path.",
        ));
    }
    let local = ConfigUpload::new(&upload_data)?;
    run(&operation, session, &format!("put -transfer=binary -resumesupport=off -nopreservetime -permissions=600 \"{}\" \"{}\"", local.0.display(), upload_path), false)?;
    let mut value = serde_json::to_value(&request)
        .map_err(|_| RemoteError::new("CONFIG_FILE", "Cannot encode configuration draft."))?;
    value.as_object_mut().unwrap().remove("configText");
    value.as_object_mut().unwrap().remove("wayrillText");
    value["hasWayrill"] = serde_json::json!(request.wayrill_text.is_some());
    value["uploadPath"] = serde_json::json!(upload_path);
    value["mode"] = serde_json::json!("validateConfig");
    let response = action_call(operation, session, value)?;
    let validation: ConfigValidation = serde_json::from_value(response["validation"].clone())
        .map_err(|_| {
            RemoteError::new(
                "CONFIG_VALIDATION",
                "Unrecognized configuration validation response.",
            )
        })?;
    if validation.version != 1
        || validation.path != request.path
        || validation.service != request.service
        || validation.config_sha256
            != format!("{:x}", Sha256::digest(request.config_text.as_bytes()))
        || validation.source_sha256 != request.expected_sha256
        || validation.expires_at <= validation.checked_at
        || validation.logs.len() > 40
        || validation.logs.iter().any(|line| line.len() > 2000)
        || (request.stage && validation.valid && validation.id.is_none())
    {
        return Err(RemoteError::new(
            "CONFIG_VALIDATION",
            "The server returned inconsistent validation details.",
        ));
    }
    if let Some(id) = &validation.id {
        validate_job_id(id)?;
    }
    Ok(validation)
}

struct ConfigUpload(std::path::PathBuf);
impl ConfigUpload {
    fn new(data: &[u8]) -> Result<Self> {
        let root = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| {
                RemoteError::new(
                    "CONFIG_UPLOAD",
                    "Windows did not provide a private user folder.",
                )
            })?
            .join("app.wayrill.aquifer/uploads");
        std::fs::create_dir_all(&root).map_err(|_| {
            RemoteError::new("CONFIG_UPLOAD", "Cannot prepare the private upload folder.")
        })?;
        for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_string_lossy().starts_with("draft-")
                && entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age.as_secs() > 3600)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = root.join(format!("draft-{}-{nonce}.json", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| {
                RemoteError::new("CONFIG_UPLOAD", "Cannot create a private upload file.")
            })?;
        let upload = Self(path);
        file.write_all(data)
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                RemoteError::new("CONFIG_UPLOAD", "Cannot write the configuration upload.")
            })?;
        Ok(upload)
    }
}
impl Drop for ConfigUpload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn parse_plan(value: serde_json::Value) -> Result<UpgradePlan> {
    let plan: UpgradePlan = serde_json::from_value(value["plan"].clone())
        .map_err(|_| RemoteError::new("APT_PLAN", "Unrecognized full-upgrade preview."))?;
    validate_job_id(&plan.id)?;
    if plan.version != 1
        || plan.expires_at <= plan.created_at
        || plan.installs.len() + plan.upgrades.len() + plan.removals.len() > 4096
    {
        return Err(RemoteError::new(
            "APT_PLAN",
            "The full-upgrade plan exceeded its limits.",
        ));
    }
    Ok(plan)
}
fn action_response(output: &[u8]) -> Result<serde_json::Value> {
    let content = frame(
        output,
        b"WAYRILL_REMOTE_ACTION_V1_BEGIN",
        b"WAYRILL_REMOTE_ACTION_V1_END",
    )
    .filter(|v| v.len() <= 2 * 1024 * 1024)
    .ok_or_else(|| {
        RemoteError::new(
            "ACTION",
            "No server job response. Reconnect to inspect progress before retrying.",
        )
    })?;
    let value: serde_json::Value = serde_json::from_slice(content)
        .map_err(|_| RemoteError::new("ACTION", "Unrecognized server job response."))?;
    if let Some(error) = value.get("error") {
        let code = match error["code"].as_str() {
            Some("SUDO") => "SUDO",
            Some("JOB_NOT_FOUND") => "JOB_NOT_FOUND",
            Some("JOB_BUSY") => "JOB_BUSY",
            Some("APT_PLAN") => "APT_PLAN",
            Some("PLAN_EXPIRED") => "PLAN_EXPIRED",
            Some("PLAN_CHANGED") => "PLAN_CHANGED",
            Some("CONFIG_CHANGED") => "CONFIG_CHANGED",
            Some("CONFIG_FILE") => "CONFIG_FILE",
            Some("CONFIG_TARGET") => "CONFIG_TARGET",
            Some("CONFIG_TOOLS") => "CONFIG_TOOLS",
            Some("CONFIG_PLAN") => "CONFIG_PLAN",
            Some("CONFIG_EXPIRED") => "CONFIG_EXPIRED",
            _ => "ACTION",
        };
        return Err(RemoteError::new(
            code,
            error["message"]
                .as_str()
                .unwrap_or("The server action failed.")
                .chars()
                .take(1024)
                .collect::<String>(),
        ));
    }
    Ok(value)
}
#[cfg(test)]
fn parse_job(output: &[u8]) -> Result<ServerJob> {
    parse_job_value(action_response(output)?)
}
fn parse_job_value(value: serde_json::Value) -> Result<ServerJob> {
    let job: ServerJob = serde_json::from_value(value["job"].clone())
        .map_err(|_| RemoteError::new("ACTION", "Unrecognized server job response."))?;
    validate_job_id(&job.id)?;
    if job.version != 1
        || job.percent.is_some_and(|v| v > 100)
        || job.logs.len() > 150
        || job.logs.iter().any(|v| v.len() > 2000)
        || job.stage.len() > 1024
        || job.message.len() > 4096
    {
        return Err(RemoteError::new(
            "ACTION",
            "The server job response exceeded its limits.",
        ));
    }
    if let Some(result) = &job.config_result {
        validate_job_id(&result.plan_id)?;
        if result.path.len() > 4096
            || result.backup_path.len() > 4096
            || result.service.len() > 188
            || ![&result.original_sha256, &result.installed_sha256]
                .into_iter()
                .all(|hash| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                })
            || result.wayrill_sha256.as_ref().is_some_and(|hash| {
                hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
            || !matches!(
                result.rollback.as_str(),
                "not-needed" | "succeeded" | "failed"
            )
        {
            return Err(RemoteError::new(
                "ACTION",
                "Invalid configuration deployment receipt.",
            ));
        }
    }
    Ok(job)
}

pub fn server_status(operation: Permit, session: &str) -> Result<ServerStatus> {
    let command = python_command(STATUS)?;
    let output = run(&operation, session, &command, false).map_err(|error| {
        if matches!(error.code, "SSH" | "NOT_FOUND") {
            RemoteError::new("SERVER_STATUS", "Server status requires Python 3 and SSH shell access. Configuration files can still be read through SFTP.")
        } else {
            error
        }
    })?;
    parse_status(&output)
}
fn frame<'a>(output: &'a [u8], start: &[u8], end: &[u8]) -> Option<&'a [u8]> {
    let tail = &output[output.windows(start.len()).position(|w| w == start)? + start.len()..];
    Some(&tail[..tail.windows(end.len()).position(|w| w == end)?])
}
fn parse_status(output: &[u8]) -> Result<ServerStatus> {
    let content = frame(output, b"WAYRILL_REMOTE_STATUS_V1_BEGIN", b"WAYRILL_REMOTE_STATUS_V1_END")
        .filter(|content| content.len() <= 1024 * 1024)
        .ok_or_else(|| RemoteError::new("SERVER_STATUS", "The server returned no valid status response. Python 3 and SSH shell access are required."))?;
    let status: ServerStatus = serde_json::from_slice(content).map_err(|_| {
        RemoteError::new(
            "SERVER_STATUS",
            "The server returned an unrecognized status response.",
        )
    })?;
    if status.version != 1
        || status.xray.processes.len() > 128
        || status.xray.services.len() > 128
        || status.reboot.packages.len() > 512
        || status.apt.packages.len() > 4096
        || (status.apt.error.is_none()
            && status.apt.upgraded != Some(status.apt.packages.len() as u32))
    {
        return Err(RemoteError::new("SERVER_STATUS", "The server status exceeded its result limits or contained inconsistent package counts."));
    }
    Ok(status)
}

pub fn discover(operation: Permit, session: &str) -> Result<Discovery> {
    let command = python_command(DISCOVERY)?;
    let output = run(&operation, session, &command, false).map_err(|error| {
        if matches!(error.code, "SSH" | "NOT_FOUND") {
            RemoteError::new("DISCOVERY", "Automatic discovery could not run in this SSH shell. Python 3 and shell-command access are required.")
        } else {
            error
        }
    })?;
    parse_discovery(&output)
}
fn parse_discovery(output: &[u8]) -> Result<Discovery> {
    let start = b"WAYRILL_REMOTE_DISCOVERY_V1_BEGIN";
    let end = b"WAYRILL_REMOTE_DISCOVERY_V1_END";
    let content = frame(output, start, end).ok_or_else(|| {
        let diagnostic = String::from_utf8_lossy(output).to_lowercase();
        let reason = if diagnostic.contains("traceback") {
            "The remote Python discovery script failed."
        } else if diagnostic.contains("python3")
            && (diagnostic.contains("not found") || diagnostic.contains("no such file"))
        {
            "Python 3 is not available in the SSH shell."
        } else {
            "The SSH shell returned no discovery result; shell-command access may be restricted."
        };
        RemoteError::new("DISCOVERY", reason)
    })?;
    // Only the framed JSON must be UTF-8. Locale-dependent console progress or
    // login banners outside it cannot corrupt an otherwise valid response.
    let result: Discovery = serde_json::from_slice(content)
        .map_err(|_| RemoteError::new("DISCOVERY", "Discovery returned an unrecognized result."))?;
    if result.version != 1 || result.files.len() > 128 || result.processes.len() > 1024 {
        return Err(RemoteError::new(
            "DISCOVERY",
            "Discovery exceeded its result limits.",
        ));
    }
    Ok(result)
}
pub fn read_config(operation: Permit, session: &str, path: &str) -> Result<ConfigSnapshot> {
    validate_path(path)?;
    let bytes = run(&operation, session, &format!("get \"{path}\" -"), true)?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let len = bytes.len();
    let text = String::from_utf8(bytes).map_err(|_| {
        RemoteError::new(
            "ENCODING",
            "The remote file is not UTF-8 JSON. Nothing was converted.",
        )
    })?;
    let companion = read_companion(&operation, session, path).unwrap_or_else(|_| WayrillCompanion {
        path: companion_path(path), sha256: None, text: None,
        error: Some("Could not inspect the Wayrill file. Check Python 3 and file access, then reconnect before saving.".into()),
    });
    Ok(ConfigSnapshot {
        companion,
        path: path.into(),
        text,
        sha256,
        bytes: len,
    })
}

fn companion_path(path: &str) -> String {
    let target = std::path::Path::new(path);
    let stem = target
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    target
        .with_file_name(format!("{stem}.wayrill.json"))
        .to_string_lossy()
        .replace('\\', "/")
}
fn read_companion(operation: &Operation, session: &str, path: &str) -> Result<WayrillCompanion> {
    let source = format!(
        "PATH={}\n{}",
        serde_json::to_string(path).unwrap(),
        include_str!("../resources/config_companion.py")
    );
    let metadata = run(operation, session, &python_command(&source)?, false)?;
    let content = frame(
        &metadata,
        b"WAYRILL_REMOTE_COMPANION_V1_BEGIN",
        b"WAYRILL_REMOTE_COMPANION_V1_END",
    )
    .ok_or_else(|| RemoteError::new("CONFIG_FILE", "Could not inspect the companion graph."))?;
    let mut companion: WayrillCompanion = serde_json::from_slice(content)
        .map_err(|_| RemoteError::new("CONFIG_FILE", "Invalid companion metadata."))?;
    validate_path(&companion.path)?;
    if !companion.path.ends_with(".wayrill.json") {
        return Err(RemoteError::new("CONFIG_FILE", "Invalid companion path."));
    }
    if let Some(expected) = &companion.sha256 {
        match run(
            operation,
            session,
            &format!("get \"{}\" -", companion.path),
            true,
        ) {
            Ok(data) if format!("{:x}", Sha256::digest(&data)) == *expected => {
                match String::from_utf8(data) {
                    Ok(text) => companion.text = Some(text),
                    Err(_) => companion.error = Some("The Wayrill file is not UTF-8.".into()),
                }
            }
            _ => {
                companion.error = Some(
                    "The Wayrill file changed or could not be downloaded. Reconnect before saving."
                        .into(),
                )
            }
        }
    }
    Ok(companion)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn companions_are_named_per_config_and_directory() {
        assert_eq!(
            companion_path("/etc/xray/config.json"),
            "/etc/xray/config.wayrill.json"
        );
        assert_eq!(
            companion_path("/etc/xray/vnc.json"),
            "/etc/xray/vnc.wayrill.json"
        );
        assert_eq!(
            companion_path("/srv/other/config.json"),
            "/srv/other/config.wayrill.json"
        );
    }
    #[test]
    fn window_title_preserves_utf8_and_matches_app_version() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["app"]["windows"][0]["title"],
            format!("Wayrill Aquifer {} · SSH / SFTP", env!("CARGO_PKG_VERSION"))
        );
    }
    #[test]
    fn full_upgrade_requires_a_plan_and_preview_is_typed() {
        let mut request = ActionRequest {
            id: "a".repeat(32),
            action: ServerAction::DistUpgrade,
            package: None,
            candidate_version: None,
            service: None,
            plan_id: None,
        };
        assert!(validate_action(&request).is_err());
        request.plan_id = Some("b".repeat(32));
        assert!(validate_action(&request).is_ok());
        let mut value = serde_json::json!({"plan":{"version":1,"id":"b".repeat(32),"hostname":"server","createdAt":1,"expiresAt":901,"installs":[],"upgrades":[],"removals":[],"heldBack":2}});
        assert_eq!(parse_plan(value.clone()).unwrap().held_back, 2);
        value["plan"]["expiresAt"] = serde_json::json!(0);
        assert!(parse_plan(value).is_err());
    }
    #[test]
    fn job_identifiers_cannot_be_paths_or_commands() {
        for id in [
            "",
            "../etc",
            "--help",
            "a\nreboot",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(validate_job_id(id).is_err());
        }
        assert!(validate_job_id("0123456789abcdef0123456789abcdef").is_ok());
    }
    #[test]
    fn config_apply_requires_a_validated_plan() {
        let mut request = ActionRequest {
            id: "a".repeat(32),
            action: ServerAction::ApplyConfig,
            package: None,
            candidate_version: None,
            service: None,
            plan_id: None,
        };
        assert!(validate_action(&request).is_err());
        request.plan_id = Some("b".repeat(32));
        assert!(validate_action(&request).is_ok());
    }
    #[test]
    fn private_sftp_upload_preserves_utf8_and_is_removed_after_use() {
        let bytes = "{\"name\":\"Тест 配置\"}\r\n".as_bytes();
        let upload = ConfigUpload::new(bytes).unwrap();
        let path = upload.0.clone();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        drop(upload);
        assert!(!path.exists());
    }
    #[test]
    fn server_job_response_is_typed_and_bounded() {
        let job = serde_json::json!({"version":1,"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"refreshApt",
            "state":"running","stage":"Downloading","percent":25,"message":"","logs":[],"createdAt":1,"updatedAt":2,"bootId":"before"});
        let framed = |v: &serde_json::Value| {
            format!("noise\nWAYRILL_REMOTE_ACTION_V1_BEGIN\n{v}\nWAYRILL_REMOTE_ACTION_V1_END")
        };
        assert_eq!(
            parse_job(framed(&serde_json::json!({"job":job})).as_bytes())
                .unwrap()
                .state,
            JobState::Running
        );
        let mut bad = job.clone();
        bad["percent"] = serde_json::json!(101);
        assert!(parse_job(framed(&serde_json::json!({"job":bad})).as_bytes()).is_err());
        assert!(parse_job(b"unframed private console output").is_err());
        let error = parse_job(framed(&serde_json::json!({"error":{"code":"SUDO","message":"Noninteractive sudo required"}})).as_bytes()).unwrap_err();
        assert_eq!(error.code, "SUDO");
    }
    #[test]
    fn connection_failures_are_not_host_key_recommendations() {
        let recommendation =
            "open sftp://root@example/ -hostkey=\"key\" -privatekey=\"password-file\"\nwinscp> get \"/etc/passwords.json\" -\n";
        for (message, code) in [
            ("Server unexpectedly closed network connection.", "CONNECT"),
            ("Authentication failed.", "AUTH"),
            ("Host key does not match configured key.", "HOST_KEY"),
            ("The host key is not cached.", "HOST_KEY"),
            ("No such file.", "NOT_FOUND"),
        ] {
            assert_eq!(
                connection_error(format!("{recommendation}{message}").as_bytes()).code,
                code
            );
        }
    }
    fn status_frame(value: &serde_json::Value) -> Vec<u8> {
        format!(
            "console\nWAYRILL_REMOTE_STATUS_V1_BEGIN\n{}\nWAYRILL_REMOTE_STATUS_V1_END\n",
            value
        )
        .into_bytes()
    }
    fn status_fixture() -> serde_json::Value {
        serde_json::json!({"version":1,"hostname":"server","checkedAt":100,"user":"tester","uid":1000,
            "reboot":{"required":null,"packages":[],"error":"Permission denied"},
            "xray":{"processes":[],"services":[],"error":"No systemd"},
            "apt":{"available":true,"packages":[],"upgraded":0,"heldBack":2,"indexesUpdatedAt":90,"error":null}})
    }
    #[test]
    fn server_status_accepts_independent_partial_results_and_console_noise() {
        let mut bytes = vec![0xff];
        bytes.extend(status_frame(&status_fixture()));
        let status = parse_status(&bytes).unwrap();
        assert!(status.reboot.required.is_none());
        assert_eq!(status.apt.upgraded, Some(0));
        assert_eq!(status.apt.held_back, Some(2));
        assert_eq!(status.uid, 1000);
    }
    #[test]
    fn server_status_rejects_inconsistent_and_malformed_results() {
        assert!(parse_status(b"arbitrary-private-output").is_err());
        let mut value = status_fixture();
        value["apt"]["upgraded"] = serde_json::json!(1);
        assert!(parse_status(&status_frame(&value)).is_err());
        value["apt"]["upgraded"] = serde_json::json!(0);
        value["version"] = serde_json::json!(2);
        assert!(parse_status(&status_frame(&value)).is_err());
    }
    #[test]
    fn discovery_frame_ignores_console_encoding_and_surrounding_output() {
        let mut output = vec![0xff, 0x80];
        output.extend(b"\r\nWAYRILL_REMOTE_DISCOVERY_V1_BEGIN\r\n{\"version\":1,\"hostname\":\"server\",\"processes\":[],\"files\":[],\"warnings\":[]}\r\nWAYRILL_REMOTE_DISCOVERY_V1_END\r\nDone");
        assert_eq!(parse_discovery(&output).unwrap().hostname, "server");
    }
    #[test]
    fn discovery_errors_do_not_echo_arbitrary_console_data() {
        for output in [
            b"python3: command not found".as_slice(),
            b"Traceback: private-sentinel".as_slice(),
            b"WAYRILL_REMOTE_DISCOVERY_V1_BEGIN private-sentinel".as_slice(),
            b"WAYRILL_REMOTE_DISCOVERY_V1_BEGIN private-sentinel WAYRILL_REMOTE_DISCOVERY_V1_END"
                .as_slice(),
        ] {
            let error = parse_discovery(output).unwrap_err();
            assert_eq!(error.code, "DISCOVERY");
            assert!(!error.message.contains("private-sentinel"));
        }
    }
    #[test]
    fn paths_cannot_inject_commands_or_expand_files() {
        for p in [
            "relative.json",
            "/etc/a\nput secret",
            "/etc/*.json",
            "/etc/a\" -delete",
            "/etc/?",
            "/etc/[abc].json",
        ] {
            assert!(validate_path(p).is_err());
        }
        for p in [
            "/usr/local/etc/xray/config.json",
            "/etc/Каталог с пробелом/配置.json",
            "/etc/name;echo.json",
        ] {
            assert!(validate_path(p).is_ok());
        }
    }
    #[test]
    fn operation_is_exclusive_and_reusable() {
        let op = Arc::new(Operation::default());
        let first = op.acquire().unwrap();
        assert!(op.acquire().is_err());
        op.cancel();
        drop(first);
        let _second = op.acquire().unwrap();
        assert!(!op.cancel.load(Ordering::Acquire));
    }
    #[test]
    fn shutdown_cannot_be_undone_by_acquiring_another_operation() {
        let op = Arc::new(Operation::default());
        op.shutdown();
        assert!(op.acquire().is_err());
        assert!(op.check_cancelled().is_err());
    }
    #[test]
    fn cancelling_a_queued_worker_cannot_be_cleared_when_it_starts() {
        let op = Arc::new(Operation::default());
        let request = op.acquire().unwrap();
        op.cancel();
        let code = std::thread::spawn(move || request.check_cancelled().unwrap_err().code)
            .join()
            .unwrap();
        assert_eq!(code, "CANCELLED");
        assert!(op.acquire().unwrap().check_cancelled().is_ok());
    }
    #[test]
    fn compressed_probes_fit_the_persistent_console_input_buffer() {
        for source in [STATUS, DISCOVERY] {
            let command = python_command(source).unwrap();
            assert!(command.encode_utf16().count() < 10000);
            assert!(!command.contains(['\n', '\r']));
        }
    }
    #[test]
    fn discovery_does_not_have_write_commands() {
        assert!(!DISCOVERY.contains("subprocess"));
        assert!(!DISCOVERY.contains("os.system"));
        assert!(!DISCOVERY.contains("'wb'"));
        assert!(!DISCOVERY.contains("'w'"));
    }
}
