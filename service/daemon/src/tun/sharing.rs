//! Native ICS ownership. Every role change has a durable before/pending record;
//! recovery accepts only the last state or that one pending operation's result.
use super::{
    clients,
    forwarding::{self, Lease, Phase},
};
use crate::{capture::Worker, lifecycle::SharingExit, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, TryRecvError},
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub tag: String,
    pub expected_version: String,
    pub public_id: String,
    pub private_id: String,
    pub upstream_tags: Vec<String>,
    #[serde(default)]
    pub ipv6: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Address {
    address: String,
    prefix: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortMapping {
    name: String,
    protocol: i32,
    external_port: i32,
    internal_port: i32,
    target: String,
    target_name: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connection {
    id: String,
    name: String,
    role: Option<u32>,
    ipv4: Vec<Address>,
    dns: Vec<String>,
    dhcp: bool,
    #[serde(default)]
    has_port_mappings: bool,
    #[serde(default)]
    port_mappings: Vec<PortMapping>,
    #[serde(default)]
    private_services: Vec<PortMapping>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    connections: Vec<Connection>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Keep {
    pub expected_version: String,
}
fn version(snapshot: &Snapshot) -> String {
    crate::system_native::hex(&Sha256::digest(serde_json::to_vec(snapshot).unwrap()))
}
fn valid(j: &Journal) -> bool {
    let ids = [
        j.original_public.id.as_str(),
        j.private.id.as_str(),
        j.owned_public.as_str(),
    ];
    j.version == 3
        && ids.iter().all(|id| guid(id))
        && ids[0] != ids[1]
        && !ids[..2].contains(&ids[2])
        && j.original_public.role == Some(0)
        && j.private.role == Some(1)
        && (!j.native_restore
            || (j.recovering
                && j.ipv6_forwarding.is_none()
                && j.ipv6_clients.is_none()
                && j.expected.iter().all(|r| r.id != j.owned_public)
                && j.pending.as_ref().is_none_or(|p| p.id != j.owned_public)))
        && j.expected_private.id == j.private.id
        && j.expected.len() <= 2
        && j.expected.windows(2).all(|w| w[0] < w[1])
        && j.expected.iter().all(|r| {
            if r.id == j.private.id {
                r.role == 1
            } else {
                (r.id == j.original_public.id || r.id == j.owned_public) && r.role == 0
            }
        })
        && j.expected.iter().filter(|r| r.role == 0).count() <= 1
        && j.pending.as_ref().is_none_or(|p| {
            ids.contains(&p.id.as_str())
                && p.role
                    .is_none_or(|role| role == if p.id == j.private.id { 1 } else { 0 })
        })
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Role {
    id: String,
    role: u32,
}
impl Snapshot {
    fn roles(&self) -> Vec<Role> {
        let mut roles: Vec<_> = self
            .connections
            .iter()
            .filter_map(|c| {
                c.role.map(|role| Role {
                    id: c.id.clone(),
                    role,
                })
            })
            .collect();
        roles.sort();
        roles
    }
    fn connection(&self, id: &str) -> Option<&Connection> {
        self.connections.iter().find(|c| c.id == id)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    id: String,
    role: Option<u32>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    original_public: Connection,
    private: Connection,
    owned_public: String,
    expected: Vec<Role>,
    expected_private: Connection,
    conflicted: bool,
    recovering: bool,
    pending: Option<Change>,
    #[serde(default)]
    native_restore: bool,
    #[serde(default)]
    ipv6_forwarding: Option<Lease>,
    #[serde(default)]
    ipv6_clients: Option<clients::Lease>,
}
// Retain the last confirmed native pair beyond the temporary capture lease.
// The previous owned GUID is only a missing-adapter recovery identity, never
// a request to adopt an existing adapter or infer a new native topology.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativePair {
    version: u32,
    public: Connection,
    private: Connection,
    previous_public: String,
    #[serde(default = "restore_native_default")]
    restore_native: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ipv6_forwarding: Option<bool>,
}
/// Record user intent before reactivating only the PnP device for safe Wintun
/// cleanup. Its IP interface remains down and sharing is not enabled here.
pub(super) fn record_disabled(data: &Path) -> Result<()> {
    let _transaction = super::keeper::mutation_lock()?;
    let path = data.join("tun-native-sharing.json");
    if let Some(mut pair) = storage::read::<NativePair>(&path)? {
        if !pair.valid() {
            return Err(error(
                "ICS_STATE",
                "The protected saved sharing configuration is invalid.",
            ));
        }
        if pair.restore_native {
            pair.restore_native = false;
            storage::write(&path, &pair)?;
        }
    }
    Ok(())
}
fn restore_native_default() -> bool {
    true
}
impl NativePair {
    fn from_journal(j: &Journal) -> Self {
        Self {
            version: 1,
            public: j.original_public.clone(),
            private: j.private.clone(),
            previous_public: j.owned_public.clone(),
            restore_native: true,
            ipv6_forwarding: j.ipv6_forwarding.as_ref().map(|l| l.original),
        }
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            connections: vec![self.public.clone(), self.private.clone()],
        }
    }
    fn same_pair(&self, public: &Connection, private: &Connection) -> bool {
        public.id == self.public.id
            && private.id == self.private.id
            && public.role == Some(0)
            && private.role == Some(1)
            && public.name == self.public.name
            && private.name == self.private.name
            && public.has_port_mappings == self.public.has_port_mappings
            && public.port_mappings == self.public.port_mappings
            && public.private_services == self.public.private_services
            && private.port_mappings == self.private.port_mappings
            && same_private(private, &self.private)
    }
    fn refreshed(&self, journal: &Journal) -> Self {
        let mut next = Self::from_journal(journal);
        if self.same_pair(&next.public, &next.private) {
            next.ipv6_forwarding = if self.restore_native {
                next.ipv6_forwarding.or(self.ipv6_forwarding)
            } else {
                self.ipv6_forwarding.or(next.ipv6_forwarding)
            };
            // Confirmation describes sharing, not the uplink's DHCP/DNS lease.
            // Keep that stable fingerprint; the live journal and GUID binding
            // still use the current interface and its current Windows state.
            next.public = self.public.clone();
        }
        next
    }
    fn valid(&self) -> bool {
        self.version == 1
            && guid(&self.public.id)
            && guid(&self.private.id)
            && self.public.id != self.private.id
            && guid(&self.previous_public)
            && self.previous_public != self.public.id
            && self.previous_public != self.private.id
            && topology(&self.snapshot(), &self.public.name).is_ok()
    }
    fn available(&self, snapshot: &Snapshot) -> Result<()> {
        let actual = snapshot.roles();
        let saved = self.snapshot().roles();
        // Disabling native public sharing can leave its private role behind,
        // and vice versa. Resume only a strict subset of this confirmed pair.
        if actual.len() >= saved.len() || actual.iter().any(|role| !saved.contains(role)) {
            return Err(error(
                "ICS_CONFLICT",
                "Another sharing configuration is active; saved sharing was left unchanged.",
            ));
        }
        let public = snapshot.connection(&self.public.id);
        let private = snapshot.connection(&self.private.id);
        let (Some(public), Some(private)) = (public, private) else {
            return Err(error("ICS_ADAPTER_MISSING", "Reconnect the saved Internet sharing adapters before starting or restoring sharing."));
        };
        let reset = private.role.is_none()
            && (private_reset(private)
                || (private.dhcp && private.dns.is_empty() && private.ipv4 == self.private.ipv4));
        if public.has_port_mappings
            || private.has_port_mappings
            || (!same_private(private, &self.private) && !reset)
        {
            return Err(error("ICS_PRIVATE_SETTINGS", "Private adapter settings differ from saved sharing. Review sharing or keep the current settings before restoring it."));
        }
        Ok(())
    }
    fn recovery(&self, snapshot: &Snapshot) -> Result<Journal> {
        self.available(snapshot)?;
        Ok(self.checkpoint(snapshot))
    }
    fn checkpoint(&self, snapshot: &Snapshot) -> Journal {
        Journal {
            version: 3,
            original_public: self.public.clone(),
            private: self.private.clone(),
            owned_public: self.previous_public.clone(),
            expected: snapshot.roles(),
            expected_private: snapshot.connection(&self.private.id).unwrap().clone(),
            conflicted: false,
            recovering: true,
            pending: None,
            native_restore: true,
            ipv6_forwarding: None,
            ipv6_clients: None,
        }
    }
}
fn error(code: &str, message: impl Into<String>) -> ApiError {
    ApiError::new(code, message)
}
pub(crate) fn valid_options(options: &Options) -> bool {
    valid_guid(&options.public_id)
        && valid_guid(&options.private_id)
        && options.public_id != options.private_id
        && options.expected_version.len() == 64
        && options
            .expected_version
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        && options.upstream_tags.len() <= wayrill_protocol::MAX_OUTBOUNDS
        && options
            .upstream_tags
            .iter()
            .all(|t| !t.is_empty() && t.len() <= 4096)
        && options
            .upstream_tags
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            == options.upstream_tags.len()
}
pub(super) fn valid_guid(value: &str) -> bool {
    guid(value)
}
fn guid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit() && !c.is_ascii_uppercase()
            }
        })
}
fn topology(snapshot: &Snapshot, uplink: &str) -> Result<(Connection, Connection)> {
    if snapshot.roles().len() != 2 {
        return Err(error(
            "ICS_TOPOLOGY",
            "ICS support requires one public and one private sharing adapter.",
        ));
    }
    let public = snapshot
        .connections
        .iter()
        .find(|c| c.role == Some(0))
        .ok_or_else(|| error("ICS_TOPOLOGY", "The shared Internet adapter is missing."))?;
    let private = snapshot
        .connections
        .iter()
        .find(|c| c.role == Some(1))
        .ok_or_else(|| error("ICS_TOPOLOGY", "The private sharing adapter is missing."))?;
    if public.name != uplink {
        return Err(error(
            "ICS_UPLINK",
            format!(
                "Select the existing ICS Internet adapter '{}' as TUN's uplink.",
                public.name
            ),
        ));
    }
    if public.has_port_mappings || private.has_port_mappings {
        return Err(error("ICS_PORT_MAPPINGS", "Enabled custom ICS port forwarding cannot be preserved by this capture mode. Review the listed mappings. Windows sharing was left unchanged."));
    }
    if private.dhcp
        || private.ipv4
            != [Address {
                address: "192.168.137.1".into(),
                prefix: 24,
            }]
        || !private.dns.is_empty()
    {
        return Err(error("ICS_PRIVATE_SETTINGS", "This first ICS mode supports Windows' standard 192.168.137.1/24 private adapter without custom DNS. Custom private settings were left unchanged."));
    }
    Ok((public.clone(), private.clone()))
}
fn changed(roles: &[Role], change: &Change) -> Vec<Role> {
    let mut next: Vec<_> = roles
        .iter()
        .filter(|r| r.id != change.id)
        .cloned()
        .collect();
    if let Some(role) = change.role {
        next.push(Role {
            id: change.id.clone(),
            role,
        });
    }
    next.sort();
    next
}
fn handoff(from: &str, to: &str, private: &str) -> [Change; 4] {
    [
        Change {
            id: from.into(),
            role: None,
        },
        Change {
            id: private.into(),
            role: None,
        },
        Change {
            id: to.into(),
            role: Some(0),
        },
        Change {
            id: private.into(),
            role: Some(1),
        },
    ]
}
fn baseline(journal: &Journal) -> Vec<Role> {
    let mut result = vec![
        Role {
            id: journal.original_public.id.clone(),
            role: 0,
        },
        Role {
            id: journal.private.id.clone(),
            role: 1,
        },
    ];
    result.sort();
    result
}
// During a transaction Windows may reset the private adapter itself. Preserve
// its last confirmed settings as well as roles before the next native operation.
fn compatible(journal: &Journal, snapshot: &Snapshot) -> bool {
    if snapshot
        .connections
        .iter()
        .any(|c| c.role.is_some() && c.has_port_mappings)
    {
        return false;
    }
    let actual = snapshot.roles();
    let pending_private = journal
        .pending
        .as_ref()
        .filter(|p| p.id == journal.private.id && actual == changed(&journal.expected, p));
    if snapshot.connection(&journal.private.id).is_some_and(|c| {
        !same_private(c, &journal.expected_private)
            && !pending_private.is_some_and(|p| {
                if p.role == Some(1) {
                    same_private(c, &journal.private)
                } else {
                    private_reset(c)
                }
            })
    }) {
        return false;
    }
    let allowed = |roles: Vec<Role>| {
        let present: Vec<_> = roles
            .into_iter()
            .filter(|r| r.id != journal.owned_public || snapshot.connection(&r.id).is_some())
            .collect();
        actual == present
    };
    allowed(journal.expected.clone())
        || journal
            .pending
            .as_ref()
            .is_some_and(|p| allowed(changed(&journal.expected, p)))
}
// Name differing checkpoint fields without logging addresses, adapter names,
// ownership tokens or full native/configuration records. This is diagnostic;
// compatibility and foreign-change guards remain authoritative.
fn checkpoint_differences(journal: &Journal, snapshot: &Snapshot) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if snapshot.roles() != journal.expected {
        fields.push("roles");
    }
    if snapshot
        .connections
        .iter()
        .any(|c| c.role.is_some() && c.has_port_mappings)
    {
        fields.push("active port mappings");
    }
    match snapshot.connection(&journal.private.id) {
        None => fields.push("private adapter missing"),
        Some(private) => {
            let expected = &journal.expected_private;
            if private.ipv4 != expected.ipv4 {
                fields.push("private IPv4");
            }
            if private.dns != expected.dns {
                fields.push("private DNS");
            }
            if private.dhcp != expected.dhcp {
                fields.push("private DHCP");
            }
            if private.has_port_mappings != expected.has_port_mappings {
                fields.push("private port mappings");
            }
            if private.private_services != expected.private_services {
                fields.push("private gateway services");
            }
        }
    }
    fields
}
fn sharing_disabled(journal: &Journal, snapshot: &Snapshot, explicit: bool) -> bool {
    let expected = [
        Role {
            id: journal.owned_public.clone(),
            role: 0,
        },
        Role {
            id: journal.private.id.clone(),
            role: 1,
        },
    ];
    !journal.conflicted
        && !journal.recovering
        && journal.pending.is_none()
        && expected.iter().all(|r| journal.expected.contains(r))
        && journal.expected.len() == 2
        && !snapshot
            .connections
            .iter()
            .any(|c| c.role.is_some() && c.has_port_mappings)
        && (explicit || snapshot.connection(&journal.owned_public).is_some())
        && snapshot.connection(&journal.original_public.id).is_some()
        && snapshot.connection(&journal.private.id).is_some_and(|p| {
            !p.has_port_mappings && (same_private(p, &journal.expected_private) || private_reset(p))
        })
        && {
            let actual = snapshot.roles();
            actual.len() < expected.len() && actual.iter().all(|r| expected.contains(r))
        }
}
fn same_private(a: &Connection, b: &Connection) -> bool {
    a.ipv4 == b.ipv4
        && a.dns == b.dns
        && a.dhcp == b.dhcp
        && a.has_port_mappings == b.has_port_mappings
        && a.private_services == b.private_services
}
fn private_reset(c: &Connection) -> bool {
    c.dhcp
        && c.dns.is_empty()
        && c.ipv4.iter().all(|a| {
            a.prefix == 16
                && a.address
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| ip.is_link_local())
        })
}
fn crash_private_reset(journal: &Journal, c: &Connection) -> bool {
    // A full Windows boot can retain the recorded ICS address while reporting
    // DHCP enabled. Accept that exact address only inside the ownership/reset
    // signature; ordinary transition checks remain strict.
    private_reset(c) || (c.dhcp && c.dns.is_empty() && c.ipv4 == journal.private.ipv4)
}
fn native_crash_cleanup(journal: &Journal, snapshot: &Snapshot) -> bool {
    !journal.conflicted
        && snapshot.connection(&journal.owned_public).is_none()
        && snapshot.roles().is_empty()
        && (journal.recovering
            || journal
                .expected
                .iter()
                .any(|r| r.id == journal.owned_public && r.role == 0))
        && snapshot
            .connection(&journal.private.id)
            .is_some_and(|c| crash_private_reset(journal, c))
}
fn restart_required(
    journal: Option<&Journal>,
    snapshot: &Snapshot,
    problem: Option<&ApiError>,
) -> bool {
    if !problem.is_some_and(|e| e.code == "ICS_WINDOWS" && e.message.contains("0x80040201")) {
        return false;
    }
    journal.is_some_and(|j| {
        j.recovering
            && !j.conflicted
            && snapshot.roles().is_empty()
            && snapshot.connection(&j.owned_public).is_none()
            && snapshot.connection(&j.original_public.id).is_some()
            && snapshot
                .connection(&j.private.id)
                .is_some_and(|c| crash_private_reset(j, c))
    })
}
fn recovery_checkpoint(journal: &mut Journal, snapshot: &Snapshot, startup: bool) -> Result<()> {
    let private = snapshot.connection(&journal.private.id).ok_or_else(|| {
        error(
            "ICS_ADAPTER_MISSING",
            "The private sharing adapter disappeared during recovery.",
        )
    })?;
    // The first startup snapshot may still contain the private role while
    // Windows removes the owned public adapter. Preserve recovery eligibility
    // once the guarded restoration starts, not only after the final NAT reset.
    journal.recovering |= startup;
    journal.expected = snapshot.roles();
    journal.expected_private = private.clone();
    journal.pending = None;
    Ok(())
}

// Idle observations never own Windows settings. Keep one bounded read-only job
// outside the serialized routing kernel; a slow COM call must not stop routing
// or hold up commands. Active sharing leases still use the guarded monitor.
#[derive(Default)]
struct IdleMonitor {
    dirty: bool,
    pending: Option<Receiver<Result<Snapshot>>>,
    valid: bool,
    error: Option<ApiError>,
}
impl IdleMonitor {
    fn invalidate(&mut self) {
        self.valid = false;
        self.error = None;
        // Keep the receiver until completion, so repeated commands cannot
        // accumulate helper processes/threads while Windows is unresponsive.
    }
    fn completed(&mut self) -> Option<Result<Snapshot>> {
        let result = match self.pending.as_ref()?.try_recv() {
            Ok(result) => result,
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => Err(error(
                "ICS_WINDOWS",
                "The idle sharing inspection ended without a result.",
            )),
        };
        self.pending = None;
        self.valid.then_some(result)
    }
    fn start(&mut self, root: PathBuf) -> Result<()> {
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("ics-observer".into())
            .spawn(move || {
                let result = Worker::spawn_attribution(&root).and_then(|mut worker| {
                    worker.call("sharing.inspect", json!({})).and_then(|value| {
                        serde_json::from_value(value).map_err(|_| {
                            error("ICS_STATE", "Windows returned invalid sharing data.")
                        })
                    })
                });
                let _ = sender.send(result);
            })
            .map_err(|e| ApiError::io("Start idle sharing inspection", e))?;
        self.pending = Some(receiver);
        self.valid = true;
        Ok(())
    }
}

/// A native observation, shared by the coordinator and its keeper. Runtime
/// policy reads these fields directly; JSON is only the public representation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Status {
    pub managed: bool,
    pub recovery_pending: bool,
    pub last_error: Option<ApiError>,
    monitor_error: Option<ApiError>,
    restore_native_on_boot: Option<bool>,
    upstream: Option<String>,
    private: Option<String>,
    ipv6_forwarding: Value,
    ipv6_clients: Value,
}

pub struct Manager {
    path: PathBuf,
    remembered_path: PathBuf,
    remembered: Option<NativePair>,
    worker_root: PathBuf,
    worker: Option<Worker>,
    journal: Option<Journal>,
    last_error: Option<ApiError>,
    recovery_until: Option<Instant>,
    recovery_checked: Instant,
    idle: IdleMonitor,
    changes: Option<super::notifications::Changes>,
}
impl Manager {
    pub fn new(data: &Path, worker_root: PathBuf) -> Result<Self> {
        let lease = super::keeper::keeper_lease()?;
        let _transaction = if lease.is_some() {
            Some(super::keeper::mutation_lock()?)
        } else {
            None
        };
        let path = data.join("tun-sharing-lease.json");
        let journal: Option<Journal> = storage::read(&path)?;
        if journal.as_ref().is_some_and(|j| !valid(j)) {
            return Err(error(
                "ICS_STATE",
                "The protected sharing recovery record is invalid.",
            ));
        }
        let remembered_path = data.join("tun-native-sharing.json");
        let mut remembered: Option<NativePair> = storage::read(&remembered_path)?;
        if remembered.as_ref().is_some_and(|pair| !pair.valid()) {
            return Err(error(
                "ICS_STATE",
                "The protected saved sharing configuration is invalid.",
            ));
        }
        if remembered.is_none() {
            if let Some(j) = &journal {
                let pair = NativePair::from_journal(j);
                storage::write(&remembered_path, &pair)?;
                remembered = Some(pair);
            }
        }
        let recovery_until = (journal.is_some()
            || remembered.as_ref().is_some_and(|p| p.restore_native)
            || lease.is_none())
        .then(|| Instant::now() + Duration::from_secs(180));
        let mut manager = Self {
            path,
            remembered_path,
            remembered,
            worker_root,
            worker: None,
            journal,
            last_error: None,
            recovery_until,
            recovery_checked: Instant::now(),
            idle: IdleMonitor::default(),
            changes: super::notifications::Changes::new()
                .inspect_err(|e| {
                    crate::diagnostics::error!(
                        "{}; periodic sharing inspection remains active.",
                        e.message
                    );
                })
                .ok(),
        };
        if lease.is_none() {
            manager.last_error = Some(super::keeper::busy());
        } else if manager.journal.is_some() {
            let result = manager.restore_inner(true);
            let _ = manager.finish_recovery(result);
        }
        Ok(manager)
    }
    fn reload_journal(&mut self) -> Result<()> {
        self.idle.invalidate();
        let journal: Option<Journal> = storage::read(&self.path)?;
        if journal.as_ref().is_some_and(|j| !valid(j)) {
            return Err(error(
                "ICS_STATE",
                "The protected sharing recovery record is invalid.",
            ));
        }
        self.journal = journal;
        self.remembered = storage::read(&self.remembered_path)?;
        if self.remembered.as_ref().is_some_and(|pair| !pair.valid()) {
            return Err(error(
                "ICS_STATE",
                "The protected saved sharing configuration is invalid.",
            ));
        }
        Ok(())
    }
    fn finish_previous_keeper(&mut self) -> Result<()> {
        if !self
            .last_error
            .as_ref()
            .is_some_and(|e| e.code == "ICS_BUSY")
        {
            return Ok(());
        }
        let Some(_lease) = super::keeper::keeper_lease()? else {
            return Ok(());
        };
        let _transaction = super::keeper::mutation_lock()?;
        self.reload_journal()?;
        let result = self.restore_inner(true);
        self.finish_recovery(result)
    }
    fn finish_recovery(&mut self, result: Result<()>) -> Result<()> {
        self.last_error = result.as_ref().err().cloned();
        if self
            .last_error
            .as_ref()
            .is_none_or(|error| !super::network::network_unavailable(error))
        {
            // A definite native/ownership failure requires explicit recovery.
            // Do not replay EnableSharing every five seconds merely because
            // an old boot window remains armed. Keep the journal for inspection.
            self.recovery_until = None;
        } else if self.recovery_until.is_some() {
            self.recovery_until = Some(Instant::now() + Duration::from_secs(180));
        }
        result
    }
    fn recover_pending(&mut self) -> Result<()> {
        self.finish_previous_keeper()?;
        if self.last_error.is_none() {
            return Ok(());
        }
        let Some(_lease) = super::keeper::keeper_lease()? else {
            return Err(super::keeper::busy());
        };
        let _transaction = super::keeper::mutation_lock()?;
        self.reload_journal()?;
        // Re-read native state for a later manual/boot attempt. Every mutation
        // still passes the durable ownership guards; a conflict is never reset.
        let result = self.restore_inner(true);
        self.finish_recovery(result)
    }
    fn call(&mut self, method: &str, data: Value) -> Result<Snapshot> {
        self.idle.invalidate();
        if self.worker.is_none() {
            self.worker = Some(Worker::spawn_attribution(&self.worker_root)?);
        }
        let response = self.worker.as_mut().unwrap().call(method, data);
        match response {
            Ok(value) => serde_json::from_value(value)
                .map_err(|_| error("ICS_STATE", "Windows returned invalid sharing data.")),
            Err(e) => {
                self.worker = None;
                Err(error("ICS_WINDOWS", e.message))
            }
        }
    }
    fn read(&mut self) -> Result<Snapshot> {
        let result = self.call("sharing.inspect", json!({}));
        if self.journal.is_none() {
            self.worker = None;
        }
        result
    }
    fn inspection(&self, snapshot: &Snapshot) -> Value {
        let saved = self
            .remembered
            .as_ref()
            .filter(|_| self.journal.is_none() && snapshot.roles().len() < 2);
        let saved_problem = saved.and_then(|pair| pair.available(snapshot).err());
        let logical = if let Some(j) = &self.journal {
            if compatible(j, snapshot) {
                Snapshot {
                    connections: vec![j.original_public.clone(), j.private.clone()],
                }
            } else {
                snapshot.clone()
            }
        } else if let Some(pair) = saved.filter(|_| saved_problem.is_none()) {
            pair.snapshot()
        } else {
            snapshot.clone()
        };
        let public = logical.connections.iter().find(|c| c.role == Some(0));
        let private = logical.connections.iter().find(|c| c.role == Some(1));
        let pair = public.zip(private);
        let checked = public.map(|c| topology(&logical, &c.name));
        let supported =
            matches!(&checked, Some(Ok(_))) && self.journal.as_ref().is_none_or(|j| !j.conflicted);
        let fingerprint = pair
            .map(|(a, b)| {
                self.remembered
                    .as_ref()
                    .filter(|p| p.same_pair(a, b))
                    .map_or_else(
                        || Snapshot {
                            connections: vec![a.clone(), b.clone()],
                        },
                        NativePair::snapshot,
                    )
            })
            .unwrap_or_else(|| logical.clone());
        json!({"version":version(&fingerprint), "connections":snapshot.connections,
            "pair":pair.map(|(a,b)| json!({"public":{"id":a.id,"name":a.name},"private":{"id":b.id,"name":b.name}})),
            "supported":supported,"problem":saved_problem.or_else(|| checked.and_then(|r|r.err())).map(|e|e.message),
            "source":if self.journal.as_ref().is_some_and(|j| j.native_restore) { "remembered" } else if self.journal.is_some() { "managed" } else if saved.is_some() && supported { "remembered" } else { "native" },
            "hasSavedPair":self.remembered.is_some(),"restoreNativeOnBoot":self.remembered.as_ref().is_some_and(|p| p.restore_native),"windowsSharingActive":!snapshot.roles().is_empty(),
            "managed":self.journal.is_some(),"recoveryPending":self.last_error.is_some(),"lastError":self.last_error,"monitorError":self.idle.error,
            "restartRequired":restart_required(self.journal.as_ref(), snapshot, self.last_error.as_ref()),
            "ipv6Forwarding":self.ipv6_status(),"ipv6Clients":self.client_status()})
    }
    pub fn inspect(&mut self) -> Result<Value> {
        self.finish_previous_keeper()?;
        let snapshot = self.read()?;
        Ok(self.inspection(&snapshot))
    }
    pub fn selection(&mut self, options: &Options) -> Result<String> {
        if self.journal.as_ref().is_some_and(|j| j.native_restore) {
            let _lease = super::keeper::keeper_lease()?.ok_or_else(super::keeper::busy)?;
            let _transaction = super::keeper::mutation_lock()?;
            self.reload_journal()?;
            if self.journal.is_none() {
                self.last_error = None;
            }
            let current = self.read()?;
            if let Some(j) = self.journal.as_mut().filter(|j| j.native_restore) {
                let reset = native_crash_cleanup(j, &current);
                if j.conflicted || (!compatible(j, &current) && !reset) {
                    return Err(error("ICS_CONFLICT", "Saved sharing restoration changed outside Wayrill. Inspect recovery before starting ICS TUN."));
                }
                let pair = NativePair::from_journal(j);
                if version(&pair.snapshot()) != options.expected_version
                    || pair.public.id != options.public_id
                    || pair.private.id != options.private_id
                {
                    return Err(error(
                        "ICS_CONFLICT",
                        "Confirm the saved sharing pair before starting ICS TUN.",
                    ));
                }
                if !compatible(j, &current) {
                    recovery_checkpoint(j, &current, true)?;
                    storage::write(&self.path, j)?;
                }
                self.last_error = None;
            }
        } else {
            self.recover_pending()?;
        }
        let snapshot = self.read()?;
        if self.journal.is_none() && snapshot.roles().len() < 2 {
            if let Some(pair) = &self.remembered {
                pair.available(&snapshot)?;
            }
        }
        let inspected = self.inspection(&snapshot);
        if !inspected["supported"].as_bool().unwrap_or(false) || self.last_error.is_some() {
            let mut problem = error(
                "ICS_TOPOLOGY",
                inspected["problem"].as_str().unwrap_or(
                    "A supported Windows sharing pair is required. Restore pending sharing first.",
                ),
            );
            // Windows can expose the original adapters before loading roles.
            // Wait only when nothing is shared; never replace a different pair.
            problem.retryable = snapshot.roles().is_empty();
            return Err(problem);
        }
        if inspected["version"] != options.expected_version
            || inspected["pair"]["public"]["id"] != options.public_id
            || inspected["pair"]["private"]["id"] != options.private_id
        {
            return Err(error("ICS_CONFLICT", "Windows sharing changed. Inspect and confirm the current pair in the ICS TUN editor before applying."));
        }
        // Resolve the GUID at every activation. Friendly names are display-only.
        super::guid_uplink(&options.public_id)
    }
    pub fn released(&mut self, id: &str) -> Result<bool> {
        Ok(!self.path.exists() && self.read()?.connection(id).is_none_or(|c| c.role.is_none()))
    }
    fn ipv6_status(&self) -> Value {
        self.journal.as_ref().and_then(|j| j.ipv6_forwarding.as_ref()).map_or(Value::Null, |lease|
            json!({"upstream":self.journal.as_ref().unwrap().original_public.name,"original":lease.original,"phase":lease.phase}))
    }
    pub(super) fn recovery_pending(&self) -> bool {
        self.last_error.is_some()
    }
    pub(super) fn observation(&self) -> Status {
        Status {
            managed: self.journal.is_some(),
            recovery_pending: self.recovery_pending(),
            last_error: self.last_error.clone(),
            monitor_error: self.idle.error.clone(),
            restore_native_on_boot: self.remembered.as_ref().map(|p| p.restore_native),
            upstream: self
                .journal
                .as_ref()
                .map(|j| j.original_public.name.clone()),
            private: self.journal.as_ref().map(|j| j.private.name.clone()),
            ipv6_forwarding: self.ipv6_status(),
            ipv6_clients: self.client_status(),
        }
    }
    pub fn status(&self) -> Value {
        serde_json::to_value(self.observation()).unwrap()
    }
    pub fn preflight(&mut self, uplink: &str, enabled: bool) -> Result<bool> {
        self.recover_pending()?;
        if self.last_error.is_some() {
            return Err(error(
                "ICS_RECOVERY",
                "Restore pending Internet Connection Sharing before starting TUN.",
            ));
        }
        if !enabled && self.journal.is_none() {
            // Remembering a pair is not evidence of active Windows forwarding.
            // The caller's native routing guard checks the actual IP settings.
            self.recovery_until = None;
            if self.remembered.is_some() {
                let snapshot = self.read()?;
                self.observe_native_intent(&snapshot)?;
            }
            return Ok(false);
        }
        let snapshot = self.read()?;
        if let Some(j) = &self.journal {
            if !compatible(j, &snapshot) {
                return Err(error(
                    "ICS_CONFLICT",
                    "Internet sharing changed outside Wayrill. Stop and inspect sharing recovery.",
                ));
            }
            if !enabled
                || !snapshot
                    .connection(&j.original_public.id)
                    .is_some_and(|c| c.name == uplink)
            {
                return Err(error("ICS_UPLINK","Keep ICS support and its original uplink, or Stop before changing TUN's uplink."));
            }
            return Ok(false); // The original uplink no longer forwards.
        }
        let roles = snapshot.roles();
        if roles.len() < 2 {
            if let Some(pair) = &self.remembered {
                pair.available(&snapshot)?;
                return Ok(false);
            }
            if roles.is_empty() {
                return Ok(false);
            }
        }
        topology(&snapshot, uplink)?;
        Ok(true)
    }
    fn set(&mut self, id: &str, role: Option<u32>) -> Result<()> {
        let change = Change {
            id: id.into(),
            role,
        };
        let j = self
            .journal
            .as_mut()
            .ok_or_else(|| error("ICS_STATE", "Missing sharing journal."))?;
        // An inactive remembered pair has no private role to release. Sending
        // that no-op to Windows would wait for a DHCP reset that never occurred.
        // The next actual change still validates this exact native checkpoint.
        if role.is_none() && j.pending.is_none() && j.expected.iter().all(|r| r.id != id) {
            return Ok(());
        }
        j.pending = Some(change.clone());
        storage::write(&self.path, j)?;
        let expected = j.expected.clone();
        let restore_services = if id == j.private.id && role == Some(1) {
            j.private.private_services.clone()
        } else {
            vec![]
        };
        let after = self.call(
            "sharing.set",
            json!({"id":id,"role":role,"expected":expected,"private":self.journal.as_ref().unwrap().expected_private,"restorePrivateServices":restore_services}),
        )?;
        if after.roles() != changed(&expected, &change) {
            return Err(error(
                "ICS_STATE",
                "Unexpected native sharing transition; recovery is pending.",
            ));
        }
        let j = self.journal.as_mut().unwrap();
        j.expected = after.roles();
        j.expected_private = after.connection(&j.private.id).cloned().ok_or_else(|| {
            error(
                "ICS_ADAPTER_MISSING",
                "The private sharing adapter disappeared.",
            )
        })?;
        j.pending = None;
        storage::write(&self.path, j)
    }
    pub fn move_to(
        &mut self,
        uplink: &str,
        owned_public: &str,
        host_ipv6: bool,
        client_ipv6: bool,
    ) -> Result<bool> {
        let _transaction = super::keeper::mutation_lock()?;
        self.preflight(uplink, true)?;
        let before = self.read()?;
        let native_restore = self.journal.as_ref().is_some_and(|j| j.native_restore);
        if self.journal.is_some() && !native_restore {
            return Err(error(
                "ICS_STATE",
                "Restore the previous sharing lease first.",
            ));
        }
        let (public, private) = if before.roles().len() < 2 || native_restore {
            let pair = self.remembered.as_ref().ok_or_else(|| {
                error(
                    "ICS_TOPOLOGY",
                    "Configure and confirm Internet sharing once before starting ICS TUN.",
                )
            })?;
            if !native_restore {
                pair.available(&before)?;
            }
            (pair.public.clone(), pair.private.clone())
        } else {
            topology(&before, uplink)?
        };
        if before
            .connection(owned_public)
            .is_none_or(|c| c.role.is_some())
        {
            return Err(error(
                "ICS_STATE",
                "The owned sharing adapter is unavailable or already shared.",
            ));
        }
        let ipv6_forwarding = if host_ipv6 {
            Lease::capture(&public.id)?.map(|mut lease| {
                if let Some(original) = self
                    .remembered
                    .as_ref()
                    .filter(|p| p.public.id == public.id && !p.restore_native)
                    .and_then(|p| p.ipv6_forwarding)
                {
                    lease.original = original;
                }
                lease
            })
        } else {
            None
        };
        let ipv6_clients = if client_ipv6 {
            Some(clients::Lease::capture(&private.id)?)
        } else {
            None
        };
        self.journal = Some(Journal {
            version: 3,
            original_public: public.clone(),
            private: private.clone(),
            owned_public: owned_public.into(),
            expected: before.roles(),
            expected_private: before.connection(&private.id).unwrap().clone(),
            conflicted: false,
            recovering: false,
            pending: None,
            native_restore: false,
            ipv6_forwarding,
            ipv6_clients,
        });
        storage::write(&self.path, self.journal.as_ref().unwrap())?;
        let journal = self.journal.as_ref().unwrap();
        let remembered = self.remembered.as_ref().map_or_else(
            || NativePair::from_journal(journal),
            |pair| pair.refreshed(journal),
        );
        storage::write(&self.remembered_path, &remembered)?;
        self.remembered = Some(remembered);
        self.recovery_until = None;
        let moved: Result<()> = (|| {
            // Windows requires the private role to be released before the public
            // handoff. The native worker waits for IP/DHCP changes to settle before
            // returning each private checkpoint, and restores its saved services.
            for change in handoff(&public.id, owned_public, &private.id) {
                self.set(&change.id, change.role)?;
            }
            Ok(())
        })();
        if let Err(e) = moved {
            self.last_error = Some(e.clone());
            return Err(e);
        }
        let after = self.read()?;
        if after
            .connection(&private.id)
            .is_none_or(|c| !same_private(c, &private))
        {
            let e = error(
                "ICS_PRIVATE_SETTINGS",
                "Windows changed private adapter settings during sharing. Recovery is required.",
            );
            self.last_error = Some(e.clone());
            return Err(e);
        }
        self.activate_ipv6()?;
        self.last_error = None;
        Ok(true)
    }
    fn activate_ipv6(&mut self) -> Result<()> {
        let Some(j) = self.journal.as_mut() else {
            return Ok(());
        };
        let Some(lease) = j.ipv6_forwarding.as_mut() else {
            return Ok(());
        };
        lease.phase = Phase::Disabling;
        storage::write(&self.path, j)?;
        forwarding::set(&j.original_public.id, false)?;
        j.ipv6_forwarding.as_mut().unwrap().phase = Phase::Active;
        storage::write(&self.path, j)
    }
    pub(super) fn enable_clients(&mut self) -> Result<String> {
        let _transaction = super::keeper::mutation_lock()?;
        let j = self
            .journal
            .as_mut()
            .ok_or_else(|| error("ICS_STATE", "Sharing is not active."))?;
        let lease = j
            .ipv6_clients
            .as_mut()
            .ok_or_else(|| error("ICS_STATE", "IPv6 sharing is not configured."))?;
        if lease.phase != clients::Phase::Captured {
            return Err(error("ICS_STATE", "IPv6 sharing is already initialized."));
        }
        lease.phase = clients::Phase::Activating;
        storage::write(&self.path, j)?;
        let id = j.private.id.clone();
        if let Err(e) = j.ipv6_clients.as_ref().unwrap().activate(&id) {
            if e.code == "ICS_IPV6_CREATE" {
                // Create failed without changing the address table. In
                // particular, never remove a concurrent external address.
                j.ipv6_clients.as_mut().unwrap().phase = clients::Phase::Captured;
                storage::write(&self.path, j)?;
            }
            return Err(e);
        }
        j.ipv6_clients.as_mut().unwrap().phase = clients::Phase::Active;
        storage::write(&self.path, j)?;
        Ok(id)
    }
    pub(super) fn client_status(&self) -> Value {
        self.journal.as_ref().and_then(|j|j.ipv6_clients.as_ref().map(|l|json!({"prefix":format!("{}/64",clients::prefix(&j.private.id)),"phase":l.phase,"private":j.private.name}))).unwrap_or(Value::Null)
    }
    fn begin_ipv6_restore(&mut self) -> Result<()> {
        let Some(mut next) = self.journal.clone() else {
            return Ok(());
        };
        if let Some(lease) = next.ipv6_forwarding.as_ref() {
            lease.check_restore(forwarding::required(&next.original_public.id)?)?;
        }
        if let Some(lease) = next.ipv6_clients.as_ref() {
            lease.check_restore(&next.private.id)?;
        }
        if let Some(lease) = next.ipv6_forwarding.as_mut() {
            lease.phase = Phase::Restoring;
        }
        if let Some(lease) = next.ipv6_clients.as_mut() {
            if lease.phase != clients::Phase::Captured {
                lease.phase = clients::Phase::Restoring;
            }
        }
        storage::write(&self.path, &next)?;
        if next
            .ipv6_clients
            .as_ref()
            .is_some_and(|l| l.phase != clients::Phase::Captured)
        {
            // This also withdraws advertisements during cold journal recovery.
            // If the link is gone, clients expire the short router lifetime.
            if let Err(e) =
                clients::Advertiser::new(&next.private.id, 1280).and_then(|a| a.withdraw())
            {
                crate::diagnostics::error!("Withdraw shared IPv6 advertisement: {}", e.message);
            }
        }
        self.journal = Some(next);
        Ok(())
    }
    fn restore_ipv6(&self, sharing: SharingExit) -> Result<()> {
        if let Some(j) = &self.journal {
            if let Some(lease) = &j.ipv6_clients {
                lease.restore(&j.private.id)?;
            }
            if let Some(lease) = &j.ipv6_forwarding {
                forwarding::set(
                    &j.original_public.id,
                    lease.original && sharing != SharingExit::Disable,
                )?;
            }
        }
        Ok(())
    }
    fn observe_native_intent(&mut self, snapshot: &Snapshot) -> Result<()> {
        if let Some(pair) = &mut self.remembered {
            let Some((public, private)) = snapshot
                .connection(&pair.public.id)
                .zip(snapshot.connection(&pair.private.id))
            else {
                return Ok(()); // A removed/offline adapter is not user-disabled sharing.
            };
            let active = pair.same_pair(public, private);
            if pair.restore_native != active {
                // Save only observed intent, never adopt or mutate a new pair.
                let mut next = pair.clone();
                next.restore_native = active;
                storage::write(&self.remembered_path, &next)?;
                *pair = next;
            }
        }
        Ok(())
    }
    pub fn restore_saved(&mut self) -> Result<()> {
        let _lease = super::keeper::keeper_lease()?.ok_or_else(super::keeper::busy)?;
        let _transaction = super::keeper::mutation_lock()?;
        self.reload_journal()?;
        if self.journal.is_none() {
            if let Some(pair) = self.remembered.clone() {
                let snapshot = self.read()?;
                if snapshot.roles().len() < 2 {
                    pair.available(&snapshot)?;
                } else if !snapshot
                    .connection(&pair.public.id)
                    .zip(snapshot.connection(&pair.private.id))
                    .is_some_and(|(public, private)| pair.same_pair(public, private))
                {
                    return Err(error("ICS_CONFLICT", "Another Windows sharing configuration is active. Refresh and use detected sharing, or keep Windows changes before restoring the saved pair."));
                }
            }
        }
        // An explicit recovery request re-enables saved native intent.
        if let Some(pair) = &mut self.remembered {
            let mut next = pair.clone();
            next.restore_native = true;
            storage::write(&self.remembered_path, &next)?;
            *pair = next;
        }
        let result = self.restore_inner(true);
        self.finish_recovery(result)
    }
    pub fn retire(&mut self, sharing: SharingExit) -> Result<()> {
        self.recovery_until = None;
        let _lease = super::keeper::keeper_lease()?.ok_or_else(super::keeper::busy)?;
        let _transaction = super::keeper::mutation_lock()?;
        self.reload_journal()?;
        if sharing == SharingExit::Disable {
            self.set_native_intent(false)?;
        }
        let result = self.retire_inner(false, sharing);
        self.last_error = result.as_ref().err().cloned();
        result
    }
    pub(super) fn disable_native_intent(&mut self) -> Result<()> {
        let _transaction = super::keeper::mutation_lock()?;
        self.set_native_intent(false)
    }
    fn set_native_intent(&mut self, enabled: bool) -> Result<()> {
        if let Some(pair) = &mut self.remembered {
            if pair.restore_native != enabled {
                let mut next = pair.clone();
                next.restore_native = enabled;
                storage::write(&self.remembered_path, &next)?;
                *pair = next;
            }
        }
        Ok(())
    }
    fn restore_inner(&mut self, startup_recovery: bool) -> Result<()> {
        self.retire_inner(startup_recovery, SharingExit::Native)
    }
    fn retire_inner(&mut self, startup_recovery: bool, mut sharing: SharingExit) -> Result<()> {
        if self.journal.is_some() && self.remembered.as_ref().is_some_and(|p| !p.restore_native) {
            sharing = SharingExit::Disable;
        }
        // An explicit Disable may arrive after native Stop, with no live keeper.
        // Only the exact remembered pair can be retired; never adopt another pair.
        if self.journal.is_none() && sharing == SharingExit::Disable {
            if let Some(pair) = self.remembered.clone() {
                let current = self.read()?;
                if !current.roles().is_empty() {
                    if current.roles().len() < 2 {
                        pair.available(&current)?;
                    } else if current.roles() != pair.snapshot().roles()
                        || !current
                            .connection(&pair.public.id)
                            .zip(current.connection(&pair.private.id))
                            .is_some_and(|(public, private)| pair.same_pair(public, private))
                    {
                        return Err(error("ICS_CONFLICT", "Windows sharing differs from the saved pair; its settings were left unchanged."));
                    }
                    let mut journal = pair.checkpoint(&current);
                    journal.native_restore = false;
                    journal.ipv6_forwarding =
                        forwarding::read(&pair.public.id)?.map(|original| Lease {
                            original,
                            phase: Phase::Captured,
                        });
                    storage::write(&self.path, &journal)?;
                    self.journal = Some(journal);
                }
            }
        }
        if self.journal.is_none() && startup_recovery {
            if let Some(pair) = self.remembered.clone().filter(|p| p.restore_native) {
                let current = self.read()?;
                if current.roles().len() < 2 {
                    let journal = pair.recovery(&current)?;
                    storage::write(&self.path, &journal)?;
                    self.journal = Some(journal);
                }
            }
        }
        let Some(journal) = self.journal.clone() else {
            return Ok(());
        };
        let current = self.read()?;
        if sharing == SharingExit::Native
            && current.roles() == baseline(&journal)
            && current
                .connection(&journal.private.id)
                .is_some_and(|c| same_private(c, &journal.private))
        {
            self.begin_ipv6_restore()?;
            self.restore_ipv6(sharing)?;
            storage::remove(&self.path)?;
            self.journal = None;
            self.worker = None;
            return Ok(());
        }
        if current.connection(&journal.original_public.id).is_none()
            || current.connection(&journal.private.id).is_none()
        {
            return Err(error(
                "ICS_ADAPTER_MISSING",
                "Reconnect the original sharing adapters before recovery.",
            ));
        }
        let reset =
            (startup_recovery || journal.recovering) && native_crash_cleanup(&journal, &current);
        let disabled = sharing_disabled(&journal, &current, sharing == SharingExit::Disable);
        if disabled {
            self.set_native_intent(false)?;
            sharing = SharingExit::Disable;
        }
        if !compatible(&journal, &current) && !reset && !disabled {
            self.mark_conflict(&current)?;
            return Err(error("ICS_CONFLICT","Internet sharing changed outside Wayrill. Its newer settings were preserved. Restore manually or keep current sharing."));
        }
        // Record restoration before native handback, which may itself change forwarding.
        self.begin_ipv6_restore()?;
        // Reconcile a timed-out operation or an owned adapter lost on a crash.
        let j = self.journal.as_mut().unwrap();
        recovery_checkpoint(j, &current, startup_recovery || journal.recovering)?;
        storage::write(&self.path, j)?;
        let changes = if sharing == SharingExit::Native {
            handoff(
                &journal.owned_public,
                &journal.original_public.id,
                &journal.private.id,
            )
            .to_vec()
        } else {
            current
                .roles()
                .into_iter()
                .map(|r| Change {
                    id: r.id,
                    role: None,
                })
                .collect()
        };
        for change in changes {
            self.set(&change.id, change.role)?;
        }
        let after = self.read()?;
        let restored = if sharing == SharingExit::Native {
            after.roles() == baseline(&journal)
                && after
                    .connection(&journal.private.id)
                    .is_some_and(|c| same_private(c, &journal.private))
        } else {
            after.roles().is_empty()
        };
        if !restored {
            return Err(error("ICS_RECOVERY","Sharing roles or private settings did not recover. The recovery record was retained."));
        }
        self.restore_ipv6(sharing)?;
        storage::remove(&self.path)?;
        self.journal = None;
        self.worker = None;
        Ok(())
    }
    pub(super) fn refresh_after_keeper(&mut self) -> Result<()> {
        self.reload_journal()?;
        if self.journal.is_some() {
            return Err(error(
                "ICS_RECOVERY",
                "The sharing keeper did not release its recovery record.",
            ));
        }
        self.last_error = None;
        self.recovery_until = None;
        self.worker = None;
        Ok(())
    }
    pub fn keep(&mut self, expected: &str) -> Result<()> {
        self.idle.invalidate();
        let _lease = super::keeper::keeper_lease()?.ok_or_else(super::keeper::busy)?;
        let _transaction = super::keeper::mutation_lock()?;
        self.reload_journal()?;
        let snapshot = self.read()?;
        if self.inspection(&snapshot)["version"].as_str() != Some(expected) {
            return Err(error(
                "ICS_CONFLICT",
                "Sharing changed. Refresh before keeping the current settings.",
            ));
        }
        if self.journal.as_ref().is_some_and(|j| {
            snapshot
                .connection(&j.owned_public)
                .is_some_and(|c| c.role.is_some())
        }) {
            return Err(error(
                "ICS_RECOVERY",
                "Move sharing away from Wayrill's adapter before keeping the current settings.",
            ));
        }
        if let Some(j) = &self.journal {
            if let Some(lease) = &j.ipv6_clients {
                if let Err(e) =
                    clients::Advertiser::new(&j.private.id, 1280).and_then(|a| a.withdraw())
                {
                    crate::diagnostics::error!(
                        "Withdraw abandoned shared IPv6 advertisement: {}",
                        e.message
                    );
                }
                lease.release_owned(&j.private.id)?;
            }
            if let Some(lease) = &j.ipv6_forwarding {
                if !forwarding::required(&j.original_public.id)? {
                    forwarding::set(&j.original_public.id, lease.original)?;
                }
            }
        }
        storage::remove(&self.path)?;
        storage::remove(&self.remembered_path)?;
        self.journal = None;
        self.remembered = None;
        self.last_error = None;
        self.worker = None;
        Ok(())
    }
    pub fn poll(&mut self, restore_native: bool) -> Result<()> {
        self.finish_previous_keeper()?;
        if restore_native
            && self.journal.is_none()
            && self.remembered.is_some()
            && self
                .recovery_until
                .is_some_and(|deadline| Instant::now() < deadline)
            && self.recovery_checked.elapsed() >= Duration::from_secs(5)
        {
            self.recovery_checked = Instant::now();
            if let Some(_lease) = super::keeper::keeper_lease()? {
                let _transaction = super::keeper::mutation_lock()?;
                self.reload_journal()?;
                let result = self.restore_inner(true);
                let _ = self.finish_recovery(result);
            }
            return Ok(());
        }
        if self.last_error.is_some() {
            if self
                .last_error
                .as_ref()
                .is_some_and(super::network::network_unavailable)
                && self.recovery_until.is_some()
            {
                self.recovery_until = Some(Instant::now() + Duration::from_secs(180));
            }
            // A failed startup recovery is a stopped lease, not an active
            // runtime to monitor. Early boot snapshots must not mark it as an
            // external edit before the next guarded recovery attempt.
            // Hand back native ICS even with automatic routing disabled. Only
            // constructor recovery arms this window, never an active handoff.
            if self
                .recovery_until
                .is_some_and(|deadline| Instant::now() < deadline)
                && self.recovery_checked.elapsed() >= Duration::from_secs(5)
                && self.journal.as_ref().is_some_and(|j| !j.conflicted)
            {
                self.recovery_checked = Instant::now();
                let _ = self.recover_pending();
            }
            return Ok(());
        }
        if self.journal.is_none() && self.remembered.is_some() && self.recovery_until.is_none() {
            self.poll_idle();
        } else {
            self.idle.invalidate();
        }
        if let Some(j) = self.journal.clone() {
            if let Some(lease) = &j.ipv6_clients {
                lease.poll(&j.private.id)?;
            }
            if j.ipv6_forwarding
                .as_ref()
                .is_some_and(|l| l.phase == Phase::Active)
                && match forwarding::read(&j.original_public.id) {
                    Ok(value) => value == Some(true),
                    Err(e) if e.code == "TUN_UPLINK_UNAVAILABLE" => false,
                    Err(e) => return Err(e),
                }
            {
                let e = error("TUN_UPLINK_ROUTING", "IPv6 forwarding was enabled on the ICS uplink while host TUN was running. Capture must stop to avoid a routing loop; the changed value was not silently disabled.");
                self.last_error = Some(e.clone());
                return Err(e);
            }
            let snapshot = self.read()?;
            if sharing_disabled(&j, &snapshot, false) {
                self.set_native_intent(false)?;
                let j = self.journal.as_mut().unwrap();
                recovery_checkpoint(j, &snapshot, false)?;
                storage::write(&self.path, j)?;
                let e = error("ICS_DISABLED", "Internet sharing was disabled in Windows. Enable ICS TUN and Apply to resume sharing.");
                self.last_error = Some(e.clone());
                return Err(e);
            }
            if !compatible(&j, &snapshot) {
                self.mark_conflict(&snapshot)?;
                let e = error(
                    "ICS_CONFLICT",
                    "Internet sharing changed outside Wayrill; its newer settings were preserved.",
                );
                self.last_error = Some(e.clone());
                return Err(e);
            }
        }
        Ok(())
    }
    fn poll_idle(&mut self) {
        // Coalesce bursts. If a change arrives during an inspection, keep it
        // dirty until one subsequent snapshot confirms the final state.
        self.idle.dirty |= self.changes.as_mut().is_some_and(|changes| changes.take());
        if let Some(result) = self.idle.completed() {
            self.idle.error = result
                .and_then(|snapshot| self.observe_native_intent(&snapshot))
                .err();
            self.recovery_checked = Instant::now();
        }
        let elapsed = self.recovery_checked.elapsed();
        if self.idle.pending.is_none()
            && (elapsed >= Duration::from_secs(10)
                || (self.idle.dirty && elapsed >= Duration::from_secs(2)))
        {
            self.recovery_checked = Instant::now();
            self.idle.dirty = false;
            if let Err(e) = self.idle.start(self.worker_root.clone()) {
                self.idle.error = Some(e);
            }
        }
    }
    fn mark_conflict(&mut self, snapshot: &Snapshot) -> Result<()> {
        if let Some(j) = self.journal.as_mut() {
            crate::diagnostics::log(
                "sharing.conflict",
                "warning",
                &format!(
                    "Observed differences from sharing checkpoint: {}.",
                    checkpoint_differences(j, snapshot).join(", ")
                ),
            );
            j.conflicted = true;
            storage::write(&self.path, j)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conflict_diagnostics_name_changed_fields_without_private_values() {
        let pair = saved_pair();
        let current = pair.snapshot();
        let j = pair.checkpoint(&current);
        assert!(checkpoint_differences(&j, &current).is_empty());
        let mut changed = current.clone();
        let private = changed
            .connections
            .iter_mut()
            .find(|c| c.id == j.private.id)
            .unwrap();
        private.dhcp = !private.dhcp;
        private.dns = vec!["203.0.113.77".into()];
        assert_eq!(
            checkpoint_differences(&j, &changed),
            ["private DNS", "private DHCP"]
        );
        changed.connections.retain(|c| c.id != j.private.id);
        assert_eq!(
            checkpoint_differences(&j, &changed),
            ["roles", "private adapter missing"]
        );
    }
    fn idle_manager() -> Manager {
        Manager {
            path: PathBuf::new(),
            remembered_path: PathBuf::new(),
            remembered: Some(saved_pair()),
            worker_root: PathBuf::new(),
            worker: None,
            journal: None,
            last_error: None,
            recovery_until: None,
            recovery_checked: Instant::now(),
            idle: IdleMonitor::default(),
            changes: None,
        }
    }
    #[test]
    fn boot_recovery_retries_only_missing_network_not_definite_windows_failures() {
        let mut manager = idle_manager();
        for code in ["ICS_WINDOWS", "ICS_CONFLICT", "ICS_STATE", "ICS_DISABLED"] {
            manager.recovery_until = Some(Instant::now() + Duration::from_secs(180));
            let error = error(code, "preserved failure");
            assert_eq!(manager.finish_recovery(Err(error)).unwrap_err().code, code);
            assert!(manager.recovery_until.is_none());
            assert_eq!(manager.last_error.as_ref().unwrap().code, code);
        }
        manager.recovery_until = Some(Instant::now());
        assert!(manager
            .finish_recovery(Err(error("ICS_ADAPTER_MISSING", "offline")))
            .is_err());
        assert!(manager.recovery_until.unwrap() > Instant::now());
        manager.recovery_until = None;
        assert!(manager
            .finish_recovery(Err(error("ICS_ADAPTER_MISSING", "offline")))
            .is_err());
        assert!(
            manager.recovery_until.is_none(),
            "manual recovery cannot arm boot retries"
        );
        manager.recovery_until = Some(Instant::now());
        manager.finish_recovery(Ok(())).unwrap();
        assert!(manager.recovery_until.is_none());
        assert!(manager.last_error.is_none());
    }
    #[test]
    fn idle_timeout_is_diagnostic_and_a_pending_inspection_never_waits() {
        let mut manager = idle_manager();
        let (sender, receiver) = mpsc::sync_channel(1);
        manager.idle.pending = Some(receiver);
        manager.idle.valid = true;
        let before = Instant::now();
        manager.poll_idle();
        assert!(before.elapsed() < Duration::from_secs(1));
        assert!(manager.idle.pending.is_some());
        sender
            .send(Err(error("ICS_WINDOWS", "Capture worker did not respond.")))
            .unwrap();
        manager.poll_idle();
        assert!(manager.idle.pending.is_none());
        assert!(manager.last_error.is_none());
        assert_eq!(manager.status()["recoveryPending"], false);
        assert!(manager.remembered.as_ref().unwrap().restore_native);
        assert_eq!(manager.status()["monitorError"]["code"], "ICS_WINDOWS");
        // A later healthy observation clears the optional diagnostic.
        let (sender, receiver) = mpsc::sync_channel(1);
        manager.idle.pending = Some(receiver);
        sender
            .send(Ok(manager.remembered.as_ref().unwrap().snapshot()))
            .unwrap();
        manager.poll_idle();
        assert!(manager.idle.error.is_none());
    }
    #[test]
    fn abandoned_observations_cannot_overwrite_newer_sharing_intent() {
        let mut manager = idle_manager();
        let (sender, receiver) = mpsc::sync_channel(1);
        manager.idle.pending = Some(receiver);
        manager.idle.valid = true;
        let snapshot = inactive(manager.remembered.as_ref().unwrap());
        manager.idle.invalidate(); // a foreground read/handoff/restore supersedes this job
        assert!(manager.idle.pending.is_some()); // still one outstanding helper
        sender.send(Ok(snapshot)).unwrap();
        manager.poll_idle();
        assert!(manager.idle.pending.is_none());
        assert!(manager.remembered.as_ref().unwrap().restore_native);
        assert!(manager.idle.error.is_none());
    }
    #[test]
    fn disconnected_idle_worker_does_not_become_a_recovery_failure() {
        let mut manager = idle_manager();
        let (sender, receiver) = mpsc::sync_channel(1);
        manager.idle.pending = Some(receiver);
        manager.idle.valid = true;
        drop(sender);
        manager.poll_idle();
        assert!(manager.last_error.is_none());
        assert_eq!(manager.idle.error.unwrap().code, "ICS_WINDOWS");
    }
    fn saved_pair() -> NativePair {
        let mut j = journal();
        j.original_public.id = "11111111-1111-1111-1111-111111111111".into();
        j.private.id = "22222222-2222-2222-2222-222222222222".into();
        j.private.ipv4 = vec![Address {
            address: "192.168.137.1".into(),
            prefix: 24,
        }];
        j.owned_public = "33333333-3333-3333-3333-333333333333".into();
        NativePair::from_journal(&j)
    }
    fn inactive(pair: &NativePair) -> Snapshot {
        let mut snapshot = pair.snapshot();
        for c in &mut snapshot.connections {
            c.role = None;
        }
        snapshot
    }
    #[test]
    fn saved_native_pair_remains_a_confirmed_selection_without_active_ics() {
        let pair = saved_pair();
        assert!(pair.valid());
        let snapshot = inactive(&pair);
        let manager = Manager {
            path: PathBuf::new(),
            remembered_path: PathBuf::new(),
            remembered: Some(pair.clone()),
            worker_root: PathBuf::new(),
            worker: None,
            journal: None,
            last_error: None,
            recovery_until: None,
            recovery_checked: Instant::now(),
            idle: IdleMonitor::default(),
            changes: None,
        };
        let inspected = manager.inspection(&snapshot);
        assert_eq!(inspected["source"], "remembered");
        assert_eq!(inspected["supported"], true);
        assert_eq!(inspected["version"], version(&pair.snapshot()));
        assert!(snapshot.roles().is_empty());
        let recovery = pair.recovery(&snapshot).unwrap();
        assert!(valid(&recovery));
        assert!(compatible(&recovery, &snapshot));
        assert_eq!(recovery.private.ipv4, pair.private.ipv4);
        assert!(recovery.recovering);
        assert!(recovery.native_restore);
        let mut invalid = recovery;
        invalid.ipv6_forwarding = Some(Lease {
            original: true,
            phase: Phase::Active,
        });
        assert!(!valid(&invalid));
    }
    #[test]
    fn stopped_host_tun_does_not_restore_an_inactive_remembered_pair() {
        let pair = saved_pair();
        let mut manager = Manager {
            path: PathBuf::from("nonexistent-wayrill-lease.json"),
            remembered_path: PathBuf::new(),
            remembered: Some(pair),
            worker_root: PathBuf::new(),
            worker: None,
            journal: None,
            last_error: None,
            recovery_until: Some(Instant::now()),
            recovery_checked: Instant::now(),
            idle: IdleMonitor::default(),
            changes: None,
        };
        // No native call/worker or journal: restoration needs a live lease or
        // an explicit saved-pair recovery request.
        manager.restore_inner(false).unwrap();
        assert!(manager.worker.is_none());
        assert!(manager.journal.is_none());
    }
    #[test]
    fn remembered_but_user_disabled_sharing_is_not_a_boot_recovery_lease() {
        let mut pair = saved_pair();
        pair.restore_native = false;
        let mut manager = Manager {
            path: PathBuf::from("nonexistent-wayrill-lease.json"),
            remembered_path: PathBuf::new(),
            remembered: Some(pair.clone()),
            worker_root: PathBuf::new(),
            worker: None,
            journal: None,
            last_error: None,
            recovery_until: None,
            recovery_checked: Instant::now(),
            idle: IdleMonitor::default(),
            changes: None,
        };
        manager.restore_inner(true).unwrap();
        assert!(manager.worker.is_none());
        assert!(manager.journal.is_none());
        assert!(pair.available(&inactive(&pair)).is_ok()); // still selectable
        let persisted = serde_json::to_vec(&pair).unwrap();
        assert!(
            !serde_json::from_slice::<NativePair>(&persisted)
                .unwrap()
                .restore_native
        );
        assert_eq!(
            manager.inspection(&inactive(&pair))["restoreNativeOnBoot"],
            false
        );
    }
    #[test]
    fn external_sharing_changes_suspend_only_automatic_restore_and_preserve_selection() {
        let dir = std::env::temp_dir().join(format!(
            "wayrill-ics-intent-{}",
            super::super::random_id().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let pair = saved_pair();
        let original_version = version(&pair.snapshot());
        let path = dir.join("saved.json");
        let mut manager = Manager {
            path: dir.join("lease.json"),
            remembered_path: path.clone(),
            remembered: Some(pair.clone()),
            worker_root: PathBuf::new(),
            worker: None,
            journal: None,
            last_error: None,
            recovery_until: None,
            recovery_checked: Instant::now(),
            idle: IdleMonitor::default(),
            changes: None,
        };
        manager.observe_native_intent(&inactive(&pair)).unwrap();
        let saved: NativePair = storage::read(&path).unwrap().unwrap();
        assert!(!saved.restore_native);
        assert_eq!(version(&saved.snapshot()), original_version);
        assert!(saved.available(&inactive(&saved)).is_ok());
        manager.observe_native_intent(&pair.snapshot()).unwrap();
        let saved: NativePair = storage::read(&path).unwrap().unwrap();
        assert!(saved.restore_native);
        let mut foreign = pair.snapshot();
        foreign.connections[1].id = "44444444-4444-4444-4444-444444444444".into();
        // Missing saved adapters suspend observation rather than inferring a
        // new topology; a different pair with both originals present is explicit.
        foreign.connections.push(Connection {
            id: pair.private.id.clone(),
            role: None,
            ..pair.private.clone()
        });
        manager.observe_native_intent(&foreign).unwrap();
        let saved: NativePair = storage::read(&path).unwrap().unwrap();
        assert!(!saved.restore_native);
        assert_eq!(saved.private.id, pair.private.id);
        assert_eq!(version(&saved.snapshot()), original_version);
        assert!(manager.journal.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_native_adapter_does_not_cancel_saved_restoration_intent() {
        let pair = saved_pair();
        let mut manager = Manager {
            path: PathBuf::new(),
            remembered_path: PathBuf::new(),
            remembered: Some(pair),
            worker_root: PathBuf::new(),
            worker: None,
            journal: None,
            last_error: None,
            recovery_until: None,
            recovery_checked: Instant::now(),
            idle: IdleMonitor::default(),
            changes: None,
        };
        manager
            .observe_native_intent(&Snapshot {
                connections: vec![],
            })
            .unwrap();
        assert!(manager.remembered.as_ref().unwrap().restore_native);
    }
    #[test]
    fn saved_pair_accepts_only_known_native_reset_and_never_foreign_topology() {
        let pair = saved_pair();
        let mut snapshot = inactive(&pair);
        snapshot.connections[1].dhcp = true;
        snapshot.connections[1].ipv4.clear();
        assert!(pair.available(&snapshot).is_ok());
        snapshot.connections[1].ipv4 = vec![Address {
            address: "169.254.12.1".into(),
            prefix: 16,
        }];
        assert!(pair.recovery(&snapshot).is_ok());
        snapshot.connections[1].dns.push("1.1.1.1".into());
        assert_eq!(
            pair.available(&snapshot).unwrap_err().code,
            "ICS_PRIVATE_SETTINGS"
        );
        snapshot = inactive(&pair);
        snapshot.connections[0].role = Some(0);
        snapshot.connections[0].id = "44444444-4444-4444-4444-444444444444".into();
        assert_eq!(pair.available(&snapshot).unwrap_err().code, "ICS_CONFLICT");
        snapshot = inactive(&pair);
        snapshot.connections.pop();
        assert_eq!(
            pair.available(&snapshot).unwrap_err().code,
            "ICS_ADAPTER_MISSING"
        );
    }
    #[test]
    fn saved_pair_resumes_either_remaining_native_role_without_adopting_foreign_settings() {
        let pair = saved_pair();
        let mut manager = idle_manager();
        manager.remembered = Some(pair.clone());
        for remaining in [0, 1] {
            let mut partial = inactive(&pair);
            partial.connections[remaining].role = Some(remaining as u32);
            assert!(pair.available(&partial).is_ok());
            let inspected = manager.inspection(&partial);
            assert_eq!(inspected["supported"], true);
            assert_eq!(inspected["source"], "remembered");
            assert_eq!(inspected["version"], version(&pair.snapshot()));
            let recovery = pair.recovery(&partial).unwrap();
            assert!(valid(&recovery));
            assert!(compatible(&recovery, &partial));
            partial.connections[1].dns = vec!["192.0.2.53".into()];
            assert_eq!(
                pair.available(&partial).unwrap_err().code,
                "ICS_PRIVATE_SETTINGS"
            );
            assert_eq!(manager.inspection(&partial)["supported"], false);
            partial = inactive(&pair);
            partial.connections[remaining].role = Some(remaining as u32);
            partial.connections[1].dhcp = true;
            partial.connections[1].ipv4.clear();
            assert_eq!(
                pair.available(&partial).is_ok(),
                remaining == 0,
                "DHCP reset is valid only after releasing the private role"
            );
            partial = inactive(&pair);
            partial.connections[remaining].role = Some(1 - remaining as u32);
            assert_eq!(pair.available(&partial).unwrap_err().code, "ICS_CONFLICT");
        }
        assert_eq!(
            pair.available(&pair.snapshot()).unwrap_err().code,
            "ICS_CONFLICT"
        );
    }
    #[test]
    fn saved_confirmation_survives_public_lease_changes_but_not_private_or_pair_changes() {
        let pair = saved_pair();
        let mut current = pair.snapshot();
        current.connections[0].ipv4 = vec![Address {
            address: "198.51.100.42".into(),
            prefix: 24,
        }];
        current.connections[0].dns = vec!["192.0.2.53".into()];
        current.connections[0].dhcp = !pair.public.dhcp;
        assert!(pair.same_pair(&current.connections[0], &current.connections[1]));
        let manager = Manager {
            path: PathBuf::new(),
            remembered_path: PathBuf::new(),
            remembered: Some(pair.clone()),
            worker_root: PathBuf::new(),
            worker: None,
            journal: None,
            last_error: None,
            recovery_until: None,
            recovery_checked: Instant::now(),
            idle: IdleMonitor::default(),
            changes: None,
        };
        assert_eq!(
            manager.inspection(&current)["version"],
            version(&pair.snapshot())
        );
        let mut next = journal();
        next.original_public = current.connections[0].clone();
        next.private = current.connections[1].clone();
        next.owned_public = "44444444-4444-4444-4444-444444444444".into();
        let refreshed = pair.refreshed(&next);
        assert_eq!(version(&refreshed.snapshot()), version(&pair.snapshot()));
        assert_eq!(refreshed.previous_public, next.owned_public);
        current.connections[1].dns.push("192.0.2.53".into());
        assert!(!pair.same_pair(&current.connections[0], &current.connections[1]));
        assert_ne!(
            manager.inspection(&current)["version"],
            version(&pair.snapshot())
        );
        current.connections[1] = pair.private.clone();
        current.connections[0].id = "55555555-5555-5555-5555-555555555555".into();
        assert!(!pair.same_pair(&current.connections[0], &current.connections[1]));
    }
    #[test]
    fn saved_pair_is_strictly_versioned_and_does_not_infer_adapter_identity() {
        let pair = saved_pair();
        let encoded = serde_json::to_value(&pair).unwrap();
        assert!(serde_json::from_value::<NativePair>(encoded.clone())
            .unwrap()
            .valid());
        let mut changed = pair.clone();
        changed.previous_public = changed.public.id.clone();
        assert!(!changed.valid());
        changed = pair;
        changed.version = 2;
        assert!(!changed.valid());
        let mut unknown = encoded;
        unknown["command"] = json!("bad");
        assert!(serde_json::from_value::<NativePair>(unknown).is_err());
    }
    #[test]
    fn saved_native_restoration_can_reconcile_a_boot_reset_without_adopting_foreign_roles() {
        let pair = saved_pair();
        let mut current = inactive(&pair);
        let mut j = pair.recovery(&current).unwrap();
        current.connections[1].dhcp = true;
        current.connections[1].ipv4.clear();
        assert!(!compatible(&j, &current));
        assert!(native_crash_cleanup(&j, &current));
        recovery_checkpoint(&mut j, &current, true).unwrap();
        assert!(compatible(&j, &current) && valid(&j));
        current.connections[0].role = Some(1);
        assert!(!compatible(&j, &current) && !native_crash_cleanup(&j, &current));
        current.connections[0].role = None;
        j.conflicted = true;
        assert!(!native_crash_cleanup(&j, &current));
    }
    fn connection(id: &str, role: Option<u32>) -> Connection {
        Connection {
            id: id.into(),
            name: id.into(),
            role,
            ipv4: vec![],
            dns: vec![],
            dhcp: false,
            has_port_mappings: false,
            port_mappings: vec![],
            private_services: vec![],
        }
    }
    #[test]
    fn external_disable_is_distinct_from_foreign_edits_missing_adapters_and_pending_handoffs() {
        let j = journal();
        let active = Snapshot {
            connections: vec![
                j.original_public.clone(),
                connection("owned", Some(0)),
                j.private.clone(),
            ],
        };
        let mut active = active;
        active.connections[0].role = None;
        assert!(!sharing_disabled(&j, &active, false));
        for roles in [
            vec![],
            vec![Role {
                id: "owned".into(),
                role: 0,
            }],
            vec![Role {
                id: "private".into(),
                role: 1,
            }],
        ] {
            let mut off = active.clone();
            for c in &mut off.connections {
                c.role = roles.iter().find(|r| r.id == c.id).map(|r| r.role);
            }
            assert!(sharing_disabled(&j, &off, false));
            let mut foreign = off.clone();
            foreign.connections[0].role = Some(0);
            assert!(!sharing_disabled(&j, &foreign, false));
            let mut missing = off.clone();
            missing.connections.retain(|c| c.id != "owned");
            assert!(!sharing_disabled(&j, &missing, false));
            let mut pending = j.clone();
            pending.pending = Some(Change {
                id: "owned".into(),
                role: None,
            });
            assert!(!sharing_disabled(&pending, &off, false));
            let mut conflicted = j.clone();
            conflicted.conflicted = true;
            assert!(!sharing_disabled(&conflicted, &off, false));
            let mut altered = off;
            altered.connections[2].dns = vec!["203.0.113.1".into()];
            assert!(!sharing_disabled(&j, &altered, false));
        }
    }
    #[test]
    fn enabling_a_disabled_saved_pair_rearms_stop_and_keeps_its_forwarding_baseline() {
        let mut j = journal();
        j.ipv6_forwarding = Some(Lease {
            original: true,
            phase: Phase::Active,
        });
        let mut pair = NativePair::from_journal(&j);
        pair.restore_native = false;
        let encoded = serde_json::to_vec(&pair).unwrap();
        let pair: NativePair = serde_json::from_slice(&encoded).unwrap();
        assert!(!pair.restore_native);
        j.ipv6_forwarding.as_mut().unwrap().original = false;
        let next = pair.refreshed(&j);
        assert!(next.restore_native);
        assert_eq!(next.ipv6_forwarding, Some(true));
    }
    fn journal() -> Journal {
        Journal {
            version: 3,
            original_public: connection("public", Some(0)),
            private: connection("private", Some(1)),
            owned_public: "owned".into(),
            expected_private: connection("private", Some(1)),
            conflicted: false,
            recovering: false,
            expected: vec![
                Role {
                    id: "owned".into(),
                    role: 0,
                },
                Role {
                    id: "private".into(),
                    role: 1,
                },
            ],
            pending: None,
            native_restore: false,
            ipv6_forwarding: None,
            ipv6_clients: None,
        }
    }
    #[test]
    fn custom_mappings_are_not_disabled_and_external_mappings_block_restoration() {
        let j = journal();
        let mut public = j.original_public.clone();
        public.has_port_mappings = true;
        let mut private = j.private.clone();
        private.ipv4 = vec![Address {
            address: "192.168.137.1".into(),
            prefix: 24,
        }];
        let snapshot = Snapshot {
            connections: vec![public.clone(), private],
        };
        assert_eq!(
            topology(&snapshot, &public.name).err().unwrap().code,
            "ICS_PORT_MAPPINGS"
        );
        let mut owned = connection("owned", Some(0));
        owned.has_port_mappings = true;
        assert!(!compatible(
            &j,
            &Snapshot {
                connections: vec![owned, j.private.clone()]
            }
        ));
    }
    #[test]
    fn private_windows_services_allow_capture_but_external_state_changes_conflict() {
        let mut j = journal();
        j.private.ipv4 = vec![Address {
            address: "192.168.137.1".into(),
            prefix: 24,
        }];
        let mapping = PortMapping {
            name: "Windows DNS".into(),
            protocol: 17,
            external_port: 53,
            internal_port: 53,
            target: "".into(),
            target_name: "localhost".into(),
        };
        j.private.private_services.push(mapping);
        j.expected_private = j.private.clone();
        let before = Snapshot {
            connections: vec![j.original_public.clone(), j.private.clone()],
        };
        assert!(topology(&before, &j.original_public.name).is_ok());
        let mut current = Snapshot {
            connections: vec![connection("owned", Some(0)), j.private.clone()],
        };
        assert!(compatible(&j, &current));
        current.connections[1].private_services.clear();
        assert!(!compatible(&j, &current));
    }
    #[test]
    fn crash_recovery_allows_only_owned_adapter_disappearance() {
        let j = journal();
        assert!(compatible(
            &j,
            &Snapshot {
                connections: vec![connection("public", None), connection("private", Some(1))]
            }
        ));
        assert!(!compatible(
            &j,
            &Snapshot {
                connections: vec![connection("public", None), connection("private", None)]
            }
        ));
        assert!(!compatible(
            &j,
            &Snapshot {
                connections: vec![
                    connection("foreign", Some(0)),
                    connection("private", Some(1))
                ]
            }
        ));
        assert!(!compatible(
            &j,
            &Snapshot {
                connections: vec![connection("owned", None), connection("private", Some(1))]
            }
        ));
    }
    #[test]
    fn partial_startup_cleanup_retains_restart_advice_after_guarded_restoration() {
        let mut j = journal();
        let partial = Snapshot {
            connections: vec![connection("public", None), connection("private", Some(1))],
        };
        assert!(compatible(&j, &partial));
        assert!(!native_crash_cleanup(&j, &partial));
        recovery_checkpoint(&mut j, &partial, true).unwrap();
        let mut reset_private = connection("private", None);
        reset_private.dhcp = true;
        let reset = Snapshot {
            connections: vec![connection("public", None), reset_private],
        };
        assert!(restart_required(
            Some(&j),
            &reset,
            Some(&error("ICS_WINDOWS", "Windows sharing failed (0x80040201)"))
        ));
        j.conflicted = true;
        assert!(!restart_required(
            Some(&j),
            &reset,
            Some(&error("ICS_WINDOWS", "Windows sharing failed (0x80040201)"))
        ));
    }
    #[test]
    fn cold_boot_recovery_accepts_only_the_recorded_private_address() {
        let mut j = journal();
        j.private.ipv4 = vec![Address {
            address: "192.168.137.1".into(),
            prefix: 24,
        }];
        j.recovering = true;
        j.expected.clear();
        let mut c = j.private.clone();
        c.role = None;
        c.dhcp = true;
        let mut s = Snapshot {
            connections: vec![connection("public", None), c],
        };
        assert!(native_crash_cleanup(&j, &s));
        assert!(restart_required(
            Some(&j),
            &s,
            Some(&error("ICS_WINDOWS", "Windows sharing failed (0x80040201)"))
        ));
        s.connections[1].ipv4[0].address = "192.168.137.2".into();
        assert!(!native_crash_cleanup(&j, &s));
        s.connections[1].ipv4 = j.private.ipv4.clone();
        s.connections[1].dns.push("192.0.2.53".into());
        assert!(!native_crash_cleanup(&j, &s));
        s.connections[1].dns.clear();
        j.conflicted = true;
        assert!(!native_crash_cleanup(&j, &s));
        j.conflicted = false;
        j.recovering = false;
        assert!(!native_crash_cleanup(&j, &s));
    }
    #[test]
    fn unknown_mutation_accepts_only_one_pending_transition() {
        let mut j = journal();
        j.pending = Some(Change {
            id: "owned".into(),
            role: None,
        });
        assert!(compatible(
            &j,
            &Snapshot {
                connections: vec![connection("owned", None), connection("private", Some(1))]
            }
        ));
        assert!(!compatible(
            &j,
            &Snapshot {
                connections: vec![connection("owned", None), connection("private", None)]
            }
        ));
    }
    #[test]
    fn private_adapter_edits_are_not_overwritten_during_recovery() {
        let j = journal();
        let mut private = connection("private", Some(1));
        private.dns = vec!["192.0.2.53".into()];
        assert!(!compatible(
            &j,
            &Snapshot {
                connections: vec![connection("owned", Some(0)), private]
            }
        ));
    }
    #[test]
    fn every_handoff_boundary_has_only_one_recoverable_unknown_operation() {
        let mut j = journal();
        j.expected = baseline(&j);
        for change in handoff("public", "owned", "private") {
            j.pending = Some(change.clone());
            for roles in [j.expected.clone(), changed(&j.expected, &change)] {
                let connections = ["public", "private", "owned"]
                    .into_iter()
                    .map(|id| connection(id, roles.iter().find(|r| r.id == id).map(|r| r.role)))
                    .collect();
                assert!(compatible(&j, &Snapshot { connections }));
            }
            j.expected = changed(&j.expected, &change);
            j.pending = None;
        }
    }
    #[test]
    fn handoff_releases_private_before_public_and_restores_it_last() {
        let mut j = journal();
        j.expected = baseline(&j);
        for (from, to) in [("public", "owned"), ("owned", "public")] {
            for (index, change) in handoff(from, to, "private").into_iter().enumerate() {
                j.expected = changed(&j.expected, &change);
                assert_eq!(
                    j.expected.iter().any(|r| r.id == "private"),
                    index == 0 || index == 3
                );
                assert!(j.expected.iter().filter(|r| r.role == 0).count() <= 1);
                let snapshot = Snapshot {
                    connections: ["public", "private", "owned"]
                        .into_iter()
                        .map(|id| {
                            connection(id, j.expected.iter().find(|r| r.id == id).map(|r| r.role))
                        })
                        .collect(),
                };
                assert!(compatible(&j, &snapshot));
                let mut edited = snapshot.clone();
                edited.connections[1].dns = vec!["192.0.2.53".into()];
                assert!(!compatible(&j, &edited));
            }
        }
        assert_eq!(j.expected, baseline(&j));
    }
    #[test]
    fn recovery_journal_rejects_swapped_or_duplicate_public_roles() {
        let mut j = journal();
        let public = "00000000-0000-4000-8000-000000000001";
        let private = "00000000-0000-4000-8000-000000000002";
        let owned = "00000000-0000-4000-8000-000000000003";
        j.original_public.id = public.into();
        j.private.id = private.into();
        j.expected_private.id = private.into();
        j.owned_public = owned.into();
        j.expected = baseline(&j);
        assert!(valid(&j));
        j.expected[0].role = 1;
        assert!(!valid(&j));
        j.expected = vec![
            Role {
                id: public.into(),
                role: 0,
            },
            Role {
                id: owned.into(),
                role: 0,
            },
        ];
        assert!(!valid(&j));
        j.expected = baseline(&j);
        j.pending = Some(Change {
            id: private.into(),
            role: Some(0),
        });
        assert!(!valid(&j));
        j.pending = Some(Change {
            id: owned.into(),
            role: Some(1),
        });
        assert!(!valid(&j));
        j.pending = Some(Change {
            id: owned.into(),
            role: Some(0),
        });
        assert!(valid(&j));
    }
    #[test]
    fn topology_changes_between_inspection_and_handoff_fail_without_panicking() {
        let mut public = connection("public", Some(0));
        public.name = "Ethernet".into();
        let mut private = connection("private", Some(1));
        private.ipv4 = vec![Address {
            address: "192.168.137.1".into(),
            prefix: 24,
        }];
        assert!(topology(
            &Snapshot {
                connections: vec![public.clone(), private.clone()]
            },
            "Ethernet"
        )
        .is_ok());
        private.role = Some(0);
        assert_eq!(
            topology(
                &Snapshot {
                    connections: vec![public, private]
                },
                "Ethernet"
            )
            .err()
            .unwrap()
            .code,
            "ICS_TOPOLOGY"
        );
    }
    #[test]
    fn startup_recognizes_windows_cleanup_but_never_an_external_conflict() {
        let mut j = journal();
        let mut private = connection("private", None);
        private.dhcp = true;
        let mut snapshot = Snapshot {
            connections: vec![connection("public", None), private],
        };
        assert!(native_crash_cleanup(&j, &snapshot));
        j.conflicted = true;
        assert!(!native_crash_cleanup(&j, &snapshot));
        j.conflicted = false;
        snapshot.connections.push(connection("foreign", Some(0)));
        assert!(!native_crash_cleanup(&j, &snapshot));
        snapshot.connections.pop();
        snapshot.connections[1].dns = vec!["192.0.2.53".into()];
        assert!(!native_crash_cleanup(&j, &snapshot));
    }
    #[test]
    fn unknown_private_disable_accepts_only_its_native_reset_result() {
        let mut j = journal();
        j.pending = Some(Change {
            id: "private".into(),
            role: None,
        });
        let mut private = connection("private", None);
        private.dhcp = true;
        let mut snapshot = Snapshot {
            connections: vec![connection("owned", Some(0)), private],
        };
        assert!(compatible(&j, &snapshot));
        snapshot.connections[1].dns = vec!["192.0.2.53".into()];
        assert!(!compatible(&j, &snapshot));
    }
    #[test]
    fn restart_advice_requires_a_native_orphan_failure_and_a_recovery_lease() {
        let mut j = journal();
        let mut private = connection("private", None);
        private.dhcp = true;
        let mut snapshot = Snapshot {
            connections: vec![connection("public", None), private],
        };
        let native = error("ICS_WINDOWS", "Windows sharing failed (0x80040201)");
        let other = error("ICS_WINDOWS", "Another native failure");
        assert!(!restart_required(Some(&j), &snapshot, Some(&native)));
        j.recovering = true;
        assert!(restart_required(Some(&j), &snapshot, Some(&native)));
        assert!(!restart_required(Some(&j), &snapshot, Some(&other)));
        assert!(!restart_required(Some(&j), &snapshot, None));
        j.conflicted = true;
        assert!(!restart_required(Some(&j), &snapshot, Some(&native)));
        j.conflicted = false;
        snapshot.connections.push(connection("foreign", Some(0)));
        assert!(!restart_required(Some(&j), &snapshot, Some(&native)));
        assert!(!restart_required(None, &snapshot, Some(&native)));
    }
}
