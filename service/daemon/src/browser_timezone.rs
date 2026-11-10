//! Service-owned application timezone intent and process supervision.
use crate::native::{self, Handle};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use wayrill_protocol::{companion::Policy, ApiError, Result};
use windows_sys::Win32::{Foundation::*, Security::TOKEN_QUERY, System::Threading::*};
mod reconcile;
mod store;
use store::{Record, Records, Store};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Browser {
    pid: u32,
    created: u64,
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    browser: Browser,
    #[serde(default)]
    policy: Option<Policy>,
    #[serde(default)]
    expected_revision: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    id: String,
    expected_revision: u64,
    policy: Policy,
    #[serde(default)]
    startup: Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Add {
    path: Option<String>,
    package: Option<String>,
}
#[derive(Default)]
struct Runtime {
    browsers: Vec<Value>,
    processes: Vec<Value>,
    packages: Vec<Value>,
    statuses: BTreeMap<String, Value>,
    error: Option<String>,
    catalog_requested: bool,
    catalog_at: Option<Instant>,
    lease: Option<Instant>,
}
#[derive(Clone)]
pub struct Manager {
    policies: Arc<Mutex<Store>>,
    owner: String,
    state: Arc<(Mutex<Runtime>, Condvar)>,
}
impl Manager {
    pub fn new(path: PathBuf, owner: &str) -> Self {
        Self {
            policies: Arc::new(Mutex::new(Store::new(path))),
            owner: owner.into(),
            state: Arc::new((Mutex::new(Runtime::default()), Condvar::new())),
        }
    }
    pub fn request(&self, input: Input, write: bool) -> Result<Value> {
        let path = validate_browser(&input.browser, &self.owner)?;
        let key = identity(&path);
        let records = if write {
            let expected = input.expected_revision.ok_or_else(|| {
                ApiError::new("INVALID_REQUEST", "Missing application timezone revision.")
            })?;
            let policy = input.policy.ok_or_else(|| {
                ApiError::new("INVALID_REQUEST", "Missing browser timezone policy.")
            })?;
            policy.validate()?;
            self.change(
                key.clone(),
                Some(expected),
                Some(Record::new(path.clone(), None)),
                |record| {
                    record.path = path;
                    record.policy = policy;
                    record.package = None;
                    record.hidden = false;
                    true
                },
            )?
        } else {
            self.records()?
        };
        if let Some(record) = records.get(&key) {
            let mut result = json!(&record.policy);
            result["revision"] = json!(record.revision);
            result["configured"] = json!(true);
            result["supported"] = json!(true);
            Ok(result)
        } else {
            Ok(json!({"mode":"off","zone":"","revision":0,"configured":false,"supported":true}))
        }
    }
    pub fn list(&self) -> Result<Value> {
        let records = self.records()?;
        let mut state = self.state.0.lock().unwrap_or_else(|e| e.into_inner());
        state.lease = Some(Instant::now() + Duration::from_secs(30));
        if state
            .catalog_at
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(30))
        {
            state.catalog_requested = true;
        }
        self.state.1.notify_one();
        Ok(self.snapshot(&state, &records))
    }
    fn snapshot(&self, state: &Runtime, records: &Records) -> Value {
        let mut rows = BTreeMap::new();
        for browser in &state.browsers {
            if let Some(path) = browser["path"].as_str() {
                rows.insert(identity(path), json!({"id":identity(path),"path":path,"name":browser["name"],"revision":0,"policy":{"mode":"off","zone":""}}));
            }
        }
        for (id, record) in records {
            if record.hidden {
                if let Some(row) = rows.get_mut(id) {
                    row["revision"] = json!(record.revision);
                }
                continue;
            }
            let name = rows.get(id).map(|row| row["name"].clone());
            rows.insert(id.clone(), json!({"id":id,"name":name,"path":record.path,"package":record.package,"revision":record.revision,"policy":record.policy,"startup":record.startup}));
        }
        for (id, row) in &mut rows {
            row["status"] = state
                .statuses
                .get(id)
                .filter(|status| status["revision"] == row["revision"])
                .cloned()
                .unwrap_or_else(|| if row["revision"].as_u64().unwrap_or(0) > 0 && row["path"].as_str().is_some_and(crate::timezone_startup::required) {
                    json!({"phase":"preparing","message":"Preparing startup timezone settings…"})
                } else { json!({"phase":"waiting"}) });
        }
        json!({"browsers":rows.into_values().collect::<Vec<_>>(),"processes":state.processes,"packages":state.packages,"error":state.error})
    }
    pub fn refresh(&self) -> Result<Value> {
        self.state
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .catalog_requested = true;
        self.list()
    }
    pub fn edit(&self, input: Edit) -> Result<Value> {
        input.policy.validate()?;
        let initial = self
            .state
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .browsers
            .iter()
            .filter_map(|b| b["path"].as_str())
            .find(|p| identity(p) == input.id)
            .map(|path| Record::new(path.into(), None));
        self.change(input.id, Some(input.expected_revision), initial, |record| {
            record.policy = input.policy;
            if let Some(startup) = input.startup {
                record.startup = startup;
            }
            record.hidden = false;
            true
        })?;
        self.list()
    }
    pub fn add(&self, input: Add) -> Result<Value> {
        let (id, path, package) = match (input.path, input.package) {
            (Some(path), None) => {
                let path = local_executable(&path)?;
                (identity(&path), path, None)
            }
            (None, Some(family))
                if self
                    .state
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .packages
                    .iter()
                    .any(|p| p["family"] == family) =>
            {
                (format!("package:{family}"), family.clone(), Some(family))
            }
            _ => {
                return Err(ApiError::new(
                    "INVALID_REQUEST",
                    "Choose an executable or an installed package.",
                ))
            }
        };
        self.change(id, None, Some(Record::new(path, package)), |r| {
            let changed = r.hidden;
            r.hidden = false;
            changed
        })?;
        self.list()
    }
    pub fn remove(&self, input: Edit) -> Result<Value> {
        self.change(input.id, Some(input.expected_revision), None, |record| {
            record.policy = off();
            record.hidden = true;
            true
        })?;
        self.list()
    }
    fn records(&self) -> Result<Arc<Records>> {
        self.policies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot()
    }
    fn change(
        &self,
        id: String,
        expected: Option<u64>,
        initial: Option<Record>,
        edit: impl FnOnce(&mut Record) -> bool,
    ) -> Result<Arc<Records>> {
        let records = self
            .policies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .change(id, expected, initial, edit)?;
        self.state.1.notify_one();
        Ok(records)
    }
    pub fn start(&self, root: PathBuf) -> Result<Actor> {
        let manager = self.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = thread::Builder::new()
            .name("application-timezones".into())
            .spawn(move || reconcile::supervise(manager, root, stopped))
            .map_err(|e| ApiError::io("Start timezone supervisor", e))?;
        Ok(Actor {
            stop,
            state: self.state.clone(),
            thread: Some(thread),
        })
    }
}
fn off() -> Policy {
    Policy {
        mode: "off".into(),
        ..Policy::default()
    }
}
fn local_executable(path: &str) -> Result<String> {
    let valid = |path: &str| {
        path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && path.as_bytes().get(1..3) == Some(b":\\")
            && !path[3..].contains(':')
            && !path.chars().any(char::is_control)
            && Path::new(path)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    };
    let invalid = || ApiError::new("INVALID_REQUEST", "Choose a local Windows executable.");
    if !valid(path) {
        return Err(invalid());
    }
    let canonical = std::fs::canonicalize(path).map_err(|e| ApiError::io("Read application", e))?;
    let path = canonical.to_string_lossy();
    let path = path.trim_start_matches(r"\\?\");
    if !valid(path) || !canonical.is_file() {
        return Err(invalid());
    }
    Ok(path.into())
}
pub struct Actor {
    stop: Arc<AtomicBool>,
    state: Arc<(Mutex<Runtime>, Condvar)>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Drop for Actor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.state.1.notify_one();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn identity(path: &str) -> String {
    wayrill_protocol::application_identity::key(path)
}
fn select_process_record<'a>(
    records: &'a BTreeMap<String, Record>,
    process: &Value,
    installation: &Path,
) -> Option<(&'a String, &'a Record)> {
    let path = process["path"].as_str()?;
    let direct = select_record(
        records,
        &identity(path),
        process["package"]
            .as_str()
            .filter(|_| process["packageApplication"] == true),
    );
    // Only the inventory's verified, same-owner WebView2 host is inherited.
    // Never extend a rule to arbitrary child apps or Wayrill's own WebViews.
    let inherited = process["host"]["path"]
        .as_str()
        .filter(|path| {
            !Path::new(&path.to_lowercase())
                .starts_with(installation.to_string_lossy().to_lowercase())
        })
        .and_then(|path| {
            select_record(
                records,
                &identity(path),
                process["host"]["package"].as_str(),
            )
        });
    direct
        .filter(|(_, r)| !r.hidden)
        .or(inherited.filter(|(_, r)| !r.hidden))
        .or(direct)
        .or(inherited)
}
fn select_record<'a>(
    records: &'a BTreeMap<String, Record>,
    id: &str,
    package: Option<&str>,
) -> Option<(&'a String, &'a Record)> {
    let executable = records.get_key_value(id);
    let package = package.and_then(|family| records.get_key_value(&format!("package:{family}")));
    // Hidden Off records undo surviving hooks; removing an override must not
    // permanently exclude the application from an active package policy.
    executable
        .filter(|(_, r)| !r.hidden)
        .or(package.filter(|(_, r)| !r.hidden))
        .or(executable)
        .or(package)
}
fn validate_browser(browser: &Browser, owner: &str) -> Result<String> {
    let failure = || {
        ApiError::new(
            "TIMEZONE_BROWSER",
            "Cannot verify the Companion's browser process.",
        )
    };
    unsafe {
        let process = Handle(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            browser.pid,
        ));
        if process.0.is_null() {
            return Err(failure());
        }
        let mut born: FILETIME = std::mem::zeroed();
        let mut ended = std::mem::zeroed();
        let mut kernel = std::mem::zeroed();
        let mut user = std::mem::zeroed();
        if GetProcessTimes(process.0, &mut born, &mut ended, &mut kernel, &mut user) == 0
            || (((born.dwHighDateTime as u64) << 32) | born.dwLowDateTime as u64) != browser.created
        {
            return Err(failure());
        }
        let mut image = vec![0; 32768];
        let mut length = image.len() as u32;
        if QueryFullProcessImageNameW(process.0, 0, image.as_mut_ptr(), &mut length) == 0 {
            return Err(failure());
        }
        let path = String::from_utf16_lossy(&image[..length as usize]);
        if !path.eq_ignore_ascii_case(&browser.path)
            || !Path::new(&path).file_name().is_some_and(|v| {
                [
                    "chrome.exe",
                    "msedge.exe",
                    "opera.exe",
                    "brave.exe",
                    "vivaldi.exe",
                    "firefox.exe",
                ]
                .iter()
                .any(|name| v.eq_ignore_ascii_case(name))
            })
        {
            return Err(failure());
        }
        let mut token = ptr::null_mut();
        if OpenProcessToken(process.0, TOKEN_QUERY, &mut token) == 0 {
            return Err(failure());
        }
        let token = Handle(token);
        if native::token_sid(token.0)? != owner {
            return Err(failure());
        }
        Ok(path)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage;
    #[test]
    fn concurrent_editors_cannot_overwrite_the_same_policy_revision() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-timezone-concurrent-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let image = r"C:\Apps\Reader.exe";
        let id = identity(image);
        let manager = Manager::new(path.clone(), "test-owner");
        manager
            .change(
                id.clone(),
                Some(0),
                Some(Record::new(image.into(), None)),
                |_| true,
            )
            .unwrap();
        let gate = Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = ["Asia/Tokyo", "Europe/Berlin"]
            .into_iter()
            .map(|zone| {
                let manager = manager.clone();
                let id = id.clone();
                let gate = gate.clone();
                thread::spawn(move || {
                    gate.wait();
                    manager.edit(Edit {
                        id,
                        expected_revision: 1,
                        startup: None,
                        policy: Policy {
                            mode: "manual".into(),
                            zone: zone.into(),
                            ..Policy::default()
                        },
                    })
                })
            })
            .collect();
        gate.wait();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results.iter().find_map(|r| r.as_ref().err()).unwrap().code,
            "CONFIG_CHANGED"
        );
        let current = manager.records().unwrap();
        let recovered = Store::new(path.clone()).snapshot().unwrap();
        assert_eq!(current[&id].revision, 2);
        assert_eq!(recovered[&id].policy.zone, current[&id].policy.zone);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn readding_a_removed_executable_advances_its_activation_revision() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-timezone-readd-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let executable = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_owned();
        let id = identity(&executable);
        let record = Record {
            path: executable.clone(),
            revision: 4,
            policy: off(),
            package: None,
            startup: false,
            hidden: true,
        };
        storage::write(&path, &BTreeMap::from([(id, record)])).unwrap();
        let manager = Manager::new(path.clone(), "test-owner");
        let rows = manager
            .add(Add {
                path: Some(executable.clone()),
                package: None,
            })
            .unwrap();
        assert_eq!(rows["browsers"][0]["revision"], 5);
        assert_eq!(rows["browsers"][0]["policy"]["mode"], "off");
        // Adding an already visible entry preserves its policy and revision.
        assert_eq!(
            manager
                .add(Add {
                    path: Some(executable),
                    package: None
                })
                .unwrap()["browsers"][0]["revision"],
            5
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn older_version_specific_settings_keep_the_latest_intent_after_migration() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-timezone-versions-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let old = Record {
            path: r"C:\Apps\Chat\app-1.0.0\Chat.exe".into(),
            revision: 7,
            policy: serde_json::from_value(json!({"mode":"manual","zone":"Asia/Tokyo"})).unwrap(),
            package: None,
            startup: false,
            hidden: false,
        };
        storage::write(&path, &BTreeMap::from([("older-version-key", old.clone())])).unwrap();
        let current = Store::new(path.clone()).snapshot().unwrap();
        let id = identity(r"C:\Apps\Chat\app-1.0.1\Chat.exe");
        assert_eq!(current[&id].revision, 7);
        assert_eq!(current[&id].policy.zone, "Asia/Tokyo");
        let removed = Record {
            path: r"C:\Apps\Chat\app-1.0.1\Chat.exe".into(),
            revision: 8,
            policy: off(),
            hidden: true,
            ..old.clone()
        };
        storage::write(
            &path,
            &BTreeMap::from([("older-version-key", old), ("newer-version-key", removed)]),
        )
        .unwrap();
        let current = Store::new(path.clone()).snapshot().unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[&id].revision, 8);
        assert_eq!(current[&id].policy.mode, "off");
        assert!(current[&id].hidden);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn webview_inheritance_respects_explicit_choices_removal_and_own_app_boundary() {
        let host = r"C:\Apps\Reader.exe";
        let engine = r"C:\Runtime\msedgewebview2.exe";
        let id = identity(host);
        let engine_id = identity(engine);
        let record = |path: &str, hidden| Record {
            path: path.into(),
            revision: 1,
            policy: if hidden {
                off()
            } else {
                serde_json::from_value(json!({"mode":"manual","zone":"Asia/Tokyo"})).unwrap()
            },
            package: None,
            startup: false,
            hidden,
        };
        let process = json!({"path":engine,"host":{"path":host}});
        let root = Path::new(r"C:\Program Files\Wayrill");
        let mut records = BTreeMap::from([(id.clone(), record(host, false))]);
        assert_eq!(
            select_process_record(&records, &process, root).unwrap().0,
            &id
        );
        records.insert(
            engine_id.clone(),
            Record {
                policy: off(),
                ..record(engine, false)
            },
        );
        assert_eq!(
            select_process_record(&records, &process, root).unwrap().0,
            &engine_id
        );
        records.insert(engine_id.clone(), record(engine, true));
        assert_eq!(
            select_process_record(&records, &process, root).unwrap().0,
            &id
        );
        records.remove(&engine_id);
        records.insert(id.clone(), record(host, true));
        assert_eq!(
            select_process_record(&records, &process, root)
                .unwrap()
                .1
                .policy
                .mode,
            "off"
        );
        assert!(select_process_record(&records, &json!({"path":engine}), root).is_none());
        let own = r"c:\program files\WAYRILL\Aquifer\wayrill-aquifer.exe";
        records.insert(identity(own), record(own, false));
        assert!(
            select_process_record(&records, &json!({"path":engine,"host":{"path":own}}), root)
                .is_none()
        );
    }
    #[test]
    fn removing_an_executable_override_resumes_its_package_policy() {
        let record = |mode: &str, hidden| Record {
            path: String::new(),
            revision: 1,
            policy: Policy {
                mode: mode.into(),
                ..Policy::default()
            },
            package: None,
            startup: false,
            hidden,
        };
        let mut records = BTreeMap::from([
            ("exe".into(), record("manual", false)),
            ("package:app".into(), record("main", false)),
        ]);
        assert_eq!(
            select_record(&records, "exe", Some("app"))
                .unwrap()
                .1
                .policy
                .mode,
            "manual"
        );
        records.insert("exe".into(), record("off", true));
        assert_eq!(
            select_record(&records, "exe", Some("app"))
                .unwrap()
                .1
                .policy
                .mode,
            "main"
        );
        assert_eq!(
            select_record(&records, "exe", None).unwrap().1.policy.mode,
            "off"
        );
        records.insert("package:app".into(), record("off", true));
        assert_eq!(
            select_record(&records, "exe", Some("app"))
                .unwrap()
                .1
                .policy
                .mode,
            "off"
        );
    }
    #[test]
    fn browser_versions_share_policy_but_installations_do_not() {
        assert_eq!(
            identity(r"C:\Users\A\Opera\145.2.3\opera.exe"),
            identity(r"c:\users\a\opera\146.3.4\OPERA.EXE")
        );
        assert_ne!(
            identity(r"C:\Chrome\chrome.exe"),
            identity(r"C:\Chrome Beta\chrome.exe")
        );
        assert_eq!(
            identity(r"C:\Users\A\Discord\app-1.0.9012\Discord.exe"),
            identity(r"C:\Users\A\Discord\app-1.0.9013\Discord.exe")
        );
        assert_ne!(
            identity(r"C:\Users\A\Discord\app-1.0.9012\Discord.exe"),
            identity(r"C:\Users\B\Discord\app-1.0.9012\Discord.exe")
        );
    }
    #[test]
    fn detected_browser_removal_preserves_the_catalog_row_and_durable_off_intent() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-browser-timezone-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let browser = r"C:\Browsers\chrome.exe";
        let id = identity(browser);
        let records = BTreeMap::from([(
            id.clone(),
            Record {
                path: browser.into(),
                revision: 1,
                policy: serde_json::from_value(json!({"mode":"manual","zone":"Asia/Tokyo"}))
                    .unwrap(),
                package: None,
                startup: false,
                hidden: false,
            },
        )]);
        storage::write(&path, &records).unwrap();
        let manager = Manager::new(path.clone(), "test-owner");
        manager
            .state
            .0
            .lock()
            .unwrap()
            .browsers
            .push(json!({"path":browser,"name":"Chrome"}));
        manager
            .state
            .0
            .lock()
            .unwrap()
            .statuses
            .insert(id.clone(), json!({"phase":"applied","revision":1}));
        let edit = |revision| Edit {
            id: id.clone(),
            expected_revision: revision,
            policy: serde_json::from_value(json!({"mode":"off","zone":""})).unwrap(),
            startup: None,
        };
        assert_eq!(manager.edit(edit(1)).unwrap()["browsers"][0]["revision"], 2);
        let current = manager.list().unwrap();
        assert_eq!(current["browsers"][0]["status"]["phase"], "waiting");
        assert_eq!(current["browsers"][0]["policy"]["mode"], "off");
        assert_eq!(current["browsers"][0]["name"], "Chrome");
        assert_eq!(current["browsers"][0]["path"], browser);
        manager.remove(edit(2)).unwrap();
        let removed = manager.list().unwrap();
        assert_eq!(removed["browsers"][0]["name"], "Chrome");
        assert_eq!(removed["browsers"][0]["policy"]["mode"], "off");
        // Removal remains durable Off, so service recovery can undo a hook
        // already loaded into an application that outlived the service.
        let recovered: BTreeMap<String, Record> = storage::read(&path).unwrap().unwrap();
        assert_eq!(recovered[&id].policy.mode, "off");
        assert_eq!(recovered[&id].revision, 3);
        assert!(recovered[&id].hidden);
        std::fs::remove_file(path).unwrap();
    }
}
