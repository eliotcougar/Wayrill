// SPDX-License-Identifier: GPL-3.0-only
//! Exact Windows NAT translation identities; never infer forwarding from a missing PID.
use crate::{address::Address, packet::Flow, Error, Result};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub source: String,
    pub source_port: u16,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub external: Flow,
    pub source: Address,
    pub source_port: u16,
    pub identity: String,
}
#[derive(Default)]
pub struct Index(HashMap<Flow, Option<Session>>);
impl Index {
    pub fn new(rows: impl IntoIterator<Item = Session>) -> Result<Self> {
        let mut index = HashMap::<Flow, Option<Session>>::new();
        for row in rows {
            if !matches!(row.external.protocol, 6 | 17)
                || row.source_port == 0
                || row.external.local_port == 0
                || row.external.remote_port == 0
                || row.source.ip.is_unspecified()
                || row.source.ip.is_multicast()
                || row.source.ip.is_loopback()
                || row.source.ip.is_ipv4() != row.external.local.ip.is_ipv4()
                || row.external.local.ip.is_ipv4() != row.external.remote.ip.is_ipv4()
                || row.identity.is_empty()
            {
                return Err(Error::invalid("Invalid Windows NAT session identity."));
            }
            if index.len() >= 65_536 && !index.contains_key(&row.external) {
                return Err(Error::invalid(
                    "Windows NAT session inventory exceeds capacity.",
                ));
            }
            index
                .entry(row.external)
                .and_modify(|old| {
                    if old.as_ref() != Some(&row) {
                        *old = None;
                    }
                })
                .or_insert(Some(row));
        }
        Ok(Self(index))
    }
    pub fn find(&self, flow: Flow) -> Result<Option<Origin>> {
        match self.0.get(&flow) {
            None => Ok(None),
            Some(None) => Err(Error::invalid("Ambiguous Windows NAT translation.")),
            Some(Some(row)) => Ok(Some(Origin {
                source: row.source.ip.to_string(),
                source_port: row.source_port,
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ip(value: [u8; 4]) -> Address {
        Address {
            ip: std::net::Ipv4Addr::from(value).into(),
            scope: 0,
        }
    }
    fn session(protocol: u8) -> Session {
        Session {
            external: Flow {
                protocol,
                local: ip([10, 90, 0, 1]),
                local_port: 50001,
                remote: ip([203, 0, 113, 1]),
                remote_port: 443,
            },
            source: ip([172, 30, 187, 151]),
            source_port: 53000,
            identity: "network/session-1".into(),
        }
    }
    #[test]
    fn matches_complete_tuple_and_preserves_original_port() {
        for protocol in [6, 17] {
            let row = session(protocol);
            let index = Index::new([row.clone()]).unwrap();
            let original = index.find(row.external).unwrap().unwrap();
            assert_eq!(original.source, "172.30.187.151");
            assert_eq!(original.source_port, 53000);
            let mut other = row.external;
            other.remote_port = 80;
            assert!(index.find(other).unwrap().is_none());
            other = row.external;
            other.local_port += 1;
            assert!(index.find(other).unwrap().is_none());
            other = row.external;
            other.protocol = if protocol == 6 { 17 } else { 6 };
            assert!(index.find(other).unwrap().is_none());
        }
    }
    #[test]
    fn duplicates_are_idempotent_but_reused_or_ambiguous_leases_fail_closed() {
        let row = session(6);
        let mut changed = row.clone();
        changed.identity = "network/new-session".into();
        assert!(Index::new([row.clone(), row.clone()])
            .unwrap()
            .find(row.external)
            .unwrap()
            .is_some());
        assert!(Index::new([row.clone(), changed])
            .unwrap()
            .find(row.external)
            .is_err());
        let mut changed = row.clone();
        changed.source = ip([172, 30, 187, 152]);
        assert!(Index::new([row.clone(), changed])
            .unwrap()
            .find(row.external)
            .is_err());
    }
}
