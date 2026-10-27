//! Manual file refresh runs as the signed-in desktop user, never as the service.
use std::{fs::File, io::Read, path::Path};

const MAX_BYTES: u64 = wayrill_protocol::MAX_CONFIG as u64;

pub fn read(path: &str) -> Result<String, String> {
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
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read routing file: {e}"))?;
    decode(bytes)
}

fn decode(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!(
            "Routing files must be at most {} MiB.",
            MAX_BYTES / 1024 / 1024
        ));
    }
    let invalid = || "Routing file is not valid UTF-8 or UTF-16 text.".to_string();
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 {
            return Err(invalid());
        }
        let little = bytes[0] == 0xff;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
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
        assert!(decode(vec![b' '; MAX_BYTES as usize + 1]).is_err());
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
}
