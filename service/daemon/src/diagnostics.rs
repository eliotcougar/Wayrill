use serde_json::{json, Value};
use std::io::Read;
pub use wayrill_diagnostics::{flush, log};
use wayrill_protocol::{ApiError, Result};
macro_rules! error {
    ($($argument:tt)*) => {{
        let message = format!($($argument)*);
        $crate::diagnostics::log(module_path!(), "error", &message);
        eprintln!("{message}");
    }};
}
pub(crate) use error;

pub fn initialize(source: &str) {
    if let Err(error) =
        wayrill_diagnostics::initialize(&wayrill_diagnostics::service_directory(), source)
    {
        eprintln!("Diagnostic logging unavailable: {error}");
    }
    wayrill_diagnostics::panic_hook("service");
}
pub fn output(input: impl Read + Send + 'static, component: &'static str) -> Result<()> {
    std::thread::Builder::new()
        .name(format!("wayrill-{component}-diagnostics"))
        .spawn(move || {
            if let Err(error) =
                crate::native::read_output(input, |text| log(component, "warning", text.trim()))
            {
                log(
                    component,
                    "error",
                    &format!("Diagnostic pipe closed: {error}"),
                );
            }
        })
        .map_err(|e| ApiError::io("Start diagnostic reader", e))?;
    Ok(())
}
/// Deliberate projection: never persist complete snapshots, configurations,
/// routing decisions, statistics or authenticated IPC request/response bodies.
pub fn event(kind: &str, payload: &Value) {
    if !matches!(
        kind,
        "resources.updated"
            | "resources.failed"
            | "resources.runtimeUnchanged"
            | "resources.runtimeReloaded"
            | "resources.runtimeReloadFailed"
            | "service.ready"
            | "upgrade.completed"
            | "core.state"
            | "capture.failed"
            | "tun.failed"
            | "network.failed"
            | "runtime.progress"
    ) {
        return;
    }
    log("lifecycle", if payload["core"]["state"] == "failed" || payload["ok"] == false || kind.ends_with("Failed") || kind.ends_with(".failed") { "error" } else { "info" },
        &json!({"event":kind,"state":payload["core"]["state"],"phase":payload["phase"],
            "lifecycle":payload["lifecycle"],"error":payload.get("error").unwrap_or(&payload["core"]["lastError"]),
            "upgradeOk":payload["ok"],"upgradeCore":payload["core"].as_str(),
            "adapterError":payload["tun"]["adapterRecoveryError"],"sharingError":payload["tun"]["sharing"]["lastError"],
            "resourceFiles":payload["files"],"resourceGeneration":payload["resources"]["generation"],
            "resourceReloadError":payload["resources"]["reloadError"]}).to_string());
}
pub fn sampling_due() -> bool {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let Ok(mut last) = LAST.lock() else {
        return false;
    };
    if last.is_some_and(|time| time.elapsed() < std::time::Duration::from_secs(60)) {
        return false;
    }
    *last = Some(std::time::Instant::now());
    true
}
pub fn process(component: &str, pid: u32) {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::{ProcessStatus::*, Threading::*};
    // SAFETY: query-only access to an observed owned process; the handle is
    // released by its RAII owner. Every output buffer has its stated size.
    let value = unsafe {
        let handle = crate::native::Handle(OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            0,
            pid,
        ));
        if handle.0.is_null() {
            return;
        }
        let mut memory = PROCESS_MEMORY_COUNTERS_EX::default();
        memory.cb = std::mem::size_of_val(&memory) as u32;
        let mut handles = 0;
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        if K32GetProcessMemoryInfo(
            handle.0,
            (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            memory.cb,
        ) == 0
            || GetProcessHandleCount(handle.0, &mut handles) == 0
            || GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) == 0
        {
            return;
        }
        let ticks = |value: FILETIME| {
            (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
        };
        json!({"process":component,"pid":pid,"created":ticks(created),"privateBytes":memory.PrivateUsage,
            "workingSetBytes":memory.WorkingSetSize,"peakWorkingSetBytes":memory.PeakWorkingSetSize,
            "handles":handles,"cpuKernel100ns":ticks(kernel),"cpuUser100ns":ticks(user)})
    };
    log("resources", "info", &value.to_string());
}
pub fn snapshot(snapshot: &Value) {
    process("service", std::process::id());
    for (component, pid) in [
        ("xray", &snapshot["core"]["pid"]),
        ("tun", &snapshot["tun"]["pid"]),
        ("sharing", &snapshot["tun"]["keeperPid"]),
        ("ics-tun", &snapshot["tun"]["sharedPid"]),
        ("fakedns", &snapshot["fakeDns"]["pid"]),
    ] {
        if let Some(pid) = pid.as_u64().and_then(|n| u32::try_from(n).ok()) {
            process(component, pid);
        }
    }
}

pub fn job(component: &str, pid: u32, job: &crate::native::Handle, exit_code: Option<i32>) {
    use windows_sys::Win32::System::JobObjects::*;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // SAFETY: borrowed owned job; the fixed output struct and size agree.
    if unsafe {
        QueryInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
            std::ptr::null_mut(),
        )
    } != 0
    {
        log("resources","info",&json!({"process":component,"pid":pid,"exitCode":exit_code,"jobPeakBytes":limits.PeakJobMemoryUsed,"jobLimitBytes":limits.JobMemoryLimit}).to_string());
    }
}
