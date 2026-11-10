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

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimezoneChoices {
    #[serde(default)]
    pub query: String,
    pub group_id: Option<String>,
    pub selected: Option<TimezoneSelection>,
}
impl TimezoneChoices {
    pub fn validate(&self) -> Result<()> {
        if self.query.len() > 256 || self.group_id.as_ref().is_some_and(|id| id.len() > 160) {
            return Err(ApiError::new("INVALID_REQUEST", "Invalid Stash search."));
        }
        if let Some(selected) = &self.selected {
            selected.validate()?;
        }
        Ok(())
    }
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

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub mode: String,
    pub zone: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<TimezoneSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
}
impl Policy {
    pub fn validate(&self) -> Result<()> {
        let valid = match self.mode.as_str() {
            "off" => self.zone.is_empty() && self.selection.is_none(),
            "manual" | "main" => self.selection.is_none() && valid_zone(&self.zone),
            "custom" => {
                self.selection
                    .as_ref()
                    .is_some_and(|s| s.validate().is_ok())
                    && valid_zone(&self.zone)
            }
            _ => false,
        };
        if !valid
            || self.name.as_ref().is_some_and(|s| s.len() > 512)
            || self
                .ip
                .as_ref()
                .is_some_and(|s| s.parse::<std::net::IpAddr>().is_err())
        {
            return Err(ApiError::new(
                "INVALID_REQUEST",
                "Invalid browser timezone policy.",
            ));
        }
        Ok(())
    }
}
fn valid_zone(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() < 128
        && zone
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/_+-".contains(&c))
}
