// SPDX-License-Identifier: GPL-3.0-only
use super::{from_win32, packages::Package, wide, win32};
use crate::{text, Error, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    ffi::c_void,
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    NetworkManagement::WindowsFirewall::{
        NetworkIsolationGetAppContainerConfig, NetworkIsolationSetAppContainerConfig,
    },
    Security::{
        Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW},
        FreeSid,
        Isolation::DeriveAppContainerSidFromAppContainerName,
        PSID, SID_AND_ATTRIBUTES,
    },
    System::Memory::{GetProcessHeap, HeapFree},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub family: String,
    pub enabled: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub family: String,
    pub name: String,
    pub publisher: String,
    pub sid: String,
    pub enabled: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: String,
    pub packages: Vec<Row>,
    pub unmatched: Vec<String>,
}
struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this is one owned LocalAlloc output from a SID conversion API.
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct DerivedSid(PSID);
impl Drop for DerivedSid {
    fn drop(&mut self) {
        // SAFETY: DeriveAppContainerSidFromAppContainerName transfers exactly
        // one SID, which Windows requires its caller to free using FreeSid.
        unsafe {
            FreeSid(self.0);
        }
    }
}
fn sid_text(sid: PSID) -> Result<String> {
    let mut text = std::ptr::null_mut();
    // SAFETY: SID comes from the native isolation/derivation API; Windows owns
    // the new NUL-terminated string until our LocalAllocation releases it.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(win32());
    }
    let text = LocalAllocation(text.cast());
    let pointer = text.0.cast::<u16>();
    let mut length = 0usize;
    // SAFETY: conversion succeeded and returned a valid NUL-terminated string;
    // bound SID text to its documented maximum representation before copying.
    while length < 256 && unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    if length == 256 {
        return Err(Error::invalid("Invalid loopback SID text length."));
    }
    // SAFETY: the successful conversion allocated these initialized WCHARs and
    // LocalAllocation remains alive through this immediate copy.
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(pointer, length)
    }))
}
pub fn sid_for(family: &str) -> Result<String> {
    let family = wide(family);
    let mut sid = std::ptr::null_mut();
    // SAFETY: input family is NUL terminated; the API creates one owned SID.
    let result = unsafe { DeriveAppContainerSidFromAppContainerName(family.as_ptr(), &mut sid) };
    if result < 0 {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(result)).into());
    }
    if sid.is_null() {
        return Err(Error::invalid("Missing derived AppContainer SID."));
    }
    let sid = DerivedSid(sid);
    sid_text(sid.0)
}
struct Configuration {
    count: u32,
    entries: *mut SID_AND_ATTRIBUTES,
}
impl Drop for Configuration {
    fn drop(&mut self) {
        // SAFETY: successful NetworkIsolationGetAppContainerConfig returns one
        // process-heap array and one separately allocated SID per native count.
        // They remain owned by this guard and no pointer escapes the function.
        unsafe {
            let heap = GetProcessHeap();
            if !self.entries.is_null() {
                for i in 0..self.count as usize {
                    HeapFree(heap, 0, (*self.entries.add(i)).Sid);
                }
                HeapFree(heap, 0, self.entries.cast());
            }
        }
    }
}
pub fn read() -> Result<BTreeMap<String, u32>> {
    let mut current = Configuration {
        count: 0,
        entries: std::ptr::null_mut(),
    };
    // SAFETY: valid output pointers receive Windows-owned isolation entries;
    // Configuration releases them on every success/error path after this call.
    let error =
        unsafe { NetworkIsolationGetAppContainerConfig(&mut current.count, &mut current.entries) };
    if error != 0 {
        return Err(from_win32(error));
    }
    if current.count > 65536 || current.count != 0 && current.entries.is_null() {
        return Err(Error::invalid("Invalid loopback permission list capacity."));
    }
    let mut entries = BTreeMap::new();
    for i in 0..current.count as usize {
        // SAFETY: successful native count describes this allocation; count was
        // bounded before accessing entries and the guard owns the array.
        let entry = unsafe { &*current.entries.add(i) };
        let sid = sid_text(entry.Sid)?;
        if entries.insert(sid, entry.Attributes).is_some() {
            return Err(Error::invalid("Duplicate loopback permission SID."));
        }
    }
    Ok(entries)
}
pub fn version(entries: &BTreeMap<String, u32>) -> Result<String> {
    // SID keys are ASCII; BTreeMap order and compact JSON match the shipping
    // SortedDictionary/JsonSerializer version, including unknown SID attributes.
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(entries)?)
    ))
}
fn project(packages: &[Package], current: &BTreeMap<String, u32>) -> Result<Snapshot> {
    let mut rows = Vec::with_capacity(packages.len());
    let mut known = HashSet::new();
    for package in packages {
        let sid = sid_for(&package.family)?;
        let enabled = current.contains_key(&sid);
        known.insert(sid.clone());
        rows.push(Row {
            family: package.family.clone(),
            name: package.name.clone(),
            publisher: package.publisher.clone(),
            sid,
            enabled,
        });
    }
    Ok(Snapshot {
        version: version(current)?,
        packages: rows,
        unmatched: current
            .keys()
            .filter(|sid| !known.contains(*sid))
            .cloned()
            .collect(),
    })
}
pub fn snapshot(packages: &[Package]) -> Result<Snapshot> {
    project(packages, &read()?)
}
pub fn apply(packages: &[Package], expected_version: &str, changes: &[Change]) -> Result<Snapshot> {
    let mut current = read()?;
    if version(&current)? != expected_version {
        return Err(Error::invalid(
            "LOOPBACK_CONFLICT: Permissions changed. Refresh before applying.",
        ));
    }
    if changes.len() > 4096 {
        return Err(Error::invalid("Invalid loopback changes."));
    }
    let before = current.clone();
    for (index, change) in changes.iter().enumerate() {
        if changes[..index]
            .iter()
            .any(|other| text::equal(&change.family, &other.family))
        {
            return Err(Error::invalid("Invalid duplicate loopback changes."));
        }
        if !packages
            .iter()
            .any(|p| text::equal(&p.family, &change.family))
        {
            return Err(Error::invalid(
                "Only installed packages belonging to the app owner can be changed.",
            ));
        }
        let sid = sid_for(&change.family)?;
        if change.enabled {
            current.entry(sid).or_insert(0);
        } else {
            current.remove(&sid);
        }
    }
    if current == before {
        return snapshot(packages);
    }
    let mut allocations = Vec::with_capacity(current.len());
    let mut entries = Vec::with_capacity(current.len());
    for (sid, attributes) in &current {
        let text = wide(sid);
        let mut binary = std::ptr::null_mut();
        // SAFETY: canonical NUL-terminated SID text is converted to a separate
        // owned LocalAlloc SID kept alive until the native write completes.
        if unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut binary) } == 0 {
            return Err(win32());
        }
        allocations.push(LocalAllocation(binary));
        entries.push(SID_AND_ATTRIBUTES {
            Sid: binary,
            Attributes: *attributes,
        });
    }
    // SAFETY: every SID and the entry vector remain initialized and live until
    // this synchronous call returns; unknown entries/attributes were preserved.
    let error =
        unsafe { NetworkIsolationSetAppContainerConfig(entries.len() as u32, entries.as_ptr()) };
    if error != 0 {
        return Err(from_win32(error));
    }
    if read()? != current {
        return Err(Error::invalid(
            "Loopback permission verification failed; refresh current Windows permissions.",
        ));
    }
    snapshot(packages)
}
