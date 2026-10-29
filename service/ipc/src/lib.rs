use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use wayrill_protocol::{ApiError, Message, Request, Result, API_VERSION, MAX_FRAME};

fn request_timeout(method: &str) -> u64 {
    match method {
        "config.applyAndStart" | "config.refreshOutbounds" => 480, // Includes ICS handoff, rollback and recovery.
        "core.start" | "core.restart" => 240, // Initial/inactive wait; native progress renews it.
        "core.stop" | "core.stopForUpgrade" | "tun.sharing.restore" | "tun.sharing.keep" => 180,
        _ => 45,
    }
}

pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let data = reader
            .fill_buf()
            .await
            .map_err(|e| ApiError::io("Read pipe", e))?;
        if data.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(ApiError::new("INVALID_FRAME", "Incomplete JSON frame."))
            };
        }
        let newline = data.iter().position(|c| *c == b'\n');
        let count = newline.map(|n| n + 1).unwrap_or(data.len());
        if frame.len() + count > MAX_FRAME {
            return Err(ApiError::new(
                "FRAME_TOO_LARGE",
                "Maximum frame size is 32 MiB.",
            ));
        }
        frame.extend_from_slice(&data[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(frame));
        }
    }
}
pub async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, message: &Message) -> Result<()> {
    let mut bytes = serde_json::to_vec(message).map_err(|e| ApiError::io("Encode response", e))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME {
        return Err(ApiError::new(
            "FRAME_TOO_LARGE",
            "Response exceeds frame limit.",
        ));
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), writer.write_all(&bytes))
        .await
        .map_err(|_| ApiError::new("SLOW_CLIENT", "Pipe writer timed out."))?
        .map_err(|e| ApiError::io("Write pipe", e))
}

/// A native operation may take arbitrarily long while Windows remains busy.
/// Bound silence/partial frames, not its total duration. Progress is correlated
/// to this request and cannot acknowledge completion or another request.
async fn response<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    expected: u64,
    inactivity: std::time::Duration,
) -> Result<Value> {
    loop {
        let bytes = tokio::time::timeout(inactivity, read_frame(reader))
            .await
            .map_err(|_| {
                ApiError::new(
                    "TIMEOUT",
                    "Service stopped responding. Refresh status before retrying a mutation.",
                )
            })??
            .ok_or_else(|| ApiError::new("DISCONNECTED", "Service closed the pipe."))?;
        let message: Message = serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::new("INVALID_FRAME", "Invalid service response."))?;
        match message {
            Message::Progress {
                api_version, id, ..
            } if api_version == API_VERSION && id == expected => {}
            Message::Response {
                api_version,
                id,
                ok,
                result,
                error,
            } if api_version == API_VERSION && id == expected => {
                return if ok {
                    Ok(result)
                } else {
                    Err(error
                        .unwrap_or_else(|| ApiError::new("SERVICE_ERROR", "Unspecified error.")))
                };
            }
            _ => {
                return Err(ApiError::new(
                    "INVALID_FRAME",
                    "Mismatched response envelope.",
                ))
            }
        }
    }
}

#[cfg(windows)]
pub mod windows {
    use super::*;
    use std::{
        ptr,
        time::{Duration, Instant},
    };
    use tokio::{io::BufReader, net::windows::named_pipe::NamedPipeClient};
    use windows_sys::Win32::{
        Foundation::*,
        Storage::FileSystem::*,
        System::{Pipes::*, Services::*},
    };
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    fn service_pid() -> Result<u32> {
        unsafe {
            let manager = OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_CONNECT);
            if manager.is_null() {
                return Err(ApiError::io(
                    "Open service manager",
                    std::io::Error::last_os_error(),
                ));
            }
            let service = OpenServiceW(
                manager,
                wide(wayrill_protocol::SERVICE_NAME).as_ptr(),
                SERVICE_QUERY_STATUS,
            );
            CloseServiceHandle(manager);
            if service.is_null() {
                return Err(ApiError::new(
                    "SERVICE_UNAVAILABLE",
                    "Wayrill service is not installed or accessible.",
                ));
            }
            let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
            let mut needed = 0;
            let result = QueryServiceStatusEx(
                service,
                SC_STATUS_PROCESS_INFO,
                (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
                std::mem::size_of_val(&status) as u32,
                &mut needed,
            );
            CloseServiceHandle(service);
            if result == 0 || status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId == 0 {
                return Err(ApiError::new(
                    "SERVICE_UNAVAILABLE",
                    "Wayrill service is not running.",
                ));
            }
            Ok(status.dwProcessId)
        }
    }
    pub async fn connect() -> Result<NamedPipeClient> {
        let pid = service_pid()?;
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            unsafe {
                // Individual write rights exclude FILE_CREATE_PIPE_INSTANCE. Identification
                // prevents a spoofed pipe server from impersonating a privileged client.
                let handle = CreateFileW(
                    wide(wayrill_protocol::PIPE_NAME).as_ptr(),
                    0x0012019b,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    ptr::null_mut(),
                );
                if handle != INVALID_HANDLE_VALUE {
                    let mut server_pid = 0;
                    if GetNamedPipeServerProcessId(handle, &mut server_pid) == 0
                        || server_pid != pid
                    {
                        CloseHandle(handle);
                        return Err(ApiError::new(
                            "UNTRUSTED_SERVER",
                            "Pipe server does not match the running Windows service.",
                        ));
                    }
                    return NamedPipeClient::from_raw_handle(handle)
                        .map_err(|e| ApiError::io("Open asynchronous pipe", e));
                }
                let error = std::io::Error::last_os_error();
                if Instant::now() >= until || !matches!(error.raw_os_error(), Some(2 | 231)) {
                    return Err(ApiError::io("Connect to Wayrill service", error));
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    pub async fn request(method: &str, params: Value) -> Result<Value> {
        let pipe = connect().await?;
        let mut pipe = BufReader::new(pipe);
        let mut data = serde_json::to_vec(&Request {
            api_version: API_VERSION,
            id: 1,
            method: method.into(),
            params,
        })
        .map_err(|e| ApiError::io("Encode request", e))?;
        data.push(b'\n');
        if data.len() > MAX_FRAME {
            return Err(ApiError::new(
                "FRAME_TOO_LARGE",
                "Request exceeds frame limit.",
            ));
        }
        tokio::time::timeout(Duration::from_secs(5), pipe.get_mut().write_all(&data))
            .await
            .map_err(|_| ApiError::new("TIMEOUT", "Service request write timed out."))?
            .map_err(|e| ApiError::io("Write request", e))?;
        response(&mut pipe, 1, Duration::from_secs(request_timeout(method))).await
    }
    pub async fn subscribe(
        after_sequence: u64,
        after_instance_id: Option<String>,
        mut callback: impl FnMut(Message) + Send,
    ) -> Result<()> {
        let mut pipe = BufReader::new(connect().await?);
        let mut data = serde_json::to_vec(&Request {
            api_version: API_VERSION,
            id: 1,
            method: "events.subscribe".into(),
            params: serde_json::json!({"afterSequence":after_sequence,"afterInstanceId":after_instance_id}),
        })
        .unwrap();
        data.push(b'\n');
        pipe.get_mut()
            .write_all(&data)
            .await
            .map_err(|e| ApiError::io("Subscribe", e))?;
        while let Some(frame) = read_frame(&mut pipe).await? {
            let message: Message = serde_json::from_slice(&frame)
                .map_err(|_| ApiError::new("INVALID_FRAME", "Invalid service event."))?;
            match &message {
                Message::Event { api_version, .. } if *api_version == API_VERSION => {}
                Message::Response {
                    api_version,
                    id: 1,
                    ok: true,
                    ..
                } if *api_version == API_VERSION => {}
                Message::Response {
                    error: Some(error), ..
                } => return Err(error.clone()),
                _ => {
                    return Err(ApiError::new(
                        "INVALID_FRAME",
                        "Mismatched event stream envelope.",
                    ))
                }
            }
            callback(message);
        }
        Err(ApiError::new(
            "DISCONNECTED",
            "Service event stream closed.",
        ))
    }
    /// Refresh this user's WinINet cache after the service changes settings in session 0.
    /// This sends notifications only; registry/system settings remain service-owned.
    pub fn refresh_environment() {
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::*;
            let environment: Vec<u16> = "Environment".encode_utf16().chain(Some(0)).collect();
            let mut result = 0;
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                environment.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                1000,
                &mut result,
            );
        }
    }
    /// A scope preference changes which store every WinINet consumer reads.
    pub fn notify_proxy_scope() {
        unsafe {
            use windows_sys::Win32::Networking::WinInet::*;
            InternetSetOptionW(
                ptr::null_mut(),
                INTERNET_OPTION_PROXY_SETTINGS_CHANGED,
                ptr::null_mut(),
                0,
            );
        }
    }
    pub fn refresh_proxy_cache() {
        unsafe {
            use windows_sys::Win32::Networking::WinInet::*;
            InternetSetOptionW(
                ptr::null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                ptr::null_mut(),
                0,
            );
            InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_REFRESH, ptr::null_mut(), 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;
    #[tokio::test]
    async fn parses_separate_frames() {
        let mut r = BufReader::new(&b"{}\n[]\n"[..]);
        assert_eq!(read_frame(&mut r).await.unwrap().unwrap(), b"{}\n");
        assert_eq!(read_frame(&mut r).await.unwrap().unwrap(), b"[]\n");
        assert!(read_frame(&mut r).await.unwrap().is_none());
    }
    #[tokio::test]
    async fn rejects_oversize_before_newline() {
        let data = vec![b'x'; MAX_FRAME + 2];
        let mut r = BufReader::new(&data[..]);
        assert_eq!(
            read_frame(&mut r).await.unwrap_err().code,
            "FRAME_TOO_LARGE"
        );
    }
    #[tokio::test]
    async fn rejects_partial_frame() {
        let mut r = BufReader::new(&b"{}"[..]);
        assert_eq!(read_frame(&mut r).await.unwrap_err().code, "INVALID_FRAME");
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, BufReader};
    use wayrill_protocol::{NativeActivity, SharingPhase};
    fn progress(id: u64) -> Message {
        Message::Progress {
            api_version: API_VERSION,
            id,
            activity: NativeActivity {
                phase: SharingPhase::EnablePublic,
                elapsed_ms: 60000,
            },
        }
    }
    #[tokio::test(start_paused = true)]
    async fn progress_renews_inactivity_without_becoming_a_completion_reply() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let write = tokio::spawn(async move {
            for _ in 0..4 {
                tokio::time::sleep(Duration::from_secs(20)).await;
                write_message(&mut writer, &progress(1)).await.unwrap();
            }
            write_message(
                &mut writer,
                &Message::response(1, Ok(serde_json::json!({"completed":true}))),
            )
            .await
            .unwrap();
        });
        let started = tokio::time::Instant::now();
        let value = response(&mut BufReader::new(reader), 1, Duration::from_secs(30))
            .await
            .unwrap();
        assert_eq!(value["completed"], true);
        assert!(started.elapsed() >= Duration::from_secs(80));
        write.await.unwrap();
    }
    #[tokio::test(start_paused = true)]
    async fn silence_after_progress_is_an_uncertain_transport_error() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        write_message(&mut writer, &progress(1)).await.unwrap();
        assert_eq!(
            response(&mut BufReader::new(reader), 1, Duration::from_secs(30))
                .await
                .unwrap_err()
                .code,
            "TIMEOUT"
        );
    }
    #[tokio::test]
    async fn stale_identity_invalid_phase_and_mixed_envelopes_cannot_extend_the_request() {
        for frame in [serde_json::to_string(&progress(2)).unwrap(),
            r#"{"type":"progress","apiVersion":1,"id":1,"activity":{"phase":"arbitrary","elapsedMs":1}}"#.into(),
            r#"{"type":"progress","apiVersion":1,"id":1,"ok":true,"activity":{"phase":"enablePublic","elapsedMs":1}}"#.into()] {
            let (mut writer, reader) = tokio::io::duplex(4096);
            writer.write_all(format!("{frame}\n").as_bytes()).await.unwrap();
            assert_eq!(response(&mut BufReader::new(reader), 1, Duration::from_secs(1)).await.unwrap_err().code, "INVALID_FRAME");
        }
    }
}
