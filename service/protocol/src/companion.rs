//! Browser Companion lookups and bounded, normal-user desktop edit requests.
use crate::{ApiError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_HOSTS: usize = 128;

/// A reference to service-owned Stash data, never a browser-supplied config.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimezoneSelection {
    pub group_id: String,
    pub entry_id: String,
    pub version: u64,
}
impl TimezoneSelection {
    pub fn validate(&self) -> Result<()> {
        if [&self.group_id, &self.entry_id]
            .iter()
            .any(|id| id.is_empty() || id.len() > 160 || id.chars().any(char::is_control))
        {
            return Err(ApiError::new("INVALID_PARAMS", "Invalid Stash selection."));
        }
        Ok(())
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TimezoneRequest {
    pub selection: Option<TimezoneSelection>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleRequest {
    pub host: String,
    #[serde(default)]
    pub filter_ids: Vec<String>,
}
impl RuleRequest {
    pub fn normalized(mut self) -> Result<Self> {
        self.host = normalize_host(&self.host)?;
        if self.host.parse::<std::net::IpAddr>().is_ok()
            || self.filter_ids.len() > 8
            || self
                .filter_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 160 || id.chars().any(char::is_control))
        {
            return Err(ApiError::new(
                "INVALID_PARAMS",
                "Expected a domain and up to eight traffic filter IDs.",
            ));
        }
        let mut seen = BTreeSet::new();
        self.filter_ids.retain(|id| seen.insert(id.clone()));
        Ok(self)
    }
}

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
