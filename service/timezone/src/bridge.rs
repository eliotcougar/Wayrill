//! Only the browser in this normal-user native host's OS ancestry is eligible.
//! There is deliberately no PID, executable, DLL or command supplied by a page.
mod policy;
mod zone;
use policy::Policy;
use serde::{Deserialize, Serialize};
use std::{
    ffi::c_void,
    io::{self, Read},
    mem,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::{
        Diagnostics::{Debug::WriteProcessMemory, ToolHelp::*},
        LibraryLoader::*,
        Memory::*,
        RemoteDesktop::ProcessIdToSessionId,
        Threading::*,
    },
    UI::WindowsAndMessaging::*,
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn text(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|v| *v == 0).unwrap_or(value.len())])
}
fn image(process: HANDLE) -> Result<String, u32> {
    let mut path = vec![0; 32768];
    let mut size = path.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size) } == 0 {
        return Err(unsafe { GetLastError() });
    }
    path.truncate(size as usize);
    Ok(String::from_utf16_lossy(&path))
}
fn creation(process: HANDLE) -> Result<u64, u32> {
    unsafe {
        let mut born = mem::zeroed();
        let mut exited = mem::zeroed();
        let mut kernel = mem::zeroed();
        let mut user = mem::zeroed();
        if GetProcessTimes(process, &mut born, &mut exited, &mut kernel, &mut user) == 0 {
            return Err(GetLastError());
        }
        Ok(((born.dwHighDateTime as u64) << 32) | born.dwLowDateTime as u64)
    }
}
fn user(process: HANDLE) -> Result<Vec<u64>, u32> {
    unsafe {
        let mut raw = ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut raw) == 0 {
            return Err(GetLastError());
        }
        let token = Handle(raw);
        let mut size = 0;
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut size);
        let mut storage = vec![0; (size as usize).div_ceil(8)];
        if size == 0
            || GetTokenInformation(
                token.0,
                TokenUser,
                storage.as_mut_ptr().cast(),
                size,
                &mut size,
            ) == 0
        {
            return Err(GetLastError());
        }
        Ok(storage)
    }
}
fn same_user(process: HANDLE) -> bool {
    let Ok(left) = user(process) else {
        return false;
    };
    let Ok(right) = user(unsafe { GetCurrentProcess() }) else {
        return false;
    };
    unsafe {
        EqualSid(
            (*(left.as_ptr().cast::<TOKEN_USER>())).User.Sid,
            (*(right.as_ptr().cast::<TOKEN_USER>())).User.Sid,
        ) != 0
    }
}
fn supported(path: &str) -> bool {
    Path::new(path).file_name().is_some_and(|name| {
        [
            "chrome.exe",
            "msedge.exe",
            "opera.exe",
            "brave.exe",
            "vivaldi.exe",
            "firefox.exe",
        ]
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
    })
}
#[derive(Deserialize, Serialize)]
struct Browser {
    pid: u32,
    created: u64,
    path: String,
}
fn ancestor() -> Result<Browser, u32> {
    unsafe {
        let raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if raw == INVALID_HANDLE_VALUE {
            return Err(GetLastError());
        }
        let snapshot = Handle(raw);
        let mut entries = Vec::new();
        let mut item: PROCESSENTRY32W = mem::zeroed();
        item.dwSize = mem::size_of_val(&item) as u32;
        if Process32FirstW(snapshot.0, &mut item) == 0 {
            return Err(GetLastError());
        }
        loop {
            entries.push(item);
            if Process32NextW(snapshot.0, &mut item) == 0 {
                break;
            }
        }
        let mut pid = GetCurrentProcessId();
        let mut child_created = creation(GetCurrentProcess())?;
        let mut found: Option<Browser> = None;
        for _ in 0..24 {
            let Some(entry) = entries.iter().find(|entry| entry.th32ProcessID == pid) else {
                break;
            };
            if entry.th32ParentProcessID == 0 || entry.th32ParentProcessID == pid {
                break;
            }
            pid = entry.th32ParentProcessID;
            let process = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
            if process.0.is_null() || !same_user(process.0) {
                break;
            }
            let created = creation(process.0)?;
            if created > child_created {
                break;
            } // parent PID reused
            child_created = created;
            let path = image(process.0)?;
            if supported(&path) {
                if found
                    .as_ref()
                    .is_some_and(|old| !old.path.eq_ignore_ascii_case(&path))
                {
                    break;
                }
                found = Some(Browser { pid, created, path });
            } else if found.is_some() {
                break;
            }
        }
        found.ok_or(ERROR_NOT_FOUND)
    }
}
struct Module {
    base: usize,
    path: PathBuf,
}
fn modules(pid: u32) -> Result<Vec<Module>, u32> {
    unsafe {
        let raw = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if raw == INVALID_HANDLE_VALUE {
            return Err(GetLastError());
        }
        let snapshot = Handle(raw);
        let mut item: MODULEENTRY32W = mem::zeroed();
        item.dwSize = mem::size_of_val(&item) as u32;
        let mut result = Vec::new();
        if Module32FirstW(snapshot.0, &mut item) == 0 {
            return Err(GetLastError());
        }
        loop {
            result.push(Module {
                base: item.modBaseAddr as usize,
                path: text(&item.szExePath).into(),
            });
            if Module32NextW(snapshot.0, &mut item) == 0 {
                break;
            }
        }
        Ok(result)
    }
}
fn module(pid: u32, name: &std::ffi::OsStr) -> Result<usize, u32> {
    modules(pid)?
        .into_iter()
        .find(|item| {
            item.path
                .file_name()
                .is_some_and(|leaf| leaf.eq_ignore_ascii_case(name))
        })
        .map(|item| item.base)
        .ok_or(ERROR_MOD_NOT_FOUND)
}
fn invoke(process: HANDLE, entry: usize, bytes: &[u8]) -> Result<u32, u32> {
    unsafe {
        let remote = VirtualAllocEx(
            process,
            ptr::null(),
            bytes.len(),
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        );
        if remote.is_null() {
            return Err(GetLastError());
        }
        if WriteProcessMemory(
            process,
            remote,
            bytes.as_ptr().cast(),
            bytes.len(),
            ptr::null_mut(),
        ) == 0
        {
            let error = GetLastError();
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            return Err(error);
        }
        let thread = CreateRemoteThread(
            process,
            ptr::null(),
            0,
            Some(mem::transmute::<
                usize,
                unsafe extern "system" fn(*mut c_void) -> u32,
            >(entry)),
            remote,
            0,
            ptr::null_mut(),
        );
        if thread.is_null() {
            let error = GetLastError();
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            return Err(error);
        }
        let thread = Handle(thread);
        match WaitForSingleObject(thread.0, 10000) {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                let success = GetExitCodeThread(thread.0, &mut code);
                let error = GetLastError();
                VirtualFreeEx(process, remote, 0, MEM_RELEASE);
                if success == 0 {
                    Err(error)
                } else {
                    Ok(code)
                }
            }
            WAIT_TIMEOUT => Err(ERROR_TIMEOUT),
            _ => Err(GetLastError()),
        }
        // On timeout the argument remains valid until process exit. Never kill
        // a target thread that might own browser loader or Detours locks.
    }
}
unsafe extern "system" fn window(hwnd: HWND, pid: LPARAM) -> i32 {
    let mut owner = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut owner);
        if owner == pid as u32 {
            PostMessageW(hwnd, WM_TIMECHANGE, 0, 0);
        }
    }
    1
}
fn notify(pid: u32) {
    unsafe {
        EnumWindows(Some(window), pid as isize);
        let mut hwnd = FindWindowExW(HWND_MESSAGE, ptr::null_mut(), ptr::null(), ptr::null());
        while !hwnd.is_null() {
            window(hwnd, pid as isize);
            hwnd = FindWindowExW(HWND_MESSAGE, hwnd, ptr::null(), ptr::null());
        }
    }
}
fn asset(name: &str) -> bool {
    name.strip_prefix("wayrill-timezone-")
        .and_then(|v| v.strip_suffix(".dll"))
        .is_some_and(|v| v.len() == 16 && v.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn system_zone() -> Result<String, u32> {
    unsafe {
        let dll = LoadLibraryExW(
            wide("icu.dll").as_ptr(),
            ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        );
        if dll.is_null() {
            return Err(GetLastError());
        }
        type DefaultZone = unsafe extern "C" fn(*mut u16, i32, *mut i32) -> i32;
        let get = GetProcAddress(dll, c"ucal_getDefaultTimeZone".as_ptr().cast());
        let mut zone = [0; 128];
        let mut error = 0;
        let length = get
            .map(|f| {
                mem::transmute::<unsafe extern "system" fn() -> isize, DefaultZone>(f)(
                    zone.as_mut_ptr(),
                    128,
                    &mut error,
                )
            })
            .unwrap_or(0);
        FreeLibrary(dll);
        if error > 0 || length <= 0 || length >= 128 {
            return Err(ERROR_INVALID_DATA);
        }
        Ok(text(&zone))
    }
}
fn apply(target: &Browser, zone: &str, revision: u64) -> Result<(), u32> {
    unsafe {
        let process = Handle(OpenProcess(
            PROCESS_CREATE_THREAD
                | PROCESS_QUERY_INFORMATION
                | PROCESS_VM_OPERATION
                | PROCESS_VM_WRITE
                | PROCESS_VM_READ,
            0,
            target.pid,
        ));
        if process.0.is_null() {
            return Err(GetLastError());
        }
        if creation(process.0)? != target.created
            || !image(process.0)?.eq_ignore_ascii_case(&target.path)
            || !same_user(process.0)
        {
            return Err(ERROR_ACCESS_DENIED);
        }
        let mut machine = 0;
        let mut native = 0;
        if IsWow64Process2(process.0, &mut machine, &mut native) == 0
            || machine != 0
            || native != 0x8664
        {
            return Err(ERROR_NOT_SUPPORTED);
        }
        let own = std::env::current_exe().map_err(|_| ERROR_PATH_NOT_FOUND)?;
        let directory = own.parent().ok_or(ERROR_PATH_NOT_FOUND)?;
        let mut system = [0u16; 260];
        let length = windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(
            system.as_mut_ptr(),
            system.len() as u32,
        );
        if length == 0 || length as usize >= system.len() {
            return Err(ERROR_PATH_NOT_FOUND);
        }
        let system = PathBuf::from(text(&system));
        let mut loaded = modules(target.pid)?.into_iter().find(|item| {
            item.path.parent().is_some_and(|parent| {
                parent
                    .as_os_str()
                    .eq_ignore_ascii_case(directory.as_os_str())
                    || parent.as_os_str().eq_ignore_ascii_case(system.as_os_str())
            }) && item
                .path
                .file_name()
                .and_then(|v| v.to_str())
                .is_some_and(asset)
        });
        if loaded.is_none() && zone == "off" {
            return Ok(());
        }
        if loaded.is_none() {
            let name = std::fs::read_to_string(directory.join("asset.txt"))
                .map_err(|_| ERROR_FILE_NOT_FOUND)?;
            if !asset(name.trim()) {
                return Err(ERROR_INVALID_DATA);
            }
            let path = directory.join(name.trim());
            let path_text = path.to_string_lossy();
            let load = GetProcAddress(
                GetModuleHandleW(wide("kernel32.dll").as_ptr()),
                c"LoadLibraryW".as_ptr().cast(),
            )
            .ok_or(ERROR_PROC_NOT_FOUND)?;
            let mut owner = ptr::null_mut();
            if GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                    | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                load as *const u16,
                &mut owner,
            ) == 0
            {
                return Err(GetLastError());
            }
            let mut owner_path = vec![0; 32768];
            if GetModuleFileNameW(owner, owner_path.as_mut_ptr(), owner_path.len() as u32) == 0 {
                return Err(GetLastError());
            }
            let owner_path = PathBuf::from(text(&owner_path));
            let entry = module(
                target.pid,
                owner_path.file_name().ok_or(ERROR_MOD_NOT_FOUND)?,
            )? + (load as usize - owner as usize);
            let argument = wide(&path_text);
            let bytes =
                std::slice::from_raw_parts(argument.as_ptr().cast::<u8>(), argument.len() * 2);
            invoke(process.0, entry, bytes)?;
            loaded = Some(Module {
                base: module(target.pid, path.file_name().ok_or(ERROR_MOD_NOT_FOUND)?)?,
                path,
            });
        }
        let loaded = loaded.ok_or(ERROR_MOD_NOT_FOUND)?;
        let dll = LoadLibraryExW(
            wide(&loaded.path.to_string_lossy()).as_ptr(),
            ptr::null_mut(),
            DONT_RESOLVE_DLL_REFERENCES,
        );
        if dll.is_null() {
            return Err(GetLastError());
        }
        let entry = GetProcAddress(dll, c"WayrillTimezoneApply".as_ptr().cast())
            .map(|f| f as usize - dll as usize);
        FreeLibrary(dll);
        let entry = loaded.base + entry.ok_or(ERROR_PROC_NOT_FOUND)?;
        let mut policy = Policy {
            version: 1,
            enabled: u32::from(zone != "off"),
            revision,
            zone: [0; 128],
        };
        let encoded: Vec<u16> = zone.encode_utf16().collect();
        if encoded.len() >= policy.zone.len() {
            return Err(ERROR_INVALID_PARAMETER);
        }
        policy.zone[..encoded.len()].copy_from_slice(&encoded);
        let bytes = std::slice::from_raw_parts(
            (&policy as *const Policy).cast::<u8>(),
            mem::size_of_val(&policy),
        );
        let code = invoke(process.0, entry, bytes)?;
        if code == 0 {
            Ok(())
        } else {
            Err(code)
        }
    }
}
fn encoded_zone(
    value: &windows_sys::Win32::System::Time::DYNAMIC_TIME_ZONE_INFORMATION,
) -> Vec<u8> {
    // Encode fields, never Rust struct padding. Windows' native layout ends
    // with three padding bytes, explicitly zero in this format.
    const _: () = assert!(
        mem::size_of::<windows_sys::Win32::System::Time::DYNAMIC_TIME_ZONE_INFORMATION>() == 432
    );
    let mut bytes = value.Bias.to_le_bytes().to_vec();
    bytes.extend(value.StandardName.into_iter().flat_map(u16::to_le_bytes));
    bytes.extend(zone::systemtime_bytes(value.StandardDate));
    bytes.extend(value.StandardBias.to_le_bytes());
    bytes.extend(value.DaylightName.into_iter().flat_map(u16::to_le_bytes));
    bytes.extend(zone::systemtime_bytes(value.DaylightDate));
    bytes.extend(value.DaylightBias.to_le_bytes());
    bytes.extend(value.TimeZoneKeyName.into_iter().flat_map(u16::to_le_bytes));
    bytes.push(u8::from(value.DynamicDaylightTimeDisabled));
    bytes.resize(432, 0);
    bytes
}
fn run() -> Result<(), u32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--resolve-zone"] {
        let mut bytes = Vec::new();
        io::stdin()
            .take(1025)
            .read_to_end(&mut bytes)
            .map_err(|_| ERROR_INVALID_DATA)?;
        if bytes.len() > 1024 {
            return Err(ERROR_INVALID_DATA);
        }
        let zone: String = serde_json::from_slice(&bytes).map_err(|_| ERROR_INVALID_DATA)?;
        let resolved = zone::resolve(&zone)?;
        let data = encoded_zone(&resolved);
        println!(
            "{}",
            serde_json::json!({"windowsZone":text(&resolved.TimeZoneKeyName),"nativeZone":data})
        );
        return Ok(());
    }
    if args.as_slice() == ["--system-zone"] {
        println!("{}", serde_json::json!({"systemZone":system_zone()?}));
        return Ok(());
    }
    if args.as_slice() == ["--managed-apply"] {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            target: Browser,
            zone: String,
            revision: u64,
            session: u32,
        }
        let mut bytes = Vec::new();
        io::stdin()
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| ERROR_INVALID_DATA)?;
        if bytes.len() > 65536 {
            return Err(ERROR_INVALID_DATA);
        }
        let input: Input = serde_json::from_slice(&bytes).map_err(|_| ERROR_INVALID_DATA)?;
        let mut session = 0;
        if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) } == 0
            || session != input.session
        {
            return Err(ERROR_ACCESS_DENIED);
        }
        apply_serialized(&input.target, &input.zone, input.revision)?;
        return Ok(());
    }
    let target = ancestor()?;
    match args.as_slice() {
        [mode] if mode == "--identify" => {
            println!(
                "{}",
                serde_json::to_string(&target).map_err(|_| ERROR_INVALID_DATA)?
            );
            Ok(())
        }
        [mode] if mode == "--notify" => {
            notify(target.pid);
            Ok(())
        }
        _ => Err(ERROR_INVALID_PARAMETER),
    }
}
fn apply_serialized(target: &Browser, zone: &str, revision: u64) -> Result<(), u32> {
    let name = wide(&format!(
        "Local\\WayrillTimezone-{}-{}",
        target.pid, target.created
    ));
    let mutex = Handle(unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) });
    if mutex.0.is_null() {
        return Err(unsafe { GetLastError() });
    }
    if !matches!(
        unsafe { WaitForSingleObject(mutex.0, 8000) },
        WAIT_OBJECT_0 | WAIT_ABANDONED
    ) {
        return Err(ERROR_BUSY);
    }
    let result = apply(target, zone, revision);
    unsafe {
        ReleaseMutex(mutex.0);
    }
    if result.is_ok() {
        notify(target.pid);
    }
    result
}
fn main() {
    if let Err(error) = run() {
        if error == ERROR_NOT_SUPPORTED {
            eprintln!("This application architecture is not supported. Choose an x64 or compatible AnyCPU application; native x86 and ARM64 need matching timezone components.");
        }
        eprintln!("Native timezone error {error}");
        std::process::exit(error as i32);
    }
}
