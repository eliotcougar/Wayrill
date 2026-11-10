//! A process-local view of the default Windows timezone configuration.
//! The zone catalogue, explicit zone lookups and all writes remain native.
use super::*;
use std::cell::Cell;
use windows_sys::Win32::{Globalization::*, System::Registry::*};

const PATH: &str = "system\\currentcontrolset\\control\\timezoneinformation";
static CURRENT: OnceLock<String> = OnceLock::new();
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryKey(
        key: HKEY,
        information: u32,
        data: *mut c_void,
        length: u32,
        written: *mut u32,
    ) -> i32;
}
thread_local! { static READING: Cell<bool> = const { Cell::new(false) }; }
struct Reading;
impl Drop for Reading {
    fn drop(&mut self) {
        READING.set(false);
    }
}

unsafe fn string_w(value: *const u16) -> Option<String> {
    if value.is_null() {
        return Some(String::new());
    }
    let length = (0..512).find(|i| unsafe { *value.add(*i) } == 0)?;
    Some(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(value, length)
    }))
}
unsafe fn string_a(value: *const u8) -> Option<String> {
    if value.is_null() {
        return Some(String::new());
    }
    let length = (0..512).find(|i| unsafe { *value.add(*i) } == 0)?;
    if length == 0 {
        return Some(String::new());
    }
    let mut text = [0; 512];
    let length = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            value,
            length as i32,
            text.as_mut_ptr(),
            text.len() as i32,
        )
    };
    (length > 0).then(|| String::from_utf16_lossy(&text[..length as usize]))
}
fn native_name(key: HKEY) -> Option<String> {
    if (key as isize) < 0 {
        return None;
    }
    let mut data = [0usize; 512];
    let mut written = 0;
    // KeyNameInformation also resolves handles opened before interception.
    // Querying rather than caching prevents a closed/reused HKEY being mistaken
    // for the timezone key, even when an app closes it through another API.
    if unsafe {
        NtQueryKey(
            key,
            3,
            data.as_mut_ptr().cast(),
            mem::size_of_val(&data) as u32,
            &mut written,
        )
    } < 0
        || written < 4
    {
        return None;
    }
    let length = unsafe { data.as_ptr().cast::<u32>().read() } as usize;
    if !length.is_multiple_of(2) || length + 4 > mem::size_of_val(&data) {
        return None;
    }
    Some(
        String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(data.as_ptr().cast::<u8>().add(4).cast::<u16>(), length / 2)
        })
        .to_ascii_lowercase(),
    )
}
fn initialize_path() {
    if CURRENT.get().is_some() {
        return;
    }
    let mut key = ptr::null_mut();
    if unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(PATH).as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut key,
        )
    } == ERROR_SUCCESS
    {
        let name = native_name(key);
        unsafe {
            RegCloseKey(key);
        }
        if let Some(prefix) = name.and_then(|n| {
            n.strip_suffix("\\control\\timezoneinformation")
                .map(str::to_owned)
        }) {
            let _ = CURRENT.set(
                prefix
                    .trim_start_matches("\\registry\\machine\\")
                    .to_owned(),
            );
        }
    }
}
fn path(root: HKEY, subkey: &str) -> Option<String> {
    let prefix = if root == HKEY_LOCAL_MACHINE {
        String::new()
    } else {
        native_name(root)?
            .strip_prefix("\\registry\\machine\\")?
            .to_owned()
    };
    let subkey = subkey.trim_matches('\\').to_ascii_lowercase();
    let result = if prefix.is_empty() {
        subkey
    } else if subkey.is_empty() {
        prefix
    } else {
        format!("{prefix}\\{subkey}")
    };
    let result = if let Some(tail) = CURRENT
        .get()
        .and_then(|p| result.strip_prefix(p))
        .filter(|tail| tail.is_empty() || tail.starts_with('\\'))
    {
        format!("system\\currentcontrolset{tail}")
    } else {
        result
    };
    (result == PATH).then_some(result)
}
fn systemtime(value: SYSTEMTIME) -> Vec<u8> {
    zone::systemtime_bytes(value).to_vec()
}
fn reg_string(value: &[u16]) -> Vec<u8> {
    value
        .iter()
        .copied()
        .take_while(|v| *v != 0)
        .chain(Some(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}
fn value(
    root: HKEY,
    subkey: Option<String>,
    name: Option<String>,
    ansi: bool,
) -> Option<(u32, Vec<u8>)> {
    let name = name?.to_ascii_lowercase();
    if READING.get()
        || !matches!(
            name.as_str(),
            "timezonekeyname"
                | "standardname"
                | "daylightname"
                | "standardstart"
                | "daylightstart"
                | "bias"
                | "standardbias"
                | "daylightbias"
                | "dynamicdaylighttimedisabled"
                | "activetimebias"
        )
    {
        return None;
    }
    let zone = selected()?;
    if path(root, &subkey?)? != PATH {
        return None;
    }
    READING.set(true);
    let _reading = Reading;
    let (kind, mut bytes) = match name.as_str() {
        "timezonekeyname" => (REG_SZ, reg_string(&zone.TimeZoneKeyName)),
        "standardname" => (REG_SZ, reg_string(&zone.StandardName)),
        "daylightname" => (REG_SZ, reg_string(&zone.DaylightName)),
        "standardstart" => (REG_BINARY, systemtime(zone.StandardDate)),
        "daylightstart" => (REG_BINARY, systemtime(zone.DaylightDate)),
        _ => {
            let number = match name.as_str() {
                "bias" => zone.Bias,
                "standardbias" => zone.StandardBias,
                "daylightbias" => zone.DaylightBias,
                "dynamicdaylighttimedisabled" => zone.DynamicDaylightTimeDisabled as i32,
                "activetimebias" => {
                    zone.Bias
                        + if classify(zone) == TIME_ZONE_ID_DAYLIGHT {
                            zone.DaylightBias
                        } else {
                            zone.StandardBias
                        }
                }
                _ => return None,
            };
            (REG_DWORD, number.to_le_bytes().to_vec())
        }
    };
    if ansi && kind == REG_SZ {
        let text: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|v| u16::from_le_bytes(*v))
            .collect();
        let length = unsafe {
            WideCharToMultiByte(
                CP_ACP,
                0,
                text.as_ptr(),
                text.len() as i32,
                ptr::null_mut(),
                0,
                ptr::null(),
                ptr::null_mut(),
            )
        };
        if length <= 0 {
            return None;
        }
        bytes = vec![0; length as usize];
        if unsafe {
            WideCharToMultiByte(
                CP_ACP,
                0,
                text.as_ptr(),
                text.len() as i32,
                bytes.as_mut_ptr(),
                length,
                ptr::null(),
                ptr::null_mut(),
            )
        } != length
        {
            return None;
        }
    }
    Some((kind, bytes))
}
unsafe fn emit(
    value: (u32, Vec<u8>),
    flags: u32,
    kind: *mut u32,
    data: *mut u8,
    size: *mut u32,
) -> u32 {
    // For a size-only query Windows treats size as output-only; callers need
    // not initialize it. Read capacity only when a data buffer was supplied.
    let capacity = if data.is_null() || size.is_null() {
        0
    } else {
        unsafe { size.read() }
    };
    if !kind.is_null() {
        unsafe {
            kind.write(value.0);
        }
    }
    let allowed = flags & RRF_RT_ANY;
    let type_flag = match value.0 {
        REG_SZ => RRF_RT_REG_SZ,
        REG_BINARY => RRF_RT_REG_BINARY,
        REG_DWORD => RRF_RT_REG_DWORD,
        _ => 0,
    };
    let code = if allowed != 0 && allowed & type_flag == 0 {
        ERROR_UNSUPPORTED_TYPE
    } else if !data.is_null() && size.is_null() {
        ERROR_INVALID_PARAMETER
    } else {
        if !size.is_null() {
            unsafe {
                size.write(value.1.len() as u32);
            }
        }
        if data.is_null() {
            ERROR_SUCCESS
        } else if capacity < value.1.len() as u32 {
            ERROR_MORE_DATA
        } else {
            unsafe {
                ptr::copy_nonoverlapping(value.1.as_ptr(), data, value.1.len());
            }
            ERROR_SUCCESS
        }
    };
    if code != ERROR_SUCCESS && flags & RRF_ZEROONFAILURE != 0 && !data.is_null() {
        unsafe {
            ptr::write_bytes(data, 0, capacity as usize);
        }
    }
    code
}

macro_rules! pair {
    ($slot:ident,$first:ident,$second:ident,($($arg:ident:$ty:ty),*),$body:ident,$decode:ident) => {
        static mut $slot: [*mut c_void;2] = [ptr::null_mut();2];
        unsafe extern "system" fn $first($($arg:$ty),*) -> u32 { unsafe { $body($($arg),*,$slot[0],$decode) } }
        unsafe extern "system" fn $second($($arg:$ty),*) -> u32 { unsafe { $body($($arg),*,$slot[1],$decode) } }
    };
}
pair!(QUERY_W,query_w,query_w_base,(root:HKEY,name:*const u16,reserved:*const u32,kind:*mut u32,data:*mut u8,size:*mut u32),query_wide,string_w);
pair!(QUERY_A,query_a,query_a_base,(root:HKEY,name:*const u8,reserved:*const u32,kind:*mut u32,data:*mut u8,size:*mut u32),query_ansi,string_a);
pair!(GET_W,get_w,get_w_base,(root:HKEY,key:*const u16,name:*const u16,flags:u32,kind:*mut u32,data:*mut c_void,size:*mut u32),get_wide,string_w);
pair!(GET_A,get_a,get_a_base,(root:HKEY,key:*const u8,name:*const u8,flags:u32,kind:*mut u32,data:*mut c_void,size:*mut u32),get_ansi,string_a);
macro_rules! query_body {
    ($func:ident,$ansi:literal) => {
        #[expect(
            clippy::too_many_arguments,
            reason = "Forward the native registry signature and trampoline unchanged"
        )]
        unsafe fn $func<T>(
            root: HKEY,
            name: *const T,
            reserved: *const u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
            original: *mut c_void,
            decode: unsafe fn(*const T) -> Option<String>,
        ) -> u32 {
            if let Some(value) = value(root, Some(String::new()), unsafe { decode(name) }, $ansi) {
                return unsafe { emit(value, 0, kind, data, size) };
            }
            unsafe {
                mem::transmute::<
                    *mut c_void,
                    unsafe extern "system" fn(
                        HKEY,
                        *const T,
                        *const u32,
                        *mut u32,
                        *mut u8,
                        *mut u32,
                    ) -> u32,
                >(original)(root, name, reserved, kind, data, size)
            }
        }
    };
}
query_body!(query_wide, false);
query_body!(query_ansi, true);
macro_rules! get_body {
    ($func:ident,$ansi:literal) => {
        #[expect(
            clippy::too_many_arguments,
            reason = "Forward the native registry signature and trampoline unchanged"
        )]
        unsafe fn $func<T>(
            root: HKEY,
            key: *const T,
            name: *const T,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            size: *mut u32,
            original: *mut c_void,
            decode: unsafe fn(*const T) -> Option<String>,
        ) -> u32 {
            if let Some(value) = value(root, unsafe { decode(key) }, unsafe { decode(name) }, $ansi)
            {
                return unsafe { emit(value, flags, kind, data.cast(), size) };
            }
            unsafe {
                mem::transmute::<
                    *mut c_void,
                    unsafe extern "system" fn(
                        HKEY,
                        *const T,
                        *const T,
                        u32,
                        *mut u32,
                        *mut c_void,
                        *mut u32,
                    ) -> u32,
                >(original)(root, key, name, flags, kind, data, size)
            }
        }
    };
}
get_body!(get_wide, false);
get_body!(get_ansi, true);

/// # Safety
/// Prepared once before suspending threads, alongside the other hook families.
pub unsafe fn prepare() -> Result<Vec<Attachment>, u32> {
    initialize_path();
    let mut hooks = Vec::new();
    unsafe {
        for (slot, name, first, second) in [
            (
                &raw mut QUERY_W,
                c"RegQueryValueExW",
                query_w as *mut c_void,
                query_w_base as *mut c_void,
            ),
            (
                &raw mut QUERY_A,
                c"RegQueryValueExA",
                query_a as *mut c_void,
                query_a_base as *mut c_void,
            ),
            (
                &raw mut GET_W,
                c"RegGetValueW",
                get_w as *mut c_void,
                get_w_base as *mut c_void,
            ),
            (
                &raw mut GET_A,
                c"RegGetValueA",
                get_a as *mut c_void,
                get_a_base as *mut c_void,
            ),
        ] {
            hooks.extend(prepare_pair(slot, "advapi32.dll", name, first, second)?);
        }
    }
    Ok(hooks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_key_identity_handles_existing_handles_and_does_not_alias_other_keys() {
        initialize_path();
        let mut key = ptr::null_mut();
        unsafe {
            assert_eq!(
                RegOpenKeyExW(
                    HKEY_LOCAL_MACHINE,
                    wide(PATH).as_ptr(),
                    0,
                    KEY_QUERY_VALUE,
                    &mut key
                ),
                ERROR_SUCCESS
            );
            assert_eq!(path(key, ""), Some(PATH.into()));
            assert_eq!(path(HKEY_LOCAL_MACHINE, PATH), Some(PATH.into()));
            assert!(path(key, "unrelated").is_none());
            RegCloseKey(key);
            assert_eq!(
                RegOpenKeyExW(
                    HKEY_LOCAL_MACHINE,
                    wide("SOFTWARE").as_ptr(),
                    0,
                    KEY_QUERY_VALUE,
                    &mut key
                ),
                ERROR_SUCCESS
            );
            assert!(path(key, "").is_none());
            RegCloseKey(key);
        }
    }
    #[test]
    fn buffer_contract_supports_size_queries_type_checks_and_zero_on_failure() {
        let bytes = reg_string(&[b'T' as u16, b'Z' as u16, 0]);
        let mut required = mem::MaybeUninit::uninit();
        let mut kind = 0;
        unsafe {
            assert_eq!(
                emit(
                    (REG_SZ, bytes.clone()),
                    RRF_RT_REG_SZ,
                    &mut kind,
                    ptr::null_mut(),
                    required.as_mut_ptr()
                ),
                ERROR_SUCCESS
            );
        }
        let mut size = unsafe { required.assume_init() };
        assert_eq!((size, kind), (6, REG_SZ));
        let mut out = [0x55; 8];
        size = 2;
        unsafe {
            assert_eq!(
                emit(
                    (REG_SZ, bytes.clone()),
                    0,
                    &mut kind,
                    out.as_mut_ptr(),
                    &mut size
                ),
                ERROR_MORE_DATA
            );
        }
        assert_eq!(out, [0x55; 8]);
        assert_eq!(size, 6);
        size = out.len() as u32;
        unsafe {
            assert_eq!(
                emit(
                    (REG_SZ, bytes.clone()),
                    RRF_RT_REG_DWORD | RRF_ZEROONFAILURE,
                    &mut kind,
                    out.as_mut_ptr(),
                    &mut size
                ),
                ERROR_UNSUPPORTED_TYPE
            );
        }
        assert_eq!(out, [0; 8]);
        size = 8;
        unsafe {
            assert_eq!(
                emit(
                    (REG_SZ, bytes),
                    RRF_RT_REG_SZ,
                    &mut kind,
                    out.as_mut_ptr(),
                    &mut size
                ),
                ERROR_SUCCESS
            );
        }
        assert_eq!(&out[..6], b"T\0Z\0\0\0");
    }
}
