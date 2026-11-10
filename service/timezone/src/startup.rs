//! Application Verifier startup provider for applications that cache the zone
//! before a runtime override can reach their sandboxed content processes.
use super::*;
use windows_sys::Win32::System::Environment::SetEnvironmentVariableW;
use windows_sys::Win32::System::Registry::*;

#[repr(C)]
struct VerifierDll {
    name: *const u16,
    flags: u32,
    address: *mut c_void,
    thunks: *mut c_void,
}
#[repr(C)]
struct Provider {
    size: u32,
    dlls: *mut VerifierDll,
    load: unsafe extern "system" fn(*mut u16, *mut c_void, usize, *mut c_void),
    unload: unsafe extern "system" fn(*mut u16, *mut c_void, usize, *mut c_void),
    image: *mut u16,
    flags: u32,
    debug: u32,
    trace: *mut c_void,
    create_heap: *mut c_void,
    destroy_heap: *mut c_void,
    free: unsafe extern "system" fn(*mut c_void, usize),
}
unsafe extern "system" fn changed(_: *mut u16, _: *mut c_void, _: usize, _: *mut c_void) {}
unsafe extern "system" fn freed(_: *mut c_void, _: usize) {}
static mut DLLS: VerifierDll = VerifierDll {
    name: ptr::null(),
    flags: 0,
    address: ptr::null_mut(),
    thunks: ptr::null_mut(),
};
static mut PROVIDER: Provider = Provider {
    size: mem::size_of::<Provider>() as u32,
    dlls: &raw mut DLLS,
    load: changed,
    unload: changed,
    image: ptr::null_mut(),
    flags: 0,
    debug: 0,
    trace: ptr::null_mut(),
    create_heap: ptr::null_mut(),
    destroy_heap: ptr::null_mut(),
    free: freed,
};
static mut VERIFIER: bool = false;

fn read_zone() -> Option<(DYNAMIC_TIME_ZONE_INFORMATION, u64, String)> {
    // Resolve IANA names in the controller's adapter, outside the loader lock.
    // Startup reads only fixed-size native registry data; it loads no DLLs.
    unsafe {
        let mut image = vec![0; 32768];
        let length = GetModuleFileNameW(ptr::null_mut(), image.as_mut_ptr(), image.len() as u32);
        if length == 0 || length as usize >= image.len() {
            return None;
        }
        let id = wayrill_protocol::application_identity::key(&String::from_utf16_lossy(
            &image[..length as usize],
        ));
        let path = wide(&format!("Software\\Wayrill\\ApplicationTimezones\\{id}"));
        let mut data = [0u16; 384];
        let mut size = mem::size_of_val(&data) as u32;
        if RegGetValueW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            wide("Policy").as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut size,
        ) != 0
        {
            return None;
        }
        let text = String::from_utf16(&data[..data.iter().position(|v| *v == 0)?]).ok()?;
        let mut parts = text.splitn(4, ':');
        let version = parts.next()?;
        if !matches!(version, "1" | "2" | "3") {
            return None;
        }
        let revision = parts.next()?.parse().ok()?;
        let key = parts.next()?;
        let iana = if version != "1" { parts.next()? } else { "" };
        if iana.len() > 127
            || !iana
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || b"/_+-".contains(&v))
        {
            return None;
        }
        if key.is_empty()
            || key.len() > 127
            || key.contains(['\\', '/', ':'])
            || key.chars().any(char::is_control)
        {
            return None;
        }
        if version == "3" {
            let mut data = [0u8; mem::size_of::<DYNAMIC_TIME_ZONE_INFORMATION>()];
            let mut size = data.len() as u32;
            if RegGetValueW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                wide("Zone").as_ptr(),
                RRF_RT_REG_BINARY,
                ptr::null_mut(),
                data.as_mut_ptr().cast(),
                &mut size,
            ) != ERROR_SUCCESS
                || size as usize != data.len()
                || data[mem::offset_of!(DYNAMIC_TIME_ZONE_INFORMATION, DynamicDaylightTimeDisabled)]
                    > 1
            {
                return None;
            }
            // All other fields are integer arrays. Validate the native boolean
            // before creating a Rust value from user-writable registry bytes.
            let value = ptr::read_unaligned(data.as_ptr().cast::<DYNAMIC_TIME_ZONE_INFORMATION>());
            let end = value.TimeZoneKeyName.iter().position(|v| *v == 0)?;
            if String::from_utf16(&value.TimeZoneKeyName[..end])
                .ok()?
                .as_str()
                != key
            {
                return None;
            }
            return Some((value, revision, iana.into()));
        }
        #[repr(C)]
        struct Tzi {
            bias: i32,
            standard_bias: i32,
            daylight_bias: i32,
            standard: SYSTEMTIME,
            daylight: SYSTEMTIME,
        }
        let mut tzi: Tzi = mem::zeroed();
        let mut size = mem::size_of_val(&tzi) as u32;
        if RegGetValueW(
            HKEY_LOCAL_MACHINE,
            wide(&format!(
                "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Time Zones\\{key}"
            ))
            .as_ptr(),
            wide("TZI").as_ptr(),
            RRF_RT_REG_BINARY,
            ptr::null_mut(),
            (&mut tzi as *mut Tzi).cast(),
            &mut size,
        ) != 0
            || size as usize != mem::size_of::<Tzi>()
        {
            return None;
        }
        let mut value: DYNAMIC_TIME_ZONE_INFORMATION = mem::zeroed();
        value.Bias = tzi.bias;
        value.StandardBias = tzi.standard_bias;
        value.DaylightBias = tzi.daylight_bias;
        value.StandardDate = tzi.standard;
        value.DaylightDate = tzi.daylight;
        let encoded: Vec<u16> = key.encode_utf16().collect();
        if encoded.len() >= value.TimeZoneKeyName.len() {
            return None;
        }
        value.TimeZoneKeyName[..encoded.len()].copy_from_slice(&encoded);
        Some((value, revision, iana.into()))
    }
}

/// # Safety
/// Invoked by the Windows loader with the Application Verifier provider ABI.
#[no_mangle]
pub unsafe extern "system" fn DllMain(_: HMODULE, reason: u32, reserved: *mut c_void) -> i32 {
    unsafe {
        if reason == 4 && !reserved.is_null() {
            VERIFIER = true;
            reserved.cast::<*mut Provider>().write(&raw mut PROVIDER);
        } else if reason == 1 && VERIFIER {
            if let Some((zone, revision, iana)) = read_zone() {
                // Node reads TZ while initializing ICU/V8. Setting it here is
                // process-local, before addon/runtime initialization; child
                // Node environments and workers inherit it normally. Do not
                // use NODE_OPTIONS, an inspector, or private V8 interfaces.
                if !iana.is_empty()
                    && SetEnvironmentVariableW(wide("TZ").as_ptr(), wide(&iana).as_ptr()) == 0
                {
                    return 1;
                }
                if install(true).is_ok() {
                    *STATE.write().unwrap_or_else(|e| e.into_inner()) = State {
                        zone: Some(zone),
                        revision,
                    };
                    *INSTALL.lock().unwrap_or_else(|e| e.into_inner()) = true;
                }
            }
        }
    }
    // Optional interception must never prevent the selected app from starting.
    1
}
