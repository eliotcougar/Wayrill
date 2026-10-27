// SPDX-License-Identifier: GPL-3.0-only
//! Windows ordinal comparison, without locale-sensitive or expanding Unicode
//! case folding. The common ASCII path does not allocate or call Windows.
pub fn equal(first: &str, second: &str) -> bool {
    if first.is_ascii() && second.is_ascii() {
        return first.eq_ignore_ascii_case(second);
    }
    let a: Vec<u16> = first.encode_utf16().collect();
    let b: Vec<u16> = second.encode_utf16().collect();
    ordinal(&a, &b)
}
pub fn ordinal_compare(first: &str, second: &str) -> std::cmp::Ordering {
    if first.is_ascii() && second.is_ascii() {
        first.cmp(second)
    } else {
        first.encode_utf16().cmp(second.encode_utf16())
    }
}
pub fn starts_with(value: &str, prefix: &str) -> bool {
    if value.is_ascii() && prefix.is_ascii() {
        return value
            .get(..prefix.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(prefix));
    }
    let a: Vec<u16> = value.encode_utf16().collect();
    let b: Vec<u16> = prefix.encode_utf16().collect();
    a.get(..b.len()).is_some_and(|a| ordinal(a, &b))
}
fn ordinal(first: &[u16], second: &[u16]) -> bool {
    let (Ok(a), Ok(b)) = (i32::try_from(first.len()), i32::try_from(second.len())) else {
        return false;
    };
    // SAFETY: both buffers remain alive and contain exactly the explicit lengths.
    // CompareStringOrdinal reads the buffers without retaining their pointers.
    unsafe {
        windows_sys::Win32::Globalization::CompareStringOrdinal(
            first.as_ptr(),
            a,
            second.as_ptr(),
            b,
            1,
        ) == 2
    }
}
pub fn filename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}
pub fn stem(path: &str) -> &str {
    let name = filename(path);
    name.rsplit_once('.').map(|v| v.0).unwrap_or(name)
}
pub fn protected(name: &str) -> bool {
    let name = stem(name);
    [
        "wayrill",
        "wayrill-service",
        "wayrill-capture",
        "xray",
        "v2ray",
        "v2rayN",
        "sing-box",
    ]
    .iter()
    .any(|p| equal(name, p))
}
