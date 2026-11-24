use crate::{events::Events, native::wide, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use wayrill_protocol::{params, ApiError, Result};
pub const MAX: usize = 128 * 1024 * 1024;
const MAX_BATCH: usize = 256 * 1024 * 1024;
const PACKAGED_PREFIXES: [&str; 4] = ["", "ru-", "ir-", "cn-"];
pub(crate) fn canonical_name(file: &str) -> &str {
    match file {
        "russian-geoip.dat" => "ru-geoip.dat",
        "russian-geosite.dat" => "ru-geosite.dat",
        _ => file,
    }
}
fn plan_id(file: &str) -> String {
    if PACKAGED_PREFIXES.iter().any(|prefix| {
        ["geoip", "geosite"]
            .iter()
            .any(|kind| file == format!("{prefix}{kind}.dat"))
    }) {
        return format!("packaged-{}", file.trim_end_matches(".dat"));
    }
    file.strip_prefix("wayrill-")
        .and_then(|name| name.strip_suffix(".dat"))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "file-{}",
                crate::system_native::hex(&Sha256::digest(file.as_bytes()))
            )
        })
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn invalid(message: &str) -> ApiError {
    ApiError::new("RESOURCE_INVALID", message)
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilePlan {
    #[serde(default)]
    pub id: String,
    pub file: String,
    pub kind: String,
    pub url: String,
    pub auto_update: bool,
    pub interval_hours: u32,
    pub fetch_on_use: bool,
    #[serde(default)]
    pub through_wayrill: bool,
}
pub(crate) fn download_files(
    files: &[FilePlan],
    stop: &AtomicBool,
    proxy_port: Option<u16>,
) -> Result<Vec<(FilePlan, Vec<u8>)>> {
    let mut total = 0;
    files
        .iter()
        .map(|plan| {
            let bytes = download_file(plan, stop, proxy_port)?;
            Ok((plan.clone(), count_download(bytes, &mut total)?))
        })
        .collect()
}

fn download_file(plan: &FilePlan, stop: &AtomicBool, proxy_port: Option<u16>) -> Result<Vec<u8>> {
    let result = (|| {
        if stop.load(Ordering::Acquire) {
            return Err(invalid("Resource update canceled."));
        }
        let proxy = if plan.through_wayrill {
            Some(proxy_port.ok_or_else(|| {
                ApiError::new(
                    "RESOURCE_PROXY",
                    "Start an HTTP-compatible loopback proxy inbound to download through Wayrill.",
                )
            })?)
        } else {
            None
        };
        let bytes = crate::resource_download::fetch(&plan.url, stop, proxy)?;
        validate_dat(&bytes, &plan.kind)?;
        Ok(bytes)
    })();
    result.map_err(|mut error| {
        error.message = format!("{}: {}", plan.file, error.message);
        error
    })
}

fn count_download(bytes: Vec<u8>, total: &mut usize) -> Result<Vec<u8>> {
    if bytes.len() > MAX_BATCH - *total {
        return Err(invalid(
            "Resource update batch exceeds 256 MiB. Update fewer files at once.",
        ));
    }
    *total += bytes.len();
    Ok(bytes)
}
pub(crate) fn valid_name(name: &str) -> bool {
    name.len() <= 200
        && name.ends_with(".dat")
        && name[..name.len() - 4]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && name.len() > 4
        && !matches!(
            name[..name.len() - 4].to_ascii_uppercase().as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
}
pub fn validate_plans(files: &[FilePlan]) -> Result<()> {
    if files.len() > 256 {
        return Err(invalid("At most 256 resource files are allowed."));
    }
    let mut names = BTreeMap::new();
    let mut ids = BTreeMap::new();
    for p in files {
        if (!p.id.is_empty()
            && (p.id.len() > 80
                || !p
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                || ids.insert(&p.id, ()).is_some()))
            || !valid_name(&p.file)
            || !["geoip", "geosite"].contains(&p.kind.as_str())
            || !(1..=8760).contains(&p.interval_hours)
            || names.insert(p.file.to_lowercase(), ()).is_some()
        {
            return Err(invalid(
                "Invalid or duplicate resource filename, type or update period.",
            ));
        }
        if !p.url.is_empty() {
            validate_url(&p.url)?;
        } else if p.auto_update || p.fetch_on_use {
            return Err(invalid("Disk files cannot auto-update."));
        }
    }
    Ok(())
}
pub fn validate_url(text: &str) -> Result<url::Url> {
    let url = url::Url::parse(text).map_err(|_| invalid("Enter a valid HTTPS resource URL."))?;
    if text.len() > 8192
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "Resource URLs require HTTPS without login credentials or fragments.",
        ));
    }
    Ok(url)
}
// Bound the protobuf walk, validate both wire structure and the dataset type.
fn varint(data: &[u8], pos: &mut usize) -> Result<u64> {
    let mut n = 0u64;
    for shift in (0..70).step_by(7) {
        let b = *data
            .get(*pos)
            .ok_or_else(|| invalid("Truncated DAT file."))?;
        *pos += 1;
        if shift == 63 && b > 1 {
            return Err(invalid("Invalid DAT integer."));
        }
        n |= ((b & 127) as u64) << shift;
        if b & 128 == 0 {
            return Ok(n);
        }
    }
    Err(invalid("Invalid DAT integer."))
}
pub(crate) struct Fields<'a> {
    data: &'a [u8],
    pos: usize,
}
pub(crate) fn fields(data: &[u8]) -> Fields<'_> {
    Fields { data, pos: 0 }
}
impl<'a> Iterator for Fields<'a> {
    type Item = Result<(u64, u64, &'a [u8], u64)>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.data.len() {
            return None;
        }
        let result = (|| {
            let key = varint(self.data, &mut self.pos)?;
            let (wire, field) = (key & 7, key >> 3);
            if field == 0 || field > 0x1fff_ffff {
                return Err(invalid("Invalid DAT field."));
            }
            let mut number = 0;
            let bytes = match wire {
                0 => {
                    number = varint(self.data, &mut self.pos)?;
                    &self.data[self.pos..self.pos]
                }
                1 | 5 | 2 => {
                    let n = if wire == 2 {
                        usize::try_from(varint(self.data, &mut self.pos)?)
                            .map_err(|_| invalid("Invalid DAT length."))?
                    } else if wire == 1 {
                        8
                    } else {
                        4
                    };
                    let end = self
                        .pos
                        .checked_add(n)
                        .filter(|e| *e <= self.data.len())
                        .ok_or_else(|| invalid("Truncated DAT file."))?;
                    let bytes = &self.data[self.pos..end];
                    self.pos = end;
                    bytes
                }
                _ => return Err(invalid("Unsupported DAT wire format.")),
            };
            Ok((field, wire, bytes, number))
        })();
        if result.is_err() {
            self.pos = self.data.len();
        }
        Some(result)
    }
}
pub fn validate_dat(data: &[u8], kind: &str) -> Result<usize> {
    validate_dat_interruptible(data, kind, || Ok(()))
}

pub(crate) fn validate_dat_interruptible(
    data: &[u8],
    kind: &str,
    check: impl Fn() -> Result<()>,
) -> Result<usize> {
    if data.is_empty() || data.len() > MAX {
        return Err(invalid("DAT files must be nonempty and at most 128 MiB."));
    }
    if !["geoip", "geosite"].contains(&kind) {
        return Err(invalid("Choose GeoIP or GeoSite."));
    }
    let mut records = 0;
    for item in fields(data) {
        check()?;
        let (field, wire, entry, _) = item?;
        if field != 1 {
            continue;
        }
        if wire != 2 {
            return Err(invalid("Invalid DAT dataset."));
        }
        let mut code = false;
        for (index, item) in fields(entry).enumerate() {
            if index.is_multiple_of(1024) {
                check()?;
            }
            let (f, w, content, _) = item?;
            if f == 1 {
                code = w == 2
                    && !content.is_empty()
                    && content.len() <= 128
                    && std::str::from_utf8(content).is_ok();
            }
            if f == 2 {
                if w != 2 {
                    return Err(invalid("Invalid DAT record."));
                }
                if content.len() > 1024 * 1024 {
                    return Err(invalid("DAT record exceeds 1 MiB."));
                }
                // Singular protobuf fields use their last occurrence. Validate
                // the same effective values that Xray and the browser consume,
                // without retaining a separate allocation for every record.
                let (value_field, number_field) = if kind == "geoip" { (1, 2) } else { (2, 1) };
                let mut value = None;
                let mut number = 0;
                for (index, item) in fields(content).enumerate() {
                    if index >= 65536 {
                        return Err(invalid("DAT record has too many fields."));
                    }
                    if index > 0 && index.is_multiple_of(1024) {
                        check()?;
                    }
                    let (field, wire, bytes, n) = item?;
                    if field == value_field {
                        if wire != 2 || (kind == "geosite" && std::str::from_utf8(bytes).is_err()) {
                            return Err(invalid("Invalid DAT record value."));
                        }
                        value = Some(bytes);
                    } else if field == number_field {
                        if wire != 0 {
                            return Err(invalid("Invalid DAT record number."));
                        }
                        number = n;
                    }
                }
                let valid = if kind == "geoip" {
                    value.is_some_and(|ip| match ip.len() {
                        4 => number <= 32,
                        16 => number <= 128,
                        _ => false,
                    })
                } else {
                    number <= 3 && value.is_some_and(|domain| !domain.is_empty())
                };
                if !valid {
                    return Err(invalid("Invalid GeoIP/GeoSite DAT record."));
                }
            }
        }
        if !code {
            return Err(invalid("DAT entries need a valid group name."));
        }
        records += 1;
    }
    if records == 0 {
        return Err(invalid("The DAT file contains no groups."));
    }
    Ok(records)
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    updated_at_ms: u64,
    #[serde(default)]
    content_generation: u64,
    last_attempt_ms: u64,
    #[serde(default)]
    last_attempt_url: String,
    bytes: usize,
    sha256: String,
    last_error: Option<String>,
    source_url: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Stored {
    files: Vec<FilePlan>,
    metadata: BTreeMap<String, Metadata>,
    generation: u64,
    reload_generation: u64,
    reload_after_auto_updates: bool,
    file_aliases: BTreeMap<String, String>,
}
impl Default for Stored {
    fn default() -> Self {
        Self {
            files: Vec::new(),
            metadata: BTreeMap::new(),
            generation: 0,
            reload_generation: 0,
            reload_after_auto_updates: true,
            file_aliases: BTreeMap::new(),
        }
    }
}
struct State {
    stored: Stored,
    busy: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleVersion {
    instance_id: String,
    revision: u64,
}
struct Upload {
    file: String,
    kind: String,
    bytes: usize,
    received: usize,
    path: PathBuf,
    last_activity: Instant,
}

const UPLOAD_LEASE: Duration = Duration::from_secs(300);
const UPLOAD_RECEIPTS: usize = 16;

enum UploadPhase {
    Prepared(Instant),
    Receiving(Upload),
    Complete { result: Result<()>, at: Instant },
    Cancelled(Instant),
}
#[derive(Serialize, Deserialize)]
struct Journal {
    files: Vec<(String, bool)>,
    previous: Stored,
    #[serde(default)]
    renames: Vec<Rename>,
}
#[derive(Serialize, Deserialize)]
struct Rename {
    from: String,
    to: String,
    sha256: String,
}
pub struct Manager {
    browser: crate::geodata::Browser,
    catalogues: crate::resource_rules::Catalogues,
    assets: PathBuf,
    data: PathBuf,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    events: Arc<Events>,
    uploads: BTreeMap<String, UploadPhase>,
    schedule_revision: u64,
    worker: Option<std::thread::JoinHandle<()>>,
    launch_retry: Option<LaunchRetry>,
    proxy_port: Option<u16>,
}
struct LaunchRetry {
    at: Instant,
    files: Vec<String>,
    message: String,
}
fn move_file(from: &Path, to: &Path) -> Result<()> {
    unsafe {
        if windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            wide(&from.to_string_lossy()).as_ptr(),
            wide(&to.to_string_lossy()).as_ptr(),
            windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err(crate::native::os_error("Replace resource file"));
        }
    }
    Ok(())
}
fn clear_completed_stage(assets: &Path, files: &[(String, bool)]) {
    let stage = assets.join(".wayrill-resource-stage");
    for (name, _) in files {
        if valid_name(name) {
            for suffix in ["old", "new"] {
                let _ = fs::remove_file(stage.join(format!("{name}.{suffix}")));
            }
        }
    }
}
fn recover(assets: &Path, data: &Path) -> Result<Option<Stored>> {
    if let Some(journal) = storage::read::<Journal>(&data.join("resources-transaction.json"))? {
        for rename in journal.renames.iter().rev() {
            if !valid_name(&rename.from) || !valid_name(&rename.to) {
                return Err(invalid("Invalid resource rename journal."));
            }
            let from = assets.join(&rename.from);
            let to = assets.join(&rename.to);
            if to.exists() {
                if from.exists() && !rename.from.eq_ignore_ascii_case(&rename.to) {
                    return Err(invalid(
                        "Resource rename recovery found an occupied original filename.",
                    ));
                }
                crate::native::verify_hash(&to, &rename.sha256)?;
                fs::rename(to, from).map_err(|e| ApiError::io("Restore resource filename", e))?;
            } else if !from.exists() {
                return Err(invalid("Resource rename recovery cannot find the file."));
            }
        }
        for (name, existed) in &journal.files {
            if !valid_name(name) {
                return Err(invalid("Invalid resource recovery journal."));
            }
            let target = assets.join(name);
            let old = assets
                .join(".wayrill-resource-stage")
                .join(format!("{name}.old"));
            if *existed {
                fs::copy(&old, assets.join(format!("{name}.restore")))
                    .map_err(|e| ApiError::io("Restore resource backup", e))?;
                move_file(&assets.join(format!("{name}.restore")), &target)?;
            } else if target.exists() {
                fs::remove_file(target).map_err(|e| ApiError::io("Restore resource state", e))?;
            }
        }
        storage::write(&data.join("resources.json"), &journal.previous)?;
        storage::remove(&data.join("resources-transaction.json"))?;
        clear_completed_stage(assets, &journal.files);
        return Ok(Some(journal.previous));
    }
    Ok(None)
}
fn recover_stored(assets: &Path, data: &Path, stored: &mut Stored) -> Result<()> {
    if let Some(previous) = recover(assets, data)? {
        *stored = previous;
    }
    Ok(())
}
fn commit(
    assets: &Path,
    data: &Path,
    items: &[(FilePlan, Vec<u8>)],
    stop: &AtomicBool,
    reload: bool,
    stored: &mut Stored,
) -> Result<()> {
    // A failed inverse retains the only trustworthy backups. Never replace its
    // journal or stage another batch until that inverse has completed.
    recover_stored(assets, data, stored)?;
    let stage = assets.join(".wayrill-resource-stage");
    fs::create_dir_all(&stage).map_err(|e| ApiError::io("Stage resources", e))?;
    let mut journal = Journal {
        files: Vec::new(),
        previous: stored.clone(),
        renames: Vec::new(),
    };
    let mut metadata = Vec::new();
    let staged = (|| -> Result<()> {
        for (plan, bytes) in items {
            validate_dat(bytes, &plan.kind)?;
            let target = assets.join(&plan.file);
            let hash = crate::system_native::hex(&Sha256::digest(bytes));
            let unchanged = crate::native::verify_hash(&target, &hash).is_ok();
            metadata.push((
                plan.file.clone(),
                Metadata {
                    source_url: plan.url.clone(),
                    updated_at_ms: now(),
                    last_attempt_ms: now(),
                    last_attempt_url: plan.url.clone(),
                    bytes: bytes.len(),
                    sha256: hash,
                    last_error: None,
                    content_generation: if unchanged {
                        stored
                            .metadata
                            .get(&plan.file)
                            .map_or(0, |m| m.content_generation)
                    } else {
                        stored
                            .generation
                            .checked_add(1)
                            .ok_or_else(|| invalid("Resource generation is exhausted."))?
                    },
                },
            ));
            if unchanged {
                continue;
            }
            journal.files.push((plan.file.clone(), target.exists()));
            if target.exists() {
                fs::copy(&target, stage.join(format!("{}.old", plan.file)))
                    .map_err(|e| ApiError::io("Back up resource", e))?;
            }
            let path = stage.join(format!("{}.new", plan.file));
            let mut file = fs::File::create(path).map_err(|e| ApiError::io("Stage resource", e))?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| ApiError::io("Flush resource", e))?;
        }
        storage::write(&data.join("resources-transaction.json"), &journal)
    })();
    if let Err(error) = staged {
        // No installed file changes before the journal commits. Failed staging
        // must not retain large, unjournaled backups and partial downloads.
        clear_completed_stage(assets, &journal.files);
        return Err(error);
    }
    for (name, _) in &journal.files {
        let outcome = if stop.load(Ordering::SeqCst) {
            Err(invalid("Resource update canceled during shutdown."))
        } else {
            move_file(&stage.join(format!("{name}.new")), &assets.join(name))
        };
        if let Err(error) = outcome {
            let _ = recover(assets, data)?;
            return Err(error);
        }
    }
    let mut next = stored.clone();
    for (name, m) in metadata {
        next.metadata.insert(name, m);
    }
    if !journal.files.is_empty() {
        next.generation = stored
            .generation
            .checked_add(1)
            .ok_or_else(|| invalid("Resource generation is exhausted."))?;
    }
    if reload {
        next.reload_generation = next.generation;
    }
    let outcome = storage::write(&data.join("resources.json"), &next)
        .and_then(|_| storage::remove(&data.join("resources-transaction.json")));
    if let Err(error) = outcome {
        let _ = recover(assets, data)?;
        return Err(error);
    }
    *stored = next;
    clear_completed_stage(assets, &journal.files);
    Ok(())
}

#[derive(Default)]
struct RefreshBatch {
    fetched: Vec<(FilePlan, Vec<u8>)>,
    failed: Vec<(FilePlan, ApiError)>,
}

impl RefreshBatch {
    fn download(files: Vec<FilePlan>, mut fetch: impl FnMut(&FilePlan) -> Result<Vec<u8>>) -> Self {
        let mut batch = Self::default();
        let mut total = 0;
        for plan in files {
            match fetch(&plan).and_then(|bytes| count_download(bytes, &mut total)) {
                Ok(bytes) => batch.fetched.push((plan, bytes)),
                Err(error) => batch.failed.push((plan, error)),
            }
        }
        batch
    }

    fn install(
        self,
        assets: &Path,
        data: &Path,
        stop: &AtomicBool,
        reload: bool,
        stored: &mut Stored,
    ) -> (Vec<String>, Vec<String>) {
        let mut failed = self.failed;
        let mut updated = Vec::new();
        if !self.fetched.is_empty() {
            let result = if stop.load(Ordering::Acquire) {
                Err(invalid("Resource update canceled during shutdown."))
            } else {
                commit(assets, data, &self.fetched, stop, reload, stored)
            };
            for (plan, _) in self.fetched {
                match &result {
                    Ok(()) => updated.push(plan.file),
                    Err(error) => failed.push((plan, error.clone())),
                }
            }
        }
        if !failed.is_empty() && !stop.load(Ordering::Acquire) {
            let completed_at = now();
            for (plan, error) in &failed {
                let metadata = stored.metadata.entry(plan.file.clone()).or_default();
                metadata.last_attempt_ms = completed_at;
                metadata.last_attempt_url.clone_from(&plan.url);
                metadata.last_error = Some(error.message.clone());
            }
            // A pending rollback owns the on-disk metadata until recovery completes.
            if !data.join("resources-transaction.json").exists() {
                if let Err(error) = storage::write(&data.join("resources.json"), stored) {
                    crate::diagnostics::error!(
                        "Could not save resource update errors: {}",
                        error.message
                    );
                }
            }
        }
        (
            updated,
            failed.into_iter().map(|(plan, _)| plan.file).collect(),
        )
    }
}

impl Manager {
    pub fn new(assets: PathBuf, data: PathBuf, events: Arc<Events>) -> Result<Self> {
        let restored = recover(&assets, &data)?;
        let mut stored = match restored {
            Some(previous) => previous,
            None => storage::read::<Stored>(&data.join("resources.json"))?.unwrap_or_default(),
        };
        for file in &mut stored.files {
            file.file = canonical_name(&file.file).to_owned();
            if file.id.is_empty() {
                file.id = plan_id(&file.file);
            }
        }
        for old in ["russian-geoip.dat", "russian-geosite.dat"] {
            if let Some(metadata) = stored.metadata.remove(old) {
                stored
                    .metadata
                    .entry(canonical_name(old).to_owned())
                    .or_insert(metadata);
            }
        }
        validate_plans(&stored.files)?;
        Ok(Self {
            browser: crate::geodata::Browser::new(assets.clone()),
            catalogues: crate::resource_rules::Catalogues::default(),
            assets,
            data,
            state: Arc::new(Mutex::new(State {
                stored,
                busy: false,
            })),
            stop: Arc::new(AtomicBool::new(false)),
            events,
            uploads: BTreeMap::new(),
            schedule_revision: 0,
            worker: None,
            launch_retry: None,
            proxy_port: None,
        })
    }
    fn reconcile(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        recover_stored(&self.assets, &self.data, &mut state.stored)
    }
    fn upload_active(&self) -> bool {
        self.uploads
            .values()
            .any(|phase| matches!(phase, UploadPhase::Receiving(_)))
    }
    fn expire_uploads(&mut self, now: Instant) {
        self.uploads.retain(|_, phase| match phase {
            UploadPhase::Prepared(at)
            | UploadPhase::Complete { at, .. }
            | UploadPhase::Cancelled(at) => now.duration_since(*at) < UPLOAD_LEASE,
            UploadPhase::Receiving(upload) => {
                if now.duration_since(upload.last_activity) >= UPLOAD_LEASE {
                    let _ = fs::remove_file(&upload.path);
                    *phase = UploadPhase::Cancelled(now);
                }
                true
            }
        });
    }
    fn prepare_upload(&mut self) -> Result<String> {
        let now = Instant::now();
        self.expire_uploads(now);
        if self.uploads.len() >= UPLOAD_RECEIPTS {
            let oldest_receipt = self
                .uploads
                .iter()
                .filter_map(|(token, phase)| match phase {
                    UploadPhase::Complete { at, .. } | UploadPhase::Cancelled(at) => {
                        Some((token, at))
                    }
                    _ => None,
                })
                .min_by_key(|(_, at)| **at)
                .map(|(token, _)| token.clone());
            if let Some(token) = oldest_receipt {
                self.uploads.remove(&token);
            } else {
                return Err(ApiError::new("BUSY", "Too many pending DAT imports."));
            }
        }
        let token = crate::tun::random_id()?;
        self.uploads
            .insert(token.clone(), UploadPhase::Prepared(now));
        Ok(token)
    }
    pub fn project(&mut self, config: &Value) -> Result<crate::resource_rules::Projection> {
        let mut state = self.state.lock().unwrap();
        if state.busy {
            return Err(ApiError::new(
                "BUSY",
                "Wait for the resource update to finish.",
            ));
        }
        recover_stored(&self.assets, &self.data, &mut state.stored)?;
        let generation = state.stored.generation;
        let aliases = state.stored.file_aliases.clone();
        drop(state);
        let config = crate::resource_rules::resolve_aliases(config, &aliases);
        self.catalogues.project(&self.assets, &config, generation)
    }
    pub fn uses(&self, config: &Value, files: &[String]) -> bool {
        let aliases = self.state.lock().unwrap().stored.file_aliases.clone();
        crate::resource_rules::uses_resources(
            &crate::resource_rules::resolve_aliases(config, &aliases),
            files,
        )
    }
    pub(crate) fn missing_pool_files(
        &self,
        config: &Value,
        plans: Vec<FilePlan>,
    ) -> Result<Vec<FilePlan>> {
        validate_plans(&plans)?;
        let s = self.state.lock().unwrap();
        let config = crate::resource_rules::resolve_aliases(config, &s.stored.file_aliases);
        let mut missing = Vec::new();
        for plan in plans {
            if self.assets.join(&plan.file).is_file()
                || !crate::resource_rules::uses_resources(&config, std::slice::from_ref(&plan.file))
            {
                continue;
            }
            let plan = s
                .stored
                .files
                .iter()
                .find(|file| file.file.eq_ignore_ascii_case(&plan.file) && file.kind == plan.kind)
                .cloned()
                .unwrap_or(plan);
            if plan.url.is_empty() {
                return Err(ApiError::new(
                    "POOL_RESOURCES",
                    format!(
                        "Import {} in Resource files before applying this Pool graph.",
                        plan.file
                    ),
                ));
            }
            missing.push(plan);
        }
        Ok(missing)
    }
    pub(crate) fn install_pool_files(
        &mut self,
        config: &Value,
        mut files: Vec<(FilePlan, Vec<u8>)>,
        stop: &AtomicBool,
    ) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let mut s = self.state.lock().unwrap();
        if s.busy || self.upload_active() {
            return Err(ApiError::new(
                "BUSY",
                "Wait for the resource update or import to finish.",
            ));
        }
        recover_stored(&self.assets, &self.data, &mut s.stored)?;
        let config = crate::resource_rules::resolve_aliases(config, &s.stored.file_aliases);
        files.retain(|(plan, _)| {
            !self.assets.join(&plan.file).exists()
                && s.stored
                    .files
                    .iter()
                    .find(|file| file.file.eq_ignore_ascii_case(&plan.file))
                    .is_none_or(|file| {
                        file.kind == plan.kind
                            && file.url == plan.url
                            && file.through_wayrill == plan.through_wayrill
                    })
                && crate::resource_rules::uses_resources(&config, std::slice::from_ref(&plan.file))
        });
        if !files.is_empty() {
            commit(&self.assets, &self.data, &files, stop, false, &mut s.stored)?;
        }
        Ok(())
    }
    pub fn generation(&self) -> u64 {
        self.state.lock().unwrap().stored.generation
    }
    pub fn changed_files_after(&self, generation: u64) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .stored
            .metadata
            .iter()
            .filter(|(_, m)| m.content_generation > generation)
            .map(|(name, _)| name.clone())
            .collect()
    }
    pub fn snapshot(&self) -> Value {
        let s = self.state.lock().unwrap();
        let mut names = s
            .stored
            .files
            .iter()
            .map(|p| p.file.clone())
            .collect::<Vec<_>>();
        names.extend(s.stored.metadata.keys().cloned());
        names.extend(
            PACKAGED_PREFIXES
                .iter()
                .flat_map(|prefix| ["geoip", "geosite"].map(|kind| format!("{prefix}{kind}.dat"))),
        );
        names.sort();
        names.dedup();
        let files = names
            .iter()
            .map(|file| {
                let m = s.stored.metadata.get(file).cloned().unwrap_or_default();
                let metadata = fs::metadata(self.assets.join(file))
                    .ok()
                    .filter(|m| m.is_file());
                let plan = s
                    .stored
                    .files
                    .iter()
                    .find(|p| p.file.eq_ignore_ascii_case(file));
                let launch_error = self
                    .launch_retry
                    .as_ref()
                    .filter(|retry| {
                        plan.is_some_and(|p| p.auto_update) && retry.files.contains(file)
                    })
                    .map(|retry| retry.message.as_str());
                json!({
                    "id": plan.map(|p| &p.id),
                    "file": file,
                    "present": metadata.is_some(),
                    "updatedAtMs": m.updated_at_ms,
                    "bytes": metadata.as_ref().map(fs::Metadata::len),
                    "sha256": m.sha256,
                    "lastError": launch_error.or(m.last_error.as_deref()),
                })
            })
            .collect::<Vec<_>>();
        json!({"busy":s.busy,"generation":s.stored.generation,"reloadAfterAutoUpdates":s.stored.reload_after_auto_updates,"reloadGeneration":s.stored.reload_generation,"files":files})
    }
    pub fn set_proxy_port(&mut self, port: Option<u16>) {
        self.proxy_port = port;
    }
    pub fn reload_generation(&self) -> u64 {
        self.state.lock().unwrap().stored.reload_generation
    }
    fn current_plans(&self, mut files: Vec<FilePlan>) -> Result<Vec<FilePlan>> {
        validate_plans(&files)?;
        let state = self.state.lock().unwrap();
        for file in &mut files {
            if let Some(current) = state
                .stored
                .files
                .iter()
                .find(|current| !file.id.is_empty() && current.id == file.id)
            {
                if current.kind != file.kind {
                    return Err(invalid("A resource file's type cannot change."));
                }
                file.file = current.file.clone();
            }
        }
        Ok(files)
    }
    fn check_schedule_version(&self, base: &ScheduleVersion) -> Result<()> {
        if base.instance_id != self.events.instance_id {
            return Err(ApiError::new(
                "SERVICE_INSTANCE_CHANGED",
                "The service restarted while updating the resource schedule.",
            ));
        }
        if base.revision != self.schedule_revision {
            let mut error = ApiError::new(
                "RESOURCE_SCHEDULE_CHANGED",
                "The resource schedule changed. Read the current revision before trying again.",
            );
            error.retryable = true;
            return Err(error);
        }
        Ok(())
    }
    fn configure(
        &mut self,
        mut files: Vec<FilePlan>,
        reload_after_auto_updates: bool,
    ) -> Result<()> {
        for file in &mut files {
            if file.id.is_empty() {
                file.id = plan_id(&file.file);
            }
        }
        validate_plans(&files)?;
        self.reconcile()?;
        let mut s = self.state.lock().unwrap();
        if s.stored.files != files
            || s.stored.reload_after_auto_updates != reload_after_auto_updates
        {
            if s.busy || self.upload_active() {
                return Err(ApiError::new(
                    "BUSY",
                    "Wait for the resource update or import to finish.",
                ));
            }
            let mut next = s.stored.clone();
            let mut renames = Vec::new();
            for p in &files {
                if let Some(previous) = s
                    .stored
                    .files
                    .iter()
                    .find(|old| old.id == p.id && old.kind == p.kind && old.file != p.file)
                {
                    let from = self.assets.join(&previous.file);
                    let to = self.assets.join(&p.file);
                    if to.exists() && !previous.file.eq_ignore_ascii_case(&p.file) {
                        return Err(invalid("The new resource filename already exists."));
                    }
                    if from.exists() {
                        let mut bytes = Vec::new();
                        fs::File::open(&from)
                            .map_err(|e| ApiError::io("Open resource to rename", e))?
                            .take((MAX + 1) as u64)
                            .read_to_end(&mut bytes)
                            .map_err(|e| ApiError::io("Read resource to rename", e))?;
                        validate_dat(&bytes, &p.kind)?;
                        renames.push(Rename {
                            from: previous.file.clone(),
                            to: p.file.clone(),
                            sha256: crate::system_native::hex(&Sha256::digest(&bytes)),
                        });
                    }
                    if let Some(metadata) = next.metadata.remove(&previous.file) {
                        next.metadata.insert(p.file.clone(), metadata);
                    }
                    for target in next.file_aliases.values_mut() {
                        if target.eq_ignore_ascii_case(&previous.file) {
                            *target = p.file.clone();
                        }
                    }
                    next.file_aliases
                        .insert(previous.file.to_lowercase(), p.file.clone());
                    next.file_aliases.remove(&p.file.to_lowercase());
                }
                next.metadata
                    .entry(p.file.clone())
                    .or_insert_with(|| Metadata {
                        last_attempt_ms: now(),
                        ..Default::default()
                    });
            }
            for file in &files {
                next.file_aliases.remove(&file.file.to_lowercase());
            }
            next.files = files;
            next.reload_after_auto_updates = reload_after_auto_updates;
            if reload_after_auto_updates {
                next.reload_generation = next.generation;
            }
            if !renames.is_empty() {
                let journal = Journal {
                    files: Vec::new(),
                    previous: s.stored.clone(),
                    renames,
                };
                storage::write(&self.data.join("resources-transaction.json"), &journal)?;
                let result = (|| {
                    for rename in &journal.renames {
                        fs::rename(self.assets.join(&rename.from), self.assets.join(&rename.to))
                            .map_err(|e| ApiError::io("Rename resource file", e))?;
                    }
                    storage::write(&self.data.join("resources.json"), &next)?;
                    storage::remove(&self.data.join("resources-transaction.json"))
                })();
                if let Err(error) = result {
                    recover_stored(&self.assets, &self.data, &mut s.stored)?;
                    return Err(error);
                }
            } else {
                storage::write(&self.data.join("resources.json"), &next)?;
            }
            s.stored = next;
        }
        drop(s);
        // An accepted no-op still supersedes older writes based on this revision.
        self.schedule_revision += 1;
        Ok(())
    }
    fn start(&mut self, files: Vec<FilePlan>, automatic: bool) -> Result<Value> {
        validate_plans(&files)?;
        self.reconcile()?;
        if files.iter().any(|p| p.url.is_empty()) {
            return Err(invalid("Choose DAT files from disk before updating them."));
        }
        let mut s = self.state.lock().unwrap();
        if s.busy || self.upload_active() {
            return Err(ApiError::new(
                "BUSY",
                "A resource update or file import is already in progress.",
            ));
        }
        if files.is_empty() {
            drop(s);
            return Ok(self.snapshot());
        }
        // Completion records the attempt. Launch failures or service exit
        // before that point must leave the files due.
        let started_files = self
            .launch_retry
            .as_ref()
            .map(|_| files.iter().map(|p| p.file.clone()).collect::<Vec<_>>());
        s.busy = true;
        let reload = !automatic || s.stored.reload_after_auto_updates;
        let proxy_port = self.proxy_port;
        drop(s);
        let (state, assets, data, events, stop) = (
            self.state.clone(),
            self.assets.clone(),
            self.data.clone(),
            self.events.clone(),
            self.stop.clone(),
        );
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let worker = std::thread::Builder::new()
            .name("wayrill-resources".into())
            .spawn(move || {
                let batch =
                    RefreshBatch::download(files, |plan| download_file(plan, &stop, proxy_port));
                let mut s = state.lock().unwrap();
                if stop.load(Ordering::Acquire) {
                    s.busy = false;
                    return;
                }
                let (updated, failed) = batch.install(&assets, &data, &stop, reload, &mut s.stored);
                s.busy = false;
                drop(s);
                if !failed.is_empty() {
                    events.publish("resources.failed", json!({"files":failed,"ok":false}));
                }
                if !updated.is_empty() {
                    events.publish("resources.updated", json!({"files":updated,"ok":true}));
                }
            });
        match worker {
            Ok(worker) => {
                self.worker = Some(worker);
                if let (Some(retry), Some(started)) = (&mut self.launch_retry, started_files) {
                    retry.files.retain(|file| !started.contains(file));
                    if retry.files.is_empty() {
                        self.launch_retry = None;
                    }
                }
            }
            Err(error) => {
                self.state.lock().unwrap().busy = false;
                return Err(ApiError::io("Start resource update worker", error));
            }
        }
        Ok(self.snapshot())
    }
    pub fn tick(&mut self) {
        self.expire_uploads(Instant::now());
        if self.stop.load(Ordering::SeqCst)
            || self
                .launch_retry
                .as_ref()
                .is_some_and(|retry| Instant::now() < retry.at)
        {
            return;
        }
        let s = self.state.lock().unwrap();
        if s.busy || self.upload_active() {
            return;
        }
        let due = s
            .stored
            .files
            .iter()
            .filter(|p| {
                p.auto_update
                    && now().saturating_sub(
                        s.stored
                            .metadata
                            .get(&p.file)
                            .map_or(0, |m| m.last_attempt_ms),
                    ) >= u64::from(p.interval_hours) * 3600000
            })
            .cloned()
            .collect::<Vec<_>>();
        drop(s);
        if !due.is_empty() {
            let files = due.iter().map(|plan| plan.file.clone()).collect();
            if let Err(error) = self.start(due, true) {
                let message = format!(
                    "Automatic update could not start. Retrying shortly. {}",
                    error.message
                );
                crate::diagnostics::error!("{}", message);
                self.events.publish(
                    "resources.failed",
                    json!({"files":files,"ok":false,"error":message}),
                );
                self.launch_retry = Some(LaunchRetry {
                    at: Instant::now() + Duration::from_secs(30),
                    files,
                    message,
                });
            }
        }
    }
    pub fn shutdown(&mut self) {
        self.browser.shutdown();
        self.stop.store(true, Ordering::SeqCst);
        // Join before releasing service ownership: an old transaction must not
        // commit or roll back files underneath a newly started service instance.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        for phase in self.uploads.values() {
            if let UploadPhase::Receiving(upload) = phase {
                let _ = fs::remove_file(&upload.path);
            }
        }
        self.uploads.clear();
    }
    pub fn handle(&mut self, method: &str, input: Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Files {
            files: Vec<FilePlan>,
            #[serde(default = "default_reload")]
            reload_after_auto_updates: bool,
        }
        fn default_reload() -> bool {
            true
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Configure {
            base: ScheduleVersion,
            schedule: Files,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Ensure {
            base: Option<ScheduleVersion>,
            files: Vec<FilePlan>,
            required: Vec<String>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Begin {
            upload: Option<String>,
            #[serde(default)]
            id: String,
            file: String,
            kind: String,
            bytes: usize,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Chunk {
            upload: String,
            offset: usize,
            hex: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Token {
            upload: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct BrowseJob {
            job: String,
        }
        if matches!(
            method,
            "resources.browse" | "resources.ensure" | "resources.uploadBegin"
        ) {
            self.reconcile()?;
        }
        match method {
            "resources.browse" => {
                let q: crate::geodata::Query = params(input)?;
                q.validate()?;
                let s = self.state.lock().unwrap();
                let builtin = PACKAGED_PREFIXES
                    .iter()
                    .any(|prefix| q.file == format!("{prefix}{}.dat", q.kind));
                if !builtin
                    && !s
                        .stored
                        .files
                        .iter()
                        .any(|p| p.file == q.file && p.kind == q.kind)
                {
                    return Err(invalid("Choose a configured or packaged resource file."));
                }
                let generation = s
                    .stored
                    .metadata
                    .get(&q.file)
                    .map_or(0, |m| m.content_generation);
                drop(s);
                self.browser.browse(q, generation)
            }
            "resources.browseGet" | "resources.browseCancel" => {
                let BrowseJob { job } = params(input)?;
                if job.len() != 32 || !job.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(invalid("Invalid resource lookup ID."));
                }
                if method == "resources.browseCancel" {
                    self.browser.cancel(&job);
                    return Ok(Value::Null);
                }
                let state = self.state.lock().unwrap();
                self.browser.read(&job, |file| {
                    state
                        .stored
                        .metadata
                        .get(file)
                        .map_or(0, |m| m.content_generation)
                })
            }
            "resources.status" => {
                if input != json!({}) {
                    return Err(invalid("No status parameters are needed."));
                }
                Ok(self.snapshot())
            }
            "resources.scheduleVersion" => {
                let _: crate::kernel::Empty = params(input)?;
                Ok(json!(ScheduleVersion {
                    instance_id: self.events.instance_id.clone(),
                    revision: self.schedule_revision,
                }))
            }
            "resources.configure" => {
                let Configure { base, schedule } = params(input)?;
                self.check_schedule_version(&base)?;
                self.configure(schedule.files, schedule.reload_after_auto_updates)?;
                Ok(self.snapshot())
            }
            "resources.update" => {
                let p: Files = params(input)?;
                let files = self.current_plans(p.files)?;
                self.start(
                    files.into_iter().filter(|p| !p.url.is_empty()).collect(),
                    false,
                )
            }
            "resources.ensure" => {
                let mut p: Ensure = params(input)?;
                p.required.sort();
                p.required.dedup();
                if p.required.len() > 256 || p.required.iter().any(|f| !valid_name(f)) {
                    return Err(invalid("Invalid resource dependencies."));
                }
                validate_plans(&p.files)?;
                if self
                    .current_plans(p.files.clone())?
                    .iter()
                    .zip(&p.files)
                    .any(|(current, expected)| current.file != expected.file)
                {
                    let s = self.state.lock().unwrap();
                    if s.busy || self.upload_active() {
                        return Ok(json!({"ready":false,"busy":true}));
                    }
                    let reload = s.stored.reload_after_auto_updates;
                    drop(s);
                    self.check_schedule_version(p.base.as_ref().ok_or_else(|| {
                        invalid("Read the resource schedule version before preparing a rename.")
                    })?)?;
                    self.configure(p.files.clone(), reload)?;
                }
                let s = self.state.lock().unwrap();
                let missing =
                    p.required
                        .iter()
                        .filter(|f| {
                            !self.assets.join(f).is_file()
                                || p.files.iter().find(|plan| plan.file == **f).is_some_and(
                                    |plan| {
                                        plan.fetch_on_use
                                            && s.stored
                                                .metadata
                                                .get(*f)
                                                .is_none_or(|m| m.source_url != plan.url)
                                    },
                                )
                        })
                        .collect::<Vec<_>>();
                let plans = missing
                    .iter()
                    .map(|f| {
                        p.files
                            .iter()
                            .find(|p| &p.file == *f)
                            .filter(|p| !p.url.is_empty())
                            .cloned()
                            .ok_or_else(|| {
                                ApiError::new(
                                    "RESOURCE_MISSING",
                                    format!(
                                        "{}: import the required DAT file before validating.",
                                        f
                                    ),
                                )
                            })
                    })
                    .collect::<Result<Vec<_>>>()?;
                // A filename can be reused for a corrected provider URL while
                // an older download is failing. Only that source's failure can
                // terminate polling; a new source still needs its own attempt.
                if let Some(message) = plans
                    .iter()
                    .filter_map(|plan| {
                        s.stored
                            .metadata
                            .get(&plan.file)
                            .filter(|m| m.last_attempt_url == plan.url)
                            .and_then(|m| m.last_error.as_ref())
                    })
                    .next()
                {
                    if !s.busy {
                        return Err(ApiError::new("RESOURCE_DOWNLOAD", message));
                    }
                }
                let busy = s.busy;
                drop(s);
                if !plans.is_empty() && !busy {
                    self.start(plans, false)?;
                }
                Ok(json!({"ready":missing.is_empty(),"busy":self.state.lock().unwrap().busy}))
            }
            "resources.uploadPrepare" => {
                let _: crate::kernel::Empty = params(input)?;
                Ok(json!({"upload":self.prepare_upload()?}))
            }
            "resources.uploadBegin" => {
                let mut p: Begin = params(input)?;
                let files = self.current_plans(vec![FilePlan {
                    id: p.id.clone(),
                    file: p.file.clone(),
                    kind: p.kind.clone(),
                    url: String::new(),
                    auto_update: false,
                    interval_hours: 24,
                    fetch_on_use: false,
                    through_wayrill: false,
                }])?;
                p.file = files[0].file.clone();
                validate_plans(&[FilePlan {
                    id: String::new(),
                    file: p.file.clone(),
                    kind: p.kind.clone(),
                    url: String::new(),
                    auto_update: false,
                    interval_hours: 24,
                    fetch_on_use: false,
                    through_wayrill: false,
                }])?;
                if p.bytes == 0 || p.bytes > MAX {
                    return Err(invalid("Choose a nonempty DAT file up to 128 MiB."));
                }
                if self.state.lock().unwrap().busy || self.upload_active() {
                    return Err(ApiError::new("BUSY", "A resource transfer is in progress."));
                }
                let token = match p.upload {
                    Some(token) if matches!(self.uploads.get(&token), Some(UploadPhase::Prepared(at)) if at.elapsed() < UPLOAD_LEASE) => {
                        token
                    }
                    Some(_) => return Err(invalid("The DAT import reservation is unavailable.")),
                    None => self.prepare_upload()?,
                };
                let stage = self.assets.join(".wayrill-resource-stage");
                fs::create_dir_all(&stage).map_err(|e| ApiError::io("Stage import", e))?;
                let path = stage.join("upload.tmp");
                fs::File::create(&path).map_err(|e| ApiError::io("Stage import", e))?;
                self.uploads.insert(
                    token.clone(),
                    UploadPhase::Receiving(Upload {
                        file: p.file,
                        kind: p.kind,
                        bytes: p.bytes,
                        received: 0,
                        path,
                        last_activity: Instant::now(),
                    }),
                );
                Ok(json!({"upload":token}))
            }
            "resources.uploadChunk" => {
                let p: Chunk = params(input)?;
                let Some(UploadPhase::Receiving(u)) = self.uploads.get_mut(&p.upload) else {
                    return Err(invalid("No DAT data transfer is open for this import."));
                };
                if p.offset != u.received
                    || p.hex.is_empty()
                    || p.hex.len() > 2 * 1024 * 1024
                    || !p.hex.len().is_multiple_of(2)
                    || p.hex.len() / 2 > u.bytes - u.received
                {
                    return Err(invalid("Invalid resource chunk size or offset."));
                }
                let decoded = p
                    .hex
                    .as_bytes()
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| {
                        let f = |b: u8| match b {
                            b'0'..=b'9' => Some(b - b'0'),
                            b'a'..=b'f' => Some(b - b'a' + 10),
                            _ => None,
                        };
                        Ok(
                            f(c[0]).ok_or_else(|| invalid("Invalid resource bytes."))? * 16
                                + f(c[1]).ok_or_else(|| invalid("Invalid resource bytes."))?,
                        )
                    })
                    .collect::<Result<Vec<u8>>>()?;
                OpenOptions::new()
                    .append(true)
                    .open(&u.path)
                    .and_then(|mut f| f.write_all(&decoded))
                    .map_err(|e| ApiError::io("Write resource chunk", e))?;
                u.received += decoded.len();
                u.last_activity = Instant::now();
                Ok(json!({"received":u.received}))
            }
            "resources.uploadCancel" => {
                let p: Token = params(input)?;
                match self.uploads.get_mut(&p.upload) {
                    Some(UploadPhase::Complete { result, .. }) => {
                        result.clone()?;
                        Ok(self.snapshot())
                    }
                    Some(phase) => {
                        if let UploadPhase::Receiving(upload) = phase {
                            let _ = fs::remove_file(&upload.path);
                        }
                        *phase = UploadPhase::Cancelled(Instant::now());
                        Ok(Value::Null)
                    }
                    None => Err(ApiError::new(
                        "RESOURCE_IMPORT_UNAVAILABLE",
                        "The DAT import outcome is unavailable. Check the resource list before retrying.",
                    )),
                }
            }
            "resources.uploadCommit" => {
                let p: Token = params(input)?;
                match self.uploads.get(&p.upload) {
                    Some(UploadPhase::Complete { result, .. }) => {
                        result.clone()?;
                        return Ok(self.snapshot());
                    }
                    Some(UploadPhase::Receiving(_)) => {}
                    _ => return Err(invalid("No DAT data transfer is open for this import.")),
                }
                let Some(UploadPhase::Receiving(u)) = self.uploads.remove(&p.upload) else {
                    unreachable!("receiving upload checked above");
                };
                let result: Result<()> = (|| {
                    if u.bytes != u.received {
                        return Err(invalid("Resource upload is incomplete."));
                    }
                    let bytes =
                        fs::read(&u.path).map_err(|e| ApiError::io("Read imported resource", e))?;
                    let mut s = self.state.lock().unwrap();
                    commit(
                        &self.assets,
                        &self.data,
                        &[(
                            FilePlan {
                                id: String::new(),
                                file: u.file.clone(),
                                kind: u.kind,
                                url: String::new(),
                                auto_update: false,
                                interval_hours: 24,
                                fetch_on_use: false,
                                through_wayrill: false,
                            },
                            bytes,
                        )],
                        &self.stop,
                        true,
                        &mut s.stored,
                    )?;
                    Ok(())
                })();
                let _ = fs::remove_file(u.path);
                self.uploads.insert(
                    p.upload,
                    UploadPhase::Complete {
                        result: result.clone(),
                        at: Instant::now(),
                    },
                );
                result?;
                self.events
                    .publish("resources.updated", json!({"files":[u.file],"ok":true}));
                Ok(self.snapshot())
            }
            _ => Err(invalid("Unknown resource method.")),
        }
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn dat(kind: &str) -> Vec<u8> {
        if kind == "geoip" {
            vec![10, 14, 10, 2, b'U', b'S', 18, 8, 10, 4, 1, 2, 3, 4, 16, 24]
        } else {
            vec![
                10, 13, 10, 2, b'C', b'N', 18, 7, 8, 2, 18, 3, b'a', b'.', b'b',
            ]
        }
    }
    #[test]
    fn checks_binary_types_and_truncation() {
        for kind in ["geoip", "geosite"] {
            let good = dat(kind);
            assert_eq!(validate_dat(&good, kind).unwrap(), 1);
            assert!(
                validate_dat(&good, if kind == "geoip" { "geosite" } else { "geoip" }).is_err()
            );
            for n in 0..good.len() {
                assert!(validate_dat(&good[..n], kind).is_err());
            }
        }
    }
    #[test]
    fn rejects_invalid_last_singular_dat_values() {
        fn wire(field: u8, value: &[u8]) -> Vec<u8> {
            assert!(value.len() < 128);
            let mut out = vec![field << 3 | 2, value.len() as u8];
            out.extend(value);
            out
        }
        fn dataset(record: &[u8]) -> Vec<u8> {
            let mut group = wire(1, b"TEST");
            group.extend(wire(2, record));
            wire(1, &group)
        }
        for (kind, record) in [
            ("geoip", vec![10, 4, 192, 0, 2, 1, 16, 24, 10, 1, 0]),
            ("geoip", vec![10, 4, 192, 0, 2, 1, 16, 24, 16, 33]),
            ("geosite", vec![8, 2, 18, 3, b'a', b'.', b'b', 18, 1, 255]),
        ] {
            assert!(
                validate_dat(&dataset(&record), kind).is_err(),
                "Accepted an invalid final {kind} value: {record:?}"
            );
        }
        for (kind, record) in [
            ("geoip", vec![10, 1, 0, 10, 4, 192, 0, 2, 1, 16, 24]),
            ("geoip", vec![10, 4, 192, 0, 2, 1, 16, 33, 16, 24]),
            ("geosite", vec![8, 4, 8, 2, 18, 3, b'a', b'.', b'b']),
        ] {
            assert!(
                validate_dat(&dataset(&record), kind).is_ok(),
                "Rejected a valid effective {kind} value: {record:?}"
            );
        }
    }
    #[test]
    fn mutated_dat_wire_inputs_terminate_and_never_panic() {
        let mut seed = 0x62c4_9e73u32;
        let mut random = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for iteration in 0..2048 {
            let kind = if iteration % 2 == 0 {
                "geoip"
            } else {
                "geosite"
            };
            let mut bytes = dat(kind);
            for _ in 0..(random() % 8 + 1) {
                let index = random() as usize % bytes.len();
                bytes[index] = random() as u8;
            }
            if iteration % 3 == 0 {
                bytes.truncate(random() as usize % bytes.len());
            }
            let _ = validate_dat(&bytes, kind);
            let mut walk = fields(&bytes);
            for _ in 0..=bytes.len() {
                if walk.next().is_none_or(|value| value.is_err()) {
                    break;
                }
            }
            assert!(walk.next().is_none(), "DAT walk did not terminate");
        }
    }
    #[test]
    fn refuses_path_escape_and_insecure_sources() {
        for file in [
            "../geoip.dat",
            "C:\\geoip.dat",
            "sub/geoip.dat",
            "xray.exe",
            "geoip.dat:secret",
            "CON.dat",
            "lpt1.dat",
        ] {
            assert!(!valid_name(file));
        }
        for url in [
            "http://example.net/a",
            "file:///C:/secret",
            "https://user:pass@example.net/a",
            "https://example.net/a#b",
        ] {
            assert!(validate_url(url).is_err());
        }
    }
    #[test]
    fn rejects_conflicting_plan_names() {
        let p = FilePlan {
            id: String::new(),
            file: "geoip.dat".into(),
            kind: "geoip".into(),
            url: "https://example.net/geoip.dat".into(),
            auto_update: true,
            interval_hours: 24,
            fetch_on_use: false,
            through_wayrill: false,
        };
        assert!(validate_plans(std::slice::from_ref(&p)).is_ok());
        assert!(validate_plans(&[p.clone(), p]).is_err());
    }
}

#[cfg(test)]
mod transactional_tests {
    use super::*;
    struct Lab {
        root: PathBuf,
    }
    impl Lab {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "wayrill-resource-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(root.join("assets")).unwrap();
            fs::create_dir_all(root.join("state")).unwrap();
            Self { root }
        }
        fn manager(&self) -> Manager {
            Manager::new(
                self.root.join("assets"),
                self.root.join("state"),
                Events::new(),
            )
            .unwrap()
        }
    }
    impl Drop for Lab {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn plan() -> FilePlan {
        FilePlan {
            id: "qa".into(),
            file: "qa.dat".into(),
            kind: "geoip".into(),
            url: String::new(),
            auto_update: false,
            interval_hours: 24,
            fetch_on_use: false,
            through_wayrill: false,
        }
    }
    #[test]
    fn pool_provisions_only_referenced_missing_files_without_requesting_a_reload() {
        let lab = Lab::new();
        let mut manager = lab.manager();
        let geoip = FilePlan {
            file: "ru-geoip.dat".into(),
            url: "https://example.test/geoip.dat".into(),
            ..plan()
        };
        let geosite = FilePlan {
            id: "site".into(),
            file: "ru-geosite.dat".into(),
            kind: "geosite".into(),
            url: "https://example.test/geosite.dat".into(),
            ..plan()
        };
        let config = json!({"dns":{"servers":[{"expectedIPs":["ext:ru-geoip.dat:us"]}]}});
        let plans = vec![geoip.clone(), geosite];
        let missing = manager.missing_pool_files(&config, plans.clone()).unwrap();
        assert_eq!(missing, vec![geoip.clone()]);
        let stop = AtomicBool::new(false);
        let downloaded = vec![(geoip, dat())];
        manager
            .install_pool_files(&config, downloaded.clone(), &stop)
            .unwrap();
        assert_eq!(
            manager
                .project(&config)
                .unwrap()
                .report
                .skipped_selector_count,
            0
        );
        assert_eq!(manager.generation(), 1);
        assert_eq!(manager.reload_generation(), 0);
        assert!(manager
            .missing_pool_files(&config, plans)
            .unwrap()
            .is_empty());
        manager
            .install_pool_files(&config, downloaded, &stop)
            .unwrap();
        assert_eq!(manager.generation(), 1);
        assert!(manager.state.lock().unwrap().stored.files.is_empty());
    }
    #[test]
    fn every_preset_resource_is_catalogued_and_browsable_without_configuration() {
        let dependencies: Value =
            serde_json::from_str(include_str!("../../dependencies.json")).unwrap();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        for row in dependencies["routingData"]["files"].as_array().unwrap() {
            let file = row["path"].as_str().unwrap();
            let kind = if file.ends_with("geoip.dat") {
                "geoip"
            } else {
                "geosite"
            };
            let lab = Lab::new();
            fs::copy(
                root.join("routing-assets").join(file),
                lab.root.join("assets").join(file),
            )
            .unwrap();
            let mut manager = lab.manager();
            let snapshot = manager.snapshot();
            let entry = snapshot["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["file"] == file)
                .unwrap();
            assert_eq!(entry["present"], true, "{file}");
            assert_eq!(
                entry["bytes"].as_u64(),
                Some(
                    fs::metadata(lab.root.join("assets").join(file))
                        .unwrap()
                        .len()
                ),
                "{file}"
            );
            manager
                .handle("resources.browse", json!({"file":file,"kind":kind}))
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            loop {
                let page = manager
                    .handle("resources.browse", json!({"file":file,"kind":kind}))
                    .unwrap();
                if page["ready"] == true {
                    assert!(page["total"].as_u64().unwrap() > 0, "{file}");
                    assert!(!page["rows"].as_array().unwrap().is_empty(), "{file}");
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "{file}: {page}");
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let wrong_kind = if kind == "geoip" { "geosite" } else { "geoip" };
            assert!(manager
                .handle("resources.browse", json!({"file":file,"kind":wrong_kind}))
                .is_err());
            assert!(manager
                .handle(
                    "resources.browse",
                    json!({"file":"unconfigured.dat","kind":kind})
                )
                .is_err());
            manager.shutdown();
        }
    }

    #[test]
    fn tracked_resource_pages_cancel_independently_and_expire_when_the_data_changes() {
        let lab = Lab::new();
        fs::write(lab.root.join("assets/geoip.dat"), dat()).unwrap();
        let mut manager = lab.manager();
        let mut start = |query| {
            let page = manager.handle("resources.browse", json!({"file":"geoip.dat","kind":"geoip","group":"us","query":query,"track":true})).unwrap();
            json!({"job":page["job"].as_str().unwrap()})
        };
        let removed = start("obsolete");
        let current = start("");
        manager
            .handle("resources.browseCancel", removed.clone())
            .unwrap();
        assert_eq!(
            manager
                .handle("resources.browseGet", removed)
                .unwrap_err()
                .code,
            "RESOURCE_BROWSE_EXPIRED"
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let reply = manager
                .handle("resources.browseGet", current.clone())
                .unwrap();
            if reply["ready"] == true {
                assert_eq!(reply["rows"][0]["value"], "1.2.3.0/24");
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        manager
            .state
            .lock()
            .unwrap()
            .stored
            .metadata
            .entry("geoip.dat".into())
            .or_default()
            .content_generation += 1;
        assert_eq!(
            manager
                .handle("resources.browseGet", current)
                .unwrap_err()
                .code,
            "RESOURCE_CHANGED"
        );
    }
    #[test]
    fn shutdown_joins_the_resource_transaction() {
        let lab = Lab::new();
        let mut m = lab.manager();
        let (stop, path) = (m.stop.clone(), lab.root.join("finished"));
        m.worker = Some(std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            fs::write(path, "finished").unwrap();
        }));
        m.shutdown();
        assert!(lab.root.join("finished").is_file());
        assert!(m.worker.is_none());
    }
    #[test]
    fn staged_rename_preserves_the_identity_of_file_operations() {
        let lab = Lab::new();
        let mut manager = lab.manager();
        let mut current = plan();
        current.id = "custom".into();
        fs::write(lab.root.join("assets/qa.dat"), dat()).unwrap();
        manager.configure(vec![current.clone()], false).unwrap();
        let mut staged = current.clone();
        staged.file = "office.dat".into();
        staged.url = "https://example.invalid/never-requested.dat".into();
        staged.through_wayrill = true;
        manager
            .handle("resources.update", json!({"files":[staged]}))
            .unwrap();
        manager.worker.take().unwrap().join().unwrap();
        assert!(manager.state.lock().unwrap().stored.metadata["qa.dat"]
            .last_error
            .is_some());
        assert!(!manager
            .state
            .lock()
            .unwrap()
            .stored
            .metadata
            .contains_key("office.dat"));
        let upload = manager
            .handle(
                "resources.uploadBegin",
                json!({"id":"custom","file":"office.dat","kind":"geoip","bytes":dat().len()}),
            )
            .unwrap()["upload"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(matches!(
            manager.uploads.get(&upload),
            Some(UploadPhase::Receiving(upload)) if upload.file == "qa.dat"
        ));
        manager
            .handle("resources.uploadCancel", json!({"upload":upload}))
            .unwrap();
        current.file = "office.dat".into();
        let base = manager
            .handle("resources.scheduleVersion", json!({}))
            .unwrap();
        assert_eq!(
            manager
                .handle(
                    "resources.ensure",
                    json!({"files":[current],"required":["office.dat"],"base":base})
                )
                .unwrap()["ready"],
            true
        );
        assert!(lab.root.join("assets/office.dat").exists());
        assert!(!lab.root.join("assets/qa.dat").exists());
    }
    fn dat() -> Vec<u8> {
        vec![10, 14, 10, 2, b'U', b'S', 18, 8, 10, 4, 1, 2, 3, 4, 16, 24]
    }
    #[test]
    fn rename_moves_the_file_and_preserves_applied_references_across_restart_and_undo() {
        let lab = Lab::new();
        let mut manager = lab.manager();
        let mut file = plan();
        file.id = "custom".into();
        fs::write(lab.root.join("assets/qa.dat"), dat()).unwrap();
        manager.configure(vec![file.clone()], true).unwrap();
        file.file = "office.dat".into();
        manager.configure(vec![file.clone()], true).unwrap();
        assert!(!lab.root.join("assets/qa.dat").exists());
        assert_eq!(fs::read(lab.root.join("assets/office.dat")).unwrap(), dat());
        let config = json!({"routing":{"rules":[{"ip":["ext:qa.dat:US"],"outboundTag":"direct"}]},"outbounds":[{"settings":{"password":"ext:qa.dat:US"}}]});
        let projected = manager.project(&config).unwrap();
        assert_eq!(
            projected.config["routing"]["rules"][0]["ip"][0],
            "ext:office.dat:US"
        );
        assert_eq!(
            projected.config["outbounds"][0]["settings"]["password"],
            "ext:qa.dat:US"
        );
        assert!(manager.uses(&config, &["office.dat".into()]));
        drop(manager);
        let mut manager = lab.manager();
        assert_eq!(
            manager.project(&config).unwrap().config["routing"]["rules"][0]["ip"][0],
            "ext:office.dat:US"
        );
        file.file = "qa.dat".into();
        manager.configure(vec![file], true).unwrap();
        assert!(lab.root.join("assets/qa.dat").exists());
        assert!(!lab.root.join("assets/office.dat").exists());
        assert!(!lab.root.join("state/resources-transaction.json").exists());
    }
    #[test]
    fn interrupted_rename_recovers_the_original_filename_and_schedule() {
        let lab = Lab::new();
        let assets = lab.root.join("assets");
        let data = lab.root.join("state");
        fs::write(assets.join("qa.dat"), dat()).unwrap();
        let mut manager = lab.manager();
        let mut file = plan();
        file.id = "custom".into();
        manager.configure(vec![file], true).unwrap();
        let previous = manager.state.lock().unwrap().stored.clone();
        drop(manager);
        storage::write(
            &data.join("resources-transaction.json"),
            &Journal {
                files: Vec::new(),
                previous,
                renames: vec![Rename {
                    from: "qa.dat".into(),
                    to: "office.dat".into(),
                    sha256: crate::system_native::hex(&Sha256::digest(dat())),
                }],
            },
        )
        .unwrap();
        fs::rename(assets.join("qa.dat"), assets.join("office.dat")).unwrap();
        let manager = lab.manager();
        assert!(assets.join("qa.dat").exists());
        assert!(!assets.join("office.dat").exists());
        assert_eq!(manager.state.lock().unwrap().stored.files[0].file, "qa.dat");
        assert!(!data.join("resources-transaction.json").exists());
    }
    #[test]
    fn rename_refuses_collisions_and_rolls_back_a_locked_file_without_losing_the_schedule() {
        use std::os::windows::fs::OpenOptionsExt;
        let lab = Lab::new();
        let mut manager = lab.manager();
        let assets = lab.root.join("assets");
        fs::write(assets.join("qa.dat"), dat()).unwrap();
        let mut file = plan();
        file.id = "custom".into();
        manager.configure(vec![file.clone()], true).unwrap();
        file.file = "office.dat".into();
        fs::write(assets.join("office.dat"), dat()).unwrap();
        assert!(manager.configure(vec![file.clone()], false).is_err());
        fs::remove_file(assets.join("office.dat")).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(assets.join("qa.dat"))
            .unwrap();
        assert!(manager.configure(vec![file.clone()], false).is_err());
        assert_eq!(manager.state.lock().unwrap().stored.files[0].file, "qa.dat");
        assert!(
            manager
                .state
                .lock()
                .unwrap()
                .stored
                .reload_after_auto_updates
        );
        assert!(!lab.root.join("state/resources-transaction.json").exists());
        drop(locked);
        manager.configure(vec![file], false).unwrap();
        assert!(assets.join("office.dat").exists());
    }
    #[test]
    fn deferred_automatic_content_is_persisted_and_manual_update_requests_a_reload_even_if_identical(
    ) {
        let lab = Lab::new();
        let mut stored = Stored::default();
        commit(
            &lab.root.join("assets"),
            &lab.root.join("state"),
            &[(plan(), dat())],
            &AtomicBool::new(false),
            false,
            &mut stored,
        )
        .unwrap();
        assert_eq!(stored.generation, 1);
        assert_eq!(stored.reload_generation, 0);
        assert_eq!(lab.manager().reload_generation(), 0);
        commit(
            &lab.root.join("assets"),
            &lab.root.join("state"),
            &[(plan(), dat())],
            &AtomicBool::new(false),
            true,
            &mut stored,
        )
        .unwrap();
        assert_eq!(stored.generation, 1);
        assert_eq!(lab.manager().reload_generation(), 1);
    }
    #[test]
    fn proxy_required_download_never_falls_back_to_direct_and_records_a_delayed_retry() {
        let lab = Lab::new();
        let mut manager = lab.manager();
        let mut file = plan();
        file.url = "https://example.invalid/never-requested.dat".into();
        file.through_wayrill = true;
        file.auto_update = true;
        manager.configure(vec![file.clone()], true).unwrap();
        manager.start(vec![file], true).unwrap();
        manager.worker.take().unwrap().join().unwrap();
        let state = manager.state.lock().unwrap();
        assert!(!state.busy);
        assert_eq!(state.stored.generation, 0);
        let metadata = &state.stored.metadata["qa.dat"];
        assert!(metadata
            .last_error
            .as_ref()
            .unwrap()
            .contains("loopback proxy"));
        assert!(metadata.last_attempt_ms > 0);
        assert!(!lab.root.join("assets/qa.dat").exists());
    }
    #[test]
    fn mixed_refresh_keeps_failed_files_and_commits_successes_in_one_generation() {
        let lab = Lab::new();
        let (assets, data) = (lab.root.join("assets"), lab.root.join("state"));
        let stop = AtomicBool::new(false);
        let mut stored = Stored::default();
        let source = |file: &str| FilePlan {
            file: file.into(),
            url: format!("https://example.net/{file}"),
            ..plan()
        };
        let offline = source("offline.dat");
        let original = dat();
        commit(
            &assets,
            &data,
            &[(offline.clone(), original.clone())],
            &stop,
            false,
            &mut stored,
        )
        .unwrap();
        let batch = RefreshBatch::download(
            vec![source("first.dat"), offline, source("last.dat")],
            |plan| {
                if plan.file == "offline.dat" {
                    Err(ApiError::new("RESOURCE_DOWNLOAD", "Provider unavailable"))
                } else {
                    Ok(original.clone())
                }
            },
        );
        let (updated, failed) = batch.install(&assets, &data, &stop, true, &mut stored);
        assert_eq!(updated, ["first.dat", "last.dat"]);
        assert_eq!(failed, ["offline.dat"]);
        for file in ["first.dat", "offline.dat", "last.dat"] {
            assert_eq!(fs::read(assets.join(file)).unwrap(), original);
        }
        let saved: Stored = storage::read(&data.join("resources.json"))
            .unwrap()
            .unwrap();
        assert_eq!(saved.generation, 2);
        assert_eq!(saved.reload_generation, 2);
        assert_eq!(saved.metadata["offline.dat"].content_generation, 1);
        assert_eq!(
            saved.metadata["offline.dat"].last_error.as_deref(),
            Some("Provider unavailable")
        );
        for file in ["first.dat", "last.dat"] {
            assert_eq!(saved.metadata[file].content_generation, 2);
            assert!(saved.metadata[file].last_error.is_none());
        }
    }
    #[test]
    fn identical_download_preserves_content_generation_and_file_timestamp() {
        let lab = Lab::new();
        let mut stored = Stored::default();
        let assets = lab.root.join("assets");
        let state = lab.root.join("state");
        let stop = AtomicBool::new(false);
        commit(
            &assets,
            &state,
            &[(plan(), dat())],
            &stop,
            true,
            &mut stored,
        )
        .unwrap();
        let timestamp = fs::metadata(assets.join("qa.dat"))
            .unwrap()
            .modified()
            .unwrap();
        let mut metadata = stored.metadata["qa.dat"].clone();
        metadata.last_attempt_ms = 0;
        stored.metadata.insert("qa.dat".into(), metadata);
        commit(
            &assets,
            &state,
            &[(plan(), dat())],
            &stop,
            true,
            &mut stored,
        )
        .unwrap();
        assert_eq!(stored.generation, 1);
        assert_eq!(stored.metadata["qa.dat"].content_generation, 1);
        assert!(stored.metadata["qa.dat"].last_attempt_ms > 0);
        assert_eq!(
            fs::metadata(assets.join("qa.dat"))
                .unwrap()
                .modified()
                .unwrap(),
            timestamp
        );
        assert_eq!(lab.manager().changed_files_after(0), vec!["qa.dat"]);
        assert!(lab.manager().changed_files_after(1).is_empty());
        let mut changed = dat();
        changed[13] = 5;
        commit(
            &assets,
            &state,
            &[(plan(), changed)],
            &stop,
            true,
            &mut stored,
        )
        .unwrap();
        assert_eq!(stored.generation, 2);
        assert_eq!(lab.manager().changed_files_after(1), vec!["qa.dat"]);
    }
    #[test]
    fn valid_replacement_commits_metadata_and_survives_restart() {
        let lab = Lab::new();
        let mut original = dat();
        original[13] = 5;
        fs::write(lab.root.join("assets/qa.dat"), original).unwrap();
        let mut s = Stored::default();
        commit(
            &lab.root.join("assets"),
            &lab.root.join("state"),
            &[(plan(), dat())],
            &AtomicBool::new(false),
            true,
            &mut s,
        )
        .unwrap();
        assert_eq!(s.generation, 1);
        assert_eq!(lab.manager().generation(), 1);
        assert!(!lab
            .root
            .join("assets/.wayrill-resource-stage/qa.dat.old")
            .exists());
        assert!(!lab.root.join("state/resources-transaction.json").exists());
    }
    #[test]
    fn rejects_bad_data_without_changing_existing_files() {
        let lab = Lab::new();
        let target = lab.root.join("assets/qa.dat");
        fs::write(&target, dat()).unwrap();
        let mut s = Stored::default();
        assert!(commit(
            &lab.root.join("assets"),
            &lab.root.join("state"),
            &[(plan(), b"<html>failure</html>".to_vec())],
            &AtomicBool::new(false),
            true,
            &mut s
        )
        .is_err());
        assert_eq!(fs::read(target).unwrap(), dat());
        assert_eq!(s.generation, 0);
    }
    #[test]
    fn failed_staging_releases_uncommitted_backups_and_retries_after_unlock() {
        use std::os::windows::fs::OpenOptionsExt;

        for journal_failure in [false, true] {
            let lab = Lab::new();
            let assets = lab.root.join("assets");
            let data = lab.root.join("state");
            let stage = assets.join(".wayrill-resource-stage");
            fs::create_dir_all(&stage).unwrap();
            let original = dat();
            let mut replacement = original.clone();
            replacement[12] = 99;
            let mut second = plan();
            second.file = "second.dat".into();
            for name in ["qa.dat", "second.dat"] {
                fs::write(assets.join(name), &original).unwrap();
            }
            let blocked = if journal_failure {
                data.join("resources-transaction.tmp")
            } else {
                stage.join("second.dat.new")
            };
            let locked = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(true)
                .share_mode(0)
                .open(&blocked)
                .unwrap();
            let items = [(plan(), replacement.clone()), (second, replacement.clone())];
            let mut stored = Stored::default();
            assert!(commit(
                &assets,
                &data,
                &items,
                &AtomicBool::new(false),
                true,
                &mut stored
            )
            .is_err());
            assert_eq!(stored.generation, 0);
            assert!(stored.metadata.is_empty());
            for name in ["qa.dat", "second.dat"] {
                assert_eq!(fs::read(assets.join(name)).unwrap(), original);
                assert!(!stage.join(format!("{name}.old")).exists());
            }
            assert!(!stage.join("qa.dat.new").exists());
            assert!(!data.join("resources-transaction.json").exists());
            drop(locked);
            fs::remove_file(blocked).unwrap();
            commit(
                &assets,
                &data,
                &items,
                &AtomicBool::new(false),
                true,
                &mut stored,
            )
            .unwrap();
            assert_eq!(stored.generation, 1);
            for name in ["qa.dat", "second.dat"] {
                assert_eq!(fs::read(assets.join(name)).unwrap(), replacement);
                assert!(!stage.join(format!("{name}.new")).exists());
                assert!(!stage.join(format!("{name}.old")).exists());
            }
        }
    }
    #[test]
    fn canceled_update_recovers_every_file_and_previous_metadata() {
        let lab = Lab::new();
        let target = lab.root.join("assets/qa.dat");
        fs::write(&target, dat()).unwrap();
        let mut next = dat();
        next[12] = 99;
        let mut s = Stored::default();
        assert!(commit(
            &lab.root.join("assets"),
            &lab.root.join("state"),
            &[(plan(), next)],
            &AtomicBool::new(true),
            true,
            &mut s
        )
        .is_err());
        assert_eq!(fs::read(target).unwrap(), dat());
        assert_eq!(lab.manager().generation(), 0);
        assert!(!lab
            .root
            .join("assets/.wayrill-resource-stage/qa.dat.old")
            .exists());
    }
    #[test]
    fn startup_recovers_an_interrupted_two_file_replacement() {
        let lab = Lab::new();
        let stage = lab.root.join("assets/.wayrill-resource-stage");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("qa.dat.old"), dat()).unwrap();
        fs::write(lab.root.join("assets/qa.dat"), b"new").unwrap();
        fs::write(lab.root.join("assets/second.dat"), b"new").unwrap();
        storage::write(
            &lab.root.join("state/resources-transaction.json"),
            &Journal {
                renames: Vec::new(),
                files: vec![("qa.dat".into(), true), ("second.dat".into(), false)],
                previous: Stored::default(),
            },
        )
        .unwrap();
        let _m = lab.manager();
        assert_eq!(fs::read(lab.root.join("assets/qa.dat")).unwrap(), dat());
        assert!(!lab.root.join("assets/second.dat").exists());
        assert!(!stage.join("qa.dat.old").exists());
    }
    #[test]
    fn failed_recovery_keeps_the_journal_and_available_backup() {
        let lab = Lab::new();
        let stage = lab.root.join("assets/.wayrill-resource-stage");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("qa.dat.old"), dat()).unwrap();
        fs::write(lab.root.join("assets/qa.dat"), b"replacement").unwrap();
        storage::write(
            &lab.root.join("state/resources-transaction.json"),
            &Journal {
                renames: Vec::new(),
                files: vec![("qa.dat".into(), true), ("missing.dat".into(), true)],
                previous: Stored::default(),
            },
        )
        .unwrap();
        assert!(recover(&lab.root.join("assets"), &lab.root.join("state")).is_err());
        assert!(stage.join("qa.dat.old").exists());
        assert!(lab.root.join("state/resources-transaction.json").exists());
    }
    #[test]
    fn pending_resource_recovery_cannot_be_overwritten_and_recovers_after_unlock() {
        use std::os::windows::fs::OpenOptionsExt;
        let lab = Lab::new();
        let mut manager = lab.manager();
        let assets = lab.root.join("assets");
        let data = lab.root.join("state");
        let stage = assets.join(".wayrill-resource-stage");
        fs::create_dir_all(&stage).unwrap();
        let original = dat();
        let mut replacement = original.clone();
        replacement[12] = 99;
        fs::write(assets.join("qa.dat"), &replacement).unwrap();
        fs::write(stage.join("qa.dat.old"), &original).unwrap();
        let journal_path = data.join("resources-transaction.json");
        let original_hash = crate::system_native::hex(&Sha256::digest(&original));
        let previous = Stored {
            generation: 7,
            metadata: BTreeMap::from([(
                "qa.dat".into(),
                Metadata {
                    sha256: original_hash.clone(),
                    content_generation: 7,
                    ..Default::default()
                },
            )]),
            ..Default::default()
        };
        storage::write(
            &journal_path,
            &Journal {
                renames: Vec::new(),
                files: vec![("qa.dat".into(), true)],
                previous,
            },
        )
        .unwrap();
        let journal = fs::read(&journal_path).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(assets.join("qa.dat"))
            .unwrap();
        assert!(
            manager.project(&json!({})).is_err(),
            "unrestored resources must not reach a new runtime"
        );
        let mut stored = Stored::default();
        assert!(commit(
            &assets,
            &data,
            &[(plan(), original.clone())],
            &AtomicBool::new(false),
            true,
            &mut stored
        )
        .is_err());
        assert_eq!(
            fs::read(stage.join("qa.dat.old")).unwrap(),
            original,
            "a second update must not destroy the first backup"
        );
        assert_eq!(fs::read(&journal_path).unwrap(), journal);
        drop(locked);
        manager.project(&json!({})).unwrap();
        assert_eq!(fs::read(assets.join("qa.dat")).unwrap(), original);
        assert!(!journal_path.exists());
        assert_eq!(manager.generation(), 7);
        assert_eq!(
            manager.state.lock().unwrap().stored.metadata["qa.dat"].sha256,
            original_hash
        );
        let mut state = manager.state.lock().unwrap();
        commit(
            &assets,
            &data,
            &[(plan(), replacement.clone())],
            &AtomicBool::new(false),
            true,
            &mut state.stored,
        )
        .unwrap();
        assert_eq!(fs::read(assets.join("qa.dat")).unwrap(), replacement);
        assert_eq!(state.stored.generation, 8);
    }
    #[test]
    fn bounded_upload_rejects_out_of_order_and_wrong_kind_then_allows_a_retry() {
        let lab = Lab::new();
        let mut m = lab.manager();
        let upload = m
            .handle(
                "resources.uploadBegin",
                json!({"file":"qa.dat","kind":"geosite","bytes":dat().len()}),
            )
            .unwrap()["upload"]
            .as_str()
            .unwrap()
            .to_owned();
        let hex = dat().iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert!(m
            .handle(
                "resources.uploadChunk",
                json!({"upload":upload,"offset":1,"hex":hex})
            )
            .is_err());
        m.handle(
            "resources.uploadChunk",
            json!({"upload":upload,"offset":0,"hex":hex}),
        )
        .unwrap();
        assert!(m
            .handle("resources.uploadCommit", json!({"upload":upload}))
            .is_err());
        assert!(!lab.root.join("assets/qa.dat").exists());
        assert!(m
            .handle(
                "resources.uploadBegin",
                json!({"file":"qa.dat","kind":"geoip","bytes":dat().len()})
            )
            .is_ok());
    }
    #[test]
    fn a_late_resource_schedule_cannot_replace_a_newer_accepted_schedule() {
        let lab = Lab::new();
        let mut manager = lab.manager();
        let version = manager
            .handle("resources.scheduleVersion", json!({}))
            .unwrap();
        let configure = |base: Value, reload: bool| {
            json!({
                "base": base,
                "schedule": {"files": [], "reloadAfterAutoUpdates": reload},
            })
        };
        // Reaffirming the current schedule must also fence older requests.
        manager
            .handle("resources.configure", configure(version.clone(), true))
            .unwrap();
        let stale = manager
            .handle("resources.configure", configure(version, false))
            .unwrap_err();
        assert_eq!(stale.code, "RESOURCE_SCHEDULE_CHANGED");
        assert!(
            manager
                .state
                .lock()
                .unwrap()
                .stored
                .reload_after_auto_updates
        );
        let current = manager
            .handle("resources.scheduleVersion", json!({}))
            .unwrap();
        manager
            .handle("resources.configure", configure(current.clone(), false))
            .unwrap();
        let mut restarted = lab.manager();
        assert_eq!(
            restarted
                .handle("resources.configure", configure(current, true))
                .unwrap_err()
                .code,
            "SERVICE_INSTANCE_CHANGED"
        );
        assert!(
            !restarted
                .state
                .lock()
                .unwrap()
                .stored
                .reload_after_auto_updates
        );
    }
    #[test]
    fn auto_schedule_persists_and_abandoned_uploads_expire() {
        let lab = Lab::new();
        let mut m = lab.manager();
        let mut p = plan();
        p.url = "https://example.net/resource.dat".into();
        p.auto_update = true;
        p.interval_hours = 48;
        m.configure(vec![p.clone()], true).unwrap();
        drop(m);
        let mut m = lab.manager();
        assert_eq!(m.state.lock().unwrap().stored.files, vec![p]);
        let upload = m
            .handle(
                "resources.uploadBegin",
                json!({"file":"extra.dat","kind":"geoip","bytes":16}),
            )
            .unwrap()["upload"]
            .as_str()
            .unwrap()
            .to_owned();
        let now = Instant::now();
        m.expire_uploads(now + UPLOAD_LEASE);
        assert!(!m.upload_active());
        assert!(matches!(
            m.uploads.get(&upload),
            Some(UploadPhase::Cancelled(_))
        ));
    }
    #[test]
    fn interrupted_dat_import_can_be_retired_or_confirmed_with_its_reserved_token() {
        let lab = Lab::new();
        let mut manager = lab.manager();
        let reserve = |manager: &mut Manager| {
            manager
                .handle("resources.uploadPrepare", json!({}))
                .unwrap()["upload"]
                .clone()
        };
        let begin = |upload: &Value| {
            json!({
                "upload": upload, "file": "qa.dat", "kind": "geoip", "bytes": dat().len()
            })
        };
        let first = reserve(&mut manager);
        manager
            .handle("resources.uploadBegin", begin(&first))
            .unwrap();
        assert!(manager.upload_active());
        assert_eq!(
            manager
                .handle("resources.uploadCancel", json!({"upload":first}))
                .unwrap(),
            Value::Null
        );
        assert!(!manager.upload_active());
        assert!(manager
            .handle("resources.uploadBegin", begin(&first))
            .is_err());
        assert!(manager
            .handle("resources.uploadCommit", json!({"upload":first}))
            .is_err());

        let second = reserve(&mut manager);
        manager
            .handle("resources.uploadBegin", begin(&second))
            .unwrap();
        let hex = dat().iter().map(|b| format!("{b:02x}")).collect::<String>();
        manager
            .handle(
                "resources.uploadChunk",
                json!({"upload":second, "offset":0, "hex":hex}),
            )
            .unwrap();
        let committed = manager
            .handle("resources.uploadCommit", json!({"upload":second}))
            .unwrap();
        let recovered = manager
            .handle("resources.uploadCancel", json!({"upload":second}))
            .unwrap();
        assert_eq!(recovered["generation"], committed["generation"]);
        assert_eq!(fs::read(lab.root.join("assets/qa.dat")).unwrap(), dat());
    }
    #[test]
    fn failed_auto_launch_remains_due_and_retries_after_the_journal_is_readable() {
        let lab = Lab::new();
        let mut m = lab.manager();
        let mut p = plan();
        p.url = "https://example.net/resource.dat".into();
        p.auto_update = true;
        p.through_wayrill = true;
        m.configure(vec![p.clone()], true).unwrap();
        m.state
            .lock()
            .unwrap()
            .stored
            .metadata
            .get_mut(&p.file)
            .unwrap()
            .last_attempt_ms = 0;
        let journal = m.data.join("resources-transaction.json");
        fs::create_dir(&journal).unwrap();
        m.tick();

        let status = m.snapshot();
        let row = status["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["file"] == p.file)
            .unwrap();
        assert!(row["lastError"]
            .as_str()
            .unwrap()
            .contains("could not start"));
        assert_eq!(
            m.state.lock().unwrap().stored.metadata[&p.file].last_attempt_ms,
            0
        );
        fs::remove_dir(journal).unwrap();
        m.tick();
        assert!(m.worker.is_none());

        m.launch_retry.as_mut().unwrap().at = Instant::now();
        m.tick();
        m.worker.take().unwrap().join().unwrap();
        assert!(m.launch_retry.is_none());
        let s = m.state.lock().unwrap();
        let attempt = &s.stored.metadata[&p.file];
        assert!(attempt.last_attempt_ms > 0);
        assert_eq!(attempt.last_attempt_url, p.url);
        assert!(attempt
            .last_error
            .as_deref()
            .unwrap()
            .contains("loopback proxy"));
    }
    #[test]
    fn changed_url_requires_a_fresh_download_even_when_the_file_exists() {
        let lab = Lab::new();
        let mut m = lab.manager();
        fs::write(lab.root.join("assets/qa.dat"), dat()).unwrap();
        let mut p = plan();
        p.fetch_on_use = true;
        p.url = "https://example.net/new.dat".into();
        m.state.lock().unwrap().busy = true;
        assert_eq!(
            m.handle(
                "resources.ensure",
                json!({"files":[p.clone()],"required":["qa.dat"]})
            )
            .unwrap()["ready"],
            false
        );
        m.state.lock().unwrap().stored.metadata.insert(
            "qa.dat".into(),
            Metadata {
                source_url: p.url.clone(),
                ..Default::default()
            },
        );
        assert_eq!(
            m.handle(
                "resources.ensure",
                json!({"files":[p],"required":["qa.dat"]})
            )
            .unwrap()["ready"],
            true
        );
    }
    #[test]
    fn corrected_resource_source_does_not_inherit_another_urls_failure() {
        for configure_first in [false, true] {
            let lab = Lab::new();
            let mut failed = plan();
            failed.fetch_on_use = true;
            failed.url = "https://example.net/old.dat".into();
            storage::write(
                &lab.root.join("state/resources.json"),
                &json!({"files":[failed.clone()],"generation":0,"metadata":{"qa.dat":{
                    "updatedAtMs":0,"lastAttemptMs":123,"bytes":0,"sha256":"",
                    "sourceUrl":"","lastAttemptUrl":failed.url,"lastError":"Old source unavailable."
                }}}),
            )
            .unwrap();
            let mut m = lab.manager();
            let old = m
                .handle(
                    "resources.ensure",
                    json!({"files":[failed.clone()],"required":["qa.dat"]}),
                )
                .unwrap_err();
            assert_eq!(old.message, "Old source unavailable.");
            assert!(
                m.worker.is_none(),
                "polling the failed source must not restart it"
            );

            let mut corrected = failed;
            corrected.url = "https://example.net/corrected.dat".into();
            if configure_first {
                m.configure(vec![corrected.clone()], true).unwrap();
            }
            // Pre-cancel the worker, so this public-API regression never downloads
            // anything. Preparation must still accept the new source request.
            m.stop.store(true, Ordering::SeqCst);
            let changed = m.handle(
                "resources.ensure",
                json!({"files":[corrected],"required":["qa.dat"]}),
            );
            assert!(
                changed.is_ok(),
                "a corrected URL must not inherit {old:?}: {changed:?}"
            );
            assert_eq!(changed.unwrap()["ready"], false);
        }
    }
    #[test]
    fn accepts_all_downloaded_resource_files() {
        let r = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        for (path, kind) in [
            (r.join("resource-assets/geoip.dat"), "geoip"),
            (r.join("resource-assets/geosite.dat"), "geosite"),
            (r.join("routing-assets/ru-geoip.dat"), "geoip"),
            (r.join("routing-assets/ru-geosite.dat"), "geosite"),
            (r.join("routing-assets/ir-geoip.dat"), "geoip"),
            (r.join("routing-assets/ir-geosite.dat"), "geosite"),
            (r.join("routing-assets/cn-geoip.dat"), "geoip"),
            (r.join("routing-assets/cn-geosite.dat"), "geosite"),
        ] {
            assert!(validate_dat(&fs::read(path).unwrap(), kind).unwrap() > 0);
        }
    }
}
