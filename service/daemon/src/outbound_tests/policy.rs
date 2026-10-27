//! Snapshot the selected member for one download without altering active routing.
use super::{invalid, ActivePolicy};
use crate::live::Control;
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    ops::Bound::{Included, Unbounded},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use wayrill_protocol::Result;

fn selected<'a>(config: &'a Value, group: &Value) -> BTreeSet<&'a str> {
    let catalog: BTreeSet<_> = config["outbounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o["tag"].as_str())
        .collect();
    let mut result = BTreeSet::new();
    for prefix in group["selector"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        result.extend(
            catalog
                .range::<str, _>((Included(prefix), Unbounded))
                .take_while(|tag| tag.starts_with(prefix))
                .copied(),
        );
    }
    result
}

fn matching<'a>(config: &Value, group: &Value, root: &str, active: &'a Value) -> Option<&'a Value> {
    // Checking the complete outbound closure also detects edits to chain hops or
    // DNS transports. Ignore only the test's synthetic root loopback wrapper.
    let outputs: HashMap<_, _> = active["outbounds"]
        .as_array()?
        .iter()
        .filter_map(|o| o["tag"].as_str().map(|tag| (tag, o)))
        .collect();
    let definitions_match = config["outbounds"].as_array()?.iter().all(|o| {
        if o["tag"] == root && o["protocol"] == "loopback" {
            return true;
        }
        o["tag"]
            .as_str()
            .is_some_and(|tag| outputs.get(tag).copied() == Some(o))
    });
    if !definitions_match {
        return None;
    }
    let members = selected(config, group);
    active["routing"]["balancers"]
        .as_array()?
        .iter()
        .find(|other| {
            other["strategy"] == group["strategy"]
                && other["fallbackTag"] == group["fallbackTag"]
                && selected(active, other) == members
        })
}

fn winner(
    config: &Value,
    group: &Value,
    choice: crate::live::selection::Selection,
) -> Result<Option<String>> {
    let tag = if !choice.override_target.is_empty() {
        Some(choice.override_target)
    } else if !choice.candidates.is_empty() {
        let random = u128::from_str_radix(&crate::tun::random_id()?, 16)
            .map_err(|_| invalid("Cannot select a policy member."))?;
        Some(choice.candidates[(random % choice.candidates.len() as u128) as usize].clone())
    } else {
        group["fallbackTag"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(String::from)
    };
    if tag.as_ref().is_some_and(|tag| {
        !config["outbounds"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|o| o["tag"].as_str() == Some(tag))
    }) {
        return Err(invalid(
            "The selected policy member no longer matches this configuration.",
        ));
    }
    Ok(tag)
}

pub(super) fn prepare(
    owned: &Control,
    active: Option<&ActivePolicy>,
    config: &Value,
    root: &str,
    stop: &AtomicBool,
) -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| invalid("Cannot read the policy selection."))?
        .block_on(async {
            for group in config["routing"]["balancers"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if stop.load(Ordering::SeqCst) {
                    return Err(invalid("Test cancelled."));
                }
                let tag = group["tag"]
                    .as_str()
                    .ok_or_else(|| invalid("Missing policy tag."))?;
                let strategy = group["strategy"]["type"].as_str().unwrap_or("random");
                let live =
                    active.and_then(|a| matching(config, group, root, &a.config).map(|g| (a, g)));
                let choice = if let Some((active, live)) = live {
                    let choice = active
                        .control
                        .balancer_selection(live["tag"].as_str().unwrap())
                        .await?;
                    if choice.override_target.is_empty()
                        && !matches!(strategy, "leastPing" | "leastLoad")
                    {
                        // These strategies select afresh per connection; they have
                        // no persistent winner to copy or average.
                        continue;
                    }
                    winner(config, group, choice)?
                } else if matches!(strategy, "leastPing" | "leastLoad") {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    loop {
                        if stop.load(Ordering::SeqCst) {
                            return Err(invalid("Test cancelled."));
                        }
                        let choice = owned.balancer_selection(tag).await?;
                        if !choice.override_target.is_empty()
                            || !choice.candidates.is_empty()
                            || Instant::now() >= deadline
                        {
                            break winner(config, group, choice)?;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                } else {
                    continue;
                };
                let choice = choice.ok_or_else(|| {
                    invalid("This policy group has no available member or fallback.")
                })?;
                if stop.load(Ordering::SeqCst) {
                    return Err(invalid("Test cancelled."));
                }
                owned.pin_test_balancer(tag, &choice).await?;
            }
            Ok(())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn live_selection_is_reused_only_for_the_same_members_and_connection_definitions() {
        let config = json!({"outbounds":[{"tag":"test","protocol":"loopback"},{"tag":"a","protocol":"freedom"}],"routing":{"balancers":[{"tag":"test","selector":["a"],"strategy":{"type":"leastPing"}}]}});
        let mut live = config.clone();
        live["outbounds"].as_array_mut().unwrap().remove(0);
        live["routing"]["balancers"][0]["tag"] = json!("running");
        assert_eq!(
            matching(&config, &config["routing"]["balancers"][0], "test", &live).unwrap()["tag"],
            "running"
        );
        live["outbounds"][0]["sendThrough"] = json!("192.0.2.1");
        assert!(matching(&config, &config["routing"]["balancers"][0], "test", &live).is_none());
    }
    #[test]
    fn no_live_candidate_uses_only_the_explicit_fallback_and_never_default_direct() {
        let config = json!({"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"blocked","protocol":"blackhole"}]});
        let choice = || crate::live::selection::Selection {
            override_target: String::new(),
            candidates: vec![],
        };
        assert!(winner(&config, &json!({}), choice()).unwrap().is_none());
        assert_eq!(
            winner(&config, &json!({"fallbackTag":"blocked"}), choice())
                .unwrap()
                .as_deref(),
            Some("blocked")
        );
        assert!(winner(&config, &json!({"fallbackTag":"absent"}), choice()).is_err());
    }
}
