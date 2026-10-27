//! Resolve endpoint names before capture. Windows owns the asynchronous DNS
//! queries: timeout/error cancels and drains them instead of leaking threads.
use super::invalid;
use crate::native::{self, Handle};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    ptr,
    time::{Duration, Instant},
};
use wayrill_protocol::{ApiError, Result};
use windows_sys::Win32::{
    Foundation::*,
    Networking::WinSock::*,
    System::{Threading::*, IO::OVERLAPPED},
};

const LIMIT: usize = 1024;
const CONCURRENT: usize = 4;
const BUDGET: Duration = Duration::from_secs(12);
fn unavailable(message: impl Into<String>) -> ApiError {
    let mut error = ApiError::new("TUN_BOOTSTRAP_UNAVAILABLE", message);
    error.retryable = true;
    error
}

fn host(value: &str) -> Option<String> {
    let host = if value.contains("://") {
        url::Url::parse(value)
            .ok()?
            .host_str()?
            .trim_matches(['[', ']'])
            .to_string()
    } else if value.parse::<IpAddr>().is_ok() {
        return None;
    } else if let Ok(endpoint) = value.parse::<std::net::SocketAddr>() {
        return host(&endpoint.ip().to_string());
    } else {
        value
            .split_once(':')
            .map_or(value, |(name, _)| name)
            .to_string()
    };
    if host.is_empty()
        || host.parse::<IpAddr>().is_ok()
        || host
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "[]/\\".contains(c))
    {
        None
    } else {
        Some(host.to_lowercase())
    }
}

fn addresses(value: &Value, names: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if ["address", "endpoint"].contains(&key.as_str()) {
                    if let Some(name) = value.as_str().and_then(host) {
                        names.insert(name);
                    }
                }
                addresses(value, names);
            }
        }
        Value::Array(array) => {
            for value in array {
                addresses(value, names);
            }
        }
        _ => {}
    }
}

struct Winsock;
impl Winsock {
    fn start() -> Result<Self> {
        let mut data = WSADATA::default();
        let code = unsafe { WSAStartup(0x202, &mut data) };
        if code != 0 {
            return Err(ApiError::io(
                "Initialize TUN bootstrap resolver",
                std::io::Error::from_raw_os_error(code),
            ));
        }
        Ok(Self)
    }
}
impl Drop for Winsock {
    fn drop(&mut self) {
        unsafe {
            WSACleanup();
        }
    }
}

// Boxed storage is stable for the entire pending operation, including cleanup.
struct Query {
    name: Vec<u16>,
    hints: ADDRINFOEXW,
    overlapped: OVERLAPPED,
    event: Handle,
    cancel: HANDLE,
    result: *mut ADDRINFOEXW,
    pending: bool,
}
impl Query {
    fn start(name: &str) -> Result<Box<Self>> {
        let event = Handle(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) });
        if event.0.is_null() {
            return Err(native::os_error("Create TUN bootstrap event"));
        }
        let mut query = Box::new(Self {
            name: native::wide(name),
            hints: ADDRINFOEXW::default(),
            overlapped: OVERLAPPED {
                hEvent: event.0,
                ..Default::default()
            },
            event,
            cancel: ptr::null_mut(),
            result: ptr::null_mut(),
            pending: false,
        });
        query.hints.ai_family = AF_UNSPEC as i32;
        query.hints.ai_socktype = SOCK_STREAM;
        let code = unsafe {
            GetAddrInfoExW(
                query.name.as_ptr(),
                ptr::null(),
                NS_DNS,
                ptr::null(),
                &query.hints,
                &mut query.result,
                ptr::null(),
                &query.overlapped,
                None,
                &mut query.cancel,
            )
        };
        query.pending = code == WSA_IO_PENDING;
        if code != 0 && !query.pending {
            return Err(unavailable(format!("Cannot resolve server '{name}' before TUN activation ({code}). Supply its bootstrap IP in DNS hosts.")));
        }
        Ok(query)
    }
    fn ready(&mut self) -> Result<bool> {
        if !self.pending {
            return Ok(true);
        }
        match unsafe { WaitForSingleObject(self.event.0, 0) } {
            WAIT_TIMEOUT => Ok(false),
            WAIT_OBJECT_0 => {
                self.pending = false;
                let code = unsafe { GetAddrInfoExOverlappedResult(&self.overlapped) };
                if code != 0 {
                    return Err(unavailable(format!("Cannot resolve server '{}' before TUN activation ({code}). Supply its bootstrap IP in DNS hosts.", String::from_utf16_lossy(&self.name[..self.name.len()-1]))));
                }
                Ok(true)
            }
            _ => Err(native::os_error("Wait for TUN bootstrap")),
        }
    }
    fn ips(&self) -> Vec<String> {
        let mut ips = BTreeSet::new();
        let mut row = self.result;
        while !row.is_null() {
            // Windows provides the linked list; it is read only after completion.
            unsafe {
                let address = &*row;
                if !address.ai_addr.is_null() {
                    if address.ai_family == AF_INET as i32
                        && address.ai_addrlen >= std::mem::size_of::<SOCKADDR_IN>()
                    {
                        ips.insert(IpAddr::V4(Ipv4Addr::from(
                            (*address.ai_addr.cast::<SOCKADDR_IN>())
                                .sin_addr
                                .S_un
                                .S_addr
                                .to_ne_bytes(),
                        )));
                    } else if address.ai_family == AF_INET6 as i32
                        && address.ai_addrlen >= std::mem::size_of::<SOCKADDR_IN6>()
                    {
                        ips.insert(IpAddr::V6(Ipv6Addr::from(
                            (*address.ai_addr.cast::<SOCKADDR_IN6>()).sin6_addr.u.Byte,
                        )));
                    }
                }
                row = address.ai_next;
            }
        }
        ips.into_iter().map(|ip| ip.to_string()).collect()
    }
}
impl Drop for Query {
    fn drop(&mut self) {
        unsafe {
            if self.pending {
                GetAddrInfoExCancel(&self.cancel);
                // Cancellation completes asynchronously. Keep all buffers and
                // the event alive until Windows has stopped using them.
                WaitForSingleObject(self.event.0, INFINITE);
            }
            if !self.result.is_null() {
                FreeAddrInfoExW(self.result);
            }
        }
    }
}

fn resolve(names: BTreeSet<String>, budget: Duration) -> Result<BTreeMap<String, Vec<String>>> {
    let _winsock = Winsock::start()?;
    let deadline = Instant::now() + budget;
    let mut names = names.into_iter();
    let mut pending = Vec::new();
    let mut resolved = BTreeMap::new();
    loop {
        while pending.len() < CONCURRENT {
            let Some(name) = names.next() else {
                break;
            };
            let query = Query::start(&name)?;
            pending.push((name, query));
        }
        if pending.is_empty() {
            return Ok(resolved);
        }
        if Instant::now() >= deadline {
            return Err(unavailable(
                "TUN server bootstrap timed out. Supply bootstrap IPs in DNS hosts.",
            ));
        }
        let before = pending.len();
        let mut index = 0;
        while index < pending.len() {
            if pending[index].1.ready()? {
                let (name, query) = pending.swap_remove(index);
                let ips = query.ips();
                if ips.is_empty() {
                    return Err(unavailable(format!(
                        "Server '{name}' has no bootstrap addresses."
                    )));
                }
                resolved.insert(name, ips);
            } else {
                index += 1;
            }
        }
        if pending.len() != before {
            continue;
        }
        if !pending.is_empty() {
            let events: Vec<_> = pending.iter().map(|(_, query)| query.event.0).collect();
            let wait = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(u32::MAX as u128) as u32;
            if unsafe { WaitForMultipleObjects(events.len() as u32, events.as_ptr(), 0, wait) }
                == WAIT_FAILED
            {
                return Err(native::os_error("Wait for TUN bootstrap queries"));
            }
        }
    }
}

// Preserve configured static mappings instead of adding OS-resolved addresses
// alongside them. Do not reimplement Xray's RE2/geosite matcher in the service.
fn bootstrap_names(names: &mut BTreeSet<String>, hosts: &Value) -> Result<()> {
    let rules: Vec<_> = hosts
        .as_object()
        .into_iter()
        .flat_map(|hosts| hosts.keys())
        .map(|rule| rule.to_lowercase())
        .collect();
    names.retain(|name| {
        !rules.iter().any(|rule| {
            if let Some(value) = rule.strip_prefix("full:") {
                return name == value;
            }
            if let Some(value) = rule.strip_prefix("domain:") {
                return name == value
                    || name
                        .strip_suffix(value)
                        .is_some_and(|prefix| prefix.ends_with('.'));
            }
            if let Some(value) = rule.strip_prefix("keyword:") {
                return name.contains(value);
            }
            if let Some(value) = rule.strip_prefix("dotless:") {
                return !name.contains('.') && (value.is_empty() || name.contains(value));
            }
            name == rule
        })
    });
    if !names.is_empty()
        && rules.iter().any(|rule| {
            rule.starts_with("regexp:")
                || rule.starts_with("geosite:")
                || rule.starts_with("ext:")
                || rule.starts_with("ext-domain:")
                || rule.starts_with("ext-site:")
        })
    {
        return Err(invalid("TUN endpoint bootstrap with regexp/geosite DNS hosts needs explicit full:hostname mappings for peer and resolver names. This prevents changing your static host rules."));
    }
    Ok(())
}

pub(super) fn bootstrap(main: &mut Value) -> Result<()> {
    let mut names = BTreeSet::new();
    addresses(&main["outbounds"], &mut names);
    for server in main["dns"]["servers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|server| server.as_str().or_else(|| server["address"].as_str()))
        .filter(|address| !address.eq_ignore_ascii_case("fakedns"))
    {
        if let Some(name) = host(server) {
            names.insert(name);
        }
    }
    bootstrap_names(&mut names, &main["dns"]["hosts"])?;
    if names.len() > LIMIT {
        return Err(invalid("TUN bootstrap has more than 1,024 distinct server names. Use IP endpoints or explicit DNS hosts."));
    }
    if names.is_empty() {
        return Ok(());
    }
    let resolved = resolve(names, BUDGET)?;
    if !main["dns"].is_object() {
        main["dns"] = json!({});
    }
    if !main["dns"]["hosts"].is_object() {
        main["dns"]["hosts"] = json!({});
    }
    for (name, ips) in resolved {
        main["dns"]["hosts"][format!("full:{name}")] = json!(ips);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_names_include_single_labels_but_not_ipv6_literals() {
        for value in [
            "192.0.2.1",
            "::ffff:192.0.2.1",
            "[::ffff:192.0.2.1]:53",
            "https+local://[2001:db8::1]/dns-query",
            "\0host",
        ] {
            assert_eq!(host(value), None, "{value}");
        }
        assert_eq!(host("LOCALHOST"), Some("localhost".into()));
        assert_eq!(host("router:53"), Some("router".into()));
        assert_eq!(
            host("https+local://DNS.Example:443/dns-query"),
            Some("dns.example".into())
        );
    }
    #[test]
    fn explicit_hosts_avoid_network_and_input_is_unchanged_on_limit_error() {
        let mut main = json!({"outbounds":[{"settings":{"address":"private.example"}}],"dns":{"hosts":{"full:private.example":"192.0.2.1"},"servers":["1.1.1.1"]}});
        let original = main.clone();
        bootstrap(&mut main).unwrap();
        assert_eq!(main, original);
        main["outbounds"] = json!((0..LIMIT + 1)
            .map(|i| json!({"settings":{"address":format!("host{i}.invalid")}}))
            .collect::<Vec<_>>());
        let original = main.clone();
        assert!(bootstrap(&mut main).is_err());
        assert_eq!(main, original);
    }
    #[test]
    fn honors_static_hosts_without_merging_os_answers_or_guessing_re2_geo_rules() {
        for rule in ["full:PRIVATE.EXAMPLE", "domain:example", "keyword:private"] {
            let mut main = json!({"outbounds":[{"settings":{"address":"private.example"}}], "dns":{"hosts":{rule:"192.0.2.1"},"servers":["1.1.1.1"]}});
            let before = main.clone();
            bootstrap(&mut main).unwrap();
            assert_eq!(main, before);
        }
        let mut main = json!({"outbounds":[{"settings":{"address":"private.example"}}],"dns":{"hosts":{"regexp:.*":"192.0.2.1"},"servers":["1.1.1.1"]}});
        let before = main.clone();
        assert!(bootstrap(&mut main).is_err());
        assert_eq!(main, before);
        main["dns"]["hosts"]["full:private.example"] = json!("192.0.2.2");
        assert!(bootstrap(&mut main).is_ok());
        let mut names = BTreeSet::from(["notexample".to_string()]);
        bootstrap_names(&mut names, &json!({"domain:example":"192.0.2.1"})).unwrap();
        assert!(names.contains("notexample"));
    }
    #[test]
    fn native_queries_complete_and_repeated_timeout_cancels_cleanly() {
        let resolved = resolve(BTreeSet::from(["localhost".into()]), BUDGET).unwrap();
        assert!(resolved["localhost"]
            .iter()
            .any(|ip| ip.parse::<IpAddr>().unwrap().is_loopback()));
        for _ in 0..4 {
            assert!(resolve(
                BTreeSet::from(["bootstrap-cancel-test.invalid".into()]),
                Duration::ZERO
            )
            .is_err());
        }
        assert!(resolve(BTreeSet::from(["localhost".into()]), BUDGET).is_ok());
    }
    #[test]
    fn synthetic_dns_resolvers_are_not_bootstrapped_as_endpoint_names() {
        let mut c = json!({"outbounds":[],"dns":{"servers":["fakedns",{"address":"FakeDNS","domains":["domain:example.org"]},"tcp://192.0.2.53:53"]}});
        let original = c.clone();
        bootstrap(&mut c).unwrap();
        assert_eq!(c, original);
        // An actual outbound peer with this single-label name is still real.
        let mut peers = BTreeSet::new();
        addresses(&json!([{"settings":{"address":"fakedns"}}]), &mut peers);
        assert!(peers.contains("fakedns"));
    }
}
