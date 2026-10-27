//! Project the existing authenticated metrics response into bounded group summaries.
//! Errors/reasons, identities and arbitrary core diagnostics never reach the UI.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub fn sanitize(raw: &Value) -> Value {
    let Some(raw) = raw
        .as_object()
        .filter(|rows| rows.len() <= wayrill_protocol::MAX_OUTBOUNDS)
    else {
        return Value::Null;
    };
    let mut result = serde_json::Map::new();
    for (tag, row) in raw {
        if tag.is_empty() || tag.len() > 256 || !row.is_object() {
            continue;
        }
        let alive = row["alive"].as_bool().unwrap_or(false);
        let delay = row["delay"].as_u64().filter(|n| *n <= 86_400_000);
        // A zero delay may be omitted by protobuf JSON; failed/untested rows must
        // not become a successful zero. Alive is the core's authoritative health.
        if alive && delay.is_none() && !row["delay"].is_null() {
            continue;
        }
        result.insert(
            tag.clone(),
            json!({"alive":alive,"delay":if alive {Some(delay.unwrap_or(0))} else {None}}),
        );
    }
    Value::Object(result)
}

pub fn groups(config: &Value, raw: &Value) -> Value {
    let Some(reports) = raw.as_object() else {
        return json!([]);
    };
    let outbounds: BTreeSet<_> = config["outbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o["tag"].as_str())
        .collect();
    let mut groups = Vec::new();
    for group in config["routing"]["balancers"]
        .as_array()
        .into_iter()
        .flatten()
        .take(wayrill_protocol::MAX_SNAPSHOT_ENDPOINTS)
    {
        let Some(tag) = group["tag"].as_str() else {
            continue;
        };
        let mut candidates = BTreeMap::new();
        for prefix in group["selector"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            for candidate in outbounds
                .range(prefix..)
                .take_while(|tag| tag.starts_with(prefix))
            {
                candidates.insert(*candidate, reports.get(*candidate));
            }
        }
        let checked = candidates.values().filter(|r| r.is_some()).count();
        let live: Vec<_> = candidates
            .values()
            .filter_map(|r| r.and_then(|v| v["delay"].as_u64()))
            .collect();
        let strategy = group["strategy"]["type"].as_str().unwrap_or("random");
        let minimum = matches!(strategy, "leastPing" | "leastLoad");
        let latency = if live.is_empty() {
            None
        } else if minimum {
            live.iter().copied().min()
        } else {
            Some((live.iter().sum::<u64>() + live.len() as u64 / 2) / live.len() as u64)
        };
        groups.push(json!({"tag":tag,"strategy":strategy,"total":candidates.len(),"checked":checked,"alive":live.len(),"latencyMs":latency}));
    }
    json!(groups)
}

/// Only canvas monitoring aliases are projected; large policy candidate sets
/// remain bounded summaries instead of being copied into every status message.
pub fn outbounds(config: &Value, reports: &Value) -> Value {
    let rows: Vec<_> = config["outbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|outbound| {
            let probe = outbound["tag"].as_str()?;
            let tag = probe.strip_prefix("wayrill-observed-")?;
            let report = &reports[probe];
            Some(
                json!({"tag":tag,"checked":report.is_object(),"alive":report["alive"] == true,
                "latencyMs":report["delay"]}),
            )
        })
        .take(500)
        .collect();
    json!(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn returns_only_canvas_path_reports_including_unchecked_and_failed() {
        let config = json!({"outbounds":[{"tag":"wayrill-observed-plain"},{"tag":"wayrill-observed-chain"},{"tag":"wayrill-observed-waiting"},{"tag":"internal-candidate"}]});
        let reports = sanitize(
            &json!({"wayrill-observed-plain":{"alive":true,"delay":37},"wayrill-observed-chain":{"alive":false,"delay":999}}),
        );
        let result = outbounds(&config, &reports);
        assert_eq!(result.as_array().unwrap().len(), 3);
        assert_eq!(
            result[0],
            json!({"tag":"plain","checked":true,"alive":true,"latencyMs":37})
        );
        assert_eq!(
            result[1],
            json!({"tag":"chain","checked":true,"alive":false,"latencyMs":null})
        );
        assert_eq!(result[2]["checked"], false);
    }
    #[test]
    fn projects_unique_selected_members_without_errors_or_private_diagnostics() {
        let raw = sanitize(
            &json!({"peer-a":{"alive":true,"delay":20,"last_error_reason":"private"},"peer-b":{"alive":true,"delay":61},"peer-c":{"delay":999},"strange":{"alive":true,"delay":-9}}),
        );
        assert!(raw["strange"].is_null());
        assert!(!raw.to_string().contains("private"));
        let config = json!({"outbounds":[{"tag":"peer-a"},{"tag":"peer-b"},{"tag":"peer-c"},{"tag":"control"}],"routing":{"balancers":[{"tag":"pool","selector":["peer-","peer-a"],"strategy":{"type":"roundRobin"}}]}});
        let stats = groups(&config, &raw);
        assert_eq!(stats[0]["total"], 3);
        assert_eq!(stats[0]["checked"], 3);
        assert_eq!(stats[0]["alive"], 2);
        assert_eq!(stats[0]["latencyMs"], 41);
        let mut least = config;
        least["routing"]["balancers"][0]["strategy"]["type"] = json!("leastLoad");
        assert_eq!(groups(&least, &raw)[0]["latencyMs"], 20);
    }
    #[test]
    fn distinguishes_untested_failure_and_omitted_successful_zero() {
        let config = json!({"outbounds":[{"tag":"a"},{"tag":"b"}],"routing":{"balancers":[{"tag":"pool","selector":[""]}]}});
        let no_reports = groups(&config, &sanitize(&json!({})));
        assert_eq!(no_reports[0]["checked"], 0);
        assert!(no_reports[0]["latencyMs"].is_null());
        let failed = groups(&config, &sanitize(&json!({"a":{}})));
        assert_eq!(failed[0]["checked"], 1);
        assert_eq!(failed[0]["alive"], 0);
        let live = groups(&config, &sanitize(&json!({"a":{"alive":true}})));
        assert_eq!(live[0]["latencyMs"], 0);
        assert!(sanitize(&json!(["invalid"])).is_null());
    }
}
