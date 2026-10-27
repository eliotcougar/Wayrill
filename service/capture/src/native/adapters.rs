// SPDX-License-Identifier: GPL-3.0-only
use super::from_win32;
use crate::{interfaces::InterfaceInfo, Error, Result};
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_NO_DATA},
        NetworkManagement::IpHelper::{
            FreeMibTable, GetAdaptersAddresses, GetIfTable2, IP_ADAPTER_ADDRESSES_LH,
            IP_ADAPTER_UNICAST_ADDRESS_LH, MIB_IF_TABLE2,
        },
    },
};

pub struct NativeBuffer {
    storage: Vec<u64>,
    length: usize,
}
impl NativeBuffer {
    pub fn new(length: usize) -> Self {
        Self {
            storage: vec![0; length.div_ceil(8)],
            length,
        }
    }
    pub fn as_mut_ptr(&mut self) -> *mut u8 {
        self.storage.as_mut_ptr().cast()
    }
    pub fn validate<T>(&self, pointer: *const T) -> Result<()> {
        let at = pointer as usize;
        let begin = self.storage.as_ptr() as usize;
        if !at.is_multiple_of(std::mem::align_of::<T>())
            || at < begin
            || at
                .checked_add(std::mem::size_of::<T>())
                .is_none_or(|end| end > begin + self.length)
        {
            return Err(Error::invalid("Invalid native inventory record pointer."));
        }
        Ok(())
    }
    pub fn bytes(&self, pointer: *const u8, length: usize) -> Result<&[u8]> {
        let at = pointer as usize;
        let begin = self.storage.as_ptr() as usize;
        if at < begin
            || at
                .checked_add(length)
                .is_none_or(|end| end > begin + self.length)
        {
            return Err(Error::invalid("Invalid native inventory buffer pointer."));
        }
        // The cast is checked at compile time and borrows our initialized,
        // aligned storage without copying or trusting the caller's pointer.
        let bytes: &[u8] = bytemuck::must_cast_slice(&self.storage);
        Ok(&bytes[at - begin..at - begin + length])
    }
    fn remaining(&self, pointer: *const u8) -> Result<usize> {
        let begin = self.storage.as_ptr() as usize;
        let at = pointer as usize;
        if at < begin || at >= begin + self.length {
            return Err(Error::invalid("Invalid native inventory string pointer."));
        }
        Ok(begin + self.length - at)
    }
    pub(super) fn ansi(&self, pointer: *const u8) -> Result<String> {
        if pointer.is_null() {
            return Ok(String::new());
        }
        let bytes = self.bytes(pointer, self.remaining(pointer)?)?;
        let length = bytes
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| Error::invalid("Unterminated native inventory string."))?;
        Ok(String::from_utf8_lossy(&bytes[..length]).into_owned())
    }
    pub(super) fn unicode(&self, pointer: *const u16) -> Result<String> {
        if pointer.is_null() {
            return Ok(String::new());
        }
        if !(pointer as usize).is_multiple_of(2) {
            return Err(Error::invalid("Unaligned native Unicode string."));
        }
        let bytes = self.bytes(pointer.cast(), self.remaining(pointer.cast())?)?;
        let pairs = bytes.as_chunks::<2>().0;
        let length = pairs
            .iter()
            .position(|p| *p == [0, 0])
            .ok_or_else(|| Error::invalid("Unterminated native Unicode string."))?;
        let words: Vec<_> = pairs[..length]
            .iter()
            .map(|p| u16::from_ne_bytes(*p))
            .collect();
        Ok(String::from_utf16_lossy(&words))
    }
}
fn guid(value: GUID) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        value.data1,
        value.data2,
        value.data3,
        value.data4[0],
        value.data4[1],
        value.data4[2],
        value.data4[3],
        value.data4[4],
        value.data4[5],
        value.data4[6],
        value.data4[7]
    )
}
fn filters() -> Result<HashSet<String>> {
    struct Table(*mut MIB_IF_TABLE2);
    impl Drop for Table {
        fn drop(&mut self) {
            // SAFETY: this is the one allocation returned by GetIfTable2.
            unsafe {
                FreeMibTable(self.0.cast());
            }
        }
    }
    let mut pointer = std::ptr::null_mut();
    // SAFETY: Windows initializes the output with its own allocated interface
    // table; no row is accessed until the API reports success.
    let error = unsafe { GetIfTable2(&mut pointer) };
    if error != 0 {
        return Err(from_win32(error));
    }
    if pointer.is_null() {
        return Err(Error::invalid("Missing Windows interface table."));
    }
    let table = Table(pointer);
    // SAFETY: GetIfTable2 succeeded and table retains its live allocation.
    let count = unsafe { (*table.0).NumEntries } as usize;
    if count > 65536 {
        return Err(Error::invalid(
            "Windows interface table exceeds its capacity.",
        ));
    }
    // SAFETY: NumEntries describes the native flexible array allocated by this
    // API. addr_of avoids creating a reference to its nominal one-element field.
    let rows =
        unsafe { std::slice::from_raw_parts(std::ptr::addr_of!((*table.0).Table).cast(), count) };
    Ok(rows
        .iter()
        .filter(
            |row: &&windows_sys::Win32::NetworkManagement::IpHelper::MIB_IF_ROW2| {
                row.InterfaceAndOperStatusFlags._bitfield & 2 != 0
            },
        )
        .map(|row| guid(row.InterfaceGuid))
        .collect())
}
pub(super) fn inventory(include_dns: bool) -> Result<Option<NativeBuffer>> {
    let mut capacity = 16 * 1024usize;
    for _ in 0..5 {
        if capacity > 16 * 1024 * 1024 {
            return Err(Error::invalid("Adapter inventory exceeds its capacity."));
        }
        let mut buffer = NativeBuffer::new(capacity);
        let mut length = capacity as u32;
        // Skip unused anycast/multicast/DNS lists, but include disconnected IP
        // interfaces so retained adapter identities are never inferred by name.
        // SAFETY: buffer is aligned and owns capacity writable bytes; pointers in
        // the returned linked records remain valid only while it is retained.
        let error = unsafe {
            GetAdaptersAddresses(
                0,
                2 | 4 | 0x100 | if include_dns { 0 } else { 8 },
                std::ptr::null(),
                buffer.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if error == ERROR_BUFFER_OVERFLOW {
            capacity = length as usize;
            continue;
        }
        if error == ERROR_NO_DATA {
            return Ok(None);
        }
        if error != 0 {
            return Err(from_win32(error));
        }
        return Ok(Some(buffer));
    }
    Err(Error::invalid("Adapter inventory changed repeatedly."))
}
pub fn read() -> Result<Vec<InterfaceInfo>> {
    let filters = filters()?;
    let Some(mut buffer) = inventory(false)? else {
        return Ok(Vec::new());
    };
    let mut result = Vec::new();
    let mut pointer = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    let mut seen = HashSet::new();
    while !pointer.is_null() {
        buffer.validate(pointer)?;
        if !seen.insert(pointer as usize) || seen.len() > 65536 {
            return Err(Error::invalid("Invalid adapter inventory chain."));
        }
        // SAFETY: this initialized native record is aligned and inside the
        // allocation; validate was called before any dereference.
        let row = unsafe { &*pointer };
        let id = buffer.ansi(row.AdapterName)?;
        if row.IfType != 24 && !filters.contains(&id.trim_matches(['{', '}']).to_ascii_lowercase())
        {
            let mut addresses = Vec::new();
            let mut address = row.FirstUnicastAddress;
            let mut seen_addresses = HashSet::new();
            while !address.is_null() {
                buffer.validate::<IP_ADAPTER_UNICAST_ADDRESS_LH>(address)?;
                if !seen_addresses.insert(address as usize) || seen_addresses.len() > 65536 {
                    return Err(Error::invalid("Invalid unicast address chain."));
                }
                // SAFETY: unicast record was checked against the native
                // allocation and its alignment before borrowing it.
                let unicast = unsafe { &*address };
                if unicast.Address.iSockaddrLength < 2 {
                    return Err(Error::invalid("Invalid adapter socket address length."));
                }
                let raw = buffer.bytes(
                    unicast.Address.lpSockaddr.cast(),
                    unicast.Address.iSockaddrLength as usize,
                )?;
                let family = u16::from_ne_bytes(raw[..2].try_into().unwrap());
                let ip = match family {
                    2 if raw.len() >= 16 => Some(IpAddr::V4(Ipv4Addr::from(
                        <[u8; 4]>::try_from(&raw[4..8]).unwrap(),
                    ))),
                    23 if raw.len() >= 28 => Some(IpAddr::V6(Ipv6Addr::from(
                        <[u8; 16]>::try_from(&raw[8..24]).unwrap(),
                    ))),
                    2 | 23 => return Err(Error::invalid("Truncated adapter socket address.")),
                    _ => None,
                };
                if let Some(ip) = ip {
                    addresses.push((ip, unicast.OnLinkPrefixLength));
                }
                address = unicast.Next;
            }
            // SAFETY: these are the documented populated struct union views
            // for IP_ADAPTER_ADDRESSES_LH, returned by the Windows 10+ API.
            let (flags, index) =
                unsafe { (row.Anonymous2.Flags, row.Anonymous1.Anonymous.IfIndex) };
            result.push(InterfaceInfo {
                id,
                name: buffer.unicode(row.FriendlyName)?,
                description: buffer.unicode(row.Description)?,
                status: row.OperStatus as u32,
                ipv4_index: if flags & 0x80 != 0 { index } else { 0 },
                ipv6_index: if flags & 0x100 != 0 {
                    row.Ipv6IfIndex
                } else {
                    0
                },
                addresses,
            });
        }
        pointer = row.Next;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::NativeBuffer;

    #[test]
    fn byte_views_borrow_storage_and_reject_allocation_padding() {
        for length in [0, 1, 7, 8, 9, 15, 16, 17] {
            let mut buffer = NativeBuffer::new(length);
            for word in &mut buffer.storage {
                *word = u64::from_ne_bytes([0, 1, 2, 3, 4, 5, 6, 7]);
            }
            let start = buffer.as_mut_ptr();
            let bytes = buffer.bytes(start, length).unwrap();
            assert_eq!(bytes.as_ptr(), start);
            assert_eq!(
                bytes,
                (0..length).map(|i| (i % 8) as u8).collect::<Vec<_>>()
            );
            if length > 1 {
                assert_eq!(buffer.bytes(start.wrapping_add(1), 1).unwrap(), &[1]);
            }
            assert!(buffer
                .bytes(start.wrapping_add(length), 0)
                .unwrap()
                .is_empty());
            assert!(buffer.bytes(start, length + 1).is_err());
            assert!(buffer.bytes(start.wrapping_add(length), 1).is_err());
        }
    }

    #[test]
    fn byte_views_reject_external_addresses_and_length_overflow() {
        let mut buffer = NativeBuffer::new(16);
        let start = buffer.as_mut_ptr();
        assert!(buffer.bytes(std::ptr::null(), 0).is_err());
        assert!(buffer.bytes(start.wrapping_sub(1), 1).is_err());
        assert!(buffer.bytes(start.wrapping_add(17), 0).is_err());
        assert!(buffer.bytes(start, usize::MAX).is_err());
    }
}
