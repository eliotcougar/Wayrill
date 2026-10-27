use serde_json::{json, Value};
use std::fmt::Write as _;
use wayrill_protocol::{ApiError, Result};

// Redirected Rust stdout is UTF-8, but Windows PowerShell 5 decodes native output
// with its console code page. JSON escapes preserve every name on either side.
fn console_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for unit in text.encode_utf16() {
        if unit <= 0x7f {
            out.push(unit as u8 as char);
        } else {
            write!(&mut out, "\\u{unit:04x}").unwrap();
        }
    }
    out
}
fn parameters(bytes: &[u8]) -> Result<Value> {
    let invalid = || {
        ApiError::new(
            "INVALID_PARAMS",
            "Parameters must be UTF-8 JSON or BOM-marked UTF-16 JSON.",
        )
    };
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let (chunks, remainder) = bytes[2..].as_chunks::<2>();
        if !remainder.is_empty() {
            return Err(invalid());
        }
        let little = bytes[0] == 0xff;
        let units: Vec<u16> = chunks
            .iter()
            .map(|b| {
                if little {
                    u16::from_le_bytes(*b)
                } else {
                    u16::from_be_bytes(*b)
                }
            })
            .collect();
        let text = String::from_utf16(&units).map_err(|_| invalid())?;
        return serde_json::from_str(&text).map_err(|_| invalid());
    }
    serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
        .map_err(|_| invalid())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        println!(
            "{}",
            console_json(&json!({"ok":false,"error":error}).to_string())
        );
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("example") => {
            let text = serde_json::to_string_pretty(&wayrill_protocol::direct_example()).unwrap();
            if args.len() == 4 && args[2] == "--output" {
                std::fs::write(&args[3], text).map_err(|e| ApiError::io("Save example", e))?;
            } else if args.len() == 2 {
                println!("{}", console_json(&text));
            } else {
                return Err(ApiError::new("USAGE", "wayrillctl example [--output file.json]"));
            }
            Ok(())
        }
        Some("call") => {
            let method = args.get(2).ok_or_else(|| ApiError::new("USAGE", "wayrillctl call method [--params file.json]"))?;
            let params = if args.len() == 5 && args[3] == "--params" {
                let bytes = std::fs::read(&args[4]).map_err(|e| ApiError::io("Read parameters", e))?;
                if bytes.len() > wayrill_protocol::MAX_FRAME {
                    return Err(ApiError::new("FRAME_TOO_LARGE", "Parameters exceed 32 MiB."));
                }
                parameters(&bytes)?
            } else if args.len() == 3 {
                json!({})
            } else {
                return Err(ApiError::new("USAGE", "wayrillctl call method [--params file.json]"));
            };
            let result = wayrill_ipc::windows::request(method, params).await?;
            println!("{}", console_json(&json!({"ok":true,"result":result}).to_string()));
            Ok(())
        }
        Some("watch") => {
            let seconds = if args.len() == 4 && args[2] == "--seconds" {
                args[3].parse::<u64>().ok().filter(|n| (1..=600).contains(n))
                    .ok_or_else(|| ApiError::new("USAGE", "Watch seconds must be 1 to 600."))?
            } else if args.len() == 2 {
                10
            } else {
                return Err(ApiError::new("USAGE", "wayrillctl watch [--seconds 10]"));
            };
            match tokio::time::timeout(std::time::Duration::from_secs(seconds),
                wayrill_ipc::windows::subscribe(0, None, |m| println!("{}", console_json(&serde_json::to_string(&m).unwrap())))
            ).await {
                Ok(result) => result,
                Err(_) => Ok(()),
            }
        }
        _ => Err(ApiError::new("USAGE", "wayrillctl call method [--params file.json] | example [--output file.json] | watch [--seconds 10]")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redirected_json_preserves_unicode_under_legacy_decoders() {
        let value = json!({"Имя🌍": "中文 نام 日本語\r\nC:\\Программы\\a.exe", "literal": "\\u1234", "count": 42});
        let encoded = console_json(&value.to_string());
        assert!(encoded.is_ascii());
        assert_eq!(serde_json::from_str::<Value>(&encoded).unwrap(), value);
        let pretty = console_json(&serde_json::to_string_pretty(&value).unwrap());
        assert_eq!(serde_json::from_str::<Value>(&pretty).unwrap(), value);
        assert!(encoded.contains("\\ud83c\\udf0d"));
    }
    #[test]
    fn parameters_preserve_windows_unicode_file_encodings() {
        let value = json!({"name":"Россия 中文 نام 🌍", "path":"C:\\应用\\a.exe"});
        let text = value.to_string();
        let mut inputs = vec![
            text.as_bytes().to_vec(),
            [vec![0xef, 0xbb, 0xbf], text.as_bytes().to_vec()].concat(),
        ];
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
            inputs.push(bytes);
        }
        for bytes in inputs {
            assert_eq!(parameters(&bytes).unwrap(), value);
        }
    }
    #[test]
    fn malformed_encoding_is_rejected_before_ipc() {
        for bytes in [
            vec![0xd0],
            vec![0xff, 0xfe, b'{'],
            vec![0xff, 0xfe, 0, 0xd8],
            vec![0xfe, 0xff, 0xdc, 0],
        ] {
            assert_eq!(parameters(&bytes).unwrap_err().code, "INVALID_PARAMS");
        }
    }
}
