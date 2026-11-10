// SPDX-License-Identifier: GPL-3.0-only
//! Cached owner-scoped process discovery, shared with the attribution worker.
use crate::{
    native::{self, owned_handle, read_wide, wide},
    process::ProcessKey,
    Result,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    os::windows::io::AsRawHandle,
    path::Path,
    ptr,
};
use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessCommandLineInformation,
};
use windows_sys::Win32::{
    Foundation::{LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE, UNICODE_STRING},
    Security::{
        Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
        TOKEN_USER,
    },
    Storage::Packaging::Appx::{GetPackageFullName, GetStagedPackagePathByFullName},
    System::{Registry::*, RemoteDesktop::ProcessIdToSessionId, Threading::*},
    UI::Shell::CommandLineToArgvW,
};

#[derive(Default)]
pub struct Scanner {
    snapshot: native::processes::ProcessSnapshot,
    sessions: HashMap<ProcessKey, Option<OwnedApplication>>,
    hosts: HashMap<ProcessKey, Value>,
    owner: String,
}
#[derive(Clone, Copy)]
struct OwnedApplication {
    session: u32,
    package_application: bool,
    role: Role,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Unknown,
    Application,
    ChromiumChild,
    Node,
    WebView,
}
impl Scanner {
    pub fn read(&mut self, owner: &str, catalog: bool) -> Result<Value> {
        if self.owner != owner {
            self.sessions.clear();
            self.hosts.clear();
            self.owner = owner.into();
        }
        let processes = self.snapshot.read(true)?;
        let by_pid = processes
            .iter()
            .map(|process| (process.key.pid, process))
            .collect::<HashMap<_, _>>();
        let mut present = HashSet::new();
        let mut result = Vec::new();
        for process in processes.iter().filter(|p| p.exited.is_none()) {
            present.insert(process.key);
            let Some(path) = &process.path else {
                continue;
            };
            let session = *self
                .sessions
                .entry(process.key)
                .or_insert_with(|| owner_session(process.key, owner, path));
            if let Some(application) = session {
                // Chromium sends timezone changes from its browser process to
                // renderers. Electron's filename is app-specific; identify the
                // process role rather than injecting into sandboxed children.
                if application.role == Role::ChromiumChild {
                    continue;
                }
                // Ancestry is a fallback only when command-line discovery failed.
                // A known root can start another profile using the same image;
                // unsandboxed utilities must retain their own native API view.
                let browser_child = application.role == Role::Unknown
                    && by_pid.get(&process.parent_pid).is_some_and(|parent| {
                        parent.exited.is_none()
                            && parent.key.started <= process.key.started
                            && parent
                                .path
                                .as_ref()
                                .is_some_and(|p| p.eq_ignore_ascii_case(path))
                    })
                    && Path::new(path).file_name().is_some_and(|name| {
                        [
                            "chrome.exe",
                            "msedge.exe",
                            "opera.exe",
                            "brave.exe",
                            "vivaldi.exe",
                            "firefox.exe",
                        ]
                        .iter()
                        .any(|exe| name.eq_ignore_ascii_case(exe))
                    });
                if browser_child {
                    continue;
                }
                if application.role == Role::WebView && !self.hosts.contains_key(&process.key) {
                    if let Some(parent) = by_pid
                        .get(&process.parent_pid)
                        .filter(|p| p.exited.is_none() && p.key.started <= process.key.started)
                    {
                        if let Some(parent_path) = &parent.path {
                            let host = *self
                                .sessions
                                .entry(parent.key)
                                .or_insert_with(|| owner_session(parent.key, owner, parent_path));
                            if let Some(host) = host.filter(|h| h.session == application.session) {
                                // Keep the proven host identity until the engine
                                // exits, so Off still works if the host exits first.
                                self.hosts.insert(process.key, json!({"path":parent_path,"package":parent.package.as_ref().filter(|_| host.package_application)}));
                            }
                        }
                    }
                }
                result.push(json!({"pid":process.key.pid,"created":process.key.started as u64,"path":path,"session":application.session,"package":process.package,"packageApplication":application.package_application,"host":self.hosts.get(&process.key),"nodeRuntime":application.role == Role::Node}));
            }
        }
        self.sessions.retain(|key, _| present.contains(key));
        self.hosts.retain(|key, _| present.contains(key));
        let mut value = json!({"processes":result});
        if catalog {
            value["browsers"] = browsers(owner, &result);
            match native::packages::read(Some(owner)) {
                Ok(packages) => value["packages"] = serde_json::to_value(packages)?,
                Err(error) => {
                    value["catalogError"] =
                        json!(format!("Cannot list installed packages: {error}"))
                }
            }
        }
        Ok(value)
    }
}
fn owner_session(key: ProcessKey, owner: &str, path: &str) -> Option<OwnedApplication> {
    // SAFETY: query-only handles and stack outputs, all handles owned below.
    unsafe {
        // Timezone policies apply only to interactive applications. Exclude
        // service processes before opening their security tokens, rather than
        // inspecting system identities just to discard them afterwards.
        let mut session = 0;
        if ProcessIdToSessionId(key.pid, &mut session) == 0 || session == 0 {
            return None;
        }
        let process =
            owned_handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, key.pid)).ok()?;
        let mut created = std::mem::zeroed();
        let mut exited = std::mem::zeroed();
        let mut kernel = std::mem::zeroed();
        let mut user = std::mem::zeroed();
        if GetProcessTimes(
            process.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        ) == 0
            || native::filetime(created) != key.started
        {
            return None;
        }
        let mut raw = ptr::null_mut();
        if OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &mut raw) == 0 {
            return None;
        }
        let token = owned_handle(raw).ok()?;
        let mut size = 0;
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut size,
        );
        let mut data = vec![0u64; (size as usize).div_ceil(8)];
        if size == 0
            || GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                data.as_mut_ptr().cast(),
                size,
                &mut size,
            ) == 0
        {
            return None;
        }
        let mut sid = ptr::null_mut();
        if ConvertSidToStringSidW((*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid, &mut sid) == 0 {
            return None;
        }
        let length = (0..184).find(|i| *sid.add(*i) == 0).unwrap_or(184);
        let matches = String::from_utf16_lossy(std::slice::from_raw_parts(sid, length)) == owner;
        LocalFree(sid.cast());
        matches.then(|| OwnedApplication {
            session,
            package_application: package_application(process.as_raw_handle(), path),
            role: arguments(process.as_raw_handle())
                .map_or(Role::Unknown, |args| role(path, &args)),
        })
    }
}
fn role(image: &str, args: &[String]) -> Role {
    let switch = |name: &str| args.iter().skip(1).find_map(|arg| arg.strip_prefix(name));
    if switch("--mojo-platform-channel-handle=").is_some() {
        return match switch("--type=") {
            Some("utility") if switch("--utility-sub-type=") == Some("node.mojom.NodeService") => {
                Role::Node
            }
            // Unsandboxed utility code can call native time APIs itself. Keep
            // it managed, including Off for hooks loaded by an earlier build.
            Some("utility") if switch("--service-sandbox-type=") == Some("none") => {
                Role::Application
            }
            Some("renderer" | "gpu-process" | "utility") => Role::ChromiumChild,
            _ => Role::Application,
        };
    }
    if Path::new(image)
        .file_name()
        .is_some_and(|n| n.eq_ignore_ascii_case("msedgewebview2.exe"))
        && switch("--type=").is_none()
        && switch("--embedded-browser-webview=") == Some("1")
    {
        Role::WebView
    } else {
        Role::Application
    }
}
fn arguments(process: HANDLE) -> Option<Vec<String>> {
    // Query command-line metadata once per owned process generation. No remote
    // memory reads, process mutation or persistent command-line storage.
    // SAFETY: the handle is borrowed; the aligned buffer owns the returned
    // UNICODE_STRING and its range-checked text. Shell argv is freed locally.
    unsafe {
        let mut size = 0;
        NtQueryInformationProcess(
            process,
            ProcessCommandLineInformation,
            ptr::null_mut(),
            0,
            &mut size,
        );
        if size < std::mem::size_of::<UNICODE_STRING>() as u32 || size > 131072 {
            return None;
        }
        let mut data = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        if NtQueryInformationProcess(
            process,
            ProcessCommandLineInformation,
            data.as_mut_ptr().cast(),
            size,
            &mut size,
        ) < 0
        {
            return None;
        }
        let value = &*data.as_ptr().cast::<UNICODE_STRING>();
        let start = value.Buffer as usize;
        let end = start.checked_add(value.Length as usize)?;
        if value.Length % 2 != 0
            || start < data.as_ptr() as usize
            || end > data.as_ptr() as usize + data.len() * std::mem::size_of::<usize>()
        {
            return None;
        }
        let mut text = std::slice::from_raw_parts(value.Buffer, value.Length as usize / 2).to_vec();
        text.push(0);
        let mut count = 0;
        let argv = CommandLineToArgvW(text.as_ptr(), &mut count);
        if argv.is_null() {
            return None;
        }
        let result = (0..count)
            .map(|i| {
                let arg = *argv.add(i as usize);
                let mut length = 0;
                while *arg.add(length) != 0 {
                    length += 1;
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(arg, length))
            })
            .collect();
        LocalFree(argv.cast());
        Some(result)
    }
}
fn package_application(process: windows_sys::Win32::Foundation::HANDLE, image: &str) -> bool {
    // RuntimeBroker and other Windows hosts can carry an application's package
    // identity. Package-wide settings belong to the package's own executables.
    // SAFETY: the process handle is borrowed for the call; UTF-16 buffers carry
    // their actual capacities, and no API retains the input or output pointers.
    unsafe {
        let mut name = [0u16; 256];
        let mut length = name.len() as u32;
        if GetPackageFullName(process, &mut length, name.as_mut_ptr()) != 0 {
            return false;
        }
        let mut length = 0;
        // The worker runs as the service, not the package's registered user.
        // Staged-package lookup is independent of the caller's user context.
        if GetStagedPackagePathByFullName(name.as_ptr(), &mut length, ptr::null_mut())
            != ERROR_INSUFFICIENT_BUFFER
            || length == 0
            || length > 32768
        {
            return false;
        }
        let mut path = vec![0u16; length as usize];
        if GetStagedPackagePathByFullName(name.as_ptr(), &mut length, path.as_mut_ptr()) != 0 {
            return false;
        }
        Path::new(&image.to_lowercase()).starts_with(read_wide(&path).to_lowercase())
    }
}
fn registry(root: HKEY, key: &str, name: &str, view: u32) -> Option<String> {
    let mut data = vec![0u16; 32768];
    let mut size = (data.len() * 2) as u32;
    // SAFETY: NUL-terminated keys and a bounded writable WCHAR buffer; no retained pointers.
    let status = unsafe {
        RegGetValueW(
            root,
            wide(key).as_ptr(),
            wide(name).as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | view,
            ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut size,
        )
    };
    (status == 0).then(|| read_wide(&data))
}
fn browsers(owner: &str, running: &[Value]) -> Value {
    let profile = registry(
        HKEY_LOCAL_MACHINE,
        &format!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{owner}"),
        "ProfileImagePath",
        0,
    );
    let mut found = HashMap::<String, Value>::new();
    let mut add = |name: &str, path: String| {
        let path = if name == "Opera" {
            opera_executable(&path).unwrap_or(path)
        } else {
            path
        };
        if Path::new(&path).is_file() {
            found.insert(path.to_lowercase(), json!({"name":name,"path":path}));
        }
    };
    for (name, exe, suffix) in [
        (
            "Chrome",
            "chrome.exe",
            r"Google\Chrome\Application\chrome.exe",
        ),
        (
            "Edge",
            "msedge.exe",
            r"Microsoft\Edge\Application\msedge.exe",
        ),
        (
            "Brave",
            "brave.exe",
            r"BraveSoftware\Brave-Browser\Application\brave.exe",
        ),
        ("Vivaldi", "vivaldi.exe", r"Vivaldi\Application\vivaldi.exe"),
        ("Firefox", "firefox.exe", r"Mozilla Firefox\firefox.exe"),
        ("Opera", "opera.exe", r"Opera\opera.exe"),
    ] {
        for (root, prefix) in [
            (HKEY_LOCAL_MACHINE, String::new()),
            (HKEY_USERS, format!("{owner}\\")),
        ] {
            for view in [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY] {
                if let Some(path) = registry(
                    root,
                    &format!(r"{prefix}SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}"),
                    "",
                    view,
                ) {
                    add(name, path.trim_matches('"').into());
                }
            }
        }
        for root in [
            std::env::var("ProgramW6432").ok(),
            std::env::var("ProgramFiles(x86)").ok(),
            profile.as_ref().map(|p| format!(r"{p}\AppData\Local")),
            profile
                .as_ref()
                .map(|p| format!(r"{p}\AppData\Local\Programs")),
        ]
        .into_iter()
        .flatten()
        {
            add(name, format!(r"{root}\{suffix}"));
        }
        for process in running {
            if let Some(path) = process["path"].as_str().filter(|p| {
                Path::new(p)
                    .file_name()
                    .is_some_and(|p| p.eq_ignore_ascii_case(exe))
            }) {
                add(name, path.into());
            }
        }
    }
    let mut result = found.into_values().collect::<Vec<_>>();
    result.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    json!(result)
}
fn opera_executable(candidate: &str) -> Option<String> {
    let parent = Path::new(candidate).parent()?;
    let direct = parent.join("opera.exe");
    if direct.is_file() {
        return Some(direct.to_string_lossy().into());
    }
    let mut versions = std::fs::read_dir(parent)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let version: Option<Vec<u32>> = entry
                .file_name()
                .to_str()?
                .split('.')
                .map(|v| v.parse().ok())
                .collect();
            let path = entry.path().join("opera.exe");
            path.is_file().then_some((version?, path))
        })
        .collect::<Vec<_>>();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions
        .first()
        .map(|(_, path)| path.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_chromium_roles_without_assuming_a_browser_filename() {
        let args = |tail: &[&str]| {
            std::iter::once("C:\\Apps\\Editor.exe")
                .chain(tail.iter().copied())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            role(
                "Editor.exe",
                &args(&["--type=renderer", "--mojo-platform-channel-handle=42"])
            ),
            Role::ChromiumChild
        );
        assert_eq!(
            role(
                "Editor.exe",
                &args(&[
                    "--type=utility",
                    "--utility-sub-type=node.mojom.NodeService",
                    "--mojo-platform-channel-handle=42"
                ])
            ),
            Role::Node
        );
        assert_eq!(
            role(
                "Editor.exe",
                &args(&["--type=utility", "--mojo-platform-channel-handle=42"])
            ),
            Role::ChromiumChild
        );
        assert_eq!(
            role("Editor.exe", &args(&["--type=renderer"])),
            Role::Application
        );
        assert_eq!(
            role(
                "Editor.exe",
                &args(&[
                    "--type=utility",
                    "--service-sandbox-type=none",
                    "--mojo-platform-channel-handle=42"
                ])
            ),
            Role::Application
        );
        assert_eq!(
            role(
                "msedgewebview2.exe",
                &args(&["--embedded-browser-webview=1"])
            ),
            Role::WebView
        );
        assert_eq!(
            role("Editor.exe", &args(&["--embedded-browser-webview=1"])),
            Role::Application
        );
        // SAFETY: the pseudo-handle is borrowed for a query on this test process.
        let current = arguments(unsafe { GetCurrentProcess() }).unwrap();
        assert_eq!(current, std::env::args().collect::<Vec<_>>());
    }
}
