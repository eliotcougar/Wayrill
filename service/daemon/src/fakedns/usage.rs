//! Bounded, read-only occupancy telemetry. Missing or invalid diagnostics never
//! change allocator health or routing behavior.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, PartialEq, prost::Message, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PoolUsage {
    #[prost(string, tag = "1")]
    #[serde(alias = "ip_pool")]
    pub(super) ip_pool: String,
    #[prost(uint64, tag = "2")]
    #[serde(default)]
    used: u64,
    #[prost(uint64, tag = "3")]
    capacity: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Usage {
    used: u64,
    capacity: u64,
    pools: Vec<PoolUsage>,
}
impl Usage {
    pub(super) fn new(pools: Vec<PoolUsage>) -> Option<Self> {
        if pools.is_empty() || pools.len() > 32 {
            return None;
        }
        let mut result = Self {
            used: 0,
            capacity: 0,
            pools,
        };
        for (index, pool) in result.pools.iter().enumerate() {
            let prefix = pool.ip_pool.parse::<ipnet::IpNet>().ok()?;
            if prefix.trunc().to_string() != pool.ip_pool
                || pool.capacity == 0
                || pool.capacity > u32::MAX as u64
                || pool.used > pool.capacity
                || result.pools[..index]
                    .iter()
                    .any(|p| p.ip_pool == pool.ip_pool)
            {
                return None;
            }
            result.used += pool.used;
            result.capacity += pool.capacity;
        }
        Some(result)
    }
    pub(crate) fn from_metrics(value: &Value) -> Option<Self> {
        Self::new(serde_json::from_value(value.clone()).ok()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn usage_counts_family_slots_and_accepts_an_empty_allocator() {
        let usage = Usage::from_metrics(&json!([
            {"ip_pool":"198.18.0.0/15","capacity":32768},
            {"ip_pool":"2001:2::/48","used":12,"capacity":32768}
        ]))
        .unwrap();
        assert_eq!(usage.used, 12);
        assert_eq!(usage.capacity, 65536);
        assert_eq!(serde_json::to_value(usage).unwrap()["pools"][0]["used"], 0);
    }
    #[test]
    fn invalid_or_missing_diagnostics_are_unavailable_rather_than_zero() {
        for value in [
            Value::Null,
            json!([]),
            json!([{"ip_pool":"198.18.0.0/15","used":4,"capacity":3}]),
            json!([{"ip_pool":"198.18.0.1/15","capacity":3}]),
            json!([{"ip_pool":"198.18.0.0/15","capacity":0}]),
            json!([{"ip_pool":"198.18.0.0/15","capacity":3},{"ip_pool":"198.18.0.0/15","capacity":3}]),
        ] {
            assert!(Usage::from_metrics(&value).is_none(), "{value}");
        }
    }
}
