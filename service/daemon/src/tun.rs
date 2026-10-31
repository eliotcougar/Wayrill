//! Windows TUN adapters are exclusively created by this service. Reuse and removal
//! require protected ownership records, never names alone. No shared driver deletion.
//! A constrained same-commit private-core worker routes packets to authenticated loopback
//! relays; remote protocols/accounts remain in the restricted main core.
pub(crate) mod adapters;
mod names;
use names::{ensure_name_available, rename_adapter};
mod bootstrap;
mod clients;
mod configuration;
mod egress;
mod forwarding;
pub(crate) mod keeper;
pub(crate) mod live;
pub(crate) mod network;
mod notifications;
pub(crate) mod sharing;
mod sharing_guard;
mod update;
mod uplink_guard;
use crate::{
    events::Events,
    native::{self, CoreProcess, Handle},
    resources,
};
use bootstrap::bootstrap;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::c_void,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener},
    path::{Path, PathBuf},
    ptr,
    sync::Arc,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::*,
        NetworkManagement::{IpHelper::*, Ndis::NET_LUID_LH},
        Networking::WinSock::*,
        Security::{Cryptography::*, *},
        System::{LibraryLoader::*, Threading::*},
    },
};

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new("TUN_CONFIG", message)
}
// Both host and ICS capture use the audited private worker: the official
// TUN stack fabricates ICMP responses even for unreachable destinations.
pub(crate) fn worker_executable(service: &Path) -> Result<PathBuf> {
    let worker = service.join("tun-core").join("wayrill-tun.exe");
    let manifest: Value = serde_json::from_str(include_str!("tun-core-manifest.json"))
        .map_err(|_| invalid("Invalid TUN core manifest."))?;
    native::verify_hash(
        &worker,
        manifest["sha256"]
            .as_str()
            .ok_or_else(|| invalid("TUN core has not been built."))?,
    )?;
    native::verify_hash(
        &worker.parent().unwrap().join("wintun.dll"),
        "e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce",
    )?;
    Ok(worker)
}
pub(crate) fn random_id() -> Result<String> {
    Ok(random_bytes()?.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn random_tag_id() -> Result<String> {
    Ok(crate::tags::encode(&random_bytes()?))
}
fn random_bytes() -> Result<[u8; 16]> {
    let mut bytes = [0u8; 16];
    if unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            bytes.as_mut_ptr(),
            16,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } != 0
    {
        return Err(native::os_error("Generate TUN identity"));
    }
    Ok(bytes)
}
type CreateAdapter = unsafe extern "system" fn(*const u16, *const u16, *const GUID) -> *mut c_void;
type CloseAdapter = unsafe extern "system" fn(*mut c_void);
type GetLuid = unsafe extern "system" fn(*mut c_void, *mut NET_LUID_LH);
struct Library(HMODULE);
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.0);
        }
    }
}
struct Adapter {
    _library: Library,
    handle: *mut c_void,
    close: CloseAdapter,
    pub name: String,
    pub index: u32,
    pub guid: String,
    persistent: Option<adapters::Lease>,
}
// Adapter/library handles remain uniquely owned and may be closed on any
// service thread; Manager serializes all access. No raw pointer is shared.
unsafe impl Send for Adapter {}
impl Adapter {
    fn library(exe: &Path) -> Result<Library> {
        let dll = exe.with_file_name("wintun.dll");
        let dependencies: Value = serde_json::from_str(include_str!("../../dependencies.json"))
            .map_err(|e| ApiError::io("Read compiled TUN pin", e))?;
        native::verify_hash(
            &dll,
            dependencies["xray"]["wintunDllSha256"]
                .as_str()
                .ok_or_else(|| invalid("The compiled Wintun pin is missing."))?,
        )?;
        let library = unsafe {
            LoadLibraryExW(
                native::wide(&dll.to_string_lossy()).as_ptr(),
                ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if library.is_null() {
            return Err(native::os_error("Load packaged Wintun"));
        }
        let library = Library(library);
        // Wintun 0.14.1 queues orphan cleanup from Open/CloseAdapter without
        // retaining its module. Its callbacks can outlive every scoped handle.
        // Pin this verified image until process exit; balance both loader refs
        // normally rather than guessing when native background work has ended.
        let mut resident = ptr::null_mut();
        // SAFETY: library owns a live loader reference. FROM_ADDRESS treats its
        // module base as an address, not a string; resident is a valid out pointer.
        if unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                library.0.cast(),
                &mut resident,
            )
        } == 0
        {
            return Err(native::os_error("Retain packaged Wintun callbacks"));
        }
        drop(Library(resident));
        Ok(library)
    }
    fn from_handle(library: Library, handle: *mut c_void, name: &str) -> Result<Self> {
        unsafe {
            let close: CloseAdapter = std::mem::transmute(
                GetProcAddress(library.0, c"WintunCloseAdapter".as_ptr().cast())
                    .ok_or_else(|| invalid("WintunCloseAdapter is missing."))?,
            );
            let get: GetLuid = std::mem::transmute(
                GetProcAddress(library.0, c"WintunGetAdapterLUID".as_ptr().cast())
                    .ok_or_else(|| invalid("WintunGetAdapterLUID is missing."))?,
            );
            let mut adapter = Self {
                _library: library,
                handle,
                close,
                name: name.into(),
                index: 0,
                guid: String::new(),
                persistent: None,
            };
            let mut luid = NET_LUID_LH::default();
            get(handle, &mut luid);
            let code = ConvertInterfaceLuidToIndex(&luid, &mut adapter.index);
            if code != 0 {
                return Err(ApiError::io(
                    "Read owned TUN index",
                    std::io::Error::from_raw_os_error(code as i32),
                ));
            }
            let mut guid = GUID::default();
            let code = ConvertInterfaceLuidToGuid(&luid, &mut guid);
            if code != 0 {
                return Err(ApiError::io(
                    "Read owned TUN GUID",
                    std::io::Error::from_raw_os_error(code as i32),
                ));
            }
            adapter.guid = format!(
                "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{}",
                guid.data1,
                guid.data2,
                guid.data3,
                guid.data4[0],
                guid.data4[1],
                guid.data4[2..]
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
            Ok(adapter)
        }
    }
    fn create(exe: &Path, name: &str) -> Result<Self> {
        if !adapters::valid_name(name) {
            return Err(invalid("Enter a valid TUN adapter name."));
        }
        ensure_name_available(name, None)?;
        let library = Self::library(exe)?;
        let id = random_id()?;
        let guid = GUID {
            data1: u32::from_str_radix(&id[..8], 16).unwrap(),
            data2: u16::from_str_radix(&id[8..12], 16).unwrap(),
            data3: u16::from_str_radix(&id[12..16], 16).unwrap(),
            data4: std::array::from_fn(|i| {
                u8::from_str_radix(&id[16 + i * 2..18 + i * 2], 16).unwrap()
            }),
        };
        let create: CreateAdapter = unsafe {
            std::mem::transmute(
                GetProcAddress(library.0, c"WintunCreateAdapter".as_ptr().cast())
                    .ok_or_else(|| invalid("WintunCreateAdapter is missing."))?,
            )
        };
        let handle = unsafe {
            create(
                native::wide(name).as_ptr(),
                native::wide("Wayrill").as_ptr(),
                &guid,
            )
        };
        if handle.is_null() {
            return Err(native::os_error("Create owned TUN adapter"));
        }
        Self::from_handle(library, handle, name)
    }
    fn ensure_driver(exe: &Path) -> Result<()> {
        let library = Self::library(exe)?;
        let version: unsafe extern "system" fn() -> u32 = unsafe {
            std::mem::transmute(
                GetProcAddress(library.0, c"WintunGetRunningDriverVersion".as_ptr().cast())
                    .ok_or_else(|| invalid("Wintun driver version API is missing."))?,
            )
        };
        if unsafe { version() } == 0 {
            // A temporary first-install device lets the official signed API
            // install its driver package. It never adopts a foreign adapter.
            let name = format!("Wayrill setup {}", &random_id()?[..12]);
            drop(Self::create(exe, &name)?);
        }
        Ok(())
    }
    fn open_owned(exe: &Path, name: &str, expected: &str) -> Result<Self> {
        let library = Self::library(exe)?;
        let open: unsafe extern "system" fn(*const u16) -> *mut c_void = unsafe {
            std::mem::transmute(
                GetProcAddress(library.0, c"WintunOpenAdapter".as_ptr().cast())
                    .ok_or_else(|| invalid("WintunOpenAdapter is missing."))?,
            )
        };
        let handle = unsafe { open(native::wide(name).as_ptr()) };
        if handle.is_null() {
            return Err(native::os_error("Open verified owned TUN"));
        }
        let adapter = Self::from_handle(library, handle, name)?;
        if adapter.guid != expected {
            return Err(invalid(
                "The opened TUN does not match the verified owned interface.",
            ));
        }
        Ok(adapter)
    }
    fn park(&self) -> Result<()> {
        if let Some(lease) = &self.persistent {
            return lease.park();
        }
        let mut row = MIB_IF_ROW2 {
            InterfaceLuid: guid_luid(&self.guid)?,
            ..Default::default()
        };
        let code = unsafe { GetIfEntry2(&mut row) };
        if code != 0 {
            return Err(ApiError::io(
                "Verify disposable TUN before parking",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        if row.InterfaceIndex != self.index {
            return Err(invalid("The owned TUN interface changed before parking."));
        }
        configuration::active(row.InterfaceIndex, false)
    }
    fn disable(&mut self) -> Result<()> {
        if let Some(lease) = &mut self.persistent {
            lease.stop()?;
        }
        Ok(())
    }
    fn prepare_configuration(&mut self, settings: &Value, warm: bool) -> Result<bool> {
        // Inspect the live interface before staging it down. Holding its lease
        // does not prove that addresses, DNS or MTU stayed unchanged outside us.
        let reuse = (warm
            || (self
                .persistent
                .as_ref()
                .is_some_and(|lease| lease.matches(settings))
                && reusable_settings(settings, settings)))
            && {
                let mut geometry = settings.clone();
                geometry["autoSystemRoutingTable"] = json!([]);
                configuration::ready(self.index, &geometry)?
            };
        crate::diagnostics::log(
            "tun.adapter",
            "info",
            &format!(
                "Preparing {} (interface {}, retained {}, warm {}, reuse native settings {}).",
                self.name,
                self.index,
                self.persistent.is_some(),
                warm,
                reuse
            ),
        );
        configuration::active(self.index, false)?;
        configuration::retire_unused(self.index, settings)?;
        configuration::reset_forwarding(self.index)?;
        if let Some(lease) = &mut self.persistent {
            lease.remember(None)?;
        }
        Ok(reuse)
    }
    fn track_routes(&mut self, routes: Vec<configuration::CaptureRoute>) -> Result<()> {
        if let Some(lease) = &mut self.persistent {
            lease.track_routes(routes)?;
        }
        Ok(())
    }
    fn remember_configuration(&mut self, settings: &Value) -> Result<()> {
        if let Some(lease) = &mut self.persistent {
            lease.remember(Some(settings))?;
        }
        Ok(())
    }
    fn activate(&self) -> Result<()> {
        configuration::active(self.index, true)
    }
    fn check_name(&self, name: &str) -> Result<()> {
        if !adapters::valid_name(name) {
            return Err(invalid("Enter a valid adapter name."));
        }
        if name != self.name && self.persistent.is_none() {
            return Err(invalid(
                "Stop routing before renaming a disposable TUN adapter.",
            ));
        }
        if !self.identity_ready()? {
            return Err(invalid("The owned adapter identity changed."));
        }
        ensure_name_available(name, Some(&self.guid))
    }
    fn rename(&mut self, name: &str) -> Result<()> {
        self.check_name(name)?;
        if name == self.name {
            return Ok(());
        }
        self.persistent
            .as_mut()
            .ok_or_else(|| invalid("The retained adapter lease is missing."))?
            .rename(name)?;
        self.name = name.into();
        Ok(())
    }
    fn preserve_disabled(&self) -> Result<()> {
        self.persistent
            .as_ref()
            .map_or(Ok(()), |lease| lease.preserve_disabled())
    }
    fn administratively_disabled(&self) -> Result<bool> {
        if self
            .persistent
            .as_ref()
            .map(|lease| lease.disabled())
            .transpose()?
            .unwrap_or(false)
        {
            return Ok(true);
        }
        let mut row = MIB_IF_ROW2 {
            InterfaceLuid: guid_luid(&self.guid)?,
            ..Default::default()
        };
        let code = unsafe { GetIfEntry2(&mut row) };
        if [ERROR_NOT_FOUND, ERROR_FILE_NOT_FOUND].contains(&code) {
            return Ok(false);
        }
        if code != 0 {
            return Err(ApiError::io(
                "Inspect owned TUN administrative state",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        Ok(row.InterfaceIndex == self.index && row.AdminStatus == 2)
    }
    fn identity_ready(&self) -> Result<bool> {
        let luid = guid_luid(&self.guid)?;
        let mut row = MIB_IF_ROW2 {
            InterfaceLuid: luid,
            ..Default::default()
        };
        let code = unsafe { GetIfEntry2(&mut row) };
        if code != 0 {
            return Err(ApiError::io(
                "Verify owned TUN identity",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        Ok(row.InterfaceIndex == self.index && row.AdminStatus == 1 && alias(&luid)? == self.name)
    }
}
impl Drop for Adapter {
    fn drop(&mut self) {
        unsafe {
            (self.close)(self.handle);
        }
        // Close the API handle before disabling/removing the device. An opened
        // Wintun handle never owns device deletion; the SWD lease does.
        self.persistent = None;
    }
}
fn alias(luid: &NET_LUID_LH) -> Result<String> {
    let mut buf = [0u16; 257];
    let code = unsafe { ConvertInterfaceLuidToAlias(luid, buf.as_mut_ptr(), buf.len()) };
    if code != 0 {
        return Err(ApiError::io(
            "Find TUN uplink",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    Ok(String::from_utf16_lossy(
        &buf[..buf.iter().position(|c| *c == 0).unwrap_or(buf.len())],
    ))
}
fn socket_address(ip: IpAddr) -> SOCKADDR_INET {
    let mut address = SOCKADDR_INET::default();
    match ip {
        IpAddr::V4(ip) => {
            address.Ipv4 = SOCKADDR_IN {
                sin_family: AF_INET,
                sin_addr: IN_ADDR {
                    S_un: IN_ADDR_0 {
                        S_addr: u32::from_ne_bytes(ip.octets()),
                    },
                },
                ..Default::default()
            }
        }
        IpAddr::V6(ip) => {
            address.Ipv6 = SOCKADDR_IN6 {
                sin6_family: AF_INET6,
                sin6_addr: IN6_ADDR {
                    u: IN6_ADDR_0 { Byte: ip.octets() },
                },
                ..Default::default()
            }
        }
    }
    address
}
pub(crate) fn loopback_interface() -> Result<String> {
    // An explicit VPN/TUN route must not redefine what "local" means.
    let mut table = ptr::null_mut();
    let code = unsafe { GetIfTable2(&mut table) };
    if code != 0 {
        return Err(ApiError::io(
            "Find loopback interface",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    // SAFETY: the successful query transferred this allocation to us.
    let table = unsafe { native::MibTable::from_raw(table) }.ok_or_else(|| {
        ApiError::new(
            "LOOPBACK_INTERFACE",
            "Windows did not return an interface table.",
        )
    })?;
    let pointer = table.as_ptr();
    // SAFETY: the live allocation contains NumEntries rows. Do not form a
    // reference to the nominal one-row field before accessing the whole tail.
    let rows = unsafe {
        std::slice::from_raw_parts(
            ptr::addr_of!((*pointer).Table).cast::<MIB_IF_ROW2>(),
            (*pointer).NumEntries as usize,
        )
    };
    rows.iter()
        .find(|row| row.Type == IF_TYPE_SOFTWARE_LOOPBACK)
        .map(|row| alias(&row.InterfaceLuid))
        .unwrap_or_else(|| {
            Err(ApiError::new(
                "LOOPBACK_INTERFACE",
                "Windows loopback interface is unavailable.",
            ))
        })
}
fn route_interface(ip: IpAddr) -> Result<NET_LUID_LH> {
    let destination = socket_address(ip);
    let mut route = MIB_IPFORWARD_ROW2::default();
    let mut source = SOCKADDR_INET::default();
    let code = unsafe {
        GetBestRoute2(
            ptr::null(),
            0,
            ptr::null(),
            &destination,
            0,
            &mut route,
            &mut source,
        )
    };
    if code != 0 {
        return Err(ApiError::io(
            "Find TUN route",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    Ok(route.InterfaceLuid)
}
fn unavailable_uplink(message: impl Into<String>) -> ApiError {
    let mut error = ApiError::new("TUN_UPLINK_UNAVAILABLE", message);
    error.retryable = true;
    error
}
fn usable_uplink(luid: NET_LUID_LH) -> Result<String> {
    let mut row = MIB_IF_ROW2 {
        InterfaceLuid: luid,
        ..Default::default()
    };
    let code = unsafe { GetIfEntry2(&mut row) };
    if code == ERROR_NOT_FOUND || code == ERROR_FILE_NOT_FOUND {
        return Err(unavailable_uplink("The selected uplink disappeared."));
    }
    if code != 0 {
        return Err(ApiError::io(
            "Read TUN uplink",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    let description = String::from_utf16_lossy(
        &row.Description[..row
            .Description
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(row.Description.len())],
    );
    if description == "Wayrill retained TUN" || description == "Wayrill retained ICS TUN" {
        return Err(invalid(
            "An owned TUN capture interface cannot be its own uplink.",
        ));
    }
    if row.Type == 24 {
        return Err(invalid("Select a non-loopback TUN uplink."));
    }
    if row.OperStatus != 1 {
        return Err(unavailable_uplink(
            "The selected TUN uplink is not active yet.",
        ));
    }
    alias(&luid)
}
fn default_route_key(row: &MIB_IPFORWARD_ROW2, interface_metric: u32) -> Option<(u64, u32)> {
    (row.DestinationPrefix.PrefixLength == 0).then_some((
        u64::from(row.Metric) + u64::from(interface_metric),
        row.InterfaceIndex,
    ))
}
fn default_uplink(family: u16, excluded: Option<u32>) -> Result<Option<String>> {
    let mut rows = ptr::null_mut();
    let code = unsafe { GetIpForwardTable2(family, &mut rows) };
    if code != 0 {
        return Err(ApiError::io(
            "Read TUN default uplink",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    let mut candidates = Vec::new();
    // SAFETY: the successful query transferred this allocation to us.
    let rows = unsafe { native::MibTable::from_raw(rows) }
        .ok_or_else(|| invalid("Windows returned no default-route table."))?;
    let pointer = rows.as_ptr();
    // SAFETY: the owned snapshot contains NumEntries rows; interface lookups
    // only borrow copied LUIDs and do not alter that snapshot.
    unsafe {
        for row in std::slice::from_raw_parts(
            ptr::addr_of!((*pointer).Table).cast::<MIB_IPFORWARD_ROW2>(),
            (*pointer).NumEntries as usize,
        ) {
            if row.DestinationPrefix.PrefixLength != 0 || Some(row.InterfaceIndex) == excluded {
                continue;
            }
            let mut interface = MIB_IPINTERFACE_ROW {
                Family: family,
                InterfaceLuid: row.InterfaceLuid,
                ..Default::default()
            };
            if GetIpInterfaceEntry(&mut interface) == 0 {
                candidates.push((
                    default_route_key(row, interface.Metric).unwrap(),
                    row.InterfaceLuid,
                ));
            }
        }
    }
    candidates.sort_by_key(|(key, _)| *key);
    Ok(candidates
        .into_iter()
        .filter(|(_, luid)| automatic_interface(*luid))
        .find_map(|(_, luid)| usable_uplink(luid).ok()))
}
fn automatic_interface(luid: NET_LUID_LH) -> bool {
    let mut row = MIB_IF_ROW2 {
        InterfaceLuid: luid,
        ..Default::default()
    };
    unsafe {
        GetIfEntry2(&mut row) == 0
            && row.InterfaceAndOperStatusFlags._bitfield & 1 != 0
            && row.TunnelType == 0
            && row.Type != 24
    }
}
fn uplink(settings: &Value) -> Result<String> {
    uplink_except(settings, None)
}
fn uplink_except(settings: &Value, excluded: Option<u32>) -> Result<String> {
    let fixed = settings["autoOutboundsInterface"]
        .as_str()
        .unwrap_or("auto");
    if !fixed.is_empty() && fixed != "auto" {
        let mut luid = NET_LUID_LH::default();
        if unsafe { ConvertInterfaceAliasToLuid(native::wide(fixed).as_ptr(), &mut luid) } != 0 {
            return Err(unavailable_uplink(format!(
                "The selected uplink '{fixed}' is unavailable."
            )));
        }
        return usable_uplink(luid);
    }
    // Select the underlying default, not a VPN's more-specific capture routes:
    // sending Xray's outer transport into a VPN carried by Xray would recurse.
    // Explicit interface selection remains authoritative.
    for family in [AF_INET, AF_INET6] {
        if let Ok(Some(name)) = default_uplink(family, excluded) {
            return Ok(name);
        }
    }
    // Networks without a default can still have a usable explicit route.
    for ip in [
        IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)),
        IpAddr::V6("2606:4700:4700::1111".parse::<Ipv6Addr>().unwrap()),
    ] {
        if let Ok(luid) = route_interface(ip) {
            let mut index = 0;
            if unsafe { ConvertInterfaceLuidToIndex(&luid, &mut index) } != 0
                || Some(index) == excluded
            {
                continue;
            }
            if !automatic_interface(luid) {
                continue;
            }
            if let Ok(name) = usable_uplink(luid) {
                return Ok(name);
            }
        }
    }
    Err(unavailable_uplink(
        "No active uplink is available. Select an outbound interface in the TUN editor.",
    ))
}

// Only TUN traffic and this worker's resolver requests need a relay. Socket-
// only branches stay in the main core, avoiding duplicate geo lists/relays.
fn guid_uplink(id: &str) -> Result<String> {
    usable_uplink(guid_luid(id)?)
}
fn guid_luid(id: &str) -> Result<NET_LUID_LH> {
    if !sharing::valid_guid(id) {
        return Err(invalid("Invalid ICS adapter identity."));
    }
    let text = id.replace('-', "");
    let mut data4 = [0u8; 8];
    for (i, byte) in data4.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[16 + i * 2..18 + i * 2], 16)
            .map_err(|_| invalid("Invalid ICS adapter identity."))?;
    }
    let guid = GUID {
        data1: u32::from_str_radix(&text[..8], 16).unwrap(),
        data2: u16::from_str_radix(&text[8..12], 16).unwrap(),
        data3: u16::from_str_radix(&text[12..16], 16).unwrap(),
        data4,
    };
    let mut luid = NET_LUID_LH::default();
    if unsafe { ConvertInterfaceGuidToLuid(&guid, &mut luid) } != 0 {
        return Err(unavailable_uplink(
            "The original ICS upstream adapter is unavailable.",
        ));
    }
    Ok(luid)
}

#[cfg(test)]
fn worker_rules(config: &Value, tun_tag: &str) -> Vec<Value> {
    worker_rules_for_dns(config, tun_tag, &config["dns"])
}
fn worker_rules_for_dns(config: &Value, tun_tag: &str, dns: &Value) -> Vec<Value> {
    worker_rules_with_nat(config, tun_tag, dns, None)
}
fn worker_rules_with_nat(
    config: &Value,
    tun_tag: &str,
    dns: &Value,
    nat_tag: Option<&str>,
) -> Vec<Value> {
    let mut tags = BTreeSet::from([tun_tag]);
    if let Some(tag) = nat_tag {
        tags.insert(tag);
    }
    if let Some(tag) = dns["tag"].as_str() {
        tags.insert(tag);
    }
    for server in dns["servers"].as_array().into_iter().flatten() {
        if let Some(tag) = server["tag"].as_str() {
            tags.insert(tag);
        }
    }
    config["routing"]["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|rule| {
            rule["inboundTag"].as_array().is_none_or(|scopes| {
                scopes.is_empty()
                    || scopes
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|scope| tags.contains(scope))
            })
        })
        .cloned()
        .collect()
}

type Prefix = (IpAddr, u8);
fn address_prefix(value: &str) -> Result<Prefix> {
    let (ip, bits) = value.split_once('/').ok_or_else(|| {
        invalid(format!(
            "Invalid TUN prefix '{value}'. Use IP/prefix length."
        ))
    })?;
    let ip = ip
        .parse::<IpAddr>()
        .map_err(|_| invalid(format!("Invalid TUN prefix '{value}'.")))?;
    let bits = bits
        .parse::<u8>()
        .map_err(|_| invalid(format!("Invalid TUN prefix length '{value}'.")))?;
    if bits > if ip.is_ipv4() { 32 } else { 128 } {
        return Err(invalid(format!("Invalid TUN prefix length '{value}'.")));
    }
    Ok((ip, bits))
}
fn prefix(value: &str) -> Result<Prefix> {
    let (ip, bits) = address_prefix(value)?;
    match ip {
        IpAddr::V4(ip) if bits <= 32 => Ok((
            IpAddr::V4(Ipv4Addr::from(
                u32::from(ip) & u32::MAX.checked_shl(32 - u32::from(bits)).unwrap_or(0),
            )),
            bits,
        )),
        IpAddr::V6(ip) if bits <= 128 => Ok((
            IpAddr::V6(Ipv6Addr::from(
                u128::from(ip) & u128::MAX.checked_shl(128 - u32::from(bits)).unwrap_or(0),
            )),
            bits,
        )),
        _ => Err(invalid(format!("Invalid TUN prefix length '{value}'."))),
    }
}
fn prefixes(settings: &Value, key: &str) -> Result<BTreeSet<Prefix>> {
    let Some(values) = settings.get(key) else {
        return Ok(BTreeSet::new());
    };
    let array = values
        .as_array()
        .ok_or_else(|| invalid(format!("TUN {key} must be a list of IP prefixes.")))?;
    array
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| invalid(format!("TUN {key} must contain IP prefixes.")))
                .and_then(prefix)
        })
        .collect()
}
fn routes_ready(index: u32, expected: &BTreeSet<Prefix>) -> Result<bool> {
    if expected.is_empty() {
        return Ok(true);
    }
    let mut rows = ptr::null_mut();
    let code = unsafe { GetIpForwardTable2(AF_UNSPEC, &mut rows) };
    if code != 0 {
        return Err(ApiError::io(
            "Read TUN routes",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    let mut present = BTreeSet::new();
    // SAFETY: the successful query transferred this allocation to us.
    let rows = unsafe { native::MibTable::from_raw(rows) }
        .ok_or_else(|| invalid("Windows returned no route table."))?;
    let pointer = rows.as_ptr();
    // SAFETY: the owned snapshot contains NumEntries rows and their initialized
    // SOCKADDR_INET unions are read only after checking the address family.
    unsafe {
        for row in std::slice::from_raw_parts(
            ptr::addr_of!((*pointer).Table).cast::<MIB_IPFORWARD_ROW2>(),
            (*pointer).NumEntries as usize,
        )
        .iter()
        .filter(|row| row.InterfaceIndex == index)
        {
            let address = &row.DestinationPrefix.Prefix;
            let ip = match address.si_family {
                AF_INET => IpAddr::V4(Ipv4Addr::from(
                    address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes(),
                )),
                AF_INET6 => IpAddr::V6(Ipv6Addr::from(address.Ipv6.sin6_addr.u.Byte)),
                _ => continue,
            };
            present.insert((ip, row.DestinationPrefix.PrefixLength));
        }
    }
    Ok(expected.is_subset(&present))
}

fn scoped_token() -> Result<Handle> {
    let mut token = ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID,
            &mut token,
        )
    } == 0
    {
        return Err(native::os_error("Obtain scoped TUN worker token"));
    }
    native::restrict_token(Handle(token))
}
fn wait_started(core: &CoreProcess) -> Result<()> {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(code) = core.exit_code()? {
            return Err(invalid(format!("Shared TUN worker exited ({code}).")));
        }
        if core.started() {
            return Ok(());
        }
        if Instant::now() >= until {
            return Err(invalid("Shared TUN worker did not become ready."));
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}
// Split capture routes must yield to a VPN's equally specific routes. A real
// next hop also lets Windows VPN clients expand net_gateway through this TUN,
// rather than publishing an unusable 0.0.0.0 gateway.
const CAPTURE_ROUTE_METRIC: u32 = 10_000;
fn capture_route_metric(bits: u8) -> u32 {
    // A full /0 must still beat the physical /0. Prefer split capture routes
    // for VPN coexistence; those win by specificity and can yield by metric.
    if bits == 0 {
        0
    } else {
        CAPTURE_ROUTE_METRIC
    }
}
fn ipv4_peer(settings: &Value) -> Result<Option<Ipv4Addr>> {
    prefixes(settings, "gateway")?; // Validate, but retain the assigned host bits.
    for gateway in settings["gateway"].as_array().into_iter().flatten() {
        let cidr = gateway
            .as_str()
            .ok_or_else(|| invalid("Invalid TUN gateway."))?;
        let (ip, bits) = address_prefix(cidr)?;
        let IpAddr::V4(ip) = ip else { continue };
        if bits > 31 {
            continue;
        }
        let raw = u32::from(ip);
        let mask = if bits == 0 {
            0
        } else {
            u32::MAX << (32 - bits)
        };
        let network = raw & mask;
        let broadcast = network | !mask;
        let mut peer = raw ^ 1;
        if bits < 31 && (peer == network || peer == broadcast) {
            peer = raw ^ 3;
        }
        let peer = Ipv4Addr::from(peer);
        if !peer.is_unspecified() && !peer.is_multicast() && !peer.is_broadcast() {
            return Ok(Some(peer));
        }
    }
    Ok(None)
}
fn configure_capture_routes(index: u32, routes: &BTreeSet<Prefix>, settings: &Value) -> Result<()> {
    let peer = ipv4_peer(settings)?;
    for &(ip, bits) in routes {
        let mut row = MIB_IPFORWARD_ROW2::default();
        unsafe {
            InitializeIpForwardEntry(&mut row);
        }
        row.InterfaceIndex = index;
        row.Protocol = MIB_IPPROTO_NETMGMT;
        row.DestinationPrefix = IP_ADDRESS_PREFIX {
            Prefix: socket_address(ip),
            PrefixLength: bits,
        };
        row.NextHop = socket_address(if ip.is_ipv4() {
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        } else {
            IpAddr::V6(Ipv6Addr::UNSPECIFIED)
        });
        let mut old = row;
        let found = unsafe { GetIpForwardEntry2(&mut old) };
        if found != 0 && found != ERROR_NOT_FOUND {
            return Err(ApiError::io(
                "Read owned TUN route",
                std::io::Error::from_raw_os_error(found as i32),
            ));
        }
        row.Metric = capture_route_metric(bits);
        if let Some(peer) = peer.filter(|_| ip.is_ipv4()) {
            row.NextHop = socket_address(IpAddr::V4(peer));
            ensure_owned_route(&row, "Add owned TUN peer route")?;
            // Create first: no momentary physical bypass. Both rows are on our
            // newly created adapter; never change a foreign VPN or its routes.
            if found == 0 {
                let code = unsafe { DeleteIpForwardEntry2(&old) };
                if code != 0 {
                    return Err(ApiError::io(
                        "Replace owned on-link TUN route",
                        std::io::Error::from_raw_os_error(code as i32),
                    ));
                }
            }
        } else {
            let code = if found == 0 {
                old.Metric = capture_route_metric(bits);
                unsafe { SetIpForwardEntry2(&old) }
            } else {
                unsafe { CreateIpForwardEntry2(&row) }
            };
            if code != 0 {
                return Err(ApiError::io(
                    "Set owned TUN route priority",
                    std::io::Error::from_raw_os_error(code as i32),
                ));
            }
        }
    }
    Ok(())
}
// This is called only for our verified adapter. Reconcile the exact route key
// (interface, destination and next hop), never an interface-wide route table.
fn ensure_owned_route(row: &MIB_IPFORWARD_ROW2, action: &str) -> Result<()> {
    let mut current = *row;
    let found = unsafe { GetIpForwardEntry2(&mut current) };
    let code = if found == 0 {
        if current.Metric == row.Metric {
            return Ok(());
        }
        current.Metric = row.Metric;
        unsafe { SetIpForwardEntry2(&current) }
    } else if found == ERROR_NOT_FOUND {
        let created = unsafe { CreateIpForwardEntry2(row) };
        if created == ERROR_OBJECT_ALREADY_EXISTS {
            // Windows can finish publishing a route between lookup and create.
            // Read back that same key before treating the operation as success.
            return ensure_existing_owned_route(row, action);
        }
        created
    } else {
        found
    };
    if code != 0 {
        return Err(ApiError::io(
            action,
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    ensure_existing_owned_route(row, action)
}
fn ensure_existing_owned_route(row: &MIB_IPFORWARD_ROW2, action: &str) -> Result<()> {
    let mut current = *row;
    let mut code = unsafe { GetIpForwardEntry2(&mut current) };
    if code == 0 && current.Metric != row.Metric {
        current.Metric = row.Metric;
        code = unsafe { SetIpForwardEntry2(&current) };
        if code == 0 {
            code = unsafe { GetIpForwardEntry2(&mut current) };
        }
    }
    if code != 0 {
        return Err(ApiError::io(
            action,
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    if current.Metric != row.Metric {
        return Err(invalid(
            "Windows did not retain the owned TUN route priority.",
        ));
    }
    Ok(())
}
fn add_routes(index: u32, routes: &BTreeSet<Prefix>, metric: u32) -> Result<()> {
    for &(ip, bits) in routes {
        let mut row = MIB_IPFORWARD_ROW2::default();
        unsafe {
            InitializeIpForwardEntry(&mut row);
        }
        row.InterfaceIndex = index;
        row.Protocol = MIB_IPPROTO_NETMGMT;
        row.DestinationPrefix = IP_ADDRESS_PREFIX {
            Prefix: socket_address(ip),
            PrefixLength: bits,
        };
        row.NextHop = socket_address(if ip.is_ipv4() {
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        } else {
            IpAddr::V6(Ipv6Addr::UNSPECIFIED)
        });
        row.Metric = metric;
        ensure_owned_route(&row, "Add owned TUN route")?;
    }
    Ok(())
}
fn shared_gateway() -> Result<Ipv4Addr> {
    let mut rows = ptr::null_mut();
    let code = unsafe { GetIpForwardTable2(AF_INET, &mut rows) };
    if code != 0 {
        return Err(ApiError::io(
            "Inspect shared transit address",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    // SAFETY: the successful query transferred this allocation to us.
    let rows = unsafe { native::MibTable::from_raw(rows) }
        .ok_or_else(|| invalid("Windows returned no shared-transit route table."))?;
    let pointer = rows.as_ptr();
    // SAFETY: the owned IPv4 snapshot contains NumEntries initialized rows.
    let used: Vec<_> = unsafe {
        std::slice::from_raw_parts(
            ptr::addr_of!((*pointer).Table).cast::<MIB_IPFORWARD_ROW2>(),
            (*pointer).NumEntries as usize,
        )
        .iter()
        .filter(|r| r.DestinationPrefix.PrefixLength > 1)
        .map(|r| {
            (
                u32::from(Ipv4Addr::from(
                    r.DestinationPrefix
                        .Prefix
                        .Ipv4
                        .sin_addr
                        .S_un
                        .S_addr
                        .to_ne_bytes(),
                )),
                r.DestinationPrefix.PrefixLength,
            )
        })
        .collect()
    };
    for _ in 0..64 {
        let ip = u32::from(Ipv4Addr::new(198, 18, 0, 0))
            + (u32::from_str_radix(&random_id()?[..6], 16).unwrap() & 0x1ffff);
        if used.iter().all(|&(network, bits)| {
            ip & u32::MAX.checked_shl(32 - u32::from(bits)).unwrap_or(0) != network
        }) {
            return Ok(Ipv4Addr::from(ip));
        }
    }
    Err(invalid(
        "No unused internal IPv4 address is available for ICS.",
    ))
}

/// Shared validation is non-mutating. Prevent privileged worker file access and
/// options that cannot retain native semantics across the local relay boundary.
pub(super) fn adapter_name(settings: &Value, shared: bool) -> Result<&str> {
    let name = match settings.get("name") {
        None | Some(Value::String(_)) if settings["name"].as_str().is_none_or(str::is_empty) => {
            if shared {
                "Wayrill-ICS"
            } else {
                "Wayrill-TUN"
            }
        }
        Some(Value::String(name)) => name,
        _ => return Err(invalid("TUN adapter name must be text.")),
    };
    if !adapters::valid_name(name) {
        return Err(invalid(
            "Enter a valid adapter name (up to 100 characters).",
        ));
    }
    Ok(name)
}

pub fn validate(config: &Value) -> Result<()> {
    let tuns: Vec<_> = config["inbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["protocol"] == "tun")
        .collect();
    if tuns.is_empty() {
        return Ok(());
    }
    if tuns.len() > 2 {
        return Err(invalid(
            "Use one host TUN and one ICS TUN per running graph.",
        ));
    }
    if config["dns"]["servers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|server| {
            server
                .as_str()
                .or_else(|| server["address"].as_str())
                .is_some_and(|address| address.eq_ignore_ascii_case("localhost"))
        })
    {
        return Err(invalid(
            "The Windows system resolver (localhost) can recurse into TUN capture. Select an explicit DNS server in the DNS servers editor.",
        ));
    }
    for input in tuns {
        if config["outbounds"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|outbound| {
                outbound["protocol"] == "loopback"
                    && outbound["settings"]["inboundTag"] == input["tag"]
            })
        {
            return Err(invalid(
                "Loopback reinjection into TUN cannot retain packet metadata across the private relay. Target a socket inbound instead.",
            ));
        }
        let settings = input["settings"]
            .as_object()
            .ok_or_else(|| invalid("TUN settings must be an object."))?;
        const KEYS: &[&str] = &[
            "name",
            "desc",
            "mtu",
            "gateway",
            "dns",
            "userLevel",
            "autoSystemRoutingTable",
            "autoOutboundsInterface",
            "autoSystemDnsToGateway",
            "autoSystemWfpBlockLeak",
        ];
        if settings.keys().any(|k| !KEYS.contains(&k.as_str())) {
            return Err(invalid(
                "Unknown TUN settings. Use canonical Xray field names.",
            ));
        }
        if settings.get("autoSystemDnsToGateway") == Some(&json!(true)) {
            return Err(invalid(
                "Use adapter DNS servers on Windows; autoSystemDnsToGateway is Linux-only.",
            ));
        }
        if input.get("streamSettings").is_some() {
            return Err(invalid(
                "TUN does not accept listener transport or socket settings.",
            ));
        }
        adapter_name(&input["settings"], false)?;
        prefixes(&input["settings"], "gateway")?;
        prefixes(&input["settings"], "autoSystemRoutingTable")?;
        if let Some(dns) = settings.get("dns") {
            let servers = dns
                .as_array()
                .ok_or_else(|| invalid("TUN adapter DNS must be a list of IP addresses."))?;
            if servers.iter().any(|server| {
                server
                    .as_str()
                    .is_none_or(|ip| ip.parse::<IpAddr>().is_err())
            }) {
                return Err(invalid(
                    "TUN adapter DNS must contain IP addresses, not server URLs or names.",
                ));
            }
        }
        if settings.get("autoOutboundsInterface").is_some_and(|value| {
            value
                .as_str()
                .is_none_or(|name| name.chars().any(|c| c.is_control()))
        }) {
            return Err(invalid(
                "TUN uplink must be an adapter name without control characters.",
            ));
        }
        if input["tag"].as_str().is_none_or(|tag| tag.is_empty()) {
            return Err(invalid("TUN needs a nonempty tag."));
        }
    }
    // Native external lists read only managed DAT resources beside the pinned core.
    fn lists(value: &Value) -> Result<()> {
        match value {
            Value::String(s)
                if s.starts_with("ext:")
                    || s.starts_with("ext-ip:")
                    || s.starts_with("ext-domain:") =>
            {
                let file = s.split(':').nth(1).unwrap_or("");
                if !resources::valid_name(file) {
                    return Err(invalid(
                        "TUN geo resources must use a managed DAT filename.",
                    ));
                }
            }
            Value::Array(a) => {
                for v in a {
                    lists(v)?;
                }
            }
            Value::Object(o) => {
                for v in o.values() {
                    lists(v)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    lists(&config["routing"])?;
    lists(&config["dns"])?;
    Ok(())
}

pub struct Plan {
    pub main: Value,
    fake_dns: Option<String>,
    worker: Value,
    name: String,
    adapter_settings: Value,
    uplink: String,
    reservation: Option<TcpListener>,
    dns_reservation: Option<TcpListener>,
    applications: Option<Value>,
    shared: Option<Box<Plan>>,
    shared_source: bool,
    sharing_options: Option<sharing::Options>,
    pub routing_aliases: Vec<(String, String)>,
    network_key: Value,
}
impl Plan {
    pub(crate) fn set_fake_dns(&mut self, endpoint: Option<&str>) {
        self.fake_dns = endpoint.map(str::to_owned);
        if let Some(shared) = &mut self.shared {
            shared.set_fake_dns(endpoint);
        }
    }
    pub fn monitor_routing(&mut self) {
        crate::routing_log::enable(&mut self.worker);
        if let Some(shared) = &mut self.shared {
            shared.monitor_routing();
        }
    }
    pub fn release_relay(&mut self) {
        self.reservation = None;
        self.dns_reservation = None;
        if let Some(shared) = &mut self.shared {
            shared.release_relay();
        }
    }
}
// Resolve while the previous routing core is still usable. Only temporary DNS
// hosts cross the activation boundary; saved/exported configuration is unchanged.
pub fn bootstrap_hosts(config: &Value, cached: Option<&Value>) -> Result<Option<Value>> {
    if !config["inbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|i| i["protocol"] == "tun")
    {
        return Ok(None);
    }
    let mut runtime = config.clone();
    if let Some(hosts) = cached {
        if !runtime["dns"].is_object() {
            runtime["dns"] = json!({});
        }
        runtime["dns"]["hosts"] = hosts.clone();
    }
    bootstrap(&mut runtime)?;
    Ok(Some(runtime["dns"]["hosts"].clone()))
}
#[cfg(test)]
pub fn prepare(config: &Value) -> Result<Option<Plan>> {
    prepare_with_applications(config, None, None)
}
fn shared_ipv6_host(host: Option<&Value>) -> Result<&Value> {
    let host = host.ok_or_else(|| {
        ApiError::new(
            "ICS_IPV6_TUN",
            "Add or enable a dual-stack host TUN to share IPv6 with ICS clients.",
        )
    })?;
    if !client_ipv6_settings(&host["settings"])? {
        return Err(ApiError::new(
            "ICS_IPV6_TUN",
            "IPv6 sharing requires complete IPv6 capture on the host TUN.",
        ));
    }
    Ok(host)
}
fn preflight_shared_ipv6(host: Option<&Value>, options: Option<&sharing::Options>) -> Result<()> {
    if let Some(o) = options.filter(|o| o.ipv6) {
        shared_ipv6_host(host)?;
        clients::preflight(&o.private_id)?;
        uplink_guard::Guard::preflight(
            &guid_uplink(&o.public_id)?,
            &json!({"autoSystemRoutingTable":["::/0"]}),
            true,
        )?;
    }
    Ok(())
}
pub fn prepare_with_applications(
    config: &Value,
    capture: Option<&crate::capture::Plan>,
    excluded_index: Option<u32>,
) -> Result<Option<Plan>> {
    validate(config)?;
    // The kernel validates saved capture templates before instrumentation. This
    // config already contains service-owned relay authentication; validating it
    // again as an authored noauth template would reject every WinDivert input.
    let options = capture.and_then(|p| p.tun_sharing.as_ref());
    let mut runtime = config.clone();
    let host = config["inbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| i["protocol"] == "tun" && options.is_none_or(|o| i["tag"] != o.tag));
    preflight_shared_ipv6(host, options)?;
    let mut plan = if let Some(input) = host {
        Some(prepare_source(
            &runtime,
            input,
            capture,
            uplink_except(&input["settings"], excluded_index)?,
            false,
            true,
            options.is_some(),
        )?)
    } else {
        None
    };
    if let Some(primary) = &plan {
        runtime = primary.main.clone();
    }
    if let Some(options) = options {
        let input = config["inbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["tag"] == options.tag)
            .ok_or_else(|| invalid("ICS TUN is missing."))?;
        let upstream = guid_uplink(&options.public_id)?;
        let mut shared = prepare_source(
            &runtime,
            input,
            capture,
            upstream.clone(),
            true,
            host.is_none(),
            true,
        )?;
        for outbound in shared.main["outbounds"].as_array_mut().unwrap() {
            if options
                .upstream_tags
                .iter()
                .any(|tag| outbound["tag"] == *tag)
            {
                if !outbound["streamSettings"].is_object() {
                    outbound["streamSettings"] = json!({});
                }
                if !outbound["streamSettings"]["sockopt"].is_object() {
                    outbound["streamSettings"]["sockopt"] = json!({});
                }
                outbound["streamSettings"]["sockopt"]["interface"] = json!(upstream);
            }
        }
        if let Some(primary) = &mut plan {
            if options.ipv6 {
                primary.routing_aliases =
                    shared_ipv6_worker(&mut primary.worker, &shared.worker, &options.private_id)?;
            }
            primary.main = shared.main.clone();
            primary.shared = Some(Box::new(shared));
            primary.sharing_options = Some(options.clone());
        } else {
            shared.sharing_options = Some(options.clone());
            plan = Some(shared);
        }
    }
    if let Some(plan) = &mut plan {
        plan.network_key = update::network_key(config, capture);
    }
    Ok(plan)
}
fn prepare_source(
    config: &Value,
    input: &Value,
    capture: Option<&crate::capture::Plan>,
    uplink: String,
    shared_source: bool,
    bridge_dns: bool,
    sharing: bool,
) -> Result<Plan> {
    network::require_ready(&uplink)?;
    uplink_guard::Guard::preflight(&uplink, &input["settings"], sharing)?;
    let reservation = crate::sockets::reserve_loopback(config)?;
    let port = reservation
        .local_addr()
        .map_err(|e| ApiError::io("Read TUN relay", e))?
        .port();
    let password = random_id()? + &random_id()?;
    let tun_tag = input["tag"]
        .as_str()
        .filter(|tag| !tag.is_empty())
        .ok_or_else(|| invalid("TUN needs a nonempty tag."))?;
    // Route selection happens against the original TUN source in the worker.
    // Only its final destination (including a policy) crosses the private relay.
    let mut destinations = BTreeSet::new();
    let default = config["outbounds"][0]["tag"]
        .as_str()
        .ok_or_else(|| invalid("TUN default outbound needs a tag."))?;
    destinations.insert(("outboundTag".to_string(), default.to_string()));
    let mut application_input=capture.and_then(|p|p.inputs.iter().find(|i|i.source.as_deref()==Some("tun") && i.tag==tun_tag))
        .map(|i|serde_json::to_value(i).unwrap()).unwrap_or_else(||json!({"source":"tun","tag":tun_tag,"selectors":[],"ports":"","networks":["tcp","udp"],"predicates":[],"masks":["0"]}));
    // Native configs also need a NAT-aware identity provider without application rules.
    if application_input["masks"]
        .as_array()
        .is_none_or(Vec::is_empty)
    {
        application_input["masks"] = json!(["0"]);
    }
    let mut worker_rules = worker_rules_with_nat(
        config,
        tun_tag,
        &config["dns"],
        application_input["natTag"].as_str(),
    );
    for r in &worker_rules {
        for key in ["outboundTag", "balancerTag"] {
            if let Some(tag) = r[key].as_str() {
                destinations.insert((key.into(), tag.into()));
            }
        }
    }
    let destinations: BTreeMap<_, _> = destinations
        .into_iter()
        .enumerate()
        .map(|(i, d)| (d, format!("wtr-{}", crate::tags::number(i as u64))))
        .collect();
    let mut main = config.clone();
    main["inbounds"]
        .as_array_mut()
        .unwrap()
        .retain(|v| v["tag"] != input["tag"]);
    main["inbounds"].as_array_mut().unwrap().push(json!({"tag":tun_tag,"protocol":"socks","listen":"127.0.0.1","port":port,"streamSettings":{"sockopt":crate::sockets::udp_buffer_options(config)},"settings":{"auth":"password","udp":true,"ip":"127.0.0.1","accounts":destinations.values().map(|u|json!({"user":u,"pass":password})).collect::<Vec<_>>()}}));
    if let Some(level) = input["settings"].get("userLevel") {
        main["inbounds"].as_array_mut().unwrap().last_mut().unwrap()["settings"]["userLevel"] =
            level.clone();
    }
    let loopback = loopback_interface()?;
    let mut relays = Vec::new();
    let mut relay_rules = Vec::new();
    for ((key, target), user) in &destinations {
        let mut rule = json!({"type":"field","inboundTag":[tun_tag],"user":[user]});
        rule[key] = json!(target);
        relay_rules.push(rule);
        relays.push(json!({"tag":user,"protocol":"socks","sendThrough":"127.0.0.1","settings":{"address":"127.0.0.1","port":port,"user":user,"pass":password},"streamSettings":{"sockopt":{"interface":loopback,"customSockopt":crate::sockets::udp_buffer_options(config)["customSockopt"]}}}));
    }
    for r in &mut worker_rules {
        for key in ["outboundTag", "balancerTag"] {
            if let Some(target) = r[key].as_str() {
                let user = &destinations[&(key.into(), target.into())];
                r.as_object_mut().unwrap().remove(key);
                r["outboundTag"] = json!(user);
                break;
            }
        }
    }
    if !main["routing"].is_object() {
        main["routing"] = json!({});
    }
    relay_rules.extend(
        main["routing"]["rules"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    );
    main["routing"]["rules"] = json!(relay_rules);
    egress::bind(&mut main, &uplink, &loopback)?;
    // An explicit TUN DNS scope must never resolve through Windows' captured
    // system resolver. When no resolver was configured, use the adapter preset.
    if main["dns"]["servers"]
        .as_array()
        .is_none_or(|servers| servers.is_empty())
    {
        if !main["dns"].is_object() {
            main["dns"] = json!({});
        }
        let servers = input["settings"]["dns"]
            .as_array()
            .filter(|servers| !servers.is_empty())
            .cloned()
            .unwrap_or_else(|| vec![json!("1.1.1.1")]);
        main["dns"]["servers"] = json!(servers);
    }
    bootstrap(&mut main)?;
    let mut tun = json!({"tag":tun_tag,"protocol":"tun","settings":input["settings"]});
    if let Some(sniffing) = input.get("sniffing") {
        tun["sniffing"] = sniffing.clone();
    }
    // Native +local DNS transports also bypass our capture. Xray's controller
    // skips loopback relays; all remote protocols remain in the restricted core.
    tun["settings"]["autoOutboundsInterface"] = json!(uplink);
    tun["settings"]
        .as_object_mut()
        .unwrap()
        .remove("autoSystemDnsToGateway");
    let mut worker = json!({"log":{"loglevel":"warning"},"inbounds":[tun],"outbounds":[],"routing":{"rules":worker_rules}});
    if let Some(environment) = config.get("env") {
        worker["env"] = environment.clone();
    }
    let default_user = &destinations[&("outboundTag".into(), default.into())];
    if let Some(index) = relays
        .iter()
        .position(|o| o["tag"].as_str() == Some(default_user))
    {
        relays.swap(0, index);
    }
    worker["outbounds"] = json!(relays);
    if let Some(strategy) = config["routing"].get("domainStrategy") {
        worker["routing"]["domainStrategy"] = strategy.clone();
    }
    if let Some(policy) = config.get("policy") {
        worker["policy"] = policy.clone();
    }
    worker["dns"] = main["dns"].clone();
    if let Some(pools) = config.get("fakedns") {
        worker["fakedns"] = pools.clone();
    }
    let mut dns_reservation = None;
    if bridge_dns {
        let reserved_dns = crate::sockets::reserve_loopback(&worker)?;
        let dns_port = reserved_dns
            .local_addr()
            .map_err(|e| ApiError::io("Read TUN resolver", e))?
            .port();
        let native = config.get("fakedns").is_some_and(|p| !p.is_null());
        let dns_tag = format!("wdr-{}{}", if native { "n-" } else { "" }, random_tag_id()?);
        let dns_out = format!("wdo-{}", random_tag_id()?);
        worker["inbounds"].as_array_mut().unwrap().push(json!({"tag":dns_tag,"protocol":"dokodemo-door","listen":"127.0.0.1","port":dns_port,"settings":{"address":"1.1.1.1","port":53,"network":"tcp"}}));
        worker["outbounds"]
            .as_array_mut()
            .unwrap()
            .push(json!({"tag":dns_out,"protocol":"dns","settings":{}}));
        worker["routing"]["rules"].as_array_mut().unwrap().insert(
            0,
            json!({"type":"field","inboundTag":[dns_tag],"outboundTag":dns_out}),
        );
        // The full resolver lives in the scoped worker. The main core uses its local
        // TCP resolver bridge, so +local transports cannot recurse into TUN routes.
        let scheme = if native { "wayrill-dns" } else { "tcp+local" };
        main["dns"]["servers"] = json!([format!("{scheme}://127.0.0.1:{dns_port}")]);
        main["dns"]["disableFallback"] = json!(false);
        main["dns"]["disableFallbackIfMatch"] = json!(false);
        dns_reservation = Some(reserved_dns);
    }
    let name = adapter_name(&input["settings"], shared_source)?.to_owned();
    Ok(Plan {
        main,
        fake_dns: None,
        worker,
        name,
        adapter_settings: input["settings"].clone(),
        uplink,
        reservation: Some(reservation),
        dns_reservation,
        applications: Some(application_input),
        shared: None,
        shared_source,
        sharing_options: None,
        routing_aliases: Vec::new(),
        network_key: Value::Null,
    })
}

pub(crate) fn full_ipv6(settings: &Value) -> Result<bool> {
    let routes = prefixes(settings, "autoSystemRoutingTable")?;
    Ok(routes.contains(&(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0))
        || ["::/1", "8000::/1"]
            .iter()
            .all(|p| routes.contains(&prefix(p).unwrap())))
}
pub(crate) fn client_ipv6_settings(settings: &Value) -> Result<bool> {
    let mtu = match settings.get("mtu") {
        None => 1500,
        Some(value) => match value.as_u64() {
            Some(0) => 1500,
            Some(mtu) => mtu,
            None => return Ok(false),
        },
    };
    Ok(full_ipv6(settings)?
        && (1280..=65535).contains(&mtu)
        && prefixes(settings, "gateway")?.iter().any(|(ip, _)| {
            matches!(ip, IpAddr::V6(v) if !v.is_unicast_link_local() && !v.is_loopback() && !v.is_unspecified() && !v.is_multicast())
        }))
}
fn shared_ipv6_worker(
    host: &mut Value,
    shared: &Value,
    private: &str,
) -> Result<Vec<(String, String)>> {
    if !client_ipv6_settings(&host["inbounds"][0]["settings"])? {
        return Err(ApiError::new(
            "ICS_IPV6_TUN",
            "IPv6 sharing requires an enabled host TUN with an IPv6 gateway and complete IPv6 capture routes. Select Capture IPv4 and IPv6 in its editor.",
        ));
    }
    let host_tag = host["inbounds"][0]["tag"].clone();
    let shared_tag = &shared["inbounds"][0]["tag"];
    let mut targets = BTreeMap::new();
    for (index, o) in shared["outbounds"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["protocol"] == "socks")
        .enumerate()
    {
        let tag = o["tag"].as_str().unwrap();
        let renamed = format!("wi6-{}", crate::tags::number(index as u64));
        targets.insert(tag.to_owned(), renamed.clone());
        let mut relay = o.clone();
        relay["tag"] = json!(renamed);
        host["outbounds"].as_array_mut().unwrap().push(relay);
    }
    let scope = json!([format!("{}/64", clients::prefix(private))]);
    let mut rules = Vec::new();
    let mut tags: BTreeSet<String> = host["routing"]["rules"]
        .as_array()
        .unwrap()
        .iter()
        .chain(shared["routing"]["rules"].as_array().unwrap())
        .filter_map(|r| r["ruleTag"].as_str().map(str::to_owned))
        .collect();
    let mut aliases = Vec::new();
    for r in shared["routing"]["rules"].as_array().unwrap() {
        if r["inboundTag"]
            .as_array()
            .is_some_and(|tags| !tags.is_empty() && !tags.contains(shared_tag))
        {
            continue;
        }
        let Some(target) = r["outboundTag"].as_str().and_then(|t| targets.get(t)) else {
            continue;
        };
        // Source-dependent shared rules were rejected before this private plan.
        if r.get("sourceIP").is_some() || r.get("process").is_some() || r.get("user").is_some() {
            return Err(invalid(
                "Unexpected source predicate on shared IPv6 traffic.",
            ));
        }
        let mut rule = r.clone();
        if let Some(tag) = r["ruleTag"].as_str().filter(|tag| !tag.is_empty()) {
            let base = format!("{tag}-ics6");
            let mut alias = base.clone();
            let mut suffix = 1;
            while !tags.insert(alias.clone()) {
                alias = format!("{base}-{suffix}");
                suffix += 1;
            }
            rule["ruleTag"] = json!(alias);
            aliases.push((alias, tag.to_owned()));
        }
        rule["inboundTag"] = json!([host_tag]);
        rule["sourceIP"] = scope.clone();
        rule["outboundTag"] = json!(target);
        rule["user"] = json!(["wr-ics6"]);
        rules.push(rule);
    }
    let default = shared["outbounds"][0]["tag"]
        .as_str()
        .and_then(|t| targets.get(t))
        .ok_or_else(|| invalid("Shared IPv6 fallback relay is missing."))?;
    rules.push(json!({"type":"field","inboundTag":[host_tag],"sourceIP":scope,"user":["wr-ics6"],"outboundTag":default}));
    rules.extend(host["routing"]["rules"].as_array().unwrap().clone());
    host["routing"]["rules"] = json!(rules);
    Ok(aliases)
}

// The lease can only come from this manager's live, uniquely owned adapter.
// Holding it through a warm restart preserves VPN routes whose next hop is our
// peer; it never discovers, adopts, or copies routes from another adapter.
pub struct RetainedAdapter(Adapter);
impl RetainedAdapter {
    pub fn index(&self) -> u32 {
        self.0.index
    }
}

fn reusable_settings(previous: &Value, next: &Value) -> bool {
    let without_level = |settings: &Value| {
        let mut settings = settings.clone();
        if let Some(object) = settings.as_object_mut() {
            object.remove("userLevel");
            object.remove("name");
            object.remove("autoOutboundsInterface"); // Egress binding is not adapter geometry.
        }
        settings
    };
    previous.is_object()
        && next.is_object()
        && previous["autoSystemWfpBlockLeak"]
            .as_array()
            .is_none_or(Vec::is_empty)
        && without_level(previous) == without_level(next)
}

/// Runtime-only socket selection shared by activation, probes and the interface UI.
#[derive(Clone)]
pub(crate) struct OutboundEgress {
    pub uplink: String,
    pub loopback: String,
    pub captured: bool,
}
impl OutboundEgress {
    pub fn bind(&self, config: &mut Value) -> Result<()> {
        if self.captured {
            egress::bind(config, &self.uplink, &self.loopback)
        } else {
            egress::bind_direct(config, &self.uplink, &self.loopback)
        }
    }
}
pub(crate) fn needs_direct_binding(config: &Value) -> bool {
    egress::needs_direct_binding(config)
}

pub struct Manager {
    adapters: adapters::Store,
    adapter_recovery_error: Option<ApiError>,
    retirement_pending: Option<crate::lifecycle::SharingExit>,
    core: Option<CoreProcess>,
    adapter: Option<Adapter>,
    adapter_settings: Option<Value>,
    uplink: Option<String>,
    uplink_guard: Option<uplink_guard::Guard>,
    applications: Option<crate::capture::Worker>,
    sharing: sharing::Manager,
    keeper: Option<keeper::Client>,
    sharing_poll: Instant,
    running: Option<update::Running>,
    host_control: Option<crate::live::Control>,
    shared_worker: Option<Value>,
}
impl Manager {
    pub fn new(data: &Path, worker_root: std::path::PathBuf) -> Result<Self> {
        // Recovery can disable retained host capture. Contain private DNS
        // delivery before removing that protection, even after both owners died.
        // Missing hardware must leave recovery available without retiring any
        // existing capture before its sharing barrier can be reconciled.
        let protection = {
            let _transaction = keeper::mutation_lock()?;
            sharing_guard::set_paused(data, true)
        };
        let adapters = adapters::Store::new(data);
        let adapter_recovery_error = protection
            .and_then(|()| adapters.rehydrate())
            .and_then(|_| adapters.disable(adapters::Kind::Host, None))
            .err();
        let mut manager = Self {
            adapters,
            adapter_recovery_error,
            retirement_pending: None,
            core: None,
            adapter: None,
            adapter_settings: None,
            uplink: None,
            uplink_guard: None,
            applications: None,
            sharing: sharing::Manager::new(data, worker_root)?,
            keeper: None,
            sharing_poll: Instant::now(),
            running: None,
            host_control: None,
            shared_worker: None,
        };
        if manager.adapter_recovery_error.is_none() && !manager.sharing.recovery_pending() {
            manager.adapter_recovery_error = manager.disable_shared_adapter().err();
        }
        Ok(manager)
    }
    fn disable_shared_adapter(&mut self) -> Result<()> {
        if !self.adapters.has(adapters::Kind::Ics)? {
            return Ok(());
        }
        let ids = self.adapters.ids()?;
        let snapshot = self.sharing_inspect()?;
        // Preserve native sharing configured outside Wayrill, even if it uses
        // a device originally created by us. Explicit deletion reports why.
        if adapters::assert_unshared(&ids, &snapshot).is_ok() {
            self.adapters.disable(adapters::Kind::Ics, None)?;
        }
        Ok(())
    }
    pub fn adapter_inspect(&self) -> Result<Value> {
        self.adapters.inspect(
            &self.capture_interfaces(),
            self.sharing.recovery_pending() || self.keeper.is_some(),
            |kind| self.adapter_removal_allowed(kind),
        )
    }
    pub fn adapter_preferences(&self) -> Result<adapters::Preferences> {
        self.adapters.preferences()
    }
    pub fn adapter_set(&self, value: adapters::Preferences) -> Result<()> {
        self.adapters.set(value)
    }
    fn adapter_removal_allowed(&self, kind: adapters::Kind) -> bool {
        // Repair permission belongs to the selected resource, not the aggregate
        // core state. An unrelated sharing conflict cannot own an idle host slot.
        let host_idle = self.core.is_none()
            && self.running.is_none()
            && self.applications.is_none()
            && self.adapter.is_none();
        host_idle
            && match kind {
                adapters::Kind::Host => true,
                adapters::Kind::Ics => self.keeper.is_none() && !self.sharing.recovery_pending(),
            }
    }
    pub fn adapter_remove(&mut self, value: adapters::Remove) -> Result<()> {
        if !self.adapter_removal_allowed(value.kind) {
            return Err(invalid(
                "Stop routing and finish sharing recovery before removing adapters.",
            ));
        }
        let ids = self.adapters.removal_ids(value.kind)?;
        adapters::assert_unshared(&ids, &self.sharing_inspect()?)?;
        self.adapters.remove(value)
    }
    pub fn sharing_inspect(&mut self) -> Result<Value> {
        if let Some(keeper) = &mut self.keeper {
            keeper.call("inspect", json!({}))
        } else {
            self.sharing.inspect()
        }
    }
    // Before replacing a running graph, automatic selection reuses its known
    // physical uplink instead of mistaking our own active split routes for it.
    pub fn restore_sharing(&mut self) -> Result<()> {
        self.retire(crate::lifecycle::SharingExit::Suspend)?;
        self.sharing.restore_saved()
    }
    pub fn sharing_keep(&mut self, expected: &str) -> Result<()> {
        if self.core.is_some() || self.adapter.is_some() {
            return Err(ApiError::new(
                "ICS_RUNNING",
                "Stop host routing before keeping Windows sharing changes.",
            ));
        }
        if let Some(keeper) = &mut self.keeper {
            keeper.call("keep", json!({"expectedVersion":expected}))?;
            self.keeper = None;
            self.sharing.refresh_after_keeper()?;
            self.disable_shared_adapter()?;
            Ok(())
        } else {
            self.sharing.keep(expected)
        }
    }
    pub fn preflight(
        &mut self,
        config: &Value,
        capture: Option<&crate::capture::Plan>,
    ) -> Result<()> {
        crate::capture::validate(capture, config)?;
        // A previous transition may have parked capture while its native owner
        // drained. Finish that exact retirement before examining a new plan.
        self.finish_retirement()?;
        if self.adapter_recovery_error.is_some() {
            self.pause_sharing()?;
            self.adapters.rehydrate()?;
            self.adapters.disable(adapters::Kind::Host, None)?;
            self.disable_shared_adapter()?;
            self.adapter_recovery_error = None;
        }
        let options = capture.and_then(|p| p.tun_sharing.as_ref());
        if let Some(options) = options {
            // A WiFi link/DHCP delay is a network wait, before native sharing
            // recovery can produce a misleading COM topology failure.
            network::require_ready(&guid_uplink(&options.public_id)?)?;
        }
        let shared_uplink = if let Some(options) = options {
            if let Some(keeper) = &mut self.keeper {
                Some(
                    keeper.call("preflight", serde_json::to_value(options).unwrap())?["uplink"]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid ICS uplink reply."))?
                        .to_string(),
                )
            } else {
                Some(self.sharing.selection(options)?)
            }
        } else {
            None
        };
        let host = config["inbounds"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|i| i["protocol"] == "tun" && options.is_none_or(|o| i["tag"] != o.tag));
        preflight_shared_ipv6(host, options)?;
        let Some(input) = host else {
            return Ok(());
        };
        let settings = &input["settings"];
        let requested = settings["autoOutboundsInterface"]
            .as_str()
            .unwrap_or("auto");
        let name = if requested.is_empty() || requested == "auto" {
            self.uplink
                .clone()
                .or(shared_uplink.clone())
                .map(Ok)
                .unwrap_or_else(|| uplink(settings))?
        } else {
            uplink(settings)?
        };
        if self.keeper.is_none() && self.core.is_none() {
            self.sharing.preflight(&name, shared_uplink.is_some())?;
        }
        uplink_guard::Guard::preflight(
            &name,
            settings,
            shared_uplink.as_ref() == Some(&name) || capture.is_some_and(|p| p.sharing_disabled),
        )?;
        Ok(())
    }

    pub(crate) fn outbound_egress(&self) -> Result<OutboundEgress> {
        let captured = self.core.is_some() || self.keeper.is_some();
        let name = if captured {
            let selected = self.uplink.as_deref().ok_or_else(|| {
                unavailable_uplink("The active capture has no usable upstream interface.")
            })?;
            uplink(&json!({"autoOutboundsInterface": selected}))?
        } else {
            uplink(&json!({}))?
        };
        Ok(OutboundEgress {
            uplink: name,
            loopback: loopback_interface()?,
            captured,
        })
    }
    pub fn interfaces(&self) -> Result<Value> {
        self.list_interfaces(false)
    }
    pub(crate) fn outbound_interfaces(&self) -> Result<Value> {
        self.list_interfaces(true)
    }
    fn list_interfaces(&self, include_loopback: bool) -> Result<Value> {
        let owned = self.adapters.ids()?;
        let mut bytes = 16 * 1024u32;
        loop {
            if bytes > 4 * 1024 * 1024 {
                return Err(invalid("Adapter inventory exceeded its limit."));
            }
            let mut buf = vec![0u64; bytes.div_ceil(8) as usize];
            let rows = buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
            let code = unsafe {
                GetAdaptersAddresses(
                    AF_UNSPEC as u32,
                    GAA_FLAG_SKIP_ANYCAST
                        | GAA_FLAG_SKIP_MULTICAST
                        | GAA_FLAG_SKIP_DNS_SERVER
                        | GAA_FLAG_SKIP_UNICAST,
                    ptr::null(),
                    rows,
                    &mut bytes,
                )
            };
            if code == ERROR_BUFFER_OVERFLOW {
                continue;
            }
            if code != 0 {
                return Err(ApiError::io(
                    "List uplink adapters",
                    std::io::Error::from_raw_os_error(code as i32),
                ));
            }
            let mut result = Vec::new();
            let mut row = rows;
            while !row.is_null() {
                let adapter = unsafe { &*row };
                let index = unsafe { adapter.Anonymous1.Anonymous.IfIndex };
                let mut id = GUID::default();
                let known = unsafe { ConvertInterfaceLuidToGuid(&adapter.Luid, &mut id) } == 0
                    && owned.iter().any(|guid| {
                        guid_luid(guid)
                            .ok()
                            .is_some_and(|luid| unsafe { luid.Value == adapter.Luid.Value })
                    });
                if !known
                    && !self.adapter.as_ref().is_some_and(|a| a.index == index)
                    && !self
                        .keeper
                        .as_ref()
                        .is_some_and(|k| k.interface_index() == Some(index))
                    && (include_loopback || adapter.IfType != 24)
                {
                    if let Ok(name) = alias(&adapter.Luid) {
                        result.push(json!({"name":name,"active":adapter.OperStatus==1}));
                    }
                }
                row = adapter.Next;
            }
            return Ok(json!(result));
        }
    }
    pub fn core_pids(&self) -> impl Iterator<Item = u32> + '_ {
        self.core
            .as_ref()
            .map(|c| c.pid)
            .into_iter()
            .chain(self.keeper.as_ref().and_then(|k| k.core_pid()))
    }
    pub fn retain_adapter(
        &mut self,
        config: &Value,
        capture: Option<&crate::capture::Plan>,
    ) -> Option<RetainedAdapter> {
        // ICS handoff and native WFP leak filters have separate lifetimes. They
        // require the existing full stop/start path, not this warm host restart.
        if self.core.is_none()
            || self.keeper.is_some()
            || capture.is_some_and(|p| p.tun_sharing.is_some())
        {
            return None;
        }
        let next = config["inbounds"]
            .as_array()?
            .iter()
            .find(|i| i["protocol"] == "tun")?;
        if !reusable_settings(self.adapter_settings.as_ref()?, &next["settings"]) {
            return None;
        }
        self.adapter.take().map(RetainedAdapter)
    }
    pub fn capture_interfaces(&self) -> Vec<String> {
        self.adapter
            .as_ref()
            .map(|a| a.guid.clone())
            .into_iter()
            .chain(
                self.keeper
                    .as_ref()
                    .and_then(|k| k.adapter_id())
                    .map(str::to_owned),
            )
            .collect()
    }
    // Include retained, disabled slots as well as live disposable adapters.
    // A graph edit or restart must never make our vNIC eligible for WinDivert.
    pub fn excluded_capture_interfaces(&self) -> Result<Vec<String>> {
        let mut ids = self.adapters.ids()?;
        ids.extend(self.capture_interfaces());
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
    pub fn status(&self) -> Value {
        json!({"state":if self.core.is_some() || self.keeper.is_some(){"running"}else{"stopped"},"pid":self.core.as_ref().map(|c|c.pid),"name":self.adapter.as_ref().map(|a|&a.name),"interfaceIndex":self.adapter.as_ref().map(|a|a.index),"uplink":self.uplink,"sharing":self.keeper.as_ref().map(|k|k.sharing_status()).unwrap_or_else(||self.sharing.status()),"adapterRecoveryError":self.adapter_recovery_error,"keeperPid":self.keeper.as_ref().map(|k|k.pid()),"sharedPid":self.keeper.as_ref().and_then(|k|k.core_pid()),"sharedName":self.keeper.as_ref().and_then(|k|k.adapter_name())})
    }
    pub fn start(
        &mut self,
        exe: &Path,
        mut plan: Plan,
        events: Arc<Events>,
        generation: u64,
        retained: Option<RetainedAdapter>,
    ) -> Result<()> {
        self.retire(crate::lifecycle::SharingExit::Suspend)?;
        let key = plan.network_key.clone();
        let application_input = plan.applications.clone();
        let options = plan.sharing_options.take();
        if plan.shared_source {
            let options = options.ok_or_else(|| invalid("ICS sharing selection is missing."))?;
            self.start_shared(plan, options, None, false, events, generation)?;
            self.running = Some(update::Running {
                key,
                host_settings: None,
                applications: None,
                metadata: None,
                uplink: network::snapshot(self.uplink.as_ref().unwrap())?,
            });
            return Ok(());
        }
        let share = options.is_some();
        let shared_uplink = options
            .as_ref()
            .map(|o| guid_uplink(&o.public_id))
            .transpose()?;
        let same_uplink = shared_uplink.as_ref() == Some(&plan.uplink);
        uplink_guard::Guard::preflight(
            &plan.uplink,
            &plan.worker["inbounds"][0]["settings"],
            same_uplink,
        )?;
        let expected_routes = prefixes(
            &plan.worker["inbounds"][0]["settings"],
            "autoSystemRoutingTable",
        )?;
        let original_settings = plan.worker["inbounds"][0]["settings"].clone();
        let warm = retained.is_some();
        let mut adapter = match retained {
            Some(RetainedAdapter(adapter)) => adapter,
            None => self
                .adapters
                .acquire(exe, adapters::Kind::Host, &plan.name)?,
        };
        // Stage the host worker without capture routes until native ICS has moved.
        if share {
            plan.worker["inbounds"][0]["settings"]["autoSystemRoutingTable"] = json!([]);
        }
        // Compare against the completed settings saved on the previous run,
        // not the temporary route-free worker used for the ICS handoff.
        let reused = adapter.prepare_configuration(&original_settings, warm)?;
        if share {
            // An empty Xray route list does not flush retained routes. Retire the
            // old capture scope while this owned interface is still disabled;
            // otherwise starting its session captures before ICS is handed off.
            configuration::retire_capture_routes(adapter.index, &original_settings)?;
        }
        adapter.track_routes(configuration::capture_routes(&original_settings)?)?;
        if reused && !share {
            // Stop retires capture routes but retains addresses/DNS/MTU and
            // foreign VPN routes. Recreate only our rows while still disabled.
            configure_capture_routes(adapter.index, &expected_routes, &original_settings)?;
        }
        plan.worker["inbounds"][0]["settings"]["name"] = json!(adapter.name);
        let token = scoped_token()?;
        let service = exe.parent().unwrap().parent().unwrap();
        let (applications, endpoint) =
            update::application_provider(service, plan.applications.take(), options.as_ref())?;
        let worker_exe = worker_executable(service)?;
        let control = crate::live::Control::new(&plan.worker)?;
        let core = native::spawn_tun_with_token(
            &worker_exe,
            token,
            &control.config,
            "run -format json -config stdin:",
            Some(events.clone()),
            generation,
            native::TunOptions {
                metadata: endpoint.as_deref(),
                fakedns: plan.fake_dns.as_deref(),
                reuse_settings: reused,
                assets: exe.parent().unwrap(),
            },
        )?;
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(code) = core.exit_code()? {
                return Err(ApiError::new(
                    "TUN_START_FAILED",
                    format!(
                        "TUN worker exited ({code}). {}",
                        core.lines.lock().unwrap().join("")
                    ),
                ));
            }
            let ready = share || routes_ready(adapter.index, &expected_routes)?;
            if ready && core.started() {
                break;
            }
            if Instant::now() >= until {
                return Err(ApiError::new(
                    "TUN_TIMEOUT",
                    "TUN routes did not become ready.",
                ));
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        self.applications = applications;
        self.core = Some(core);
        self.host_control = Some(control);
        self.adapter = Some(adapter);
        self.adapter_settings = Some(plan.adapter_settings);
        self.uplink = Some(plan.uplink.clone());
        if !share && !reused {
            configure_capture_routes(
                self.adapter.as_ref().unwrap().index,
                &expected_routes,
                &original_settings,
            )?;
        }
        if let Some(options) = options {
            let client_ipv6 = options.ipv6;
            let shared = plan
                .shared
                .take()
                .ok_or_else(|| invalid("ICS worker plan is missing."))?;
            self.start_shared(
                *shared,
                options,
                self.adapter.as_ref().map(|a| a.index),
                same_uplink && expected_routes.iter().any(|(ip, _)| ip.is_ipv6()) || client_ipv6,
                events,
                generation,
            )?;
            let guard = uplink_guard::Guard::new(&plan.uplink, &original_settings)?;
            configure_capture_routes(
                self.adapter.as_ref().unwrap().index,
                &expected_routes,
                &original_settings,
            )?;
            if !routes_ready(self.adapter.as_ref().unwrap().index, &expected_routes)? {
                return Err(invalid("Staged TUN capture routes did not become ready."));
            }
            if client_ipv6 {
                let id = self.adapter.as_ref().unwrap().guid.clone();
                let mut row = MIB_IPINTERFACE_ROW {
                    Family: AF_INET6,
                    InterfaceLuid: guid_luid(&id)?,
                    ..Default::default()
                };
                let code = unsafe { GetIpInterfaceEntry(&mut row) };
                if code != 0 {
                    return Err(invalid(format!(
                        "Read owned IPv6 TUN forwarding failed ({code})."
                    )));
                }
                row.ForwardingEnabled = true;
                let code = unsafe { SetIpInterfaceEntry(&mut row) };
                if code != 0 {
                    return Err(invalid(format!(
                        "Enable owned IPv6 TUN return routing failed ({code})."
                    )));
                }
                self.adapter.as_ref().unwrap().activate()?;
                self.keeper.as_mut().unwrap().call(
                    "ipv6.enable",
                    json!({"mtu":original_settings["mtu"].as_u64().filter(|m| *m>0).unwrap_or(1500)}),
                )?;
            }
            self.uplink_guard = Some(guard);
        } else {
            self.uplink_guard = Some(uplink_guard::Guard::new(&plan.uplink, &original_settings)?);
        }
        self.adapter.as_ref().unwrap().activate()?;
        self.adapter
            .as_mut()
            .unwrap()
            .remember_configuration(&original_settings)?;
        self.running = Some(update::Running {
            key,
            host_settings: Some(original_settings),
            applications: application_input,
            metadata: endpoint,
            uplink: network::snapshot(self.uplink.as_ref().unwrap())?,
        });
        Ok(())
    }
    fn start_shared(
        &mut self,
        mut plan: Plan,
        options: sharing::Options,
        host_index: Option<u32>,
        host_ipv6: bool,
        events: Arc<Events>,
        generation: u64,
    ) -> Result<()> {
        plan.release_relay();
        let keeper = keeper::Client::spawn(events, generation)?;
        // Hold the client before Start: a timeout is an uncertain native mutation, not permission to delete its adapter.
        self.keeper = Some(keeper);
        let shared_worker = plan.worker.clone();
        self.keeper.as_mut().unwrap().call(
            "start",
            json!({"options":options,"worker":plan.worker,"hostIndex":host_index,"hostIpv6":host_ipv6,"fakeDns":plan.fake_dns}),
        )?;
        self.shared_worker = Some(shared_worker);
        if self.uplink.is_none() {
            self.uplink = Some(plan.uplink);
        }
        Ok(())
    }
    pub fn restore_sharing_intent(&mut self, previous: Option<bool>) -> Result<()> {
        let current = self.status()["sharing"]["restoreNativeOnBoot"].as_bool();
        if previous == current {
            return Ok(());
        }
        match previous {
            Some(true) => self.sharing.restore_intent(),
            Some(false) => self.retire(crate::lifecycle::SharingExit::Disable),
            None => Ok(()),
        }
    }
    pub fn request_sharing_handback(
        &mut self,
        sharing: crate::lifecycle::SharingExit,
    ) -> Result<()> {
        self.retirement_pending = Some(sharing);
        self.sharing.request_handback(sharing)
    }
    pub fn finish_retirement(&mut self) -> Result<()> {
        if let Some(sharing) = self.retirement_pending {
            if sharing != crate::lifecycle::SharingExit::Suspend {
                self.sharing.request_handback(sharing)?;
            }
            self.retire(sharing)?;
        }
        Ok(())
    }
    pub fn pause_sharing(&mut self) -> Result<()> {
        self.sharing.pause(true)
    }
    pub fn resume_sharing(&mut self) -> Result<()> {
        if self.keeper.is_some() {
            self.sharing.pause(false)?;
        }
        Ok(())
    }
    pub fn retire(&mut self, sharing: crate::lifecycle::SharingExit) -> Result<()> {
        self.pause_sharing()?;
        self.retirement_pending = Some(sharing);
        // Park capture while retaining its lease AND Wintun handle. A keeper
        // whose response channel died must be able to prove capture release
        // without needing the same exclusive lease that this parent still owns.
        if let Some(adapter) = &self.adapter {
            adapter.park()?;
        }
        if let Some(keeper) = &mut self.keeper {
            if let Err(error) = keeper.prepare_stop() {
                if keeper.draining() {
                    // retire() can acquire the keeper lease only after its
                    // in-flight native operation and EOF handoff have ended.
                    // A failed handback may leave a read-only guardian alive;
                    // guarded journal recovery lets that guardian retire too.
                    return Err(crate::lifecycle::Cleanup::after_failure(
                        error,
                        "sharing owner drain",
                        self.sharing.retire(sharing),
                    ));
                }
                return Err(error);
            }
        }
        // Wintun orphan maintenance can now safely run: the keeper is prepared
        // or confirmed dead. No Wintun handle was closed before this barrier.
        // A dead keeper cannot acknowledge preparation. Its exclusive adapter
        // lease has ended, so park any user-disabled owned device here before
        // closing a Wintun handle. Live/uncertain keepers retain their lease.
        self.adapters.preserve_disabled()?;
        if let Some(adapter) = &self.adapter {
            adapter.preserve_disabled()?;
        }
        let host_result = self.core.take().map_or(Ok(()), |core| core.stop());
        let application_result = self
            .applications
            .take()
            .map_or(Ok(()), crate::capture::Worker::stop);
        self.running = None;
        self.host_control = None;
        self.shared_worker = None;
        let adapter_result = self
            .adapter
            .as_mut()
            .map_or(Ok(()), |adapter| adapter.disable());
        if adapter_result.is_ok() {
            self.adapter = None;
            self.adapter_settings = None;
            self.uplink_guard = None;
        }
        // Even if host retirement fails, attempt sharing handback. The keeper
        // independently proves host capture release before restoring forwarding.
        let sharing_result = self.stop_shared(sharing);
        let mut cleanup = crate::lifecycle::Cleanup::default();
        cleanup.record("host packet worker", host_result);
        cleanup.record("attribution companion", application_result);
        cleanup.record("host adapter restoration", adapter_result);
        cleanup.record("sharing handback", sharing_result);
        let result = cleanup.finish();
        if result.is_ok() {
            self.retirement_pending = None;
        }
        result
    }
    fn stop_shared(&mut self, sharing: crate::lifecycle::SharingExit) -> Result<()> {
        // Host retirement first releases capture. The shared
        // adapter and its Direct worker stay alive until sharing is restored.
        if let Some(keeper) = &mut self.keeper {
            keeper.stop(sharing)?;
        }
        self.keeper = None;
        self.sharing.retire(sharing)?;
        // A previous process or Windows restart may have retained the shared
        // vNIC without a live worker. Disable it only after native handback.
        self.disable_shared_adapter()?;
        self.uplink = None;
        Ok(())
    }
    pub fn poll(&mut self) -> Result<()> {
        if self.sharing_poll.elapsed() >= Duration::from_secs(2) {
            if let Some(keeper) = &mut self.keeper {
                keeper.call("status", json!({}))?;
            } else {
                self.sharing.poll()?;
            }
            self.sharing_poll = Instant::now();
        }
        if let Some(guard) = &self.uplink_guard {
            guard.check().map_err(|mut error| {
                error.message.push_str(" TUN capture has ended; affected applications may use native networking. Restart after resolving the uplink setting.");
                error
            })?;
        }
        if let Some(provider) = &mut self.applications {
            provider.call("applications.status", json!({})).map_err(|error| ApiError::new("TUN_ATTRIBUTION_FAILED", format!("{} TUN capture has ended; affected applications may use native networking. Restart to resume.",error.message)))?;
        }
        if let Some(core) = &self.core {
            if let Some(code) = core.exit_code()? {
                return Err(ApiError::new(
                    "TUN_EXITED",
                    format!(
                        "TUN worker exited ({code}). Capture has ended; affected applications may use native networking. Restart to resume."
                    ),
                ));
            }
        }
        Ok(())
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        let _ = self.retire(crate::lifecycle::SharingExit::Suspend);
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn missing_private_adapter_keeps_recovery_available_and_retries_explicit_handback() {
        use super::*;
        let data =
            std::env::temp_dir().join(format!("wayrill-missing-private-{}", random_id().unwrap()));
        std::fs::create_dir_all(&data).unwrap();
        let guard = data.join("tun-sharing-barrier.json");
        crate::storage::write(
            &guard,
            &json!({
                "private":"11111111-1111-4111-8111-111111111111",
                "capture":"22222222-2222-4222-8222-222222222222",
                "release":null
            }),
        )
        .unwrap();
        let mut manager = Manager::new(&data, data.clone())
            .expect("Missing hardware must not prevent the service from opening its recovery API");
        assert_eq!(
            manager.status()["adapterRecoveryError"]["code"],
            "TUN_UPLINK_UNAVAILABLE"
        );
        assert_eq!(
            manager.preflight(&json!({}), None).unwrap_err().code,
            "TUN_UPLINK_UNAVAILABLE"
        );
        assert_eq!(sharing_guard::requested(&data).unwrap(), None);

        // A full/unwritable state volume can interrupt explicit Stop before it
        // records handback. Preserve that exact intent for the next retry.
        for sharing in [
            crate::lifecycle::SharingExit::Native,
            crate::lifecycle::SharingExit::Disable,
        ] {
            let temporary = guard.with_extension("tmp");
            std::fs::create_dir(&temporary).unwrap();
            assert!(manager.request_sharing_handback(sharing).is_err());
            std::fs::remove_dir(&temporary).unwrap();
            assert_eq!(
                manager.finish_retirement().unwrap_err().code,
                "TUN_UPLINK_UNAVAILABLE"
            );
            assert_eq!(sharing_guard::requested(&data).unwrap(), Some(sharing));
            assert_eq!(manager.retirement_pending, Some(sharing));
        }
        drop(manager);
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn native_loopback_selection_resolves_to_the_software_loopback_interface() {
        use super::*;
        let name = loopback_interface().unwrap();
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let mut row = MIB_IF_ROW2::default();
        // SAFETY: the name is NUL-terminated and row owns writable output storage.
        assert_eq!(
            unsafe { ConvertInterfaceAliasToLuid(name.as_ptr(), &mut row.InterfaceLuid) },
            0
        );
        // SAFETY: the resolved LUID identifies the row to retrieve.
        assert_eq!(unsafe { GetIfEntry2(&mut row) }, 0);
        assert_eq!(row.Type, IF_TYPE_SOFTWARE_LOOPBACK);
    }

    #[test]
    fn adapter_aliases_validate_before_native_mutation_and_keep_custom_unicode() {
        use super::*;
        assert_eq!(adapter_name(&json!({}), false).unwrap(), "Wayrill-TUN");
        assert_eq!(
            adapter_name(&json!({"name":""}), true).unwrap(),
            "Wayrill-ICS"
        );
        assert_eq!(
            adapter_name(&json!({"name":"Wayrill · ТВ 🌐"}), true).unwrap(),
            "Wayrill · ТВ 🌐"
        );
        assert!(adapter_name(&json!({"name":"🌐".repeat(50)}), true).is_ok());
        for name in [
            json!(42),
            json!(null),
            json!("   "),
            json!("bad/name"),
            json!("bad:name"),
            json!("🌐".repeat(51)),
        ] {
            let settings = json!({"name":name});
            assert!(adapter_name(&settings, true).is_err(), "{settings}");
            assert!(validate(
                &json!({"inbounds":[{"tag":"tun","protocol":"tun","settings":settings}]})
            )
            .is_err());
        }
    }
    #[test]
    fn warm_restart_requires_unchanged_adapter_settings() {
        assert_eq!(capture_route_metric(0), 0);
        assert_eq!(capture_route_metric(1), 10_000);
        assert_eq!(capture_route_metric(32), 10_000);

        let settings = json!({"name":"WayrillTUN", "gateway":["10.90.0.1/30"],
            "dns":["1.1.1.1"], "autoSystemRoutingTable":["0.0.0.0/1","128.0.0.0/1"],
            "autoOutboundsInterface":"auto"});
        assert!(reusable_settings(&settings, &settings));
        let mut level = settings.clone();
        level["userLevel"] = json!(2);
        assert!(reusable_settings(&settings, &level));
        for (field, value) in [
            ("gateway", json!(["10.91.0.1/30"])),
            ("dns", json!(["8.8.8.8"])),
            ("mtu", json!(1400)),
            ("autoSystemRoutingTable", json!(["0.0.0.0/0"])),
            ("autoSystemWfpBlockLeak", json!(["dns"])),
        ] {
            let mut changed = settings.clone();
            changed[field] = value;
            assert!(!reusable_settings(&settings, &changed), "{field}");
        }
        let mut wfp = settings.clone();
        wfp["autoSystemWfpBlockLeak"] = json!(["dns"]);
        assert!(!reusable_settings(&wfp, &wfp));
        assert!(!reusable_settings(&Value::Null, &Value::Null));
    }

    use super::*;
    #[test]
    fn shared_ipv6_preflight_rejects_missing_or_incomplete_host_before_native_checks() {
        assert_eq!(shared_ipv6_host(None).unwrap_err().code, "ICS_IPV6_TUN");
        for settings in [
            json!({}),
            json!({"gateway":["fd90::1/64"],"autoSystemRoutingTable":["::/1"]}),
            json!({"gateway":["fd90::1/64"],"autoSystemRoutingTable":["::/0"],"mtu":1200}),
        ] {
            assert_eq!(
                shared_ipv6_host(Some(&json!({"settings":settings})))
                    .unwrap_err()
                    .code,
                "ICS_IPV6_TUN"
            );
        }
        assert!(shared_ipv6_host(Some(&json!({"settings":{"gateway":["fd90::1/64"],"autoSystemRoutingTable":["::/0"],"mtu":1420}}))).is_ok());
    }
    #[test]
    fn accepts_instrumented_capture_relays_after_saved_plan_validation() {
        let config = json!({"inbounds":[{"tag":"captured","protocol":"socks","listen":"127.0.0.1","port":22080,"settings":{"auth":"noauth","udp":true}}],"outbounds":[{"tag":"direct","protocol":"freedom"}]});
        let plan: crate::capture::Plan = serde_json::from_value(json!({"version":2,"inputs":[{"tag":"captured","selectors":[],"ports":"","networks":["tcp","udp"],"predicates":[],"masks":["0"]}],"interfaces":{"monitorNewInterfaces":true,"interfaces":[]},"bypassLocalTraffic":true})).unwrap();
        crate::capture::validate(Some(&plan), &config).unwrap();
        let (runtime, _) = crate::capture::instrument(Some(&plan), &config).unwrap();
        assert_eq!(runtime["inbounds"][0]["settings"]["auth"], "password");
        assert!(prepare_with_applications(&runtime, Some(&plan), None)
            .unwrap()
            .is_none());
    }
    #[test]
    fn bootstrap_hosts_are_runtime_only_and_skip_non_tun_configs() {
        let mut config = json!({"inbounds":[{"protocol":"tun"}],"outbounds":[{"settings":{"address":"peer.example"}}],"dns":{"hosts":{"full:peer.example":"192.0.2.1"},"servers":["1.1.1.1"]}});
        let original = config.clone();
        assert_eq!(
            bootstrap_hosts(&config, None).unwrap(),
            Some(config["dns"]["hosts"].clone())
        );
        assert_eq!(config, original);
        config["inbounds"][0]["protocol"] = json!("socks");
        assert_eq!(bootstrap_hosts(&config, None).unwrap(), None);
    }
    #[test]
    fn cached_bootstrap_hosts_recover_without_resolving_through_dead_capture() {
        let config = json!({"inbounds":[{"protocol":"tun"}],"outbounds":[{"settings":{"address":"unresolvable.invalid"}}],"dns":{"servers":["1.1.1.1"]}});
        let original = config.clone();
        let cached = json!({"full:unresolvable.invalid":["192.0.2.2"]});
        assert_eq!(
            bootstrap_hosts(&config, Some(&cached)).unwrap(),
            Some(cached)
        );
        assert_eq!(config, original);
    }

    fn config() -> Value {
        json!({"inbounds":[{"tag":"tun","protocol":"tun","settings":{"gateway":["10.90.0.1/24"],"autoSystemRoutingTable":["0.0.0.0/1"]}}],"outbounds":[{"tag":"direct","protocol":"freedom"}],"routing":{"rules":[]}})
    }
    #[test]
    fn vpn_next_hop_is_a_distinct_usable_peer_in_the_owned_subnet() {
        for (gateway, expected) in [
            ("10.90.0.1/24", "10.90.0.2"),
            ("10.90.0.254/24", "10.90.0.253"),
            ("10.90.0.1/30", "10.90.0.2"),
            ("10.90.0.0/31", "10.90.0.1"),
            ("10.90.0.1/31", "10.90.0.0"),
        ] {
            let settings = json!({"gateway":["fd90::1/64",gateway]});
            let original = settings.clone();
            assert_eq!(
                ipv4_peer(&settings).unwrap(),
                Some(expected.parse().unwrap()),
                "{gateway}"
            );
            assert_eq!(settings, original);
        }
        assert_eq!(
            ipv4_peer(&json!({"gateway":["10.90.0.1/32"]})).unwrap(),
            None
        );
        assert_eq!(ipv4_peer(&json!({"gateway":["fd90::1/64"]})).unwrap(), None);
        assert!(ipv4_peer(&json!({"gateway":["invalid"]})).is_err());
    }
    #[test]
    fn automatic_uplink_ignores_split_capture_routes_and_weights_full_defaults() {
        let mut row = MIB_IPFORWARD_ROW2 {
            InterfaceIndex: 7,
            Metric: 20,
            ..Default::default()
        };
        row.DestinationPrefix.PrefixLength = 1;
        assert_eq!(default_route_key(&row, 0), None);
        row.DestinationPrefix.PrefixLength = 0;
        assert_eq!(default_route_key(&row, 5), Some((25, 7)));
        row.Metric = u32::MAX;
        assert_eq!(
            default_route_key(&row, u32::MAX),
            Some((2 * u64::from(u32::MAX), 7))
        );
    }
    #[test]
    fn rejects_invalid_native_prefixes_and_dns_before_start() {
        for (key, value) in [
            ("gateway", json!(["10.90.0.1/33"])),
            ("gateway", json!(["fd90::1/129"])),
            ("autoSystemRoutingTable", json!(["0.0.0.0"])),
            ("dns", json!(["https://dns.example/dns-query"])),
            ("autoOutboundsInterface", json!("Ethernet\0hidden")),
        ] {
            let mut c = config();
            c["inbounds"][0]["settings"][key] = value;
            assert!(validate(&c).is_err(), "{key}");
        }
        assert_eq!(
            prefix("10.90.0.1/24").unwrap(),
            ("10.90.0.0".parse().unwrap(), 24)
        );
        assert_eq!(
            prefix("fd90::1/64").unwrap(),
            ("fd90::".parse().unwrap(), 64)
        );
        assert_eq!(
            prefix("192.0.2.1/0").unwrap(),
            ("0.0.0.0".parse().unwrap(), 0)
        );
        assert_eq!(
            prefix("2001:db8::1/128").unwrap(),
            ("2001:db8::1".parse().unwrap(), 128)
        );
    }
    #[test]
    fn excludes_socket_branches_but_keeps_shared_and_resolver_rules_in_order() {
        let mut c = config();
        c["dns"] = json!({"tag":"dns-main", "servers":[{"address":"1.1.1.1","tag":"dns-remote"}]});
        c["routing"]["rules"] = json!([
            {"inboundTag":["proxy"],"outboundTag":"socket-only"},
            {"inboundTag":["dns-remote"],"outboundTag":"resolver"},
            {"inboundTag":["tun","proxy"],"outboundTag":"shared"},
            {"domain":["full:example.com"],"outboundTag":"global"},
            {"inboundTag":["dns-main"],"outboundTag":"resolver-main"}
        ]);
        let rules = worker_rules(&c, "tun");
        assert_eq!(
            rules
                .iter()
                .map(|rule| rule["outboundTag"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["resolver", "shared", "global", "resolver-main"]
        );
    }
    #[test]
    fn nat_scopes_are_copied_only_to_the_host_attribution_worker() {
        let c = json!({"routing":{"rules":[
            {"inboundTag":["wr-n"],"outboundTag":"guest"},
            {"inboundTag":["host"],"outboundTag":"host"},
            {"inboundTag":["shared"],"outboundTag":"shared"}
        ]}});
        assert_eq!(
            worker_rules_with_nat(&c, "host", &Value::Null, Some("wr-n")).len(),
            2
        );
        assert_eq!(
            worker_rules_for_dns(&c, "shared", &Value::Null),
            vec![json!({"inboundTag":["shared"],"outboundTag":"shared"})]
        );
    }
    #[test]
    fn empty_input_configs_do_not_panic_and_loopback_is_not_an_uplink() {
        assert!(prepare(&json!({})).unwrap().is_none());
        let luid = route_interface(IpAddr::V4(Ipv4Addr::LOCALHOST)).unwrap();
        assert!(usable_uplink(luid).is_err());
        assert!(
            routes_ready(0, &BTreeSet::from([prefix("203.0.113.0/24").unwrap()]))
                .is_ok_and(|ready| !ready)
        );
    }
    #[test]
    fn rejects_unmanaged_files_and_platform_noop() {
        let mut c = config();
        c["routing"]["rules"] =
            json!([{"domain":["ext:../../secret.dat:test"],"outboundTag":"direct"}]);
        assert!(validate(&c).is_err());
        c["routing"]["rules"] = json!([]);
        c["inbounds"][0]["settings"]["autoSystemDnsToGateway"] = json!(true);
        assert!(validate(&c).is_err());
    }
    #[test]
    fn accepts_shared_fakedns_and_rejects_tun_stream_transports() {
        let mut c = config();
        c["fakedns"] = json!({"ipPool":"198.18.0.0/24","poolSize":128});
        assert!(validate(&c).is_ok());
        c.as_object_mut().unwrap().remove("fakedns");
        c["inbounds"][0]["streamSettings"] = json!({});
        assert!(validate(&c).is_err());
    }
    #[test]
    fn rejects_loopback_reinjection_into_split_tun() {
        let mut c = config();
        c["outbounds"] =
            json!([{"tag":"loop","protocol":"loopback","settings":{"inboundTag":"tun"}}]);
        assert!(validate(&c).is_err());
        c["outbounds"][0]["settings"]["inboundTag"] = json!("socket-input");
        assert!(validate(&c).is_ok());
    }
    #[test]
    fn relay_and_worker_keep_configured_user_policy() {
        let mut c = config();
        c["inbounds"][0]["settings"]["userLevel"] = json!(7);
        c["policy"] = json!({"levels":{"7":{"connIdle":37,"bufferSize":32}}});
        let plan = prepare(&c).unwrap().unwrap();
        assert_eq!(plan.worker["policy"], c["policy"]);
        assert_eq!(plan.main["inbounds"][0]["settings"]["userLevel"], 7);
    }
    #[test]
    fn native_resolver_settings_live_in_worker_and_main_only_uses_local_bridge() {
        let mut c = config();
        c["dns"] = json!({"tag":"resolver","disableFallback":true,"servers":[{"address":"tcp+local://192.0.2.53:53","domains":["full:inside.example"]}]});
        let plan = prepare(&c).unwrap().unwrap();
        assert_eq!(plan.worker["dns"]["servers"], c["dns"]["servers"]);
        assert_eq!(plan.worker["dns"]["disableFallback"], true);
        assert!(plan.main["dns"]["servers"][0]
            .as_str()
            .unwrap()
            .starts_with("tcp+local://127.0.0.1:"));
        assert_eq!(plan.main["dns"]["disableFallback"], false);
        c["dns"]["servers"] = json!(["localhost"]);
        assert!(validate(&c).is_err());
    }
    #[test]
    fn ordinary_graph_is_unaffected() {
        assert!(validate(&json!({"inbounds":[{"protocol":"mixed"}],"routing":{"rules":[{"domain":["ext:c:/old.dat:x"]}]}})).is_ok());
    }
    #[test]
    fn private_relays_preserve_terminal_selection_without_elevating_remote_settings() {
        let mut c = config();
        c["outbounds"] = json!([{"tag":"direct","protocol":"freedom"},{"tag":"remote","protocol":"vless","settings":{"address":"192.0.2.1","port":443,"id":"secret-account"},"streamSettings":{"security":"tls","tlsSettings":{"certificates":[{"keyFile":"private.key"}]}}}]);
        c["routing"] = json!({"domainStrategy":"AsIs","balancers":[{"tag":"pool","selector":["remote"]}],"rules":[{"type":"field","inboundTag":["tun"],"process":["work.exe"],"sourceIP":["10.0.0.0/8"],"balancerTag":"pool"},{"type":"field","inboundTag":["tun"],"port":"53","outboundTag":"remote"}]});
        let original = c.clone();
        let plan = prepare(&c).unwrap().unwrap();
        assert_eq!(c, original);
        assert!(!plan.worker.to_string().contains("secret-account"));
        assert!(!plan.worker.to_string().contains("private.key"));
        assert!(plan.worker["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|o| o["protocol"] == "dns"
                || (o["protocol"] == "socks" && o["settings"]["address"] == "127.0.0.1")));
        // An uplink-bound wildcard UDP socket cannot reach the loopback relay.
        // Both its source and interface must stay on loopback for UDP ASSOCIATE.
        for relay in plan.worker["outbounds"].as_array().unwrap() {
            if relay["protocol"] == "socks" {
                assert_eq!(relay["sendThrough"], "127.0.0.1");
                assert_ne!(relay["streamSettings"]["sockopt"]["interface"], plan.uplink);
            }
        }
        assert_eq!(
            plan.worker["routing"]["rules"][1]["process"],
            json!(["work.exe"])
        );
        assert_eq!(
            plan.worker["routing"]["rules"][1]["sourceIP"],
            json!(["10.0.0.0/8"])
        );
        let rules = plan.main["routing"]["rules"].as_array().unwrap();
        assert!(rules.iter().any(|r| r["balancerTag"] == "pool"
            && r["user"].is_array()
            && r["inboundTag"] == json!(["tun"])));
        assert_eq!(
            plan.main["outbounds"][1]["settings"],
            c["outbounds"][1]["settings"]
        );
        assert_eq!(
            plan.main["outbounds"][1]["streamSettings"]["tlsSettings"],
            c["outbounds"][1]["streamSettings"]["tlsSettings"]
        );
    }
    #[test]
    fn reruns_get_new_private_credentials_and_do_not_reset_explicit_uplink_bindings() {
        let mut c = config();
        c["outbounds"][0]["streamSettings"] = json!({"sockopt":{"interface":"Explicit adapter"}});
        let a = prepare(&c).unwrap().unwrap();
        let b = prepare(&c).unwrap().unwrap();
        assert_ne!(
            a.main["inbounds"][0]["settings"]["accounts"],
            b.main["inbounds"][0]["settings"]["accounts"]
        );
        assert_eq!(
            a.main["outbounds"][0]["streamSettings"]["sockopt"]["interface"],
            "Explicit adapter"
        );
    }
}

#[cfg(test)]
mod shared_ipv6_tests {
    use super::*;
    #[test]
    fn projected_tags_are_unique_even_when_host_and_shared_match_the_same_rule() {
        let mut host = host();
        let mut shared = shared();
        host["routing"]["rules"][0]["ruleTag"] = json!("wrr-1-0");
        host["routing"]["rules"][1]["ruleTag"] = json!("wrr-1-0-ics6");
        shared["routing"]["rules"][0]["ruleTag"] = json!("wrr-1-0");
        let aliases =
            shared_ipv6_worker(&mut host, &shared, "22944640-3598-4b5d-aa13-06ea38f26fb0").unwrap();
        let tags = host["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["ruleTag"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(tags.len(), tags.iter().collect::<BTreeSet<_>>().len());
        assert_eq!(aliases, vec![("wrr-1-0-ics6-1".into(), "wrr-1-0".into())]);
        assert_eq!(
            host["routing"]["rules"][0]["sourceIP"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(host["routing"]["rules"][2]["ruleTag"], "wrr-1-0");
    }
    fn host() -> Value {
        json!({"inbounds":[{"tag":"host","protocol":"tun","settings":{"gateway":["fd90::1/64"],"autoSystemRoutingTable":["::/1","8000::/1"],"mtu":1420}}],"outbounds":[{"tag":"wtr-0","protocol":"socks","settings":{"user":"host-account"}}],"routing":{"rules":[{"inboundTag":["host"],"user":["host-mask"],"outboundTag":"wtr-0"},{"inboundTag":["dns"],"outboundTag":"wtr-0"}]}})
    }
    fn shared() -> Value {
        json!({"inbounds":[{"tag":"shared","protocol":"tun"}],"outbounds":[{"tag":"wtr-0","protocol":"socks","settings":{"user":"shared-account"}}],"routing":{"rules":[{"inboundTag":["shared"],"domain":["domain:media.example"],"outboundTag":"wtr-0"},{"inboundTag":["dns"],"outboundTag":"wtr-0"}]}})
    }
    #[test]
    fn isolates_shared_ipv6_before_host_rules_without_changing_relay_accounts_or_dns_scope() {
        let mut host = host();
        let original = host["routing"]["rules"].clone();
        shared_ipv6_worker(&mut host, &shared(), "22944640-3598-4b5d-aa13-06ea38f26fb0").unwrap();
        let rules = host["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 4);
        assert_eq!(rules[0]["user"], json!(["wr-ics6"]));
        assert_eq!(rules[0]["inboundTag"], json!(["host"]));
        assert_eq!(rules[0]["sourceIP"].as_array().unwrap().len(), 1);
        assert_eq!(rules[0]["domain"], json!(["domain:media.example"]));
        assert_eq!(rules[0]["outboundTag"], "wi6-A");
        assert_eq!(json!(&rules[2..]), original);
        assert_eq!(host["outbounds"][0]["settings"]["user"], "host-account");
        assert_eq!(host["outbounds"][1]["settings"]["user"], "shared-account");
    }
    #[test]
    fn requires_complete_ipv6_capture_gateway_and_ipv6_mtu() {
        let mut h = host();
        assert!(client_ipv6_settings(&h["inbounds"][0]["settings"]).unwrap());
        h["inbounds"][0]["settings"]["autoSystemRoutingTable"] = json!(["2001:db8::/32"]);
        assert!(!client_ipv6_settings(&h["inbounds"][0]["settings"]).unwrap());
        h["inbounds"][0]["settings"]["autoSystemRoutingTable"] = json!(["::/0"]);
        assert!(client_ipv6_settings(&h["inbounds"][0]["settings"]).unwrap());
        h["inbounds"][0]["settings"]["mtu"] = json!(1000);
        assert!(!client_ipv6_settings(&h["inbounds"][0]["settings"]).unwrap());
        h["inbounds"][0]["settings"]["mtu"] = json!(0);
        assert!(client_ipv6_settings(&h["inbounds"][0]["settings"]).unwrap());
        h["inbounds"][0]["settings"]["mtu"] = json!(100000);
        assert!(!client_ipv6_settings(&h["inbounds"][0]["settings"]).unwrap());
        h["inbounds"][0]["settings"]["mtu"] = json!(1500);
        h["inbounds"][0]["settings"]["gateway"] = json!(["fe80::1/64"]);
        assert!(!client_ipv6_settings(&h["inbounds"][0]["settings"]).unwrap());
    }
}
