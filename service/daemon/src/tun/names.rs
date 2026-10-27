//! Alias changes use the same NCI entry point as the packaged Wintun API, but
//! without Wintun's fallback that renames a foreign namesake. Ownership is
//! verified by adapters.rs before calling this module.
use super::{guid_luid, invalid};
use crate::native;
use std::ptr;
use wayrill_protocol::{ApiError, Result};
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::*,
        NetworkManagement::{IpHelper::*, Ndis::NET_LUID_LH},
        System::LibraryLoader::*,
    },
};

pub(super) fn ensure_name_available(name: &str, owned: Option<&str>) -> Result<()> {
    let mut luid = NET_LUID_LH::default();
    let code = unsafe { ConvertInterfaceAliasToLuid(native::wide(name).as_ptr(), &mut luid) };
    if code == 0 {
        if owned
            .and_then(|id| guid_luid(id).ok())
            .is_some_and(|ours| unsafe { ours.Value == luid.Value })
        {
            return Ok(());
        }
        return Err(invalid(format!("An adapter named '{name}' already exists. Choose a different adapter name; Wayrill will not rename or use it.")));
    }
    if [
        ERROR_FILE_NOT_FOUND,
        ERROR_NOT_FOUND,
        ERROR_INVALID_PARAMETER,
    ]
    .contains(&code)
    {
        Ok(())
    } else {
        Err(ApiError::io(
            "Check TUN name availability",
            std::io::Error::from_raw_os_error(code as i32),
        ))
    }
}
struct Nci(HMODULE);
impl Drop for Nci {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.0);
        }
    }
}
pub(super) fn rename_adapter(id: &str, name: &str) -> Result<()> {
    ensure_name_available(name, Some(id))?;
    let luid = guid_luid(id)?;
    if super::alias(&luid)? == name {
        return Ok(());
    }
    let mut guid = GUID::default();
    let code = unsafe { ConvertInterfaceLuidToGuid(&luid, &mut guid) };
    if code != 0 {
        return Err(ApiError::io(
            "Read owned TUN GUID",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    let module = unsafe {
        LoadLibraryExW(
            native::wide("nci.dll").as_ptr(),
            ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if module.is_null() {
        return Err(native::os_error("Load Windows adapter naming API"));
    }
    let module = Nci(module);
    let rename: unsafe extern "system" fn(*const GUID, *const u16) -> u32 = unsafe {
        std::mem::transmute(
            GetProcAddress(module.0, c"NciSetConnectionName".as_ptr().cast())
                .ok_or_else(|| invalid("Windows adapter naming API is unavailable."))?,
        )
    };
    let code = unsafe { rename(&guid, native::wide(name).as_ptr()) };
    if code != 0 {
        return Err(ApiError::io(
            "Rename owned TUN",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    if super::alias(&luid)? != name {
        return Err(invalid("The owned adapter name did not update."));
    }
    Ok(())
}
