//! Read-only, paged DAT browsing. Parsing/search run on one lazy worker, never
//! under the networking coordinator lock. One indexed file and eight page results.
mod ip;
use crate::resources::{fields, validate_dat, MAX};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::Read,
    net::{Ipv4Addr, Ipv6Addr},
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::UNIX_EPOCH,
};
use wayrill_protocol::{ApiError, Result};

fn invalid(message: &str) -> ApiError {
    ApiError::new("RESOURCE_INVALID", message)
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub file: String,
    pub kind: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub attributes: Vec<String>,
    #[serde(default)]
    pub inverse: bool,
    #[serde(default)]
    pub cidr: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_size")]
    pub limit: usize,
}
fn page_size() -> usize {
    100
}
impl Query {
    pub fn validate(&self) -> Result<()> {
        if !crate::resources::valid_name(&self.file)
            || !["geosite", "geoip"].contains(&self.kind.as_str())
            || self.group.len() > 128
            || self.attributes.len() > 256
            || self
                .attributes
                .iter()
                .any(|a| a.is_empty() || a.len() > 128 || a.contains(['@', ':', '\n', '\r', '\0']))
            || self.cidr.len() > 256
            || self.query.len() > 256
            || self.offset > 4_000_000
            || !(1..=100).contains(&self.limit)
            || (self.group.is_empty() && !self.attributes.is_empty())
            || (self.kind == "geoip" && !self.attributes.is_empty())
            || (self.kind == "geosite" && (self.inverse || !self.cidr.is_empty()))
            || (!self.cidr.is_empty() && !self.group.is_empty())
            || (self.inverse && self.group.is_empty() && self.cidr.is_empty())
        {
            return Err(invalid("Invalid resource browser request."));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    file: String,
    kind: String,
    bytes: u64,
    modified: u128,
    generation: u64,
}
fn stamp(root: &Path, q: &Query, generation: u64) -> Result<Stamp> {
    if !q.cidr.is_empty() {
        return Ok(Stamp {
            file: String::new(),
            kind: q.kind.clone(),
            bytes: 0,
            modified: 0,
            generation: 0,
        });
    }
    let m = fs::symlink_metadata(root.join(&q.file)).map_err(|_| {
        invalid("This resource file is not installed. Update it in Resource files.")
    })?;
    if !m.is_file() || m.file_attributes() & 0x400 != 0 || m.len() == 0 || m.len() > MAX as u64 {
        return Err(invalid(
            "Resource files must be regular DAT files, at most 128 MiB.",
        ));
    }
    Ok(Stamp {
        file: q.file.clone(),
        kind: q.kind.clone(),
        bytes: m.len(),
        modified: m
            .modified()
            .map_err(|_| invalid("Cannot inspect resource file."))?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        generation,
    })
}
struct Group {
    records: Vec<(u32, u32)>,
    attributes: BTreeSet<String>,
}
struct Index {
    data: Vec<u8>,
    groups: BTreeMap<String, Group>,
    stamp: Stamp,
}
fn text(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| invalid("Invalid UTF-8 in resource data."))
}
fn attributes(record: &[u8]) -> Result<BTreeSet<String>> {
    let mut result = BTreeSet::new();
    for field in fields(record) {
        let (n, w, data, _) = field?;
        if n != 3 {
            continue;
        }
        if w != 2 {
            return Err(invalid("Invalid GeoSite attribute."));
        }
        let mut name = None;
        for f in fields(data) {
            let (n, w, key, _) = f?;
            if n == 1 {
                let key = text(key)?;
                if w != 2
                    || key.is_empty()
                    || key.len() > 128
                    || key.contains(['@', ':', '\n', '\r'])
                {
                    return Err(invalid("Invalid GeoSite attribute name."));
                }
                name = Some(key.to_owned());
            }
        }
        if let Some(name) = name {
            result.insert(name);
        }
    }
    Ok(result)
}
fn record_value<'a>(record: &'a [u8], kind: &str) -> Result<(&'a [u8], u64)> {
    let mut value = &[][..];
    let mut number = 0;
    for f in fields(record) {
        let (n, w, bytes, v) = f?;
        if (kind == "geoip" && n == 1 && w == 2) || (kind == "geosite" && n == 2 && w == 2) {
            value = bytes;
        }
        if (kind == "geoip" && n == 2 && w == 0) || (kind == "geosite" && n == 1 && w == 0) {
            number = v;
        }
    }
    Ok((value, number))
}
impl Index {
    fn load(root: &Path, q: &Query, key: Stamp, stop: &AtomicBool) -> Result<Self> {
        let mut data = Vec::new();
        File::open(root.join(&q.file))
            .map_err(|_| invalid("Cannot read resource file."))?
            .take(MAX as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|_| invalid("Cannot read resource file."))?;
        if stamp(root, q, key.generation)? != key {
            return Err(ApiError::new(
                "RESOURCE_CHANGED",
                "Resource data changed. Retry the browser request.",
            ));
        }
        validate_dat(&data, &q.kind)?;
        let mut groups = BTreeMap::new();
        let mut count = 0usize;
        for field in fields(&data) {
            let (n, w, entry, _) = field?;
            if n != 1 || w != 2 {
                continue;
            }
            if stop.load(Ordering::Relaxed) {
                return Err(invalid("Resource browsing stopped."));
            }
            let mut code = String::new();
            let mut group = Group {
                records: Vec::new(),
                attributes: BTreeSet::new(),
            };
            for f in fields(entry) {
                let (n, w, record, _) = f?;
                match (n, w) {
                    (1, 2) => code = text(record)?.to_ascii_lowercase(),
                    (2, 2) => {
                        count += 1;
                        if count > 4_000_000 {
                            return Err(invalid("Resource dataset has too many records."));
                        }
                        if count.is_multiple_of(1024) && stop.load(Ordering::Relaxed) {
                            return Err(invalid("Resource browsing stopped."));
                        }
                        group.records.push((
                            (record.as_ptr() as usize - data.as_ptr() as usize) as u32,
                            record.len() as u32,
                        ));
                        if q.kind == "geosite" {
                            group.attributes.extend(attributes(record)?)
                        }
                        if group.attributes.len() > 256 {
                            return Err(invalid("Resource group has too many attribute names."));
                        }
                    }
                    _ => {}
                }
            }
            if code.is_empty()
                || code.contains(['@', ':', '\n', '\r'])
                || groups.insert(code, group).is_some()
                || groups.len() > 65536
            {
                return Err(invalid(
                    "Resource dataset contains invalid or duplicate group names.",
                ));
            }
        }
        Ok(Self {
            data,
            groups,
            stamp: key,
        })
    }
    fn record(&self, range: (u32, u32)) -> &[u8] {
        &self.data[range.0 as usize..range.0 as usize + range.1 as usize]
    }
    fn entry(&self, record: &[u8], kind: &str) -> Result<String> {
        let (value, number) = record_value(record, kind)?;
        if kind == "geosite" {
            let prefix = match number {
                0 => "keyword",
                1 => "regexp",
                2 => "domain",
                3 => "full",
                _ => return Err(invalid("Unknown GeoSite match type.")),
            };
            Ok(format!("{prefix}:{}", text(value)?))
        } else {
            let address = match value.len() {
                4 => Ipv4Addr::from(<[u8; 4]>::try_from(value).unwrap()).to_string(),
                16 => Ipv6Addr::from(<[u8; 16]>::try_from(value).unwrap()).to_string(),
                _ => return Err(invalid("Invalid GeoIP address.")),
            };
            if number > if value.len() == 4 { 32 } else { 128 } {
                return Err(invalid("Invalid GeoIP prefix."));
            }
            Ok(format!("{address}/{number}"))
        }
    }
    fn page(&self, q: &Query, stop: &AtomicBool) -> Result<Value> {
        let needle = q.query.to_lowercase();
        let mut rows = Vec::new();
        let mut total = 0;
        let group = if q.group.is_empty() {
            None
        } else {
            Some(
                self.groups
                    .get(&q.group.to_ascii_lowercase())
                    .ok_or_else(|| invalid("This group is no longer in the selected file."))?,
            )
        };
        if let Some(g) = group {
            if q.kind == "geoip" {
                let mut prefixes = Vec::with_capacity(g.records.len());
                for (i, range) in g.records.iter().enumerate() {
                    if i % 1024 == 0 && stop.load(Ordering::Relaxed) {
                        return Err(invalid("Resource browsing stopped."));
                    }
                    let (bytes, bits) = record_value(self.record(*range), "geoip")?;
                    prefixes.push(ip::Prefix::from_bytes(bytes, bits)?);
                }
                let mut page = ip::page(&prefixes, q, stop)?;
                page["version"] = json!(format!(
                    "{}:{}:{}",
                    self.stamp.bytes, self.stamp.modified, self.stamp.generation
                ));
                page["group"] =
                    json!({"count":g.records.len(),"attributes":[],"inverse":q.inverse});
                return Ok(page);
            }
            let required: Vec<_> = q.attributes.iter().map(|a| a.to_lowercase()).collect();
            for (i, range) in g.records.iter().enumerate() {
                if i % 1024 == 0 && stop.load(Ordering::Relaxed) {
                    return Err(invalid("Resource browsing stopped."));
                }
                let record = self.record(*range);
                if !required.is_empty() {
                    let present = attributes(record)?;
                    if !required.iter().all(|a| present.contains(a)) {
                        continue;
                    }
                }
                let value = self.entry(record, &q.kind)?;
                if !needle.is_empty() && !value.to_lowercase().contains(&needle) {
                    continue;
                }
                if total >= q.offset && rows.len() < q.limit {
                    rows.push(json!({"value":if value.len()<=4096 {Some(&value)}else{None},"preview":value.chars().take(4096).collect::<String>()}));
                }
                total += 1;
            }
        } else {
            for (code, g) in &self.groups {
                if !code.to_lowercase().contains(&needle) {
                    continue;
                }
                if total >= q.offset && rows.len() < q.limit {
                    rows.push(json!({"code":code,"count":g.records.len()}))
                }
                total += 1;
            }
        }
        let key = &self.stamp;
        Ok(
            json!({"ready":true,"version":format!("{}:{}:{}",key.bytes,key.modified,key.generation),"total":total,"offset":q.offset,"limit":q.limit,"rows":rows,"group":group.map(|g|json!({"count":g.records.len(),"attributes":g.attributes,"inverse":q.inverse}))}),
        )
    }
}
type Cached = VecDeque<(Query, Stamp, Option<Result<Value>>)>;
pub struct Browser {
    root: PathBuf,
    cache: Arc<Mutex<Cached>>,
    stop: Arc<AtomicBool>,
    sender: Option<mpsc::SyncSender<(Query, Stamp)>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Browser {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            cache: Arc::new(Mutex::new(VecDeque::new())),
            stop: Arc::new(AtomicBool::new(false)),
            sender: None,
            worker: None,
        }
    }
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
    pub fn browse(&mut self, q: Query, generation: u64) -> Result<Value> {
        if self.stop.load(Ordering::Relaxed) {
            return Err(invalid("Resource browsing stopped."));
        }
        q.validate()?;
        let key = stamp(&self.root, &q, generation)?;
        {
            let cache = self.cache.lock().unwrap();
            if let Some((_, _, result)) = cache
                .iter()
                .find(|(request, k, _)| *request == q && *k == key)
            {
                return result.clone().unwrap_or_else(|| Ok(json!({"ready":false})));
            }
        }
        if self.sender.is_none() {
            let (sender, receiver) = mpsc::sync_channel::<(Query, Stamp)>(8);
            let cache = self.cache.clone();
            let stop = self.stop.clone();
            let root = self.root.clone();
            self.worker = Some(
                thread::Builder::new()
                    .name("wayrill-geodata".into())
                    .spawn(move || {
                        let mut index: Option<Index> = None;
                        while let Ok((q, key)) = receiver.recv() {
                            if stop.load(Ordering::Relaxed) {
                                break;
                            }
                            let result = (|| {
                                if !q.cidr.is_empty() {
                                    return ip::page(&[ip::Prefix::parse(&q.cidr)?], &q, &stop);
                                }
                                if index.as_ref().is_none_or(|i| i.stamp != key) {
                                    index = Some(Index::load(&root, &q, key.clone(), &stop)?)
                                }
                                index.as_ref().unwrap().page(&q, &stop)
                            })();
                            if let Some((_, _, slot)) = cache
                                .lock()
                                .unwrap()
                                .iter_mut()
                                .find(|(r, k, _)| *r == q && *k == key)
                            {
                                *slot = Some(result)
                            }
                        }
                    })
                    .map_err(|_| invalid("Cannot start the resource browser."))?,
            );
            self.sender = Some(sender);
        }
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= 8 {
            if let Some(i) = cache.iter().position(|(_, _, r)| r.is_some()) {
                cache.remove(i);
            } else {
                return Err(ApiError::new(
                    "BUSY",
                    "Resource browser is busy. Retry shortly.",
                ));
            }
        }
        cache.push_back((q.clone(), key.clone(), None));
        if self.sender.as_ref().unwrap().try_send((q, key)).is_err() {
            cache.pop_back();
            return Err(ApiError::new(
                "BUSY",
                "Resource browser is busy. Retry shortly.",
            ));
        }
        Ok(json!({"ready":false}))
    }
}
impl Drop for Browser {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn wire(n: u8, data: &[u8]) -> Vec<u8> {
        let mut result = vec![(n << 3) | 2];
        let mut size = data.len();
        loop {
            let b = (size & 127) as u8;
            size >>= 7;
            result.push(if size > 0 { b | 128 } else { b });
            if size == 0 {
                break;
            }
        }
        result.extend(data);
        result
    }
    fn domain(kind: u8, value: &str, attr: &str) -> Vec<u8> {
        let mut record = vec![8, kind];
        record.extend(wire(2, value.as_bytes()));
        if !attr.is_empty() {
            record.extend(wire(3, &wire(1, attr.as_bytes())))
        }
        record
    }
    fn dataset(kind: &str) -> Vec<u8> {
        let mut group = wire(1, b"TEST");
        if kind == "geosite" {
            for (kind, value, attr) in [
                (0, "contains", ""),
                (1, ".*\\.test$", ""),
                (2, "example.test", "cn"),
                (3, "host.test", "CN"),
            ] {
                let mut record = domain(kind, value, attr);
                if value == "example.test" {
                    record.extend(wire(3, &wire(1, b"ads")));
                }
                group.extend(wire(2, &record))
            }
        } else {
            let mut ip = wire(1, &[1, 2, 3, 4]);
            ip.extend([16, 24]);
            group.extend(wire(2, &ip));
            let mut ip = wire(1, &Ipv6Addr::LOCALHOST.octets());
            ip.extend([16, 128, 1]);
            group.extend(wire(2, &ip));
        }
        wire(1, &group)
    }
    pub(super) fn query(kind: &str) -> Query {
        Query {
            file: format!("{kind}.dat"),
            kind: kind.into(),
            group: String::new(),
            attributes: Vec::new(),
            inverse: false,
            cidr: String::new(),
            query: String::new(),
            offset: 0,
            limit: 100,
        }
    }
    fn index(kind: &str) -> Index {
        let data = dataset(kind);
        let root = std::env::temp_dir().join(format!(
            "wayrill-geo-{}-{}-{}",
            std::process::id(),
            kind,
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(format!("{kind}.dat")), data).unwrap();
        let q = query(kind);
        let result = Index::load(
            &root,
            &q,
            stamp(&root, &q, 0).unwrap(),
            &AtomicBool::new(false),
        )
        .unwrap();
        fs::remove_file(root.join(format!("{kind}.dat"))).unwrap();
        fs::remove_dir(root).unwrap();
        result
    }
    #[test]
    fn lists_groups_and_exact_domain_types_attributes_and_pages() {
        let i = index("geosite");
        let mut q = query("geosite");
        let stop = AtomicBool::new(false);
        assert_eq!(
            i.page(&q, &stop).unwrap()["rows"][0],
            json!({"code":"test","count":4})
        );
        q.group = "test".into();
        q.limit = 2;
        q.offset = 1;
        let page = i.page(&q, &stop).unwrap();
        assert_eq!(page["total"], 4);
        assert_eq!(page["rows"][0]["value"], "regexp:.*\\.test$");
        assert_eq!(page["group"]["attributes"], json!(["CN", "ads", "cn"]));
        q.offset = 0;
        q.attributes = vec!["CN".into(), "ads".into()];
        let page = i.page(&q, &stop).unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["rows"][0]["value"], "domain:example.test");
        q.query = "EXAMPLE".into();
        assert_eq!(i.page(&q, &stop).unwrap()["total"], 1);
        q.attributes = vec!["missing".into()];
        assert_eq!(i.page(&q, &stop).unwrap()["total"], 0);
        q.attributes = vec!["!cn".into()];
        assert_eq!(i.page(&q, &stop).unwrap()["total"], 0);
    }
    #[test]
    fn shows_ipv4_ipv6_and_reversed_ranges_without_mutating_data() {
        let i = index("geoip");
        let mut q = query("geoip");
        q.group = "test".into();
        let stop = AtomicBool::new(false);
        let page = i.page(&q, &stop).unwrap();
        assert_eq!(page["rows"][0]["value"], "1.2.3.0/24");
        assert_eq!(page["rows"][1]["value"], "::1/128");
        let bytes = i.data.clone();
        q.inverse = true;
        assert_eq!(i.page(&q, &stop).unwrap()["rows"][0]["value"], "0.0.0.0/8");
        assert_eq!(i.page(&q, &stop).unwrap()["total"], 152);
        assert_eq!(bytes, i.data);
    }
    #[test]
    fn bounds_input_and_rejects_paths_unknown_groups_and_bad_prefixes() {
        let i = index("geoip");
        let mut q = query("geoip");
        q.file = "../geoip.dat".into();
        assert!(q.validate().is_err());
        q = query("geoip");
        q.limit = 101;
        assert!(q.validate().is_err());
        q = query("geoip");
        q.group = "missing".into();
        assert!(i.page(&q, &AtomicBool::new(false)).is_err());
        let mut bad = wire(1, &[1, 2, 3, 4]);
        bad.extend([16, 250, 1]);
        assert!(i.entry(&bad, "geoip").is_err());
    }
    #[test]
    fn asynchronously_caches_pages_and_invalidates_on_file_generation() {
        let root = std::env::temp_dir().join(format!("wayrill-geo-cache-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("geosite.dat"), dataset("geosite")).unwrap();
        let mut browser = Browser::new(root.clone());
        let q = query("geosite");
        assert_eq!(browser.browse(q.clone(), 0).unwrap()["ready"], false);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let page = browser.browse(q.clone(), 0).unwrap();
            if page["ready"] == true {
                assert_eq!(page["total"], 1);
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(browser.browse(q, 1).unwrap()["ready"], false);
        browser.shutdown();
        fs::remove_file(root.join("geosite.dat")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
