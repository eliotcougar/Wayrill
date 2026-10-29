//! Fixed WFP provider: bounded per-application blocks, never arbitrary policy.
use super::Target;
use crate::native::wide;
use std::{
    ffi::c_void,
    fs::OpenOptions,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    ptr::{null, null_mut},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, HANDLE},
        NetworkManagement::WindowsFilteringPlatform::*,
        Security::{FreeSid, Isolation::DeriveAppContainerSidFromAppContainerName},
        Storage::FileSystem::{
            GetFinalPathNameByHandleW, FILE_FLAG_BACKUP_SEMANTICS, FILE_NAME_OPENED, VOLUME_NAME_NT,
        },
    },
};

const PROVIDER: GUID = GUID::from_u128(0x50d25c4c_a848_4a18_bfbc_13ea685901e7);
const SUBLAYER: GUID = GUID::from_u128(0xb44e7754_7361_4731_b6bd_408cd18bcd01);
const LAYERS: [GUID; 4] = [
    FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
];
const ALREADY_EXISTS: u32 = 0x80320009;
const PROVIDER_NOT_FOUND: u32 = 0x80320005;

fn check(code: u32) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        let mut error = ApiError::new("APP_PROTECTION", format!("Windows app protection failed (0x{code:08X}). Selected applications remain protected if a previous barrier is installed."));
        error.retryable = true;
        Err(error)
    }
}
struct Engine(HANDLE);
impl Engine {
    fn open() -> Result<Self> {
        let mut handle = null_mut();
        // SAFETY: local authenticated management session and initialized output.
        unsafe {
            check(FwpmEngineOpen0(null(), 10, null(), null(), &mut handle))?;
        }
        Ok(Self(handle))
    }
    fn transaction(&self, apply: impl FnOnce() -> Result<()>) -> Result<()> {
        // SAFETY: live session, one synchronous transaction. Failure always aborts.
        unsafe {
            check(FwpmTransactionBegin0(self.0, 0))?;
        }
        let result = apply().and_then(|()| unsafe { check(FwpmTransactionCommit0(self.0)) });
        if result.is_err() {
            unsafe {
                FwpmTransactionAbort0(self.0);
            }
        }
        result
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}
struct Memory(*mut c_void);
impl Drop for Memory {
    fn drop(&mut self) {
        unsafe {
            FwpmFreeMemory0(&mut self.0);
        }
    }
}
enum Identity {
    Executable(Memory),
    MissingExecutable {
        _path: Vec<u16>,
        blob: FWP_BYTE_BLOB,
    },
    Package(*mut c_void),
}
impl Identity {
    fn new(target: &Target) -> Result<Self> {
        match target {
            Target::Executable { value } => {
                let mut blob = null_mut();
                // SAFETY: terminated input; Windows allocates the returned blob.
                let code = unsafe { FwpmGetAppIdFromFileName0(wide(value).as_ptr(), &mut blob) };
                if matches!(code, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
                    // Updaters remove old executables/version directories. Keep
                    // protecting the exact selected path without requiring it to
                    // exist, rather than dropping the target or the whole barrier.
                    let mut path = missing_executable_id(Path::new(value))?;
                    let blob = FWP_BYTE_BLOB {
                        size: (path.len() * 2) as u32,
                        data: path.as_mut_ptr().cast(),
                    };
                    return Ok(Self::MissingExecutable { _path: path, blob });
                }
                check(code).map_err(|mut error| {
                    error.message = format!(
                        "Cannot identify protected application '{value}': {}",
                        error.message
                    );
                    error
                })?;
                Ok(Self::Executable(Memory(blob.cast())))
            }
            Target::Package { value } => {
                let mut sid = null_mut();
                // SAFETY: bounded package-family input and owned SID output.
                let code = unsafe {
                    DeriveAppContainerSidFromAppContainerName(wide(value).as_ptr(), &mut sid)
                };
                if code < 0 {
                    check(code as u32)?;
                }
                Ok(Self::Package(sid))
            }
        }
    }
    fn condition(&self) -> FWPM_FILTER_CONDITION0 {
        let mut condition = FWPM_FILTER_CONDITION0 {
            matchType: FWP_MATCH_EQUAL,
            ..Default::default()
        };
        match self {
            Self::Executable(blob) => {
                condition.fieldKey = FWPM_CONDITION_ALE_APP_ID;
                condition.conditionValue.r#type = FWP_BYTE_BLOB_TYPE;
                condition.conditionValue.Anonymous.byteBlob = blob.0.cast();
            }
            Self::MissingExecutable { blob, .. } => {
                condition.fieldKey = FWPM_CONDITION_ALE_APP_ID;
                condition.conditionValue.r#type = FWP_BYTE_BLOB_TYPE;
                condition.conditionValue.Anonymous.byteBlob = std::ptr::from_ref(blob).cast_mut();
            }
            Self::Package(sid) => {
                condition.fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
                condition.conditionValue.r#type = FWP_SID;
                condition.conditionValue.Anonymous.sid = (*sid).cast();
            }
        }
        condition
    }
}

fn missing_executable_id(path: &Path) -> Result<Vec<u16>> {
    // Resolve the nearest existing ancestor through Windows, including junctions
    // and volume mount points. Never guess a drive's NT device name or hide an
    // access/volume error as an absent application.
    let mut ancestor = path;
    let directory = loop {
        match OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(ancestor)
        {
            Ok(directory) => break directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| ApiError::io("Resolve protected application's volume", error))?;
            }
            Err(error) => return Err(ApiError::io("Resolve protected application's path", error)),
        }
    };
    let mut native = vec![0; 32768];
    // SAFETY: owned live directory handle and initialized WCHAR output buffer.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            directory.as_raw_handle(),
            native.as_mut_ptr(),
            native.len() as u32,
            // WFP preserves the opened spelling, including 8.3 aliases. Expanding
            // an ancestor's short name would change the ID after the file is removed.
            VOLUME_NAME_NT | FILE_NAME_OPENED,
        )
    } as usize;
    if length == 0 {
        return Err(ApiError::io(
            "Resolve protected application's device path",
            std::io::Error::last_os_error(),
        ));
    }
    if length >= native.len() {
        return Err(ApiError::new(
            "APP_PROTECTION",
            "Protected application's device path is too long.",
        ));
    }
    native.truncate(length);
    let suffix = path
        .strip_prefix(ancestor)
        .map_err(|_| ApiError::new("APP_PROTECTION", "Invalid protected application's path."))?;
    if !suffix.as_os_str().is_empty() {
        if native.last() != Some(&(b'\\' as u16)) {
            native.push(b'\\' as u16);
        }
        use std::os::windows::ffi::OsStrExt;
        native.extend(suffix.as_os_str().encode_wide());
    }
    native.push(0);
    // FwpmGetAppIdFromFileName lowercases ASCII, preserving non-ASCII WCHARs.
    // Unicode/locale lowercasing would produce a different application ID.
    for unit in &mut native {
        if (b'A' as u16..=b'Z' as u16).contains(unit) {
            *unit += 32;
        }
    }
    Ok(native)
}
impl Drop for Identity {
    fn drop(&mut self) {
        if let Self::Package(sid) = self {
            unsafe {
                FreeSid(*sid);
            }
        }
    }
}
pub(super) fn validate(targets: &[Target]) -> Result<()> {
    for target in targets {
        Identity::new(target)?;
    }
    Ok(())
}
fn equal(a: GUID, b: GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

fn owned_filters(engine: &Engine) -> Result<Vec<u64>> {
    let mut ids = Vec::new();
    for layer in LAYERS {
        ids.extend(layer_filters(engine, layer)?);
    }
    Ok(ids)
}
fn layer_filters(engine: &Engine, layer: GUID) -> Result<Vec<u64>> {
    let mut provider = PROVIDER;
    let template = FWPM_FILTER_ENUM_TEMPLATE0 {
        providerKey: &mut provider,
        layerKey: layer,
        actionMask: u32::MAX,
        flags: FWP_FILTER_ENUM_FLAG_INCLUDE_DISABLED,
        ..Default::default()
    };
    let mut enumeration = null_mut();
    // SAFETY: live engine, synchronous template and initialized output.
    let code = unsafe { FwpmFilterCreateEnumHandle0(engine.0, &template, &mut enumeration) };
    if code == PROVIDER_NOT_FOUND {
        return Ok(Vec::new());
    }
    check(code)?;
    let result = (|| {
        let mut ids = Vec::new();
        loop {
            let mut entries = null_mut();
            let mut count = 0;
            unsafe {
                check(FwpmFilterEnum0(
                    engine.0,
                    enumeration,
                    256,
                    &mut entries,
                    &mut count,
                ))?;
            }
            let memory = Memory(entries.cast());
            if count == 0 {
                break;
            }
            // SAFETY: WFP owns `count` initialized filter pointers until memory drops.
            for entry in unsafe { std::slice::from_raw_parts(entries, count as usize) } {
                let filter = unsafe { &**entry };
                if filter.providerKey.is_null()
                    || !equal(unsafe { *filter.providerKey }, PROVIDER)
                    || !equal(filter.subLayerKey, SUBLAYER)
                    || filter.action.r#type != FWP_ACTION_BLOCK
                    || !LAYERS.iter().any(|layer| equal(*layer, filter.layerKey))
                {
                    return Err(ApiError::new("APP_PROTECTION_CONFLICT", "Wayrill's app-protection provider was modified. Its filters were preserved."));
                }
                ids.push(filter.filterId);
            }
            drop(memory);
            if ids.len() > 4096 {
                return Err(ApiError::new(
                    "APP_PROTECTION_CONFLICT",
                    "Unexpected app-protection filter count.",
                ));
            }
        }
        Ok(ids)
    })();
    unsafe {
        FwpmFilterDestroyEnumHandle0(engine.0, enumeration);
    }
    result
}
fn objects(engine: &Engine) -> Result<()> {
    let mut name = wide("Wayrill app protection");
    let provider = FWPM_PROVIDER0 {
        providerKey: PROVIDER,
        flags: FWPM_PROVIDER_FLAG_PERSISTENT,
        displayData: FWPM_DISPLAY_DATA0 {
            name: name.as_mut_ptr(),
            ..Default::default()
        },
        ..Default::default()
    };
    let code = unsafe { FwpmProviderAdd0(engine.0, &provider, null_mut()) };
    if code != ALREADY_EXISTS {
        check(code)?;
    }
    let mut provider_key = PROVIDER;
    let layer = FWPM_SUBLAYER0 {
        subLayerKey: SUBLAYER,
        flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
        providerKey: &mut provider_key,
        weight: 0x7ffe,
        displayData: FWPM_DISPLAY_DATA0 {
            name: name.as_mut_ptr(),
            ..Default::default()
        },
        ..Default::default()
    };
    let code = unsafe { FwpmSubLayerAdd0(engine.0, &layer, null_mut()) };
    if code != ALREADY_EXISTS {
        check(code)?;
    }
    Ok(())
}
pub(super) fn replace(targets: &[Target]) -> Result<()> {
    #[cfg(test)]
    if std::env::var("WAYRILL_APP_PROTECTION_VM_TEST").as_deref() != Ok("authorized-guest") {
        return Err(ApiError::new(
            "VM_TEST_REQUIRED",
            "Native app-protection mutation requires the isolated guest opt-in.",
        ));
    }
    // Prepare every identity before touching existing rules. Invalid/missing
    // identities never remove a previously working barrier.
    let identities = targets
        .iter()
        .map(Identity::new)
        .collect::<Result<Vec<_>>>()?;
    let engine = Engine::open()?;
    engine.transaction(|| {
        let existing = owned_filters(&engine)?;
        if identities.is_empty() && existing.is_empty() {
            return Ok(());
        }
        if !identities.is_empty() {
            objects(&engine)?;
        }
        for id in existing {
            unsafe {
                check(FwpmFilterDeleteById0(engine.0, id))?;
            }
        }
        for identity in &identities {
            let mut non_loopback = FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_FLAGS,
                matchType: FWP_MATCH_FLAGS_NONE_SET,
                ..Default::default()
            };
            non_loopback.conditionValue.r#type = FWP_UINT32;
            non_loopback.conditionValue.Anonymous.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
            let mut conditions = [identity.condition(), non_loopback];
            let mut name = wide("Wayrill: routing restart in progress");
            let mut provider = PROVIDER;
            for layer in LAYERS {
                let mut filter = FWPM_FILTER0 {
                    flags: FWPM_FILTER_FLAG_PERSISTENT,
                    providerKey: &mut provider,
                    layerKey: layer,
                    subLayerKey: SUBLAYER,
                    numFilterConditions: conditions.len() as u32,
                    filterCondition: conditions.as_mut_ptr(),
                    displayData: FWPM_DISPLAY_DATA0 {
                        name: name.as_mut_ptr(),
                        ..Default::default()
                    },
                    ..Default::default()
                };
                filter.action.r#type = FWP_ACTION_BLOCK;
                filter.weight.r#type = FWP_UINT8;
                filter.weight.Anonymous.uint8 = 15;
                // SAFETY: every referenced identity/buffer outlives this
                // synchronous call; Windows copies policy into its own store.
                unsafe {
                    check(FwpmFilterAdd0(engine.0, &filter, null_mut(), null_mut()))?;
                }
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_id(identity: &Identity) -> Vec<u16> {
        let condition = identity.condition();
        // SAFETY: the identity owns the blob and its UTF-16 bytes throughout.
        unsafe {
            let blob = &*condition.conditionValue.Anonymous.byteBlob;
            std::slice::from_raw_parts(blob.data.cast::<u16>(), blob.size as usize / 2).to_vec()
        }
    }

    #[test]
    fn device_path_normalization_matches_windows_application_ids() {
        let executable = std::env::current_exe().unwrap();
        let target = Target::Executable {
            value: executable.to_string_lossy().into_owned(),
        };
        assert_eq!(
            missing_executable_id(&executable).unwrap(),
            app_id(&Identity::new(&target).unwrap())
        );
    }

    #[test]
    fn removed_executable_and_version_folder_keep_the_same_identity() {
        let root = std::env::temp_dir().join(format!("wayrill-app-id-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut short = vec![0; 32768];
        // SAFETY: terminated existing path and an initialized WCHAR output buffer.
        let length = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
                wide(root.to_str().unwrap()).as_ptr(),
                short.as_mut_ptr(),
                short.len() as u32,
            )
        } as usize;
        assert!(length > 0 && length < short.len());
        use std::os::windows::ffi::OsStringExt;
        let root = std::path::PathBuf::from(std::ffi::OsString::from_wide(&short[..length]));
        let directory = root.join("VÉRSION-中文");
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("BROWSER.exe");
        std::fs::write(&executable, b"identity fixture").unwrap();
        let target = Target::Executable {
            value: executable.to_string_lossy().into_owned(),
        };
        let before = app_id(&Identity::new(&target).unwrap());
        std::fs::remove_file(&executable).unwrap();
        assert_eq!(app_id(&Identity::new(&target).unwrap()), before);
        std::fs::remove_dir(&directory).unwrap();
        assert_eq!(app_id(&Identity::new(&target).unwrap()), before);
        std::fs::write(&executable, b"cannot exist").unwrap_err();
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(&executable, b"replacement").unwrap();
        assert_eq!(app_id(&Identity::new(&target).unwrap()), before);
        std::fs::remove_dir_all(root).unwrap();
    }
}
