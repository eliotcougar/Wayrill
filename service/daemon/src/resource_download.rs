use crate::{
    native::wide,
    resources::{validate_url, MAX},
};
use std::{
    ptr,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::Networking::WinHttp::*;
struct Handle(*mut std::ffi::c_void);
impl Handle {
    fn checked(raw: *mut std::ffi::c_void) -> Result<Self> {
        if raw.is_null() {
            Err(failure("Windows could not open the resource connection."))
        } else {
            Ok(Self(raw))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            WinHttpCloseHandle(self.0);
        }
    }
}
fn failure(text: &str) -> ApiError {
    ApiError::new("RESOURCE_DOWNLOAD", text)
}
fn redirect(current: &url::Url, text: &str) -> Result<url::Url> {
    let next = current
        .join(text)
        .map_err(|_| failure("Invalid resource redirect."))?;
    validate_url(next.as_str())
}
pub fn fetch(text: &str, stop: &AtomicBool, proxy_port: Option<u16>) -> Result<Vec<u8>> {
    let mut url = validate_url(text)?;
    let deadline = Instant::now() + Duration::from_secs(180);
    let proxy =
        proxy_port.map(|port| wide(&format!("http=127.0.0.1:{port};https=127.0.0.1:{port}")));
    let session = Handle::checked(unsafe {
        WinHttpOpen(
            wide(concat!("Wayrill/", env!("CARGO_PKG_VERSION"))).as_ptr(),
            if proxy.is_some() {
                WINHTTP_ACCESS_TYPE_NAMED_PROXY
            } else {
                WINHTTP_ACCESS_TYPE_NO_PROXY
            },
            proxy.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
            ptr::null(),
            0,
        )
    })?;
    if unsafe { WinHttpSetTimeouts(session.0, 10000, 10000, 10000, 10000) } == 0 {
        return Err(failure("Cannot set resource download timeouts."));
    }
    for count in 0..=5 {
        if stop.load(Ordering::SeqCst) || Instant::now() > deadline {
            return Err(failure("Resource download canceled or timed out."));
        }
        let connection = Handle::checked(unsafe {
            WinHttpConnect(
                session.0,
                wide(url.host_str().unwrap()).as_ptr(),
                url.port_or_known_default().unwrap(),
                0,
            )
        })?;
        let path = format!(
            "{}{}",
            url.path(),
            url.query().map(|q| format!("?{q}")).unwrap_or_default()
        );
        let request = Handle::checked(unsafe {
            WinHttpOpenRequest(
                connection.0,
                wide("GET").as_ptr(),
                wide(&path).as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                WINHTTP_FLAG_SECURE,
            )
        })?;
        let policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        if unsafe {
            WinHttpSetOption(
                request.0,
                WINHTTP_OPTION_REDIRECT_POLICY,
                (&policy as *const u32).cast(),
                4,
            )
        } == 0
        {
            return Err(failure("Cannot set resource redirect policy."));
        }
        if unsafe { WinHttpSendRequest(request.0, ptr::null(), 0, ptr::null(), 0, 0, 0) } == 0
            || unsafe { WinHttpReceiveResponse(request.0, ptr::null_mut()) } == 0
        {
            return Err(failure(
                "Resource download failed. Check connectivity and certificate validity.",
            ));
        }
        let mut status = 0u32;
        let mut length = 4;
        if unsafe {
            WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                ptr::null(),
                (&mut status as *mut u32).cast(),
                &mut length,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(failure("Cannot read resource response status."));
        }
        if [301, 302, 303, 307, 308].contains(&status) {
            if count == 5 {
                return Err(failure("Too many resource redirects."));
            }
            let mut location = vec![0u16; 8193];
            let mut bytes = (location.len() * 2) as u32;
            if unsafe {
                WinHttpQueryHeaders(
                    request.0,
                    WINHTTP_QUERY_LOCATION,
                    ptr::null(),
                    location.as_mut_ptr().cast(),
                    &mut bytes,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(failure("Missing or oversized resource redirect."));
            }
            let location =
                String::from_utf16(&location[..(bytes as usize / 2).min(location.len())])
                    .map_err(|_| failure("Invalid resource redirect."))?;
            url = redirect(&url, location.trim_end_matches('\0'))?;
            continue;
        }
        if status != 200 {
            return Err(failure(&format!("Resource server returned HTTP {status}.")));
        }
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 65536];
        loop {
            if stop.load(Ordering::SeqCst) || Instant::now() > deadline {
                return Err(failure("Resource download canceled or timed out."));
            }
            let mut read = 0;
            if unsafe {
                WinHttpReadData(
                    request.0,
                    chunk.as_mut_ptr().cast(),
                    chunk.len() as u32,
                    &mut read,
                )
            } == 0
            {
                return Err(failure("Resource download was interrupted."));
            }
            if read == 0 {
                break;
            }
            if bytes.len() + read as usize > MAX {
                return Err(failure("Resource file exceeds 128 MiB."));
            }
            bytes.extend_from_slice(&chunk[..read as usize]);
        }
        return Ok(bytes);
    }
    Err(failure("Too many resource redirects."))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn follows_only_https_without_credentials() {
        let origin = validate_url("https://example.net/a").unwrap();
        assert_eq!(
            redirect(&origin, "../b").unwrap().as_str(),
            "https://example.net/b"
        );
        for bad in [
            "http://example.net/",
            "file:///secret",
            "https://user:password@example.net/",
            "https://example.net/#secret",
        ] {
            assert!(redirect(&origin, bad).is_err());
        }
    }
}
