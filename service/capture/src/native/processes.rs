// SPDX-License-Identifier: GPL-3.0-only
use super::{filetime, now_filetime, owned_handle, read_wide, wide, win32};
use crate::{
    process::{ProcessInfo, ProcessKey, ProcessTree},
    text, Error, Result,
};
use std::{
    collections::{HashMap, HashSet},
    os::windows::io::{AsRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_NO_MORE_FILES, FILETIME},
    Storage::{
        FileSystem::QueryDosDeviceW,
        Packaging::Appx::{GetPackageFamilyName, PackageFamilyNameFromFullName},
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        SystemInformation::GetWindowsDirectoryW,
        Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

struct Tracked {
    info: ProcessInfo,
    handle: OwnedHandle,
}
#[derive(Default)]
pub struct ProcessSnapshot {
    processes: HashMap<u32, Tracked>,
    present: HashSet<u32>,
    observed_at: i64,
    image_buffer: Vec<u16>,
}
fn times(handle: &OwnedHandle) -> Result<(i64, i64)> {
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: handle is live and all four FILETIME output pointers are valid.
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(win32());
    }
    Ok((filetime(created), filetime(exited)))
}
fn image_path(handle: &OwnedHandle, buffer: &mut Vec<u16>) -> Option<String> {
    // Reuse one bounded native-query allocation across the process inventory.
    buffer.resize(32768, 0);
    let mut length = buffer.len() as u32;
    // SAFETY: the owned process handle stays alive and the writable array has
    // exactly the capacity communicated to QueryFullProcessImageNameW.
    if unsafe {
        QueryFullProcessImageNameW(handle.as_raw_handle(), 0, buffer.as_mut_ptr(), &mut length)
    } == 0
    {
        return None;
    }
    Some(String::from_utf16_lossy(buffer.get(..length as usize)?))
}
pub fn package_family(handle: &OwnedHandle) -> Option<String> {
    let mut family = [0u16; 128];
    let mut length = 128;
    // SAFETY: handle is borrowed from a live process and the output size matches
    // the array. Windows never retains the family buffer.
    match unsafe { GetPackageFamilyName(handle.as_raw_handle(), &mut length, family.as_mut_ptr()) }
    {
        0 => Some(read_wide(&family)),
        15700 => Some(String::new()),
        _ => None,
    }
}
pub fn family_from_full_name(full_name: &str) -> Option<String> {
    if full_name.is_empty() {
        return Some(String::new());
    }
    let full_name = wide(full_name);
    let mut family = [0u16; 128];
    let mut length = 128;
    // SAFETY: input is NUL terminated and output owns the stated 128 WCHARs.
    if unsafe {
        PackageFamilyNameFromFullName(full_name.as_ptr(), &mut length, family.as_mut_ptr())
    } != 0
    {
        return None;
    }
    Some(read_wide(&family))
}
pub fn read_key(pid: u32) -> Option<ProcessKey> {
    // SAFETY: OpenProcess accepts a numeric PID and returns a new owned handle.
    let handle =
        owned_handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }).ok()?;
    Some(ProcessKey {
        pid,
        started: times(&handle).ok()?.0,
    })
}
pub fn process_name(pid: u32) -> Option<String> {
    // SAFETY: query-only handle on the numeric observed process ID.
    let handle =
        owned_handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }).ok()?;
    image_path(&handle, &mut Vec::new()).map(|path| text::stem(&path).to_owned())
}
pub fn windows_directory() -> Result<String> {
    let mut buffer = vec![0; 32768];
    // SAFETY: writable array has the exact capacity passed to Windows.
    let length = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return Err(win32());
    }
    Ok(read_wide(&buffer))
}
pub fn normalize_image(image: &str) -> Option<String> {
    let mut image = image.to_owned();
    if let Some(rest) = image.strip_prefix("\\??\\") {
        image = if text::starts_with(rest, "UNC\\") {
            format!("\\\\{}", &rest[4..])
        } else {
            rest.into()
        };
    }
    if text::starts_with(&image, "\\Device\\Mup\\") {
        return Some(format!("\\\\{}", &image[12..]));
    }
    if text::starts_with(&image, "\\SystemRoot\\") {
        return windows_directory()
            .ok()
            .map(|p| format!("{p}\\{}", &image[12..]));
    }
    let fully_qualified = image.starts_with("\\\\")
        || image.as_bytes().get(1) == Some(&b':')
            && matches!(image.as_bytes().get(2), Some(b'\\' | b'/'));
    if fully_qualified && !text::starts_with(&image, "\\Device\\") {
        return Some(image);
    }
    if !text::starts_with(&image, "\\Device\\") {
        return None;
    }
    let mut target = vec![0u16; 32768];
    for letter in b'A'..=b'Z' {
        let name = [u16::from(letter), u16::from(b':'), 0];
        // SAFETY: name is a two-character drive plus NUL; output is writable for
        // the stated WCHAR count and is not retained by QueryDosDeviceW.
        if unsafe { QueryDosDeviceW(name.as_ptr(), target.as_mut_ptr(), target.len() as u32) } == 0
        {
            continue;
        }
        let target = read_wide(&target);
        if text::starts_with(&image, &format!("{target}\\")) {
            return Some(format!("{}:{}", char::from(letter), &image[target.len()..]));
        }
    }
    None
}
impl ProcessSnapshot {
    fn collect_exits(
        &mut self,
        result: &mut Vec<ProcessInfo>,
        include_live: bool,
        packages: bool,
    ) -> Result<()> {
        let mut exited = Vec::new();
        for (pid, tracked) in &mut self.processes {
            // SAFETY: SYNCHRONIZE was requested for every retained process handle.
            match unsafe { WaitForSingleObject(tracked.handle.as_raw_handle(), 0) } {
                258 => {
                    if include_live {
                        if tracked.info.path.is_none() {
                            if let Some(path) = image_path(&tracked.handle, &mut self.image_buffer)
                            {
                                tracked.info.name = text::filename(&path).to_owned();
                                tracked.info.path = Some(path);
                            }
                        }
                        if packages && tracked.info.package.is_none() {
                            tracked.info.package = package_family(&tracked.handle);
                        }
                        result.push(tracked.info.clone());
                    }
                }
                0 => {
                    let mut info = tracked.info.clone();
                    info.exited = Some(times(&tracked.handle)?.1);
                    result.push(info);
                    exited.push(*pid);
                }
                _ => return Err(win32()),
            }
        }
        for pid in exited {
            self.processes.remove(&pid);
        }
        Ok(())
    }
    pub fn reconcile(&self, tree: &mut ProcessTree) {
        tree.reconcile_presence(self.observed_at, |key| {
            // A visible PID whose image/times cannot be queried remains
            // uncertain, not dead. A queried newer generation proves the old
            // one ended. The tree separately excludes post-snapshot births.
            self.present.contains(&key.pid)
                && self
                    .processes
                    .get(&key.pid)
                    .is_none_or(|process| process.info.key.started <= key.started)
        });
    }
    pub fn read(&mut self, packages: bool) -> Result<Vec<ProcessInfo>> {
        let mut present = HashSet::new();
        let mut result = Vec::new();
        self.collect_exits(&mut result, true, packages)?;
        let snapshot_time = now_filetime();
        // SAFETY: snapshot flags are fixed and the returned handle is adopted
        // immediately; no foreign handles are closed or changed.
        let snapshot = owned_handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // SAFETY: entry has the documented dwSize and lives through each call.
        if unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } == 0 {
            return Err(win32());
        }
        loop {
            let pid = entry.th32ProcessID;
            if pid > i32::MAX as u32 || entry.th32ParentProcessID > i32::MAX as u32 {
                return Err(Error::invalid("Process snapshot PID overflow."));
            }
            present.insert(pid);
            if pid > 4 && !self.processes.contains_key(&pid) {
                // SAFETY: fixed query-only/SYNCHRONIZE rights on the observed PID.
                let handle = owned_handle(unsafe {
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x100000, 0, pid)
                });
                if let Ok(handle) = handle {
                    if let Ok((started, _)) = times(&handle) {
                        if started <= snapshot_time {
                            let path = image_path(&handle, &mut self.image_buffer);
                            let name = path
                                .as_deref()
                                .map(text::filename)
                                .map(str::to_owned)
                                .unwrap_or_else(|| read_wide(&entry.szExeFile));
                            let package = if packages {
                                package_family(&handle)
                            } else {
                                None
                            };
                            let info = ProcessInfo {
                                key: ProcessKey { pid, started },
                                parent_pid: entry.th32ParentProcessID,
                                name,
                                path,
                                exited: None,
                                sequence: 0,
                                parent_sequence: 0,
                                started_at: 0,
                                exited_at: None,
                                package,
                            };
                            result.push(info.clone());
                            self.processes.insert(pid, Tracked { info, handle });
                        }
                    }
                }
            }
            // SAFETY: snapshot remains owned and entry remains initialized.
            if unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } == 0 {
                break;
            }
        }
        // SAFETY: last-error is captured immediately after the enumeration call.
        if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
            return Err(win32());
        }
        self.collect_exits(&mut result, false, packages)?;
        // Publish only a complete successful enumeration. A partial/failed
        // Windows snapshot never establishes absence.
        self.present = present;
        self.observed_at = snapshot_time;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_live_metadata_is_retried_without_reopening_the_process() {
        let pid = std::process::id();
        // SAFETY: query/synchronize rights on our own process; immediately owned.
        let handle = owned_handle(unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x100000, 0, pid)
        })
        .unwrap();
        let started = times(&handle).unwrap().0;
        let mut snapshot = ProcessSnapshot::default();
        snapshot.processes.insert(
            pid,
            Tracked {
                handle,
                info: ProcessInfo {
                    key: ProcessKey { pid, started },
                    parent_pid: 0,
                    name: "fallback.exe".into(),
                    path: None,
                    exited: None,
                    sequence: 0,
                    parent_sequence: 0,
                    started_at: 0,
                    exited_at: None,
                    package: None,
                },
            },
        );
        let mut result = Vec::new();
        snapshot.collect_exits(&mut result, true, true).unwrap();
        assert_eq!(result.len(), 1);
        let path = result[0]
            .path
            .as_ref()
            .expect("live image query was not retried");
        assert!(text::equal(text::filename(path), &result[0].name));
        assert_eq!(result[0].package.as_deref(), Some(""));
        assert_eq!(
            snapshot.processes[&pid].info.key,
            ProcessKey { pid, started }
        );
    }
}
