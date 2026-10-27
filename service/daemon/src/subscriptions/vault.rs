//! SYSTEM-user DPAPI plus the installer's protected ProgramData ACL. The file
//! remains decryptable before owner sign-in, without storing account passwords.
use super::Library;
use std::{fs, path::Path, ptr};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    if bytes.len() > 256 * 1024 * 1024 {
        return Err(ApiError::new(
            "SUBSCRIPTION_STORAGE",
            "Subscription storage is oversized.",
        ));
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: all blobs remain valid for the synchronous DPAPI call. Windows
    // allocates output; it is copied and freed exactly once below.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(ApiError::new(
            "SUBSCRIPTION_STORAGE",
            "Windows could not unlock subscription storage. The existing file was preserved.",
        ));
    }
    let copied = if output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(copied)
}
pub(crate) fn protect_graph(text: &str) -> Result<String> {
    use base64::Engine;
    if text.len() > 64 * 1024 * 1024 {
        return Err(ApiError::new(
            "SUBSCRIPTION_GRAPH",
            "Source graph exceeds 64 MiB.",
        ));
    }
    let header: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| ApiError::new("SUBSCRIPTION_GRAPH", "Invalid source graph."))?;
    if header["format"] != "wayrill.graph" || header["version"] != 2 {
        return Err(ApiError::new(
            "SUBSCRIPTION_GRAPH",
            "Invalid source graph format.",
        ));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(crypt(text.as_bytes(), true)?))
}
pub(crate) fn unprotect_graph(text: &str) -> Result<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| ApiError::new("SUBSCRIPTION_GRAPH", "Invalid protected graph."))?;
    String::from_utf8(crypt(&bytes, false)?)
        .map_err(|_| ApiError::new("SUBSCRIPTION_GRAPH", "Invalid protected graph text."))
}
pub(super) fn read(path: &Path) -> Result<Option<Library>> {
    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ApiError::io("Inspect subscription storage", e)),
    };
    if metadata.len() > 256 * 1024 * 1024 {
        return Err(ApiError::new(
            "SUBSCRIPTION_STORAGE",
            "Subscription storage is oversized; it was preserved.",
        ));
    }
    let bytes = fs::read(path).map_err(|e| ApiError::io("Read subscription storage", e))?;
    let mut document: serde_json::Value =
        serde_json::from_slice(&crypt(&bytes, false)?).map_err(|_| {
            ApiError::new(
                "SUBSCRIPTION_STORAGE",
                "Invalid subscription storage; it was preserved.",
            )
        })?;
    // Normalize the prior catalogue, mirroring the Stash document boundary.
    for group in document["catalog"].as_array_mut().into_iter().flatten() {
        if let Some(settings) = group["maintenance"].as_object_mut() {
            if let Some(mode) = settings.remove("testMode") {
                settings.insert("removeUnreachable".into(), serde_json::json!(mode != "off"));
            }
            settings.remove("retestMinutes");
        }
    }
    serde_json::from_value(document).map(Some).map_err(|_| {
        ApiError::new(
            "SUBSCRIPTION_STORAGE",
            "Invalid subscription storage; it was preserved.",
        )
    })
}
pub(super) fn write(path: &Path, library: &Library) -> Result<()> {
    let bytes =
        serde_json::to_vec(library).map_err(|e| ApiError::io("Encode subscription storage", e))?;
    crate::storage::write_bytes(path, &crypt(&bytes, true)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opens_the_preceding_catalogue_without_preserving_disabled_modes() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-policy-upgrade-{}.dpapi",
            crate::tun::random_id().unwrap()
        ));
        let library = Library::empty("test-owner".into());
        let mut old = serde_json::to_value(library).unwrap();
        old["catalog"] = serde_json::json!([{
            "id":"provider","name":"Provider","url":"","userAgent":"","headers":{},"allowHttp":false,
            "maintenance":{"autoRefresh":true,"refreshMinutes":60,"testMode":"disable","maxRetries":2,"retestMinutes":30,"viaProxy":false},
            "maintenancePaused":false,"updatedAt":1,"lastTestAt":null,"testCycleAt":null,"entries":[]
        }]);
        fs::write(
            &path,
            crypt(&serde_json::to_vec(&old).unwrap(), true).unwrap(),
        )
        .unwrap();
        let current = read(&path).unwrap().unwrap();
        assert!(current.catalog[0].maintenance.remove_unreachable);
        let settings = serde_json::to_value(&current.catalog[0].maintenance).unwrap();
        assert!(settings.get("testMode").is_none());
        assert!(settings.get("retestMinutes").is_none());
        write(&path, &current).unwrap();
        assert!(
            read(&path).unwrap().unwrap().catalog[0]
                .maintenance
                .remove_unreachable
        );
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn protected_library_survives_reopen_and_rejects_corruption() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-subscription-vault-{}.dpapi",
            crate::tun::random_id().unwrap()
        ));
        let mut library = Library::empty("test-owner".into());
        library.stash = Some("private-subscription-secret".into());
        write(&path, &library).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        assert!(!bytes
            .windows(27)
            .any(|w| w == b"private-subscription-secret"));
        assert_eq!(read(&path).unwrap().unwrap().stash, library.stash);
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&path, &bytes).unwrap();
        assert!(read(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn protected_graph_roundtrip_preserves_unicode_and_rejects_invalid_format() {
        let graph = r#"{"format":"wayrill.graph","version":2,"name":"Пример 🛰"}"#;
        assert_eq!(
            unprotect_graph(&protect_graph(graph).unwrap()).unwrap(),
            graph
        );
        assert!(protect_graph("{}").is_err());
    }
}
