// SPDX-License-Identifier: GPL-3.0-only
use std::sync::Arc;
use wayrill_capture::{
    address::Address,
    attribution::{AttributionSnapshot, FlowOwner, OwnerRow},
    packet::Flow,
    policy::{Endpoint, Identity, Input, InterfaceOptions, Plan, Selector, SharedPolicy},
    process::{Decision, Kind, ProcessKey},
    sockets::{SocketEvent, SocketHistory},
};

fn flow() -> Flow {
    Flow {
        protocol: 17,
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
    }
}
fn selected() -> Decision {
    let policy = SharedPolicy::new(Plan {
        inputs: vec![Input {
            tag: "QA".into(),
            selectors: vec![],
            ports: "443".into(),
            networks: vec!["tcp".into(), "udp".into()],
            endpoint: Endpoint {
                port: 12345,
                username: "private".into(),
                password: "secret".into(),
            },
            predicates: vec![],
            masks: vec!["0".into()],
        }],
        interfaces: InterfaceOptions::default(),
        bypass_local_traffic: true,
    })
    .unwrap();
    let rule = policy
        .select(&[Identity::new("client.exe", None, Some(""))], None)
        .unwrap()
        .unwrap();
    Decision {
        kind: Kind::Selected,
        process: Some(ProcessKey {
            pid: 41,
            started: 100,
        }),
        rule: Some(rule),
        endpoint: 55,
        service_pending: false,
        accepted: false,
    }
}
fn event(event: u8, timestamp: i64, endpoint: u64, pid: u32, flow: Flow) -> SocketEvent {
    SocketEvent {
        event,
        timestamp,
        endpoint,
        pid,
        flow,
    }
}
#[test]
fn stale_or_temporarily_unresolved_service_does_not_retire_live_udp_but_reuse_does() {
    let original = selected();
    let owner = FlowOwner::new(original.clone());
    assert!(!owner.is_current(|| None).unwrap());
    assert!(!owner.invalidated().unwrap());
    let mut pending = original.clone();
    pending.kind = Kind::Unresolved;
    pending.rule = None;
    pending.service_pending = true;
    assert!(!owner.is_current(|| Some(pending)).unwrap());
    assert!(!owner.invalidated().unwrap());
    assert!(owner.is_current(|| Some(original.clone())).unwrap());
    let mut reused = original.clone();
    reused.endpoint += 1;
    assert!(!owner.is_current(|| Some(reused)).unwrap());
    assert!(owner.invalidated().unwrap());
    assert!(!owner.is_current(|| Some(original)).unwrap());
}
#[test]
fn replaced_policy_target_identity_is_not_reused_even_with_same_name() {
    let original = selected();
    let replacement = selected();
    assert_eq!(
        original.rule.as_ref().unwrap().id,
        replacement.rule.as_ref().unwrap().id
    );
    assert!(!Arc::ptr_eq(
        original.rule.as_ref().unwrap(),
        replacement.rule.as_ref().unwrap()
    ));
    assert!(!FlowOwner::new(original)
        .is_current(|| Some(replacement))
        .unwrap());
}
#[test]
fn udp_eligibility_is_applied_before_shared_bind_ambiguity() {
    let original = selected();
    let flow = flow();
    let rows = [
        OwnerRow {
            local: flow.local,
            port: flow.local_port,
            remote: None,
            remote_port: 0,
            pid: 41,
            module: None,
            state: 0,
        },
        OwnerRow {
            local: Address {
                ip: "0.0.0.0".parse().unwrap(),
                scope: 0,
            },
            pid: 42,
            ..OwnerRow {
                local: flow.local,
                port: flow.local_port,
                remote: None,
                remote_port: 0,
                pid: 41,
                module: None,
                state: 0,
            }
        },
    ];
    let snapshot = AttributionSnapshot::new(
        &[],
        &rows,
        |pid, _| {
            if pid == 41 {
                Ok(original.clone())
            } else {
                let mut d = Decision::new(Kind::Unselected);
                d.process = Some(ProcessKey { pid, started: 1 });
                Ok(d)
            }
        },
        100,
        None,
    )
    .unwrap();
    assert_eq!(snapshot.find(flow, 0).kind, Kind::Ambiguous);
    assert_eq!(
        snapshot
            .find(
                Flow {
                    remote_port: 80,
                    ..flow
                },
                0
            )
            .kind,
        Kind::Unselected
    );
    assert!(snapshot.find_fresh(flow, 601, 0, 0).is_none());
    assert!(snapshot.find_fresh(flow, 100, 101, 0).is_none());
}
#[test]
fn historical_packets_keep_original_owner_and_lifecycle_gap_is_not_assigned_to_new_owner() {
    let original = selected();
    let flow = flow();
    let mut history = SocketHistory::new(10000);
    history
        .update(
            vec![
                event(
                    3,
                    1,
                    1,
                    41,
                    Flow {
                        remote_port: 0,
                        ..flow
                    },
                ),
                event(7, 10, 1, 41, flow),
                event(
                    3,
                    12,
                    2,
                    42,
                    Flow {
                        remote_port: 0,
                        ..flow
                    },
                ),
            ],
            20,
            &|_, _| None,
            None,
        )
        .unwrap();
    let snapshot = history
        .snapshot(|pid, _| {
            let mut d = original.clone();
            d.process = Some(ProcessKey { pid, started: 100 });
            Ok(d)
        })
        .unwrap();
    assert_eq!(snapshot.find(flow, 5).unwrap().endpoint, 1);
    assert_eq!(snapshot.find(flow, 11).unwrap().kind, Kind::Unresolved);
    assert_eq!(snapshot.find(flow, 0).unwrap().endpoint, 2);
    let rows = [OwnerRow {
        local: flow.local,
        port: flow.local_port,
        remote: None,
        remote_port: 0,
        pid: 42,
        module: None,
        state: 0,
    }];
    let sampled = AttributionSnapshot::new(
        &[],
        &rows,
        |pid, _| {
            let mut d = original.clone();
            d.process = Some(ProcessKey { pid, started: 100 });
            Ok(d)
        },
        100,
        Some(snapshot),
    )
    .unwrap();
    assert_eq!(sampled.find(flow, 5).endpoint, 1);
}
#[test]
fn close_delivered_before_open_stays_closed_and_repeated_udp_authorization_is_not_new_lifetime() {
    let flow = flow();
    let mut history = SocketHistory::new(1000);
    history
        .update(vec![event(7, 20, 1, 41, flow)], 30, &|_, _| None, None)
        .unwrap();
    history
        .update(
            vec![event(
                3,
                10,
                1,
                41,
                Flow {
                    remote_port: 0,
                    ..flow
                },
            )],
            30,
            &|_, _| None,
            None,
        )
        .unwrap();
    let snapshot = history.snapshot(|_, _| Ok(selected())).unwrap();
    assert_eq!(snapshot.find(flow, 0).unwrap().kind, Kind::Unresolved);
    assert_eq!(snapshot.find(flow, 15).unwrap().kind, Kind::Selected);
    history
        .update(
            vec![
                event(
                    3,
                    30,
                    2,
                    41,
                    Flow {
                        remote_port: 0,
                        ..flow
                    },
                ),
                event(4, 31, 2, 41, flow),
                event(4, 32, 2, 41, flow),
            ],
            33,
            &|_, _| None,
            None,
        )
        .unwrap();
    assert_eq!(history.count(), 3);
}
#[test]
fn brief_table_absence_does_not_close_a_long_lived_endpoint() {
    let flow = flow();
    let mut history = SocketHistory::new(1000);
    history
        .update(
            vec![event(
                3,
                1,
                1,
                41,
                Flow {
                    remote_port: 0,
                    ..flow
                },
            )],
            1,
            &|_, _| None,
            None,
        )
        .unwrap();
    history
        .update(vec![], 10, &|_, _| None, Some(&|_| false))
        .unwrap();
    assert_eq!(
        history
            .snapshot(|_, _| Ok(selected()))
            .unwrap()
            .find(flow, 0)
            .unwrap()
            .kind,
        Kind::Selected
    );
    history
        .update(vec![], 20, &|_, _| None, Some(&|_| true))
        .unwrap();
    history
        .update(vec![], 30, &|_, _| None, Some(&|_| false))
        .unwrap();
    history
        .update(vec![], 1031, &|_, _| None, Some(&|_| false))
        .unwrap();
    assert!(history
        .snapshot(|_, _| Ok(selected()))
        .unwrap()
        .find(flow, 0)
        .is_none_or(|d| d.kind == Kind::Unresolved));
}
#[test]
fn listener_seed_preserves_incoming_tcp_and_explicit_connect_overrides_seed() {
    let flow = Flow {
        protocol: 6,
        local_port: 443,
        remote_port: 443,
        ..flow()
    };
    let rows = [
        OwnerRow {
            local: Address {
                ip: "0.0.0.0".parse().unwrap(),
                scope: 0,
            },
            port: 443,
            remote: Some(flow.remote),
            remote_port: 0,
            pid: 41,
            module: None,
            state: 2,
        },
        OwnerRow {
            local: flow.local,
            port: 443,
            remote: Some(flow.remote),
            remote_port: 443,
            pid: 41,
            module: None,
            state: 5,
        },
    ];
    let sampled = AttributionSnapshot::new(&rows, &[], |_, _| Ok(selected()), 100, None).unwrap();
    assert!(sampled.find(flow, 0).accepted);
    let mut history = SocketHistory::new(10000);
    history
        .update(vec![event(4, 1, 1, 41, flow)], 1, &|_, _| None, None)
        .unwrap();
    let events = history.snapshot(|_, _| Ok(selected())).unwrap();
    let sampled =
        AttributionSnapshot::new(&rows, &[], |_, _| Ok(selected()), 100, Some(events)).unwrap();
    assert_eq!(sampled.find(flow, 0).kind, Kind::Selected);
    assert!(!sampled.find(flow, 0).accepted);
}
#[test]
fn selector_deserialization_rejects_unknown_unicode_properties() {
    let error =
        serde_json::from_str::<Selector>(r#"{"kind":"process","value":"x","Имя🌍中文نام":true}"#)
            .unwrap_err();
    assert!(error.to_string().contains("Имя🌍中文نام"));
}
