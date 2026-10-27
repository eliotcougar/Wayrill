// SPDX-License-Identifier: GPL-3.0-only
use wayrill_capture::sharing::*;
const PUBLIC: &str = "830b3b6e-fa82-4103-8ff5-66f93d1dafa4";
const PRIVATE: &str = "22944640-3598-4b5d-aa13-06ea38f26fb0";
const TUN: &str = "cffb700e-7385-4f51-b99c-4947414b0800";
fn service() -> Mapping {
    Mapping {
        name: "DNS для клиентов".into(),
        protocol: 17,
        external_port: 53,
        internal_port: 53,
        target: String::new(),
        target_name: "localhost".into(),
    }
}
fn connection(id: &str, role: Option<i32>) -> Connection {
    Connection {
        id: id.into(),
        name: id.into(),
        role,
        ipv4: if role == Some(1) {
            vec![Address {
                address: "192.168.137.1".into(),
                prefix: 24,
            }]
        } else {
            vec![]
        },
        dns: vec![],
        dhcp: role != Some(1),
        has_port_mappings: false,
        port_mappings: vec![],
        private_services: if role == Some(1) {
            vec![service()]
        } else {
            vec![]
        },
    }
}
fn snapshot() -> Snapshot {
    Snapshot {
        connections: vec![
            connection(PUBLIC, Some(0)),
            connection(PRIVATE, Some(1)),
            connection(TUN, None),
        ],
    }
}
fn change(before: &Snapshot, id: &str, role: Option<i32>) -> Change {
    Change {
        id: id.into(),
        role,
        expected: before.roles(),
        private: before
            .connections
            .iter()
            .find(|c| c.id == PRIVATE)
            .unwrap()
            .clone(),
        restore_private_services: vec![],
    }
}
#[test]
fn sharing_handoff_preserves_independent_private_edits_and_roles() {
    let before = snapshot();
    let request = change(&before, PUBLIC, None);
    request.validate().unwrap();
    request.validate_expected(&before).unwrap();
    let mut after = before.clone();
    after.connections[0].role = None;
    request.validate_result(&after, true).unwrap();
    after.connections[1].dns.push("192.0.2.1".into());
    assert!(request
        .validate_result(&after, true)
        .unwrap_err()
        .0
        .contains("DNS servers"));
    after.connections[1].dns.clear();
    after.connections[1].private_services.clear();
    assert!(request
        .validate_result(&after, true)
        .unwrap_err()
        .0
        .contains("Windows gateway services"));
    let mut foreign = before.clone();
    foreign.connections[2].role = Some(0);
    assert!(request
        .validate_expected(&foreign)
        .unwrap_err()
        .0
        .contains("roles no longer match"));
}
#[test]
fn private_handoff_waits_for_native_dhcp_address_and_gateway_settling() {
    let before = snapshot();
    let request = change(&before, PRIVATE, None);
    let mut pending = before.clone();
    pending.connections[1].role = None;
    request.validate_result(&pending, false).unwrap();
    assert!(!request.private_transition_ready(&pending));
    pending.connections[1].dhcp = true;
    pending.connections[1].ipv4.clear();
    assert!(!request.private_transition_ready(&pending));
    pending.connections[1].private_services.clear();
    assert!(request.private_transition_ready(&pending));
    let mut restore = change(&pending, PRIVATE, Some(1));
    restore.restore_private_services = vec![service()];
    restore.validate().unwrap();
    let mut restored = pending.clone();
    restored.connections[1] = connection(PRIVATE, Some(1));
    restore.validate_result(&restored, true).unwrap();
    assert!(restore.private_transition_ready(&restored));
    restored.connections[1].ipv4[0].address = "192.168.138.1".into();
    assert!(!restore.private_transition_ready(&restored));
}
#[test]
fn completed_private_transition_cannot_wait_forever_on_unchanging_wrong_dns() {
    let before = snapshot();
    let mut request = change(&before, PRIVATE, Some(1));
    request.restore_private_services = vec![service()];
    let mut pending = before.clone();
    pending.connections[1].dns = vec!["192.168.137.254".into()];
    let mut settling = PrivateSettling::default();
    assert!(!settling.observe(&request, &pending, 1_000).unwrap());
    assert!(!settling.observe(&request, &pending, 30_999).unwrap());
    let error = settling.observe(&request, &pending, 31_000).unwrap_err();
    assert!(error.0.contains("stopped progressing"));
    // Observation never writes the native settings or adopts the changed DNS.
    assert_eq!(pending.connections[1].dns, ["192.168.137.254"]);
    assert!(request.private.dns.is_empty());
}
#[test]
fn completed_private_transition_reports_disappearance_instead_of_waiting_forever() {
    let before = snapshot();
    let request = change(&before, PRIVATE, None);
    let mut pending = before.clone();
    pending.connections.remove(1);
    let error = PrivateSettling::default()
        .observe(&request, &pending, 1_000)
        .unwrap_err();
    assert!(error.0.contains("private sharing adapter is unavailable"));
}
#[test]
fn genuine_private_progress_renews_settling_without_an_overall_deadline() {
    let before = snapshot();
    let request = change(&before, PRIVATE, None);
    let mut pending = before.clone();
    pending.connections[1].role = None;
    let mut settling = PrivateSettling::default();
    assert!(!settling.observe(&request, &pending, 0).unwrap());
    pending.connections[1].dhcp = true;
    assert!(!settling.observe(&request, &pending, 29_000).unwrap());
    pending.connections[1].ipv4.clear();
    assert!(!settling.observe(&request, &pending, 58_000).unwrap());
    pending.connections[1].private_services.clear();
    assert!(!settling.observe(&request, &pending, 87_000).unwrap());
    assert!(!settling.observe(&request, &pending, 87_249).unwrap());
    assert!(settling.observe(&request, &pending, 87_250).unwrap());
    let mut foreign = pending;
    foreign.connections[2].role = Some(0);
    assert!(settling.observe(&request, &foreign, 87_251).is_err());
}
#[test]
fn localized_gateway_names_are_not_confused_with_custom_forwarding() {
    assert!(service().is_private_service());
    for protocol in [6, 17] {
        for port in [53, 67, 68, 1900, 2869] {
            let mut mapping = service();
            mapping.protocol = protocol;
            mapping.external_port = port;
            mapping.internal_port = port;
            assert_eq!(
                mapping.is_private_service(),
                matches!((protocol, port), (17, 53 | 67 | 68 | 1900) | (6, 2869))
            );
        }
    }
    let mut custom = service();
    custom.target = "192.168.137.2".into();
    assert!(!custom.is_private_service());
    custom = service();
    custom.external_port = 5353;
    assert!(!custom.is_private_service());
    let mut before = snapshot();
    before.connections[0].has_port_mappings = true;
    assert!(change(&before, PUBLIC, None)
        .validate_expected(&before)
        .unwrap_err()
        .0
        .contains("custom port forwarding"));
}
#[test]
fn malformed_roles_duplicate_restore_and_noncanonical_checkpoints_are_rejected() {
    let before = snapshot();
    let mut request = change(&before, PRIVATE, Some(1));
    request.expected[0].id = request.expected[0].id.to_uppercase();
    assert!(request.validate().is_err());
    request = change(&before, PRIVATE, Some(1));
    request.expected.push(request.expected[0].clone());
    assert!(request.validate().is_err());
    request = change(&before, PRIVATE, Some(1));
    request.restore_private_services = vec![service(), service()];
    assert!(request.validate().is_err());
    request = change(&before, PUBLIC, Some(0));
    request.restore_private_services = vec![service()];
    assert!(request.validate().is_err());
    request = change(&before, PRIVATE, Some(7));
    assert!(request.validate().is_err());
    assert_eq!(
        canonical_id(&format!("{{{}}}", PUBLIC.to_uppercase())).unwrap(),
        PUBLIC
    );
    assert!(canonical_id("not-an-adapter").is_none());
    assert!(!keep_address("169.254.2.3".parse().unwrap(), false));
    assert!(keep_address("169.254.2.3".parse().unwrap(), true));
    assert!(keep_address("192.168.137.1".parse().unwrap(), false));
}
