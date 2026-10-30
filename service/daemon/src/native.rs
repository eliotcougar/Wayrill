use crate::events::Events;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    os::windows::io::FromRawHandle,
    path::Path,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    System::{JobObjects::*, Pipes::*, RemoteDesktop::*, Threading::*},
};
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
pub fn os_error(context: &str) -> ApiError {
    ApiError::io(context, std::io::Error::last_os_error())
}
pub struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                CloseHandle(self.0);
            }
        }
    }
}
/// Owns a table allocated by the Windows IP Helper APIs.
pub(crate) struct MibTable<T>(ptr::NonNull<T>);
impl<T> MibTable<T> {
    /// # Safety
    /// A non-null pointer must be a uniquely owned allocation returned by an IP
    /// Helper table query and must not be freed or adopted elsewhere.
    pub(crate) unsafe fn from_raw(pointer: *mut T) -> Option<Self> {
        ptr::NonNull::new(pointer).map(Self)
    }
    pub(crate) fn as_ptr(&self) -> *mut T {
        self.0.as_ptr()
    }
}
impl<T> Drop for MibTable<T> {
    fn drop(&mut self) {
        // SAFETY: from_raw transfers exactly one live IP Helper allocation.
        unsafe {
            windows_sys::Win32::NetworkManagement::IpHelper::FreeMibTable(self.0.as_ptr().cast());
        }
    }
}
pub fn verify_hash(path: &Path, expected: &str) -> Result<()> {
    let mut f = File::open(path).map_err(|e| ApiError::io("Open bundled dependency", e))?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| ApiError::io("Hash dependency", e))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    if crate::system_native::hex(&hash.finalize()) != expected.to_lowercase() {
        return Err(ApiError::new(
            "BINARY_INTEGRITY",
            "Bundled dependency SHA-256 does not match this service build.",
        ));
    }
    Ok(())
}
pub const XRAY_VERSION: &str = env!("WAYRILL_XRAY_VERSION");
pub const XRAY_SHA: &str = env!("WAYRILL_XRAY_SHA");
pub fn token_sid(token: HANDLE) -> Result<String> {
    unsafe {
        let mut bytes = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut bytes);
        let mut storage = vec![0u64; (bytes as usize).div_ceil(8)];
        if GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        ) == 0
        {
            return Err(os_error("Read token identity"));
        }
        let user = &*(storage.as_ptr().cast::<TOKEN_USER>());
        let mut text = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(os_error("Format identity"));
        }
        let mut n = 0;
        while *text.add(n) != 0 {
            n += 1;
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
        LocalFree(text.cast());
        Ok(result)
    }
}
pub fn authorize_pipe(pipe: HANDLE, owner: &str) -> Result<()> {
    unsafe {
        if ImpersonateNamedPipeClient(pipe) == 0 {
            return Err(os_error("Identify pipe client"));
        }
        struct Revert;
        impl Drop for Revert {
            fn drop(&mut self) {
                unsafe {
                    if RevertToSelf() == 0 {
                        std::process::abort();
                    }
                }
            }
        }
        let _revert = Revert;
        let mut token = ptr::null_mut();
        if OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) == 0 {
            return Err(os_error("Read client token"));
        }
        let token = Handle(token);
        let sid = token_sid(token.0)?;
        if sid != owner && sid != "S-1-5-18" {
            return Err(ApiError::new(
                "UNAUTHORIZED",
                "Only the installation's authorized user and LocalSystem may call this service.",
            ));
        }
        Ok(())
    }
}
pub struct SecurityDescriptor(*mut std::ffi::c_void);
impl SecurityDescriptor {
    pub fn pipe(owner: &str) -> Result<Self> {
        unsafe {
            let mut p = ptr::null_mut();
            let sddl = format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;{owner})");
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&sddl).as_ptr(),
                SDDL_REVISION_1,
                &mut p,
                ptr::null_mut(),
            ) == 0
            {
                return Err(os_error("Create pipe permissions"));
            }
            Ok(Self(p))
        }
    }
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

/// Select an unprivileged core identity without storing account credentials.
#[derive(Clone, Copy)]
pub enum CoreIdentity<'a> {
    Owner(&'a str),
    LocalService,
}
impl CoreIdentity<'_> {
    pub(crate) fn token(self) -> Result<Handle> {
        match self {
            Self::Owner(owner) => owner_token(owner),
            Self::LocalService => unsafe {
                let mut token = ptr::null_mut();
                if LogonUserW(
                    wide("LocalService").as_ptr(),
                    wide("NT AUTHORITY").as_ptr(),
                    ptr::null(),
                    LOGON32_LOGON_SERVICE,
                    LOGON32_PROVIDER_DEFAULT,
                    &mut token,
                ) == 0
                {
                    return Err(os_error("Obtain LocalService token"));
                }
                let token = Handle(token);
                if token_sid(token.0)? != "S-1-5-19" {
                    return Err(ApiError::new(
                        "TOKEN_IDENTITY",
                        "Unexpected boot core identity.",
                    ));
                }
                restrict_token(token)
            },
        }
    }
}
/// Obtain the configured owner's logged-on token and restrict it to session 0.
fn owner_token(owner: &str) -> Result<Handle> {
    unsafe {
        let mut sessions = ptr::null_mut();
        let mut count = 0;
        if WTSEnumerateSessionsW(ptr::null_mut(), 0, 1, &mut sessions, &mut count) == 0 {
            return Err(os_error("List user sessions"));
        }
        let list = if count == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(sessions, count as usize)
        };
        let mut found = None;
        for session in list {
            let mut token = ptr::null_mut();
            if WTSQueryUserToken(session.SessionId, &mut token) != 0 {
                let token = Handle(token);
                if token_sid(token.0).ok().as_deref() == Some(owner) {
                    found = Some(token);
                    break;
                }
            }
        }
        WTSFreeMemory(sessions.cast());
        let token = found.ok_or_else(|| {
            ApiError::new(
                "OWNER_NOT_LOGGED_ON",
                "The authorized user must be logged on before Xray can be validated or started.",
            )
        })?;
        restrict_token(token)
    }
}
// Both identities get the same privilege stripping and noninteractive containment.
pub(crate) fn restrict_token(token: Handle) -> Result<Handle> {
    unsafe {
        let mut admin = ptr::null_mut();
        if ConvertStringSidToSidW(wide("S-1-5-32-544").as_ptr(), &mut admin) == 0 {
            return Err(os_error("Administrator SID"));
        }
        let group = SID_AND_ATTRIBUTES {
            Sid: admin,
            Attributes: 0,
        };
        let mut restricted = ptr::null_mut();
        let ok = CreateRestrictedToken(
            token.0,
            DISABLE_MAX_PRIVILEGE,
            1,
            &group,
            0,
            ptr::null(),
            0,
            ptr::null(),
            &mut restricted,
        );
        LocalFree(admin);
        if ok == 0 {
            return Err(os_error("Restrict Xray token"));
        }
        let restricted = Handle(restricted);
        let session: u32 = 0;
        if SetTokenInformation(
            restricted.0,
            TokenSessionId,
            (&session as *const u32).cast(),
            4,
        ) == 0
        {
            return Err(os_error("Set noninteractive Xray session"));
        }
        Ok(restricted)
    }
}
fn pipe_pair() -> Result<(Handle, Handle)> {
    unsafe {
        let mut read = ptr::null_mut();
        let mut write = ptr::null_mut();
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: ptr::null_mut(),
            bInheritHandle: 1,
        };
        if CreatePipe(&mut read, &mut write, &sa, 0) == 0 {
            return Err(os_error("Create core pipes"));
        }
        Ok((Handle(read), Handle(write)))
    }
}
fn file(handle: Handle) -> File {
    let raw = handle.0;
    std::mem::forget(handle);
    unsafe { File::from_raw_handle(raw) }
}
pub struct CoreProcess {
    pub pid: u32,
    pub user_sid: String,
    process: Handle,
    job: Handle,
    pub lines: Arc<Mutex<Vec<String>>>,
    output: Arc<CoreOutput>,
}
impl CoreProcess {
    pub(crate) fn private_reply(&self) -> Result<Option<Value>> {
        if self.output.readers_done.load(Ordering::Acquire) != 2 {
            return Ok(None);
        }
        let reply = self.output.reply.lock().unwrap();
        let text = reply.as_ref().ok_or_else(|| {
            ApiError::new("SUBSCRIPTION_WORKER", "Missing private worker response.")
        })?;
        if text.len() > 256 * 1024 * 1024 {
            return Err(ApiError::new(
                "LIMIT",
                "Subscription worker response is too large.",
            ));
        }
        serde_json::from_str(text)
            .map(Some)
            .map_err(|_| ApiError::new("SUBSCRIPTION_WORKER", "Invalid private worker response."))
    }
    pub fn started(&self) -> bool {
        self.output.started.load(Ordering::Acquire)
    }
    pub fn take_routing_lines(&self) -> Vec<String> {
        self.output.routing.lock().unwrap().drain(..).collect()
    }
    pub fn exit_code(&self) -> Result<Option<u32>> {
        unsafe {
            let mut code = 0;
            if GetExitCodeProcess(self.process.0, &mut code) == 0 {
                return Err(os_error("Read Xray process state"));
            }
            Ok(if code == STILL_ACTIVE as u32 {
                None
            } else {
                Some(code)
            })
        }
    }
    pub fn stop(&self) -> Result<()> {
        unsafe {
            if self.exit_code()?.is_some() {
                return Ok(());
            }
            if TerminateJobObject(self.job.0, 0) == 0 {
                return Err(os_error("Stop owned Xray job"));
            }
            match WaitForSingleObject(self.process.0, 5000) {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => {
                    return Err(ApiError::new("TIMEOUT", "Owned Xray process did not exit."))
                }
                _ => return Err(os_error("Wait for owned Xray process")),
            }
            Ok(())
        }
    }
}
impl Drop for CoreProcess {
    fn drop(&mut self) {
        // Wait for job termination before callers release adapters or other
        // resources the worker can still be configuring, including startup errors.
        let _ = self.stop();
    }
}
/// Keep bounded output chunks without splitting a UTF-8 character or trimming
/// spaces inside a helper's JSON. Retain at most three incomplete trailing bytes.
pub(crate) fn read_output(input: impl Read, mut emit: impl FnMut(String)) -> std::io::Result<()> {
    let mut reader = BufReader::new(input);
    let mut bytes = Vec::new();
    loop {
        let capacity = 8192 - bytes.len();
        if (&mut reader)
            .take(capacity as u64)
            .read_until(b'\n', &mut bytes)?
            == 0
        {
            if !bytes.is_empty() {
                emit(String::from_utf8_lossy(&bytes).into_owned());
            }
            return Ok(());
        }
        let pending = (1..=3.min(bytes.len()))
            .find(|&n| {
                std::str::from_utf8(&bytes[bytes.len() - n..])
                    .is_err_and(|e| e.valid_up_to() == 0 && e.error_len().is_none())
            })
            .unwrap_or(0);
        let end = bytes.len() - pending;
        if end != 0 {
            emit(String::from_utf8_lossy(&bytes[..end]).into_owned());
            bytes.drain(..end);
        }
    }
}

fn helper_output(arguments: &str) -> bool {
    matches!(
        arguments,
        "--proxy-helper" | "--system-settings-helper" | "wayrill-fakedns" | "--subscription-worker"
    )
}

#[derive(Default)]
struct CoreOutput {
    reply: Mutex<Option<String>>,
    readers_done: std::sync::atomic::AtomicUsize,
    lines: Arc<Mutex<Vec<String>>>,
    started: AtomicBool,
    // The independent ICS keeper drains this bounded queue through its private
    // status pipe. Other cores deliver decisions directly to the service log.
    relay_routing: bool,
    // Helper output is a private IPC reply, not a core diagnostic stream.
    helper: bool,
    origin: u32,
    source: &'static str,
    routing: Mutex<VecDeque<String>>,
}
impl CoreOutput {
    fn observe(&self, text: String, events: Option<&Events>, generation: u64) {
        {
            let mut reply = self.reply.lock().unwrap();
            if let Some(reply) = reply.as_mut() {
                if reply.len() <= 256 * 1024 * 1024 {
                    reply.push_str(&text);
                }
                return;
            }
        }
        if !self.helper
            && text.contains("core: Xray ")
            && text.trim_end().ends_with(" started")
            && !self.started.swap(true, Ordering::AcqRel)
        {
            crate::diagnostics::process(self.source, self.origin);
        }
        if !self.helper
            && events.is_some_and(|e| {
                e.routing
                    .ingest_from(generation, self.origin, self.source, &text)
            })
        {
            return;
        }
        if !self.helper && self.relay_routing && crate::routing_log::is_info(&text) {
            if crate::routing_log::decision(&text).is_some() {
                let mut routing = self.routing.lock().unwrap();
                if routing.len() == 1000 {
                    routing.pop_front();
                }
                routing.push_back(text);
            }
            return;
        }
        let mut out = self.lines.lock().unwrap();
        if out.len() == 64 {
            out.remove(0);
        }
        out.push(text.clone());
        if self.helper {
            return;
        }
        if !crate::routing_log::is_info(&text)
            && !text.contains(" accepted ")
            && !text.contains(" rejected ")
        {
            crate::diagnostics::log(
                self.source,
                wayrill_diagnostics::xray_level(&text).unwrap_or("info"),
                text.trim(),
            );
        }
        drop(out);
        if let Some(e) = events {
            let message = text.trim();
            if !message.is_empty() {
                e.publish(
                    "core.log",
                    json!({"generation":generation,"message":message}),
                );
            }
        }
    }
}
fn collect_output(
    input: File,
    output: Arc<CoreOutput>,
    events: Option<Arc<Events>>,
    generation: u64,
) -> Result<()> {
    std::thread::Builder::new()
        .name("wayrill-core-output".into())
        .spawn(move || {
            let _ = read_output(input, |text| {
                output.observe(text, events.as_deref(), generation)
            });
            output.readers_done.fetch_add(1, Ordering::Release);
        })
        .map_err(|e| ApiError::io("Start core output reader", e))?;
    Ok(())
}

pub fn spawn_owned(
    exe: &Path,
    owner: &str,
    input: &Value,
    arguments: &str,
    events: Option<Arc<Events>>,
    generation: u64,
) -> Result<CoreProcess> {
    spawn_with_token(
        exe,
        owner_token(owner)?,
        input,
        arguments,
        events,
        generation,
    )
}
pub(crate) fn spawn_with_token(
    exe: &Path,
    token: Handle,
    input: &Value,
    arguments: &str,
    events: Option<Arc<Events>>,
    generation: u64,
) -> Result<CoreProcess> {
    spawn_tun_with_token(
        exe,
        token,
        input,
        arguments,
        events,
        generation,
        TunOptions {
            metadata: None,
            fakedns: None,
            reuse_settings: false,
            assets: exe.parent().unwrap(),
        },
    )
}
pub(crate) struct TunOptions<'a> {
    pub metadata: Option<&'a str>,
    pub fakedns: Option<&'a str>,
    pub reuse_settings: bool,
    pub assets: &'a Path,
}
pub(crate) fn spawn_tun_with_token(
    exe: &Path,
    token: Handle,
    input: &Value,
    arguments: &str,
    events: Option<Arc<Events>>,
    generation: u64,
    options: TunOptions<'_>,
) -> Result<CoreProcess> {
    let TunOptions {
        metadata,
        fakedns,
        reuse_settings,
        assets,
    } = options;
    let user_sid = token_sid(token.0)?;
    unsafe {
        let job = Handle(CreateJobObjectW(ptr::null(), ptr::null()));
        if job.0.is_null() {
            return Err(os_error("Create core job"));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY;
        // The fixed user-settings helper can launch one bounded netsh child.
        // Xray and every other helper retain the one-process containment limit.
        limits.BasicLimitInformation.ActiveProcessLimit = if arguments == "--system-settings-helper"
        {
            2
        } else {
            1
        };
        limits.JobMemoryLimit = if arguments == "--subscription-worker" {
            1536
        } else {
            768
        } * 1024
            * 1024;
        if SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            return Err(os_error("Set core job limits"));
        }
        let (stdin_read, stdin_write) = pipe_pair()?;
        let (stdout_read, stdout_write) = pipe_pair()?;
        let (stderr_read, stderr_write) = pipe_pair()?;
        for handle in [&stdin_write, &stdout_read, &stderr_read] {
            if SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0) == 0 {
                return Err(os_error("Restrict pipe inheritance"));
            }
        }
        let mut size = 0;
        InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
        let mut attrs =
            vec![0usize; (size + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
        let attr = attrs.as_mut_ptr().cast();
        if InitializeProcThreadAttributeList(attr, 1, 0, &mut size) == 0 {
            return Err(os_error("Create inherited-handle list"));
        }
        let inherited = [stdin_read.0, stdout_write.0, stderr_write.0];
        if UpdateProcThreadAttribute(
            attr,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited.as_ptr().cast(),
            std::mem::size_of_val(&inherited),
            ptr::null_mut(),
            ptr::null(),
        ) == 0
        {
            DeleteProcThreadAttributeList(attr);
            return Err(os_error("Limit inherited handles"));
        }
        let mut startup: STARTUPINFOEXW = std::mem::zeroed();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin_read.0;
        startup.StartupInfo.hStdOutput = stdout_write.0;
        startup.StartupInfo.hStdError = stderr_write.0;
        startup.lpAttributeList = attr;
        let app = wide(&exe.to_string_lossy());
        let dir = wide(&exe.parent().unwrap().to_string_lossy());
        let mut command = wide(&format!("\"{}\" {arguments}", exe.display()));
        // A minimal service-owned environment avoids inherited Xray asset/config overrides.
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let real_dns = fakedns
            .and_then(|_| input["inbounds"].as_array())
            .and_then(|inputs| {
                inputs
                    .iter()
                    .find(|i| {
                        i["tag"]
                            .as_str()
                            .is_some_and(|t| t.starts_with("wr-tun-resolver-native-"))
                    })
                    .and_then(|i| i["port"].as_u64())
                    .map(|port| format!("wayrill-dns://127.0.0.1:{port}"))
                    .or_else(|| {
                        input["dns"]["servers"].as_array().and_then(|servers| {
                            servers
                                .iter()
                                .filter_map(|s| s.as_str())
                                .find(|s| s.starts_with("wayrill-dns://127.0.0.1:"))
                                .map(str::to_owned)
                        })
                    })
            })
            .unwrap_or_default();
        let mut environment: Vec<u16> = format!(
            "SystemRoot={system_root}\0XRAY_LOCATION_ASSET={}\0WAYRILL_TUN_METADATA={}\0WAYRILL_TUN_REUSE_SETTINGS={}\0WAYRILL_FAKEDNS={}\0WAYRILL_REAL_DNS={real_dns}\0\0",
            assets.display(),
            metadata.unwrap_or(""),
            if reuse_settings { "1" } else { "0" },
            fakedns.unwrap_or("")
        )
        .encode_utf16()
        .collect();
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessAsUserW(
            token.0,
            app.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_mut_ptr().cast(),
            dir.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        );
        let create_error = std::io::Error::last_os_error();
        DeleteProcThreadAttributeList(attr);
        if ok == 0 {
            return Err(ApiError::io("Launch unprivileged Xray", create_error));
        }
        let process = Handle(info.hProcess);
        let thread = Handle(info.hThread);
        if AssignProcessToJobObject(job.0, process.0) == 0 {
            TerminateProcess(process.0, 1);
            return Err(os_error("Contain Xray process"));
        }
        if ResumeThread(thread.0) == u32::MAX {
            return Err(os_error("Resume Xray"));
        }
        drop(thread);
        drop(stdin_read);
        drop(stdout_write);
        drop(stderr_write);
        let output = Arc::new(CoreOutput {
            reply: Mutex::new((arguments == "--subscription-worker").then(String::new)),
            origin: info.dwProcessId,
            helper: helper_output(arguments),
            source: if input["inbounds"]
                .as_array()
                .is_some_and(|inbounds| inbounds.iter().any(|i| i["protocol"] == "tun"))
            {
                "TUN"
            } else {
                "Xray"
            },
            relay_routing: events.is_none()
                && input["log"]["loglevel"] == "info"
                && input["inbounds"]
                    .as_array()
                    .is_some_and(|inbounds| inbounds.iter().any(|i| i["protocol"] == "tun")),
            ..Default::default()
        });
        let core = CoreProcess {
            pid: info.dwProcessId,
            user_sid,
            process,
            job,
            lines: output.lines.clone(),
            output: output.clone(),
        };
        collect_output(
            file(stdout_read),
            output.clone(),
            events.clone(),
            generation,
        )?;
        collect_output(file(stderr_read), output, events, generation)?;
        let bytes =
            serde_json::to_vec(input).map_err(|e| ApiError::io("Serialize process input", e))?;
        std::thread::Builder::new()
            .name("wayrill-core-input".into())
            .spawn(move || {
                let _ = file(stdin_write).write_all(&bytes);
            })
            .map_err(|e| ApiError::io("Start core input writer", e))?;
        Ok(core)
    }
}
pub fn spawn_core(
    exe: &Path,
    identity: CoreIdentity<'_>,
    config: &Value,
    test: bool,
    events: Option<Arc<Events>>,
    generation: u64,
) -> Result<CoreProcess> {
    spawn_verified_core(
        exe,
        identity,
        config,
        if test {
            "run -test -format json -config stdin:"
        } else {
            "run -format json -config stdin:"
        },
        events,
        generation,
        None,
    )
}
pub fn spawn_core_with_fakedns(
    exe: &Path,
    identity: CoreIdentity<'_>,
    config: &Value,
    fakedns: Option<&str>,
    events: Option<Arc<Events>>,
    generation: u64,
) -> Result<CoreProcess> {
    spawn_verified_core(
        exe,
        identity,
        config,
        "run -format json -config stdin:",
        events,
        generation,
        fakedns,
    )
}
fn spawn_verified_core(
    exe: &Path,
    identity: CoreIdentity<'_>,
    config: &Value,
    arguments: &str,
    events: Option<Arc<Events>>,
    generation: u64,
    fakedns: Option<&str>,
) -> Result<CoreProcess> {
    verify_hash(exe, XRAY_SHA)?;
    spawn_tun_with_token(
        exe,
        identity.token()?,
        config,
        arguments,
        events,
        generation,
        TunOptions {
            metadata: None,
            fakedns,
            reuse_settings: false,
            assets: exe.parent().unwrap(),
        },
    )
}

pub fn validate_core(exe: &Path, identity: CoreIdentity<'_>, config: &Value) -> Result<()> {
    let core = spawn_core(exe, identity, config, true, None, 0)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(code) = core.exit_code()? {
            if code == 0 {
                return Ok(());
            }
            return Err(ApiError::new(
                "XRAY_CONFIG_INVALID",
                format!(
                    "Xray rejected the configuration (exit {code}). {}",
                    core.lines.lock().unwrap().join("")
                ),
            ));
        }
        if Instant::now() >= deadline {
            return Err(ApiError::new(
                "TIMEOUT",
                "Xray validation exceeded twenty seconds.",
            ));
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;
    #[test]
    fn embedded_core_identity_matches_the_release_pin() {
        let pin: Value = serde_json::from_str(include_str!("../../dependencies.json")).unwrap();
        assert_eq!(XRAY_VERSION, pin["xray"]["version"].as_str().unwrap());
        assert_eq!(
            XRAY_SHA,
            pin["xray"]["executableSha256"]
                .as_str()
                .unwrap()
                .to_lowercase()
        );
    }

    #[test]
    fn helper_replies_stay_private_even_when_the_payload_resembles_core_output() {
        for arguments in [
            "--proxy-helper",
            "--system-settings-helper",
            "wayrill-fakedns",
        ] {
            let output = CoreOutput {
                helper: helper_output(arguments),
                relay_routing: true,
                ..Default::default()
            };
            let events = Events::new();
            let reply = "2026/10/21 12:00:00 [Warning] core: Xray example started";
            output.observe(reply.into(), Some(&events), 1);
            output.observe("{\"privateReply\":true}".into(), Some(&events), 1);
            assert_eq!(output.lines.lock().unwrap()[0], reply);
            assert_eq!(output.lines.lock().unwrap().len(), 2);
            assert!(!output.started.load(Ordering::Acquire));
            assert!(output.routing.lock().unwrap().is_empty());
            assert_eq!(events.subscribe(0, None).0, 0);
        }
        assert!(!helper_output("run -test"));
    }

    #[test]
    fn readiness_survives_a_full_diagnostic_tail() {
        let output = CoreOutput::default();
        output.observe(
            "2026/10/13 12:01:02 [Warning] core: Xray 26.9.30 started\r\n".into(),
            None,
            1,
        );
        for _ in 0..128 {
            output.observe("accepted tcp:127.0.0.1:1234\r\n".into(), None, 1);
        }
        assert_eq!(output.lines.lock().unwrap().len(), 64);
        assert!(!output
            .lines
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.contains("started")));
        assert!(output.started.load(Ordering::Acquire));
    }
    #[test]
    fn keeper_output_retains_only_bounded_routing_decisions() {
        let output = CoreOutput {
            relay_routing: true,
            ..Default::default()
        };
        output.observe(
            "2026/10/13 12:01:02 [Info] proxy/socks: account SECRET\r\n".into(),
            None,
            1,
        );
        for index in 0..1005 {
            output.observe(format!("2026/10/13 12:01:02.123 [Info] [345] app/dispatcher: Hit route rule: [wr-route-1-0] so taking detour [wr-tun-1] for [tcp:example.org:{index}]\r\n"), None, 1);
        }
        let mut rows = output.routing.lock().unwrap();
        assert_eq!(rows.len(), 1000);
        assert!(rows.front().unwrap().contains("example.org:5]"));
        assert!(rows.back().unwrap().contains("example.org:1004]"));
        assert!(!rows.iter().any(|s| s.contains("SECRET")));
        assert!(output.lines.lock().unwrap().is_empty());
        assert_eq!(rows.drain(..).count(), 1000);
        assert!(rows.is_empty());
    }
    fn chunks(bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        read_output(bytes, |text| out.push(text)).unwrap();
        assert!(out.iter().all(|text| text.len() <= 8192));
        out
    }
    #[test]
    fn utf8_characters_survive_every_chunk_boundary() {
        for name in ["Имя", "中文", "نام", "日本語", "🌍"] {
            for offset in 0..=4 {
                let text = format!(
                    "{}{}{}\r\nnext",
                    "x".repeat(8192 - offset),
                    name,
                    name.repeat(8192)
                );
                assert_eq!(chunks(text.as_bytes()).concat(), text);
            }
        }
    }
    #[test]
    fn helper_json_preserves_spaces_and_unicode_inside_long_strings() {
        let value =
            json!({"bypass": format!("{} 中文 نام 🌍 ", "x".repeat(8190)), "next": " Имя "});
        let text = serde_json::to_string_pretty(&value).unwrap();
        let restored = chunks(text.as_bytes()).concat();
        assert_eq!(restored, text);
        assert_eq!(serde_json::from_str::<Value>(&restored).unwrap(), value);
        assert_eq!(chunks(b"\r\n \t\r\n").concat(), "\r\n \t\r\n");
    }
    #[test]
    fn incomplete_and_invalid_utf8_still_produces_bounded_diagnostics() {
        for input in [b"error: \xf0\x9f\x8c".as_slice(), b"\xfferror\r\n", b"\xd0"] {
            assert_eq!(chunks(input).concat(), String::from_utf8_lossy(input));
        }
        assert!(chunks(b"").is_empty());
    }
}
