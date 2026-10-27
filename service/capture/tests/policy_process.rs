// SPDX-License-Identifier: GPL-3.0-only
use std::sync::Arc;
use wayrill_capture::{
    address::Address,
    packet::Flow,
    policy::{Endpoint, Identity, Input, InterfaceOptions, Plan, Selector, SharedPolicy},
    process::{Kind, ProcessInfo, ProcessKey, ProcessTree},
    text,
};

fn selector(kind: &str, value: &str, mode: &str, children: bool) -> Selector {
    Selector {
        kind: kind.into(),
        value: value.into(),
        mode: mode.into(),
        children,
        enabled: true,
    }
}
fn input(tag: &str, ports: &str, selectors: Vec<Selector>) -> Input {
    Input {
        tag: tag.into(),
        ports: ports.into(),
        selectors,
        networks: vec!["tcp".into(), "udp".into()],
        endpoint: Endpoint {
            port: 22080,
            username: "private".into(),
            password: "secret".into(),
        },
        predicates: vec![],
        masks: vec!["0".into()],
    }
}
fn policy(inputs: Vec<Input>) -> Arc<SharedPolicy> {
    Arc::new(
        SharedPolicy::new(Plan {
            inputs,
            interfaces: InterfaceOptions::default(),
            bypass_local_traffic: true,
        })
        .unwrap(),
    )
}
fn client() -> Identity {
    Identity::new("client.exe", Some("C:\\apps\\client.exe"), Some(""))
}
fn tcp() -> Flow {
    Flow {
        protocol: 6,
        local: Address {
            ip: "127.0.0.1".parse().unwrap(),
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
fn process(pid: u32, started: i64, parent: u32, name: &str) -> ProcessInfo {
    ProcessInfo {
        key: ProcessKey { pid, started },
        parent_pid: parent,
        name: name.into(),
        path: Some(format!("C:\\apps\\{name}")),
        exited: None,
        sequence: 0,
        parent_sequence: 0,
        started_at: 10,
        exited_at: None,
        package: Some("".into()),
    }
}
#[test]
fn loss_reconciliation_keeps_proven_ancestry_and_blocks_gap_generations() {
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("process", "parent", "name", true)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    let mut parent = process(100, 1000, 0, "parent.exe");
    parent.exited = Some(1400);
    let child = process(101, 1200, 100, "child.exe");
    tree.update([parent, child.clone()], 1500).unwrap();
    assert_eq!(
        tree.decide(child.key, 900, None).unwrap().kind,
        Kind::Selected
    );

    // Complete polling after loss must not invent a missing start/ancestry
    // event or reset the observation epoch, even for a directly matching name.
    let mut gap = process(102, 1600, 100, "parent.exe");
    gap.started_at = 0;
    tree.update([child.clone(), gap.clone()], 1700).unwrap();
    assert_eq!(
        tree.decide(child.key, 900, None).unwrap().kind,
        Kind::Selected
    );
    assert_eq!(
        tree.decide(gap.key, 900, None).unwrap().kind,
        Kind::Unresolved
    );
    let descendant = process(103, 1650, 102, "child.exe");
    tree.update([descendant.clone()], 1700).unwrap();
    assert_eq!(
        tree.decide(descendant.key, 900, None).unwrap().kind,
        Kind::Unresolved
    );
}
#[test]
fn process_history_budget_accounts_for_string_capacity() {
    let mut tree = ProcessTree::new(None, []);
    let mut info = process(1, 100, 0, "large.exe");
    info.path = Some(String::with_capacity(64 * 1024 * 1024 + 1));
    assert!(tree
        .update([info], 200)
        .unwrap_err()
        .to_string()
        .contains("capacity"));
}
#[test]
fn process_decisions_do_not_attribute_historical_packets_to_poll_only_reused_pid() {
    use wayrill_capture::process_decisions::ProcessDecisions;
    let mut tree = ProcessTree::new(Some(policy(vec![input("all", "", vec![])])), []);
    let mut old = process(100, 1000, 0, "old.exe");
    old.started_at = 50;
    old.exited = Some(2100);
    old.exited_at = Some(150);
    let mut new = process(100, 2200, 0, "new.exe");
    new.started_at = 0;
    tree.update([old, new.clone()], 2300).unwrap();
    let mut decisions = ProcessDecisions::new(&tree, 2000, None);
    assert_eq!(decisions.at(100, 100, None).unwrap().kind, Kind::Unresolved);
    assert!(decisions.owner_at(100, 100).is_none());
    new.started_at = 200;
    tree.update([new], 2300).unwrap();
    let mut decisions = ProcessDecisions::new(&tree, 2000, None);
    assert_eq!(decisions.owner_at(100, 100).unwrap().key.started, 1000);
    assert!(decisions.owner_at(100, 175).is_none());
    assert_eq!(decisions.owner_at(100, 250).unwrap().key.started, 2200);
    assert_eq!(
        decisions
            .current(100, None)
            .unwrap()
            .process
            .unwrap()
            .started,
        2200
    );
}
#[test]
fn shared_service_host_pending_decision_does_not_poison_resolved_service_cache() {
    use wayrill_capture::{
        process_decisions::ProcessDecisions,
        services::{ServiceInfo, ServiceSnapshot},
    };
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("service", "DnsClient", "name", false)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    tree.update([process(100, 1000, 0, "svchost.exe")], 1000)
        .unwrap();
    let services = ServiceSnapshot::new(
        &[
            ServiceInfo {
                name: "DnsClient".into(),
                display_name: String::new(),
                pid: 100,
            },
            ServiceInfo {
                name: "OtherService".into(),
                display_name: String::new(),
                pid: 100,
            },
        ],
        tree.processes(),
        &["DnsClient".into()],
    );
    let mut decisions = ProcessDecisions::new(&tree, 0, Some(&services));
    assert!(decisions.current(100, None).unwrap().service_pending);
    assert_eq!(
        decisions.current(100, Some("dnsclient")).unwrap().kind,
        Kind::Selected
    );
    assert_eq!(
        decisions.current(100, Some("OtherService")).unwrap().kind,
        Kind::Unselected
    );
    assert!(
        decisions
            .current(100, Some("unknown-module"))
            .unwrap()
            .service_pending
    );
    assert_eq!(
        decisions.current(100, Some("DnsClient")).unwrap().kind,
        Kind::Selected
    );
}
#[test]
fn first_eligible_input_wins_after_port_and_network_selection() {
    let mut udp = input("udp", "443", vec![]);
    udp.networks = vec!["udp".into()];
    let policy = policy(vec![
        udp,
        input("https", "443", vec![]),
        input("last", "", vec![]),
    ]);
    let target = policy.select(&[client()], None).unwrap().unwrap();
    assert_eq!(target.for_flow(tcp()).unwrap().id, "input:1:0");
    assert_eq!(
        target
            .for_flow(Flow {
                protocol: 17,
                ..tcp()
            })
            .unwrap()
            .id,
        "input:0:0"
    );
    assert_eq!(
        target
            .for_flow(Flow {
                remote_port: 80,
                ..tcp()
            })
            .unwrap()
            .id,
        "input:2:0"
    );
}
#[test]
fn masks_encode_every_matching_predicate_and_stable_arc_identity() {
    let mut branch = input("rules", "", vec![]);
    branch.predicates = vec![
        vec![selector("process", "client.exe", "name", false)],
        vec![selector("process", "C:\\apps", "folder", false)],
        vec![selector("service", "Dnscache", "name", false)],
    ];
    branch.masks = (0..8).map(|i| format!("{i:x}")).collect();
    let policy = policy(vec![branch]);
    let first = policy
        .select(&[client()], Some("dnscache"))
        .unwrap()
        .unwrap();
    let second = policy
        .select(&[client()], Some("DNSCACHE"))
        .unwrap()
        .unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(first.endpoint.as_ref().unwrap().username, "wr-7-private");
    let plain = policy.select(&[client()], None).unwrap().unwrap();
    assert_eq!(plain.endpoint.as_ref().unwrap().username, "wr-3-private");
    assert!(policy.retains(&first));
    assert!(policy.needs_path("client.exe", false));
    assert!(!policy.needs_path("client.exe", true));
    assert_eq!(policy.service_names, vec!["Dnscache"]);
    let replacement = super_policy();
    assert!(!replacement.retains(&first));
}
fn super_policy() -> Arc<SharedPolicy> {
    policy(vec![input("replacement", "", vec![])])
}
#[test]
fn package_ancestry_folder_boundaries_and_service_names_are_exact() {
    let package = policy(vec![input(
        "package",
        "",
        vec![selector("package", "App_family", "name", true)],
    )]);
    let parent = Identity::new(
        "launcher.exe",
        Some("C:/apps/launcher.exe"),
        Some("App_family"),
    );
    assert!(package.select(&[client(), parent], None).unwrap().is_some());
    assert!(package.select(&[client()], None).unwrap().is_none());
    let folder = policy(vec![input(
        "folder",
        "",
        vec![selector("process", "C:\\apps", "folder", true)],
    )]);
    assert!(folder.select(&[client()], None).unwrap().is_some());
    assert!(folder
        .select(
            &[Identity::new(
                "client.exe",
                Some("C:/apps-other/client.exe"),
                Some("")
            )],
            None
        )
        .unwrap()
        .is_none());
    let services = policy(vec![input(
        "DNS",
        "",
        vec![selector("service", "Dnscache", "name", true)],
    )]);
    assert!(services
        .select(&[client()], Some("BITS"))
        .unwrap()
        .is_none());
    assert!(services.select(&[client()], None).unwrap().is_none());
    assert!(services
        .select(&[client()], Some("DNSCache"))
        .unwrap()
        .is_some());
}
#[test]
fn missing_or_uncompiled_identity_is_an_error_not_fallback() {
    let mut branch = input("bad", "", vec![]);
    branch.masks.clear();
    assert!(SharedPolicy::new(Plan {
        inputs: vec![branch],
        interfaces: InterfaceOptions::default(),
        bypass_local_traffic: true
    })
    .is_err());
    let mut branch = input("bad", "", vec![]);
    branch.predicates = vec![vec![selector("process", "client.exe", "name", false)]];
    let policy = policy(vec![branch]);
    assert!(policy.select(&[client()], None).is_err());
}
#[test]
fn malformed_ports_do_not_broaden_capture() {
    for invalid in ["0", "1-0", "65536", "443,", "1-2-3", "bad"] {
        assert!(
            SharedPolicy::new(Plan {
                inputs: vec![input("bad", invalid, vec![])],
                interfaces: InterfaceOptions::default(),
                bypass_local_traffic: true
            })
            .is_err(),
            "{invalid}"
        );
    }
}
#[test]
fn windows_ordinal_matching_handles_unicode_without_expanding_or_using_locale() {
    assert!(text::equal("КЛИЕНТ🌍.exe", "клиент🌍.exe"));
    assert!(text::starts_with(
        "C:/ПРОГРАММЫ/🌍/app.exe",
        "c:/программы/🌍/"
    ));
    assert!(!text::equal("straße.exe", "STRASSE.exe"));
    assert!(text::protected("C:\\app\\XRAY.EXE"));
}
#[test]
fn recycled_parent_does_not_inherit_and_live_ancestry_survives_launcher_exit() {
    let policy = policy(vec![input(
        "launcher",
        "",
        vec![selector("process", "launcher.exe", "name", true)],
    )]);
    let mut tree = ProcessTree::new(Some(policy), []);
    let parent = process(10, 100, 0, "launcher.exe");
    let child = process(20, 150, 10, "client.exe");
    tree.update([parent.clone(), child.clone()], 200).unwrap();
    assert_eq!(
        tree.decide(child.key, 0, None).unwrap().kind,
        Kind::Selected
    );
    tree.update(
        [
            ProcessInfo {
                exited: Some(160),
                ..parent.clone()
            },
            process(10, 170, 0, "other.exe"),
        ],
        300,
    )
    .unwrap();
    assert_eq!(
        tree.decide(child.key, 0, None).unwrap().kind,
        Kind::Selected
    );
    let next_child = process(21, 180, 10, "client.exe");
    tree.update([next_child.clone()], 400).unwrap();
    assert_eq!(
        tree.decide(next_child.key, 0, None).unwrap().kind,
        Kind::Unselected
    );
    tree.update([], 200_000_000).unwrap();
    assert!(tree.contains(parent.key));
}
#[test]
fn stopped_generation_is_not_resurrected_and_package_identity_is_not_erased() {
    let p = process(10, 100, 0, "client.exe");
    let mut tree = ProcessTree::new(None, []);
    let original = ProcessInfo {
        package: Some("App_family".into()),
        ..p.clone()
    };
    tree.update([original], 1000).unwrap();
    let stopped = ProcessInfo {
        name: String::new(),
        path: None,
        package: None,
        exited: Some(200),
        exited_at: Some(50),
        ..p.clone()
    };
    tree.update([stopped], 1000).unwrap();
    tree.update([p], 1000).unwrap();
    let observed = tree.processes().next().unwrap();
    assert_eq!(observed.exited, Some(200));
    assert_eq!(observed.exited_at, Some(50));
    assert_eq!(observed.name, "client.exe");
    assert_eq!(observed.package.as_deref(), Some("App_family"));
}
#[test]
fn uncertain_ancestry_and_package_identity_remain_unresolved() {
    let policy = policy(vec![input(
        "package",
        "",
        vec![selector("package", "App_family", "name", false)],
    )]);
    let mut tree = ProcessTree::new(Some(policy), []);
    let mut child = process(20, 150, 10, "client.exe");
    child.package = None;
    tree.update([child.clone()], 200).unwrap();
    assert_eq!(
        tree.decide(child.key, 0, None).unwrap().kind,
        Kind::Unresolved
    );
    child.package = Some("".into());
    tree.update([child.clone()], 200).unwrap();
    assert_eq!(
        tree.decide(child.key, 100, None).unwrap().kind,
        Kind::Unresolved
    );
    tree.set_rules(None, [child.key]);
    assert_eq!(
        tree.decide(child.key, 0, None).unwrap().kind,
        Kind::Unselected
    );
}

#[test]
fn native_absence_retires_lost_exits_but_preserves_known_ancestry() {
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("process", "parent", "name", true)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    let parent = process(100, 1000, 0, "parent.exe");
    let child = process(101, 1200, 100, "child.exe");
    let orphan = process(102, 1300, 0, "orphan.exe");
    tree.update([parent.clone(), child.clone(), orphan.clone()], 1500)
        .unwrap();
    tree.reconcile_presence(2000, |key| key == child.key);
    // Unknown exit timing is not invented, and a known child's lineage survives.
    assert!(tree
        .processes()
        .find(|p| p.key == parent.key)
        .unwrap()
        .exited
        .is_none());
    tree.update([], 2000 + 110_000_000).unwrap();
    assert!(tree.contains(parent.key));
    assert!(!tree.contains(orphan.key));
    assert_eq!(
        tree.decide(child.key, 900, None).unwrap().kind,
        Kind::Selected
    );
    // A later child cannot inherit from a parent already proven absent.
    let later = process(103, 3000, 100, "later.exe");
    tree.update([later.clone()], 2000 + 110_000_000).unwrap();
    assert_eq!(
        tree.decide(later.key, 900, None).unwrap().kind,
        Kind::Unresolved
    );
}
#[test]
fn absence_does_not_retire_post_snapshot_births_or_a_present_identity() {
    let mut tree = ProcessTree::new(None, []);
    let future = process(100, 3000, 0, "future.exe");
    let present = process(101, 1000, 0, "present.exe");
    tree.update([future.clone(), present.clone()], 4000)
        .unwrap();
    tree.reconcile_presence(2000, |_| false);
    tree.reconcile_presence(2500, |key| key == present.key);
    tree.update([], 2000 + 110_000_000).unwrap();
    assert!(tree.contains(future.key));
    assert!(tree.contains(present.key));
}
#[test]
fn repeated_missing_exit_batches_remain_bounded_without_resetting_live_history() {
    let mut tree = ProcessTree::new(None, []);
    let live = process(100, 1, 0, "live.exe");
    tree.update([live.clone()], 2).unwrap();
    for batch in 0..80 {
        let now = 1_000_000_000 * (batch + 1);
        tree.update(
            (0..1000).map(|i| process((1000 + i) as u32, now + i, 0, "short.exe")),
            now,
        )
        .unwrap();
        assert_eq!(tree.processes().count(), 1001);
        tree.reconcile_presence(now + 1000, |key| key == live.key);
        tree.update([], now + 110_000_000).unwrap();
        assert_eq!(tree.processes().count(), 1);
    }
    assert!(tree.contains(live.key));
}

#[test]
fn current_snapshot_reconciles_lost_start_with_proven_parent() {
    use wayrill_capture::process_decisions::ProcessDecisions;
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("process", "parent", "name", true)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    let parent = process(100, 1000, 0, "parent.exe");
    let other = process(200, 1000, 0, "other.exe");
    tree.update([parent, other], 1500).unwrap();
    // ETW lost these new processes' start events. A complete native snapshot
    // still supplies exact creation generations, parents and package identity.
    let mut child = process(101, 2200, 100, "browser.exe");
    let mut helper = process(102, 2300, 101, "network.exe");
    let mut unrelated = process(201, 2400, 200, "client.exe");
    for info in [&mut child, &mut helper, &mut unrelated] {
        info.started_at = 0;
    }
    tree.update([child.clone(), helper.clone(), unrelated.clone()], 2500)
        .unwrap();
    let mut decisions = ProcessDecisions::new(&tree, 2000, None);
    assert_eq!(decisions.current(101, None).unwrap().kind, Kind::Selected);
    assert_eq!(decisions.current(102, None).unwrap().kind, Kind::Selected);
    assert_eq!(decisions.current(201, None).unwrap().kind, Kind::Unselected);
    assert_eq!(
        decisions.current(102, None).unwrap().process,
        Some(helper.key)
    );
    // Polling cannot fabricate the QPC lifetime of historical socket events.
    assert_eq!(decisions.at(101, 100, None).unwrap().kind, Kind::Unresolved);
    assert_eq!(decisions.at(102, 100, None).unwrap().kind, Kind::Unresolved);
    assert!(tree
        .processes()
        .filter(|p| p.key.started >= 2000)
        .all(|p| p.started_at == 0));
}

#[test]
fn late_child_cannot_adopt_an_absent_generation_with_unknown_exit() {
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("process", "parent", "name", true)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    let parent = process(100, 1000, 0, "parent.exe");
    tree.update([parent], 1500).unwrap();
    // Its exit was lost. A different generation reused PID 100, launched a
    // child and ended between polls, without leaving its own start event.
    tree.reconcile_presence(2000, |_| false);
    let child = process(101, 1700, 100, "child.exe");
    tree.update([child.clone()], 2100).unwrap();
    assert_eq!(
        tree.decide(child.key, 900, None).unwrap().kind,
        Kind::Unresolved
    );
}

#[test]
fn refreshed_parent_identity_cannot_keep_a_contradictory_cached_edge() {
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("process", "parent", "name", true)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    let mut child = process(101, 1700, 100, "child.exe");
    tree.update(
        [
            process(100, 1000, 0, "parent.exe"),
            process(200, 1100, 0, "other.exe"),
            child.clone(),
        ],
        1800,
    )
    .unwrap();
    assert_eq!(
        tree.decide(child.key, 900, None).unwrap().kind,
        Kind::Selected
    );
    child.parent_pid = 200;
    tree.update([child.clone()], 2100).unwrap();
    assert_eq!(
        tree.decide(child.key, 900, None).unwrap().kind,
        Kind::Unselected
    );
}

#[test]
fn stale_selected_service_host_waits_for_a_fresh_catalog_after_pid_reuse() {
    use wayrill_capture::{
        process_decisions::ProcessDecisions,
        services::{ServiceInfo, ServiceSnapshot},
    };
    let rules = policy(vec![input(
        "dns",
        "",
        vec![selector("service", "DnsClient", "name", false)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    let mut host = process(100, 1000, 0, "host.exe");
    tree.update([host.clone()], 1100).unwrap();
    let catalog = ServiceSnapshot::new(
        &[ServiceInfo {
            name: "DnsClient".into(),
            display_name: String::new(),
            pid: 100,
        }],
        tree.processes(),
        &["DnsClient".into()],
    );
    host.exited = Some(1200);
    let replacement = process(100, 1300, 0, "ordinary.exe");
    tree.update([host, replacement.clone()], 1400).unwrap();
    let mut decisions = ProcessDecisions::new(&tree, 900, Some(&catalog));
    let pending = decisions.current(100, None).unwrap();
    assert_eq!(pending.kind, Kind::Unresolved);
    assert!(pending.service_pending);
    assert_eq!(pending.process, Some(replacement.key));
    let fresh = ServiceSnapshot::new(&[], tree.processes(), &["DnsClient".into()]);
    let mut decisions = ProcessDecisions::new(&tree, 900, Some(&fresh));
    assert_eq!(decisions.current(100, None).unwrap().kind, Kind::Unselected);
}

#[test]
fn native_absence_blocks_current_ownership_without_erasing_child_history() {
    use wayrill_capture::process_decisions::ProcessDecisions;
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("process", "parent", "name", true)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    let parent = process(100, 1000, 0, "parent.exe");
    let child = process(101, 1200, 100, "child.exe");
    tree.update([parent.clone(), child.clone()], 1500).unwrap();
    tree.reconcile_presence(2000, |key| key == child.key);
    tree.refresh(2100).unwrap();
    let mut decisions = ProcessDecisions::new(&tree, 900, None);
    assert_eq!(decisions.current(100, None).unwrap().kind, Kind::Unresolved);
    assert_eq!(decisions.current(101, None).unwrap().kind, Kind::Selected);
}

#[test]
fn presence_is_applied_to_new_etw_nodes_before_building_parent_edges() {
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("process", "parent", "name", true)],
    )]);
    let mut tree = ProcessTree::new(Some(rules), []);
    let parent = process(100, 1000, 0, "parent.exe");
    let mut child = process(101, 1200, 100, "child.exe");
    tree.ingest([parent.clone(), child.clone()]);
    tree.reconcile_presence(2000, |key| key == child.key);
    tree.refresh(2100).unwrap();
    assert_eq!(
        tree.decide(child.key, 900, None).unwrap().kind,
        Kind::Unresolved
    );
    // A real parent sequence, unlike the PID alone, identifies that generation.
    let mut parent = parent;
    parent.sequence = 71;
    child.parent_sequence = 71;
    tree.update([parent, child.clone()], 2200).unwrap();
    assert_eq!(
        tree.decide(child.key, 900, None).unwrap().kind,
        Kind::Selected
    );
}

#[test]
fn parallel_classification_keeps_the_same_cached_target_identity() {
    let rules = policy(vec![input(
        "selected",
        "",
        vec![selector("process", "client", "name", false)],
    )]);
    let threads = (0..8)
        .map(|_| {
            let rules = rules.clone();
            std::thread::spawn(move || {
                let mut results = Vec::new();
                for _ in 0..100 {
                    results.push(rules.select(&[client()], None).unwrap().unwrap());
                }
                results
            })
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .flat_map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert!(results
        .iter()
        .all(|target| Arc::ptr_eq(target, &results[0]) && rules.retains(target)));
}
