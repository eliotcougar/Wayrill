// SPDX-License-Identifier: GPL-3.0-only
use wayrill_capture::{
    address::Address,
    events::EventQueue,
    interfaces::{self, InterfaceInfo, InterfacePolicy, LocalTraffic},
    packet::Flow,
    policy::{InterfaceItem, InterfaceOptions},
    process::{ProcessInfo, ProcessKey},
    services::{ServiceInfo, ServiceSnapshot},
    Error,
};

#[test]
fn loopback_versions_preserve_the_existing_lowercase_hex_encoding() {
    let entries =
        std::collections::BTreeMap::from([("S-1-15-2-456".into(), 0), ("S-1-15-2-123".into(), 4)]);
    assert_eq!(
        wayrill_capture::native::loopback::version(&entries).unwrap(),
        "05c51f375844a661f4c7ef29bbb15ef805ce8e3f726d7fccb5149431acd673a4"
    );
}

fn adapter(id: &str, index: u32) -> InterfaceInfo {
    InterfaceInfo {
        id: id.into(),
        name: "Ethernet".into(),
        description: "QA".into(),
        status: 1,
        ipv4_index: index,
        ipv6_index: index,
        addresses: vec![
            ("192.168.137.1".parse().unwrap(), 24),
            ("fd00:1234::1".parse().unwrap(), 64),
        ],
    }
}
fn flow(remote: &str, local_port: u16, remote_port: u16) -> Flow {
    Flow {
        protocol: 17,
        local: Address {
            ip: "192.168.137.1".parse().unwrap(),
            scope: 0,
        },
        remote: Address {
            ip: remote.parse().unwrap(),
            scope: 0,
        },
        local_port,
        remote_port,
    }
}
#[test]
fn native_local_bypass_preserves_discovery_without_bypassing_arbitrary_lan_or_public_traffic() {
    let local = LocalTraffic::new(&[adapter("nic", 7)]);
    for ip in [
        "239.1.2.3",
        "255.255.255.255",
        "169.254.1.1",
        "192.168.137.255",
        "ff02::1",
        "fe80::1",
    ] {
        assert!(local.bypasses_address(7, ip.parse().unwrap()), "{ip}");
    }
    assert!(!local.bypasses_address(7, "192.168.137.10".parse().unwrap()));
    assert!(local.bypasses_flow(7, flow("192.168.137.10", 5353, 50000)));
    assert!(!local.bypasses_flow(7, flow("203.0.113.5", 5353, 50000)));
    assert!(local.bypasses_flow(7, flow("203.0.113.5", 68, 67)));
    assert!(!local.bypasses_flow(
        7,
        Flow {
            protocol: 6,
            ..flow("203.0.113.5", 68, 67)
        }
    ));
    assert!(local.bypasses_flow(7, flow("fd00:1234::10", 5353, 50000)));
    assert!(!local.bypasses_flow(8, flow("fd00:1234::10", 5353, 50000)));
}
#[test]
fn owned_guid_cannot_be_selected_and_reused_foreign_index_does_not_retain_flows() {
    let owned = "11223344-5566-7788-99aa-bbccddeeff00";
    let options = InterfaceOptions {
        monitor_new_interfaces: true,
        interfaces: vec![InterfaceItem {
            id: format!("{{{owned}}}"),
            name: "owned".into(),
            monitored: true,
        }],
    };
    let previous = InterfacePolicy::new(
        &options,
        &[adapter(&format!("{{{owned}}}"), 7)],
        true,
        &[owned.into()],
    )
    .unwrap();
    assert!(!previous.monitors(7, false));
    assert!(!previous.monitors(7, true));
    assert!(previous.monitors(8, false));
    let next =
        InterfacePolicy::new(&options, &[adapter("foreign", 7)], true, &[owned.into()]).unwrap();
    assert!(next.monitors(7, false));
    assert!(!next.retains(&previous, 7, false));
    assert!(InterfacePolicy::new(&options, &[], true, &["bad identity".into()]).is_err());
}
#[test]
fn first_seen_interface_choices_survive_new_default_and_name_changes() {
    let original = InterfaceOptions {
        monitor_new_interfaces: false,
        interfaces: vec![],
    };
    let known = interfaces::discover(&original, &[adapter("nic", 7)]);
    let changed = InterfaceOptions {
        monitor_new_interfaces: true,
        ..known
    };
    let mut renamed = adapter("nic", 7);
    renamed.name = "New WiFi".into();
    let updated = interfaces::discover(&changed, &[renamed, adapter("new", 8)]);
    assert!(!updated.interfaces[0].monitored);
    assert_eq!(updated.interfaces[0].name, "New WiFi");
    assert!(updated.interfaces[1].monitored);
    let disabled_bypass = InterfacePolicy::new(&updated, &[adapter("nic", 7)], false, &[]).unwrap();
    assert!(!disabled_bypass.bypasses_address(7, "239.1.2.3".parse().unwrap()));
}
#[test]
fn shared_service_resolution_requires_exact_process_generation() {
    let process = ProcessInfo {
        key: ProcessKey {
            pid: 41,
            started: 100,
        },
        parent_pid: 0,
        name: "svchost.exe".into(),
        path: None,
        exited: None,
        sequence: 0,
        parent_sequence: 0,
        started_at: 0,
        exited_at: None,
        package: Some(String::new()),
    };
    let services = [
        ServiceInfo {
            name: "Dnscache".into(),
            display_name: "DNS".into(),
            pid: 41,
        },
        ServiceInfo {
            name: "BITS".into(),
            display_name: "BITS".into(),
            pid: 41,
        },
    ];
    let snapshot = ServiceSnapshot::new(
        &services,
        std::slice::from_ref(&process),
        &["dnscache".into()],
    );
    assert!(snapshot.has_selected_hosts());
    assert!(snapshot.needs_module(41));
    assert_eq!(snapshot.resolve(process.key, None), None);
    assert_eq!(
        snapshot.resolve(process.key, Some("dnsCACHE")),
        Some("Dnscache")
    );
    assert_eq!(
        snapshot.resolve(
            ProcessKey {
                started: 101,
                ..process.key
            },
            Some("Dnscache")
        ),
        None
    );
    assert!(!snapshot.contains_selected(ProcessKey {
        started: 101,
        ..process.key
    }));
}
#[test]
fn event_health_flush_does_not_hold_the_callback_lock() {
    let events = EventQueue::new("test");
    events.add(1).unwrap();
    assert_eq!(
        events
            .drain(|| {
                events.add(2)?;
                Ok(())
            })
            .unwrap(),
        vec![1, 2]
    );
    events.add(3).unwrap();
    events.fail(Error::invalid("reader died")).unwrap();
    assert!(events
        .drain(|| Ok(()))
        .unwrap_err()
        .0
        .contains("reader died"));
    assert!(events.drain(|| Ok(())).is_err());
}
#[test]
fn event_overflow_never_returns_a_silently_incomplete_history() {
    let events = EventQueue::new("test");
    for i in 0..32769 {
        events.add(i).unwrap();
    }
    assert!(events
        .drain(|| Ok(()))
        .unwrap_err()
        .0
        .contains("overflowed"));
}
