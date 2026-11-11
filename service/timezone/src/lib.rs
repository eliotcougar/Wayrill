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
        atomic::{AtomicBool, AtomicPtr, Ordering},
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
    fn DetourAttachEx(
        target: *mut *mut c_void,
        replacement: *mut c_void,
        trampoline: *mut *mut c_void,
        real_target: *mut *mut c_void,
        real_detour: *mut *mut c_void,
    ) -> i32;
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
type HookPair = [AtomicPtr<c_void>; 2];
const fn hook_pair() -> HookPair {
    [const { AtomicPtr::new(ptr::null_mut()) }; 2]
}
static DYNAMIC: HookPair = hook_pair();
static ZONE: HookPair = hook_pair();
static LOCAL: HookPair = hook_pair();
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
        local_time(out, LOCAL[0].load(Ordering::Acquire));
    }
}
unsafe extern "system" fn local_base(out: *mut SYSTEMTIME) {
    unsafe {
        local_time(out, LOCAL[1].load(Ordering::Acquire));
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
    unsafe { dynamic(out, DYNAMIC[1].load(Ordering::Acquire)) }
}
unsafe extern "system" fn dynamic_kernel(out: *mut DYNAMIC_TIME_ZONE_INFORMATION) -> u32 {
    unsafe { dynamic(out, DYNAMIC[0].load(Ordering::Acquire)) }
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
    unsafe { zone(out, ZONE[0].load(Ordering::Acquire)) }
}
unsafe extern "system" fn zone_base(out: *mut TIME_ZONE_INFORMATION) -> u32 {
    unsafe { zone(out, ZONE[1].load(Ordering::Acquire)) }
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
struct Attachment {
    target: *mut c_void,
    replacement: *mut c_void,
    original: &'static AtomicPtr<c_void>,
}
impl Attachment {
    /// # Safety
    /// The current thread owns an open Detours transaction and this attachment
    /// stays in place until that transaction ends.
    unsafe fn queue(&mut self) -> Result<(), u32> {
        let mut trampoline = ptr::null_mut();
        // On x64 the trampoline returned by Detours begins at its code.
        let code = unsafe {
            DetourAttachEx(
                &raw mut self.target,
                self.replacement,
                &mut trampoline,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if code != 0 {
            return Err(code as u32);
        }
        if trampoline.is_null() {
            return Err(ERROR_INVALID_ADDRESS);
        }
        // Commit makes the callback reachable. Publish its call-through first.
        self.original.store(trampoline, Ordering::Release);
        Ok(())
    }
}
fn prepare_pair(
    slots: &'static HookPair,
    module: &str,
    name: &std::ffi::CStr,
    first: *mut c_void,
    second: *mut c_void,
) -> Result<Vec<Attachment>, u32> {
    let address = |module: &str| unsafe {
        let handle = GetModuleHandleW(wide(module).as_ptr());
        if handle.is_null() {
            return ptr::null_mut();
        }
        GetProcAddress(handle, name.as_ptr().cast()).map_or(ptr::null_mut(), |v| v as *mut c_void)
    };
    let target = address(module);
    if target.is_null() {
        return Err(ERROR_PROC_NOT_FOUND);
    }
    let mut result = vec![Attachment {
        target,
        replacement: first,
        original: &slots[0],
    }];
    let base = address("kernelbase.dll");
    if !base.is_null() && target != base {
        result.push(Attachment {
            target: base,
            replacement: second,
            original: &slots[1],
        });
    }
    Ok(result)
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
            &DYNAMIC,
            "kernel32.dll",
            c"GetDynamicTimeZoneInformation",
            dynamic_kernel as *mut c_void,
            dynamic_base as *mut c_void,
        )?;
        attachments.extend(prepare_pair(
            &ZONE,
            "kernel32.dll",
            c"GetTimeZoneInformation",
            zone_kernel as *mut c_void,
            zone_base as *mut c_void,
        )?);
        attachments.extend(prepare_pair(
            &LOCAL,
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
        let mut transaction = || -> Result<(), u32> {
            let check = |code: i32| if code == 0 { Ok(()) } else { Err(code as u32) };
            for hook in &mut attachments {
                hook.queue()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_the_callable_trampoline_before_commit() {
        unsafe extern "system" {
            fn DetourDetach(target: *mut *mut c_void, replacement: *mut c_void) -> i32;
        }
        static ORIGINAL: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
        #[inline(never)]
        extern "system" fn fixture(input: u32) -> u32 {
            std::hint::black_box(input).wrapping_add(1)
        }
        extern "system" fn replacement(input: u32) -> u32 {
            let original = ORIGINAL.load(Ordering::Acquire);
            let original =
                unsafe { mem::transmute::<*mut c_void, extern "system" fn(u32) -> u32>(original) };
            original(input).wrapping_add(10)
        }
        let mut hook = Attachment {
            target: fixture as *mut c_void,
            replacement: replacement as *mut c_void,
            original: &ORIGINAL,
        };
        let call = std::hint::black_box(fixture as extern "system" fn(u32) -> u32);
        // Only this test calls the fixture. The transaction modifies no system
        // APIs or code used by other tests.
        unsafe {
            assert_eq!(DetourTransactionBegin(), 0);
            if let Err(error) = hook.queue() {
                DetourTransactionAbort();
                panic!("Could not attach test detour: {error}");
            }
            let published = ORIGINAL.load(Ordering::Acquire);
            assert_eq!(DetourTransactionCommit(), 0);
            let committed = hook.target;
            let result = call(7);
            assert_eq!(DetourTransactionBegin(), 0);
            let error = DetourDetach(&raw mut hook.target, hook.replacement);
            if error != 0 {
                DetourTransactionAbort();
                panic!("Could not detach test detour: {error}");
            }
            assert_eq!(DetourTransactionCommit(), 0);
            assert_eq!(published, committed);
            assert_eq!(result, 18);
            assert_eq!(call(7), 8);
        }
    }
}
