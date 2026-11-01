//! Browser native messaging host. No arbitrary service calls, shell, or HTTP listener.
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use wayrill_protocol::{companion::Lookup, ApiError, Result};
mod desktop;

const MAX_INPUT: usize = 64 * 1024;
const MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    id: u32,
    method: String,
    params: Value,
}
fn decode(bytes: &[u8]) -> Result<Request> {
    let mut request: Request = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::new("INVALID_REQUEST", "Invalid Companion request."))?;
    if request.version != 1 || !["routes", "editDomain"].contains(&request.method.as_str()) {
        return Err(ApiError::new(
            "UNSUPPORTED",
            "Only Companion v1 routes and domain edit requests are supported.",
        ));
    }
    if request.method == "routes" {
        let lookup: Lookup = serde_json::from_value(request.params.clone())
            .map_err(|_| ApiError::new("INVALID_REQUEST", "Invalid routes request."))?;
        lookup.normalized()?;
    } else {
        let edit: wayrill_protocol::companion::RuleRequest = serde_json::from_value(request.params)
            .map_err(|_| ApiError::new("INVALID_REQUEST", "Invalid domain edit request."))?;
        request.params = json!(edit.normalized()?);
    }
    Ok(request)
}
fn edit_domain(params: &Value, firefox: bool) -> Result<Value> {
    let exe = std::env::current_exe()
        .map_err(|_| ApiError::new("DESKTOP_UNAVAILABLE", "Cannot locate Wayrill."))?;
    let directory = exe
        .parent()
        .ok_or_else(|| ApiError::new("DESKTOP_UNAVAILABLE", "Cannot locate Wayrill."))?;
    // The separately distributed Companion can be registered from its extracted
    // folder. Its editor still belongs to the installed app, not that folder.
    let program_files =
        std::env::var_os("ProgramW6432").or_else(|| std::env::var_os("ProgramFiles"));
    let desktop = desktop::locate(directory, program_files.as_deref()).ok_or_else(|| {
        ApiError::new(
            "DESKTOP_UNAVAILABLE",
            "Install Wayrill to use its rule editor.",
        )
    })?;
    desktop::launch(
        &desktop,
        &["--companion-domain", &params.to_string()],
        firefox,
    )
    .map_err(|_| ApiError::new("DESKTOP_UNAVAILABLE", "Cannot open Wayrill's rule editor."))?;
    Ok(json!({"opened":true}))
}
fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0; 4];
    // EOF between messages is normal; a partial length is a protocol error.
    if reader.read(&mut header[..1])? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_INPUT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid Companion frame size.",
        ));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}
fn write_frame(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_OUTPUT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Companion response exceeds 1 MiB.",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    // Browsers enforce the manifest's exact extension allowlist. The service
    // independently authenticates this normal-user process via its existing pipe.
    // stdout belongs exclusively to binary-framed messages, including on failure.
    if let Err(error) = run().await {
        eprintln!("Wayrill Companion: {error}");
    }
}
async fn run() -> io::Result<()> {
    // Compiled package identity, not a service-supplied reload command. An old
    // bridge remains compatible; upgraded files can reload their unpacked copy.
    let extension: Value =
        serde_json::from_str(include_str!("../../../extensions/companion/manifest.json"))?;
    let gecko: Value =
        serde_json::from_str(include_str!("../../../extensions/companion/firefox.json"))?;
    // Firefox passes the host manifest path, then the add-on ID. This selects
    // its job-lifetime behavior, not authorization or a caller-supplied command.
    let firefox = std::env::args()
        .nth(2)
        .is_some_and(|id| gecko["gecko"]["id"] == id);
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(bytes) = read_frame(&mut input)? {
        let (id, result) = match decode(&bytes) {
            Ok(request) => {
                let result = if request.method == "editDomain" {
                    edit_domain(&request.params, firefox)
                } else {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        wayrill_ipc::windows::request("companion.routes", json!(request.params)),
                    )
                    .await
                    .unwrap_or_else(|_| {
                        Err(ApiError::new(
                            "TIMEOUT",
                            "Wayrill is busy. Try again shortly.",
                        ))
                    })
                };
                (request.id, result)
            }
            Err(error) => (0, Err(error)),
        };
        // Do not pass service diagnostic details or private paths into a browser.
        let mut response = match result {
            Ok(result) => json!({"version":1,"id":id,"ok":true,"result":result}),
            Err(error) => json!({"version":1,"id":id,"ok":false,"error":{
                "code":error.code,
                "message":if error.code == "DESKTOP_UNAVAILABLE" { &error.message }
                    else if error.code == "METHOD_NOT_FOUND" { "Update Wayrill to a Companion-compatible build." }
                    else { "Cannot read Wayrill routes. Check the service and Companion setup." }
            }}),
        };
        response["extensionVersion"] = extension["version"].clone();
        write_frame(&mut output, &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    #[test]
    fn standalone_bridge_finds_installed_desktop_and_prefers_its_own_bundle() {
        let root =
            std::env::temp_dir().join(format!("wayrill-desktop-location-{}", std::process::id()));
        let extracted = root.join("download/Companion");
        let installed = root.join("Program Files/Wayrill");
        std::fs::create_dir_all(&extracted).unwrap();
        std::fs::create_dir_all(&installed).unwrap();
        let program_files = installed.parent().unwrap().as_os_str();
        assert!(desktop::locate(&extracted, Some(program_files)).is_none());
        let app = installed.join("wayrill.exe");
        std::fs::write(&app, b"installed").unwrap();
        assert_eq!(desktop::locate(&extracted, Some(program_files)), Some(app));
        let portable = extracted.parent().unwrap().join("wayrill.exe");
        std::fs::write(&portable, b"portable").unwrap();
        assert_eq!(
            desktop::locate(&extracted, Some(program_files)),
            Some(portable)
        );
        let bundled = extracted.join("wayrill.exe");
        std::fs::write(&bundled, b"bundled").unwrap();
        assert_eq!(desktop::locate(&extracted, None), Some(bundled));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn desktop_children_do_not_hold_browser_pipes() {
        use std::{
            fs,
            sync::mpsc,
            thread,
            time::{Duration, Instant, SystemTime, UNIX_EPOCH},
        };
        const ROLE: &str = "WAYRILL_STDIO_TEST_ROLE";
        const ROOT: &str = "WAYRILL_STDIO_TEST_ROOT";
        let wait = |path: &std::path::Path| {
            let deadline = Instant::now() + Duration::from_secs(15);
            while !path.exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(path.exists(), "Child rendezvous failed");
        };
        if let Ok(role) = std::env::var(ROLE) {
            let root = std::path::PathBuf::from(std::env::var_os(ROOT).unwrap());
            if role == "desktop" {
                assert_eq!(
                    std::env::args().next_back().unwrap(),
                    r#"{"domain":"пример.test","id":"a\\b\"c\\"}"#
                );
                fs::write(root.join("ready"), b"ready").unwrap();
                wait(&root.join("release"));
                fs::write(root.join("exited"), b"exited").unwrap();
            } else {
                use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
                use windows_sys::Win32::{
                    Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS},
                    System::Threading::GetCurrentProcess,
                };
                let mut extra = std::ptr::null_mut();
                // SAFETY: duplicate this process's live stdout as an extra,
                // inheritable handle, like Chromium's non-stdio control pipes.
                assert_ne!(
                    unsafe {
                        DuplicateHandle(
                            GetCurrentProcess(),
                            io::stdout().as_raw_handle(),
                            GetCurrentProcess(),
                            &mut extra,
                            0,
                            1,
                            DUPLICATE_SAME_ACCESS,
                        )
                    },
                    0
                );
                // SAFETY: DuplicateHandle transferred this new handle to us.
                let _extra = unsafe { OwnedHandle::from_raw_handle(extra) };
                std::env::set_var(ROLE, "desktop"); // Isolated helper process, no concurrent work.
                desktop::launch(
                    &std::env::current_exe().unwrap(),
                    &[
                        "--exact",
                        "tests::desktop_children_do_not_hold_browser_pipes",
                        r#"{"domain":"пример.test","id":"a\\b\"c\\"}"#,
                    ],
                    false,
                )
                .unwrap();
                wait(&root.join("ready"));
                println!("bridge-finished");
            }
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "wayrill-bridge-pipes-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let mut bridge = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::desktop_children_do_not_hold_browser_pipes",
                "--nocapture",
            ])
            .env(ROLE, "bridge")
            .env(ROOT, &root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut output = bridge.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut text = String::new();
            let result = output.read_to_string(&mut text).map(|_| text);
            let _ = sender.send(result);
        });
        let eof = receiver.recv_timeout(Duration::from_secs(10));
        // Always release the child, including when a regression retains the pipe.
        fs::write(root.join("release"), b"release").unwrap();
        reader.join().unwrap();
        let status = bridge.wait().unwrap();
        wait(&root.join("exited"));
        fs::remove_dir_all(&root).unwrap();
        assert!(status.success());
        assert!(eof
            .expect("Browser pipe remained open while the desktop was alive")
            .unwrap()
            .contains("bridge-finished"));
    }
    #[test]
    fn chromium_frames_support_multiple_messages_unicode_and_clean_eof() {
        let value = json!({"name":"Выход 🌍"});
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &value).unwrap();
        write_frame(&mut bytes, &value).unwrap();
        let mut reader = bytes.as_slice();
        for _ in 0..2 {
            assert_eq!(
                serde_json::from_slice::<Value>(&read_frame(&mut reader).unwrap().unwrap())
                    .unwrap(),
                value
            );
        }
        assert!(read_frame(&mut reader).unwrap().is_none());
        for bytes in [
            vec![1, 0],
            vec![5, 0, 0, 0, b'{'],
            (MAX_INPUT as u32 + 1).to_le_bytes().to_vec(),
        ] {
            assert!(read_frame(&mut bytes.as_slice()).is_err());
        }
    }
    #[test]
    fn browser_cannot_forward_privileged_methods_or_extra_parameters() {
        for request in [
            json!({"version":1,"id":1,"method":"core.stop","params":{"hosts":[]}}),
            json!({"version":2,"id":1,"method":"routes","params":{"hosts":[]}}),
            json!({"version":1,"id":1,"method":"routes","params":{"hosts":[],"config":{}}}),
            json!({"version":1,"id":1,"method":"editDomain","params":{"host":"a.test","command":"core.stop"}}),
            json!({"version":1,"id":1,"method":"editDomain","params":{"host":"https://a.test/private"}}),
            json!({"version":1,"id":1,"method":"editDomain","params":{"host":"127.0.0.1"}}),
            json!({"version":1,"id":1,"method":"editDomain","params":{"host":"a.test","filterIds":["a".repeat(161)]}}),
        ] {
            assert!(decode(&serde_json::to_vec(&request).unwrap()).is_err());
        }
        assert!(decode(
            br#"{"version":1,"id":3,"method":"routes","params":{"hosts":["example.org"]}}"#
        )
        .is_ok());
        let edit = decode(br#"{"version":1,"id":4,"method":"editDomain","params":{"host":"EXAMPLE.org.","filterIds":["b","a","b"]}}"#).unwrap();
        assert_eq!(
            edit.params,
            json!({"host":"example.org","filterIds":["b","a"]})
        );
    }
}
