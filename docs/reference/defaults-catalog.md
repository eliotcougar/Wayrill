# Global defaults and node inheritance

Settings are arranged by purpose. Common choices and feature switches remain visible; detailed tuning is in collapsed **Advanced** groups. Configured values are summarized and retained; search/error navigation reveals the relevant control. See [SETTINGS-LAYOUT.md](../guide/graphs.md).

Open **Settings → Global defaults…**. This provides 80 shared settings in eight categories, searchable by name, transport or scope. Defaults belong to the current workspace and travel in its graph file; New graph and newly added nodes use that workspace's defaults.

## Using defaults and overrides

An inheritable node field shows **App default**, **Xray default** or **Overridden**. Editing the field creates an explicit override. **Override** freezes its current value even when it equals the default. **Use default** clears one override and immediately adopts the current workspace value; **Use all global defaults** clears all inheritable overrides on that node. Node identity, server, account credentials, transport selection, authentication, listener addresses/ports and routing connections remain intact. Undo/redo includes both values and inheritance state.

Changing defaults updates only inheriting fields. False, zero and blank overrides are real overrides, never treated as missing. A field can remain overridden even when its value equals the new default. Inactive transport/security options are retained and show their state when their mode becomes active. Configuration-wide logging, routing strategy, statistics and policy have no per-node override; policy levels themselves are selectable on inputs and connecting outputs.

The settings window edits a draft. Cancel/Escape discards it; Save defaults applies one graph transaction. Factory buttons restore either one field or all factory defaults while retaining node overrides. The footer shows changed fields, affected nodes and retained overrides. Invalid defaults block saving, while node-specific compatibility issues remain visible for correcting unfinished drafts.

Saving/editing defaults does not reconfigure a running core. Check and Validate the graph, then use Start/Apply. Healthy capture and owned Windows proxy assignments remain active while the core is replaced.

## Two levels of defaults

Unset node fields show a pale italic hint from the configured app global, otherwise the embedded Xray core. Unset globals show the core default. Use Xray default removes a global value; Factory restores an explicit app preset. Zero, false and imported native omissions remain distinct. The versioned store covers all generated protocol fields and the named global/native controls, including contextual behavior and required fields. Builds reject a stale audit after a core update. See [CORE-DEFAULTS.md](../development/core-defaults.md) for the store, provenance, compiler behavior and upgrade workflow.

## Complete settings catalogue

### Inputs & name detection (10)

UDP applies to SOCKS listeners. Sniffing detects names only in traffic reaching an input.

| Setting                             | Scope        | Factory value        | Native configuration mapping           |
| ----------------------------------- | ------------ | -------------------- | -------------------------------------- |
| Inspect traffic for routing names   | SOCKS / HTTP | true                 | inbounds[].sniffing.enabled            |
| HTTP Host                           | SOCKS / HTTP | true                 | inbounds[].sniffing.destOverride: http |
| TLS server name (SNI)               | SOCKS / HTTP | true                 | inbounds[].sniffing.destOverride: tls  |
| Use detected names only for routing | SOCKS / HTTP | true                 | inbounds[].sniffing.routeOnly          |
| Inspect metadata only               | SOCKS / HTTP | false                | inbounds[].sniffing.metadataOnly       |
| Excluded domain rules (JSON)        | SOCKS / HTTP | (blank/core default) | inbounds[].sniffing.domainsExcluded    |
| Excluded IP rules (JSON)            | SOCKS / HTTP | (blank/core default) | inbounds[].sniffing.ipsExcluded        |
| Enable SOCKS5 UDP                   | SOCKS        | true                 | SOCKS settings.udp                     |
| QUIC server name                    | SOCKS        | true                 | inbounds[].sniffing.destOverride: quic |
| Input policy level                  | SOCKS / HTTP | 0                    | inbounds[].settings.userLevel          |

### TLS & User-Agent (8)

Shared client TLS tuning and transport headers. Server identity and account credentials stay in each node.

| Setting                | Scope | Factory value        | Native configuration mapping                                                            |
| ---------------------- | ----- | -------------------- | --------------------------------------------------------------------------------------- |
| Client fingerprint     | VLESS | chrome               | streamSettings.tlsSettings / realitySettings.fingerprint                                |
| ALPN                   | VLESS | (blank/core default) | streamSettings.tlsSettings.alpn                                                         |
| Minimum TLS version    | VLESS | (blank/core default) | streamSettings.tlsSettings.minVersion                                                   |
| Maximum TLS version    | VLESS | (blank/core default) | streamSettings.tlsSettings.maxVersion                                                   |
| TLS session resumption | VLESS | false                | streamSettings.tlsSettings.enableSessionResumption                                      |
| TLS cipher suites      | VLESS | (blank/core default) | streamSettings.tlsSettings.cipherSuites                                                 |
| TLS curve preferences  | VLESS | (blank/core default) | streamSettings.tlsSettings.curvePreferences                                             |
| Transport User-Agent   | VLESS | (blank/core default) | RAW request.headers / WS or HTTPUpgrade headers / gRPC user_agent / XHTTP extra.headers |

### Multiplexing (4)

VLESS TCP mux and XUDP. Vision requires TCP concurrency -1. XHTTP uses its own xmux tuning instead.

| Setting                   | Scope | Factory value | Native configuration mapping                  |
| ------------------------- | ----- | ------------- | --------------------------------------------- |
| Enable multiplexing       | VLESS | false         | outbounds[].mux.enabled, except XHTTP         |
| TCP multiplex concurrency | VLESS | 8             | outbounds[].mux.concurrency, except XHTTP     |
| XUDP concurrency          | VLESS | 16            | outbounds[].mux.xudpConcurrency, except XHTTP |
| XUDP handling of UDP 443  | VLESS | reject        | outbounds[].mux.xudpProxyUDP443, except XHTTP |

### Fragmentation (6)

Separate outer secured-connection and inner client-traffic stages, using native Xray FinalMask.

| Setting                            | Scope | Factory value | Native configuration mapping                                        |
| ---------------------------------- | ----- | ------------- | ------------------------------------------------------------------- |
| Fragment before transport security | VLESS | false         | streamSettings.finalmask.tcp fragment mask on secured TCP transport |
| Fragment traffic inside VLESS      | VLESS | false         | freedom wrapper plus sockopt.dialerProxy to the original VLESS      |
| Packets to fragment                | VLESS | tlshello      | fragment mask settings.packets, both stages                         |
| Fragment lengths (bytes)           | VLESS | 50-100        | fragment mask settings.lengths[], both stages                       |
| Fragment delays (milliseconds)     | VLESS | 10-20         | fragment mask settings.delays[], both stages                        |
| Maximum splits                     | VLESS | 0             | fragment mask settings.maxSplit, both stages                        |

### Connections & DNS strategy (15)

Local socket defaults for connecting outbounds. Availability of interface/socket features depends on Windows and the core.

| Setting                             | Scope          | Factory value        | Native configuration mapping                                |
| ----------------------------------- | -------------- | -------------------- | ----------------------------------------------------------- |
| Source IP / CIDR                    | VLESS / Direct | (blank/core default) | outbounds[].sendThrough                                     |
| Network interface                   | VLESS / Direct | (blank/core default) | streamSettings.sockopt.interface                            |
| TCP Fast Open                       | VLESS / Direct | default              | streamSettings.sockopt.tcpFastOpen                          |
| TCP keepalive idle (seconds)        | VLESS / Direct | 0                    | streamSettings.sockopt.tcpKeepAliveIdle                     |
| TCP keepalive interval (seconds)    | VLESS / Direct | 0                    | streamSettings.sockopt.tcpKeepAliveInterval                 |
| TCP user timeout (milliseconds)     | VLESS / Direct | 0                    | streamSettings.sockopt.tcpUserTimeout                       |
| Happy Eyeballs address racing       | VLESS / Direct | false                | streamSettings.sockopt.happyEyeballs object enabled/omitted |
| Address-race delay (milliseconds)   | VLESS / Direct | 0                    | streamSettings.sockopt.happyEyeballs.tryDelayMs             |
| Prefer IPv6 in address racing       | VLESS / Direct | false                | streamSettings.sockopt.happyEyeballs.prioritizeIPv6         |
| Address-race interleave             | VLESS / Direct | 1                    | streamSettings.sockopt.happyEyeballs.interleave             |
| Maximum concurrent address attempts | VLESS / Direct | 4                    | streamSettings.sockopt.happyEyeballs.maxConcurrentTry       |
| VLESS server DNS strategy           | VLESS          | AsIs                 | VLESS streamSettings.sockopt.domainStrategy                 |
| Direct destination DNS strategy     | Direct         | AsIs                 | Direct streamSettings.sockopt.domainStrategy                |
| VLESS target DNS strategy           | VLESS          | AsIs                 | VLESS outbounds[].targetStrategy                            |
| Outbound policy level               | VLESS / Direct | 0                    | VLESS settings.level / Direct settings.userLevel            |

### Transport tuning (16)

Defaults for the selected transport only; inactive transport settings are retained.

| Setting                             | Scope | Factory value | Native configuration mapping                                               |
| ----------------------------------- | ----- | ------------- | -------------------------------------------------------------------------- |
| WebSocket heartbeat (seconds)       | VLESS | 0             | streamSettings.wsSettings.heartbeatPeriod                                  |
| XHTTP mode                          | VLESS | auto          | streamSettings.xhttpSettings.mode                                          |
| gRPC idle timeout (seconds)         | VLESS | 0             | streamSettings.grpcSettings.idle_timeout                                   |
| gRPC health timeout (seconds)       | VLESS | 0             | streamSettings.grpcSettings.health_check_timeout                           |
| Keepalive without streams           | VLESS | false         | streamSettings.grpcSettings.permit_without_stream                          |
| gRPC initial window (bytes)         | VLESS | 0             | streamSettings.grpcSettings.initial_windows_size                           |
| mKCP MTU (bytes)                    | VLESS | 1350          | streamSettings.kcpSettings.mtu                                             |
| mKCP TTI (milliseconds)             | VLESS | 50            | streamSettings.kcpSettings.tti                                             |
| mKCP upload capacity (MB/s)         | VLESS | 5             | streamSettings.kcpSettings.uplinkCapacity                                  |
| mKCP download capacity (MB/s)       | VLESS | 20            | streamSettings.kcpSettings.downlinkCapacity                                |
| mKCP congestion window multiplier   | VLESS | 1             | streamSettings.kcpSettings.cwndMultiplier                                  |
| mKCP maximum sending window (bytes) | VLESS | 20971520      | streamSettings.kcpSettings.maxSendingWindow                                |
| UDP idle timeout (seconds)          | VLESS | 60            | streamSettings.hysteriaSettings.udpIdleTimeout                             |
| Hysteria upload (Mbps)              | VLESS | 0             | finalmask.quicParams.brutalUp with congestion brutal                       |
| Hysteria download (Mbps)            | VLESS | 0             | finalmask.quicParams.brutalDown with congestion brutal                     |
| Hysteria hop interval (seconds)     | VLESS | 30            | finalmask.udp[].settings.interval (type udphop); server ports stay in node |

### Additional core options (10)

Complete shared JSON objects for advanced tuning. Named fields take precedence over overlapping JSON keys.

| Setting                               | Scope          | Factory value        | Native configuration mapping                              |
| ------------------------------------- | -------------- | -------------------- | --------------------------------------------------------- |
| Input stream settings (JSON)          | SOCKS / HTTP   | (blank/core default) | inbounds[].streamSettings                                 |
| Use only configured certificate roots | VLESS          | false                | streamSettings.tlsSettings.disableSystemRoot              |
| Certificates (JSON)                   | VLESS          | (blank/core default) | streamSettings.tlsSettings.certificates                   |
| Additional TLS options (JSON)         | VLESS          | (blank/core default) | streamSettings.tlsSettings, additional keys               |
| ECH DNS socket options (JSON)         | VLESS          | (blank/core default) | streamSettings.tlsSettings.echSockopt                     |
| REALITY debug output                  | VLESS          | false                | streamSettings.realitySettings.show                       |
| Additional REALITY options (JSON)     | VLESS          | (blank/core default) | streamSettings.realitySettings, additional keys           |
| Additional socket options (JSON)      | VLESS / Direct | Windows UDP 256 KiB | streamSettings.sockopt, additional keys                   |
| XHTTP extra (JSON)                    | VLESS          | (blank/core default) | streamSettings.xhttpSettings.extra, including native xmux |
| FinalMask (JSON)                      | VLESS          | (blank/core default) | streamSettings.finalmask TCP/UDP masks and quicParams     |

### Core, routing & policy (9)

Configuration-wide settings. DNS servers, DNS request policies and resolver preferences live in the DNS nodes.

| Setting                         | Scope               | Factory value        | Native configuration mapping                  |
| ------------------------------- | ------------------- | -------------------- | --------------------------------------------- |
| Core log level                  | Whole configuration | warning              | log.loglevel                                  |
| Log core DNS activity           | Whole configuration | false                | log.dnsLog                                    |
| Mask addresses in core logs     | Whole configuration | full                 | log.maskAddress                               |
| Routing domain strategy         | Whole configuration | AsIs                 | routing.domainStrategy                        |
| Enable core statistics counters | Whole configuration | false                | stats module enabled/omitted                  |
| Enable core metrics             | Whole configuration | false                | metrics module enabled/omitted                |
| Metrics outbound tag            | Whole configuration | metrics              | metrics.tag                                   |
| Metrics listen address          | Whole configuration | (blank)              | metrics.listen; service permits loopback only |
| Core policy (JSON)              | Whole configuration | (blank/core default) | policy.levels and policy.system               |

## Compatibility and advanced coverage

- **UDP and sniffing:** UDP enables SOCKS5 UDP ASSOCIATE. HTTP input remains TCP. HTTP/TLS/QUIC name detection and routeOnly act only on traffic reaching the listener; they do not capture Windows DNS. Metadata-only mode cannot recover HTTP/TLS/QUIC payload names.
- **TLS:** the fingerprint applies to TLS and REALITY; ALPN, TLS versions, cipher/curve preferences, resumption, roots and certificate lists apply to TLS. Server name, certificate verification names/pins, ECH configuration list, REALITY password/public key, short ID and ML-DSA identity stay with the server node. The pinned core removed allowInsecure; it is rejected instead of silently weakening validation.
- **User-Agent:** applies to the transport's HTTP camouflage/request, WebSocket, HTTPUpgrade, gRPC or XHTTP headers. RAW needs HTTP header camouflage selected. It does not rewrite a browser's application traffic or a subscription-update request. Wayrill supports XHTTP's native extra.headers as an addition to v2rayN's current global-UA mappings. Editing transport JSON synchronizes single-value User-Agent headers with the named field; multivalue RAW headers remain in JSON. Reapplying the UA default removes case-insensitive JSON UA shadows while preserving unrelated headers.
- **Mux:** ordinary Xray mux and XUDP are separate from XHTTP's native extra.xmux. XHTTP never receives ordinary mux. Vision with mux requires TCP concurrency -1; XUDP can remain enabled. Invalid inherited Vision/TCP-mux combinations are diagnosed before compilation. Enabled/disabled remains an explicit node override as well as a default.
- **Fragment:** the outer stage inserts a TCP fragment FinalMask on the secured transport to the VLESS server. The inner stage inserts a freedom wrapper whose original public tag preserves graph routing, and dials a renamed VLESS outbound. Both stages can coexist. Ordered lengths/delays and maxSplit ranges follow the native core's accepted shape. The outer named stage does not apply to UDP transports or security none. Duplicate fragment masks are rejected. Fragment efficacy against a particular network is not established by parser acceptance.
- **Connections:** VLESS and Direct inherit socket/source defaults; Block has no connecting socket. This scope is explicit: v2rayN applies some global source/interface preferences selectively to its proxy outbounds. AsIs delegates resolution to the system; native Happy Eyeballs requires a resolving Xray address strategy. Socket/interface availability depends on the OS/core.
- **Hysteria:** positive bandwidth selects native Brutal tuning; zero leaves congestion tuning to the core/additional JSON. Hopping uses server-specific ports from the node plus the inherited interval. mKCP and gRPC values are emitted only for their selected transport.
- **Advanced JSON:** socket options cover native mark, tproxy, acceptProxyProtocol, TCP congestion/window/max-segment options, penetrate, v6only, multipath TCP, customSockopt, addressPortStrategy and trusted X-Forwarded-For alongside named fields. TLS/REALITY JSON covers remaining client tuning; input stream settings covers supported inbound transports/sockets; FinalMask covers TCP/UDP masks and QUIC tuning; XHTTP extra covers native xmux, padding, upload/download behavior, headers and downloadSettings. Named fields emitted by the compiler take precedence over overlapping JSON values; omitted/blank optional fields permit additional native JSON options. Validate the complete configuration with Xray for platform/mode compatibility.
- **Policy and statistics:** policy JSON covers per-level handshake, connIdle, uplinkOnly, downlinkOnly, bufferSize, statsUserUplink, statsUserDownlink, statsUserOnline and system statsInboundUplink/Downlink plus statsOutboundUplink/Downlink. Seconds, KiB, integer bounds and known keys are validated. Counters can be enabled. The Statistics panel displays live rates, totals and hourly history through the service-owned monitoring API.
- **Logging:** the service preserves the selected log level, boolean DNS logging and native address-mask mode. Destinations remain service-owned; arbitrary file paths and access logging stay disabled. DNS logging is opt-in and can contain queried names. Address masking is not log encryption.

## Settings owned elsewhere or intentionally excluded

DNS query strategy, cache, hosts, request-type rules, resolver groups/preferences, expected/unexpected answer IPs and fallback/timeout settings already live in the native DNS handler/filter/server nodes. The defaults dialog links directly to the handler instead of introducing a second authoritative copy.

Network selection, server address/port, transport host/path/service name, Hysteria authentication/hopping ports, VLESS UUID/encryption/flow/email, server verification identity, node tag, listener authentication/ports, Direct redirect/PROXY protocol and Block response are node-specific. Shared settings are exposed only for implemented node kinds. Server-side VLESS/TLS/REALITY parameters are outside a client-defaults menu.

v2rayN UI/theme/autostart/update settings, subscription HTTP User-Agent, sing-box cache/TUN/Hysteria protocol settings, Windows adapter DNS, transparent capture and OS proxy activation are not Xray defaults. Windows proxy activation remains the explicit runtime lease action. Native API/control listeners, arbitrary elevated actions/log paths and server-side control features are not added by this menu. Removed domainMatcher, old KCP read/write-buffer fields and the legacy KCP header/seed shape are not offered as live current-core controls.

## Persistence

The defaults refinement uses shared provenance controls across the inspector, protocol and capture editors. A retained native omission displays the contextual Xray hint, not its encoded graph placeholder. Use default shows the graph default it will adopt; Override keeps the current configured value. An explicit zero sentinel remains zero with its effective behavior explained. Per-account values stay inspectable in their native account controls. See [validation](../development/testing.md) for current verification and limits.

Native projections optionally store `editedKeys` to retain deliberate shared-field edits, including values equal to import placeholders. Individual or bulk reset clears that intent. In protocol editors, named and native JSON drafts synchronize so the latest edit wins, including explicit omission. Optional blank values and missing properties are kept distinct; their advanced-JSON interactions are reported from the emitted configuration rather than guessed from encoded values.

Graph format is wayrill.graph version 2. A required defaults object has version 1 and a typed settings map. Each node stores an overrides array of its inheritable node-field keys and its effective settings. Export, reopen, local caching, duplication and undo/redo preserve inheritance. Unknown fields/types or invalid/duplicate override keys are rejected.

Files missing workspace defaults or per-node override arrays are rejected, as are retired node kinds and legacy DNS plans. Protected-storage failures preserve the original slot and block automatic overwrite until recovery. See [protected storage](../guide/stash.md), [cleanup](../development/releasing.md) and [the current review](../development/testing.md).

## Core controls and native imports

Global Defaults now includes metrics enable/tag/listen controls and a policy-level form alongside Policy JSON. SOCKS outbounds share transport/security/mux/socket defaults with VLESS; mixed inputs share UDP/sniffing/policy/stream defaults with other inputs. Native imports hydrate core policy, statistics, metrics, logging and routing defaults from the source. The core-options editor and global menu synchronize their edits atomically, with Undo. DNS controls remain in their handler/server nodes.

Imported input/outbound settings are explicit overrides. An unchanged export preserves native omissions; choosing Use default deliberately reapplies the effective global value, even when a placeholder looked equal. Clearing a core field keeps it omitted. Tag-only metrics preserves native routing; the service restricts a separate listener to an unused loopback port at least 1024. Extended native fields remain in their JSON tabs. See [XRAY-IMPORT.md](xray-import.md).

## Additional protocol scopes

The preceding tables describe the earlier scopes. The app now displays current scopes for all registered protocol nodes: sniffing and listener stream settings for new inputs; applicable client TLS/User-Agent, transport, mux and socket defaults for new outbounds; policy levels for Tunnel/TUN/DNS and supported client/account layouts. Imported omissions/overrides remain preserved until edited/reset. Named values take precedence over additional JSON. MASQUE receives no mux defaults. Hysteria hopping uses FinalMask UDP masks, and shared bandwidth uses QUIC brutalUp/brutalDown. Credentials/peers/adapters remain node-specific. See [PROTOCOL-NODES.md](protocols.md).

## Resource files

See [shared resource files](../guide/resources-defaults.md). Resource selections are defaults shared by all filters. The service exposes resources.status, resources.configure {files}, resources.update {files}, resources.ensure {files,required}, resources.uploadBegin {file,kind,bytes}, resources.uploadChunk {upload,offset,hex}, resources.uploadCommit {upload}, and resources.uploadCancel {upload}. Plans contain file, kind, url, autoUpdate, intervalHours, fetchOnUse. Successful preparation strips frontend-only plans before the existing config API call. Status includes busy, generation, files with presence/update/error metadata, and restartRequired. Events resources.updated/resources.failed contain filenames and success only. Binary validation, serialized updates, bounded upload leases and transaction recovery happen in the service. API v1 is unchanged; service.hello advertises resources.management.

## Windows socket buffering

Factory settings request 256 KiB UDP receive/send buffers through ordinary input
stream options and outbound socket options. They use native customSockopt entries
scoped to system=windows and network=udp (SOL_SOCKET 65535; SO_RCVBUF 4098 /
SO_SNDBUF 4097). TCP keeps Windows defaults unless explicitly overridden.

Wayrill also registers a 256 KiB process-wide UDP listener default through Xray's
public listener controller. Ordinary inbound overrides run afterwards. Removing
an authored UDP option therefore retains the listener default; it does not remove
the initializer. SOCKS/Mixed UDP associations ignore their inbound sockopts in
upstream Xray and always use this shared default. Their TCP listener remains
configurable. Service-owned TUN/ICS and outbound-test cores include the initializer.

Compatible inbound editors expose separate TCP/UDP receive/send controls in bytes;
Proxy provides its TCP controls in Properties. Existing native options and imported
omissions are retained until an edit. See [protocol nodes](protocols.md) and
[UDP loss](../development/xray-customizations.md) for precedence, controls, tests and measurement limits.

These bounded buffers absorb short bursts; they cannot make an overloaded path
loss-free or add congestion control to an arbitrary UDP application.

## UDP listener buffers

Traffic sources & name detection includes independent receive/send buffers in KiB. The app factory value is 256 KiB for each; zero or Use Xray default leaves the Windows default unchanged. These graph-wide values also reach internal TUN/ICS and capture relays and isolated outbound tests. Save defaults edits the draft; Apply/Start replaces sockets through the existing guarded lifecycle. Ordinary explicit listener socket options take precedence. SOCKS UDP associations have no per-inbound override in upstream Xray and use these shared values. See [UDP-LOSS.md](../development/xray-customizations.md).
