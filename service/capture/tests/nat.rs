// SPDX-License-Identifier: GPL-3.0-only
use std::sync::Arc;
use wayrill_capture::{
    address::{Address, DivertAddress},
    nat::NatTable,
    packet::{Flow, Packet},
    policy::{Endpoint, Identity, Input, InterfaceOptions, Plan, SharedPolicy},
};
fn setup() -> (Arc<SharedPolicy>, Flow) {
    let policy = Arc::new(
        SharedPolicy::new(Plan {
            inputs: vec![Input {
                tag: "QA".into(),
                selectors: vec![],
                ports: String::new(),
                networks: vec!["tcp".into(), "udp".into()],
                endpoint: Endpoint {
                    port: 22080,
                    username: "private".into(),
                    password: "secret".into(),
                },
                predicates: vec![],
                masks: vec!["0".into()],
            }],
            interfaces: InterfaceOptions::default(),
            bypass_local_traffic: true,
        })
        .unwrap(),
    );
    let flow = Flow {
        protocol: 6,
        local: Address {
            ip: "10.0.2.15".parse().unwrap(),
            scope: 0,
        },
        remote: Address {
            ip: "203.0.113.7".parse().unwrap(),
            scope: 0,
        },
        local_port: 50000,
        remote_port: 443,
    };
    (policy, flow)
}
#[test]
fn syn_retransmissions_reuse_mapping_but_new_generation_keeps_old_reverse_tombstone() {
    let (policy, flow) = setup();
    let rule = policy
        .select(&[Identity::new("client.exe", None, Some(""))], None)
        .unwrap()
        .unwrap();
    let table = NatTable::default();
    let original = table
        .get_or_add(flow, rule.clone(), 123, DivertAddress::default(), 0)
        .unwrap();
    assert!(Arc::ptr_eq(
        &original,
        &table.find(flow, Some(123), 1).unwrap().unwrap()
    ));
    assert!(table.find(flow, Some(124), 2).unwrap().is_none());
    assert!(original.retired());
    let replacement = table
        .get_or_add(flow, rule, 124, DivertAddress::default(), 2)
        .unwrap();
    assert_ne!(original.translated_port, replacement.translated_port);
    // Keep the old port reserved, but never forward its late relay packets into
    // the replacement application's stream.
    assert!(table
        .reverse(flow.local, flow.remote, original.translated_port)
        .unwrap()
        .is_none());
    assert!(table.may_be_reflection(flow.local, flow.remote).unwrap());
    assert!(Arc::ptr_eq(
        &replacement,
        &table
            .reverse(flow.local, flow.remote, replacement.translated_port)
            .unwrap()
            .unwrap()
    ));
    table.expire(120003).unwrap();
    assert!(table
        .reverse(flow.local, flow.remote, original.translated_port)
        .unwrap()
        .is_none());
}
#[test]
fn revocation_keeps_forward_tombstone_and_cancels_relay_before_or_after_accept() {
    let (policy, flow) = setup();
    let rule = policy
        .select(&[Identity::new("client.exe", None, Some(""))], None)
        .unwrap()
        .unwrap();
    let table = NatTable::default();
    let entry = table
        .get_or_add(flow, rule.clone(), 123, DivertAddress::default(), 0)
        .unwrap();
    let relay = entry.begin_relay().unwrap();
    assert!(!*relay.borrow());
    assert_eq!(table.retain(Some(&policy), |_| true, 1).unwrap().len(), 0);
    assert_eq!(table.retain(None, |_| true, 2).unwrap().len(), 1);
    assert!(*relay.borrow());
    assert!(table.find(flow, None, 3).unwrap().unwrap().closed());
    assert!(table
        .reverse(flow.local, flow.remote, entry.translated_port)
        .unwrap()
        .is_none());
    let next = table
        .get_or_add(
            Flow {
                local_port: 50001,
                ..flow
            },
            rule,
            0,
            DivertAddress::default(),
            3,
        )
        .unwrap();
    next.retire(4).unwrap();
    assert!(*next.begin_relay().unwrap().borrow());
    assert!(next.begin_relay().is_err());
}
#[test]
fn accepted_idle_tcp_survives_expiry_and_reset_uses_latest_ack() {
    let (policy, flow) = setup();
    let rule = policy
        .select(&[Identity::new("client.exe", None, Some(""))], None)
        .unwrap()
        .unwrap();
    let table = NatTable::default();
    let entry = table
        .get_or_add(flow, rule, u32::MAX, DivertAddress::default(), 0)
        .unwrap();
    entry.set_accepted(true);
    table.expire(999999).unwrap();
    assert!(table.find(flow, None, 999999).unwrap().is_some());
    let reset = entry.create_reset().unwrap();
    assert_eq!(&reset[28..32], &[0; 4]);
    entry.acknowledge(456);
    let reset = entry.create_reset().unwrap();
    let parsed = Packet::parse(&reset, 0).unwrap();
    assert_eq!(parsed.tcp_sequence, 456);
    assert_eq!(parsed.tcp_flags, 4);
}
#[test]
fn translated_ports_never_alias_live_or_retained_connections_at_capacity() {
    let (policy, flow) = setup();
    let rule = policy
        .select(&[Identity::new("client.exe", None, Some(""))], None)
        .unwrap()
        .unwrap();
    let table = NatTable::default();
    let mut ports = std::collections::HashSet::new();
    for port in 1..=64512 {
        let entry = table
            .get_or_add(
                Flow {
                    local_port: port,
                    ..flow
                },
                rule.clone(),
                0,
                DivertAddress::default(),
                0,
            )
            .unwrap();
        assert!(ports.insert(entry.translated_port));
    }
    assert!(table
        .get_or_add(
            Flow {
                local_port: 65000,
                ..flow
            },
            rule.clone(),
            0,
            DivertAddress::default(),
            0
        )
        .is_err());
    table.expire(120001).unwrap();
    assert!(table
        .get_or_add(
            Flow {
                local_port: 65000,
                ..flow
            },
            rule,
            0,
            DivertAddress::default(),
            120001
        )
        .is_ok());
}
