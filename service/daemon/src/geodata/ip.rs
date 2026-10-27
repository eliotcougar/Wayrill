//! Canonical prefixes for a single native GeoIP/CIDR selector. Negation applies
//! only to address families present in the set, like the pinned IPSet matcher.
use super::{invalid, Query};
use serde_json::{json, Value};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::atomic::{AtomicBool, Ordering},
};
use wayrill_protocol::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Prefix {
    address: u128,
    width: u32,
    bits: u32,
}
impl Prefix {
    pub(super) fn from_bytes(bytes: &[u8], bits: u64) -> Result<Self> {
        let (address, width) = match bytes.len() {
            4 => (u32::from_be_bytes(bytes.try_into().unwrap()) as u128, 32),
            16 => (u128::from_be_bytes(bytes.try_into().unwrap()), 128),
            _ => return Err(invalid("Invalid GeoIP address.")),
        };
        if bits > width as u64 {
            return Err(invalid("Invalid GeoIP prefix."));
        }
        Ok(Self {
            address,
            width,
            bits: bits as u32,
        })
    }
    pub(super) fn parse(text: &str) -> Result<Self> {
        let (address, bits) = text
            .split_once('/')
            .map_or((text, None), |(a, b)| (a, Some(b)));
        let ip: IpAddr = address
            .parse()
            .map_err(|_| invalid("Enter a valid IPv4/IPv6 address or CIDR."))?;
        let (address, width) = match ip {
            IpAddr::V4(ip) => (u32::from(ip) as u128, 32),
            IpAddr::V6(ip) => {
                if let Some(v4) = ip.to_ipv4_mapped() {
                    (u32::from(v4) as u128, 32)
                } else {
                    (u128::from(ip), 128)
                }
            }
        };
        let bits = match bits {
            None | Some("") => width,
            Some(b) => b
                .parse::<u32>()
                .map_err(|_| invalid("Invalid CIDR prefix length."))?,
        };
        if bits > width {
            return Err(invalid("CIDR prefix exceeds its address family."));
        }
        Ok(Self {
            address,
            width,
            bits,
        })
    }
    fn interval(self) -> (u128, u128) {
        let hosts = self.width - self.bits;
        let mask = if hosts == 128 {
            u128::MAX
        } else {
            (1u128 << hosts) - 1
        };
        let low = self.address & !mask;
        (low, low | mask)
    }
    fn display(self) -> String {
        let address = if self.width == 32 {
            Ipv4Addr::from(self.address as u32).to_string()
        } else {
            Ipv6Addr::from(self.address).to_string()
        };
        format!("{address}/{}", self.bits)
    }
}
fn stopped(stop: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::Relaxed) {
        Err(invalid("Resource browsing stopped."))
    } else {
        Ok(())
    }
}
fn intervals(
    prefixes: &[Prefix],
    width: u32,
    inverse: bool,
    stop: &AtomicBool,
) -> Result<Vec<(u128, u128)>> {
    let mut ranges: Vec<_> = prefixes
        .iter()
        .filter(|p| p.width == width)
        .map(|p| p.interval())
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(u128, u128)> = Vec::new();
    for (i, (low, high)) in ranges.into_iter().enumerate() {
        if i % 1024 == 0 {
            stopped(stop)?;
        }
        if let Some(last) = merged.last_mut() {
            if low <= last.1 || last.1.checked_add(1) == Some(low) {
                last.1 = last.1.max(high);
                continue;
            }
        }
        merged.push((low, high));
    }
    if !inverse || merged.is_empty() {
        return Ok(merged);
    }
    let max = if width == 32 {
        u32::MAX as u128
    } else {
        u128::MAX
    };
    let mut result = Vec::new();
    let mut next = 0;
    for (low, high) in merged {
        if next < low {
            result.push((next, low - 1));
        }
        if high == max {
            return Ok(result);
        }
        next = high + 1;
    }
    result.push((next, max));
    Ok(result)
}
pub(super) fn page(prefixes: &[Prefix], q: &Query, stop: &AtomicBool) -> Result<Value> {
    let mut rows = Vec::new();
    let mut total = 0usize;
    let mut visited = 0usize;
    let needle = q.query.to_lowercase();
    for width in [32u32, 128] {
        for (mut low, high) in intervals(prefixes, width, q.inverse, stop)? {
            loop {
                if visited.is_multiple_of(1024) {
                    stopped(stop)?;
                }
                visited += 1;
                if visited > 4_000_000 {
                    return Err(invalid(
                        "The expression exceeds the preview limit of 4,000,000 ranges.",
                    ));
                }
                let span = high.checked_sub(low).and_then(|n| n.checked_add(1));
                let fit = span.map_or(128, |n| 127 - n.leading_zeros());
                let host = low.trailing_zeros().min(width).min(fit);
                let value = Prefix {
                    address: low,
                    width,
                    bits: width - host,
                }
                .display();
                if needle.is_empty() || value.to_lowercase().contains(&needle) {
                    if total >= q.offset && rows.len() < q.limit {
                        rows.push(json!({"value":value,"preview":value}));
                    }
                    total += 1;
                }
                if host == 128 {
                    break;
                }
                let Some(next) = low.checked_add(1u128 << host) else {
                    break;
                };
                if next > high {
                    break;
                }
                low = next;
            }
        }
    }
    Ok(
        json!({"ready":true,"total":total,"offset":q.offset,"limit":q.limit,"rows":rows,"group":null}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn preview(values: &[&str], inverse: bool) -> Value {
        let mut q = super::super::tests::query("geoip");
        q.inverse = inverse;
        page(
            &values
                .iter()
                .map(|s| Prefix::parse(s).unwrap())
                .collect::<Vec<_>>(),
            &q,
            &AtomicBool::new(false),
        )
        .unwrap()
    }
    #[test]
    fn merges_masks_and_presents_the_actual_complement() {
        let p = preview(&["192.0.2.129/25", "192.0.2.1/25", "192.0.2.0/24"], false);
        assert_eq!(p["total"], 1);
        assert_eq!(p["rows"][0]["value"], "192.0.2.0/24");
        let p = preview(&["0.0.0.0/1"], true);
        assert_eq!(
            p["rows"],
            json!([{"value":"128.0.0.0/1","preview":"128.0.0.0/1"}])
        );
        assert_eq!(preview(&["0.0.0.0/0", "::/0"], true)["total"], 0);
        assert_eq!(preview(&["::/1"], true)["rows"][0]["value"], "8000::/1");
    }
    #[test]
    fn handles_boundaries_single_hosts_and_native_family_scope() {
        assert_eq!(preview(&["0.0.0.0"], true)["total"], 32);
        assert_eq!(preview(&["::"], true)["total"], 128);
        assert_eq!(
            preview(&["255.255.255.255"], false)["rows"][0]["value"],
            "255.255.255.255/32"
        );
        assert_eq!(
            preview(&["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"], false)["total"],
            1
        );
        assert!(Prefix::parse("1.2.3.4/33").is_err());
        assert!(Prefix::parse("::/129").is_err());
        assert!(Prefix::parse("::ffff:192.0.2.1/120").is_err());
    }
}
