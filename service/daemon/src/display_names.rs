use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use wayrill_protocol::{ApiError, Result};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplayNames {
    #[serde(default)]
    pub inbound: BTreeMap<String, String>,
    #[serde(default)]
    pub outbound: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub routing: BTreeMap<String, Vec<crate::routing_log::Hop>>,
    #[serde(
        default,
        rename = "routingDefault",
        skip_serializing_if = "Option::is_none"
    )]
    pub routing_default: Option<Vec<crate::routing_log::Hop>>,
}
impl DisplayNames {
    pub fn validate(&self, config: &Value) -> Result<()> {
        for (kind, names) in [("inbounds", &self.inbound), ("outbounds", &self.outbound)] {
            if names.len() > wayrill_protocol::MAX_OUTBOUNDS {
                return Err(ApiError::new(
                    "INVALID_PARAMS",
                    "Too many endpoint display names.",
                ));
            }
            let tags: std::collections::HashSet<&str> = config[kind]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v["tag"].as_str())
                .collect();
            for (tag, name) in names {
                if !tags.contains(tag.as_str())
                    || name.is_empty()
                    || name.chars().count() > 160
                    || name.chars().any(char::is_control)
                {
                    return Err(ApiError::new("INVALID_PARAMS", "Endpoint display names must reference configured tags and contain 1-160 printable characters."));
                }
            }
        }
        crate::routing_log::validate_metadata(self, config)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_tag_membership_and_bounds() {
        let config =
            serde_json::json!({"inbounds":[{"tag":"local"}],"outbounds":[{"tag":"member-hash"}]});
        let mut names = DisplayNames::default();
        names
            .outbound
            .insert("member-hash".into(), "Friendly server".into());
        names.validate(&config).unwrap();
        let restored: DisplayNames =
            serde_json::from_value(serde_json::to_value(&names).unwrap()).unwrap();
        assert_eq!(restored.outbound["member-hash"], "Friendly server");
        for invalid in ["".to_string(), "a".repeat(161), "line\nbreak".into()] {
            names.outbound.insert("member-hash".into(), invalid);
            assert!(names.validate(&config).is_err());
        }
        names.outbound.clear();
        names.outbound.insert("missing".into(), "Server".into());
        assert!(names.validate(&config).is_err());
    }
}
