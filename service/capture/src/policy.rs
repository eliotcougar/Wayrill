// SPDX-License-Identifier: GPL-3.0-only
use crate::{packet::Flow, text, Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

fn yes() -> bool {
    true
}
fn name_mode() -> String {
    "name".into()
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selector {
    pub kind: String,
    pub value: String,
    #[serde(default = "name_mode")]
    pub mode: String,
    #[serde(default)]
    pub children: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}
impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub tag: String,
    pub selectors: Vec<Selector>,
    pub ports: String,
    pub networks: Vec<String>,
    pub endpoint: Endpoint,
    pub predicates: Vec<Vec<Selector>>,
    pub masks: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterfaceItem {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "yes")]
    pub monitored: bool,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterfaceOptions {
    #[serde(default = "yes")]
    pub monitor_new_interfaces: bool,
    #[serde(default)]
    pub interfaces: Vec<InterfaceItem>,
}
impl Default for InterfaceOptions {
    fn default() -> Self {
        Self {
            monitor_new_interfaces: true,
            interfaces: Vec::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub inputs: Vec<Input>,
    pub interfaces: InterfaceOptions,
    #[serde(default = "yes")]
    pub bypass_local_traffic: bool,
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub name: String,
    pub path: Option<String>,
    pub package: Option<String>,
}
impl Identity {
    pub fn new(name: &str, path: Option<&str>, package: Option<&str>) -> Self {
        Self {
            name: text::stem(name).into(),
            path: path.map(|p| p.replace('\\', "/")),
            package: package.map(str::to_owned),
        }
    }
}
#[derive(Debug)]
struct Row {
    kind: String,
    mode: String,
    children: bool,
    value: String,
    name: String,
}
impl Row {
    fn from(selector: &Selector) -> Result<Self> {
        if !matches!(selector.kind.as_str(), "process" | "service" | "package") {
            return Err(Error::invalid("Unknown selector."));
        }
        if !matches!(selector.mode.as_str(), "name" | "path" | "folder") {
            return Err(Error::invalid("Unknown process mode."));
        }
        let mut value = selector.value.trim().trim_matches('"').replace('\\', "/");
        if selector.kind == "process" {
            if selector.mode == "name" {
                value = text::filename(&value).into();
            } else if selector.mode == "folder" && !value.ends_with('/') {
                if value
                    .get(value.len().saturating_sub(4)..)
                    .is_some_and(|s| s.eq_ignore_ascii_case(".exe"))
                {
                    value.truncate(value.rfind('/').map(|i| i + 1).unwrap_or(0));
                } else {
                    value.push('/');
                }
            }
        }
        Ok(Self {
            name: text::stem(&value).into(),
            value,
            kind: selector.kind.clone(),
            mode: selector.mode.clone(),
            children: selector.children,
        })
    }
    fn matches(&self, lineage: &[Identity], service: Option<&str>) -> bool {
        if self.kind == "service" {
            return service.is_some_and(|s| text::equal(s, &self.value));
        }
        lineage
            .iter()
            .take(if self.children { lineage.len() } else { 1 })
            .any(|p| {
                if self.kind == "package" {
                    return p
                        .package
                        .as_deref()
                        .is_some_and(|s| text::equal(s, &self.value));
                }
                match self.mode.as_str() {
                    "folder" => p
                        .path
                        .as_deref()
                        .is_some_and(|s| text::starts_with(s, &self.value)),
                    "path" => p
                        .path
                        .as_deref()
                        .is_some_and(|s| text::equal(s, &self.value)),
                    _ => text::equal(&p.name, &self.name),
                }
            })
    }
    fn needs_path(&self, name: &str, ancestor: bool) -> bool {
        self.kind == "process"
            && (!ancestor || self.children)
            && (self.mode == "folder"
                || self.mode == "path" && text::equal(text::filename(&self.value), name))
    }
}
#[derive(Debug)]
pub struct Ports {
    bits: Box<[u64; 1024]>,
    tcp: bool,
    udp: bool,
}
impl Ports {
    pub fn new(ports: &str, networks: &[String]) -> Result<Self> {
        let tcp = networks.iter().any(|n| n == "tcp");
        let udp = networks.iter().any(|n| n == "udp");
        if !(tcp || udp)
            || networks
                .iter()
                .any(|n| !matches!(n.as_str(), "tcp" | "udp"))
        {
            return Err(Error::invalid("Choose TCP and/or UDP."));
        }
        let mut result = Self {
            bits: Box::new([0; 1024]),
            tcp,
            udp,
        };
        let ports = if ports.trim().is_empty() {
            "1-65535"
        } else {
            ports
        };
        for range in ports.split(',') {
            let parts: Vec<_> = range.trim().split('-').collect();
            let invalid = || Error::invalid("Ports must be numbers or ranges between 1 and 65535.");
            if parts.len() > 2 {
                return Err(invalid());
            }
            let first: u16 = parts[0].trim().parse().map_err(|_| invalid())?;
            let last: u16 = parts
                .last()
                .unwrap()
                .trim()
                .parse()
                .map_err(|_| invalid())?;
            if first == 0 || first > last {
                return Err(invalid());
            }
            for port in first..=last {
                result.bits[usize::from(port) / 64] |= 1 << (port % 64);
            }
        }
        Ok(result)
    }
    pub fn matches(&self, flow: Flow) -> bool {
        (flow.protocol == 6 && self.tcp || flow.protocol == 17 && self.udp)
            && self.bits[usize::from(flow.remote_port) / 64] & (1 << (flow.remote_port % 64)) != 0
    }
}

#[derive(Debug)]
pub struct Target {
    pub id: String,
    pub endpoint: Option<Endpoint>,
    ports: Option<Arc<Ports>>,
    candidates: Vec<Arc<Target>>,
}
impl Target {
    pub fn for_flow(self: &Arc<Self>, flow: Flow) -> Option<Arc<Self>> {
        if !self.candidates.is_empty() {
            return self
                .candidates
                .iter()
                .find(|t| t.ports.as_ref().unwrap().matches(flow))
                .cloned();
        }
        if self.ports.as_ref().is_none_or(|p| p.matches(flow)) {
            Some(self.clone())
        } else {
            None
        }
    }
}
struct Branch {
    input: Input,
    selectors: Vec<Row>,
    predicates: Vec<Vec<Row>>,
    masks: HashSet<String>,
    ports: Arc<Ports>,
}
pub struct SharedPolicy {
    branches: Vec<Branch>,
    targets: Mutex<HashMap<String, Arc<Target>>>,
    pub has_packages: bool,
    pub packages_include_children: bool,
    pub service_names: Vec<String>,
}
fn rows(selectors: &[Selector]) -> Result<Vec<Row>> {
    selectors
        .iter()
        .filter(|s| s.enabled)
        .map(Row::from)
        .collect()
}
fn profile_mask(matches: impl Iterator<Item = bool>, width: usize) -> String {
    let mut mask = vec![0u8; width];
    for (i, matched) in matches.enumerate() {
        if matched {
            let pos = mask.len() - 1 - i / 4;
            mask[pos] |= 1 << (i % 4);
        }
    }
    mask.into_iter()
        .map(|n| char::from(b"0123456789abcdef"[usize::from(n)]))
        .collect()
}
/// Evaluate supplied identities with the same matcher used by live capture.
/// This operation does not start observation or claim ownership of real flows.
pub fn evaluate(value: &serde_json::Value) -> Result<serde_json::Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Person {
        name: String,
        path: Option<String>,
        package: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Evaluation {
        predicates: Vec<Vec<Selector>>,
        lineage: Vec<Person>,
        service: Option<String>,
        #[serde(rename = "maskCount")]
        mask_count: usize,
        #[serde(rename = "maskWidth")]
        mask_width: usize,
    }
    let input: Evaluation = serde_json::from_value(value.clone())?;
    if input.predicates.len() > 32768
        || input.lineage.len() > 64
        || input.predicates.iter().map(Vec::len).sum::<usize>() > 32768
    {
        return Err(Error::invalid("Application diagnostic exceeds its limit."));
    }
    let lineage = input
        .lineage
        .iter()
        .map(|p| Identity::new(&p.name, p.path.as_deref(), p.package.as_deref()))
        .collect::<Vec<_>>();
    let matches = input
        .predicates
        .iter()
        .map(|p| {
            Ok(rows(p)?
                .iter()
                .any(|r| r.matches(&lineage, input.service.as_deref())))
        })
        .collect::<Result<Vec<bool>>>()?;
    if input.mask_count > matches.len()
        || input.mask_width < input.mask_count.div_ceil(4).max(1)
        || input.mask_width > 8192
    {
        return Err(Error::invalid("Invalid application diagnostic mask."));
    }
    Ok(
        serde_json::json!({"mask":profile_mask(matches.iter().take(input.mask_count).copied(), input.mask_width),"matches":matches}),
    )
}
impl SharedPolicy {
    pub fn new(plan: Plan) -> Result<Self> {
        let mut branches = Vec::new();
        for input in plan.inputs {
            if input.masks.is_empty() {
                return Err(Error::invalid(
                    "Capture requires compiled identity metadata.",
                ));
            }
            let ports = Arc::new(Ports::new(&input.ports, &input.networks)?);
            let selectors = rows(&input.selectors)?;
            let predicates = input
                .predicates
                .iter()
                .map(|p| rows(p))
                .collect::<Result<Vec<_>>>()?;
            let masks = input.masks.iter().cloned().collect();
            branches.push(Branch {
                input,
                selectors,
                predicates,
                masks,
                ports,
            });
        }
        let all = branches
            .iter()
            .flat_map(|b| b.selectors.iter().chain(b.predicates.iter().flatten()));
        let (mut has_packages, mut packages_include_children, mut service_names) =
            (false, false, Vec::new());
        for row in all {
            if row.kind == "package" {
                has_packages = true;
                packages_include_children |= row.children;
            }
            if row.kind == "service"
                && !service_names
                    .iter()
                    .any(|s: &String| text::equal(s, &row.value))
            {
                service_names.push(row.value.clone());
            }
        }
        Ok(Self {
            branches,
            targets: Mutex::new(HashMap::new()),
            has_packages,
            packages_include_children,
            service_names,
        })
    }
    pub fn needs_path(&self, name: &str, ancestor: bool) -> bool {
        self.branches
            .iter()
            .flat_map(|b| b.selectors.iter().chain(b.predicates.iter().flatten()))
            .any(|r| r.needs_path(name, ancestor))
    }
    pub fn select(
        &self,
        lineage: &[Identity],
        service: Option<&str>,
    ) -> Result<Option<Arc<Target>>> {
        let mut selected = Vec::new();
        for (index, b) in self.branches.iter().enumerate() {
            if !b.selectors.is_empty() && !b.selectors.iter().any(|r| r.matches(lineage, service)) {
                continue;
            }
            let profile = profile_mask(
                b.predicates
                    .iter()
                    .map(|p| p.iter().any(|r| r.matches(lineage, service))),
                b.predicates.len().div_ceil(4).max(1),
            );
            if !b.masks.contains(&profile) {
                return Err(Error::invalid(
                    "A Windows process identity is absent from its compiled profiles.",
                ));
            }
            let key = format!("input:{index}:{profile}");
            // Packet/reply eligibility also reads this cache. Keep selector
            // matching (including Windows Unicode calls) outside its lock.
            let mut targets = self
                .targets
                .lock()
                .map_err(|_| Error::invalid("Capture policy target cache poisoned."))?;
            let target = targets.entry(key.clone()).or_insert_with(|| {
                let mut endpoint = b.input.endpoint.clone();
                endpoint.username = format!("wr-{profile}-{}", endpoint.username);
                Arc::new(Target {
                    id: key,
                    endpoint: Some(endpoint),
                    ports: Some(b.ports.clone()),
                    candidates: Vec::new(),
                })
            });
            selected.push(target.clone());
        }
        if selected.is_empty() {
            return Ok(None);
        }
        if selected.len() == 1 {
            return Ok(selected.pop());
        }
        let key = format!(
            "flow:{}",
            selected
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>()
                .join(",")
        );
        // A combination is temporary ownership-snapshot data. Its concrete
        // candidates retain stable cached identities; caching every combination
        // would accumulate their Cartesian product for the entire policy life.
        Ok(Some(Arc::new(Target {
            id: key,
            endpoint: None,
            ports: None,
            candidates: selected,
        })))
    }
    pub fn retains(&self, target: &Arc<Target>) -> bool {
        self.targets.lock().is_ok_and(|targets| {
            targets
                .get(&target.id)
                .is_some_and(|current| Arc::ptr_eq(current, target))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supplied_application_diagnostics_share_child_service_and_package_matching() {
        let selector = |kind: &str, value: &str, mode: &str, children: bool| serde_json::json!({"kind":kind,"value":value,"mode":mode,"children":children});
        let result=evaluate(&serde_json::json!({"predicates":[[selector("process","parent.exe","name",true)],[selector("process","parent.exe","name",false)],[selector("package","package.name","name",false)],[selector("service","DnsService","name",false)],[selector("process","C:\\Apps\\","folder",false)]],"lineage":[{"name":"child.exe","path":"C:\\Apps\\child.exe","package":"package.name"},{"name":"parent.exe","path":null,"package":null}],"service":"dnsservice","maskCount":5,"maskWidth":2})).unwrap();
        assert_eq!(
            result["matches"],
            serde_json::json!([true, false, true, true, true])
        );
        assert_eq!(result["mask"], "1d");
        assert!(evaluate(&serde_json::json!({"predicates":[],"lineage":[],"service":null,"maskCount":1,"maskWidth":1})).is_err());
    }
    #[test]
    fn composite_profiles_do_not_accumulate_in_the_policy_cache() {
        let inputs = (0..4)
            .map(|branch| Input {
                tag: format!("input-{branch}"),
                selectors: vec![],
                ports: String::new(),
                networks: vec!["tcp".into()],
                endpoint: Endpoint {
                    port: 1234,
                    username: "fixture".into(),
                    password: "secret".into(),
                },
                predicates: (0..2)
                    .map(|bit| {
                        vec![Selector {
                            kind: "process".into(),
                            value: format!("flag-{branch}-{bit}"),
                            mode: "name".into(),
                            children: true,
                            enabled: true,
                        }]
                    })
                    .collect(),
                masks: (0..4).map(|mask| format!("{mask:x}")).collect(),
            })
            .collect();
        let policy = SharedPolicy::new(Plan {
            inputs,
            interfaces: InterfaceOptions::default(),
            bypass_local_traffic: true,
        })
        .unwrap();
        for mask in 0u16..256 {
            let lineage = (0..8)
                .filter(|bit| mask & (1 << bit) != 0)
                .map(|bit| Identity::new(&format!("flag-{}-{}", bit / 2, bit % 2), None, Some("")))
                .collect::<Vec<_>>();
            let target = policy.select(&lineage, None).unwrap().unwrap();
            assert_eq!(target.candidates.len(), 4);
            for candidate in &target.candidates {
                assert!(policy.retains(candidate));
            }
        }
        assert_eq!(policy.targets.lock().unwrap().len(), 16);
    }
}
