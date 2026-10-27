use crate::native::wide;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use wayrill_protocol::{ApiError, Result};
pub fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data)
            .map(Some)
            .map_err(|e| ApiError::io("Read protected state", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ApiError::io("Read protected state", e)),
    }
}
pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| ApiError::io("Encode state", e))?;
    write_bytes(path, &bytes)
}
pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| ApiError::io("Write protected state", e))?;
    file.write_all(bytes)
        .map_err(|e| ApiError::io("Write state", e))?;
    file.sync_all()
        .map_err(|e| ApiError::io("Flush state", e))?;
    drop(file);
    unsafe {
        if windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            wide(&temporary.to_string_lossy()).as_ptr(),
            wide(&path.to_string_lossy()).as_ptr(),
            windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err(crate::native::os_error("Commit protected state"));
        }
    }
    Ok(())
}
pub fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ApiError::io("Remove completed journal", e)),
    }
}
