//! Project the existing authenticated metrics response into bounded group summaries.
//! Errors/reasons, identities and arbitrary core diagnostics never reach the UI.
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::ops::Range;

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

#[derive(Default)]
pub struct GroupPlan {
    tags: Vec<String>,
    groups: Vec<Group>,
    selected: Vec<Range<usize>>,
}

struct Group {
    tag: String,
    strategy: String,
    members: Vec<Range<usize>>,
    total: usize,
}

fn merge_ranges(mut ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    ranges.sort_unstable_by_key(|range| range.start);
    let mut merged: Vec<Range<usize>> = Vec::new();
    for range in ranges {
        if let Some(previous) = merged
            .last_mut()
            .filter(|previous| range.start <= previous.end)
        {
            previous.end = previous.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

impl GroupPlan {
    pub fn new(config: &Value) -> Self {
        let Some(groups) = config["routing"]["balancers"]
            .as_array()
            .filter(|groups| !groups.is_empty())
        else {
            return Self::default();
        };
        let tags: Vec<&str> = config["outbounds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|outbound| outbound["tag"].as_str())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let groups: Vec<_> = groups
            .iter()
            .take(wayrill_protocol::MAX_SNAPSHOT_ENDPOINTS)
            .filter_map(|group| {
                let tag = group["tag"].as_str()?;
                let strategy = group["strategy"]["type"].as_str().unwrap_or("random");
                let ranges = group["selector"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter_map(|prefix| {
                        let start = tags.partition_point(|tag| *tag < prefix);
                        let len = tags[start..].partition_point(|tag| tag.starts_with(prefix));
                        (len != 0).then_some(start..start + len)
                    })
                    .collect();
                // Prefix matches occupy contiguous runs of sorted tags. Keep
                // the union of those runs without copying tags into each group.
                let members = merge_ranges(ranges);
                let total = members.iter().map(ExactSizeIterator::len).sum();
                Some(Group {
                    tag: tag.into(),
                    strategy: strategy.into(),
                    members,
                    total,
                })
            })
            .collect();
        let selected = merge_ranges(
            groups
                .iter()
                .flat_map(|group| group.members.iter().cloned())
                .collect(),
        );
        Self {
            tags: tags.into_iter().map(str::to_owned).collect(),
            groups,
            selected,
        }
    }

    pub fn summarize(&self, reports: &serde_json::Map<String, Value>) -> Value {
        // Resolve each report once, even when many groups share the outbound.
        // Outer None means untested; inner None means checked but unavailable.
        let mut readings = vec![None; self.tags.len()];
        for range in &self.selected {
            for (tag, reading) in self.tags[range.clone()]
                .iter()
                .zip(&mut readings[range.clone()])
            {
                *reading = reports.get(tag).map(|value| value["delay"].as_u64());
            }
        }
        Value::Array(self.groups.iter().map(|group| {
            let mut checked = 0;
            let mut alive = 0;
            let mut sum = 0;
            let mut min = u64::MAX;
            for reading in group.members.iter().flat_map(|range| readings[range.clone()].iter().flatten()) {
                checked += 1;
                if let Some(delay) = reading {
                    alive += 1;
                    sum += delay;
                    min = min.min(*delay);
                }
            }
            let latency = if alive == 0 {
                None
            } else if matches!(group.strategy.as_str(), "leastPing" | "leastLoad") {
                Some(min)
            } else {
                Some((sum + alive / 2) / alive)
            };
            json!({"tag":group.tag,"strategy":group.strategy,"total":group.total,"checked":checked,"alive":alive,"latencyMs":latency})
        }).collect())
    }
}

/// Only canvas monitoring aliases are projected; large policy candidate sets
/// remain bounded summaries instead of being copied into every status message.
pub fn outbounds(
    config: &Value,
    reports: &Value,
    names: &crate::display_names::DisplayNames,
) -> Value {
    let rows: Vec<_> = config["outbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|outbound| {
            let probe = outbound["tag"].as_str()?;
            let tag = names
                .observed
                .get(probe)
                .map(String::as_str)
                .or_else(|| probe.strip_prefix("wayrill-observed-"))?;
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
        let config = json!({"outbounds":[{"tag":"wob-AAAAAAAAAAAAAAAAAAAAAA"},{"tag":"wayrill-observed-chain"},{"tag":"wayrill-observed-waiting"},{"tag":"plain"},{"tag":"internal-candidate"}]});
        let reports = sanitize(
            &json!({"wob-AAAAAAAAAAAAAAAAAAAAAA":{"alive":true,"delay":37},"wayrill-observed-chain":{"alive":false,"delay":999}}),
        );
        let mut names = crate::display_names::DisplayNames::default();
        names
            .observed
            .insert("wob-AAAAAAAAAAAAAAAAAAAAAA".into(), "plain".into());
        names.validate(&config).unwrap();
        let result = outbounds(&config, &reports, &names);
        names
            .observed
            .insert("wob-AAAAAAAAAAAAAAAAAAAAAA".into(), "missing".into());
        assert!(names.validate(&config).is_err());
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
        let stats = GroupPlan::new(&config).summarize(raw.as_object().unwrap());
        assert_eq!(stats[0]["total"], 3);
        assert_eq!(stats[0]["checked"], 3);
        assert_eq!(stats[0]["alive"], 2);
        assert_eq!(stats[0]["latencyMs"], 41);
        let mut least = config;
        least["routing"]["balancers"][0]["strategy"]["type"] = json!("leastLoad");
        assert_eq!(
            GroupPlan::new(&least).summarize(raw.as_object().unwrap())[0]["latencyMs"],
            20
        );
    }
    #[test]
    fn distinguishes_untested_failure_and_omitted_successful_zero() {
        let config = json!({"outbounds":[{"tag":"a"},{"tag":"b"}],"routing":{"balancers":[{"tag":"pool","selector":[""]}]}});
        let plan = GroupPlan::new(&config);
        let no_reports = plan.summarize(sanitize(&json!({})).as_object().unwrap());
        assert_eq!(no_reports[0]["checked"], 0);
        assert!(no_reports[0]["latencyMs"].is_null());
        let failed = plan.summarize(sanitize(&json!({"a":{}})).as_object().unwrap());
        assert_eq!(failed[0]["checked"], 1);
        assert_eq!(failed[0]["alive"], 0);
        let live = plan.summarize(sanitize(&json!({"a":{"alive":true}})).as_object().unwrap());
        assert_eq!(live[0]["latencyMs"], 0);
        assert!(sanitize(&json!(["invalid"])).is_null());
    }
}
