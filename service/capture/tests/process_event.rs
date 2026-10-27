// SPDX-License-Identifier: GPL-3.0-only
use wayrill_capture::process_event;

fn unicode(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .chain([0])
        .flat_map(u16::to_le_bytes)
        .collect()
}
fn start(version: u8) -> Vec<u8> {
    let mut bytes = 41u32.to_le_bytes().to_vec();
    if version >= 3 {
        bytes.extend_from_slice(&123u64.to_le_bytes());
    }
    bytes.extend_from_slice(&1000i64.to_le_bytes());
    bytes.extend_from_slice(&10u32.to_le_bytes());
    if version >= 3 {
        bytes.extend_from_slice(&122u64.to_le_bytes());
    }
    bytes.extend_from_slice(&1u32.to_le_bytes());
    if version >= 1 {
        bytes.extend_from_slice(&0u32.to_le_bytes());
    }
    if version >= 3 {
        bytes.extend_from_slice(&[0; 8]);
        bytes.extend_from_slice(&[1, 2, 0, 0, 0, 0, 0, 5]);
        bytes.extend_from_slice(&[0; 8]);
    }
    bytes.extend_from_slice(&unicode("C:\\Путь🌍\\client.exe"));
    if version >= 2 {
        bytes.extend_from_slice(&[0; 8]);
        bytes.extend_from_slice(&unicode("App_full_package"));
    }
    bytes
}
#[test]
fn every_supported_start_version_preserves_filetime_qpc_unicode_and_sequences() {
    for version in 0..=4 {
        let bytes = start(version);
        let process = process_event::decode(
            1,
            version,
            456,
            &bytes,
            |p| Some(p.into()),
            |p| Some(format!("family:{p}")),
        )
        .unwrap();
        assert_eq!(process.key.pid, 41);
        assert_eq!(process.key.started, 1000);
        assert_eq!(process.parent_pid, 10);
        assert_eq!(process.started_at, 456);
        assert_eq!(process.name, "client.exe");
        assert_eq!(process.path.as_deref(), Some("C:\\Путь🌍\\client.exe"));
        assert_eq!(process.sequence, if version >= 3 { 123 } else { 0 });
        assert_eq!(process.parent_sequence, if version >= 3 { 122 } else { 0 });
        assert_eq!(
            process.package.as_deref(),
            if version >= 2 {
                Some("family:App_full_package")
            } else {
                None
            }
        );
        for size in 0..bytes.len() {
            assert!(
                process_event::decode(
                    1,
                    version,
                    456,
                    &bytes[..size],
                    |p| Some(p.into()),
                    |p| Some(p.into())
                )
                .is_err(),
                "version {version}, size {size}"
            );
        }
    }
}
#[test]
fn stop_records_are_sparse_and_preserve_native_generation() {
    for version in 0..=2 {
        let mut bytes = 41u32.to_le_bytes().to_vec();
        if version >= 2 {
            bytes.extend_from_slice(&123u64.to_le_bytes());
        }
        bytes.extend_from_slice(&1000i64.to_le_bytes());
        bytes.extend_from_slice(&2000i64.to_le_bytes());
        let process = process_event::decode(
            2,
            version,
            999,
            &bytes,
            |_| panic!("stop must not resolve paths"),
            |_| panic!("stop must not resolve packages"),
        )
        .unwrap();
        assert_eq!(process.key.started, 1000);
        assert_eq!(process.exited, Some(2000));
        assert_eq!(process.exited_at, Some(999));
        assert!(process.name.is_empty());
        assert!(process.path.is_none());
    }
}
#[test]
fn unknown_schema_sid_truncation_and_pid_overflow_fail_closed() {
    assert!(process_event::decode(1, 5, 0, &[], |_| None, |_| None)
        .unwrap_err()
        .0
        .contains("Unsupported"));
    let mut bytes = start(4);
    bytes[..4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(process_event::decode(1, 4, 0, &bytes, |_| None, |_| None).is_err());
    let mut bytes = start(4);
    bytes[49] = 255;
    assert!(process_event::decode(1, 4, 0, &bytes, |_| None, |_| None).is_err());
}
