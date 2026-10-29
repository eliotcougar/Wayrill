//! Missing DAT groups are inactive in the runtime, never erased from the profile.
//! Keep routing slots stable for capture predicates and execution-log metadata.
use crate::resources::{fields, valid_name, validate_dat, MAX};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, VecDeque},
    fs::{self, File},
    io::Read,
    os::windows::fs::MetadataExt,
    path::Path,
    time::SystemTime,
};
use wayrill_protocol::{ApiError, Result};

const NEVER: &str = "regexp:a^";
const CACHE_BYTES: usize = 8 * 1024 * 1024;

/// File renames preserve the meaning of an already applied profile until its
/// authored references are saved again. Only native matcher fields participate.
pub fn resolve_aliases(
    config: &Value,
    aliases: &std::collections::BTreeMap<String, String>,
) -> Value {
    fn selector(text: &str, aliases: &std::collections::BTreeMap<String, String>) -> String {
        let term = text.trim_start_matches('!');
        let Some((prefix, value)) = term.split_once(':') else {
            return text.to_owned();
        };
        let (file, group) = match prefix {
            "geoip" => ("geoip.dat", value),
            "geosite" => ("geosite.dat", value),
            "ext" | "ext-ip" | "ext-domain" | "ext-site" => {
                let Some(pair) = value.split_once(':') else {
                    return text.to_owned();
                };
                pair
            }
            _ => return text.to_owned(),
        };
        aliases.get(&file.to_lowercase()).map_or_else(
            || text.to_owned(),
            |name| format!("{}ext:{name}:{group}", &text[..text.len() - term.len()]),
        )
    }
    fn visit(
        value: &mut Value,
        key: &str,
        literal: bool,
        aliases: &std::collections::BTreeMap<String, String>,
    ) {
        match value {
            Value::String(text)
                if [
                    "domain",
                    "domains",
                    "ip",
                    "source",
                    "sourceIP",
                    "localIP",
                    "expectedIPs",
                    "unexpectedIPs",
                    "expectIPs",
                    "domainsExcluded",
                    "ipsExcluded",
                    "host-key",
                ]
                .contains(&key) =>
            {
                *text = if literal || key == "host-key" {
                    selector(text, aliases)
                } else {
                    text.split(',')
                        .map(|term| selector(term, aliases))
                        .collect::<Vec<_>>()
                        .join(",")
                };
            }
            Value::Array(rows) => {
                for row in rows {
                    visit(row, key, true, aliases);
                }
            }
            Value::Object(object) => {
                if key == "hosts" {
                    for old in object.keys().cloned().collect::<Vec<_>>() {
                        let name = selector(&old, aliases);
                        if name != old {
                            if let Some(value) = object.remove(&old) {
                                object.entry(name).or_insert(value);
                            }
                        }
                    }
                }
                for (key, value) in object {
                    visit(value, key, false, aliases);
                }
            }
            _ => (),
        }
    }
    let mut result = config.clone();
    if !aliases.is_empty() {
        visit(&mut result, "", false, aliases);
    }
    result
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub skipped_selector_count: usize,
    pub skipped_selectors: Vec<Skipped>,
}
#[derive(Clone, Serialize)]
pub struct Skipped {
    pub selector: String,
    pub context: String,
}
impl Report {
    fn add(&mut self, selector: &str, context: &str) {
        self.skipped_selector_count += 1;
        if self.skipped_selectors.len() < 100 {
            self.skipped_selectors.push(Skipped {
                selector: selector.chars().take(512).collect(),
                context: context.to_owned(),
            });
        }
    }
}
pub struct Projection {
    pub config: Value,
    pub report: Report,
}
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    file: String,
    kind: &'static str,
    size: u64,
    modified: SystemTime,
    generation: u64,
}
struct Catalogue {
    stamp: Stamp,
    groups: BTreeSet<String>,
    charge: usize,
}
#[derive(Default)]
pub struct Catalogues(VecDeque<Catalogue>);

fn invalid(message: &str) -> ApiError {
    ApiError::new("RESOURCE_INVALID", message)
}
fn stamp(root: &Path, file: &str, kind: &'static str, generation: u64) -> Result<Stamp> {
    let metadata = fs::symlink_metadata(root.join(file))
        .map_err(|e| ApiError::io("Inspect resource groups", e))?;
    if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 || metadata.len() > MAX as u64
    {
        return Err(invalid(
            "Resource catalogues require regular DAT files up to 128 MiB.",
        ));
    }
    Ok(Stamp {
        file: file.to_owned(),
        kind,
        generation,
        size: metadata.len(),
        modified: metadata
            .modified()
            .map_err(|e| ApiError::io("Inspect resource timestamp", e))?,
    })
}
// Only recognized, syntactically complete selectors participate. Malformed
// expressions and missing/unreadable files still fail ordinary validation.
fn reference(text: &str, kind: &'static str) -> Option<(String, String)> {
    let text = if kind == "geoip" {
        text.trim_start_matches('!')
    } else {
        text
    };
    let (file, group) = if let Some(group) = text.strip_prefix(&format!("{kind}:")) {
        (format!("{kind}.dat"), group)
    } else {
        let value = text.strip_prefix("ext:").or_else(|| {
            if kind == "geoip" {
                text.strip_prefix("ext-ip:")
            } else {
                text.strip_prefix("ext-domain:")
                    .or_else(|| text.strip_prefix("ext-site:"))
            }
        })?;
        let (file, group) = value.split_once(':')?;
        (crate::resources::canonical_name(file).to_owned(), group)
    };
    let group = if kind == "geoip" {
        group.trim_start_matches('!')
    } else {
        if group.ends_with('@') || group.contains("@@") {
            return None;
        }
        group.split('@').next()?
    };
    if !valid_name(&file)
        || group.is_empty()
        || group.len() > 128
        || group.contains([':', '@', '\r', '\n', '\0'])
    {
        return None;
    }
    // Go strings.ToUpper uses simple Unicode mappings, without expanding a
    // single character into multiple characters (for example sharp s).
    let group = group
        .chars()
        .map(|c| {
            let mut upper = c.to_uppercase();
            let first = upper.next().unwrap();
            if upper.next().is_none() {
                first
            } else {
                c
            }
        })
        .collect();
    Some((file, group))
}
fn nonempty_list(value: &Value) -> bool {
    value.is_string() || value.as_array().is_some_and(|items| !items.is_empty())
}
fn canonical_selector(text: &str) -> std::borrow::Cow<'_, str> {
    let term = text.trim_start_matches('!');
    for prefix in ["ext:", "ext-ip:", "ext-domain:", "ext-site:"] {
        if let Some((file, group)) = term
            .strip_prefix(prefix)
            .and_then(|value| value.split_once(':'))
        {
            let canonical = crate::resources::canonical_name(file);
            if canonical != file {
                return format!(
                    "{}{}{}:{}",
                    &text[..text.len() - term.len()],
                    prefix,
                    canonical,
                    group
                )
                .into();
            }
        }
    }
    text.into()
}
impl Catalogues {
    fn missing(
        &mut self,
        root: &Path,
        text: &str,
        kind: &'static str,
        generation: u64,
    ) -> Result<bool> {
        let Some((file, group)) = reference(text, kind) else {
            return Ok(false);
        };
        let key = stamp(root, &file, kind, generation)?;
        if let Some(index) = self.0.iter().position(|c| c.stamp == key) {
            let catalogue = self.0.remove(index).unwrap();
            let missing = !catalogue.groups.contains(&group);
            self.0.push_back(catalogue);
            return Ok(missing);
        }
        let mut bytes = Vec::new();
        File::open(root.join(&file))
            .and_then(|f| f.take(MAX as u64 + 1).read_to_end(&mut bytes))
            .map_err(|e| ApiError::io("Read resource groups", e))?;
        validate_dat(&bytes, kind)?;
        if stamp(root, &file, kind, generation)? != key {
            return Err(ApiError::new(
                "RESOURCE_CHANGED",
                "Resource changed while inspecting its groups. Retry.",
            ));
        }
        let mut groups = BTreeSet::new();
        for item in fields(&bytes) {
            let (field, wire, entry, _) = item?;
            if field != 1 || wire != 2 {
                continue;
            }
            // Match the pinned core's seek: a group begins with its uppercase
            // code, encoded with one length byte. Do not invent absent aliases.
            if entry.first() == Some(&10) && entry.len() > 2 {
                let len = entry[1] as usize;
                if len < 128 && entry.len() >= 2 + len {
                    if let Ok(code) = std::str::from_utf8(&entry[2..2 + len]) {
                        groups.insert(code.to_owned());
                    }
                }
            }
            if groups.len() > 65536 {
                return Err(invalid("Resource has too many groups."));
            }
        }
        let missing = !groups.contains(&group);
        // Charge conservatively for owned strings and tree nodes. Large catalogues
        // can be used once without being retained in the bounded cache.
        let charge = groups.iter().map(|g| g.len() + 256).sum();
        if charge <= CACHE_BYTES {
            self.0
                .retain(|c| c.stamp.file != file || c.stamp.kind != kind);
            while self.0.len() >= 8
                || self.0.iter().map(|c| c.charge).sum::<usize>() + charge > CACHE_BYTES
            {
                self.0.pop_front();
            }
            self.0.push_back(Catalogue {
                stamp: key,
                groups,
                charge,
            });
        }
        Ok(missing)
    }
    fn list(
        &mut self,
        root: &Path,
        value: &mut Value,
        kind: &'static str,
        generation: u64,
        report: &mut Report,
        context: &str,
    ) -> Result<bool> {
        // Native StringList also accepts comma-separated scalars. Array entries
        // are literal strings; commas inside those entries are not separators.
        if let Some(text) = value.as_str() {
            let mut kept = Vec::new();
            let mut changed = false;
            let mut renamed = false;
            for item in text.split(',') {
                let canonical = canonical_selector(item);
                if self.missing(root, &canonical, kind, generation)? {
                    report.add(item, context);
                    changed = true;
                } else {
                    renamed |= canonical != item;
                    kept.push(Value::String(canonical.into_owned()));
                }
            }
            if changed || renamed {
                *value = Value::Array(kept);
            }
            return Ok(changed);
        }
        let Some(items) = value.as_array_mut() else {
            return Ok(false);
        };
        let mut removed = Vec::new();
        for (index, item) in items.iter_mut().enumerate() {
            if let Some(text) = item.as_str() {
                let canonical = canonical_selector(text);
                if self.missing(root, &canonical, kind, generation)? {
                    report.add(text, context);
                    removed.push(index);
                } else if canonical != text {
                    *item = Value::String(canonical.into_owned());
                }
            }
        }
        if removed.is_empty() {
            return Ok(false);
        }
        let mut removed = removed.into_iter().peekable();
        let mut index = 0;
        items.retain(|_| {
            let keep = removed.peek() != Some(&index);
            if !keep {
                removed.next();
            }
            index += 1;
            keep
        });
        Ok(true)
    }
    pub fn project(&mut self, root: &Path, config: &Value, generation: u64) -> Result<Projection> {
        let mut config = config.clone();
        let mut report = Report::default();
        if let Some(rules) = config
            .get_mut("routing")
            .and_then(|r| r.get_mut("rules"))
            .and_then(Value::as_array_mut)
        {
            for (index, rule) in rules.iter_mut().enumerate() {
                let mut disabled = false;
                let domain_key = if rule.get("domains").is_some_and(|v| !v.is_null()) {
                    "domains"
                } else {
                    "domain"
                };
                let source_key = if rule.get("sourceIP").is_some_and(|v| !v.is_null()) {
                    "sourceIP"
                } else {
                    "source"
                };
                for (key, kind) in [
                    ("domain", "geosite"),
                    ("domains", "geosite"),
                    ("ip", "geoip"),
                    ("source", "geoip"),
                    ("sourceIP", "geoip"),
                    ("localIP", "geoip"),
                ] {
                    // SourceIP supersedes source without parsing the latter.
                    // Both domain aliases are parsed, but domains wins last.
                    if (key == "source" || key == "sourceIP") && key != source_key {
                        continue;
                    }
                    let context = format!("Traffic rule {} · {key}", index + 1);
                    let Some(values) = rule.get_mut(key) else {
                        continue;
                    };
                    if self.list(root, values, kind, generation, &mut report, &context)?
                        && values.as_array().is_some_and(Vec::is_empty)
                    {
                        rule.as_object_mut().unwrap().remove(key);
                        // Removing the authoritative field must not expose an
                        // ignored legacy alias to Xray's fallback parser.
                        if key == "sourceIP" {
                            rule.as_object_mut().unwrap().remove("source");
                        }
                        disabled |= key != "domain" || domain_key == "domain";
                    }
                }
                if disabled {
                    rule.as_object_mut().unwrap().remove("domains");
                    rule["domain"] = json!([NEVER]);
                }
            }
        }
        if let Some(servers) = config
            .get_mut("dns")
            .and_then(|d| d.get_mut("servers"))
            .and_then(Value::as_array_mut)
        {
            for (index, server) in servers.iter_mut().enumerate() {
                if !server.is_object() {
                    continue;
                }
                let mut disabled = false;
                for (key, kind) in [
                    ("domains", "geosite"),
                    ("expectIPs", "geoip"),
                    ("expectedIPs", "geoip"),
                    ("unexpectedIPs", "geoip"),
                ] {
                    if key == "expectIPs" && server.get("expectedIPs").is_some_and(nonempty_list) {
                        continue;
                    }
                    let context = format!("DNS server {} · {key}", index + 1);
                    let Some(values) = server.get_mut(key) else {
                        continue;
                    };
                    let removed =
                        self.list(root, values, kind, generation, &mut report, &context)?;
                    // Missing answer exclusions cannot be silently weakened.
                    disabled |= removed
                        && (key == "unexpectedIPs"
                            || server[key].as_array().is_some_and(Vec::is_empty));
                    if removed && server[key].as_array().is_some_and(Vec::is_empty) {
                        server.as_object_mut().unwrap().remove(key);
                        if key == "expectedIPs" {
                            server.as_object_mut().unwrap().remove("expectIPs");
                        }
                    }
                }
                if disabled {
                    server["domains"] = json!([NEVER]);
                    server["skipFallback"] = json!(true);
                }
            }
        }
        if let Some(hosts) = config
            .get_mut("dns")
            .and_then(|d| d.get_mut("hosts"))
            .and_then(Value::as_object_mut)
        {
            let keys: Vec<_> = hosts.keys().cloned().collect();
            for key in keys {
                let canonical = canonical_selector(&key).into_owned();
                if self.missing(root, &canonical, "geosite", generation)? {
                    hosts.remove(&key);
                    report.add(&key, "DNS hosts");
                } else if canonical != key {
                    if let Some(value) = hosts.remove(&key) {
                        hosts.entry(canonical).or_insert(value);
                    }
                }
            }
        }
        for (index, outbound) in config
            .get_mut("outbounds")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if outbound["protocol"] != "dns" {
                continue;
            }
            for (rule_index, rule) in outbound
                .get_mut("settings")
                .and_then(|s| s.get_mut("rules"))
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
                .enumerate()
            {
                if let Some(domains) = rule.get_mut("domain") {
                    if self.list(
                        root,
                        domains,
                        "geosite",
                        generation,
                        &mut report,
                        &format!(
                            "DNS request policy {} · outbound {}",
                            rule_index + 1,
                            index + 1
                        ),
                    )? && domains.as_array().is_some_and(Vec::is_empty)
                    {
                        rule["domain"] = json!([NEVER]);
                    }
                }
            }
        }
        for (index, inbound) in config
            .get_mut("inbounds")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
            .enumerate()
        {
            for (key, kind) in [("domainsExcluded", "geosite"), ("ipsExcluded", "geoip")] {
                if let Some(sniffing) = inbound.get_mut("sniffing") {
                    if let Some(values) = sniffing.get_mut(key) {
                        self.list(
                            root,
                            values,
                            kind,
                            generation,
                            &mut report,
                            &format!("Inbound {} · sniffing {key}", index + 1),
                        )?;
                    }
                }
            }
        }
        Ok(Projection { config, report })
    }
}

/// Same selector grammar and fields as projection; never scan credentials/tags.
pub fn uses_resources(config: &Value, files: &[String]) -> bool {
    let matches = |value: &Value, kind| {
        let contains = |text: &str| {
            reference(text, kind)
                .is_some_and(|(file, _)| files.iter().any(|f| f.eq_ignore_ascii_case(&file)))
        };
        if let Some(text) = value.as_str() {
            text.split(',').any(contains)
        } else {
            value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(contains)
        }
    };
    config["routing"]["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|rule| {
            matches(&rule["domain"], "geosite")
                || matches(&rule["domains"], "geosite")
                || matches(
                    &rule[if rule.get("sourceIP").is_some_and(|v| !v.is_null()) {
                        "sourceIP"
                    } else {
                        "source"
                    }],
                    "geoip",
                )
                || ["ip", "localIP"]
                    .iter()
                    .any(|k| matches(&rule[*k], "geoip"))
        })
        || config["dns"]["servers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|server| {
                matches(&server["domains"], "geosite")
                    || matches(
                        &server[if nonempty_list(&server["expectedIPs"]) {
                            "expectedIPs"
                        } else {
                            "expectIPs"
                        }],
                        "geoip",
                    )
                    || matches(&server["unexpectedIPs"], "geoip")
            })
        || config["dns"]["hosts"].as_object().is_some_and(|hosts| {
            hosts.keys().any(|key| {
                reference(key, "geosite")
                    .is_some_and(|(file, _)| files.iter().any(|f| f.eq_ignore_ascii_case(&file)))
            })
        })
        || config["outbounds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| o["protocol"] == "dns")
            .any(|o| {
                o["settings"]["rules"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|r| matches(&r["domain"], "geosite"))
            })
        || config["inbounds"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|inbound| {
                matches(&inbound["sniffing"]["domainsExcluded"], "geosite")
                    || matches(&inbound["sniffing"]["ipsExcluded"], "geoip")
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Lab(PathBuf);
    impl Lab {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "wayrill-missing-groups-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let lab = Self(root);
            lab.write("geosite", "KEEP");
            lab.write("geoip", "KEEP");
            lab
        }
        fn write(&self, kind: &str, code: &str) {
            fn wire(field: u8, bytes: &[u8]) -> Vec<u8> {
                let mut v = vec![field * 8 + 2, bytes.len() as u8];
                v.extend(bytes);
                v
            }
            let mut group = wire(1, code.as_bytes());
            let record = if kind == "geoip" {
                vec![10, 4, 192, 0, 2, 0, 16, 24]
            } else {
                let mut v = vec![8, 2];
                v.extend(wire(2, b"example.net"));
                v
            };
            group.extend(wire(2, &record));
            fs::write(self.0.join(format!("{kind}.dat")), wire(1, &group)).unwrap();
        }
        fn project(&self, config: &Value) -> Projection {
            Catalogues::default().project(&self.0, config, 0).unwrap()
        }
    }
    impl Drop for Lab {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn narrows_or_lists_and_never_broadens_an_emptied_and_condition() {
        let lab = Lab::new();
        let config = json!({"routing":{"rules":[
            {"domain":["geosite:keep","geosite:gone"],"outboundTag":"block"},
            {"ip":["geoip:!gone"],"network":"tcp","outboundTag":"block"},
            {"domain":["geosite:gone"],"ip":["192.0.2.1"],"outboundTag":"direct"},
            {"source":["ext-ip:geoip.dat:!gone"],"balancerTag":"pool"}]}});
        let p = lab.project(&config);
        assert_eq!(p.report.skipped_selector_count, 4);
        assert_eq!(p.config["routing"]["rules"].as_array().unwrap().len(), 4);
        assert_eq!(
            p.config["routing"]["rules"][0]["domain"],
            json!(["geosite:keep"])
        );
        for index in 1..4 {
            assert_eq!(
                p.config["routing"]["rules"][index]["domain"],
                json!([NEVER])
            );
        }
        assert_eq!(config["routing"]["rules"][1]["ip"], json!(["geoip:!gone"]));
    }
    #[test]
    fn native_scalar_lists_never_become_catch_all_and_arrays_keep_literal_commas() {
        let lab = Lab::new();
        let config = json!({"routing":{"rules":[
            {"domain":"geosite:gone","outboundTag":"block"},
            {"ip":"geoip:gone","port":"443","outboundTag":"direct"},
            {"domain":"geosite:gone,full:example.net","outboundTag":"direct"},
            {"domain":["full:a,b.example"],"outboundTag":"direct"}]},
            "dns":{"servers":[{"address":"192.0.2.53","domains":"geosite:gone"}]}});
        let p = lab.project(&config);
        for i in 0..2 {
            assert_eq!(p.config["routing"]["rules"][i]["domain"], json!([NEVER]));
        }
        assert_eq!(
            p.config["routing"]["rules"][2]["domain"],
            json!(["full:example.net"])
        );
        assert_eq!(
            p.config["routing"]["rules"][3],
            config["routing"]["rules"][3]
        );
        assert_eq!(p.config["dns"]["servers"][0]["skipFallback"], true);
        assert!(uses_resources(&config, &["geosite.dat".into()]));
        assert!(uses_resources(&config, &["geoip.dat".into()]));
        assert!(!uses_resources(
            &json!({"routing":{"rules":[{"domain":["full:a,geosite:gone"]}]}}),
            &["geosite.dat".into()]
        ));
    }
    #[test]
    fn dns_request_policies_keep_their_other_conditions_when_disabled() {
        let lab = Lab::new();
        let config = json!({"outbounds":[{"protocol":"dns","settings":{"rules":[
            {"domain":["geosite:gone"],"qType":"AAAA","action":"drop"},
            {"domain":["geosite:keep","geosite:gone"],"action":"hijack"},
            {"action":"hijack"}]}}]});
        let p = lab.project(&config);
        assert_eq!(
            p.config["outbounds"][0]["settings"]["rules"][0]["domain"],
            json!([NEVER])
        );
        assert_eq!(
            p.config["outbounds"][0]["settings"]["rules"][0]["qType"],
            "AAAA"
        );
        assert_eq!(
            p.config["outbounds"][0]["settings"]["rules"][1]["domain"],
            json!(["geosite:keep"])
        );
        assert_eq!(
            p.config["outbounds"][0]["settings"]["rules"][2],
            config["outbounds"][0]["settings"]["rules"][2]
        );
        assert!(uses_resources(&config, &["geosite.dat".into()]));
    }
    #[test]
    #[cfg(feature = "core-integration")]
    fn core_integration_accepts_inactive_rules_and_rejects_the_missing_group_control() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        let exe = std::env::var_os("WAYRILL_XRAY_TEST_EXE").expect("explicit pinned core required");
        let lab = Lab::new();
        let config = json!({"inbounds":[{"tag":"proxy","protocol":"socks","listen":"127.0.0.1","port":22981,"settings":{}}],
            "outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"block","protocol":"blackhole"},
                {"tag":"dns","protocol":"dns","settings":{"rules":[{"domain":["geosite:gone"],"qType":"28","action":"drop"},{"action":"hijack"}]}}],
            "dns":{"hosts":{"geosite:gone":"192.0.2.1"},"servers":[{"address":"192.0.2.53","domains":["geosite:gone"],
                "expectedIPs":["geoip:gone"],"expectIPs":["ext:unreadable.dat:gone"]}]},
            "routing":{"rules":[{"domain":["geosite:gone"],"outboundTag":"block"},
                {"ip":["geoip:gone"],"network":"tcp","outboundTag":"block"},
                {"sourceIP":["geoip:gone"],"source":["ext:unreadable.dat:gone"],"outboundTag":"direct"}]}});
        let check = |value: &Value| {
            let mut child = Command::new(&exe)
                .args(["run", "-test", "-format", "json", "-config", "stdin:"])
                .env("XRAY_LOCATION_ASSET", &lab.0)
                .current_dir(&lab.0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&serde_json::to_vec(value).unwrap())
                .unwrap();
            child.wait_with_output().unwrap()
        };
        let original = check(&config);
        assert!(!original.status.success(), "unadjusted control must fail");
        assert!(
            format!(
                "{} {}",
                String::from_utf8_lossy(&original.stdout),
                String::from_utf8_lossy(&original.stderr)
            )
            .to_lowercase()
            .contains("gone"),
            "control must specifically fail on the removed group"
        );
        let projected = lab.project(&config);
        let result = check(&projected.config);
        assert!(
            result.status.success(),
            "{} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(projected.report.skipped_selector_count, 7);
    }
    #[test]
    fn respects_native_alias_precedence_without_allowing_an_alias_to_reactivate_a_rule() {
        let lab = Lab::new();
        let config = json!({"routing":{"rules":[
            {"domain":["geosite:gone"],"domains":["full:keep.example"],"outboundTag":"direct"},
            {"domain":["full:keep.example"],"domains":["geosite:gone"],"outboundTag":"direct"},
            {"domains":["full:keep.example"],"ip":["geoip:gone"],"outboundTag":"block"},
            {"sourceIP":["127.0.0.0/8"],"source":["ext:unreadable.dat:gone"],"outboundTag":"direct"}]},
            "dns":{"servers":[{"address":"192.0.2.53","expectedIPs":["192.0.2.0/24"],"expectIPs":["ext:unreadable.dat:gone"]}]}});
        let p = lab.project(&config);
        assert!(p.config["routing"]["rules"][0].get("domain").is_none());
        assert_eq!(
            p.config["routing"]["rules"][0]["domains"],
            json!(["full:keep.example"])
        );
        for i in 1..3 {
            assert_eq!(p.config["routing"]["rules"][i]["domain"], json!([NEVER]));
            assert!(p.config["routing"]["rules"][i].get("domains").is_none());
        }
        assert_eq!(
            p.config["routing"]["rules"][3],
            config["routing"]["rules"][3]
        );
        assert_eq!(p.config["dns"], config["dns"]);
        assert!(!uses_resources(&config, &["unreadable.dat".into()]));
    }
    #[test]
    fn pruning_an_authoritative_condition_cannot_reactivate_an_ignored_alias() {
        let lab = Lab::new();
        let config = json!({"routing":{"rules":[{
            "sourceIP":["geoip:gone"],"source":["ext:unreadable.dat:gone"],
            "outboundTag":"direct"
        }]},"dns":{"servers":[{
            "address":"192.0.2.53","expectedIPs":["geoip:gone"],
            "expectIPs":["ext:unreadable.dat:gone"]
        }]}});
        let projected = lab.project(&config);
        let rule = &projected.config["routing"]["rules"][0];
        assert_eq!(rule["domain"], json!([NEVER]));
        assert!(rule.get("sourceIP").is_none());
        assert!(
            rule.get("source").is_none(),
            "the ignored source must stay inactive"
        );
        let server = &projected.config["dns"]["servers"][0];
        assert_eq!(server["domains"], json!([NEVER]));
        assert_eq!(server["skipFallback"], true);
        assert!(server.get("expectedIPs").is_none());
        assert!(
            server.get("expectIPs").is_none(),
            "the ignored answer filter must stay inactive"
        );
        assert_eq!(projected.report.skipped_selector_count, 2);
        assert_eq!(
            config["routing"]["rules"][0]["sourceIP"],
            json!(["geoip:gone"])
        );
        assert_eq!(
            config["dns"]["servers"][0]["expectedIPs"],
            json!(["geoip:gone"])
        );
    }
    #[test]
    fn unicode_group_codes_follow_simple_uppercase_mapping() {
        let lab = Lab::new();
        lab.write("geosite", "STRAßE");
        let config =
            json!({"routing":{"rules":[{"domain":["geosite:straße"],"outboundTag":"direct"}]}});
        assert_eq!(lab.project(&config).config, config);
    }
    #[test]
    fn dns_constraints_do_not_turn_into_unrestricted_fallbacks() {
        let lab = Lab::new();
        let config = json!({"dns":{"hosts":{"geosite:gone":"192.0.2.1","full:local.example":"127.0.0.1"},"servers":[
            {"address":"192.0.2.53","domains":["geosite:gone"]},
            {"address":"192.0.2.54","domains":["geosite:keep"],"expectIPs":["geoip:gone"]},
            {"address":"192.0.2.55","unexpectedIPs":["geoip:gone","geoip:keep"]},
            {"address":"192.0.2.56","domains":["geosite:gone","geosite:keep"]},"localhost"]}});
        let p = lab.project(&config);
        assert!(p.config["dns"]["hosts"].get("geosite:gone").is_none());
        assert_eq!(p.config["dns"]["hosts"]["full:local.example"], "127.0.0.1");
        for index in 0..3 {
            assert_eq!(p.config["dns"]["servers"][index]["skipFallback"], true);
            assert_eq!(p.config["dns"]["servers"][index]["domains"], json!([NEVER]));
        }
        assert_eq!(
            p.config["dns"]["servers"][3]["domains"],
            json!(["geosite:keep"])
        );
        assert_eq!(p.config["dns"]["servers"][4], "localhost");
    }
    #[test]
    fn preserves_originals_and_recovers_automatically_when_groups_return() {
        let lab = Lab::new();
        let mut cache = Catalogues::default();
        let config =
            json!({"routing":{"rules":[{"domain":["geosite:back"],"outboundTag":"direct"}]}});
        assert_eq!(
            cache
                .project(&lab.0, &config, 0)
                .unwrap()
                .report
                .skipped_selector_count,
            1
        );
        lab.write("geosite", "BACK");
        let p = cache.project(&lab.0, &config, 1).unwrap();
        assert_eq!(p.report.skipped_selector_count, 0);
        assert_eq!(p.config, config);
        lab.write("geosite", "KEEP");
        assert_eq!(
            cache
                .project(&lab.0, &config, 2)
                .unwrap()
                .report
                .skipped_selector_count,
            1
        );
    }
    #[test]
    fn unreadable_or_corrupt_data_and_malformed_expressions_are_not_silenced() {
        let lab = Lab::new();
        let config = json!({"routing":{"rules":[{"domain":["ext:absent.dat:KEEP"]}]}});
        assert!(Catalogues::default().project(&lab.0, &config, 0).is_err());
        fs::write(lab.0.join("geosite.dat"), b"broken").unwrap();
        assert!(Catalogues::default()
            .project(
                &lab.0,
                &json!({"routing":{"rules":[{"domain":["geosite:KEEP"]}]}}),
                0
            )
            .is_err());
        for text in [
            "geosite:",
            "geosite:KEEP@",
            "geosite:KEEP@@cn",
            "ext:../private.dat:KEEP",
        ] {
            assert!(reference(text, "geosite").is_none());
        }
    }
    #[test]
    fn only_actual_matchers_change_and_warning_details_are_bounded() {
        let lab = Lab::new();
        let plain = json!({"outbounds":[{"tag":"geosite:gone","settings":{"password":"geoip:gone"}}],"dns":{"servers":["localhost"]}});
        assert_eq!(lab.project(&plain).config, plain);
        let config = json!({"routing":{"rules":[{"domain":(0..150).map(|i|format!("ext-domain:geosite.dat:gone{i}@cn")).collect::<Vec<_>>(),"outboundTag":"block"}]}});
        let p = lab.project(&config);
        assert_eq!(p.report.skipped_selector_count, 150);
        assert_eq!(p.report.skipped_selectors.len(), 100);
        assert!(!uses_resources(&plain, &["geosite.dat".into()]));
        assert!(uses_resources(
            &json!({"routing":{"rules":[{"source":["!!ext-ip:geoip.dat:!gone"]}]}}),
            &["geoip.dat".into()]
        ));
        assert!(uses_resources(&config, &["geosite.dat".into()]));
    }
}
