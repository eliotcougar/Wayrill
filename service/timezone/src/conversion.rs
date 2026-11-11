//! Preserve explicit zone arguments; replace only the process-default zone.
use super::*;

macro_rules! pair {
    ($slot:ident, $kernel:ident, $base:ident, ($($arg:ident: $ty:ty),*) -> $ret:ty, $body:ident) => {
        static $slot: HookPair = hook_pair();
        unsafe extern "system" fn $kernel($($arg: $ty),*) -> $ret {
            unsafe { $body($($arg),*, $slot[0].load(Ordering::Acquire)) }
        }
        unsafe extern "system" fn $base($($arg: $ty),*) -> $ret {
            unsafe { $body($($arg),*, $slot[1].load(Ordering::Acquire)) }
        }
    };
}
pair!(TO_LOCAL, to_local, to_local_base, (zone: *const TIME_ZONE_INFORMATION, input: *const SYSTEMTIME, output: *mut SYSTEMTIME) -> i32, legacy);
pair!(TO_UTC, to_utc, to_utc_base, (zone: *const TIME_ZONE_INFORMATION, input: *const SYSTEMTIME, output: *mut SYSTEMTIME) -> i32, legacy);
pair!(TO_LOCAL_EX, to_local_ex, to_local_ex_base, (zone: *const DYNAMIC_TIME_ZONE_INFORMATION, input: *const SYSTEMTIME, output: *mut SYSTEMTIME) -> i32, dynamic);
pair!(TO_UTC_EX, to_utc_ex, to_utc_ex_base, (zone: *const DYNAMIC_TIME_ZONE_INFORMATION, input: *const SYSTEMTIME, output: *mut SYSTEMTIME) -> i32, dynamic);
pair!(YEAR, year, year_base, (year: u16, zone: *const DYNAMIC_TIME_ZONE_INFORMATION, output: *mut TIME_ZONE_INFORMATION) -> i32, for_year);
pair!(FILE_LOCAL, file_local, file_local_base, (input: *const FILETIME, output: *mut FILETIME) -> i32, local_file);
pair!(FILE_UTC, file_utc, file_utc_base, (input: *const FILETIME, output: *mut FILETIME) -> i32, utc_file);

type Convert<T> = unsafe extern "system" fn(*const T, *const SYSTEMTIME, *mut SYSTEMTIME) -> i32;
unsafe fn legacy(
    zone: *const TIME_ZONE_INFORMATION,
    input: *const SYSTEMTIME,
    output: *mut SYSTEMTIME,
    original: *mut c_void,
) -> i32 {
    let value = zone
        .is_null()
        .then(selected)
        .flatten()
        .map(legacy_information);
    unsafe {
        mem::transmute::<*mut c_void, Convert<TIME_ZONE_INFORMATION>>(original)(
            value.as_ref().map_or(zone, ptr::from_ref),
            input,
            output,
        )
    }
}
unsafe fn dynamic(
    zone: *const DYNAMIC_TIME_ZONE_INFORMATION,
    input: *const SYSTEMTIME,
    output: *mut SYSTEMTIME,
    original: *mut c_void,
) -> i32 {
    let value = zone.is_null().then(selected).flatten();
    unsafe {
        mem::transmute::<*mut c_void, Convert<DYNAMIC_TIME_ZONE_INFORMATION>>(original)(
            value.as_ref().map_or(zone, ptr::from_ref),
            input,
            output,
        )
    }
}
unsafe fn for_year(
    year: u16,
    zone: *const DYNAMIC_TIME_ZONE_INFORMATION,
    output: *mut TIME_ZONE_INFORMATION,
    original: *mut c_void,
) -> i32 {
    type Query = unsafe extern "system" fn(
        u16,
        *const DYNAMIC_TIME_ZONE_INFORMATION,
        *mut TIME_ZONE_INFORMATION,
    ) -> i32;
    let value = zone.is_null().then(selected).flatten();
    unsafe {
        mem::transmute::<*mut c_void, Query>(original)(
            year,
            value.as_ref().map_or(zone, ptr::from_ref),
            output,
        )
    }
}
unsafe fn local_file(input: *const FILETIME, output: *mut FILETIME, original: *mut c_void) -> i32 {
    unsafe { file(input, output, original, false) }
}
unsafe fn utc_file(input: *const FILETIME, output: *mut FILETIME, original: *mut c_void) -> i32 {
    unsafe { file(input, output, original, true) }
}
fn shifted(input: FILETIME, bias: i64, to_utc: bool) -> Option<FILETIME> {
    let ticks = ((input.dwHighDateTime as u64) << 32) | input.dwLowDateTime as u64;
    let change = bias * 600_000_000 * if to_utc { 1 } else { -1 };
    let ticks = ticks
        .checked_add_signed(change)
        .filter(|t| *t <= i64::MAX as u64)?;
    Some(FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    })
}
unsafe fn file(
    input: *const FILETIME,
    output: *mut FILETIME,
    original: *mut c_void,
    to_utc: bool,
) -> i32 {
    let Some(zone) = selected() else {
        return unsafe {
            mem::transmute::<
                *mut c_void,
                unsafe extern "system" fn(*const FILETIME, *mut FILETIME) -> i32,
            >(original)(input, output)
        };
    };
    // Like Windows' file-time APIs, use the currently active bias, rather
    // than inferring a different DST rule from the timestamp being converted.
    let extra = match classify(zone) {
        TIME_ZONE_ID_DAYLIGHT => zone.DaylightBias,
        TIME_ZONE_ID_STANDARD | TIME_ZONE_ID_UNKNOWN => zone.StandardBias,
        _ => return 0,
    };
    if !input.is_null() && !output.is_null() {
        if let Some(value) = shifted(
            unsafe { input.read() },
            zone.Bias as i64 + extra as i64,
            to_utc,
        ) {
            unsafe {
                output.write(value);
            }
            return 1;
        }
    }
    unsafe {
        SetLastError(ERROR_INVALID_PARAMETER);
    }
    0
}

pub(super) fn prepare() -> Result<Vec<Attachment>, u32> {
    let mut hooks = Vec::new();
    for (slot, name, first, second) in [
        (
            &TO_LOCAL,
            c"SystemTimeToTzSpecificLocalTime",
            to_local as *mut c_void,
            to_local_base as *mut c_void,
        ),
        (
            &TO_UTC,
            c"TzSpecificLocalTimeToSystemTime",
            to_utc as *mut c_void,
            to_utc_base as *mut c_void,
        ),
        (
            &TO_LOCAL_EX,
            c"SystemTimeToTzSpecificLocalTimeEx",
            to_local_ex as *mut c_void,
            to_local_ex_base as *mut c_void,
        ),
        (
            &TO_UTC_EX,
            c"TzSpecificLocalTimeToSystemTimeEx",
            to_utc_ex as *mut c_void,
            to_utc_ex_base as *mut c_void,
        ),
        (
            &YEAR,
            c"GetTimeZoneInformationForYear",
            year as *mut c_void,
            year_base as *mut c_void,
        ),
        (
            &FILE_LOCAL,
            c"FileTimeToLocalFileTime",
            file_local as *mut c_void,
            file_local_base as *mut c_void,
        ),
        (
            &FILE_UTC,
            c"LocalFileTimeToFileTime",
            file_utc as *mut c_void,
            file_utc_base as *mut c_void,
        ),
    ] {
        hooks.extend(prepare_pair(slot, "kernel32.dll", name, first, second)?);
    }
    Ok(hooks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_bias_converts_in_both_directions_and_rejects_out_of_range_results() {
        let filetime = |ticks: u64| FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        };
        let ticks = |value: FILETIME| {
            (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
        };
        // 06:00:00.1234 UTC becomes 11:45:00.1234 at UTC+05:45 and
        // 05:00:00.1234 at UTC-01:00. Check each direction independently.
        let utc = 216_001_234_000;
        for (bias, local) in [(-345, 423_001_234_000), (60, 180_001_234_000)] {
            assert_eq!(ticks(shifted(filetime(utc), bias, false).unwrap()), local);
            assert_eq!(ticks(shifted(filetime(local), bias, true).unwrap()), utc);
        }
        assert!(shifted(
            FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0
            },
            60,
            false
        )
        .is_none());
        assert!(shifted(
            FILETIME {
                dwLowDateTime: u32::MAX,
                dwHighDateTime: i32::MAX as u32
            },
            -60,
            false
        )
        .is_none());
    }
}
