//! Read-only browser Companion contract. Hosts are exact ASCII/IDNA names or IPs.
use crate::{ApiError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_HOSTS: usize = 128;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Lookup {
    pub hosts: Vec<String>,
}
impl Lookup {
    pub fn normalized(&self) -> Result<BTreeSet<String>> {
        if self.hosts.len() > MAX_HOSTS {
            return Err(ApiError::new(
                "INVALID_PARAMS",
                "At most 128 hosts per lookup.",
            ));
        }
        self.hosts.iter().map(|host| normalize_host(host)).collect()
    }
}

pub fn normalize_host(host: &str) -> Result<String> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let ip = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(&host);
    if let Ok(ip) = ip.parse::<std::net::IpAddr>() {
        return Ok(ip.to_string());
    }
    if host.is_empty()
        || host.len() > 253
        || !host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
    {
        return Err(ApiError::new(
            "INVALID_PARAMS",
            "Expected an ASCII hostname or IP address, without a URL or port.",
        ));
    }
    Ok(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_hosts_cannot_be_urls_patterns_or_unbounded_queries() {
        for bad in [
            "",
            "https://a.test/secret",
            "*.test",
            "a.test:443",
            "a..test",
            "é.test",
            "a\ntest",
        ] {
            assert!(normalize_host(bad).is_err(), "{bad}");
        }
        assert_eq!(normalize_host("EXAMPLE.org.").unwrap(), "example.org");
        assert_eq!(normalize_host("[2001:0db8::1]").unwrap(), "2001:db8::1");
        assert!(Lookup {
            hosts: vec!["a.test".into(); MAX_HOSTS + 1]
        }
        .normalized()
        .is_err());
        assert!(serde_json::from_value::<Lookup>(
            serde_json::json!({"hosts":[],"method":"core.stop"})
        )
        .is_err());
    }
}
