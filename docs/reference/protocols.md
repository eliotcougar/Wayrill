# Protocols and native settings

Wayrill's first beta uses a pinned, customized **Xray 26.10.21**. The following
families have node editors. A valid combination still depends on the selected
transport, security mode, peer and Windows runtime support.

## Choose the right node

| Role | Available families |
| --- | --- |
| **Inbounds** | Proxy (SOCKS / HTTP / Mixed), Tunnel, VLESS, VMess, Trojan, Shadowsocks, WireGuard, Hysteria 2 and MASQUE. |
| **Local capture** | Host TUN, ICS TUN and WinDivert. |
| **Outbounds** | Direct, Block, Loopback, HTTP CONNECT, SOCKS, VLESS, VMess, Trojan, Shadowsocks, WireGuard, Hysteria 2, MASQUE and DNS. Policy groups and proxy chains are reusable outbound choices too. |

Some similar names have different jobs:

- **Proxy** combines the SOCKS/HTTP/Mixed listener modes in one node type.
- **Tunnel** is Xray's fixed-destination/redirect listener, also known as
  `dokodemo-door`. It is different from the host TUN adapter.
- **MASQUE inbound** accepts compatible protocol clients. Adding it does not
  capture this PC's ordinary traffic like a Local capture node does.
- **DNS outbound** handles routed DNS-query traffic. The **DNS handler** selects
  how the resolver module answers names; they are separate functions.
- **TLS and REALITY** are security settings inside compatible protocol nodes,
  not independent proxy protocols.

The pinned core includes Hysteria 2, not TUIC or ShadowsocksR. Use
[Xray JSON import](xray-import.md) when moving a complete native configuration;
imported aliases retain their supported native spelling.

## Edit a protocol

Double-click the node or use its context menu. Editors group settings by task:
listener/accounts or server/account, transport/security, name detection or
connections/mux, defaults and Native JSON. Available controls depend on the
protocol. Lists such as accounts, peers, certificates and fallbacks keep their
order and can be edited before accepting the whole change.

Start with a provider's working profile. Address, port, account identifiers,
keys, transport and TLS/REALITY server settings must agree with the peer. Do not
fill an empty field just because a hint displays a default; an omitted field and
an explicit value can have different meanings.

Common tuning can inherit [Global defaults](defaults-catalog.md). Credentials,
peer identities and adapter choices remain node-specific. Named controls and
Native JSON retain supported imported values and extended settings. If you edit
both representations, review the resulting values and Validate before applying.

RAW/TCP, WebSocket, HTTP Upgrade, gRPC, XHTTP/SplitHTTP, mKCP, Hysteria, MASQUE and
XDrive transport fields are represented where supported by the pinned core.
FinalMask and other extensible objects may need JSON. A transport's presence in
the editor does not make every security/protocol pairing valid.

## Listener addresses and access

Executed socket inbounds accept explicit IPv4/IPv6 addresses, wildcard listeners
and one integer port from **1 to 65535**. Localhost is the usual choice for an
app running on this PC. For external clients, choose the correct listen address,
authentication and firewall access.

An optional metrics HTTP listener has a narrower boundary: an unused loopback
port from **1024 to 65535**. Tag-only metrics can use routing instead. The
service manages log destinations and its own control endpoints.

TUN and WinDivert need [Local capture setup](../guide/capture.md); a protocol
listener's redirect option does not install system packet capture. WireGuard
uses Xray's userspace implementation on Windows.

## Socket buffers

Compatible socket inbound editors have **Advanced → Socket buffers** under name
detection; Proxy exposes its applicable listener controls in Properties. These
per-listener receive/send fields use **bytes**. The graph-wide UDP listener
controls in Global defaults use **KiB**.

The editor offers controls for the actual listener transport. SOCKS/Mixed UDP
associations use the shared UDP listener defaults because upstream Xray does not
apply per-inbound socket options to those association sockets. Setting a Proxy
TCP buffer is not a way to change its UDP buffer.

Existing per-address-family, wildcard and non-Windows native socket options are
retained. Clearing one named Windows override does not erase unrelated native
options. QUIC libraries may also adjust their socket buffers. See
[UDP listener defaults](defaults-catalog.md#udp-listener-buffers) for inheritance
and activation.

## Validate and test

Run Check, then Validate, then activate the graph. Configuration acceptance is
followed by a separate [outbound test](../guide/testing-statistics.md) and a real
client request. A SOCKS5 UDP test requires a working UDP path through the chosen
server; there is no separate invented outbound UDP switch to enable it.

For server-style use, review the protocol's native access rules as well as
Wayrill's graph. The pinned Direct/Freedom implementation has private-destination
restrictions for some server-side protocols. Preserved `finalRules` and embedded
IP-stack restrictions can affect LAN or loopback targets.

See [execution limits](limits.md) and the
[core customization inventory](../development/xray-customizations.md) for the
exact integration boundary. Contributors maintain the field/default catalogues
as part of a [core upgrade](../development/core-defaults.md).
