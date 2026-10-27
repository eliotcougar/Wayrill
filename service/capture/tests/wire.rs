// SPDX-License-Identifier: GPL-3.0-only
use serde_json::{json, Value};
use std::io::{Cursor, Write};
use wayrill_capture::{
    native::loopback::Change,
    wire::{self, MAX_FRAME},
};

#[test]
fn requests_keep_unicode_error_fields_ids_and_final_unterminated_frame() {
    let input="{\"id\":7,\"method\":\"change\",\"data\":{\"Имя🌍中文نام\":true}}\r\n{\"id\":8,\"method\":\"status\",\"data\":{}}";
    let mut output = Vec::new();
    wire::serve(Cursor::new(input.as_bytes()), &mut output, |request, _| {
        if request.method == "change" {
            serde_json::from_value::<Change>(request.data.clone())?;
        }
        Ok(json!({"state":"stopped"}))
    })
    .unwrap();
    let replies = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["id"], 7);
    assert_eq!(replies[0]["ok"], false);
    assert!(replies[0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Имя🌍中文نام"));
    assert_eq!(replies[1]["id"], 8);
    assert_eq!(replies[1]["ok"], true);
}
#[test]
fn oversized_unterminated_request_is_bounded_and_never_dispatches_its_tail() {
    let mut input = vec![b'x'; MAX_FRAME + 500];
    input.extend_from_slice(b"\n{\"id\":1,\"method\":\"start\",\"data\":{}}\n");
    let mut output = Vec::new();
    let mut dispatched = false;
    assert!(wire::serve(Cursor::new(input), &mut output, |_, _| {
        dispatched = true;
        Ok(Value::Null)
    })
    .is_err());
    assert!(!dispatched);
    assert!(String::from_utf8(output)
        .unwrap()
        .contains("exceeds capacity"));
}
#[test]
fn oversized_result_does_not_write_half_a_json_frame() {
    let mut output = Vec::new();
    wire::serve(
        Cursor::new(b"{\"id\":1,\"method\":\"catalog\",\"data\":{}}\n"),
        &mut output,
        |_, _| Ok(json!({"large":"x".repeat(MAX_FRAME+100)})),
    )
    .unwrap();
    let reply: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["ok"], false);
}
#[test]
fn partially_failed_pipe_without_os_code_never_gets_a_second_frame() {
    struct FailingWriter {
        bytes: Vec<u8>,
        calls: usize,
    }
    impl Write for FailingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.calls += 1;
            if self.calls == 1 {
                self.bytes.extend_from_slice(&bytes[..3]);
                Ok(3)
            } else {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"))
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let input = b"{\"id\":1,\"method\":\"status\",\"data\":{}}\n{\"id\":2,\"method\":\"start\",\"data\":{}}\n";
    let mut writer = FailingWriter {
        bytes: Vec::new(),
        calls: 0,
    };
    let mut dispatched = 0;
    assert!(wire::serve(Cursor::new(input), &mut writer, |_, _| {
        dispatched += 1;
        Ok(Value::Null)
    })
    .is_err());
    assert_eq!(dispatched, 1);
    assert_eq!(writer.calls, 2);
    assert_eq!(writer.bytes.len(), 3);
}
#[test]
fn invalid_utf8_terminates_before_subsequent_commands() {
    let mut input = b"{\"data\":\"".to_vec();
    input.extend_from_slice(&[0xff, b'"', b'}', b'\n']);
    input.extend_from_slice(b"{\"id\":2,\"method\":\"start\",\"data\":{}}\n");
    let mut output = Vec::new();
    assert!(wire::serve(Cursor::new(input), &mut output, |_, _| panic!(
        "invalid stream dispatched"
    ))
    .is_err());
    let reply: Value = serde_json::from_slice(&output).unwrap();
    assert!(reply["error"]["message"]
        .as_str()
        .unwrap()
        .contains("UTF-8"));
}
#[test]
fn nesting_limit_matches_the_parent_protocol() {
    let mut value = json!({"leaf":true});
    for _ in 0..64 {
        value = json!({"nested":value});
    }
    let input = format!(
        "{}\n{{\"id\":2,\"method\":\"status\",\"data\":{{}}}}\n",
        json!({"id":1,"method":"start","data":value})
    );
    let mut output = Vec::new();
    let mut ids = Vec::new();
    wire::serve(Cursor::new(input), &mut output, |request, _| {
        ids.push(request.id);
        Ok(Value::Null)
    })
    .unwrap();
    assert_eq!(ids, [2]);
    let text = String::from_utf8(output).unwrap();
    let replies = text
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(replies[0]["ok"], false);
    assert_eq!(replies[1]["ok"], true);
}

#[test]
fn native_progress_precedes_but_never_replaces_correlated_completion() {
    let input = b"{\"id\":11,\"method\":\"sharing.set\",\"data\":{}}\n";
    let mut output = Vec::new();
    wire::serve(Cursor::new(input), &mut output, |_, report| {
        report(&wayrill_capture::sharing::Progress {
            phase: wayrill_capture::sharing::Phase::EnablePublic,
            elapsed_ms: 31000,
        })?;
        Ok(json!({"connections":[]}))
    })
    .unwrap();
    let frames: Vec<Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["id"], 11);
    assert_eq!(frames[0]["progress"]["elapsedMs"], 31000);
    assert!(frames[0].get("ok").is_none());
    assert_eq!(frames[1]["id"], 11);
    assert_eq!(frames[1]["ok"], true);
}
