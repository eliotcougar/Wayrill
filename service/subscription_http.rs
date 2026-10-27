// Subscription downloads run in the service's restricted LocalService helper.
use std::{
    collections::BTreeMap,
    ptr,
    time::{Duration, Instant},
};
use url::Url;
use windows_sys::Win32::Networking::WinHttp::*;
const MAX: usize = 32 * 1024 * 1024;
pub fn validate_url(text: &str, allow_http: bool) -> Result<Url, String> {
    if text.len() > 8192 {
        return Err("Subscription URL is too long.".into());
    }
    let url = Url::parse(text).map_err(|_| "Enter a valid subscription URL.")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Subscription URLs require a host and cannot contain login credentials or a fragment."
                .into(),
        );
    }
    if url.scheme() != "https" && !(allow_http && url.scheme() == "http") {
        return Err("Use HTTPS, or explicitly allow HTTP for this subscription.".into());
    }
    Ok(url)
}
pub fn validate_headers(headers: &BTreeMap<String, String>, agent: &str) -> Result<(), String> {
    if headers.len() > 32 || agent.len() > 512 || agent.contains(['\r', '\n', '\0']) {
        return Err("Invalid subscription request headers.".into());
    }
    let mut size = 0;
    for (name, value) in headers {
        size += name.len() + value.len();
        if name.is_empty()
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c))
            || value.contains(['\r', '\n', '\0'])
            || [
                "host",
                "content-length",
                "connection",
                "transfer-encoding",
                "proxy-authorization",
            ]
            .contains(&name.to_ascii_lowercase().as_str())
        {
            return Err("Invalid subscription request headers.".into());
        }
    }
    if size > 8192 {
        return Err("Subscription request headers are too large.".into());
    }
    Ok(())
}
struct Handle(*mut std::ffi::c_void);
impl Handle {
    fn checked(raw: *mut std::ffi::c_void) -> Result<Self, String> {
        if raw.is_null() {
            Err("Windows could not open the subscription connection.".into())
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
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn download_error() -> String {
    let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
    match code {
        ERROR_WINHTTP_TIMEOUT => "Subscription request timed out.".into(),
        ERROR_WINHTTP_NAME_NOT_RESOLVED => "Cannot resolve the subscription server.".into(),
        ERROR_WINHTTP_CANNOT_CONNECT => "Cannot connect to the subscription server.".into(),
        ERROR_WINHTTP_SECURE_FAILURE => "Subscription TLS certificate validation failed.".into(),
        ERROR_WINHTTP_INVALID_SERVER_RESPONSE => {
            "The subscription server returned an invalid HTTP response.".into()
        }
        _ => format!("Subscription download failed (Windows error {code})."),
    }
}
pub fn fetch(
    text: &str,
    allow_http: bool,
    agent: &str,
    headers: &BTreeMap<String, String>,
    proxy_port: Option<u16>,
) -> Result<String, String> {
    let url = validate_url(text, allow_http)?;
    validate_headers(headers, agent)?;
    let proxy = proxy_port.map(|p| wide(&format!("127.0.0.1:{p}")));
    let session = Handle::checked(unsafe {
        WinHttpOpen(
            wide(if agent.is_empty() {
                concat!("Wayrill/", env!("CARGO_PKG_VERSION"))
            } else {
                agent
            })
            .as_ptr(),
            if proxy.is_some() {
                WINHTTP_ACCESS_TYPE_NAMED_PROXY
            } else {
                WINHTTP_ACCESS_TYPE_NO_PROXY
            },
            proxy.as_ref().map_or(ptr::null(), |p| p.as_ptr()),
            ptr::null(),
            0,
        )
    })?;
    if unsafe { WinHttpSetTimeouts(session.0, 10000, 10000, 10000, 10000) } == 0 {
        return Err("Cannot set subscription timeouts.".into());
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
            if url.scheme() == "https" {
                WINHTTP_FLAG_SECURE
            } else {
                0
            },
        )
    })?;
    // Refuse redirects rather than send subscription authorization to another origin.
    let redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    if unsafe {
        WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_REDIRECT_POLICY,
            (&redirects as *const u32).cast(),
            4,
        )
    } == 0
    {
        return Err("Cannot set subscription redirect policy.".into());
    }
    let header_text = headers
        .iter()
        .map(|(k, v)| format!("{k}: {v}\r\n"))
        .collect::<String>();
    let header_wide = wide(&header_text);
    if unsafe {
        WinHttpSendRequest(
            request.0,
            header_wide.as_ptr(),
            (header_wide.len() - 1) as u32,
            ptr::null(),
            0,
            0,
            0,
        )
    } == 0
        || unsafe { WinHttpReceiveResponse(request.0, ptr::null_mut()) } == 0
    {
        return Err(download_error());
    }
    let mut status = 0u32;
    let mut length = 4u32;
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
        return Err("Cannot read subscription response status.".into());
    }
    if !(200..300).contains(&status) {
        let hint = if (300..400).contains(&status) {
            " Redirects are not followed; use the final subscription URL."
        } else {
            ""
        };
        return Err(format!("Subscription server returned HTTP {status}.{hint}"));
    }
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        if Instant::now() > deadline {
            return Err("Subscription download timed out.".into());
        }
        let mut read = 0u32;
        if unsafe {
            WinHttpReadData(
                request.0,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut read,
            )
        } == 0
        {
            return Err(download_error());
        }
        if read == 0 {
            break;
        }
        if bytes.len() + read as usize > MAX {
            return Err("Subscription exceeds 32 MiB.".into());
        }
        bytes.extend_from_slice(&chunk[..read as usize]);
    }
    String::from_utf8(bytes).map_err(|_| "Subscription is not UTF-8 text.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls_are_explicit_and_errors_do_not_echo_secrets() {
        for bad in [
            "file:///C:/private",
            "https://user:secret@example.net/",
            "https://example.net/#private",
            "http://example.net/",
        ] {
            assert!(validate_url(bad, false).is_err());
        }
        assert!(validate_url("http://127.0.0.1:8767/list", true).is_ok());
        assert!(validate_url("https://example.net/sub?token=private", false).is_ok());
    }
    #[test]
    fn rejects_header_injection() {
        assert!(validate_headers(
            &BTreeMap::from([("Authorization".into(), "Bearer test\r\nHost: bad".into())]),
            "Wayrill"
        )
        .is_err());
        assert!(
            validate_headers(&BTreeMap::from([("Host".into(), "bad".into())]), "Wayrill").is_err()
        );
    }
}

#[cfg(test)]
mod http_integration {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread,
    };
    pub(super) fn accept(listener: &TcpListener) -> TcpStream {
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match listener.accept() {
                Ok((socket, _)) => {
                    socket.set_nonblocking(false).unwrap();
                    return socket;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "Test client never connected");
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Test listener failed: {error}"),
            }
        }
    }
    pub(super) fn read_request(socket: &mut TcpStream) -> String {
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut chunk = [0u8; 4096];
            let count = socket.read(&mut chunk).unwrap();
            assert!(count > 0, "Request ended before its headers");
            request.extend_from_slice(&chunk[..count]);
            assert!(request.len() <= 16384, "Test request headers are too large");
        }
        String::from_utf8(request).unwrap()
    }
    #[test]
    fn downloads_utf8_and_sends_explicit_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let mut socket = accept(&listener);
            let request = read_request(&mut socket);
            assert!(request.contains("Authorization: Bearer test-only"));
            let body = "fictional-subscription-跳";
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let reply = fetch(
            &format!("http://127.0.0.1:{port}/subscription"),
            true,
            "Wayrill QA",
            &BTreeMap::from([("Authorization".into(), "Bearer test-only".into())]),
            None,
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(reply, "fictional-subscription-跳");
    }
    #[test]
    fn downloads_from_ipv6_loopback_without_stripping_host_brackets() {
        let listener = TcpListener::bind("[::1]:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let mut socket = accept(&listener);
            assert!(read_request(&mut socket).starts_with("GET /subscription "));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]")
                .unwrap();
        });
        let result = fetch(
            &format!("http://[::1]:{port}/subscription"),
            true,
            "",
            &BTreeMap::new(),
            None,
        );
        worker.join().unwrap();
        assert_eq!(result.unwrap(), "[]");
    }
}

#[cfg(test)]
mod failure_integration {
    use super::*;
    use std::{io::Write, net::TcpListener, thread};
    #[test]
    fn provider_failures_only_suggest_redirect_changes_for_redirect_statuses() {
        for status in [302, 401, 403, 429, 503] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let worker = thread::spawn(move || {
                let mut socket = super::http_integration::accept(&listener);
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                super::http_integration::read_request(&mut socket);
                write!(socket, "HTTP/1.1 {status} Failure\r\nContent-Length: 0\r\nLocation: http://127.0.0.1:{port}/private\r\nConnection: close\r\n\r\n").unwrap();
            });
            let error = fetch(
                &format!("http://127.0.0.1:{port}/sub?token=private"),
                true,
                "",
                &BTreeMap::new(),
                None,
            )
            .unwrap_err();
            worker.join().unwrap();
            assert!(error.contains(&format!("HTTP {status}")), "{error}");
            assert_eq!(error.contains("Redirects"), status == 302);
            assert!(!error.contains("private"));
        }
    }
    #[test]
    fn invalid_http_response_is_not_misdiagnosed_as_a_certificate_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let mut socket = super::http_integration::accept(&listener);
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            super::http_integration::read_request(&mut socket);
            socket.write_all(b"Not an HTTP response\r\n\r\n").unwrap();
        });
        let error = fetch(
            &format!("http://127.0.0.1:{port}/sub?token=private"),
            true,
            "",
            &BTreeMap::new(),
            None,
        )
        .unwrap_err();
        worker.join().unwrap();
        assert_eq!(
            error,
            "The subscription server returned an invalid HTTP response."
        );
    }
}
