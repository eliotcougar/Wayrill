// SPDX-License-Identifier: GPL-3.0-only
use crate::{text, Result};
use serde::Serialize;
use windows::{
    core::HSTRING,
    Management::Deployment::PackageManager,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub family: String,
    pub name: String,
    pub publisher: String,
    pub install_path: Option<String>,
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: Apartment is constructed only after successful RoInitialize,
        // stays on this thread, and outlives every WinRT object in read().
        unsafe {
            RoUninitialize();
        }
    }
}
/// Enumerate the installation owner's packages, including a fallback name when
/// a localized display resource is missing. Each COM/HSTRING reference is owned
/// by the Windows projection and released before leaving its apartment.
pub fn read(owner_sid: Option<&str>) -> Result<Vec<Package>> {
    // SAFETY: this function initializes its calling background thread as MTA
    // and balances every successful S_OK/S_FALSE result with RoUninitialize.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }?;
    let _apartment = Apartment;
    let manager = PackageManager::new()?;
    let packages = manager.FindPackagesByUserSecurityId(&HSTRING::from(owner_sid.unwrap_or("")))?;
    let iterator = packages.First()?;
    let mut has_current = iterator.HasCurrent()?;
    let mut result: Vec<Package> = Vec::new();
    while has_current {
        let package = iterator.Current()?;
        if !package.IsFramework()? && !package.IsResourcePackage()? && !package.IsBundle()? {
            let id = package.Id()?;
            let family = id.FamilyName()?.to_string_lossy();
            let display = package
                .DisplayName()
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            let name = if display.trim().is_empty() {
                id.Name()?.to_string_lossy()
            } else {
                display
            };
            let publisher = package
                .PublisherDisplayName()
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            let entry = Package {
                family,
                name,
                publisher,
                install_path: None,
            };
            if let Some(index) = result
                .iter()
                .position(|p| text::equal(&p.family, &entry.family))
            {
                result[index] = entry;
            } else {
                result.push(entry);
            }
        }
        has_current = iterator.MoveNext()?;
    }
    let mut result: Vec<_> = result
        .into_iter()
        .map(|p| {
            let wide = p.name.encode_utf16().collect::<Vec<_>>();
            (p, wide)
        })
        .collect();
    result.sort_by(|(a, aw), (b, bw)| {
        // SAFETY: UTF-16 buffers are retained for the entire comparison with
        // explicit lengths. NULL locale selects the current Windows user locale.
        let order = unsafe {
            windows_sys::Win32::Globalization::CompareStringEx(
                std::ptr::null(),
                1,
                aw.as_ptr(),
                aw.len() as i32,
                bw.as_ptr(),
                bw.len() as i32,
                std::ptr::null(),
                std::ptr::null(),
                0,
            )
        };
        match order {
            1 => std::cmp::Ordering::Less,
            2 => std::cmp::Ordering::Equal,
            3 => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });
    Ok(result.into_iter().map(|p| p.0).collect())
}
