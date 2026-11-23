//! Low-frequency uplink snapshots, independent of traffic volume. Reconnects
//! rebuild only runtime bindings; graph/profile and Windows sharing intent stay
//! unchanged. No NCSI probes, WLAN credentials or foreign adapter mutations.
use super::*;
use serde::Serialize;

const INTERVAL: Duration = Duration::from_secs(2);
const SETTLE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Link {
    id: String,
    name: String,
    index: u32,
    mtu: u32,
    network_id: String,
    dns_suffix: String,
    metrics: [u32; 2],
    ip_mtu: [u32; 2],
    addresses: BTreeSet<String>,
    dns: BTreeSet<String>,
    defaults: BTreeSet<String>,
}

fn ip(address: &SOCKADDR_INET) -> Option<IpAddr> {
    unsafe {
        match address.si_family {
            AF_INET => Some(IpAddr::V4(Ipv4Addr::from(
                address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes(),
            ))),
            AF_INET6 => Some(IpAddr::V6(Ipv6Addr::from(address.Ipv6.sin6_addr.u.Byte))),
            _ => None,
        }
    }
}
fn socket_ip(address: SOCKET_ADDRESS) -> Option<IpAddr> {
    if address.lpSockaddr.is_null() {
        return None;
    }
    // Windows owns this buffer; validate the family-specific size before read.
    unsafe {
        match (*address.lpSockaddr).sa_family {
            AF_INET if address.iSockaddrLength as usize >= std::mem::size_of::<SOCKADDR_IN>() => {
                Some(IpAddr::V4(Ipv4Addr::from(
                    (*address.lpSockaddr.cast::<SOCKADDR_IN>())
                        .sin_addr
                        .S_un
                        .S_addr
                        .to_ne_bytes(),
                )))
            }
            AF_INET6 if address.iSockaddrLength as usize >= std::mem::size_of::<SOCKADDR_IN6>() => {
                Some(IpAddr::V6(Ipv6Addr::from(
                    (*address.lpSockaddr.cast::<SOCKADDR_IN6>())
                        .sin6_addr
                        .u
                        .Byte,
                )))
            }
            _ => None,
        }
    }
}
fn guid_text(guid: GUID) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4[0],
        guid.data4[1],
        guid.data4[2..]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}
fn id(luid: NET_LUID_LH) -> Result<String> {
    let mut guid = GUID::default();
    let code = unsafe { ConvertInterfaceLuidToGuid(&luid, &mut guid) };
    if code != 0 {
        return Err(unavailable_uplink("The selected uplink disappeared."));
    }
    Ok(guid_text(guid))
}
fn luid(name: &str) -> Result<NET_LUID_LH> {
    let mut value = NET_LUID_LH::default();
    if unsafe { ConvertInterfaceAliasToLuid(native::wide(name).as_ptr(), &mut value) } != 0 {
        return Err(unavailable_uplink(format!("Waiting for uplink '{name}'.")));
    }
    Ok(value)
}

pub(super) fn require_ready(name: &str) -> Result<()> {
    link(luid(name)?).map(|_| ())
}

pub(super) fn snapshot(name: &str) -> Result<Value> {
    serde_json::to_value(link(luid(name)?)?).map_err(|e| ApiError::io("Snapshot TUN uplink", e))
}

fn link(value: NET_LUID_LH) -> Result<Link> {
    let name = usable_uplink(value)?;
    let mut bytes = 16 * 1024;
    let mut result = None;
    loop {
        if bytes > 4 * 1024 * 1024 {
            return Err(invalid("Uplink inventory exceeded its limit."));
        }
        let mut buffer = vec![0u64; (bytes as usize).div_ceil(8)];
        let rows = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let code = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST,
                ptr::null(),
                rows,
                &mut bytes,
            )
        };
        if code == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if code != 0 {
            return Err(ApiError::io(
                "Read uplink addresses",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        let mut row = rows;
        while !row.is_null() {
            let adapter = unsafe { &*row };
            if unsafe { adapter.Luid.Value == value.Value } {
                let mut addresses = BTreeSet::new();
                let mut address = adapter.FirstUnicastAddress;
                while !address.is_null() {
                    let unicast = unsafe { &*address };
                    if unicast.DadState == IpDadStatePreferred {
                        if let Some(ip) = socket_ip(unicast.Address).filter(|ip| match ip {
                            IpAddr::V4(ip) => {
                                !ip.is_unspecified() && !ip.is_loopback() && !ip.is_link_local()
                            }
                            IpAddr::V6(ip) => {
                                !ip.is_unspecified()
                                    && !ip.is_loopback()
                                    && !ip.is_unicast_link_local()
                            }
                        }) {
                            addresses.insert(format!("{ip}/{}", unicast.OnLinkPrefixLength));
                        }
                    }
                    address = unicast.Next;
                }
                let mut dns = BTreeSet::new();
                let mut server = adapter.FirstDnsServerAddress;
                while !server.is_null() {
                    let server_row = unsafe { &*server };
                    if let Some(ip) = socket_ip(server_row.Address) {
                        dns.insert(ip.to_string());
                    }
                    server = server_row.Next;
                }
                let dns_suffix = if adapter.DnsSuffix.is_null() {
                    String::new()
                } else {
                    let mut length = 0;
                    unsafe {
                        while length < 4096 && *adapter.DnsSuffix.add(length) != 0 {
                            length += 1;
                        }
                    }
                    unsafe {
                        String::from_utf16_lossy(std::slice::from_raw_parts(
                            adapter.DnsSuffix,
                            length,
                        ))
                    }
                };
                let mut metrics = [0; 2];
                let mut ip_mtu = [0; 2];
                for (i, family) in [AF_INET, AF_INET6].into_iter().enumerate() {
                    let mut row = MIB_IPINTERFACE_ROW {
                        Family: family,
                        InterfaceLuid: value,
                        ..Default::default()
                    };
                    let code = unsafe { GetIpInterfaceEntry(&mut row) };
                    if code == ERROR_NOT_FOUND {
                        continue;
                    }
                    if code != 0 {
                        return Err(ApiError::io(
                            "Read uplink IP settings",
                            std::io::Error::from_raw_os_error(code as i32),
                        ));
                    }
                    metrics[i] = row.Metric;
                    ip_mtu[i] = row.NlMtu;
                }
                let mut index = 0;
                if unsafe { ConvertInterfaceLuidToIndex(&value, &mut index) } != 0 {
                    return Err(unavailable_uplink("The uplink index changed."));
                }
                result = Some(Link {
                    metrics,
                    ip_mtu,
                    network_id: guid_text(adapter.NetworkGuid),
                    dns_suffix,
                    id: id(value)?,
                    name: name.clone(),
                    index,
                    mtu: adapter.Mtu,
                    addresses,
                    dns,
                    defaults: BTreeSet::new(),
                });
                break;
            }
            row = adapter.Next;
        }
        break;
    }
    let mut result = result.ok_or_else(|| unavailable_uplink("Waiting for uplink addresses."))?;
    if result.addresses.is_empty() {
        return Err(unavailable_uplink(format!(
            "Waiting for an IP address on '{}'.",
            result.name
        )));
    }
    let mut table = ptr::null_mut();
    let code = unsafe { GetIpForwardTable2(AF_UNSPEC, &mut table) };
    if code != 0 {
        return Err(ApiError::io(
            "Read uplink routes",
            std::io::Error::from_raw_os_error(code as i32),
        ));
    }
    // SAFETY: the successful query transferred this allocation to us.
    let table = unsafe { crate::native::MibTable::from_raw(table) }
        .ok_or_else(|| unavailable_uplink("Windows returned no uplink route table."))?;
    let pointer = table.as_ptr();
    // SAFETY: the owned snapshot contains NumEntries initialized route rows.
    unsafe {
        for row in std::slice::from_raw_parts(
            ptr::addr_of!((*pointer).Table).cast::<MIB_IPFORWARD_ROW2>(),
            (*pointer).NumEntries as usize,
        ) {
            if row.InterfaceLuid.Value == value.Value && row.DestinationPrefix.PrefixLength == 0 {
                if let Some(next) = ip(&row.NextHop) {
                    result.defaults.insert(format!("{next}/{}", row.Metric));
                }
            }
        }
    }
    Ok(result)
}

#[derive(Clone)]
struct Binding {
    tag: String,
    fixed: Option<String>,
}

#[derive(Default)]
pub(crate) struct Monitor {
    notifications: Option<Notifications>,
    bindings: Vec<Binding>,
    applied: Vec<Link>,
    interrupted: bool,
    checked: Option<Instant>,
    phase: Phase,
}
#[derive(Default)]
enum Phase {
    #[default]
    Ready,
    Waiting(ApiError),
    Settling {
        links: Vec<Link>,
        since: Instant,
    },
    Reconnecting(Vec<Link>),
}

pub(crate) struct PreparedUplinks(Vec<(Binding, Link)>);

impl PreparedUplinks {
    pub(crate) fn new(config: &Value, plan: Option<&Plan>) -> Result<Self> {
        let Some(primary) = plan else {
            return Ok(Self(Vec::new()));
        };
        let mut uplinks = Vec::new();
        for source in std::iter::once(primary).chain(primary.shared.as_deref()) {
            let tag = source.worker["inbounds"][0]["tag"]
                .as_str()
                .ok_or_else(|| invalid("TUN tag missing."))?;
            let input = config["inbounds"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|input| input["tag"] == tag)
                .ok_or_else(|| invalid("TUN input missing."))?;
            // Record the exact interface selected by the plan, before spawning.
            // Resolving the default route again after startup could acknowledge an
            // uplink the running core never used.
            let uplink = link(luid(&source.uplink)?)?;
            let fixed = source.shared_source
                || input["settings"]["autoOutboundsInterface"]
                    .as_str()
                    .is_some_and(|name| !name.is_empty() && name != "auto");
            uplinks.push((
                Binding {
                    tag: tag.to_owned(),
                    fixed: fixed.then(|| uplink.id.clone()),
                },
                uplink,
            ));
        }
        Ok(Self(uplinks))
    }
}
#[derive(PartialEq, Eq, Debug)]
pub(crate) enum Change {
    None,
    Status,
    Reconnect,
}
impl Monitor {
    pub(crate) fn cancel(&mut self) {
        *self = Self::default();
    }
    pub(crate) fn active(&self) -> bool {
        !self.bindings.is_empty()
    }
    pub(crate) fn activated(&mut self, prepared: PreparedUplinks) {
        let (bindings, links): (Vec<_>, Vec<_>) = prepared.0.into_iter().unzip();
        if bindings.is_empty() {
            self.cancel();
            return;
        }
        self.bindings = bindings;
        self.committed(links);
    }
    fn sample(&self, config: &Value) -> Result<Vec<Link>> {
        self.bindings
            .iter()
            .map(|binding| {
                let value = if let Some(id) = &binding.fixed {
                    guid_luid(id)?
                } else {
                    let settings = config["inbounds"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|i| i["tag"] == binding.tag)
                        .ok_or_else(|| invalid("TUN input changed without activation."))?;
                    luid(&uplink(&settings["settings"])?)?
                };
                link(value)
            })
            .collect()
    }
    pub(crate) fn configuration(&self, config: &Value) -> Result<Value> {
        let mut result = config.clone();
        if !self.active() {
            return Ok(result);
        }
        let sampled;
        let links = match &self.phase {
            Phase::Reconnecting(links) => links,
            _ => {
                sampled = self.sample(config)?;
                &sampled
            }
        };
        for (binding, link) in self.bindings.iter().zip(links) {
            if let Some(input) = result["inbounds"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|i| i["tag"] == binding.tag)
            {
                input["settings"]["autoOutboundsInterface"] = json!(link.name);
            }
        }
        Ok(result)
    }
    pub(crate) fn poll(&mut self, config: &Value) -> Result<Change> {
        if !self.active() {
            return Ok(Change::None);
        }
        let now = Instant::now();
        if self
            .checked
            .is_some_and(|last| now.duration_since(last) < INTERVAL)
        {
            return Ok(Change::None);
        }
        self.checked = Some(now);
        if self.notifications.as_ref().is_some_and(|n| {
            n.context
                .lost
                .swap(false, std::sync::atomic::Ordering::AcqRel)
        }) {
            self.interrupted = true;
        }
        let sample = self.sample(config);
        self.observe(sample, now)
    }
    fn observe(&mut self, sample: Result<Vec<Link>>, now: Instant) -> Result<Change> {
        let links = match sample {
            Ok(links) => links,
            Err(error) if network_unavailable(&error) => return Ok(self.waiting(error)),
            Err(error) => return Err(error),
        };
        if links == self.applied && !self.interrupted {
            let changed = !matches!(self.phase, Phase::Ready);
            self.phase = Phase::Ready;
            return Ok(if changed {
                Change::Status
            } else {
                Change::None
            });
        }
        match &self.phase {
            Phase::Settling {
                links: candidate,
                since,
            } if *candidate == links => {
                if now.duration_since(*since) < SETTLE {
                    return Ok(Change::None);
                }
            }
            _ => {
                self.phase = Phase::Settling { links, since: now };
                return Ok(Change::Status);
            }
        }
        self.phase = Phase::Reconnecting(links);
        Ok(Change::Reconnect)
    }
    pub(crate) fn waiting(&mut self, error: ApiError) -> Change {
        let changed =
            !matches!(&self.phase, Phase::Waiting(previous) if previous.message == error.message);
        self.phase = Phase::Waiting(error);
        self.interrupted = true;
        if changed {
            Change::Status
        } else {
            Change::None
        }
    }
    fn committed(&mut self, links: Vec<Link>) {
        if self.notifications.is_none() {
            self.notifications = Notifications::new().ok();
        }
        if let Some(notifications) = &self.notifications {
            for (slot, link) in notifications.context.luids.iter().zip(&links) {
                slot.store(
                    guid_luid(&link.id).map(|v| unsafe { v.Value }).unwrap_or(0),
                    std::sync::atomic::Ordering::Release,
                );
            }
            notifications
                .context
                .lost
                .store(false, std::sync::atomic::Ordering::Release);
        }
        self.applied = links;
        self.interrupted = false;
        self.phase = Phase::Ready;
        self.checked = None;
    }
    pub(crate) fn snapshot(&self) -> Value {
        let (state, error) = match &self.phase {
            Phase::Ready if self.active() => ("ready", None),
            Phase::Ready => ("inactive", None),
            Phase::Waiting(error) => ("waiting", Some(error)),
            Phase::Settling { .. } => ("settling", None),
            Phase::Reconnecting(_) => ("reconnecting", None),
        };
        json!({"state":state,"lastError":error,"uplinks":self.applied.iter().map(|l|json!({"id":l.id,"name":l.name,"interfaceIndex":l.index})).collect::<Vec<_>>()})
    }
}
pub(crate) fn network_unavailable(error: &ApiError) -> bool {
    matches!(
        error.code.as_str(),
        "TUN_UPLINK_UNAVAILABLE"
            | "TUN_BOOTSTRAP_UNAVAILABLE"
            | "ICS_ADAPTER_MISSING"
            | "TUN_FORWARDING_ADAPTER"
    )
}

// Only matching uplink notifications signal an interruption. The callback does
// no lifecycle/ICS mutation and takes no locks. Cancel drains callbacks before
// freeing their context; it never runs on the callback thread.
struct NotificationContext {
    luids: [std::sync::atomic::AtomicU64; 2],
    lost: std::sync::atomic::AtomicBool,
}
struct Notifications {
    handle: HANDLE,
    context: Box<NotificationContext>,
}
unsafe impl Send for Notifications {}
impl Notifications {
    fn new() -> Result<Self> {
        let context = Box::new(NotificationContext {
            luids: std::array::from_fn(|_| std::sync::atomic::AtomicU64::new(0)),
            lost: std::sync::atomic::AtomicBool::new(false),
        });
        let mut handle = ptr::null_mut();
        let code = unsafe {
            NotifyIpInterfaceChange(
                AF_UNSPEC,
                Some(interface_changed),
                (&*context as *const NotificationContext).cast(),
                false,
                &mut handle,
            )
        };
        if code != 0 {
            return Err(ApiError::io(
                "Watch TUN uplink",
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        Ok(Self { handle, context })
    }
}
impl Drop for Notifications {
    fn drop(&mut self) {
        for luid in &self.context.luids {
            luid.store(0, std::sync::atomic::Ordering::Release);
        }
        if unsafe { CancelMibChangeNotify2(self.handle) } != 0 {
            let context = std::mem::replace(
                &mut self.context,
                Box::new(NotificationContext {
                    luids: std::array::from_fn(|_| std::sync::atomic::AtomicU64::new(0)),
                    lost: std::sync::atomic::AtomicBool::new(false),
                }),
            );
            let _ = Box::into_raw(context); // Native callbacks may still reference it.
            crate::diagnostics::error!(
                "TUN uplink watch could not be canceled; its inert context was retained."
            );
        }
    }
}
unsafe extern "system" fn interface_changed(
    context: *const c_void,
    row: *const MIB_IPINTERFACE_ROW,
    _kind: MIB_NOTIFICATION_TYPE,
) {
    if context.is_null() || row.is_null() {
        return;
    }
    let context = unsafe { &*context.cast::<NotificationContext>() };
    let luid = unsafe { (*row).InterfaceLuid };
    let key = unsafe { luid.Value };
    if key == 0
        || !context
            .luids
            .iter()
            .any(|v| v.load(std::sync::atomic::Ordering::Acquire) == key)
    {
        return;
    }
    let mut link = MIB_IF_ROW2 {
        InterfaceLuid: luid,
        ..Default::default()
    };
    if unsafe { GetIfEntry2(&mut link) } != 0 || link.OperStatus != 1 {
        context
            .lost
            .store(true, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(name: &str) -> Vec<Link> {
        vec![Link {
            id: "identity".into(),
            name: name.into(),
            index: 5,
            mtu: 1500,
            network_id: "network".into(),
            dns_suffix: String::new(),
            metrics: [25, 25],
            ip_mtu: [1500, 1500],
            addresses: BTreeSet::from(["192.0.2.2/24".into()]),
            dns: BTreeSet::new(),
            defaults: BTreeSet::from(["192.0.2.1/10".into()]),
        }]
    }
    fn monitor() -> Monitor {
        Monitor {
            bindings: vec![Binding {
                tag: "tun".into(),
                fixed: None,
            }],
            applied: sample("Wi-Fi"),
            ..Default::default()
        }
    }
    #[test]
    fn a_default_route_change_during_startup_is_not_acknowledged_as_applied() {
        let mut m = monitor();
        let now = Instant::now();
        let ethernet = sample("Ethernet");
        assert_eq!(
            m.observe(Ok(ethernet.clone()), now).unwrap(),
            Change::Status
        );
        assert_eq!(
            m.observe(Ok(ethernet.clone()), now + SETTLE).unwrap(),
            Change::Reconnect
        );
        let config =
            json!({"inbounds":[{"tag":"tun","settings":{"autoOutboundsInterface":"auto"}}]});
        assert_eq!(
            m.configuration(&config).unwrap()["inbounds"][0]["settings"]["autoOutboundsInterface"],
            "Ethernet"
        );

        let prepared = PreparedUplinks(vec![(m.bindings[0].clone(), ethernet[0].clone())]);
        m.activated(prepared);
        assert_eq!(m.snapshot()["uplinks"][0]["name"], "Ethernet");
        let newer = sample("USB Ethernet");
        assert_eq!(
            m.observe(Ok(newer.clone()), now + SETTLE).unwrap(),
            Change::Status
        );
        assert_eq!(
            m.observe(Ok(newer), now + SETTLE * 2).unwrap(),
            Change::Reconnect
        );
    }
    #[test]
    fn offline_then_same_network_still_reconnects_after_settling() {
        let mut m = monitor();
        let now = Instant::now();
        assert_eq!(
            m.observe(Err(unavailable_uplink("Offline")), now).unwrap(),
            Change::Status
        );
        assert_eq!(m.snapshot()["state"], "waiting");
        assert_eq!(
            m.observe(Ok(sample("Wi-Fi")), now + INTERVAL).unwrap(),
            Change::Status
        );
        assert_eq!(
            m.observe(Ok(sample("Wi-Fi")), now + INTERVAL + SETTLE)
                .unwrap(),
            Change::Reconnect
        );
        m.committed(sample("Wi-Fi"));
        assert_eq!(
            m.observe(Ok(sample("Wi-Fi")), now + INTERVAL + SETTLE * 2)
                .unwrap(),
            Change::None
        );
    }
    #[test]
    fn dhcp_gateway_dns_mtu_and_interface_changes_trigger_one_debounced_restart() {
        for property in [
            "address", "gateway", "dns", "mtu", "ip_mtu", "index", "name", "id",
        ] {
            let mut m = monitor();
            let mut next = sample("Wi-Fi");
            let l = &mut next[0];
            match property {
                "address" => {
                    l.addresses.insert("198.51.100.4/24".into());
                }
                "gateway" => {
                    l.defaults.insert("198.51.100.1/20".into());
                }
                "dns" => {
                    l.dns.insert("198.51.100.53".into());
                }
                "mtu" => l.mtu = 1400,
                "ip_mtu" => l.ip_mtu[0] = 1400,
                "index" => l.index = 7,
                "name" => l.name = "New name".into(),
                _ => l.id = "new adapter".into(),
            }
            let now = Instant::now();
            assert_eq!(
                m.observe(Ok(next.clone()), now).unwrap(),
                Change::Status,
                "{property}"
            );
            assert_eq!(
                m.observe(Ok(next.clone()), now + SETTLE).unwrap(),
                Change::Reconnect,
                "{property}"
            );
            m.committed(next.clone());
            assert_eq!(m.observe(Ok(next), now + SETTLE * 2).unwrap(), Change::None);
        }
    }
    #[test]
    fn flapping_restarts_settle_timer_and_manual_stop_cancels_recovery() {
        let mut m = monitor();
        let now = Instant::now();
        m.observe(Ok(sample("B")), now).unwrap();
        assert_eq!(
            m.observe(Ok(sample("C")), now + SETTLE).unwrap(),
            Change::Status
        );
        assert_eq!(
            m.observe(Ok(sample("C")), now + SETTLE + Duration::from_millis(1))
                .unwrap(),
            Change::None
        );
        m.cancel();
        assert!(!m.active());
        assert_eq!(m.snapshot()["state"], "inactive");
    }
    #[test]
    fn ownership_errors_are_reported_without_a_second_retry_scheduler() {
        let mut m = monitor();
        assert_eq!(
            m.observe(
                Err(ApiError::new("ICS_CONFLICT", "external change")),
                Instant::now()
            )
            .unwrap_err()
            .code,
            "ICS_CONFLICT"
        );
    }
}
