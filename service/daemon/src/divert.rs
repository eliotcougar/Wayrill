use crate::native::{os_error, verify_hash, wide};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::{FreeLibrary, GetLastError, HANDLE, INVALID_HANDLE_VALUE},
    System::LibraryLoader::*,
};
type Open = unsafe extern "system" fn(*const u8, u32, i16, u64) -> HANDLE;
type Recv = unsafe extern "system" fn(HANDLE, *mut u8, u32, *mut u32, *mut u8) -> i32;
type Shutdown = unsafe extern "system" fn(HANDLE, u32) -> i32;
type Close = unsafe extern "system" fn(HANDLE) -> i32;
type SetParam = unsafe extern "system" fn(HANDLE, u32, u64) -> i32;
struct Library {
    module: windows_sys::Win32::Foundation::HMODULE,
    open: Open,
    recv: Recv,
    shutdown: Shutdown,
    close: Close,
    set_param: SetParam,
}
unsafe impl Send for Library {}
unsafe impl Sync for Library {}
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.module);
        }
    }
}
impl Library {
    fn load(root: &Path) -> Result<Arc<Self>> {
        unsafe {
            let dll = root.join("WinDivert.dll");
            verify_hash(
                &dll,
                "c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2",
            )?;
            verify_hash(
                &root.join("WinDivert64.sys"),
                "8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2",
            )?;
            let module = LoadLibraryExW(
                wide(&dll.to_string_lossy()).as_ptr(),
                ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if module.is_null() {
                return Err(os_error("Load official WinDivert library"));
            }
            macro_rules! symbol {
                ($name:literal,$ty:ty) => {
                    match GetProcAddress(module, concat!($name, "\0").as_ptr()) {
                        Some(f) => {
                            std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(f)
                        }
                        None => {
                            FreeLibrary(module);
                            return Err(os_error("Resolve WinDivert API"));
                        }
                    }
                };
            }
            Ok(Arc::new(Self {
                module,
                open: symbol!("WinDivertOpen", Open),
                recv: symbol!("WinDivertRecv", Recv),
                shutdown: symbol!("WinDivertShutdown", Shutdown),
                close: symbol!("WinDivertClose", Close),
                set_param: symbol!("WinDivertSetParam", SetParam),
            }))
        }
    }
}
struct Capture {
    library: Arc<Library>,
    handle: usize,
    worker: JoinHandle<()>,
    packets: Arc<AtomicU64>,
    bytes: Arc<AtomicU64>,
    error: Arc<AtomicU32>,
    port: u16,
}
pub struct DivertManager {
    root: PathBuf,
    capture: Option<Capture>,
    last: Value,
}
impl DivertManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            capture: None,
            last: json!({"state":"stopped","packets":0,"bytes":0}),
        }
    }
    pub fn status(&self) -> Value {
        let mut value = if let Some(c) = &self.capture {
            let mut value = self.status_of(c);
            if c.worker.is_finished() {
                value["state"] = json!("failed");
            }
            value
        } else {
            self.last.clone()
        };
        value["mode"] = json!("sniffOnly");
        value["available"] = json!(
            self.root.join("WinDivert.dll").is_file()
                && self.root.join("WinDivert64.sys").is_file()
        );
        value
    }
    pub fn start(&mut self, port: u16) -> Result<()> {
        if port < 1024 {
            return Err(ApiError::new(
                "INVALID_PARAMS",
                "Diagnostic port must be 1024 or higher.",
            ));
        }
        if self
            .capture
            .as_ref()
            .is_some_and(|c| c.worker.is_finished())
        {
            self.stop()?;
        }
        if let Some(c) = &self.capture {
            if c.port == port {
                return Ok(());
            }
            return Err(ApiError::new(
                "BUSY",
                "Stop the existing diagnostic capture first.",
            ));
        }
        let library = Library::load(&self.root)?;
        let filter = std::ffi::CString::new(format!(
            "loopback and tcp and (tcp.SrcPort == {port} or tcp.DstPort == {port})"
        ))
        .unwrap();
        let handle = unsafe { (library.open)(filter.as_ptr().cast(), 0, -1000, 1 | 4) }; // NETWORK, SNIFF | RECV_ONLY: no packet diversion.
        if handle == INVALID_HANDLE_VALUE {
            return Err(os_error("Open WinDivert diagnostic handle"));
        }
        unsafe {
            (library.set_param)(handle, 0, 128);
        }
        let packets = Arc::new(AtomicU64::new(0));
        let bytes = Arc::new(AtomicU64::new(0));
        let error = Arc::new(AtomicU32::new(0));
        let (worker_library, worker_packets, worker_bytes, worker_error) = (
            library.clone(),
            packets.clone(),
            bytes.clone(),
            error.clone(),
        );
        let raw = handle as usize;
        let worker = std::thread::Builder::new()
            .name("wayrill-packet-diagnostic".into())
            .spawn(move || {
                let mut packet = vec![0u8; 65535];
                let mut address = [0u64; 10];
                loop {
                    let mut count = 0;
                    let ok = unsafe {
                        (worker_library.recv)(
                            raw as HANDLE,
                            packet.as_mut_ptr(),
                            packet.len() as u32,
                            &mut count,
                            address.as_mut_ptr().cast(),
                        )
                    };
                    if ok == 0 {
                        let code = unsafe { GetLastError() };
                        if ![232, 995, 6].contains(&code) {
                            worker_error.store(code, Ordering::Relaxed);
                        }
                        break;
                    }
                    worker_packets.fetch_add(1, Ordering::Relaxed);
                    worker_bytes.fetch_add(count as u64, Ordering::Relaxed);
                }
            })
            .map_err(|error| {
                unsafe {
                    (library.close)(handle);
                }
                ApiError::io("Start packet diagnostic worker", error)
            })?;
        self.capture = Some(Capture {
            library,
            handle: raw,
            worker,
            packets,
            bytes,
            error,
            port,
        });
        Ok(())
    }
    pub fn stop(&mut self) -> Result<()> {
        if let Some(c) = self.capture.take() {
            self.last = self.status_of(&c);
            self.last["state"] = json!("stopped");
            unsafe {
                (c.library.shutdown)(c.handle as HANDLE, 1);
            }
            let until = Instant::now() + Duration::from_secs(3);
            while !c.worker.is_finished() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
            unsafe {
                (c.library.close)(c.handle as HANDLE);
            }
            let _ = c.worker.join();
        }
        Ok(())
    }
    fn status_of(&self, c: &Capture) -> Value {
        json!({"state":"running","port":c.port,"packets":c.packets.load(Ordering::Relaxed),"bytes":c.bytes.load(Ordering::Relaxed),"lastError":c.error.load(Ordering::Relaxed)})
    }
}
impl Drop for DivertManager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
