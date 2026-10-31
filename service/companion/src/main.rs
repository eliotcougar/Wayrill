//! Chromium native messaging host. No arbitrary service calls, shell, or HTTP listener.
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use wayrill_protocol::{companion::Lookup, ApiError, Result};

const MAX_INPUT: usize = 64 * 1024;
const MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    id: u32,
    method: String,
    params: Lookup,
}
fn decode(bytes: &[u8]) -> Result<Request> {
    let request: Request = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::new("INVALID_REQUEST", "Invalid Companion request."))?;
    if request.version != 1 || request.method != "routes" {
        return Err(ApiError::new(
            "UNSUPPORTED",
            "Only Companion v1 routes lookups are supported.",
        ));
    }
    request.params.normalized()?;
    Ok(request)
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
    // Chrome enforces the manifest's exact extension-origin allowlist. The service
    // independently authenticates this normal-user process via its existing pipe.
    // stdout belongs exclusively to binary-framed messages, including on failure.
    if let Err(error) = run().await {
        eprintln!("Wayrill Companion: {error}");
    }
}
async fn run() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(bytes) = read_frame(&mut input)? {
        let (id, result) = match decode(&bytes) {
            Ok(request) => {
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    wayrill_ipc::windows::request("companion.routes", json!(request.params)),
                )
                .await
                .unwrap_or_else(|_| {
                    Err(ApiError::new(
                        "TIMEOUT",
                        "Wayrill is busy. Try again shortly.",
                    ))
                });
                (request.id, result)
            }
            Err(error) => (0, Err(error)),
        };
        // Do not pass service diagnostic details or private paths into a browser.
        let response = match result {
            Ok(result) => json!({"version":1,"id":id,"ok":true,"result":result}),
            Err(error) => json!({"version":1,"id":id,"ok":false,"error":{
                "code":error.code,
                "message":if error.code == "METHOD_NOT_FOUND" { "Update Wayrill to a Companion-compatible build." }
                    else { "Cannot read Wayrill routes. Check the service and Companion setup." }
            }}),
        };
        write_frame(&mut output, &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        ] {
            assert!(decode(&serde_json::to_vec(&request).unwrap()).is_err());
        }
        assert!(decode(
            br#"{"version":1,"id":3,"method":"routes","params":{"hosts":["example.org"]}}"#
        )
        .is_ok());
    }
}
