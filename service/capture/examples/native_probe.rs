// SPDX-License-Identifier: GPL-3.0-only
//! Native parity probe. Optional ownership checks open only passive metadata
//! handles and never capture packets or change adapter/system settings.
use std::{
    io::{BufRead, Read, Write},
    process::{Command, Stdio},
};
use wayrill_capture::{
    address::{Address, DivertAddress},
    native::{
        self,
        processes::{self, ProcessSnapshot},
        service_catalog,
    },
    packet::{self, Flow, Packet},
    Error, Result,
};
fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--events-child") {
        let _observer = native::process_events::ProcessEvents::open(
            native::process_events::Scope::Capture,
            std::sync::Arc::new(tokio::sync::Notify::new()),
        )?;
        println!("ready");
        std::io::stdout().flush()?;
        std::io::stdin().read_to_end(&mut Vec::new())?;
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--socket-child") {
        let api = native::divert::Api::load()?;
        let _handle = api.open_socket()?;
        println!("ready");
        std::io::stdout().flush()?;
        std::io::stdin().read_to_end(&mut Vec::new())?;
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--child") {
        let mut sink = Vec::new();
        std::io::stdin().read_to_end(&mut sink)?;
        return Ok(());
    }
    let observation = std::env::args().any(|a| a == "--enable-observation");
    if observation {
        native::observation::enable()?;
    }
    let mut snapshot = ProcessSnapshot::default();
    let rows = snapshot.read(true)?;
    let key = processes::read_key(std::process::id())
        .ok_or_else(|| Error::invalid("Probe process creation time unavailable."))?;
    let own = rows.iter().find(|p| p.key == key).ok_or_else(|| {
        Error::invalid(format!(
            "Probe absent from process snapshot: key={key:?}, now={}, rows={}.",
            native::now_filetime(),
            rows.len()
        ))
    })?;
    if own.path.is_none() {
        return Err(Error::invalid("Probe path unavailable."));
    }
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--child")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let child_pid = child.id();
    let child_rows = snapshot.read(false)?;
    let child_key = child_rows
        .iter()
        .find(|p| p.key.pid == child_pid && p.exited.is_none())
        .map(|p| p.key)
        .ok_or_else(|| Error::invalid("Native process snapshot missed live child."))?;
    drop(child.stdin.take());
    if !child.wait()?.success() {
        return Err(Error::invalid("Probe child failed."));
    }
    let after = snapshot.read(false)?;
    if !after
        .iter()
        .any(|p| p.key == child_key && p.exited.is_some_and(|exit| exit >= child_key.started))
    {
        return Err(Error::invalid(
            "Native process snapshot lost child generation exit.",
        ));
    }
    let services = service_catalog::read()?;
    let sharing = if std::env::args().any(|a| a == "--sharing-inspect") {
        Some(native::sharing::inspect(&mut |_| Ok(()))?)
    } else {
        None
    };
    let firewall_checks = if std::env::args().any(|a| a == "--firewall") {
        firewall_probe()?
    } else {
        0
    };
    let tun_bridge_checks = if std::env::args().any(|a| a == "--tun-bridge") {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?
            .block_on(tun_bridge_probe())?
    } else {
        0
    };
    let attribution_checks = if std::env::args().any(|a| a == "--attribution") {
        attribution_probe()?
    } else {
        0
    };
    let poll_recovery_checks = if std::env::args().any(|a| a == "--poll-recovery") {
        poll_recovery_probe()?
    } else {
        0
    };
    let process_event_checks = if std::env::args().any(|a| a == "--process-events") {
        process_event_probe()?
    } else {
        0
    };
    let ownership_checks = if std::env::args().any(|a| a == "--ownership") {
        ownership_probe()?
    } else {
        0
    };
    let owner_table_checks = owner_table_probe(own)?;
    let arguments = std::env::args().collect::<Vec<_>>();
    let owner = arguments
        .windows(2)
        .find(|a| a[0] == "--owner-sid")
        .map(|a| a[1].as_str());
    let packages = if let Some(owner) = owner {
        native::packages::read(Some(owner))?
    } else {
        Vec::new()
    };
    let loopback_write_checks = if std::env::args().any(|a| a == "--loopback-write") {
        loopback_write_probe(&packages)?
    } else {
        0
    };
    let loopback = native::loopback::snapshot(&packages)?;
    let checksum_cases = if std::env::args().any(|a| a == "--checksum") {
        checksum_probe()?
    } else {
        0
    };
    let adapters = native::adapters::read()?;
    if adapters.is_empty() {
        return Err(Error::invalid("Empty native adapter inventory."));
    }
    if services.is_empty() {
        return Err(Error::invalid("Empty native Windows service inventory."));
    }
    let directory = processes::windows_directory()?;
    let normalized = processes::normalize_image("\\SystemRoot\\System32\\svchost.exe")
        .ok_or_else(|| Error::invalid("SystemRoot path normalization failed."))?;
    if normalized != format!("{directory}\\System32\\svchost.exe") {
        return Err(Error::invalid("Incorrect native path normalization."));
    }
    if native::now_filetime() < key.started {
        return Err(Error::invalid("Native FILETIME is older than the probe."));
    }
    println!(
        "{}",
        serde_json::json!({"passed":true,"processes":rows.len(),"services":services.len(),"selfGenerationFound":true,
        "childExitGenerationPreserved":true,"systemRootNormalized":true,"captureOpened":false,"settingsChanged":false,
        "loopback":loopback,"sharing":sharing,"firewallChecks":firewall_checks,"tunBridgeChecks":tun_bridge_checks,"loopbackWriteChecks":loopback_write_checks,"attributionChecks":attribution_checks,"processEventChecks":process_event_checks,
        "pollRecoveryChecks": poll_recovery_checks,"ownershipChecks":ownership_checks,"ownerTableChecks":owner_table_checks,"observationPrivilegeEnabled":observation,"packages":packages,"checksumCases":checksum_cases,"interfaces":adapters.iter().map(|a|serde_json::json!({"id":a.id,"name":a.name,"status":a.status,"ipv4Index":a.ipv4_index,"ipv6Index":a.ipv6_index})).collect::<Vec<_>>()})
    );
    Ok(())
}
fn firewall_probe() -> Result<usize> {
    use native::firewall::{self, ReflectionFirewall, NAME};
    use windows::{
        core::{Interface, BSTR},
        Win32::{
            NetworkManagement::WindowsFirewall::{INetFwPolicy2, INetFwRule3, NetFwPolicy2},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED,
            },
        },
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: balanced successful initialization on this probe thread.
            unsafe {
                CoUninitialize();
            }
        }
    }
    // SAFETY: the probe has not initialized COM on this thread; own a balanced
    // initialization while the explicitly owned test rule is inspected/changed.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    }
    let _apartment = Apartment;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let mut owned = ReflectionFirewall::new(&[port, port])?;
    // SAFETY: fixed firewall class/owned QA rule only. Narrow its remote scope,
    // check that cleanup preserves the edit, then restore our exact test scope.
    unsafe {
        let policy: INetFwPolicy2 = CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER)?;
        let rules = policy.Rules()?;
        let rule = rules.Item(&BSTR::from(NAME))?;
        if rule.LocalPorts()? != port.to_string()
            || rule.ApplicationName()? != std::env::current_exe()?.to_string_lossy().as_ref()
        {
            return Err(Error::invalid(
                "Firewall rule scope differs from the owned listener.",
            ));
        }
        let old = rule.RemoteAddresses()?;
        rule.SetRemoteAddresses(&BSTR::from("192.0.2.1"))?;
        let changed = rule.RemoteAddresses()?;
        let conflict = owned
            .close()
            .is_err_and(|e| e.0.starts_with("FIREWALL_CONFLICT:"));
        let preserved = rules.Item(&BSTR::from(NAME))?.RemoteAddresses()? == changed;
        rule.SetRemoteAddresses(&old)?;
        let extended: INetFwRule3 = rule.cast()?;
        let original_owner = extended.LocalUserOwner()?;
        extended.SetLocalUserOwner(&BSTR::from("S-1-5-18"))?;
        let extended_conflict =
            firewall::clear_stale().is_err_and(|e| e.0.starts_with("FIREWALL_CONFLICT:"));
        let owner_preserved = extended.LocalUserOwner()? == "S-1-5-18";
        extended.SetLocalUserOwner(&original_owner)?;
        firewall::clear_stale()?;
        if !conflict || !preserved || !extended_conflict || !owner_preserved {
            return Err(Error::invalid("Modified firewall rule was not preserved."));
        }
        if rules.Item(&BSTR::from(NAME)).is_ok() {
            return Err(Error::invalid(
                "Restored owned firewall rule was not removed.",
            ));
        }
    }
    ReflectionFirewall::new(&[port])?.close()?;
    firewall::clear_stale()?;
    Ok(7)
}
async fn tun_bridge_probe() -> Result<usize> {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
        time::{timeout, Duration},
    };
    use wayrill_capture::tun_applications::{TunApplications, TunInput};
    let input = |name: &str| -> Result<TunInput> {
        Ok(serde_json::from_value(
            serde_json::json!({"source":"tun","tag":"native-qa","selectors":[],"ports":"","networks":["tcp","udp"],"predicates":[[{"kind":"process","value":name,"mode":"name","enabled":true,"children":false}]],"masks":["0","1"]}),
        )?)
    };
    async fn query(port: u16, request: &[u8]) -> Result<Vec<u8>> {
        let run = async {
            let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await?;
            socket.write_all(request).await?;
            let mut output = Vec::new();
            socket.read_to_end(&mut output).await?;
            Ok::<_, Error>(output)
        };
        timeout(Duration::from_secs(3), run)
            .await
            .map_err(|_| Error::invalid("TUN bridge query timed out."))?
    }
    let udp = std::net::UdpSocket::bind("127.0.0.1:0")?;
    let request = |auth: &str, source: &str| {
        format!("{}\n",serde_json::json!({"auth":auth,"network":"udp","source":source,"sourcePort":udp.local_addr().unwrap().port(),"destination":"127.0.0.1","destinationPort":443})).into_bytes()
    };
    let mut previous_secret = String::new();
    let executable = std::env::current_exe()?;
    let own_name = executable
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::invalid("Probe executable name unavailable."))?;
    for (name, expected) in [(own_name, "1"), ("not-the-probe.exe", "0")] {
        let mut bridge = TunApplications::start(input(name)?).await?;
        let port = bridge.endpoint().port;
        let secret = bridge.endpoint().secret.clone();
        if secret.len() != 64 || secret == previous_secret || bridge.endpoint().width != 1 {
            return Err(Error::invalid(
                "TUN bridge endpoint identity is invalid or reused.",
            ));
        }
        previous_secret = secret.clone();
        let response: serde_json::Value =
            serde_json::from_slice(&query(port, &request(&secret, "127.0.0.1")).await?)?;
        if response["mask"] != expected || !response["origin"].is_null() {
            return Err(Error::invalid(
                "TUN bridge returned an incorrect identity mask.",
            ));
        }
        let response: serde_json::Value =
            serde_json::from_slice(&query(port, &request(&secret, "::ffff:127.0.0.1")).await?)?;
        if response["mask"] != expected || !response["origin"].is_null() {
            return Err(Error::invalid(
                "TUN bridge mapped IPv4 did not preserve ownership.",
            ));
        }
        if !query(port, &request(&"00".repeat(32), "127.0.0.1"))
            .await?
            .is_empty()
        {
            return Err(Error::invalid(
                "Unauthenticated TUN query received an identity.",
            ));
        }
        if !query(port, b"{\"auth\":\"bad\",\"unknown\":true}\n")
            .await?
            .is_empty()
        {
            return Err(Error::invalid("Malformed TUN query received an identity."));
        }
        match query(port, &vec![b'x'; 1025]).await {
            Ok(bytes) if bytes.is_empty() => {}
            Err(error) if matches!(error.os_code(), Some(10054 | 10053 | 1236)) => {}
            Err(error) => return Err(error),
            _ => return Err(Error::invalid("Oversized TUN query received an identity.")),
        }
        bridge.check_health()?;
        let mut idle = Vec::new();
        for _ in 0..33 {
            idle.push(TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await?);
        }
        timeout(Duration::from_secs(3), bridge.close())
            .await
            .map_err(|_| Error::invalid("TUN bridge did not drain its blocked clients."))??;
        if TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok()
        {
            return Err(Error::invalid(
                "Stopped TUN bridge listener is still reachable.",
            ));
        }
    }
    Ok(16)
}
fn loopback_write_probe(packages: &[native::packages::Package]) -> Result<usize> {
    use native::loopback::{self, Change};
    let before = loopback::read()?;
    let original = loopback::snapshot(packages)?;
    if loopback::apply(packages, &original.version, &[])?.version != original.version {
        return Err(Error::invalid("No-op loopback update changed permissions."));
    }
    if loopback::apply(packages, "stale-version", &[]).is_ok() {
        return Err(Error::invalid("Stale loopback update was accepted."));
    }
    let package = original
        .packages
        .iter()
        .find(|p| !p.enabled)
        .ok_or_else(|| {
            Error::invalid("No disabled package available for reversible loopback QA.")
        })?;
    struct Restore<'a> {
        packages: &'a [native::packages::Package],
        family: String,
        expected: std::collections::BTreeMap<String, u32>,
    }
    impl Drop for Restore<'_> {
        fn drop(&mut self) {
            // Restore only when the entire current map still equals our own
            // temporary result. Never overwrite an unrelated concurrent edit.
            if matches!(loopback::read(),Ok(ref current) if *current==self.expected) {
                if let Ok(snapshot) = loopback::snapshot(self.packages) {
                    let _ = loopback::apply(
                        self.packages,
                        &snapshot.version,
                        &[Change {
                            family: self.family.clone(),
                            enabled: false,
                        }],
                    );
                }
            }
        }
    }
    let mut expected = before.clone();
    expected.insert(package.sid.clone(), 0);
    let restore = Restore {
        packages,
        family: package.family.clone(),
        expected,
    };
    let changed = loopback::apply(
        packages,
        &original.version,
        &[Change {
            family: package.family.clone(),
            enabled: true,
        }],
    )?;
    if loopback::read()? != restore.expected {
        return Err(Error::invalid(
            "Loopback write altered unrelated permissions.",
        ));
    }
    if loopback::apply(
        packages,
        &original.version,
        &[Change {
            family: package.family.clone(),
            enabled: false,
        }],
    )
    .is_ok()
    {
        return Err(Error::invalid(
            "Stale loopback update replaced a newer version.",
        ));
    }
    loopback::apply(
        packages,
        &changed.version,
        &[Change {
            family: package.family.clone(),
            enabled: false,
        }],
    )?;
    drop(restore);
    if loopback::read()? != before {
        return Err(Error::invalid(
            "Loopback QA did not restore original permissions and attributes.",
        ));
    }
    Ok(5)
}
fn attribution_probe() -> Result<usize> {
    use std::{
        sync::Arc,
        thread,
        time::{Duration, Instant},
    };
    use wayrill_capture::{
        policy::{Endpoint, Input, InterfaceOptions, Plan, SharedPolicy},
        process::Kind,
    };
    let rules = Arc::new(SharedPolicy::new(Plan {
        inputs: vec![Input {
            tag: "native-qa".into(),
            selectors: Vec::new(),
            ports: String::new(),
            networks: vec!["tcp".into(), "udp".into()],
            endpoint: Endpoint {
                port: 22080,
                username: String::new(),
                password: String::new(),
            },
            predicates: Vec::new(),
            masks: vec!["0".into()],
        }],
        interfaces: InterfaceOptions::default(),
        bypass_local_traffic: true,
    })?);
    let key = processes::read_key(std::process::id())
        .ok_or_else(|| Error::invalid("Attribution probe generation unavailable."))?;
    let api = native::divert::Api::load()?;
    let mut checks = 0;
    for capture in [false, true] {
        let mut source = native::attribution_source::AttributionSource::new()?;
        let changed = Arc::new(tokio::sync::Notify::new());
        if capture {
            source.start_capture(&api, changed)?;
        } else {
            source.start_tun(changed)?;
        }
        source.read(Some(rules.clone()), &[], true)?;
        for six in [false, true] {
            let bind = if six { "[::1]:0" } else { "127.0.0.1:0" };
            let listener = std::net::TcpListener::bind(bind)?;
            let client = std::net::TcpStream::connect(listener.local_addr()?)?;
            let (server, _) = listener.accept()?;
            let udp = std::net::UdpSocket::bind(bind)?;
            let peer = std::net::UdpSocket::bind(bind)?;
            udp.connect(peer.local_addr()?)?;
            udp.send(b"qa")?;
            let flows = [
                (6, client.local_addr()?, client.peer_addr()?),
                (17, udp.local_addr()?, peer.local_addr()?),
            ]
            .map(|(protocol, local, remote)| Flow {
                protocol,
                local: Address {
                    ip: local.ip(),
                    scope: 0,
                },
                local_port: local.port(),
                remote: Address {
                    ip: remote.ip(),
                    scope: 0,
                },
                remote_port: remote.port(),
            });
            let deadline = Instant::now() + Duration::from_secs(3);
            let snapshot = loop {
                let snapshot = source.read(Some(rules.clone()), &[], true)?;
                let selected = flows.iter().all(|flow| {
                    let d = snapshot.find(*flow, 0);
                    d.kind == Kind::Selected
                        && d.process == Some(key)
                        && (!capture || d.endpoint != 0)
                });
                if selected {
                    break snapshot;
                }
                if Instant::now() >= deadline {
                    return Err(Error::invalid(format!(
                        "Native {} attribution failed for IPv{}: {:?}",
                        if capture { "capture" } else { "TUN" },
                        if six { 6 } else { 4 },
                        flows.map(|f| snapshot.find(f, 0))
                    )));
                }
                thread::sleep(Duration::from_millis(10));
            };
            let excluded = source.read(Some(rules.clone()), &[key], true)?;
            if flows
                .iter()
                .any(|flow| excluded.find(*flow, 0).kind != Kind::Unselected)
            {
                return Err(Error::invalid(
                    "Generation exclusions did not replace native attribution decisions.",
                ));
            }
            if flows
                .iter()
                .any(|flow| snapshot.find(*flow, 0).kind != Kind::Selected)
            {
                return Err(Error::invalid(
                    "Published native attribution snapshot was mutated.",
                ));
            }
            let accepted = Flow {
                protocol: 6,
                local: Address {
                    ip: server.local_addr()?.ip(),
                    scope: 0,
                },
                local_port: server.local_addr()?.port(),
                remote: Address {
                    ip: server.peer_addr()?.ip(),
                    scope: 0,
                },
                remote_port: server.peer_addr()?.port(),
            };
            if !snapshot.find(accepted, 0).accepted {
                return Err(Error::invalid(
                    "Native accepted TCP stream was not exempted.",
                ));
            }
            checks += 5;
        }
        source.close()?;
    }
    Ok(checks)
}
fn process_event_probe() -> Result<usize> {
    use native::process_events::{ProcessEvents, Scope};
    use std::{
        sync::Arc,
        thread,
        time::{Duration, Instant},
    };
    let notify = Arc::new(tokio::sync::Notify::new());
    let mut observer = ProcessEvents::open(Scope::Capture, notify.clone())?;
    if ProcessEvents::open(Scope::Capture, notify.clone()).is_ok() {
        return Err(Error::invalid(
            "Duplicate process observer acquired ownership.",
        ));
    }
    let mut tun = ProcessEvents::open(Scope::Tun, notify.clone())?;
    let mut seen = std::collections::HashMap::new();
    for _ in 0..16 {
        let mut child = Command::new(std::env::current_exe()?)
            .arg("--child")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()?;
        let key = processes::read_key(child.id())
            .ok_or_else(|| Error::invalid("ETW child creation time unavailable."))?;
        drop(child.stdin.take());
        if !child.wait()?.success() {
            return Err(Error::invalid("ETW child failed."));
        }
        seen.insert(key, (false, false));
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let batch = observer.drain(true)?;
        if batch.discontinuity {
            return Err(Error::invalid("Process observer lost probe events."));
        }
        for event in batch.items {
            if let Some((started, exited)) = seen.get_mut(&event.key) {
                if event.exited.is_some() {
                    *exited = event.exited_at.is_some_and(|q| q > 0);
                } else {
                    if event.parent_pid != std::process::id()
                        || event.path.is_none()
                        || event.started_at <= 0
                    {
                        return Err(Error::invalid(
                            "ETW start lost parent, path or QPC identity.",
                        ));
                    }
                    *started = true;
                }
            }
        }
        if seen.values().all(|(start, stop)| *start && *stop) {
            break;
        }
        if Instant::now() >= deadline {
            return Err(Error::invalid(format!(
                "ETW missed child lifetimes: {} of {} complete.",
                seen.values().filter(|(a, b)| *a && *b).count(),
                seen.len()
            )));
        }
        thread::sleep(Duration::from_millis(10));
    }
    // Flush submits buffers; it is not a synchronous consumer-delivery barrier.
    // Give the second independent consumer the same bounded delivery window.
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut tun_seen = std::collections::HashSet::new();
    while tun_seen.len() != seen.len() * 2 {
        let batch = tun.drain(true)?;
        if batch.discontinuity {
            return Err(Error::invalid("TUN observer lost probe events."));
        }
        for event in batch.items {
            if seen.contains_key(&event.key) {
                tun_seen.insert((event.key, event.exited.is_some()));
            }
        }
        if tun_seen.len() == seen.len() * 2 {
            break;
        }
        if Instant::now() >= deadline {
            return Err(Error::invalid(format!(
                "Independent TUN process observer received {} of {} expected events.",
                tun_seen.len(),
                seen.len() * 2
            )));
        }
        thread::sleep(Duration::from_millis(10));
    }
    tun.close()?;
    observer.close()?;
    for _ in 0..8 {
        ProcessEvents::open(Scope::Capture, notify.clone())?.close()?;
    }
    // Kill only our own test child, leaving an ETW session orphan. A replacement
    // must reclaim it under the installation mutex, without touching other sessions.
    let mut orphan = Command::new(std::env::current_exe()?)
        .arg("--events-child")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut line = String::new();
    std::io::BufReader::new(orphan.stdout.take().unwrap()).read_line(&mut line)?;
    if line.trim() != "ready" {
        drop(orphan.stdin.take());
        let _ = orphan.kill();
        let _ = orphan.wait();
        return Err(Error::invalid("ETW orphan fixture did not become ready."));
    }
    orphan.kill()?;
    orphan.wait()?;
    ProcessEvents::open(Scope::Capture, notify)?.close()?;
    Ok(29)
}
fn ownership_probe() -> Result<usize> {
    use native::divert_monitor::Monitor;
    use std::{
        thread,
        time::{Duration, Instant},
    };
    let api = native::divert::Api::load()?;
    native::capture_availability::check(&api, None, None)?;
    let mut monitor = Monitor::open(&api, true)?
        .ok_or_else(|| Error::invalid("Ownership observer unavailable."))?;
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            drop(self.0.stdin.take());
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }
    let mut child = Child(
        Command::new(std::env::current_exe()?)
            .arg("--socket-child")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?,
    );
    let child_pid = child.0.id();
    let mut ready = String::new();
    std::io::BufReader::new(child.0.stdout.take().unwrap()).read_line(&mut ready)?;
    if ready.trim() != "ready" {
        return Err(Error::invalid("Ownership child did not become ready."));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while !monitor
        .handles()?
        .iter()
        .any(|h| h.pid == child_pid && h.layer == 3)
    {
        if Instant::now() >= deadline {
            return Err(Error::invalid(
                "Live ownership observer missed new child handle.",
            ));
        }
        thread::sleep(Duration::from_millis(5));
    }
    let snapshot = Monitor::snapshot(&api)?
        .ok_or_else(|| Error::invalid("Ownership snapshot unavailable."))?;
    let handle = snapshot
        .handles()?
        .into_iter()
        .find(|h| h.pid == child_pid && h.layer == 3)
        .ok_or_else(|| Error::invalid("Ownership snapshot missed child handle."))?;
    if !handle.is_foreign(std::process::id(), None, None)
        || handle.is_foreign(std::process::id(), Some(child_pid), None)
    {
        return Err(Error::invalid(
            "Ownership conflict exclusions are incorrect.",
        ));
    }
    drop(child.0.stdin.take());
    if !child.0.wait()?.success() {
        return Err(Error::invalid("Ownership child failed."));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while monitor.handles()?.iter().any(|h| h.pid == child_pid) {
        if Instant::now() >= deadline {
            return Err(Error::invalid(
                "Ownership observer resurrected a closed child handle.",
            ));
        }
        thread::sleep(Duration::from_millis(5));
    }
    monitor.close()?;
    native::drivers::check_loaded()?;
    Ok(6)
}
fn owner_table_probe(process: &wayrill_capture::process::ProcessInfo) -> Result<usize> {
    use wayrill_capture::services::{ServiceInfo, ServiceSnapshot};
    let services = ServiceSnapshot::new(
        &[
            ServiceInfo {
                name: "Wayrill.QA.Selected".into(),
                display_name: String::new(),
                pid: process.key.pid,
            },
            ServiceInfo {
                name: "Wayrill.QA.Other".into(),
                display_name: String::new(),
                pid: process.key.pid,
            },
        ],
        std::slice::from_ref(process),
        &["Wayrill.QA.Selected".into()],
    );
    let mut checks = 0;
    for six in [false, true] {
        let address = if six { "[::1]:0" } else { "127.0.0.1:0" };
        let tcp = std::net::TcpListener::bind(address)?;
        let udp = std::net::UdpSocket::bind(address)?;
        for modules in [false, true] {
            for (protocol, port) in [
                (6, tcp.local_addr()?.port()),
                (17, udp.local_addr()?.port()),
            ] {
                let rows = native::owners::read(protocol, six, modules.then_some(&services))?;
                let row=rows.iter().find(|r|r.pid==process.key.pid && r.port==port).ok_or_else(||Error::invalid(format!("Native owner table missed protocol={protocol}, IPv6={six}, module={modules}.")))?;
                if modules && row.module.is_none() {
                    return Err(Error::invalid(
                        "Native owner module name unavailable for the probe socket.",
                    ));
                }
                checks += 1;
            }
        }
    }
    Ok(checks)
}
fn checksum_probe() -> Result<usize> {
    let api = native::divert::Api::load()?;
    let mut seed = 123u32;
    let mut cases = 0;
    for six in [false, true] {
        let flow = Flow {
            protocol: 6,
            local: Address {
                ip: if six { "fd00::10" } else { "10.0.2.15" }.parse().unwrap(),
                scope: 0,
            },
            remote: Address {
                ip: if six { "2001:db8::7" } else { "203.0.113.7" }
                    .parse()
                    .unwrap(),
                scope: 0,
            },
            local_port: 50000,
            remote_port: 443,
        };
        for length in [0, 1, 31, 1440, 8191] {
            for _ in 0..32 {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let mut bytes = packet::tcp_reset(flow, seed, Some(seed ^ 17))?;
                bytes.extend((0..length).map(|i| (seed.wrapping_add(i) >> 16) as u8));
                let offset = if six { 4 } else { 2 };
                let total = if six { bytes.len() - 40 } else { bytes.len() } as u16;
                bytes[offset..offset + 2].copy_from_slice(&total.to_be_bytes());
                let mut address = DivertAddress::default();
                api.calculate_checksums(&mut bytes, &mut address)?;
                let parsed = Packet::parse(&bytes, 0)
                    .ok_or_else(|| Error::invalid("Invalid native checksum fixture."))?;
                if !parsed.reflect(&mut bytes, seed as u16, (seed >> 16) as u16, address)? {
                    return Err(Error::invalid(
                        "Native helper did not mark a valid TCP checksum.",
                    ));
                }
                let incremental = bytes.clone();
                bytes[parsed.transport + 16..parsed.transport + 18].fill(0);
                if !six {
                    bytes[10..12].fill(0);
                }
                api.calculate_checksums(&mut bytes, &mut address)?;
                if bytes != incremental {
                    return Err(Error::invalid(
                        "Rust reflection differs from WinDivert's full checksum calculation.",
                    ));
                }
                cases += 1;
            }
        }
    }
    Ok(cases)
}

/// A real native inventory recovers new generations even when their ETW start
/// was lost. No capture handle, adapter or Windows setting is changed.
fn poll_recovery_probe() -> Result<usize> {
    use std::sync::Arc;
    use wayrill_capture::{
        policy::{Endpoint, Input, InterfaceOptions, Plan, Selector, SharedPolicy},
        process::{Kind, ProcessTree},
        process_decisions::ProcessDecisions,
    };
    let exe = std::env::current_exe()?;
    let name = exe.file_name().unwrap().to_string_lossy().into_owned();
    let rules = Arc::new(SharedPolicy::new(Plan {
        inputs: vec![Input {
            tag: "probe".into(),
            ports: String::new(),
            selectors: vec![Selector {
                kind: "process".into(),
                value: name,
                mode: "name".into(),
                children: true,
                enabled: true,
            }],
            networks: vec!["tcp".into(), "udp".into()],
            endpoint: Endpoint {
                port: 22080,
                username: "private".into(),
                password: "test".into(),
            },
            predicates: vec![],
            masks: vec!["0".into()],
        }],
        interfaces: InterfaceOptions::default(),
        bypass_local_traffic: true,
    })?);
    let mut snapshot = ProcessSnapshot::default();
    let mut tree = ProcessTree::new(Some(rules), []);
    tree.update(snapshot.read(true)?, native::now_filetime())?;
    let epoch = native::now_filetime();
    let mut child = Command::new(exe)
        .arg("--child")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let result = (|| {
        let key = processes::read_key(child.id())
            .ok_or_else(|| Error::invalid("Child generation unavailable."))?;
        if key.started < epoch {
            return Err(Error::invalid(
                "Child did not start after the observation epoch.",
            ));
        }
        // Deliberately use only native table rows, not the ETW start event.
        tree.update(snapshot.read(true)?, native::now_filetime())?;
        let mut decisions = ProcessDecisions::new(&tree, epoch, None);
        let current = decisions.current(child.id(), None)?;
        if current.kind != Kind::Selected || current.process != Some(key) {
            return Err(Error::invalid(format!(
                "Current native generation remained unresolved: {current:?}"
            )));
        }
        if decisions
            .owner_at(child.id(), native::clock::ticks())
            .is_some()
        {
            return Err(Error::invalid(
                "Native snapshot invented historical ETW timing.",
            ));
        }
        Ok(3)
    })();
    drop(child.stdin.take());
    let exited = child.wait()?;
    if !exited.success() {
        return Err(Error::invalid("Native recovery probe child failed."));
    }
    result
}
