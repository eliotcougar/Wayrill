//! Manual rule imports run under the signed-in user's token in Wayrill and Pool.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap, fs::File, future::Future, io::Read, path::Path, sync::Mutex,
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::watch;
use wayrill_ipc::windows::request;
use wayrill_protocol::{http_proxy_input, MAX_CONFIG};

use crate::http_source_url::validate_http_source;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DownloadKey(String, String);

static DOWNLOADS: Mutex<BTreeMap<DownloadKey, watch::Sender<bool>>> = Mutex::new(BTreeMap::new());

struct ActiveDownload {
    key: DownloadKey,
    cancelled: watch::Receiver<bool>,
}

impl ActiveDownload {
    fn start(window: &str, id: &str) -> Result<Self, String> {
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid routing download ID.".into());
        }
        let mut active = DOWNLOADS
            .lock()
            .map_err(|_| "Routing download state is unavailable.")?;
        let key = DownloadKey(window.into(), id.into());
        if active.len() >= 4 || active.contains_key(&key) {
            return Err("Too many routing downloads are active. Try again in a moment.".into());
        }
        let (cancel, cancelled) = watch::channel(false);
        active.insert(key.clone(), cancel);
        Ok(Self { key, cancelled })
    }

    async fn run(
        mut self,
        work: impl Future<Output = Result<String, String>>,
    ) -> Result<String, String> {
        tokio::select! {
            biased;
            _ = self.cancelled.changed() => Err("Routing download cancelled.".into()),
            result = work => result,
        }
    }

    fn cancel(window: &str, id: String) {
        if let Ok(active) = DOWNLOADS.lock() {
            if let Some(cancel) = active.get(&DownloadKey(window.into(), id)) {
                cancel.send_replace(true);
            }
        }
    }
}

impl Drop for ActiveDownload {
    fn drop(&mut self) {
        if let Ok(mut active) = DOWNLOADS.lock() {
            active.remove(&self.key);
        }
    }
}

#[tauri::command]
pub async fn routing_source_file(
    window: tauri::WebviewWindow,
    path: Option<String>,
) -> Result<Option<Value>, String> {
    let owner = window.hwnd().map_err(|_| "Cannot find the app window.")?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let path = match path {
            Some(path) => Some(path),
            None => std::thread::spawn(move || crate::picker::choose(owner, "routing"))
                .join()
                .map_err(|_| "Routing file picker failed.")??,
        };
        path.map(|path| read(&path).map(|text| json!({"path": path, "text": text})))
            .transpose()
    })
    .await
    .map_err(|_| "Routing file task failed.")?
}

#[tauri::command]
pub async fn routing_source_download(
    window: tauri::WebviewWindow,
    id: String,
    ready: Channel<()>,
    url: String,
    allow_http: bool,
    via_wayrill: bool,
) -> Result<String, String> {
    let url = validate_http_source(&url, allow_http)?;
    let active = ActiveDownload::start(window.label(), &id)?;
    // Acknowledge only after registering, so an abort cannot miss its native request.
    ready
        .send(())
        .map_err(|_| "The routing editor is no longer available.")?;
    active
        .run(async {
            let proxy = if via_wayrill {
                Some(running_proxy_port().await?)
            } else {
                None
            };
            download(url, proxy).await
        })
        .await
}

#[tauri::command]
pub fn routing_source_download_cancel(window: tauri::WebviewWindow, id: String) {
    ActiveDownload::cancel(window.label(), id);
}

async fn download(url: url::Url, proxy: Option<u16>) -> Result<String, String> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Wayrill/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60));
    if let Some(port) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(download_error)?,
        );
    }
    let mut response = builder
        .build()
        .map_err(download_error)?
        .get(url)
        .send()
        .await
        .map_err(download_error)?;
    let status = response.status();
    if status.is_redirection() {
        return Err("Redirects are not followed. Use the final routing source URL.".into());
    }
    if !status.is_success() {
        return Err(format!("Routing server returned HTTP {}.", status.as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(download_error)? {
        if bytes.len() + chunk.len() > MAX_CONFIG {
            return Err(size_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Routing files must be UTF-8 text.".into())
}

fn download_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "Routing download timed out.".into();
    }
    format!("Routing download failed. {}", error.without_url())
}

async fn running_proxy_port() -> Result<u16, String> {
    let applied = request("config.get", json!({}))
        .await
        .map_err(|e| e.message)?;
    let status = request("service.status", json!({}))
        .await
        .map_err(|e| e.message)?;
    proxy_port(&applied, &status).ok_or_else(|| {
        "Start Wayrill with an unauthenticated HTTP-compatible input to download through it.".into()
    })
}

fn proxy_port(applied: &Value, status: &Value) -> Option<u16> {
    if status["core"]["state"] != "running"
        || status["config"]["revision"].as_u64()? != applied["revision"].as_u64()?
    {
        return None;
    }
    let relays = applied["capture"]["inputs"].as_array();
    applied["config"]["inbounds"]
        .as_array()?
        .iter()
        .filter(|input| http_proxy_input(input))
        .find_map(|input| {
            // Saved capture relays acquire private credentials when started.
            if relays.is_some_and(|relays| relays.iter().any(|relay| relay["tag"] == input["tag"]))
            {
                return None;
            }
            input["port"]
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
        })
}

fn size_error() -> String {
    format!(
        "Routing files must be at most {} MiB.",
        MAX_CONFIG / 1024 / 1024
    )
}

fn read(path: &str) -> Result<String, String> {
    let normalized = path.replace('/', "\\").to_ascii_lowercase();
    if !Path::new(path).is_absolute()
        || normalized.starts_with("\\\\.\\")
        || normalized.starts_with("\\\\?\\")
        || path.contains('\0')
        || path.get(2..).is_some_and(|rest| rest.contains(':'))
    {
        return Err("Choose an absolute path to a regular routing file.".into());
    }
    let file = File::open(path).map_err(|e| format!("Cannot open routing file: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Choose a regular routing file.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read routing file: {e}"))?;
    decode(bytes)
}

#[allow(
    clippy::chunks_exact_to_as_chunks,
    reason = "Shared with the desktop crate's Rust 1.77 MSRV."
)]
fn decode(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > MAX_CONFIG {
        return Err(size_error());
    }
    let invalid = || "Routing file is not valid UTF-8 or UTF-16 text.".to_string();
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let pairs = bytes[2..].chunks_exact(2);
        if !pairs.remainder().is_empty() {
            return Err(invalid());
        }
        let little = bytes[0] == 0xff;
        let units: Vec<u16> = pairs
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|_| invalid())
    } else {
        String::from_utf8(bytes)
            .map(|text| text.trim_start_matches('\u{feff}').to_owned())
            .map_err(|_| invalid())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelling_a_stalled_response_closes_its_socket() {
        use tokio::{
            io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
            net::TcpListener,
            sync::oneshot,
            time::timeout,
        };

        tauri::async_runtime::block_on(async {
            for send_headers in [false, true] {
                let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
                let address = listener.local_addr().unwrap();
                let proxy = send_headers.then_some(address.port());
                let url = if proxy.is_some() {
                    "http://source.invalid/rules".into()
                } else {
                    format!("http://{address}/rules")
                };
                let id = "e7c8851605324354a8b3312f9ce25be7";
                let (requested, sent) = oneshot::channel();
                let server = tokio::spawn(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut stream = BufReader::new(stream);
                    let mut request = String::new();
                    stream.read_line(&mut request).await.unwrap();
                    assert!(request.starts_with(if proxy.is_some() {
                        "GET http://source.invalid/rules "
                    } else {
                        "GET /rules "
                    }));
                    loop {
                        let mut line = String::new();
                        assert_ne!(stream.read_line(&mut line).await.unwrap(), 0);
                        if line == "\r\n" {
                            break;
                        }
                    }
                    if send_headers {
                        stream
                            .get_mut()
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n[")
                            .await
                            .unwrap();
                    }
                    requested.send(()).unwrap();
                    match stream.read(&mut [0]).await {
                        Ok(0) => (),
                        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
                        result => {
                            panic!("The cancelled client must close its connection: {result:?}")
                        }
                    }
                });
                let request = tokio::spawn(
                    ActiveDownload::start("test", id)
                        .unwrap()
                        .run(download(url.parse().unwrap(), proxy)),
                );
                timeout(Duration::from_secs(5), sent)
                    .await
                    .unwrap()
                    .unwrap();
                ActiveDownload::cancel("test", id.into());
                let error = timeout(Duration::from_secs(5), request)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap_err();
                assert_eq!(error, "Routing download cancelled.");
                timeout(Duration::from_secs(5), server)
                    .await
                    .unwrap()
                    .unwrap();
            }
        });
    }
    #[test]
    fn accepts_windows_encodings_and_rejects_invalid_input() {
        let text = "[{\"remarks\":\"Правила\"}]";
        assert_eq!(decode(text.as_bytes().to_vec()).unwrap(), text);
        for little in [true, false] {
            let mut bytes = if little {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for unit in text.encode_utf16() {
                bytes.extend(if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            assert_eq!(decode(bytes).unwrap(), text);
        }
        assert!(decode(vec![0xff, 0xfe, 0]).is_err());
        assert!(decode(vec![0xff, 0xfe, 0, 0xd8]).is_err());
        assert!(decode(vec![0xff]).is_err());
        assert!(decode(vec![b' '; MAX_CONFIG + 1]).is_err());
    }
    #[test]
    fn reads_unicode_paths_and_rejects_devices_or_missing_files() {
        let path =
            std::env::temp_dir().join(format!("wayrill-правила-{}.json", std::process::id()));
        std::fs::write(&path, "[]").unwrap();
        assert_eq!(read(path.to_str().unwrap()).unwrap(), "[]");
        std::fs::remove_file(&path).unwrap();
        assert!(read(path.to_str().unwrap()).is_err());
        assert!(read("rules.json").is_err());
        assert!(read("\\\\.\\pipe\\rules").is_err());
        assert!(read("C:\\rules.json:stream").is_err());
    }

    #[test]
    fn downloads_use_only_a_public_proxy_from_the_running_revision() {
        let mut applied = json!({
            "revision": 5,
            "config": {"inbounds": [
                {"tag": "relay", "protocol": "socks", "listen": "127.0.0.1", "port": 1080},
                {"tag": "proxy", "protocol": "http", "listen": "127.0.0.1", "port": 8080}
            ]},
            "capture": {"inputs": [{"tag": "relay"}]}
        });
        let mut status = json!({"config": {"revision": 4}, "core": {"state": "running"}});
        assert_eq!(proxy_port(&applied, &status), None);
        status["config"]["revision"] = json!(5);
        assert_eq!(proxy_port(&applied, &status), Some(8080));
        applied["config"]["inbounds"][1]["settings"] = json!({"auth": "password"});
        assert_eq!(proxy_port(&applied, &status), None);
        applied["capture"] = Value::Null;
        assert_eq!(proxy_port(&applied, &status), Some(1080));
        status["core"]["state"] = json!("stopped");
        assert_eq!(proxy_port(&applied, &status), None);
    }
}
