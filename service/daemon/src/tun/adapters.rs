//! Persistent software devices, scoped to protected installation records. Names
//! are presentation only: every native mutation verifies the device's private
//! ownership property and its Windows interface GUID.
use super::{
    configuration::{self, CaptureRoute},
    guid_luid, random_id, Adapter,
};
use crate::{native, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    path::{Path, PathBuf},
    ptr,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::{
    core::GUID,
    Win32::{
        Devices::{DeviceAndDriverInstallation::*, Enumeration::Pnp::*, Properties::*},
        Foundation::*,
        NetworkManagement::{IpHelper::*, Ndis::NET_LUID_LH},
        Storage::FileSystem::*,
        System::Registry::*,
    },
};

// The SDK import library selects the software-device API set on Windows 10.
// Calling cfgmgr32's compatibility export directly fails on some Windows 10 builds.
#[link(name = "Swdevice")]
unsafe extern "system" {
    #[link_name = "SwDeviceCreate"]
    fn create_device(
        enumerator: *const u16,
        parent: *const u16,
        info: *const SW_DEVICE_CREATE_INFO,
        count: u32,
        properties: *const DEVPROPERTY,
        callback: SW_DEVICE_CREATE_CALLBACK,
        context: *const c_void,
        handle: *mut HSWDEVICE,
    ) -> i32;
    #[link_name = "SwDeviceClose"]
    fn close_device(handle: HSWDEVICE);
    #[link_name = "SwDeviceSetLifetime"]
    fn set_lifetime(handle: HSWDEVICE, lifetime: SW_DEVICE_LIFETIME) -> i32;
}
const OWNER_KEY: DEVPROPKEY = DEVPROPKEY {
    fmtid: GUID::from_u128(0x203c6bfc_77e9_4900_b599_636fe1f58c29),
    pid: 2,
};
const NAME_KEY: DEVPROPKEY = DEVPROPKEY {
    fmtid: GUID::from_u128(0x3361c968_2f2e_4660_b47e_699cdc4c32b9),
    pid: 3,
};
const NET_CLASS: GUID = GUID::from_u128(0x4d36e972_e325_11ce_bfc1_08002be10318);
const CLASS_KEY: DEVPROPKEY = DEVPROPKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 10,
};
const FRIENDLY_KEY: DEVPROPKEY = DEVPROPKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};
const DESCRIPTION_KEY: DEVPROPKEY = DEVPROPKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 2,
};

fn error(message: impl Into<String>) -> ApiError {
    ApiError::new("TUN_ADAPTER", message)
}
fn os(code: u32, operation: &str) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(ApiError::io(
            operation,
            std::io::Error::from_raw_os_error(code as i32),
        ))
    }
}
fn hr(code: i32, operation: &str) -> Result<()> {
    if code >= 0 {
        Ok(())
    } else {
        Err(error(format!(
            "{operation} failed (0x{:08x}).",
            code as u32
        )))
    }
}
pub(super) fn guid_string(id: &str) -> String {
    format!(
        "{}-{}-{}-{}-{}",
        &id[..8],
        &id[8..12],
        &id[12..16],
        &id[16..20],
        &id[20..]
    )
}
fn valid_guid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Host,
    Ics,
}
impl Kind {
    fn key(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Ics => "ics",
        }
    }
    fn description(self) -> &'static str {
        match self {
            Self::Host => "Wayrill retained TUN",
            Self::Ics => "Wayrill retained ICS TUN",
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    kind: Kind,
    instance: String,
    token: String,
    name: String,
    guid: Option<String>,
    #[serde(default)]
    settings_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    capture_routes: Vec<CaptureRoute>,
}
impl Record {
    fn valid(&self, kind: Kind) -> bool {
        self.version == 1
            && self.kind == kind
            && self.capture_routes.iter().all(CaptureRoute::valid)
            && valid_guid(&self.instance)
            && self.token.len() == 32
            && self.token.bytes().all(|c| c.is_ascii_hexdigit())
            && valid_name(&self.name)
            && self.guid.as_ref().is_none_or(|id| valid_guid(id))
            && self
                .settings_hash
                .as_ref()
                .is_none_or(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()))
    }
    fn retire_routes(&mut self, data: &Path) -> Result<()> {
        if self.capture_routes.is_empty() {
            return Ok(());
        }
        if let Some((_, row)) = interface(self)? {
            configuration::retire_routes(row.InterfaceIndex, &self.capture_routes)?;
        }
        // Missing/already-removed rows and externally changed rows are released.
        // On an OS error keep the durable inventory for the next Stop/recovery.
        let mut cleared = self.clone();
        cleared.capture_routes.clear();
        storage::write(&Store::new(data).path(self.kind), &cleared)?;
        *self = cleared;
        Ok(())
    }
    fn device_id(&self) -> String {
        format!("SWD\\Wintun\\{{{}}}", self.instance)
    }
}
pub(super) fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.encode_utf16().count() <= 100
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub reuse_adapters: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            reuse_adapters: true,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Remove {
    pub kind: Kind,
    pub expected_id: String,
}
pub struct Store {
    data: PathBuf,
}
impl Store {
    pub fn new(data: &Path) -> Self {
        Self {
            data: data.to_owned(),
        }
    }
    fn path(&self, kind: Kind) -> PathBuf {
        self.data.join(format!("tun-adapter-{}.json", kind.key()))
    }
    fn load(&self, kind: Kind) -> Result<Option<Record>> {
        let record: Option<Record> = storage::read(&self.path(kind))?;
        if record.as_ref().is_some_and(|r| !r.valid(kind)) {
            return Err(error(
                "The protected TUN adapter ownership record is invalid; no adapters were changed.",
            ));
        }
        Ok(record)
    }
    pub fn preferences(&self) -> Result<Preferences> {
        Ok(storage::read(&self.data.join("tun-adapters.json"))?.unwrap_or_default())
    }
    pub fn set(&self, value: Preferences) -> Result<()> {
        storage::write(&self.data.join("tun-adapters.json"), &value)
    }
    fn lock(&self, kind: Kind) -> Result<native::Handle> {
        let path = native::wide(
            &self
                .data
                .join(format!("tun-adapter-{}.lock", kind.key()))
                .to_string_lossy(),
        );
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            if [ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION].contains(&code) {
                let mut e=ApiError::new("TUN_ADAPTER_BUSY","This Wayrill adapter is still in use. Stop routing and finish sharing recovery first.");
                e.retryable = true;
                return Err(e);
            }
            return Err(ApiError::io(
                "Acquire owned TUN lease",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        Ok(native::Handle(handle))
    }
    pub fn ids(&self) -> Result<Vec<String>> {
        [Kind::Host, Kind::Ics]
            .into_iter()
            .map(|kind| self.load(kind))
            .collect::<Result<Vec<_>>>()
            .map(|records| {
                records
                    .into_iter()
                    .flatten()
                    .filter_map(|r| r.guid)
                    .collect()
            })
    }
    pub(super) fn removal_ids(&self, kind: Kind) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        if let Some(record) = self.load(kind)? {
            ids.extend(record.guid.clone());
            if let Some(id) = observed_guid(&record)? {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
    }
    pub(super) fn has(&self, kind: Kind) -> Result<bool> {
        Ok(self.load(kind)?.is_some())
    }
    pub(super) fn preserve_disabled(&self) -> Result<()> {
        for kind in [Kind::Host, Kind::Ics] {
            let _lease = match self.lock(kind) {
                Ok(lease) => lease,
                Err(e) if e.code == "TUN_ADAPTER_BUSY" => continue,
                Err(e) => return Err(e),
            };
            let Some(record) = self.load(kind)? else {
                continue;
            };
            if disabled_device(&record)?.is_some() {
                if kind == Kind::Ics {
                    super::sharing::record_disabled(&self.data)?;
                }
                preserve_disabled(&record)?;
            }
        }
        Ok(())
    }
    pub(super) fn rehydrate(&self) -> Result<()> {
        self.preserve_disabled()?;
        // Software devices become dormant across a Windows boot. Re-enumerate
        // every recorded device before loading Wintun: its orphan maintenance
        // would otherwise remove another dormant retained slot.
        let mut devices = Vec::new();
        for kind in [Kind::Host, Kind::Ics] {
            let Some(record) = self.load(kind)? else {
                continue;
            };
            let lease = match self.lock(kind) {
                Ok(lease) => lease,
                Err(e) if e.code == "TUN_ADAPTER_BUSY" => continue,
                Err(e) => return Err(e),
            };
            if native_guid(&record)?.is_some() {
                let device = SoftwareDevice::open(record)?;
                device.set_enabled(false)?;
                devices.push((device, lease));
            }
        }
        Ok(())
    }
    pub fn inspect(
        &self,
        active: &[String],
        recovery: bool,
        allowed: impl Fn(Kind) -> bool,
    ) -> Result<Value> {
        let mut items = Vec::new();
        for kind in [Kind::Host, Kind::Ics] {
            if let Some(record) = self.load(kind)? {
                let (state, issue) = match interface(&record) {
                    Ok(Some((_, row))) => (
                        if active.iter().any(|id| Some(id) == record.guid.as_ref()) {
                            "running"
                        } else if row.AdminStatus == 2 {
                            "disabled"
                        } else {
                            "enabled"
                        },
                        None,
                    ),
                    Ok(None) => ("missing", None),
                    Err(e) => ("conflict", Some(e.message)),
                };
                // A network reset may change this owned devnode's GUID. It
                // must not be adopted for routing, but explicit removal can
                // still prove the exact device's protected ownership token.
                let removable = state != "conflict" || observed_guid(&record).is_ok();
                items.push(json!({"kind":kind,"id":record.instance,"name":record.name,"interfaceId":record.guid,"state":state,"error":issue,"canRemove":state!="running" && removable && allowed(kind) && self.lock(kind).is_ok()}));
            }
        }
        Ok(
            json!({"reuseAdapters":self.preferences()?.reuse_adapters,"adapters":items,"recoveryPending":recovery}),
        )
    }
    pub(super) fn acquire(&self, exe: &Path, kind: Kind, name: &str) -> Result<Adapter> {
        if !valid_name(name) {
            return Err(error(
                "Enter a valid, unique TUN adapter name (up to 100 characters).",
            ));
        }
        self.preserve_disabled()?;
        let keep = self.preferences()?.reuse_adapters;
        let lease = self.lock(kind)?;
        let mut record = self.load(kind)?;
        if !keep && record.is_none() {
            return Adapter::create(exe, name);
        }
        if record.is_none() {
            super::ensure_name_available(name, None)?;
            // The official signed package installs the driver on the first use.
            // No API layouts are inspected and no shared driver is uninstalled.
            Adapter::ensure_driver(exe)?;
            let value = Record {
                version: 1,
                kind,
                instance: guid_string(&random_id()?),
                token: random_id()?,
                name: name.into(),
                guid: None,
                settings_hash: None,
                capture_routes: Vec::new(),
            };
            storage::write(&self.path(kind), &value)?; // Ownership precedes enumeration.
            record = Some(value);
        }
        let mut record = record.unwrap();
        let existing = native_guid(&record)?;
        if existing.is_none() && record.guid.is_some() {
            // Windows or an explicit device-manager action removed the vNIC.
            // Regenerate the instance identity rather than adopting a namesake.
            super::ensure_name_available(name, None)?;
            record.instance = guid_string(&random_id()?);
            record.token = random_id()?;
            record.guid = None;
            record.settings_hash = None;
            record.capture_routes.clear();
            record.name = name.into();
            storage::write(&self.path(kind), &record)?;
        } else {
            super::ensure_name_available(name, record.guid.as_deref())?;
        }
        preserve_disabled(&record)?;
        let mut device = SoftwareDevice::open(record.clone())?;
        let guid = native_guid(&record)?
            .ok_or_else(|| error("The owned TUN did not expose a Windows interface."))?;
        if record.guid.as_ref().is_some_and(|old| old != &guid) {
            return Err(error(
                "The owned TUN interface identity changed; it was left unchanged.",
            ));
        }
        record.guid = Some(guid.clone());
        storage::write(&self.path(kind), &record)?;
        device.record = record.clone();
        // Own cleanup before the first setup mutation or fallible Wintun
        // open. Every early return must honor retention/disposable policy.
        let mut pending = Lease {
            device,
            lock: lease,
            data: self.data.clone(),
            keep,
            retired: false,
        };
        pending.device.set_enabled(false)?;
        record.retire_routes(&self.data)?;
        pending.device.record = record.clone();
        if record.name != name {
            super::rename_adapter(&guid, name)?;
            pending.device.set_name(name)?;
            record.name = name.into();
            storage::write(&self.path(kind), &record)?;
            pending.device.record = record.clone();
        } else {
            super::rename_adapter(&guid, name)?;
        }
        let mut adapter = Adapter::open_owned(exe, &record.name, &guid)?;
        adapter.persistent = Some(pending);
        Ok(adapter)
    }
    pub fn disable(&self, kind: Kind, expected_luid: Option<NET_LUID_LH>) -> Result<()> {
        let _lock = self.lock(kind)?;
        if let Some(mut record) = self.load(kind)? {
            if let Some((_, row)) = interface(&record)? {
                if expected_luid
                    .is_some_and(|luid| unsafe { luid.Value != row.InterfaceLuid.Value })
                {
                    return Err(error(
                        "The capture interface no longer matches its ownership record.",
                    ));
                }
                set_enabled(row.InterfaceIndex, false)?;
            }
            record.retire_routes(&self.data)?;
        }
        Ok(())
    }
    pub fn remove(&self, request: Remove) -> Result<()> {
        let _lock = self.lock(request.kind)?;
        let record = self
            .load(request.kind)?
            .ok_or_else(|| error("The adapter was already removed. Refresh the list."))?;
        if request.expected_id != record.instance {
            return Err(error(
                "The adapter list changed. Refresh before removing it.",
            ));
        }
        if let Some(id) = observed_guid(&record)? {
            // Use the observed identity only in this deletion handle; the
            // protected routing record is never changed/adopted. Re-acquire
            // SWD lifetime control without loading Wintun or enabling PnP.
            let mut deleting = record.clone();
            deleting.guid = Some(id);
            let mut device = SoftwareDevice::enumerate(deleting)?;
            device.remove()?;
        }
        storage::remove(&self.path(request.kind))
    }
    pub fn remove_all(&self) -> Result<()> {
        for kind in [Kind::Host, Kind::Ics] {
            if let Some(r) = self.load(kind)? {
                self.remove(Remove {
                    kind,
                    expected_id: r.instance,
                })?;
            }
        }
        Ok(())
    }
}

// A software-device handle is ours, unlike Wintun's deliberately opaque API
// handles. Retention uses Microsoft's documented lifetime API.
pub(super) struct Lease {
    device: SoftwareDevice,
    lock: native::Handle,
    data: PathBuf,
    keep: bool,
    retired: bool,
}
unsafe impl Send for Lease {}
impl Lease {
    pub fn rename(&mut self, name: &str) -> Result<()> {
        let old = self.device.record.clone();
        let guid = native_guid(&old)?.ok_or_else(|| error("The owned adapter is missing."))?;
        super::rename_adapter(&guid, name)?;
        let mut next = old.clone();
        next.name = name.into();
        let changed = self
            .device
            .set_name(name)
            .and_then(|_| storage::write(&Store::new(&self.data).path(old.kind), &next));
        if let Err(error) = changed {
            let property = self.device.set_name(&old.name);
            let alias = super::rename_adapter(&guid, &old.name);
            if property.is_err() || alias.is_err() {
                return Err(super::invalid("The owned adapter rename failed and its old name could not be restored. Stop routing to recover."));
            }
            return Err(error);
        }
        self.device.record = next;
        Ok(())
    }
    pub fn preserve_disabled(&self) -> Result<()> {
        preserve_disabled(&self.device.record)
    }
    pub fn disabled(&self) -> Result<bool> {
        Ok(disabled_device(&self.device.record)?.is_some())
    }
    pub fn matches(&self, settings: &Value) -> bool {
        self.device.record.settings_hash.as_deref() == Some(settings_hash(settings).as_str())
    }
    pub fn remember(&mut self, settings: Option<&Value>) -> Result<()> {
        let mut record = self.device.record.clone();
        record.settings_hash = settings.map(settings_hash);
        storage::write(&Store::new(&self.data).path(record.kind), &record)?;
        self.device.record = record;
        Ok(())
    }
    pub fn track_routes(&mut self, routes: Vec<CaptureRoute>) -> Result<()> {
        let mut record = self.device.record.clone();
        for route in routes {
            if !record.capture_routes.contains(&route) {
                record.capture_routes.push(route);
            }
        }
        storage::write(&Store::new(&self.data).path(record.kind), &record)?;
        self.device.record = record;
        Ok(())
    }
    pub fn park(&self) -> Result<()> {
        self.preserve_disabled()?;
        self.device.set_enabled(false)
    }
    pub fn stop(&mut self) -> Result<()> {
        if self.retired {
            return Ok(());
        }
        self.device.set_enabled(false)?;
        self.device.record.retire_routes(&self.data)?;
        if !self.keep {
            self.device.remove()?;
            storage::remove(&Store::new(&self.data).path(self.device.record.kind))?;
        }
        self.retired = true;
        Ok(())
    }
}
fn settings_hash(settings: &Value) -> String {
    let mut settings = settings.clone();
    if let Some(object) = settings.as_object_mut() {
        object.remove("userLevel");
        object.remove("name");
        object.remove("autoOutboundsInterface");
    }
    crate::system_native::hex(&Sha256::digest(
        format!("{}:{}", crate::native::XRAY_SHA, settings).as_bytes(),
    ))
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Err(e) = self.stop() {
            crate::diagnostics::error!("Retire owned TUN: {}", e.message);
        }
        let _ = &self.lock;
    }
}
struct Completion {
    value: Mutex<Option<(i32, String)>>,
    ready: Condvar,
}
unsafe extern "system" fn created(
    _: HSWDEVICE,
    result: i32,
    context: *const c_void,
    id: *const u16,
) {
    let completion = Arc::from_raw(context.cast::<Completion>());
    let id = if id.is_null() {
        String::new()
    } else {
        let mut n = 0;
        while n < 200 && *id.add(n) != 0 {
            n += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(id, n))
    };
    if let Ok(mut value) = completion.value.lock() {
        *value = Some((result, id));
        completion.ready.notify_one();
    };
}
struct SoftwareDevice {
    handle: HSWDEVICE,
    record: Record,
}
impl SoftwareDevice {
    fn open(record: Record) -> Result<Self> {
        let device = Self::enumerate(record)?;
        let until = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            match interface(&device.record) {
                Ok(Some((dev, _))) if driver_ready(dev, &device.record)? => break,
                Err(e) if e.code == "TUN_ADAPTER" => return Err(e),
                result if std::time::Instant::now() >= until => {
                    return Err(result
                        .err()
                        .unwrap_or_else(|| error("The owned TUN driver did not become ready.")));
                }
                _ => std::thread::sleep(Duration::from_millis(80)),
            }
        }
        Ok(device)
    }
    fn enumerate(record: Record) -> Result<Self> {
        // Verify before re-acquiring an existing SWD instance. No caller can
        // turn a foreign interface into an owned one by supplying its name.
        let _ = native_guid(&record)?;
        let id = native::wide(&format!("{{{}}}", record.instance));
        let parent = native::wide("HTREE\\ROOT\\0");
        let hardware: Vec<u16> = "Wintun\0\0".encode_utf16().collect();
        let description = native::wide(record.kind.description());
        let name = native::wide(&record.name);
        let token = native::wide(&record.token);
        let info = SW_DEVICE_CREATE_INFO {
            cbSize: std::mem::size_of::<SW_DEVICE_CREATE_INFO>() as u32,
            pszInstanceId: id.as_ptr(),
            pszzHardwareIds: hardware.as_ptr(),
            CapabilityFlags: (SWDeviceCapabilitiesSilentInstall
                | SWDeviceCapabilitiesDriverRequired) as u32,
            pszDeviceDescription: description.as_ptr(),
            ..Default::default()
        };
        let properties = [
            property(NAME_KEY, &name),
            property(OWNER_KEY, &token),
            property(FRIENDLY_KEY, &description),
            property(DESCRIPTION_KEY, &description),
            DEVPROPERTY {
                CompKey: DEVPROPCOMPKEY {
                    Key: CLASS_KEY,
                    Store: DEVPROP_STORE_SYSTEM,
                    LocaleName: ptr::null(),
                },
                Type: DEVPROP_TYPE_GUID,
                BufferSize: 16,
                Buffer: (&NET_CLASS as *const GUID).cast_mut().cast(),
            },
        ];
        let completion = Arc::new(Completion {
            value: Mutex::new(None),
            ready: Condvar::new(),
        });
        let context = Arc::into_raw(completion.clone());
        let mut handle = ptr::null_mut();
        let result = unsafe {
            create_device(
                native::wide("Wintun").as_ptr(),
                parent.as_ptr(),
                &info,
                properties.len() as u32,
                properties.as_ptr(),
                Some(created),
                context.cast(),
                &mut handle,
            )
        };
        if result < 0 {
            unsafe {
                drop(Arc::from_raw(context));
            }
            hr(result, "Enumerate owned TUN")?;
        }
        let device = Self { handle, record };
        let value = completion
            .value
            .lock()
            .map_err(|_| error("TUN creation observer failed."))?;
        let (value, _) = completion
            .ready
            .wait_timeout_while(value, Duration::from_secs(20), |v| v.is_none())
            .map_err(|_| error("TUN creation observer failed."))?;
        let (result, id) = value
            .as_ref()
            .ok_or_else(|| error("Windows did not finish enumerating the owned TUN adapter."))?;
        hr(*result, "Install owned TUN")?;
        if !id.eq_ignore_ascii_case(&device.record.device_id()) {
            return Err(error("Windows returned an unexpected TUN device identity."));
        }
        hr(
            unsafe { set_lifetime(handle, SWDeviceLifetimeParentPresent) },
            "Retain owned TUN",
        )?;
        Ok(device)
    }
    fn set_enabled(&self, enabled: bool) -> Result<()> {
        if let Some((_, row)) = interface(&self.record)? {
            set_enabled(row.InterfaceIndex, enabled)?;
        }
        Ok(())
    }
    fn set_name(&self, name: &str) -> Result<()> {
        let name = native::wide(name);
        let prop = property(NAME_KEY, &name);
        // Uses the same SDK API-set import as creation on Windows 10.
        #[link(name = "Swdevice")]
        unsafe extern "system" {
            #[link_name = "SwDevicePropertySet"]
            fn properties(h: HSWDEVICE, n: u32, p: *const DEVPROPERTY) -> i32;
        }
        hr(
            unsafe { properties(self.handle, 1, &prop) },
            "Rename owned TUN property",
        )
    }
    fn remove(&mut self) -> Result<()> {
        self.set_enabled(false)?;
        let Some(dev) = device(&self.record)? else {
            return Ok(());
        };
        ownership(dev, &self.record)?;
        hr(
            unsafe { set_lifetime(self.handle, SWDeviceLifetimeHandle) },
            "Release retained TUN",
        )?;
        uninstall_device(dev, &self.record)?;
        unsafe {
            close_device(self.handle);
        }
        self.handle = ptr::null_mut();
        Ok(())
    }
}
impl Drop for SoftwareDevice {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            if let Err(e) = self.set_enabled(false) {
                crate::diagnostics::error!("Disable retained TUN: {}", e.message);
            }
            unsafe {
                close_device(self.handle);
            }
        }
    }
}
// Follow the network class installer, like Wintun's own removal path. Direct
// CM_Uninstall_DevNode bypasses class/co-installer network bookkeeping.
fn uninstall_device(dev: u32, record: &Record) -> Result<()> {
    let set = unsafe { SetupDiCreateDeviceInfoList(&NET_CLASS, ptr::null_mut()) };
    if set == INVALID_HANDLE_VALUE as isize {
        return Err(native::os_error("Open owned TUN removal set"));
    }
    let result = (|| {
        let mut info = SP_DEVINFO_DATA {
            cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
            ..Default::default()
        };
        if unsafe {
            SetupDiOpenDeviceInfoW(
                set,
                native::wide(&record.device_id()).as_ptr(),
                ptr::null_mut(),
                0,
                &mut info,
            )
        } == 0
        {
            return Err(native::os_error("Open exact owned TUN for removal"));
        }
        if info.DevInst != dev {
            return Err(error(
                "The owned TUN changed before removal; refresh and retry.",
            ));
        }
        ownership(info.DevInst, record)?;
        let parameters = SP_REMOVEDEVICE_PARAMS {
            ClassInstallHeader: SP_CLASSINSTALL_HEADER {
                cbSize: std::mem::size_of::<SP_CLASSINSTALL_HEADER>() as u32,
                InstallFunction: DIF_REMOVE,
            },
            Scope: DI_REMOVEDEVICE_GLOBAL,
            HwProfile: 0,
        };
        if unsafe {
            SetupDiSetClassInstallParamsW(
                set,
                &info,
                &parameters.ClassInstallHeader,
                std::mem::size_of::<SP_REMOVEDEVICE_PARAMS>() as u32,
            )
        } == 0
            || unsafe { SetupDiCallClassInstaller(DIF_REMOVE, set, &info) } == 0
        {
            return Err(native::os_error(
                "Remove owned TUN through Windows network installer",
            ));
        }
        Ok(())
    })();
    unsafe {
        SetupDiDestroyDeviceInfoList(set);
    }
    result
}
fn property(key: DEVPROPKEY, value: &[u16]) -> DEVPROPERTY {
    DEVPROPERTY {
        CompKey: DEVPROPCOMPKEY {
            Key: key,
            Store: DEVPROP_STORE_SYSTEM,
            LocaleName: ptr::null(),
        },
        Type: DEVPROP_TYPE_STRING,
        BufferSize: (value.len() * 2) as u32,
        Buffer: value.as_ptr().cast_mut().cast(),
    }
}
fn device(record: &Record) -> Result<Option<u32>> {
    device_with_flags(record, CM_LOCATE_DEVNODE_PHANTOM)
}
fn device_with_flags(record: &Record, flags: u32) -> Result<Option<u32>> {
    let mut dev = 0;
    let code =
        unsafe { CM_Locate_DevNodeW(&mut dev, native::wide(&record.device_id()).as_ptr(), flags) };
    match code {
        CR_SUCCESS => Ok(Some(dev)),
        CR_NO_SUCH_DEVNODE => Ok(None),
        _ => Err(error(format!("Read owned TUN device failed ({code})."))),
    }
}
fn ownership(dev: u32, record: &Record) -> Result<()> {
    let mut value = [0u16; 128];
    let mut size = std::mem::size_of_val(&value) as u32;
    let mut kind = 0;
    let code = unsafe {
        CM_Get_DevNode_PropertyW(
            dev,
            &OWNER_KEY,
            &mut kind,
            value.as_mut_ptr().cast(),
            &mut size,
            0,
        )
    };
    if code != CR_SUCCESS
        || kind != DEVPROP_TYPE_STRING
        || size as usize > std::mem::size_of_val(&value)
        || String::from_utf16_lossy(
            &value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())],
        ) != record.token
    {
        return Err(error(
            "A TUN device no longer matches Wayrill's ownership record; it was left unchanged.",
        ));
    }
    Ok(())
}
fn native_guid(record: &Record) -> Result<Option<String>> {
    let id = observed_guid(record)?;
    if id
        .as_ref()
        .is_some_and(|id| record.guid.as_ref().is_some_and(|expected| expected != id))
    {
        return Err(error(
            "The TUN device's Windows GUID changed. Remove its retained adapter in Settings, then Start to recreate it.",
        ));
    }
    Ok(id)
}
fn observed_guid(record: &Record) -> Result<Option<String>> {
    let Some(dev) = device(record)? else {
        return Ok(None);
    };
    ownership(dev, record)?;
    let mut key = ptr::null_mut();
    let code = unsafe {
        CM_Open_DevNode_Key(
            dev,
            KEY_QUERY_VALUE,
            0,
            RegDisposition_OpenExisting,
            &mut key,
            CM_REGISTRY_SOFTWARE,
        )
    };
    if code != CR_SUCCESS {
        return Err(error(format!("Read owned TUN identity failed ({code}).")));
    }
    let mut value = [0u16; 64];
    let mut size = std::mem::size_of_val(&value) as u32;
    let result = unsafe {
        RegGetValueW(
            key,
            ptr::null(),
            native::wide("NetCfgInstanceId").as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            value.as_mut_ptr().cast(),
            &mut size,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    os(result, "Read owned TUN interface GUID")?;
    let id = String::from_utf16_lossy(
        &value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())],
    )
    .trim_matches(['{', '}'])
    .to_lowercase();
    if !valid_guid(&id) {
        return Err(error(
            "The owned TUN has an invalid Windows interface GUID.",
        ));
    }
    Ok(Some(id))
}
fn interface(record: &Record) -> Result<Option<(u32, MIB_IF_ROW2)>> {
    if disabled_device(record)?.is_some() {
        return Ok(None);
    }
    let Some(dev) = device_with_flags(record, CM_LOCATE_DEVNODE_NORMAL)? else {
        return Ok(None);
    };
    let Some(id) = native_guid(record)? else {
        return Ok(None);
    };
    let luid = guid_luid(&id)?;
    let mut row = MIB_IF_ROW2 {
        InterfaceLuid: luid,
        ..Default::default()
    };
    os(unsafe { GetIfEntry2(&mut row) }, "Read owned TUN state")?;
    Ok(Some((dev, row)))
}
fn preserve_disabled(record: &Record) -> Result<()> {
    let Some(dev) = disabled_device(record)? else {
        return Ok(());
    };
    let code = unsafe { CM_Enable_DevNode(dev, 0) };
    if code != CR_SUCCESS {
        return Err(error(format!(
            "Reactivate owned TUN device failed ({code})."
        )));
    }
    let until = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some((dev, row)) = interface(record)? {
            if driver_ready(dev, record)? {
                return set_enabled(row.InterfaceIndex, false);
            }
        }
        if std::time::Instant::now() >= until {
            return Err(error(
                "The reactivated owned TUN driver did not become ready.",
            ));
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}
fn disabled_device(record: &Record) -> Result<Option<u32>> {
    let _ = native_guid(record)?; // Verify ownership property and GUID first.
    let Some(dev) = device_with_flags(record, CM_LOCATE_DEVNODE_NORMAL)? else {
        return Ok(None);
    };
    let mut status = 0;
    let mut problem = 0;
    let code = unsafe { CM_Get_DevNode_Status(&mut status, &mut problem, dev, 0) };
    if code != CR_SUCCESS {
        return Err(error(format!(
            "Read owned TUN device status failed ({code})."
        )));
    }
    Ok((status & DN_HAS_PROBLEM != 0 && problem == CM_PROB_DISABLED).then_some(dev))
}
fn driver_ready(dev: u32, record: &Record) -> Result<bool> {
    let mut status = 0;
    let mut problem = 0;
    let code = unsafe { CM_Get_DevNode_Status(&mut status, &mut problem, dev, 0) };
    if code != CR_SUCCESS {
        return Err(error(format!("Read TUN driver readiness failed ({code}).")));
    }
    if status & DN_HAS_PROBLEM != 0 || status & DN_STARTED == 0 {
        return Ok(false);
    }
    let class = GUID::from_u128(0xcac88484_7515_4c03_82e6_71a87abac361);
    let mut count = 0;
    let code = unsafe {
        CM_Get_Device_Interface_List_SizeW(
            &mut count,
            &class,
            native::wide(&record.device_id()).as_ptr(),
            CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
        )
    };
    if code != CR_SUCCESS {
        return Err(error(format!(
            "Read TUN device-interface readiness failed ({code})."
        )));
    }
    Ok(count > 1)
}
fn set_enabled(index: u32, enabled: bool) -> Result<()> {
    let row = MIB_IFROW {
        dwIndex: index,
        dwAdminStatus: if enabled { 1 } else { 2 },
        ..Default::default()
    };
    os(
        unsafe { SetIfEntry(&row) },
        "Change owned TUN administrative state",
    )?;
    let mut check = MIB_IF_ROW2 {
        InterfaceIndex: index,
        ..Default::default()
    };
    os(
        unsafe { GetIfEntry2(&mut check) },
        "Verify owned TUN administrative state",
    )?;
    if check.AdminStatus != row.dwAdminStatus as i32 {
        return Err(error("Windows did not apply the TUN adapter state."));
    }
    Ok(())
}

pub(crate) fn uninstall() -> Result<()> {
    use windows_service::{
        service::{ServiceAccess, ServiceState},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    use windows_sys::Win32::{Security::*, System::Threading::*};
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(native::os_error("Identify adapter cleanup caller"));
    }
    let token = native::Handle(token);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut size = 0;
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of_val(&elevation) as u32,
            &mut size,
        )
    } == 0
        || elevation.TokenIsElevated == 0
    {
        return Err(error(
            "Run adapter cleanup from an Administrator installer.",
        ));
    }
    let services = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| error(e.to_string()))?;
    match services.open_service("WayrillService", ServiceAccess::QUERY_STATUS) {
        Ok(service)
            if service
                .query_status()
                .map_err(|e| error(e.to_string()))?
                .current_state
                != ServiceState::Stopped =>
        {
            return Err(error(
                "Stop the Wayrill service before removing its adapters.",
            ))
        }
        Ok(_) => {}
        Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1060) => {}
        Err(e) => return Err(error(e.to_string())),
    }
    let data =
        PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()))
            .join("Wayrill");
    if data.join("tun-sharing-lease.json").exists() {
        return Err(error(
            "Internet sharing recovery must finish before removing TUN adapters.",
        ));
    }
    let store = Store::new(&data);
    if store.ids()?.is_empty()
        && [Kind::Host, Kind::Ics]
            .into_iter()
            .all(|kind| !store.path(kind).exists())
    {
        return Ok(());
    }
    let root = std::env::current_exe()
        .map_err(|e| ApiError::io("Locate adapter cleanup assets", e))?
        .parent()
        .unwrap()
        .to_owned();
    let mut worker = crate::capture::Worker::spawn_attribution(&root.join("attribution"))?;
    let mut ids = store.removal_ids(Kind::Host)?;
    ids.extend(store.removal_ids(Kind::Ics)?);
    assert_unshared(&ids, &worker.call("sharing.inspect", json!({}))?)?;
    store.remove_all()
}
pub(super) fn assert_unshared(ids: &[String], snapshot: &Value) -> Result<()> {
    let rows = snapshot["connections"].as_array().ok_or_else(|| {
        error("Windows sharing state could not be inspected; adapters were left unchanged.")
    })?;
    if rows.iter().any(|row| {
        !row["role"].is_null()
            && row["id"]
                .as_str()
                .is_some_and(|id| ids.iter().any(|ours| ours.eq_ignore_ascii_case(id)))
    }) {
        return Err(error("A retained adapter is still used by Windows Internet sharing. Restore sharing before removing it."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_mode_is_default_and_records_cannot_target_external_paths() {
        assert!(Preferences::default().reuse_adapters);
        assert!(
            serde_json::from_value::<Preferences>(json!({"reuseAdapters":true,"path":"x"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<Remove>(json!({"kind":"foreign","expectedId":"x"})).is_err()
        );
        let mut r = Record {
            version: 1,
            kind: Kind::Host,
            instance: "a6a23b9c-1a70-4e9b-9d61-e99a10142e58".into(),
            token: "a".repeat(32),
            name: "WayrillTUN".into(),
            guid: None,
            settings_hash: None,
            capture_routes: Vec::new(),
        };
        assert!(r.valid(Kind::Host));
        assert!(!r.valid(Kind::Ics));
        r.instance = "..\\foreign".into();
        assert!(!r.valid(Kind::Host));
        assert_eq!(
            guid_string(&"a".repeat(32)),
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        );
    }
    #[test]
    fn adapter_alias_does_not_invalidate_saved_network_geometry() {
        let old = json!({"name":"Owned", "gateway":["10.90.0.1/24"],"mtu":1500});
        let mut renamed = old.clone();
        renamed["name"] = json!("Renamed");
        assert_eq!(settings_hash(&old), settings_hash(&renamed));
        renamed["mtu"] = json!(1400);
        assert_ne!(settings_hash(&old), settings_hash(&renamed));
    }
    #[test]
    fn names_and_expected_identity_are_bounded() {
        assert!(valid_name("Wayrill 🌍"));
        for name in ["", " ", "bad\0name", "x/y", "bad\nname"] {
            assert!(!valid_name(name));
        }
        assert!(!valid_name(&"🌍".repeat(51)));
        assert!(!valid_guid(&"a".repeat(36)));
        assert!(valid_guid("a6a23b9c-1a70-4e9b-9d61-e99a10142e58"));
    }
    #[test]
    fn shared_adapters_are_not_deletable_until_handed_back() {
        let id = "a6a23b9c-1a70-4e9b-9d61-e99a10142e58".to_string();
        assert!(assert_unshared(
            std::slice::from_ref(&id),
            &json!({"connections":[{"id":id,"role":0}]})
        )
        .is_err());
        assert!(assert_unshared(
            std::slice::from_ref(&id),
            &json!({"connections":[{"id":id.to_uppercase(),"role":1}]})
        )
        .is_err());
        assert!(assert_unshared(
            std::slice::from_ref(&id),
            &json!({"connections":[{"id":id,"role":null}]})
        )
        .is_ok());
        assert!(assert_unshared(&[id], &json!({})).is_err());
    }
}
