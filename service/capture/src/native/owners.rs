// SPDX-License-Identifier: GPL-3.0-only
use super::{adapters::NativeBuffer, from_win32};
use crate::{address::Address, attribution::OwnerRow, services::ServiceSnapshot, Error, Result};
use std::{
    ffi::c_void,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};
use windows_sys::Win32::{
    Foundation::ERROR_INSUFFICIENT_BUFFER,
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, GetOwnerModuleFromTcp6Entry,
        GetOwnerModuleFromTcpEntry, GetOwnerModuleFromUdp6Entry, GetOwnerModuleFromUdpEntry,
        MIB_TCP6ROW_OWNER_MODULE, MIB_TCPROW_OWNER_MODULE, MIB_UDP6ROW_OWNER_MODULE,
        MIB_UDPROW_OWNER_MODULE,
    },
};

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_ne_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn ip_at(bytes: &[u8], offset: usize, six: bool, scope: usize) -> Address {
    if six {
        Address {
            ip: IpAddr::V6(Ipv6Addr::from(
                <[u8; 16]>::try_from(&bytes[offset..offset + 16]).unwrap(),
            )),
            scope: u32_at(bytes, scope),
        }
    } else {
        Address {
            ip: IpAddr::V4(Ipv4Addr::from(
                <[u8; 4]>::try_from(&bytes[offset..offset + 4]).unwrap(),
            )),
            scope: 0,
        }
    }
}
fn decode(bytes: &[u8], tcp: bool, six: bool) -> Result<OwnerRow> {
    let minimum = match (tcp, six) {
        (true, true) => 56,
        (true, false) => 24,
        (false, true) => 28,
        (false, false) => 12,
    };
    if bytes.len() < minimum {
        return Err(Error::invalid("Truncated IP owner row."));
    }
    let local_offset = if tcp && !six { 4 } else { 0 };
    let local_port = if six {
        20
    } else if tcp {
        8
    } else {
        4
    };
    let remote_offset = if six { 24 } else { 12 };
    let remote_port = if six { 44 } else { 16 };
    let pid_offset = if six {
        if tcp {
            52
        } else {
            24
        }
    } else if tcp {
        20
    } else {
        8
    };
    let pid = u32_at(bytes, pid_offset);
    if pid > i32::MAX as u32 {
        return Err(Error::invalid("IP owner process ID overflow."));
    }
    Ok(OwnerRow {
        local: ip_at(bytes, local_offset, six, 16),
        port: u16::from_be_bytes(bytes[local_port..local_port + 2].try_into().unwrap()),
        remote: tcp.then(|| ip_at(bytes, remote_offset, six, 40)),
        remote_port: if tcp {
            u16::from_be_bytes(bytes[remote_port..remote_port + 2].try_into().unwrap())
        } else {
            0
        },
        pid,
        module: None,
        state: if tcp {
            u32_at(bytes, if six { 48 } else { 0 })
        } else {
            0
        },
    })
}
pub fn read(protocol: u8, six: bool, services: Option<&ServiceSnapshot>) -> Result<Vec<OwnerRow>> {
    if !matches!(protocol, 6 | 17) {
        return Err(Error::invalid("Invalid owner table protocol."));
    }
    let tcp = protocol == 6;
    let module = services.is_some_and(ServiceSnapshot::has_selected_hosts);
    let class = if tcp {
        if module {
            8
        } else {
            5
        }
    } else if module {
        2
    } else {
        1
    };
    let family = if six { 23 } else { 2 };
    let query = |pointer: *mut c_void, length: &mut u32| {
        // SAFETY: native API writes to either a null sizing query or the exact
        // initialized caller buffer described by length; other arguments are fixed.
        unsafe {
            if tcp {
                GetExtendedTcpTable(pointer, length, 0, family, class, 0)
            } else {
                GetExtendedUdpTable(pointer, length, 0, family, class, 0)
            }
        }
    };
    let (mut buffer, capacity) = read_table(query)?;
    let pointer = buffer.as_mut_ptr();
    let data = buffer.bytes(pointer, capacity)?;
    let first = if module { 8 } else { 4 };
    let row_size = match (tcp, six, module) {
        (true, true, true) => std::mem::size_of::<MIB_TCP6ROW_OWNER_MODULE>(),
        (true, false, true) => std::mem::size_of::<MIB_TCPROW_OWNER_MODULE>(),
        (false, true, true) => std::mem::size_of::<MIB_UDP6ROW_OWNER_MODULE>(),
        (false, false, true) => std::mem::size_of::<MIB_UDPROW_OWNER_MODULE>(),
        (true, true, false) => 56,
        (true, false, false) => 24,
        (false, true, false) => 28,
        (false, false, false) => 12,
    };
    let count = u32_at(data, 0) as usize;
    if capacity < first || count > (capacity - first) / row_size {
        return Err(Error::invalid("Invalid IP owner table."));
    }
    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let offset = first + i * row_size;
        let mut row = decode(&data[offset..offset + row_size], tcp, six)?;
        if module && services.is_some_and(|s| s.needs_module(row.pid)) {
            row.module = module_name(&data[offset..offset + row_size], tcp, six);
        }
        rows.push(row);
    }
    Ok(rows)
}

// Windows' endpoint table grows between sizing and reading, especially when
// many short-lived connections open together. Reserve bounded headroom rather
// than repeatedly allocating exactly the last (already stale) required size.
fn read_table(
    mut query: impl FnMut(*mut c_void, &mut u32) -> u32,
) -> Result<(NativeBuffer, usize)> {
    const MAX: usize = 32 * 1024 * 1024;
    let mut required = 0;
    let error = query(std::ptr::null_mut(), &mut required);
    if error != 0 && error != ERROR_INSUFFICIENT_BUFFER {
        return Err(from_win32(error));
    }
    let mut previous = 0;
    for _ in 0..4 {
        let needed = required as usize;
        if !(4..=MAX).contains(&needed) || previous == MAX {
            return Err(Error::invalid("IP owner table exceeds its capacity."));
        }
        let capacity = (needed + needed / 2)
            .max(64 * 1024)
            .max(previous * 2)
            .min(MAX);
        let mut buffer = NativeBuffer::new(capacity);
        let mut written = capacity as u32;
        let error = query(buffer.as_mut_ptr().cast(), &mut written);
        if error == ERROR_INSUFFICIENT_BUFFER {
            previous = capacity;
            // Keep Windows' new requirement, not the old allocation size.
            // A successful retry must still advertise the full real capacity.
            required = written;
            continue;
        }
        if error != 0 {
            return Err(from_win32(error));
        }
        if !(4..=capacity).contains(&(written as usize)) {
            return Err(Error::invalid("Invalid IP owner table length."));
        }
        return Ok((buffer, written as usize));
    }
    Err(Error::invalid("IP owner table changed repeatedly."))
}

fn module_name(row: &[u8], tcp: bool, six: bool) -> Option<String> {
    let query = |pointer: *mut c_void, length: &mut u32| {
        // SAFETY: row is the complete aligned native owner-module record from
        // GetExtended*Table. Size/layout is selected from those native types.
        unsafe {
            match (tcp, six) {
                (true, true) => {
                    GetOwnerModuleFromTcp6Entry(row.as_ptr().cast(), 0, pointer, length)
                }
                (true, false) => {
                    GetOwnerModuleFromTcpEntry(row.as_ptr().cast(), 0, pointer, length)
                }
                (false, true) => {
                    GetOwnerModuleFromUdp6Entry(row.as_ptr().cast(), 0, pointer, length)
                }
                (false, false) => {
                    GetOwnerModuleFromUdpEntry(row.as_ptr().cast(), 0, pointer, length)
                }
            }
        }
    };
    let mut length = 0;
    if query(std::ptr::null_mut(), &mut length) != ERROR_INSUFFICIENT_BUFFER
        || !(std::mem::size_of::<usize>() as u32..=65536).contains(&length)
    {
        return None;
    }
    let mut buffer = NativeBuffer::new(length as usize);
    let pointer = buffer.as_mut_ptr();
    if query(pointer.cast(), &mut length) != 0 {
        return None;
    }
    let raw = buffer.bytes(pointer, std::mem::size_of::<usize>()).ok()?;
    let name = usize::from_ne_bytes(raw.try_into().ok()?) as *const u16;
    if name.is_null() {
        return None;
    }
    buffer.unicode(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn growing_owner_table_has_headroom_and_retries_with_actual_capacity() {
        let mut calls = 0;
        let (_, written) = read_table(|pointer, size| {
            calls += 1;
            if pointer.is_null() {
                *size = 28;
                return ERROR_INSUFFICIENT_BUFFER;
            }
            if calls == 2 {
                assert!(*size >= 64 * 1024);
                *size = 70000;
                return ERROR_INSUFFICIENT_BUFFER;
            }
            assert!(*size >= 131072);
            *size = 70024;
            0
        })
        .unwrap();
        assert_eq!(written, 70024);
        assert_eq!(calls, 3);
    }
    #[test]
    fn owner_table_rejects_oversized_and_malformed_lengths() {
        assert!(read_table(|_, size| {
            *size = 32 * 1024 * 1024 + 1;
            ERROR_INSUFFICIENT_BUFFER
        })
        .is_err());
        let mut calls = 0;
        assert!(read_table(|_, size| {
            calls += 1;
            *size = if calls == 1 { 4 } else { 100000 };
            0
        })
        .is_err());
    }
    #[test]
    fn native_module_row_sizes_and_basic_offsets_are_preserved() {
        assert_eq!(std::mem::size_of::<MIB_TCPROW_OWNER_MODULE>(), 160);
        assert_eq!(std::mem::size_of::<MIB_TCP6ROW_OWNER_MODULE>(), 192);
        assert_eq!(std::mem::size_of::<MIB_UDPROW_OWNER_MODULE>(), 160);
        assert_eq!(std::mem::size_of::<MIB_UDP6ROW_OWNER_MODULE>(), 176);
        for tcp in [false, true] {
            for six in [false, true] {
                let length = match (tcp, six) {
                    (true, true) => 56,
                    (true, false) => 24,
                    (false, true) => 28,
                    (false, false) => 12,
                };
                let mut bytes = vec![0; length];
                let port = if six {
                    20
                } else if tcp {
                    8
                } else {
                    4
                };
                bytes[port..port + 2].copy_from_slice(&54321u16.to_be_bytes());
                bytes[length - 4..].copy_from_slice(&41u32.to_ne_bytes());
                let row = decode(&bytes, tcp, six).unwrap();
                assert_eq!(row.port, 54321);
                assert_eq!(row.pid, 41);
                assert_eq!(row.local.ip.is_ipv6(), six);
                assert!(decode(&bytes[..length - 1], tcp, six).is_err());
            }
        }
    }
}
