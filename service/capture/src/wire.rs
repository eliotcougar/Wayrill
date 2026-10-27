// SPDX-License-Identifier: GPL-3.0-only
use crate::{Error, Result};
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};

pub const MAX_FRAME: usize = 4 * 1024 * 1024;
pub struct Command<'a> {
    pub id: i64,
    pub method: &'a str,
    pub data: &'a Value,
}
struct Frame(Vec<u8>);
impl Write for Frame {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_FRAME - self.0.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Worker response exceeds capacity.",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encode(value: &Value) -> Result<Frame> {
    let mut frame = Frame(Vec::new());
    serde_json::to_writer(&mut frame, value)?;
    Ok(frame)
}
fn write_frame(output: &mut impl Write, frame: &Frame) -> Result<()> {
    output.write_all(&frame.0)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
fn error_reply(output: &mut impl Write, id: i64, error: &Error) -> Result<()> {
    let code = if error.0.starts_with("LOOPBACK_CONFLICT:") {
        "LOOPBACK_CONFLICT"
    } else if error.0.contains("FIREWALL_CONFLICT:") {
        "FIREWALL_CONFLICT"
    } else if error.0.contains("WINDIVERT_CONFLICT:") {
        "WINDIVERT_CONFLICT"
    } else {
        "CAPTURE_ERROR"
    };
    // Bound echoed malformed-field diagnostics while preserving UTF-8 boundaries.
    let message = error.0.chars().take(8192).collect::<String>();
    let frame = encode(&json!({"id":id,"ok":false,"error":{"code":code,"message":message}}))?;
    write_frame(output, &frame)
}
fn depth(value: &Value) -> usize {
    match value {
        Value::Array(values) => 1 + values.iter().map(depth).max().unwrap_or(0),
        Value::Object(values) => 1 + values.values().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}
/// One serial command stream over the parent's inherited pipes. EOF/write
/// failure returns to the worker controller so it can unconditionally drain its
/// resources. Oversize input terminates the stream rather than resynchronizing
/// arbitrary command bytes after an unauthenticated/unbounded drain.
pub fn serve(
    mut input: impl BufRead,
    mut output: impl Write,
    mut execute: impl FnMut(Command<'_>, &mut crate::sharing::Report<'_>) -> Result<Value>,
) -> Result<()> {
    loop {
        let mut line = Vec::new();
        let count = input
            .by_ref()
            .take((MAX_FRAME + 3) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            return Ok(());
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > MAX_FRAME {
            let error = Error::invalid("Worker request exceeds capacity.");
            error_reply(&mut output, 0, &error)?;
            return Err(error);
        }
        if std::str::from_utf8(&line).is_err() {
            let error = Error::invalid("Worker request is not valid UTF-8.");
            error_reply(&mut output, 0, &error)?;
            return Err(error);
        }
        let value: Value = match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(error) => {
                error_reply(&mut output, 0, &error.into())?;
                continue;
            }
        };
        let id = value.get("id").and_then(Value::as_i64).unwrap_or(0);
        if depth(&value) > 64 {
            error_reply(
                &mut output,
                id,
                &Error::invalid("Worker request exceeds JSON depth limit."),
            )?;
            continue;
        }
        let command = match (
            value.get("id").and_then(Value::as_i64),
            value.get("method").and_then(Value::as_str),
            value.get("data"),
        ) {
            (Some(id), Some(method), Some(data)) => Command { id, method, data },
            _ => {
                error_reply(
                    &mut output,
                    id,
                    &Error::invalid("Invalid worker request fields."),
                )?;
                continue;
            }
        };
        let mut broken = None;
        let result = execute(command, &mut |progress| {
            if broken.is_some() {
                return Err(Error::invalid("Progress channel closed."));
            }
            let result = encode(&json!({"id":id,"progress":progress}))
                .and_then(|frame| write_frame(&mut output, &frame));
            if let Err(error) = &result {
                broken = Some(error.0.clone());
            }
            result
        });
        if let Some(error) = broken {
            return Err(Error::invalid(error));
        }
        match result {
            Ok(result) => match encode(&json!({"id":id,"ok":true,"result":result})) {
                Ok(frame) => write_frame(&mut output, &frame)?,
                Err(error) => error_reply(&mut output, id, &error)?,
            },
            Err(error) => error_reply(&mut output, id, &error)?,
        }
    }
}
