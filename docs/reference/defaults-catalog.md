# Defaults and inheritance

Use **Settings → Global defaults…** to set values shared by compatible nodes.
This reference explains which value wins and where to find common controls in
the first beta. For resource management, see
[Resource files and defaults](../guide/resources-defaults.md).

## Which value will a node use?

The order is:

1. An explicit setting on the node.
2. A configured value in the graph's Global defaults.
3. The embedded Xray core's own default when neither specifies a value.

An unset field shows the effective default as a pale italic hint. The node's
state identifies **App default**, **Xray default** or **Overridden**. A value can
be overridden even when it happens to equal the current default.

**Override** makes the current setting independent. **Use default** removes its
override and adopts the current inherited value. **Use all global defaults**
clears the node's inheritable overrides. These actions retain its server,
credentials, identity, transport choice, listener and routing connections.

An explicit zero, false or empty string can differ from an omitted field. Use
the reset/default action when your intention is inheritance; do not enter zero
as a generic way to clear a value.

## Where to find settings

| Category | Typical controls and purpose |
| --- | --- |
| **Resource files** | Select default GeoSite/GeoIP files and manage sources/updates. Also accessible from Settings → Resource files…. |
| **Traffic sources & name detection** | SOCKS UDP, HTTP/TLS/QUIC name detection, routing-only inspection, exclusions, policy level and shared UDP listener buffers. |
| **TLS & User-Agent** | Client fingerprint, TLS versions/ALPN and transport User-Agent headers where applicable. Server identities and keys stay on each node. |
| **Multiplexing** | Mux and XUDP settings for compatible protocols. Transport-specific multiplexing may have separate controls. |
| **Fragmentation** | Compatible secured-connection and client-traffic fragmentation stages. |
| **Connections & DNS strategy** | Interface/source binding, keepalive/socket choices and DNS strategies used when connecting to a remote server or Direct destination. |
| **Transport tuning** | Settings for the selected transport, such as WebSocket, gRPC, XHTTP, mKCP or Hysteria. |
| **Additional core options** | Shared native JSON settings for cases beyond the named controls. |
| **Core, routing & policy** | Logging, routing-domain strategy, native statistics/metrics and policy levels. |
| **Traffic display** | Display units for traffic measurements. |

Use the search field to locate a setting by name, transport or scope. Controls
apply only to compatible protocols and active transports. An inactive transport's
saved settings can remain available without affecting the current transport.

DNS servers, request policies and resolver preferences belong to the
[DNS nodes](../guide/dns.md), rather than a separate DNS setup wizard in Global
defaults. Routing-domain strategy controls lookups made while evaluating IP
rules; it is separate from an outbound's destination/server DNS strategy.

## Save or reset defaults

The window edits a draft. **Cancel** discards it; **Save defaults** accepts the
change into the graph. Check/Validate, then Start/Apply to change the running
configuration. Changing a global value updates inheriting fields and retains
explicit node overrides. Undo/Redo includes values and inheritance state.

**Use Xray default** removes one app value. **Use all Xray defaults** clears the
shared app values. **Factory defaults** restores Wayrill's presets; it does not
erase each node's explicit overrides. Defaults travel with the graph/backup, so
review them when loading another configuration.

Configuration-wide logging, routing strategy and policy are shared core options,
not independent copies on every node. Native core-options edits and these
defaults stay synchronized. Arbitrary log-file destinations are not exposed:
the service collects logs in its managed directories.

## UDP listener buffers

**UDP listener receive buffer (KiB)** and **UDP listener send buffer (KiB)** are
under Traffic sources & name detection. Wayrill's factory preset is **256 KiB**
for each. Zero or Use Xray default leaves the Windows default unchanged.

These shared values also reach internal TUN/ICS relays and isolated outbound
tests. Explicit compatible listener socket options take precedence. SOCKS/Mixed
UDP associations use the shared values because upstream Xray does not apply
their per-inbound socket options to those association sockets. TCP keeps its
Windows defaults unless an explicit compatible socket option changes them.

Apply/Start recreates the affected sockets through the normal activation path.
Larger buffers can absorb bursts; they do not add congestion control or guarantee
loss-free delivery on an overloaded path. For listener controls in bytes and
native-family overrides, see [Protocol settings](protocols.md).

## Imported configurations

An unedited native import preserves its original omissions and explicit values.
The hint is explanatory, not a request to fill every omitted field. Editing an
inheritable setting makes that choice explicit; Use default deliberately adopts
the current graph/core value. Clearing a native field can preserve omission.

Named controls take precedence over overlapping shared additional JSON. Avoid
specifying the same option in both places unless you intend that precedence.
Native JSON and typed controls preserve supported explicit false/zero/empty
values; see [Xray import/export](xray-import.md).

The beta's core-default information is tied to **Xray 26.10.29** and its pinned
source. The [shared setting definitions](../../src/graph/defaults.ts) record the
current app presets and applicable node scopes; the
[core defaults store](../../src/graph/xrayCoreDefaults.json) records native hints
and their source references. Core upgrades require reviewing that information.
Contributors can find the audit and generation workflow in
[Core default maintenance](../development/core-defaults.md).
