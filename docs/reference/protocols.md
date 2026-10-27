# Xray protocol nodes

Settings are arranged by purpose, with optional tuning in collapsed **Advanced** groups. Configured values are summarized and retained; search/error navigation reveals the relevant control. See [SETTINGS-LAYOUT.md](../guide/graphs.md).

Wayrill represents every inbound and outbound registration in the pinned Xray 26.10.21 base (with the audited integrations in CORE-INTEGRATION.md), commit `1b1647cd9ddf0abc34b981d4611fc03bcac1ca74`. The authoritative registry is [infra/conf/xray.go](https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/infra/conf/xray.go).

| Direction | Families | Preserved aliases |
| --- | --- | --- |
| Inbound | Tunnel, Proxy (HTTP/SOCKS/Mixed), VLESS, VMess, Trojan, Shadowsocks, WireGuard, Hysteria 2, MASQUE, TUN | `dokodemo-door`, `mixed`, `socks` |
| Outbound | Direct, Block, Loopback, HTTP CONNECT, Shadowsocks, SOCKS, VLESS, VMess, Trojan, Hysteria 2, MASQUE, DNS, WireGuard | `direct`/`freedom`, `block`/`blackhole` |

These are 13 inbound and 15 outbound protocol strings. SOCKS and Mixed use the same core implementation. Hysteria is version 2; this core has no TUIC, ShadowsocksR, standalone TLS or standalone REALITY proxy registration. Transports and security stay inside protocol nodes.

## Editing

New protocol nodes have an atomic edit window with Listener & accounts or Server & account, Transport & security, Name detection or Connections & mux, Global defaults and Native JSON tabs. Account, peer, fallback, endpoint and certificate collections preserve order; add, remove and reorder entries before Apply. Cancel discards the whole draft. Password controls hide simple credential fields. Explicit empty strings, false, zero and omitted native fields remain distinct.

The field catalogue is generated from 68 audited Go/account structures with 459 fields. It covers protocol settings, legacy endpoint/account layouts, RAW/TCP, WebSocket, HTTP Upgrade, gRPC, XHTTP/SplitHTTP, mKCP, Hysteria, MASQUE and XDrive transports; TLS/REALITY, certificates, sockets, sniffing, mux and FinalMask/QUIC parameters. Custom mask bodies and extensible native objects remain JSON fields. The pinned core’s own validation remains authoritative for combinations and platform support.

Regenerate only after auditing a core upgrade. Use an exact Git checkout whose HEAD matches `service/dependencies.json`, prepared with the reviewed main-core integrations described in [CORE-INTEGRATION.md](../development/xray-integration.md). Review the generator's pinned-commit guard with the upgrade; do not use the old references folder or private TUN hook tree:

```powershell
$XraySource = 'C:\path\to\audited-main-Xray-source'
python tools/Generate-ProtocolSchema.py --source $XraySource
```

Source-specific fields include Tunnel rewrite/capture behavior; VLESS decryption/accounts/fallbacks; VMess accounts/defaults; Trojan accounts/fallbacks; Shadowsocks cipher and account layouts; WireGuard private key, addresses, peers, allowed IPs, reserved bytes, MTU and remote DNS; Hysteria 2 accounts and QUIC transport authentication; MASQUE accounts, address prefixes, MTU and CONNECT-IP transport credentials; TUN adapter/gateway/DNS/route/WFP controls; Loopback reinjection tag; and DNS outbound rewriting/request policies. A DNS outbound handles routed query traffic; it does not replace the global resolver node.

Applicable global settings use the existing override badges and Use default actions. Server identities, accounts, keys, peer lists and adapter settings stay specific to the node. Imported values and omissions remain unchanged until explicitly edited/reset. Shared settings apply only to active transports, with named defaults taking precedence over overlapping additional JSON. MASQUE does not receive mux defaults. WireGuard uses Xray’s userspace stack on Windows.

## Graphs, profiles and subscriptions

All new nodes participate in palette search, selection, duplication, undo, graph save/open, typed connections, filter outputs, policy-group membership, Xray previews, import/export and runtime compilation. New socket inputs use one Traffic connection; native import retains the global ordered rule list and does not invent DNS classifiers. Loopback references follow unchanged imported input-tag renames; diagnostics detect certain reinjection loops and warn about conditional cycles.

The configuration stash accepts all registered outbound configurations, including extended JSON fields and legacy endpoint arrays. Assigning a profile replaces one node while retaining its identity, position, tag and wires. Adding a stashed profile creates a linked graph instance. Edits update the shared Stash definition; its graph tag, position and incoming wires remain local. Duplication creates an independent manual definition. See [Stash editing](../guide/stash.md). Large subscription groups stay outside the canvas. Share-link parsers cover VLESS, VMess JSON/Base64, Trojan, SIP002/legacy Shadowsocks, SOCKS/SOCKS5, HTTP/HTTPS, WireGuard and Hysteria2/hy2. A Wayrill MASQUE URI uses username/password plus mapped stream parameters; it is not asserted to be an industry interchange standard. Xray JSON remains the full fidelity path.

Unmapped parameters, ambiguous repeated parameters, old VMess alterId, Shadowsocks plugins and removed insecure TLS are reported; original rows stay in the stash. Imports never silently discard them or start networking. Native graph/config exports contain credentials; Windows workspace storage remains current-user DPAPI protected.

## Service boundaries

API v1 `service.hello` adds capability `xray.protocols` and `protocols: { inbound: string[], outbound: string[], adapterRuntime: true }`. The frontend checks advertised registrations before activation. Socket protocols run under a restricted owner token, or restricted LocalService token when startup routing is enabled, in a kill-on-close job. Fixed TCP and UDP endpoints receive separate conflict/startup checks; SOCKS/Mixed UDP association sockets are created on ephemeral ports per request and are excluded from fixed-port readiness; a TCP and UDP listener may share a numeric port. Failed activation retains/restores the previous applied profile and owned settings according to the existing journal.

Executed socket inputs accept explicit IPv4/IPv6 listeners, wildcard addresses and one integer port 1–65535 (see [LISTENERS.md](../guide/capture.md)), a unique tag, at most 16 inputs and 16,384 outbounds, and at most 16 MiB of complete JSON. Export may retain broader native listeners. Service log sinks remain owned and arbitrary core API/root sections remain rejected. Source registration does not imply that every transport/option combination is valid.

**TUN supports service-managed execution.** The service acquires only its owned adapter (retained and reused by default, disposable when configured); a constrained worker configures its routes/DNS while remote protocols remain in the restricted main core. See [TUN.md](../guide/capture.md) for setup and supported boundaries. Tunnel `followRedirect` also does not install transparent capture. WinDivert inputs use the separately owned capture worker and plan; see [WINDOWS-CAPTURE.md](../development/windows-capture.md). Stop removes owned routes/settings and disables retained adapters; disposable mode deletes only its owned adapter. Foreign VPN adapters are not adopted or removed.

The pinned Freedom implementation blocks private destinations by default for several server-side protocols. Explicit `finalRules` are preserved through Direct additional settings/import/export. Wayrill does not silently allow LAN or loopback targets for these server configurations. Userspace WireGuard/MASQUE IP stacks also reject loopback destinations inside tunnel packets; their QA uses virtual tunnel addresses rewritten to the scoped local test servers.

See [testing](../development/testing.md) for the required distinction between protocol configuration checks and executed Windows traffic scenarios.

## Local capture and listener groups

The node library groups WinDivert, host TUN and ICS TUN under **Local capture**. Their cards, configuration tags and editors use capture terminology. Socket listeners, including Proxy, Tunnel (dokodemo-door), and MASQUE, remain in **Inbounds**. Xray protocol registrations, core inbound arrays/tags, graph kind identifiers, routing and typed connection behavior retain their actual technical semantics. This is a UI classification; protocol registrations retain their core semantics.

## Windows listener buffers

Socket inbounds expose **Advanced - Socket buffers** in their native editor's
Name detection tab; Proxy exposes the same controls in Properties. Receive and
send sizes use bytes and map to Windows SOL_SOCKET SO_RCVBUF / SO_SNDBUF through
standard `streamSettings.sockopt.customSockopt` entries. Fields follow the actual
TCP/UDP listener transports, including mKCP, Hysteria, WireGuard, XHTTP/3 and
MASQUE's ALPN selection; TUN adapter nodes have no socket-buffer form.

Unspecified TCP keeps Windows defaults. UDP listeners inherit Wayrill's 262144-byte
initializer unless a configured option overrides it. QUIC libraries may enlarge
socket buffers further. SOCKS/Mixed UDP ASSOCIATE ignores inbound socket options
upstream and uses process-wide 256 KiB defaults; its editor exposes TCP listener
tuning and explains the UDP boundary instead of offering an ineffective control.

Edits retain unrelated, wildcard, per-address-family and non-Windows native socket
options. Clearing removes that Windows protocol-wide override; existing generic
or per-family options remain effective. Different IPv4/IPv6 values are shown as a
native-value hint until deliberately overridden. Editing one field retains the
other currently inherited stream defaults. Imported JSON remains unchanged until
an edit is made.
