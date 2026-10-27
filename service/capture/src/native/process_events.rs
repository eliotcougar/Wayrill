// SPDX-License-Identifier: GPL-3.0-only
//! Installation-scoped process observation. Event loss requests a complete
//! process-table reconciliation; malformed events/native failures stay fatal.
use super::{from_win32, now_filetime, owned_handle, wide, win32};
use crate::{
    events::{EventBatch, EventQueue},
    process::ProcessInfo,
    process_event, Error, Result,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    os::windows::io::{AsRawHandle, OwnedHandle},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
};
use tokio::sync::Notify;
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::{ERROR_ALREADY_EXISTS, ERROR_CTX_CLOSE_PENDING, ERROR_WMI_INSTANCE_NOT_FOUND},
        Globalization::{LCMapStringEx, LCMAP_UPPERCASE, LOCALE_NAME_INVARIANT},
        System::{
            Diagnostics::Etw::*,
            Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
        },
    },
};

const PROVIDER: GUID = GUID::from_u128(0x22fb2cd6_0e7b_422b_a0c7_2fad1fd0e716);
#[derive(Clone, Copy)]
pub enum Scope {
    Capture,
    Tun,
}
#[repr(C)]
struct Properties {
    native: EVENT_TRACE_PROPERTIES,
    name: [u16; 1024],
}
impl Properties {
    fn new(name: &[u16]) -> Self {
        let mut value = Self {
            native: EVENT_TRACE_PROPERTIES::default(),
            name: [0; 1024],
        };
        value.name[..name.len()].copy_from_slice(name);
        value.native.Wnode.BufferSize = std::mem::size_of::<Self>() as u32;
        value.native.Wnode.ClientContext = 1; // raw QPC, same clock as WinDivert
        value.native.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        value.native.BufferSize = 64;
        value.native.MinimumBuffers = 64;
        value.native.MaximumBuffers = 128;
        // Other consumers of this provider must not suppress our events when
        // their sessions fill. QPC timestamps allow normal per-CPU buffering;
        // a common buffer unnecessarily serializes concurrent process bursts.
        value.native.LogFileMode =
            EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_INDEPENDENT_SESSION_MODE;
        value.native.FlushTimer = 1;
        value.native.LoggerNameOffset = std::mem::offset_of!(Properties, name) as u32;
        value
    }
}
fn name(scope: Scope) -> Result<Vec<u16>> {
    let path = std::env::current_exe()?;
    let root = path
        .parent()
        .ok_or_else(|| Error::invalid("Process observer installation unavailable."))?;
    let text = format!("{}\\", root.to_string_lossy());
    let source = wide(&text);
    let mut upper = vec![0; source.len() * 3];
    // SAFETY: invariant case mapping over explicit UTF-16 buffers, no pointers retained.
    let count = unsafe {
        LCMapStringEx(
            LOCALE_NAME_INVARIANT,
            LCMAP_UPPERCASE,
            source.as_ptr(),
            source.len() as i32,
            upper.as_mut_ptr(),
            upper.len() as i32,
            std::ptr::null(),
            std::ptr::null(),
            0,
        )
    };
    if count == 0 {
        return Err(win32());
    }
    let upper = String::from_utf16_lossy(&upper[..count as usize - 1]);
    let hash = Sha256::digest(upper.as_bytes());
    let installation = hash[..8]
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<String>();
    let suffix = match scope {
        Scope::Capture => "",
        Scope::Tun => ".TUN",
    };
    Ok(wide(&format!(
        "v2rayN.ApplicationRouting.Processes.{installation}{suffix}"
    )))
}
struct Owner(OwnedHandle);
impl Owner {
    fn acquire(name: &[u16]) -> Result<Self> {
        let name = wide(&format!("Global\\{}", super::read_wide(name)));
        // SAFETY: fixed installation-scoped name; newly returned mutex handle is adopted.
        let handle = owned_handle(unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) })?;
        // SAFETY: live mutex handle, zero timeout; ownership remains on this worker thread.
        match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
            0 | 128 => Ok(Self(handle)),
            258 => Err(Error::invalid(
                "Application-routing process observation is already in use.",
            )),
            _ => Err(win32()),
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        // SAFETY: only created after successful wait; released on the owning thread.
        unsafe {
            ReleaseMutex(self.0.as_raw_handle());
        }
    }
}
struct Control {
    session: Option<u64>,
    consumer: Option<u64>,
    name: Vec<u16>,
    losses: [u32; 2],
    cleanup_error: Option<Error>,
}
impl Control {
    fn health(&mut self, flush: bool) -> Result<bool> {
        let handle = self
            .session
            .ok_or_else(|| Error::invalid("Process observer is not running."))?;
        let mut properties = Properties::new(&self.name);
        // SAFETY: owned session handle and complete aligned properties allocation.
        let code = unsafe {
            ControlTraceW(
                CONTROLTRACE_HANDLE { Value: handle },
                std::ptr::null(),
                &mut properties.native,
                if flush {
                    EVENT_TRACE_CONTROL_FLUSH
                } else {
                    EVENT_TRACE_CONTROL_QUERY
                },
            )
        };
        if code != 0 {
            return Err(from_win32(code));
        }
        // Windows reports lifetime counters. A past loss must not poison every
        // subsequent refresh; acknowledge each change only with a new snapshot.
        let losses = [
            properties.native.EventsLost,
            properties.native.RealTimeBuffersLost,
        ];
        let changed = std::mem::replace(&mut self.losses, losses) != losses;
        if changed {
            eprintln!(
                "Process ETW event loss: events={}, buffers={}; free={}/{}, max={}, size={} KiB, written={}, mode=0x{:08x}; reconciling native identities.",
                losses[0], losses[1], properties.native.FreeBuffers,
                properties.native.NumberOfBuffers, properties.native.MaximumBuffers,
                properties.native.BufferSize, properties.native.BuffersWritten,
                properties.native.LogFileMode,
            );
        }
        Ok(changed)
    }
    fn stop(&mut self) {
        if let Some(handle) = self.session.take() {
            let mut properties = Properties::new(&self.name);
            // SAFETY: stop only our owned numeric session, never a supplied/foreign name.
            let code = unsafe {
                ControlTraceW(
                    CONTROLTRACE_HANDLE { Value: handle },
                    std::ptr::null(),
                    &mut properties.native,
                    EVENT_TRACE_CONTROL_STOP,
                )
            };
            if code != 0 && code != ERROR_WMI_INSTANCE_NOT_FOUND {
                self.cleanup_error.get_or_insert_with(|| from_win32(code));
            }
        }
        if let Some(handle) = self.consumer.take() {
            // SAFETY: this sole consumer reference is closed once. CloseTrace permits
            // a concurrent ProcessTrace to finish before its callback context drops.
            let code = unsafe { CloseTrace(PROCESSTRACE_HANDLE { Value: handle }) };
            // Pending is successful asynchronous closure on supported Windows.
            if code != 0 && code != ERROR_CTX_CLOSE_PENDING {
                self.cleanup_error.get_or_insert_with(|| from_win32(code));
            }
        }
    }
}
struct Context {
    queue: Arc<EventQueue<ProcessInfo>>,
    changed: Arc<Notify>,
    stopping: Arc<AtomicBool>,
    failed: AtomicBool,
}
impl Context {
    fn fail(&self, error: Error) {
        let _ = self.queue.fail(error);
        self.failed.store(true, Ordering::Release);
        self.changed.notify_one();
    }
}
unsafe extern "system" fn event_callback(pointer: *mut EVENT_RECORD) {
    if pointer.is_null() {
        return;
    }
    // SAFETY: Windows supplies a valid EVENT_RECORD for this callback's lifetime.
    let event = unsafe { &*pointer };
    if event.UserContext.is_null() {
        return;
    }
    // SAFETY: OpenTrace receives the Context address, which remains boxed until
    // ProcessTrace returns and the sole consumer reference has been closed.
    let context = unsafe { &*event.UserContext.cast::<Context>() };
    let decoded = catch_unwind(AssertUnwindSafe(|| -> Result<()> {
        let header = &event.EventHeader;
        let provider = &header.ProviderId;
        if provider.data1 != PROVIDER.data1
            || provider.data2 != PROVIDER.data2
            || provider.data3 != PROVIDER.data3
            || provider.data4 != PROVIDER.data4
            || !matches!(header.EventDescriptor.Id, 1 | 2)
        {
            return Ok(());
        }
        if event.UserDataLength == 0 || event.UserData.is_null() {
            return Err(Error::invalid("Empty process event payload."));
        }
        // SAFETY: Windows owns exactly UserDataLength readable bytes until return.
        let payload = unsafe {
            std::slice::from_raw_parts(event.UserData.cast::<u8>(), event.UserDataLength as usize)
        };
        let info = process_event::decode(
            header.EventDescriptor.Id,
            header.EventDescriptor.Version,
            header.TimeStamp,
            payload,
            // Keep the ETW callback bounded. Drive/package resolution can call
            // Windows repeatedly and must run on the snapshot reader instead.
            |image| Some(image.to_owned()),
            |package| Some(package.to_owned()),
        )?;
        let bytes = info.resident_bytes();
        context.queue.add_sized(info, bytes)?;
        context.changed.notify_one();
        Ok(())
    }));
    match decoded {
        Ok(Ok(())) => {}
        Ok(Err(error)) => context.fail(error),
        Err(_) => context.fail(Error::invalid("Process event callback panicked.")),
    }
}
unsafe extern "system" fn buffer_callback(pointer: *mut EVENT_TRACE_LOGFILEW) -> u32 {
    if pointer.is_null() {
        return 0;
    }
    // SAFETY: live ETW callback logfile and its exact owned Context reference.
    let logfile = unsafe { &*pointer };
    if logfile.Context.is_null() {
        return 0;
    }
    // SAFETY: same Context lifetime as event_callback, released only after drain.
    let context = unsafe { &*logfile.Context.cast::<Context>() };
    u32::from(!context.stopping.load(Ordering::Acquire) && !context.failed.load(Ordering::Acquire))
}

pub struct ProcessEvents {
    pub started: i64,
    queue: Arc<EventQueue<ProcessInfo>>,
    stopping: Arc<AtomicBool>,
    control: Arc<Mutex<Control>>,
    reader: Option<JoinHandle<()>>,
}
impl ProcessEvents {
    pub fn open(scope: Scope, changed: Arc<Notify>) -> Result<Self> {
        let queue = Arc::new(EventQueue::new("process"));
        let stopping = Arc::new(AtomicBool::new(false));
        let control = Arc::new(Mutex::new(Control {
            session: None,
            consumer: None,
            name: name(scope)?,
            losses: [0; 2],
            cleanup_error: None,
        }));
        let (ready, received) = mpsc::sync_channel(1);
        let context = Box::new(Context {
            queue: queue.clone(),
            changed,
            stopping: stopping.clone(),
            failed: AtomicBool::new(false),
        });
        let worker_control = control.clone();
        let reader = thread::Builder::new()
            .name("capture-processes".into())
            .spawn(move || {
                let mut owner = None;
                let run = || -> Result<()> {
                    let name = worker_control
                        .lock()
                        .map_err(|_| Error::invalid("Process observer state poisoned."))?
                        .name
                        .clone();
                    owner = Some(Owner::acquire(&name)?);
                    let mut properties = Properties::new(&name);
                    let mut session = CONTROLTRACE_HANDLE { Value: 0 };
                    // SAFETY: initialized properties with logger-name storage and valid handle output.
                    let mut code =
                        unsafe { StartTraceW(&mut session, name.as_ptr(), &mut properties.native) };
                    if code == ERROR_ALREADY_EXISTS {
                        // Our mutex is owned, so this exact installation-scoped
                        // session is an orphan from an earlier crash, not a live owner.
                        let mut old = Properties::new(&name);
                        // SAFETY: fixed owned session name, guarded by its mutex.
                        let stopped = unsafe {
                            ControlTraceW(
                                CONTROLTRACE_HANDLE { Value: 0 },
                                name.as_ptr(),
                                &mut old.native,
                                EVENT_TRACE_CONTROL_STOP,
                            )
                        };
                        if stopped != 0 && stopped != ERROR_WMI_INSTANCE_NOT_FOUND {
                            return Err(from_win32(stopped));
                        }
                        properties = Properties::new(&name);
                        // SAFETY: fresh full properties and owned output after orphan cleanup.
                        code = unsafe {
                            StartTraceW(&mut session, name.as_ptr(), &mut properties.native)
                        };
                    }
                    if code != 0 {
                        return Err(from_win32(code));
                    }
                    worker_control
                        .lock()
                        .map_err(|_| Error::invalid("Process observer state poisoned."))?
                        .session = Some(session.Value);
                    let mut logger_name = name;
                    let mut logfile = EVENT_TRACE_LOGFILEW {
                        LoggerName: logger_name.as_mut_ptr(),
                        Context: (&*context as *const Context).cast_mut().cast(),
                        BufferCallback: Some(buffer_callback),
                        ..Default::default()
                    };
                    logfile.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME
                        | PROCESS_TRACE_MODE_EVENT_RECORD
                        | PROCESS_TRACE_MODE_RAW_TIMESTAMP;
                    logfile.Anonymous2.EventRecordCallback = Some(event_callback);
                    // SAFETY: logfile has live name/context storage and correctly typed callbacks.
                    let consumer = unsafe { OpenTraceW(&mut logfile) };
                    if consumer.Value == u64::MAX {
                        return Err(win32());
                    }
                    worker_control
                        .lock()
                        .map_err(|_| Error::invalid("Process observer state poisoned."))?
                        .consumer = Some(consumer.Value);
                    #[repr(C)]
                    struct Filter {
                        enabled: u8,
                        reserved: u8,
                        count: u16,
                        ids: [u16; 2],
                    }
                    let filter = Filter {
                        enabled: 1,
                        reserved: 0,
                        count: 2,
                        ids: [1, 2],
                    };
                    let mut descriptor = EVENT_FILTER_DESCRIPTOR {
                        Ptr: (&filter as *const Filter) as u64,
                        Size: std::mem::size_of::<Filter>() as u32,
                        Type: EVENT_FILTER_TYPE_EVENT_ID,
                    };
                    let parameters = ENABLE_TRACE_PARAMETERS {
                        Version: ENABLE_TRACE_PARAMETERS_VERSION_2,
                        EnableFilterDesc: &mut descriptor,
                        FilterDescCount: 1,
                        ..Default::default()
                    };
                    let started = now_filetime();
                    // SAFETY: fixed provider/keyword/IDs; filter buffers live until this
                    // synchronous enable call returns. No unrelated provider is modified.
                    let code = unsafe {
                        EnableTraceEx2(
                            session,
                            &PROVIDER,
                            EVENT_CONTROL_CODE_ENABLE_PROVIDER,
                            4,
                            0x10,
                            0,
                            1000,
                            &parameters,
                        )
                    };
                    if code != 0 {
                        return Err(from_win32(code));
                    }
                    let _ = ready.send(Ok(started));
                    // SAFETY: owned real-time consumer, callback context and logger
                    // buffers live through this blocking call and are never moved.
                    let code =
                        unsafe { ProcessTrace(&consumer, 1, std::ptr::null(), std::ptr::null()) };
                    if !context.stopping.load(Ordering::Acquire) {
                        return Err(if code != 0 {
                            from_win32(code)
                        } else {
                            Error::invalid(
                                "Application-routing process observation stopped unexpectedly.",
                            )
                        });
                    }
                    Ok(())
                };
                let result = catch_unwind(AssertUnwindSafe(run))
                    .unwrap_or_else(|_| Err(Error::invalid("Process observer thread panicked.")));
                if let Err(error) = result {
                    context.fail(error.clone());
                    let _ = ready.send(Err(error));
                }
                worker_control
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .stop();
                // Keep the installation mutex through native cleanup, including
                // partial startup, before a replacement may reclaim the name.
                drop(owner);
            })?;
        let mut observer = Self {
            started: 0,
            queue,
            stopping,
            control,
            reader: Some(reader),
        };
        observer.started = received
            .recv()
            .map_err(|_| Error::invalid("Process observer failed before startup."))??;
        Ok(observer)
    }
    pub fn drain(&self, flush: bool) -> Result<EventBatch<ProcessInfo>> {
        let mut batch = self.queue.drain_reconciling(|| {
            if !self.stopping.load(Ordering::Acquire)
                && self
                    .reader
                    .as_ref()
                    .is_some_and(|reader| reader.is_finished())
            {
                return Err(Error::invalid(
                    "Process observer thread ended unexpectedly.",
                ));
            }
            let mut control = self
                .control
                .lock()
                .map_err(|_| Error::invalid("Process observer state poisoned."))?;
            control.health(flush)
        })?;
        let mut paths = HashMap::new();
        let mut packages = HashMap::new();
        for info in &mut batch.items {
            if let Some(path) = info.path.take() {
                info.path = paths
                    .entry(path.clone())
                    .or_insert_with(|| super::processes::normalize_image(&path))
                    .clone();
            }
            if let Some(package) = info.package.take() {
                info.package = packages
                    .entry(package.clone())
                    .or_insert_with(|| super::processes::family_from_full_name(&package))
                    .clone();
            }
        }
        Ok(batch)
    }
    pub fn close(&mut self) -> Result<()> {
        self.stopping.store(true, Ordering::Release);
        self.control
            .lock()
            // Poisoned state may be used only for teardown, never attribution.
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stop();
        if let Some(reader) = self.reader.take() {
            reader
                .join()
                .map_err(|_| Error::invalid("Process observer thread panicked."))?;
        }
        self.control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cleanup_error
            .clone()
            .map_or(Ok(()), Err)
    }
}
impl Drop for ProcessEvents {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_failure_is_not_erased_by_repeated_close() {
        let mut observer = ProcessEvents {
            started: 0,
            queue: Arc::new(EventQueue::new("process")),
            stopping: Arc::new(AtomicBool::new(false)),
            control: Arc::new(Mutex::new(Control {
                session: None,
                consumer: None,
                name: Vec::new(),
                losses: [0; 2],
                cleanup_error: Some(Error::invalid("injected cleanup failure")),
            })),
            reader: Some(thread::spawn(|| {})),
        };
        assert!(observer
            .close()
            .unwrap_err()
            .to_string()
            .contains("injected cleanup failure"));
        assert!(observer.reader.is_none());
        assert!(observer.close().is_err());
    }
    #[test]
    #[ignore = "Opt-in QA VM ETW lifecycle; WAYRILL_PROCESS_EVENTS_VM_TEST=1"]
    fn native_repeated_observer_retirement_releases_sessions_and_handles() {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
        assert_eq!(
            std::env::var("WAYRILL_PROCESS_EVENTS_VM_TEST").as_deref(),
            Ok("1")
        );
        super::super::observation::enable().unwrap();
        let handles = || {
            let mut count = 0;
            assert_ne!(
                // SAFETY: borrowed current-process pseudo-handle and valid output.
                unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) },
                0
            );
            count
        };
        // Exclude Windows' one-time ETW library initialization from leak counts.
        ProcessEvents::open(Scope::Tun, Arc::new(Notify::new()))
            .unwrap()
            .close()
            .unwrap();
        let before = handles();
        for cycle in 0..20 {
            let mut observer = ProcessEvents::open(Scope::Tun, Arc::new(Notify::new())).unwrap();
            observer.drain(true).unwrap();
            if cycle == 10 {
                let handle = observer.control.lock().unwrap().session.unwrap();
                let mut properties = Properties::new(&name(Scope::Tun).unwrap());
                // SAFETY: simulate external retirement of this test's own numeric session.
                let code = unsafe {
                    ControlTraceW(
                        CONTROLTRACE_HANDLE { Value: handle },
                        std::ptr::null(),
                        &mut properties.native,
                        EVENT_TRACE_CONTROL_STOP,
                    )
                };
                assert_eq!(code, 0);
            }
            observer.close().unwrap();
            observer.close().unwrap();
            let name = name(Scope::Tun).unwrap();
            let mut properties = Properties::new(&name);
            // SAFETY: query only this fixture's exact installation-scoped session.
            let code = unsafe {
                ControlTraceW(
                    CONTROLTRACE_HANDLE { Value: 0 },
                    name.as_ptr(),
                    &mut properties.native,
                    EVENT_TRACE_CONTROL_QUERY,
                )
            };
            assert_eq!(
                code, ERROR_WMI_INSTANCE_NOT_FOUND,
                "session remained after cycle {cycle}"
            );
        }
        let after = handles();
        eprintln!("ETW lifecycle: cycles=20, handles_before={before}, handles_after={after}");
        assert!(after <= before + 2, "Observer handles accumulated");
    }
    #[test]
    fn session_is_isolated_and_uses_qpc_with_per_processor_buffers() {
        let p = Properties::new(&wide("Wayrill.QA.Properties"));
        assert_eq!(
            p.native.LogFileMode,
            EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_INDEPENDENT_SESSION_MODE
        );
        assert_eq!(p.native.Wnode.ClientContext, 1);
        assert_eq!(
            (
                p.native.BufferSize,
                p.native.MinimumBuffers,
                p.native.MaximumBuffers
            ),
            (64, 64, 128)
        );
    }
    #[test]
    fn poisoned_control_still_closes_and_joins_the_reader() {
        let control = Arc::new(Mutex::new(Control {
            session: None,
            consumer: None,
            name: Vec::new(),
            losses: [0; 2],
            cleanup_error: None,
        }));
        let poisoned = control.clone();
        let reader = thread::spawn(move || {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                let _guard = poisoned.lock().unwrap();
                panic!("injected control panic");
            }));
        });
        reader.join().unwrap();
        let mut observer = ProcessEvents {
            started: 0,
            queue: Arc::new(EventQueue::new("process")),
            stopping: Arc::new(AtomicBool::new(false)),
            control,
            reader: Some(thread::spawn(|| {})),
        };
        assert!(observer.control.is_poisoned());
        observer.close().unwrap();
        assert!(observer.reader.is_none());
    }
    #[test]
    #[ignore = "Opt-in QA VM process observer; WAYRILL_PROCESS_EVENTS_VM_TEST=1"]
    fn native_loss_reconciliation_keeps_the_observer_running() {
        assert_eq!(
            std::env::var("WAYRILL_PROCESS_EVENTS_VM_TEST").as_deref(),
            Ok("1")
        );
        super::super::observation::enable().unwrap();
        let mut observer = ProcessEvents::open(Scope::Tun, Arc::new(Notify::new())).unwrap();
        // Exercise the real query/queue/consumer path with a stale loss baseline.
        // No production fault-injection interface is compiled into the worker.
        observer.control.lock().unwrap().losses = [u32::MAX; 2];
        assert!(observer.drain(true).unwrap().discontinuity);
        assert!(!observer.drain(true).unwrap().discontinuity);
        assert!(!observer.reader.as_ref().unwrap().is_finished());
        observer.close().unwrap();
        let mut replacement = ProcessEvents::open(Scope::Tun, Arc::new(Notify::new())).unwrap();
        assert!(!replacement.drain(true).unwrap().discontinuity);
        replacement.close().unwrap();
    }
    #[test]
    fn ended_reader_cannot_leave_a_healthy_attribution_snapshot() {
        let reader = thread::spawn(|| {});
        while !reader.is_finished() {
            thread::yield_now();
        }
        let mut observer = ProcessEvents {
            started: 0,
            queue: Arc::new(EventQueue::new("process")),
            stopping: Arc::new(AtomicBool::new(false)),
            control: Arc::new(Mutex::new(Control {
                session: None,
                consumer: None,
                name: Vec::new(),
                losses: [0; 2],
                cleanup_error: None,
            })),
            reader: Some(reader),
        };
        assert!(observer
            .drain(false)
            .unwrap_err()
            .to_string()
            .contains("ended unexpectedly"));
        observer.close().unwrap();
        assert!(observer.drain(false).is_err());
    }

    #[test]
    #[ignore = "Opt-in QA VM stalled ETW session; WAYRILL_PROCESS_EVENTS_VM_TEST=1"]
    fn stalled_session_does_not_block_process_delivery() {
        use std::{
            collections::HashSet,
            os::windows::process::CommandExt,
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        assert_eq!(
            std::env::var("WAYRILL_PROCESS_EVENTS_VM_TEST").as_deref(),
            Ok("1")
        );
        super::super::observation::enable().unwrap();
        // The fixture owns this unique logger and deliberately never consumes
        // it. Its Drop guard always retires only its numeric handles.
        struct Stalled(Control);
        impl Drop for Stalled {
            fn drop(&mut self) {
                self.0.stop();
            }
        }
        let name = wide(&format!(
            "Wayrill.QA.Stalled.{}.{}",
            std::process::id(),
            now_filetime()
        ));
        let mut properties = Properties::new(&name);
        properties.native.BufferSize = 4;
        properties.native.MinimumBuffers = 2;
        properties.native.MaximumBuffers = 2;
        properties.native.LogFileMode =
            EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_NO_PER_PROCESSOR_BUFFERING;
        let mut session = CONTROLTRACE_HANDLE { Value: 0 };
        assert_eq!(
            // SAFETY: complete properties/name allocation and owned handle output.
            unsafe { StartTraceW(&mut session, name.as_ptr(), &mut properties.native) },
            0
        );
        let mut stalled = Stalled(Control {
            session: Some(session.Value),
            consumer: None,
            name,
            losses: [0; 2],
            cleanup_error: None,
        });
        let mut logger_name = stalled.0.name.clone();
        let mut logfile = EVENT_TRACE_LOGFILEW {
            LoggerName: logger_name.as_mut_ptr(),
            ..Default::default()
        };
        logfile.Anonymous1.ProcessTraceMode =
            PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
        logfile.Anonymous2.EventRecordCallback = Some(event_callback);
        // SAFETY: own logger name is live; no ProcessTrace runs on this consumer.
        let consumer = unsafe { OpenTraceW(&mut logfile) };
        assert_ne!(consumer.Value, u64::MAX);
        stalled.0.consumer = Some(consumer.Value);
        assert_eq!(
            // SAFETY: enable only the fixture's provider on its own session.
            unsafe {
                EnableTraceEx2(
                    session,
                    &PROVIDER,
                    EVENT_CONTROL_CODE_ENABLE_PROVIDER,
                    4,
                    0x10,
                    0,
                    1000,
                    std::ptr::null(),
                )
            },
            0
        );
        let mut observer = ProcessEvents::open(Scope::Tun, Arc::new(Notify::new())).unwrap();
        let command = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/cmd.exe");
        let mut expected = HashSet::new();
        let mut starts = HashSet::new();
        let mut stops = HashSet::new();
        for _ in 0..256 {
            let mut children = (0..16)
                .map(|_| {
                    Command::new(&command)
                        .args(["/D", "/C", "exit 0"])
                        .creation_flags(0x08000000)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .unwrap()
                })
                .collect::<Vec<_>>();
            for child in &children {
                let mut times = [windows_sys::Win32::Foundation::FILETIME::default(); 4];
                assert_ne!(
                    // SAFETY: Child retains its process handle after exit and all four outputs are writable.
                    unsafe {
                        windows_sys::Win32::System::Threading::GetProcessTimes(
                            child.as_raw_handle(),
                            &mut times[0],
                            &mut times[1],
                            &mut times[2],
                            &mut times[3],
                        )
                    },
                    0
                );
                expected.insert(crate::process::ProcessKey {
                    pid: child.id(),
                    started: ((u64::from(times[0].dwHighDateTime) << 32)
                        | u64::from(times[0].dwLowDateTime)) as i64,
                });
            }
            for child in &mut children {
                let _ = child.wait().unwrap();
            }
            for info in observer.drain(false).unwrap().items {
                if info.exited.is_some() {
                    stops.insert(info.key);
                } else {
                    starts.insert(info.key);
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            for info in observer.drain(true).unwrap().items {
                if info.exited.is_some() {
                    stops.insert(info.key);
                } else {
                    starts.insert(info.key);
                }
            }
            if (expected.is_subset(&starts) && expected.is_subset(&stops))
                || Instant::now() >= deadline
            {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        stalled.0.health(true).unwrap();
        let mut stats = Properties::new(&stalled.0.name);
        assert_eq!(
            // SAFETY: query only the fixture-owned handle into complete properties.
            unsafe {
                ControlTraceW(
                    session,
                    std::ptr::null(),
                    &mut stats.native,
                    EVENT_TRACE_CONTROL_QUERY,
                )
            },
            0
        );
        eprintln!("Stalled pool: size={}, min={}, max={}, allocated={}, free={}, written={}, lost={}/{}/{}", stats.native.BufferSize, stats.native.MinimumBuffers, stats.native.MaximumBuffers, stats.native.NumberOfBuffers, stats.native.FreeBuffers, stats.native.BuffersWritten, stats.native.EventsLost, stats.native.LogBuffersLost, stats.native.RealTimeBuffersLost);
        let losses = observer.control.lock().unwrap().losses;
        let delivered_starts = expected.intersection(&starts).count();
        let delivered_stops = expected.intersection(&stops).count();
        eprintln!("ETW isolation: fixture_losses={:?}, observer_losses={losses:?}, children={}, starts={delivered_starts}, stops={delivered_stops}", stalled.0.losses, expected.len());
        observer.close().unwrap();
        assert!(
            stalled.0.losses[0] > 0,
            "Stalled fixture did not reach producer loss"
        );
        assert_eq!(losses, [0, 0]);
        assert_eq!(delivered_starts, expected.len());
        assert_eq!(delivered_stops, expected.len());
    }
}
