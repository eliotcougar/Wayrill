// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    process::{ProcessInfo, ProcessKey},
    text, Error, Result,
};

struct Reader<'a> {
    remaining: &'a [u8],
}
impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        if self.remaining.len() < length {
            return Err(Error::invalid("Truncated process event payload."));
        }
        let (value, next) = self.remaining.split_at(length);
        self.remaining = next;
        Ok(value)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn pid(&mut self) -> Result<u32> {
        let pid = self.u32()?;
        if pid > i32::MAX as u32 {
            return Err(Error::invalid("Process ID overflow."));
        }
        Ok(pid)
    }
    fn unicode(&mut self) -> Result<String> {
        let Some(length) = self
            .remaining
            .as_chunks::<2>()
            .0
            .iter()
            .position(|p| *p == [0, 0])
            .map(|i| i * 2)
        else {
            return Err(Error::invalid("Unterminated process event string."));
        };
        let words = self
            .take(length)?
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| u16::from_le_bytes(*p))
            .collect::<Vec<_>>();
        self.take(2)?;
        Ok(String::from_utf16_lossy(&words))
    }
}
/// Versioned Microsoft-Windows-Kernel-Process payload decoding. Path/device and
/// package resolution are supplied by native readers, outside packet handling.
pub fn decode(
    id: u16,
    version: u8,
    timestamp: i64,
    payload: &[u8],
    normalize: impl FnOnce(&str) -> Option<String>,
    family: impl FnOnce(&str) -> Option<String>,
) -> Result<ProcessInfo> {
    if !(id == 1 && version <= 4 || id == 2 && version <= 2) {
        return Err(Error::invalid(format!(
            "Unsupported process event {id}, version {version}."
        )));
    }
    let read = || -> Result<ProcessInfo> {
        let mut reader = Reader { remaining: payload };
        let pid = reader.pid()?;
        let sequence = if id == 1 && version >= 3 || id == 2 && version >= 2 {
            reader.u64()?
        } else {
            0
        };
        let key = ProcessKey {
            pid,
            started: reader.i64()?,
        };
        if id == 2 {
            return Ok(ProcessInfo {
                key,
                parent_pid: 0,
                name: String::new(),
                path: None,
                exited: Some(reader.i64()?),
                sequence,
                parent_sequence: 0,
                started_at: 0,
                exited_at: Some(timestamp),
                package: None,
            });
        }
        let parent_pid = reader.pid()?;
        let parent_sequence = if version >= 3 { reader.u64()? } else { 0 };
        reader.take(4)?;
        if version >= 1 {
            reader.take(4)?;
        }
        if version >= 3 {
            reader.take(8)?;
            let sid = reader.take(8)?;
            reader.take(usize::from(sid[1]) * 4)?;
        }
        let image = reader.unicode()?;
        let package = if version >= 2 {
            reader.take(8)?;
            family(&reader.unicode()?)
        } else {
            None
        };
        Ok(ProcessInfo {
            key,
            parent_pid,
            name: text::filename(&image).into(),
            path: normalize(&image),
            exited: None,
            sequence,
            parent_sequence,
            started_at: timestamp,
            exited_at: None,
            package,
        })
    };
    read().map_err(|error| {
        Error::invalid(format!(
            "Invalid process event {id}, version {version}: {error}"
        ))
    })
}
