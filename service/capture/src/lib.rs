// SPDX-License-Identifier: GPL-3.0-only
//! Rust port of Wayrill's contained capture worker. The worker executable and
//! ownership/lifecycle contracts are in docs/development/capture-worker.md.
pub mod address;
pub mod attribution;
pub mod batch;
pub mod buffers;
#[cfg(feature = "windivert")]
pub mod capture;
pub mod companion;
#[cfg(feature = "windivert")]
pub mod controller;
#[cfg(feature = "windivert")]
pub mod divert_monitor;
pub mod events;
pub mod fragments;
pub mod interfaces;
pub mod nat;
pub mod nat_sessions;
pub mod native;
pub mod packet;
pub mod pending;
pub mod policy;
pub mod process;
pub mod process_decisions;
pub mod process_event;
pub mod services;
pub mod sharing;
pub mod socket_presence;
pub mod sockets;
pub mod socks;
pub mod text;
pub mod tun_applications;
#[cfg(feature = "windivert")]
pub mod udp;
pub mod wire;

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String, Option<i32>);
impl Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(message.into(), None)
    }
    pub fn os_code(&self) -> Option<i32> {
        self.1
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self(value.to_string(), value.raw_os_error())
    }
}
impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self(value.to_string(), None)
    }
}
impl From<windows::core::Error> for Error {
    fn from(value: windows::core::Error) -> Self {
        Self::invalid(format!(
            "{} (HRESULT 0x{:08X})",
            value.message(),
            value.code().0 as u32
        ))
    }
}
pub type Result<T> = std::result::Result<T, Error>;
