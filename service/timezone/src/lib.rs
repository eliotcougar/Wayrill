//! Per-process timezone override. System timezone and UTC remain unchanged.
mod conversion;
mod policy;
mod registry;
mod startup;
mod zone;
use policy::Policy;
use std::{
    ffi::c_void,
    mem, ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock, RwLock, TryLockError,
    },
};
use windows_sys::Win32::{
    Foundation::*,
    System::{
        Diagnostics::ToolHelp::*,
        LibraryLoader::*,
        Memory::*,
        SystemInformation::GetSystemTime,
        SystemServices::{TIME_ZONE_ID_DAYLIGHT, TIME_ZONE_ID_STANDARD, TIME_ZONE_ID_UNKNOWN},
        Threading::*,
        Time::*,
    },
};

#[link(name = "detours", kind = "static")]
unsafe extern "system" {
    fn DetourTransactionBegin() -> i32;
    fn DetourTransactionAbort() -> i32;
    fn DetourTransactionCommit() -> i32;
    fn DetourAttach(original: *mut *mut c_void, replacement: *mut c_void) -> i32;
    fn DetourUpdateThread(thread: HANDLE) -> i32;
}
// Microsoft Detours allocates transaction entries with MSVC operator new while
// previously enrolled threads are suspended. Use a private heap so these calls
// cannot wait on the browser's CRT/process heap. These are the x64 MSVC ABI
// allocation symbols used by the pinned library, not a second hooking engine.
static DETOURS_HEAP: OnceLock<usize> = OnceLock::new();
#[export_name = "??2@YAPEAX_K@Z"]
unsafe extern "C" fn detours_new(size: usize) -> *mut c_void {
    let heap = *DETOURS_HEAP.get_or_init(|| unsafe { HeapCreate(0, 0, 0) as usize });
    if heap == 0 {
        return ptr::null_mut();
    }
    unsafe { HeapAlloc(heap as HANDLE, 0, size) }
}
#[export_name = "??3@YAXPEAX@Z"]
unsafe extern "C" fn detours_delete(value: *mut c_void) {
    if let Some(heap) = DETOURS_HEAP.get() {
        if !value.is_null() {
            unsafe {
                HeapFree(*heap as HANDLE, 0, value);
            }
        }
    }
}
#[export_name = "??3@YAXPEAX_K@Z"]
unsafe extern "C" fn detours_sized_delete(value: *mut c_void, _: usize) {
    unsafe {
        detours_delete(value);
    }
}

#[derive(Clone, Copy)]
struct State {
    zone: Option<DYNAMIC_TIME_ZONE_INFORMATION>,
    revision: u64,
}
static STATE: RwLock<State> = RwLock::new(State {
    zone: None,
    revision: 0,
});
static INSTALL: Mutex<bool> = Mutex::new(false);
static REFRESH_NAME: AtomicBool = AtomicBool::new(false);
type Dynamic = unsafe extern "system" fn(*mut DYNAMIC_TIME_ZONE_INFORMATION) -> u32;
type Zone = unsafe extern "system" fn(*mut TIME_ZONE_INFORMATION) -> u32;
static mut DYNAMIC: [*mut c_void; 2] = [ptr::null_mut(); 2];
static mut ZONE: [*mut c_void; 2] = [ptr::null_mut(); 2];
static mut LOCAL: [*mut c_void; 2] = [ptr::null_mut(); 2];
type Local = unsafe extern "system" fn(*mut SYSTEMTIME);
unsafe fn local_time(out: *mut SYSTEMTIME, original: *mut c_void) {
    if let Some(value) = selected() {
        if !out.is_null() {
            unsafe {
                let mut utc = mem::zeroed();
                GetSystemTime(&mut utc);
                SystemTimeToTzSpecificLocalTimeEx(&value, &utc, out);
            }
        }
    } else {
        unsafe {
            mem::transmute::<*mut c_void, Local>(original)(out);
        }
    }
}
unsafe extern "system" fn local_kernel(out: *mut SYSTEMTIME) {
    unsafe {
        local_time(out, LOCAL[0]);
    }
}
unsafe extern "system" fn local_base(out: *mut SYSTEMTIME) {
    unsafe {
        local_time(out, LOCAL[1]);
    }
}

fn selected() -> Option<DYNAMIC_TIME_ZONE_INFORMATION> {
    STATE.read().unwrap_or_else(|e| e.into_inner()).zone
}
fn classify(value: DYNAMIC_TIME_ZONE_INFORMATION) -> u32 {
    // Explicit timezone arguments avoid consulting or changing the OS default.
    unsafe {
        let mut utc = mem::zeroed();
        let mut local = mem::zeroed();
        GetSystemTime(&mut utc);
        if SystemTimeToTzSpecificLocalTimeEx(&value, &utc, &mut local) == 0 {
            return TIME_ZONE_ID_INVALID;
        }
        let mut year: TIME_ZONE_INFORMATION = mem::zeroed();
        if GetTimeZoneInformationForYear(local.wYear, &value, &mut year) == 0 {
            return TIME_ZONE_ID_INVALID;
        }
        if year.DaylightDate.wMonth == 0 {
            return TIME_ZONE_ID_UNKNOWN;
        }
        let mut u: FILETIME = mem::zeroed();
        let mut l: FILETIME = mem::zeroed();
        if SystemTimeToFileTime(&utc, &mut u) == 0 || SystemTimeToFileTime(&local, &mut l) == 0 {
            return TIME_ZONE_ID_INVALID;
        }
        let ticks = |v: FILETIME| ((v.dwHighDateTime as i64) << 32) | v.dwLowDateTime as i64;
        let bias = (ticks(u) - ticks(l)) / 600_000_000;
        if bias == year.Bias as i64 + year.DaylightBias as i64 {
            TIME_ZONE_ID_DAYLIGHT
        } else {
            TIME_ZONE_ID_STANDARD
        }
    }
}
unsafe fn dynamic(out: *mut DYNAMIC_TIME_ZONE_INFORMATION, original: *mut c_void) -> u32 {
    if let Some(value) = selected() {
        if out.is_null() {
            unsafe {
                SetLastError(ERROR_INVALID_PARAMETER);
            }
            return TIME_ZONE_ID_INVALID;
        }
        unsafe {
            out.write(value);
        }
        classify(value)
    } else {
        unsafe { mem::transmute::<*mut c_void, Dynamic>(original)(out) }
    }
}
unsafe extern "system" fn dynamic_base(out: *mut DYNAMIC_TIME_ZONE_INFORMATION) -> u32 {
    unsafe { dynamic(out, DYNAMIC[1]) }
}
unsafe extern "system" fn dynamic_kernel(out: *mut DYNAMIC_TIME_ZONE_INFORMATION) -> u32 {
    unsafe { dynamic(out, DYNAMIC[0]) }
}
unsafe fn zone(out: *mut TIME_ZONE_INFORMATION, original: *mut c_void) -> u32 {
    if let Some(value) = selected() {
        if out.is_null() {
            unsafe {
                SetLastError(ERROR_INVALID_PARAMETER);
            }
            return TIME_ZONE_ID_INVALID;
        }
        unsafe {
            let mut now = mem::zeroed();
            GetSystemTime(&mut now);
            let mut local = mem::zeroed();
            if SystemTimeToTzSpecificLocalTimeEx(&value, &now, &mut local) == 0 {
                return TIME_ZONE_ID_INVALID;
            }
            let mut result: TIME_ZONE_INFORMATION = mem::zeroed();
            if GetTimeZoneInformationForYear(local.wYear, &value, &mut result) == 0 {
                return TIME_ZONE_ID_INVALID;
            }
            // Chromium uses an empty name to re-detect ICU on WM_TIMECHANGE.
            // Other runtimes need real names for zone/abbreviation lookup.
            if REFRESH_NAME.load(Ordering::Relaxed) {
                result.StandardName = [0; 32];
            }
            result.DaylightName = value.DaylightName;
            out.write(result);
        }
        classify(value)
    } else {
        unsafe { mem::transmute::<*mut c_void, Zone>(original)(out) }
    }
}
unsafe extern "system" fn zone_kernel(out: *mut TIME_ZONE_INFORMATION) -> u32 {
    unsafe { zone(out, ZONE[0]) }
}
unsafe extern "system" fn zone_base(out: *mut TIME_ZONE_INFORMATION) -> u32 {
    unsafe { zone(out, ZONE[1]) }
}

fn resolve(id: &[u16; 128]) -> Result<DYNAMIC_TIME_ZONE_INFORMATION, u32> {
    let end = id
        .iter()
        .position(|v| *v == 0)
        .ok_or(ERROR_INVALID_PARAMETER)?;
    let id = String::from_utf16(&id[..end]).map_err(|_| ERROR_INVALID_PARAMETER)?;
    zone::resolve(&id)
}
fn legacy_information(value: DYNAMIC_TIME_ZONE_INFORMATION) -> TIME_ZONE_INFORMATION {
    TIME_ZONE_INFORMATION {
        Bias: value.Bias,
        StandardName: value.StandardName,
        StandardDate: value.StandardDate,
        StandardBias: value.StandardBias,
        DaylightName: value.DaylightName,
        DaylightDate: value.DaylightDate,
        DaylightBias: value.DaylightBias,
    }
}
type Attachment = (*mut *mut c_void, *mut c_void);
/// # Safety
/// Slots are initialized once before their entry points are intercepted.
unsafe fn prepare_pair(
    slot: *mut [*mut c_void; 2],
    module: &str,
    name: &std::ffi::CStr,
    first: *mut c_void,
    second: *mut c_void,
) -> Result<Vec<Attachment>, u32> {
    unsafe {
        let address = |module: &str| {
            GetProcAddress(
                GetModuleHandleW(wide(module).as_ptr()),
                name.as_ptr().cast(),
            )
            .map_or(ptr::null_mut(), |v| v as *mut c_void)
        };
        (*slot)[0] = address(module);
        (*slot)[1] = address("kernelbase.dll");
        if (*slot)[0].is_null() {
            return Err(ERROR_PROC_NOT_FOUND);
        }
        let mut result = vec![(&raw mut (*slot)[0], first)];
        if !(*slot)[1].is_null() && (*slot)[0] != (*slot)[1] {
            result.push((&raw mut (*slot)[1], second));
        }
        Ok(result)
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn install(at_startup: bool) -> Result<(), u32> {
    unsafe {
        let mut attachments = prepare_pair(
            &raw mut DYNAMIC,
            "kernel32.dll",
            c"GetDynamicTimeZoneInformation",
            dynamic_kernel as *mut c_void,
            dynamic_base as *mut c_void,
        )?;
        attachments.extend(prepare_pair(
            &raw mut ZONE,
            "kernel32.dll",
            c"GetTimeZoneInformation",
            zone_kernel as *mut c_void,
            zone_base as *mut c_void,
        )?);
        attachments.extend(prepare_pair(
            &raw mut LOCAL,
            "kernel32.dll",
            c"GetLocalTime",
            local_kernel as *mut c_void,
            local_base as *mut c_void,
        )?);
        attachments.extend(conversion::prepare()?);
        attachments.extend(registry::prepare()?);
        let image = GetModuleHandleW(ptr::null());
        let chromium = GetProcAddress(image, c"IsSandboxedProcess".as_ptr().cast()).is_some()
            || !GetModuleHandleW(wide("libcef.dll").as_ptr()).is_null()
            || !GetModuleHandleW(wide("Qt6WebEngineCore.dll").as_ptr()).is_null()
            || !GetModuleHandleW(wide("Qt5WebEngineCore.dll").as_ptr()).is_null();
        REFRESH_NAME.store(!at_startup && chromium, Ordering::Relaxed);
        let mut threads = Vec::new();
        // At process startup the loader serializes DLL initialization. Enrolling
        // other threads here could suspend one that is waiting for the loader.
        if !at_startup {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(GetLastError());
            }
            let snapshot = Handle(snapshot);
            let mut item: THREADENTRY32 = mem::zeroed();
            item.dwSize = mem::size_of_val(&item) as u32;
            if Thread32First(snapshot.0, &mut item) == 0 {
                return Err(GetLastError());
            }
            loop {
                if item.th32OwnerProcessID == GetCurrentProcessId()
                    && item.th32ThreadID != GetCurrentThreadId()
                {
                    let thread = OpenThread(
                        THREAD_SUSPEND_RESUME
                            | THREAD_GET_CONTEXT
                            | THREAD_SET_CONTEXT
                            | THREAD_QUERY_INFORMATION,
                        0,
                        item.th32ThreadID,
                    );
                    if !thread.is_null() {
                        threads.push(Handle(thread));
                    } else if GetLastError() != ERROR_INVALID_PARAMETER {
                        return Err(GetLastError());
                    }
                }
                if Thread32Next(snapshot.0, &mut item) == 0 {
                    break;
                }
            }
        }
        // Initialize the private allocator before suspending any browser thread.
        let warmup = detours_new(1);
        if warmup.is_null() {
            return Err(ERROR_NOT_ENOUGH_MEMORY);
        }
        detours_delete(warmup);
        let code = DetourTransactionBegin();
        if code != 0 {
            return Err(code as u32);
        }
        let transaction = || -> Result<(), u32> {
            let check = |code: i32| if code == 0 { Ok(()) } else { Err(code as u32) };
            for &(slot, callback) in &attachments {
                check(DetourAttach(slot, callback))?;
            }
            for thread in &threads {
                check(DetourUpdateThread(thread.0))?;
            }
            Ok(())
        };
        if let Err(error) = transaction() {
            DetourTransactionAbort();
            return Err(error);
        }
        let code = DetourTransactionCommit();
        if code != 0 {
            return Err(code as u32);
        }
        Ok(())
    }
}
/// # Safety
/// Called by the bridge with a live, initialized Policy argument. Its allocation
/// remains valid until this exported thread entry returns.
#[no_mangle]
pub unsafe extern "system" fn WayrillTimezoneApply(input: *mut c_void) -> u32 {
    if input.is_null() {
        return ERROR_INVALID_PARAMETER;
    }
    let policy = unsafe { &*input.cast::<Policy>() };
    if policy.version != 1 || policy.enabled > 1 || policy.zone[127] != 0 {
        return ERROR_INVALID_PARAMETER;
    }
    // A timed-out remote call may still be installing the hook. Retrying must
    // not leave another browser thread waiting behind it on each alarm tick.
    let mut installed = match INSTALL.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(error)) => error.into_inner(),
        Err(TryLockError::WouldBlock) => return ERROR_BUSY,
    };
    let current = *STATE.read().unwrap_or_else(|e| e.into_inner());
    if policy.revision < current.revision {
        return ERROR_REVISION_MISMATCH;
    }
    if policy.revision == current.revision && (policy.enabled == 1) == current.zone.is_some() {
        return ERROR_SUCCESS;
    }
    let next = if policy.enabled == 1 {
        match resolve(&policy.zone) {
            Ok(value) => Some(value),
            Err(error) => return error,
        }
    } else {
        None
    };
    if !*installed && next.is_some() {
        let mut module = ptr::null_mut();
        if unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                WayrillTimezoneApply as *const u16,
                &mut module,
            )
        } == 0
        {
            return unsafe { GetLastError() };
        }
        if let Err(error) = install(false) {
            return error;
        }
        *installed = true;
    }
    *STATE.write().unwrap_or_else(|e| e.into_inner()) = State {
        zone: next,
        revision: policy.revision,
    };
    ERROR_SUCCESS
}
