// SPDX-License-Identifier: GPL-3.0-only
use super::{wide, win32};
use crate::{
    address::DivertAddress,
    batch::{self, CAPACITY},
    Error, Result,
};
use std::{
    ffi::{c_void, CStr},
    sync::Arc,
};
use windows_sys::Win32::{
    Foundation::{FreeLibrary, HANDLE, HMODULE, INVALID_HANDLE_VALUE},
    System::LibraryLoader::{
        GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        LOAD_LIBRARY_SEARCH_SYSTEM32,
    },
};

type Open = unsafe extern "C" fn(*const u8, i32, i16, u64) -> HANDLE;
type SetParam = unsafe extern "C" fn(HANDLE, u32, u64) -> i32;
type RecvEx = unsafe extern "C" fn(
    HANDLE,
    *mut u8,
    u32,
    *mut u32,
    u64,
    *mut DivertAddress,
    *mut u32,
    *mut c_void,
) -> i32;
type Recv = unsafe extern "C" fn(HANDLE, *mut u8, u32, *mut u32, *mut DivertAddress) -> i32;
type SendEx = unsafe extern "C" fn(
    HANDLE,
    *const u8,
    u32,
    *mut u32,
    u64,
    *const DivertAddress,
    u32,
    *mut c_void,
) -> i32;
type Checksums = unsafe extern "C" fn(*mut u8, u32, *mut DivertAddress, u64) -> i32;
type Shutdown = unsafe extern "C" fn(HANDLE, u32) -> i32;
type Close = unsafe extern "C" fn(HANDLE) -> i32;
struct Module(HMODULE);
// SAFETY: Windows loader references are process-wide and usable on any thread.
// Arc retains the module until every API reference and its handles are gone.
unsafe impl Send for Module {}
// SAFETY: no mutable loader state is exposed; WinDivert's documented APIs are
// thread-safe and unloading happens only after the final shared reference drops.
unsafe impl Sync for Module {}
impl Drop for Module {
    fn drop(&mut self) {
        // SAFETY: this is the owned successful LoadLibraryExW reference, dropped once.
        unsafe {
            FreeLibrary(self.0);
        }
    }
}
pub struct Api {
    _module: Module,
    open: Open,
    set_param: SetParam,
    receive: RecvEx,
    receive_one: Recv,
    send: SendEx,
    checksums: Checksums,
    shutdown: Shutdown,
    close: Close,
}
impl Api {
    /// Only the immutable sibling dependency location is loadable. Serialized
    /// worker commands never supply a DLL path or a native filter expression.
    pub fn load() -> Result<Arc<Self>> {
        let executable = std::env::current_exe()?;
        let root = executable
            .parent()
            .and_then(|p| p.parent())
            .ok_or_else(|| Error::invalid("Capture dependency directory unavailable."))?;
        let path = root.join("windivert/WinDivert.dll");
        let path = wide(&path.to_string_lossy());
        // SAFETY: explicit absolute dependency path; restrict resolution to its
        // own directory and System32, excluding PATH/current-directory DLLs.
        let raw_module = unsafe {
            LoadLibraryExW(
                path.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if raw_module.is_null() {
            return Err(win32());
        }
        let module = Module(raw_module);
        macro_rules! symbol {
            ($name:literal,$kind:ty) => {{
                // SAFETY: each fixed ASCII symbol is NUL terminated, belongs to
                // the retained module, and uses WinDivert 2.2's documented ABI.
                let pointer = unsafe { GetProcAddress(module.0, concat!($name, "\0").as_ptr()) }
                    .ok_or_else(win32)?;
                // SAFETY: the fixed symbol's WinDivert ABI is exactly $kind.
                unsafe {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, $kind>(pointer)
                }
            }};
        }
        Ok(Arc::new(Self {
            open: symbol!("WinDivertOpen", Open),
            set_param: symbol!("WinDivertSetParam", SetParam),
            receive: symbol!("WinDivertRecvEx", RecvEx),
            receive_one: symbol!("WinDivertRecv", Recv),
            send: symbol!("WinDivertSendEx", SendEx),
            checksums: symbol!("WinDivertHelperCalcChecksums", Checksums),
            shutdown: symbol!("WinDivertShutdown", Shutdown),
            close: symbol!("WinDivertClose", Close),
            _module: module,
        }))
    }
    fn open(
        self: &Arc<Self>,
        filter: &CStr,
        layer: i32,
        priority: i16,
        flags: u64,
    ) -> Result<Handle> {
        // SAFETY: fixed trusted filter and scalar options. The Arc outlives the
        // returned handle; only this constructor can create a Handle reference.
        let raw = unsafe { (self.open)(filter.as_ptr().cast(), layer, priority, flags) };
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            return Err(win32());
        }
        Ok(Handle {
            raw,
            api: self.clone(),
        })
    }
    pub fn open_network(self: &Arc<Self>) -> Result<Handle> {
        self.open(
            c"outbound and !loopback and (tcp or udp or fragment)",
            0,
            100,
            0,
        )
    }
    pub fn open_socket(self: &Arc<Self>) -> Result<Handle> {
        self.open(c"(tcp or udp) and (event == BIND or event == CONNECT or event == ACCEPT or event == CLOSE)",3,0,5)
    }
    pub fn open_monitor(self: &Arc<Self>, allow_install: bool) -> Result<Handle> {
        self.open(c"true", 4, 0, if allow_install { 5 } else { 5 | 0x10 })
    }
    pub fn calculate_checksums(
        &self,
        packet: &mut [u8],
        address: &mut DivertAddress,
    ) -> Result<()> {
        let length = u32::try_from(packet.len())
            .map_err(|_| Error::invalid("Packet checksum buffer too large."))?;
        if packet.is_empty() {
            return Err(Error::invalid("Empty packet checksum buffer."));
        }
        // SAFETY: packet and address are exclusively borrowed initialized arrays
        // of the advertised lengths. The helper retains neither pointer.
        if unsafe { (self.checksums)(packet.as_mut_ptr(), length, address, 0) } == 0 {
            return Err(Error::invalid(
                "Could not calculate redirected packet checksums.",
            ));
        }
        Ok(())
    }
}
pub struct Handle {
    raw: HANDLE,
    api: Arc<Api>,
}
// SAFETY: WinDivert handles support simultaneous receive/send/shutdown calls;
// references keep the handle and API loaded until all borrowing threads join.
unsafe impl Send for Handle {}
// SAFETY: callers borrow a live handle. Drop requires exclusive ownership, and
// shutdown does not close the handle or invalidate another thread's pointer.
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: exactly the owned handle returned by Api::open, closed once.
        // This does not remove or stop the shared Windows driver service.
        unsafe {
            (self.api.close)(self.raw);
        }
    }
}
impl Handle {
    pub fn receive_one(&self, packet: &mut [u8]) -> Result<(usize, DivertAddress)> {
        let length =
            u32::try_from(packet.len()).map_err(|_| Error::invalid("Receive buffer too large."))?;
        let mut received = 0;
        let mut address = DivertAddress::default();
        let pointer = if packet.is_empty() {
            std::ptr::null_mut()
        } else {
            packet.as_mut_ptr()
        };
        // SAFETY: packet and address own the advertised writable storage. SOCKET
        // metadata uses a documented null packet pointer and zero packet length.
        if unsafe { (self.api.receive_one)(self.raw, pointer, length, &mut received, &mut address) }
            == 0
        {
            return Err(win32());
        }
        if received as usize > packet.len() {
            return Err(Error::invalid("Invalid WinDivert metadata length."));
        }
        Ok((received as usize, address))
    }
    pub fn set_param(&self, parameter: u32, value: u64) -> Result<()> {
        // SAFETY: fixed scalar option on a borrowed live WinDivert handle.
        if unsafe { (self.api.set_param)(self.raw, parameter, value) } == 0 {
            return Err(win32());
        }
        Ok(())
    }
    pub fn receive(
        &self,
        packets: &mut [u8],
        addresses: &mut [DivertAddress; CAPACITY],
    ) -> Result<(usize, usize)> {
        let length = u32::try_from(packets.len())
            .map_err(|_| Error::invalid("Receive buffer too large."))?;
        let (mut received, mut address_length) = (0, (80 * CAPACITY) as u32);
        // SAFETY: both arrays are exclusively borrowed, lengths describe their
        // entire writable storage, and null OVERLAPPED requests synchronous I/O.
        if unsafe {
            (self.api.receive)(
                self.raw,
                packets.as_mut_ptr(),
                length,
                &mut received,
                0,
                addresses.as_mut_ptr(),
                &mut address_length,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(win32());
        }
        if received as usize > packets.len()
            || address_length as usize > 80 * CAPACITY
            || !address_length.is_multiple_of(80)
        {
            return Err(Error::invalid("Invalid WinDivert receive length."));
        }
        Ok((received as usize, address_length as usize))
    }
    pub fn send(&self, packets: &[u8], addresses: &[DivertAddress]) -> Result<()> {
        if packets.is_empty()
            || addresses.is_empty()
            || addresses.len() > CAPACITY
            || packets.len() > batch::BUFFER_LENGTH
        {
            return Err(Error::invalid("Invalid WinDivert injection batch."));
        }
        let mut sent = 0;
        // SAFETY: packet/address arrays remain borrowed throughout synchronous
        // injection; their exact lengths are representable in the native ABI.
        let success = unsafe {
            (self.api.send)(
                self.raw,
                packets.as_ptr(),
                packets.len() as u32,
                &mut sent,
                0,
                addresses.as_ptr(),
                std::mem::size_of_val(addresses) as u32,
                std::ptr::null_mut(),
            )
        };
        if success == 0 {
            return Err(win32());
        }
        if sent as usize != packets.len() {
            return Err(Error::invalid(
                "WinDivert packet injection was incomplete; the batch will not be retried.",
            ));
        }
        Ok(())
    }
    pub fn shutdown(&self, how: u32) -> Result<()> {
        // SAFETY: shutdown is documented to unblock concurrent receives while
        // preserving the handle until the reader has joined and Drop closes it.
        if unsafe { (self.api.shutdown)(self.raw, how) } == 0 {
            return Err(win32());
        }
        Ok(())
    }
}
