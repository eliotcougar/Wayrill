//! Full-trust package processes need executable filters in addition to the
//! AppContainer SID. Resolve install roots through the Windows package catalog.
use super::Target;
use std::{collections::BTreeSet, fs, os::windows::fs::MetadataExt, path::PathBuf};
use wayrill_protocol::{ApiError, Result};
use windows::{
    core::HSTRING,
    Management::Deployment::PackageManager,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: apartment initialization succeeded on this thread.
        unsafe { RoUninitialize() }
    }
}

fn installed_paths(families: &[&str]) -> windows::core::Result<BTreeSet<PathBuf>> {
    // SAFETY: the guard stays on this thread and outlives the WinRT objects.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }?;
    let _apartment = Apartment;
    let manager = PackageManager::new()?;
    let mut paths = BTreeSet::new();
    for family in families {
        let packages = manager.FindPackagesByPackageFamilyName(&HSTRING::from(*family))?;
        let packages = packages.First()?;
        while packages.HasCurrent()? {
            let package = packages.Current()?;
            if !package.IsResourcePackage()? && !package.IsBundle()? {
                let path = package.InstalledLocation()?.Path()?;
                paths.insert(PathBuf::from(path.to_os_string()));
            }
            packages.MoveNext()?;
        }
    }
    Ok(paths)
}

pub(super) fn executables(applications: &[Target]) -> Result<Vec<Target>> {
    let families: Vec<_> = applications
        .iter()
        .filter_map(|target| match target {
            Target::Package { value } => Some(value.as_str()),
            Target::Executable { .. } => None,
        })
        .collect();
    if families.is_empty() {
        return Ok(Vec::new());
    }
    let paths = installed_paths(&families).map_err(|error| {
        ApiError::new(
            "APP_PROTECTION",
            format!("Read protected Windows packages: {error}"),
        )
    })?;
    let mut directories: Vec<_> = paths.into_iter().collect();
    let mut executables = Vec::new();
    while let Some(directory) = directories.pop() {
        if !directory.is_absolute() {
            return Err(ApiError::new(
                "APP_PROTECTION",
                "Windows returned an invalid package install location.",
            ));
        }
        let entries = fs::read_dir(&directory)
            .map_err(|error| ApiError::io("Read protected package directory", error))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| ApiError::io("Read protected package entry", error))?;
            let kind = entry
                .file_type()
                .map_err(|error| ApiError::io("Inspect protected package entry", error))?;
            let path = entry.path();
            if kind.is_dir() {
                let attributes = entry
                    .metadata()
                    .map_err(|error| ApiError::io("Inspect protected package directory", error))?
                    .file_attributes();
                // Never traverse a junction out of the package.
                if attributes
                    & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                    == 0
                {
                    directories.push(path);
                }
            } else if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            {
                let value = path.into_os_string().into_string().map_err(|_| {
                    ApiError::new(
                        "APP_PROTECTION",
                        "A protected package executable has an invalid path.",
                    )
                })?;
                executables.push(Target::Executable { value });
                if executables.len() > super::MAX_TARGETS {
                    return Err(super::too_many_targets());
                }
            }
        }
    }
    Ok(executables)
}
