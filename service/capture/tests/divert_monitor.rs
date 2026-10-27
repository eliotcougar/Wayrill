// SPDX-License-Identifier: GPL-3.0-only
use wayrill_capture::divert_monitor::{HandleInfo, HandleSnapshot};
fn handle(timestamp: i64, pid: u32, layer: i32) -> HandleInfo {
    HandleInfo {
        timestamp,
        pid,
        layer,
        flags: 0,
        priority: 100,
    }
}
#[test]
fn initial_snapshot_cannot_resurrect_a_closed_handle_or_replace_newer_metadata() {
    let mut snapshot = HandleSnapshot::default();
    snapshot.observe(handle(1, 41, 0), false).unwrap();
    snapshot.observe(handle(2, 42, 3), true).unwrap();
    snapshot
        .merge_initial([handle(1, 41, 0), handle(2, 42, 0), handle(3, 43, 1)])
        .unwrap();
    assert!(!snapshot.handles.contains_key(&(1, 41)));
    assert_eq!(snapshot.handles[&(2, 42)].layer, 3);
    assert_eq!(snapshot.foreign(99, None, None).unwrap().pid, 42);
}
#[test]
fn own_worker_service_and_passive_reflectors_do_not_block_capture() {
    let mut snapshot = HandleSnapshot::default();
    for h in [
        handle(1, 1, 0),
        handle(2, 2, 0),
        handle(3, 3, 3),
        handle(4, 4, 4),
    ] {
        snapshot.observe(h, true).unwrap();
    }
    assert!(snapshot.foreign(1, Some(2), Some(3)).is_none());
    snapshot.observe(handle(5, 5, 0), true).unwrap();
    assert_eq!(snapshot.foreign(1, Some(2), Some(3)).unwrap().pid, 5);
}
#[test]
fn observation_capacity_is_an_error_and_does_not_truncate_foreign_handles() {
    let mut snapshot = HandleSnapshot::default();
    for i in 0..4096 {
        snapshot.observe(handle(i, 41, 0), true).unwrap();
    }
    assert!(snapshot.observe(handle(4096, 41, 0), true).is_err());
    assert_eq!(snapshot.handles.len(), 4096);
    snapshot.observe(handle(0, 41, 1), true).unwrap();
    assert_eq!(snapshot.handles[&(0, 41)].layer, 1);
    let mut snapshot = HandleSnapshot::default();
    for i in 0..8192 {
        snapshot.observe(handle(i, 41, 0), false).unwrap();
    }
    assert!(snapshot.observe(handle(8192, 41, 0), false).is_err());
}
