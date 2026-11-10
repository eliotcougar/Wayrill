use std::{mem, ptr};
use windows_sys::Win32::{
    Foundation::*,
    System::{LibraryLoader::*, Time::*},
};

pub fn systemtime_bytes(value: SYSTEMTIME) -> [u8; 16] {
    let fields = [
        value.wYear,
        value.wMonth,
        value.wDayOfWeek,
        value.wDay,
        value.wHour,
        value.wMinute,
        value.wSecond,
        value.wMilliseconds,
    ];
    let mut result = [0; 16];
    for (index, field) in fields.into_iter().enumerate() {
        result[index * 2..index * 2 + 2].copy_from_slice(&field.to_le_bytes());
    }
    result
}
pub fn resolve(zone: &str) -> Result<DYNAMIC_TIME_ZONE_INFORMATION, u32> {
    let key: Vec<u16> = windows_key(zone)?.encode_utf16().collect();
    unsafe {
        let mut value: DYNAMIC_TIME_ZONE_INFORMATION = mem::zeroed();
        let mut index = 0;
        while EnumDynamicTimeZoneInformation(index, &mut value) == ERROR_SUCCESS {
            let end = value
                .TimeZoneKeyName
                .iter()
                .position(|v| *v == 0)
                .unwrap_or(value.TimeZoneKeyName.len());
            if value.TimeZoneKeyName[..end] == key {
                return Ok(value);
            }
            index += 1;
        }
    }
    Err(ERROR_NOT_FOUND)
}

pub fn windows_key(zone: &str) -> Result<String, u32> {
    let id: Vec<u16> = zone.encode_utf16().chain(Some(0)).collect();
    if id.len() > 128 || zone.contains('\0') {
        return Err(ERROR_INVALID_PARAMETER);
    }
    unsafe {
        let library: Vec<u16> = "icu.dll".encode_utf16().chain(Some(0)).collect();
        let dll = LoadLibraryExW(
            library.as_ptr(),
            ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        );
        if dll.is_null() {
            return Err(GetLastError());
        }
        type Convert = unsafe extern "C" fn(*const u16, i32, *mut u16, i32, *mut i32) -> i32;
        let convert = GetProcAddress(dll, c"ucal_getWindowsTimeZoneID".as_ptr().cast());
        let mut key = [0; 128];
        let mut error = 0;
        let length = convert
            .map(|f| {
                mem::transmute::<unsafe extern "system" fn() -> isize, Convert>(f)(
                    id.as_ptr(),
                    -1,
                    key.as_mut_ptr(),
                    128,
                    &mut error,
                )
            })
            .unwrap_or(0);
        FreeLibrary(dll);
        if error > 0 || length <= 0 || length >= 128 {
            return Err(ERROR_INVALID_PARAMETER);
        }
        String::from_utf16(&key[..length as usize]).map_err(|_| ERROR_INVALID_DATA)
    }
}
