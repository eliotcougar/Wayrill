// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    attribution::OwnerRow,
    sockets::{matches_address, SocketEvent},
};
use std::collections::HashMap;
pub struct SocketPresence<'a> {
    rows: HashMap<(u8, u32, u16), Vec<&'a OwnerRow>>,
}
impl<'a> SocketPresence<'a> {
    pub fn new(tcp: &'a [OwnerRow], udp: &'a [OwnerRow]) -> Self {
        let mut rows: HashMap<_, Vec<_>> = HashMap::new();
        for (protocol, source) in [(6, tcp), (17, udp)] {
            for row in source {
                rows.entry((protocol, row.pid, row.port))
                    .or_default()
                    .push(row);
            }
        }
        Self { rows }
    }
    pub fn contains(&self, socket: &SocketEvent) -> bool {
        let flow = socket.flow;
        self.rows
            .get(&(flow.protocol, socket.pid, flow.local_port))
            .is_some_and(|rows| {
                rows.iter().any(|row| {
                    (matches_address(row.local, flow.local)
                        || matches_address(flow.local, row.local))
                        && (flow.protocol == 17
                            || flow.remote_port == 0
                            || row.remote_port == flow.remote_port
                                && row
                                    .remote
                                    .is_some_and(|remote| matches_address(flow.remote, remote)))
                })
            })
    }
}
