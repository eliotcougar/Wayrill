# Custom Xray change inventory

This is the maintained inventory of changes compiled into Wayrill's Xray
executables. It covers patches, added Go files and build-script edits. Existing
upstream APIs used by Wayrill are identified separately from custom APIs.

Last reconciled: **30 October 2026**, the pinned core build. PR states below were
checked on GitHub on that date. They describe upstream publication, not whether
a change is compiled into Wayrill.

## Build baseline and scope

| Item | Current source of truth |
| --- | --- |
| Upstream base | Xray **v26.10.29**, commit `0afec66085a85191e9dd2a4a6646c7c9a94688d1` |
| Main executable | `xray.exe`; upstream base plus the shared patch and socket initializer |
| Private worker executable | `wayrill-tun.exe`; main-core changes plus TUN hooks and helper commands |
| Shared FakeDNS authority | Separate restricted process running `wayrill-tun.exe wayrill-fakedns`; not a third independently maintained binary |
| Patch | [service/xray-patches/shared-fakedns.patch](../../service/xray-patches/shared-fakedns.patch) |
| Initializers and additions | [core-init](../../service/core-init), [core-control](../../service/core-control), [tun-core](../../service/tun-core) |
| Application of every change | [tools/Build-XrayCores.ps1](../../tools/Build-XrayCores.ps1) |
| Main/source/patch/SDK/Wintun pins | [service/dependencies.json](../../service/dependencies.json) |
| Private worker identity | [tun-core-manifest.json](../../service/daemon/src/tun-core-manifest.json) |

Both executable variants are custom source builds using Go **1.27.3**. A public
Go extension hook still requires linked executable code; it cannot be injected
into the official release binary. Exact current hashes belong in the manifests
above rather than a second manually maintained hash table here.

The patch's name is historical: it includes real-DNS cancellation, allocator
correctness and telemetry as well as shared FakeDNS. The patch currently covers
**35 paths**, including tests and generated bindings. The builder also copies
**11 Go files** and edits **three additional upstream TUN files**. The complete
file index below makes those less visible changes reviewable.

## Active changes

“Shared” means both executable variants. “Worker” means the private worker only.

| ID | Change | Scope | Upstream relationship |
| --- | --- | --- | --- |
| X01 | Configurable UDP listener buffers | Shared | Uses existing public listener-controller hook; app-owned initializer |
| X02 | Independent DNS waiter deadlines and query ownership | Shared | Private; related focused PR [#7244](https://github.com/XTLS/Xray-core/pull/7244) is closed, unmerged |
| X03 | Cancellable native DNS lookup entrypoint | Shared | Private optional implementation method; stable `dns.Client` remains unchanged |
| X04 | Shared FakeDNS mapping transport and remote engine | Shared | Private authenticated implementation; general proposal [#7272](https://github.com/XTLS/Xray-core/pull/7272) is closed, unmerged |
| X05 | Request-aware native FakeDNS calls | Shared | Private optional capability/call sites; associated with X04 |
| X06 | Native resolver bridge between cores | Shared | Private protocol and server scheme; not an upstream DNS protocol |
| X07 | FakeDNS allocator correctness and safe inspection | Shared | Private address-width, publication and locking corrections |
| X08 | Exact FakeDNS occupancy telemetry | Shared | Private; independent proposal [#7271](https://github.com/XTLS/Xray-core/pull/7271) is closed, unmerged |
| X09 | TUN process, shared-IPv6 and Windows NAT attribution | Worker | Private Windows integration with Wayrill's separate Rust companion |
| X10 | Reopen TUN without reapplying owned Windows settings | Worker | Private service-authorized reuse flag and native setup bypass |
| X11 | Real, upstream-bound ICMP echo through TUN | Worker | Private Windows implementation and packet-stack hooks |
| X12 | Routing-control and FakeDNS authority commands | Worker | App-owned commands; routing updates use existing upstream gRPC |

### X01 — UDP listener buffers

The initializer registers `internet.RegisterListenerController` once at process
setup. For UDP sockets it reads `WAYRILL_UDP_LISTENER_RECEIVE_BYTES` and
`WAYRILL_UDP_LISTENER_SEND_BYTES`, validates them and applies Windows receive/send
buffer options. It contains no hardcoded buffer-size default. Global Defaults
and the compiled graph supply the app values; absent/zero retains OS defaults.
Explicit socket options remain applied after the initializer. TCP is unchanged.

Stored in `service/core-init/udp_windows.go`, copied into upstream `main`.
This is added executable code using a supported hook, not a SOCKS source patch.
See [UDP buffers](xray-customizations.md) and [Global Defaults](../reference/defaults-catalog.md).

### X02 — Native DNS waiter ownership and timeouts

Native DNS work is coalesced per nameserver, domain and address family. Each
waiter retains its own deadline; the shared work survives while another waiter
needs it. The last waiter leaving or DNS shutdown cancels it. Work has an
eight-second bound, extended for a longer configured nameserver timeout.
Completed A/AAAA results survive the other family's timeout. Cancellation closes
an owned TCP DNS connection. Single-family TTLs and existing dual-stack TTL
semantics are preserved.

This prevents a short foreground query from waiting behind a long optimistic
cache refresh before trying a healthy fallback. The revised focused source is
[6ecd2853](https://github.com/eliotcougar/Xray-core/commit/6ecd2853f4af823312461b673ac733df21ad9754).
PR #7244 was closed before that revision was pushed; its original Files changed
view is not the revised implementation now included in Wayrill.

### X03 — Cancellable native DNS lookups

`LookupIPContext` is an optional method on the native DNS implementation. It
combines caller cancellation with the DNS module's own context, preserving the
resolver's routing metadata instead of inheriting application-flow metadata.
Cancellation reaches serial, parallel, cached and Lua query paths. The stable
context-free `dns.Client.LookupIP` contract is preserved. This does not claim to
make the OS/system resolver itself cancellable.

The private resolver and ICMP real-address lookup use this facility. An external
timeout alone would stop waiting without stopping the underlying native work.

### X04 — One shared FakeDNS allocator

Consumers implement the existing FakeDNS feature interfaces but perform
allocation/reverse lookup over reusable local gRPC connections. A separate
restricted authority owns Xray's native bounded LRU. Pool membership is local;
the allocation/reverse map is not replicated or independently cached.

`GetPools`, `Allocate` and `ReverseLookup` are private RPCs. The production
contract also includes occupancy in `GetPools`, combining X04 and X08. This
does not mean the two independent upstream proposal branches contain each other.
Wayrill injects `WAYRILL_FAKEDNS` into owned processes and validates pool geometry
before readiness. Both accepted addresses are loopback and every RPC requires
the generated secret. Admission, headers/messages, connections and deadlines
are bounded. Consumer shutdown cancels pending work and closes its connection
without closing the authority.

The Rust service owns authority retention across compatible Apply/restart and
rollback, and retirement on explicit Stop or pool replacement. Its health
supervision and unresolved-synthetic-address guard are app behavior outside the
core patch. See [FakeDNS](../guide/dns.md) and [lifecycle](lifecycle.md).

### X05 — Request-aware FakeDNS allocation and recovery

An optional `FakeDNSEngineContext` capability passes request contexts and backend
errors through allocation and reverse lookup. Native FakeDNS DNS handling and
metadata sniffing use it when present; old context-free local engines continue
working. Metadata sniffer errors propagate instead of being discarded there.

Legacy methods cannot carry request cancellation or distinguish an RPC failure
from a missing mapping. The small native call-site changes preserve those
distinctions for remote engines; the service's synthetic-address guard remains
responsible for rejecting unresolved synthetic traffic.

### X06 — Native resolver bridge

The runtime-only `wayrill-dns://` server and authenticated native resolver
handler carry address-family options, `FakeEnable`, TTL and DNS response codes
between cores. The handler is selected only on generated native-resolver inbound
tags and requires local authenticated access. Frame sizes, concurrency and query
time are bounded; cancellation interrupts unread links and active requests.

Ordinary DNS wire messages do not encode the distinction between synthetic client
answers and internal lookups needing real addresses. Losing that distinction
can feed a synthetic answer back into Direct or upstream ICMP resolution.
This is why the bridge is separate from the mapping RPCs and from normal DNS
forwarding. The private scheme cannot be selected in a saved public profile.

### X07 — FakeDNS allocator correctness

Native allocation preserves the full four-/sixteen-byte address width, including
leading-zero custom pools and wraparound. Holder initialization/publication,
membership checks and snapshots use consistent locking, including pre-start
checks. Reverse lookup releases the holder lock before invoking log callbacks,
so a callback inspecting occupancy cannot deadlock the holder.

Allocation and eviction remain owned by the native LRU. These changes are not a
second allocator or a persistent mapping database.

### X08 — Exact mapping counts

The LRU exposes a locked usage/capacity snapshot. Holders implement the optional
`FakeDNSStatsProvider`; snapshots do not allocate, change recency or expose
domains. Local pools add `fakeDns` to metrics; shared pools report usage through
their authenticated `GetPools` response. Missing/uninitialized usage is not
reported as a misleading zero. An IPv4 and IPv6 mapping each consume a slot.

The app's counter display/collection lives in Wayrill, not this core change.
This is the production combination of occupancy and shared transport; neither
is available as an API in the unmodified pinned upstream executable.

### X09 — TUN attribution

Before native dispatch, the worker calls Wayrill's bounded authenticated loopback
attribution companion. It assigns the returned routing identity to the inbound
user and rejects failures rather than silently using ordinary unmatched traffic.
The companion's policy can explicitly authorize an ambiguous result.

The same hook distinguishes shared IPv6 traffic and proven Windows NAT sessions.
For NAT, it changes routing source/tag metadata while retaining packet-stack wire
endpoints for replies. IPv6 literals use plain address syntax on the wire.
The ETW/process tree, services, package lookup, NAT inventory, ambiguity policy
and rule-mask computation remain in the separate Rust service/capture code.
They are not new native Xray process matchers.

Added by the builder to `proxy/tun/handler.go`, implemented by
`service/tun-core/wayrill_windows.go`. See [TUN](../guide/capture.md).

### X10 — Retained adapter settings

`WAYRILL_TUN_REUSE_SETTINGS=1` is supplied only after the service proves owned
addresses, routes and native settings. In that mode the worker skips redundant
Windows setup writes, DNS registration changes and DNS cache flushing. Its
packet-stack gateways and process-local DNS exclusions/controllers still start.

Stock Xray already reopens a named Wintun adapter. This customization preserves
its native configuration during compatible core replacement; it is not the
basic ability to reuse an adapter. Ownership, rename/delete UI, Windows journals
and ICS handoff/recovery remain Rust service responsibilities.

Added by the builder to `proxy/tun/tun_windows.go`, using the flag helper in
`service/tun-core/wayrill_windows.go`. See [live Apply](lifecycle.md).

### X11 — Real ICMP passthrough

The lightweight stack attaches ICMP interception only to a real TUN handler.
Echo requests use bounded, source-bound Windows upstream echo calls, with native
reply validation, loop protection, cancellation/draining and error translation.
Malformed requests cannot fall back to locally fabricated echo replies. Other
ICMP/PMTU behavior and WireGuard/MASQUE stack users retain upstream handling.

A known synthetic destination is reverse-mapped, resolved with `FakeEnable=false`
and pinged through the physical upstream. Unknown mappings and failed native
echoes produce no fabricated success. This implements the chosen unconditional
Direct-upstream ICMP policy, not ICMP carried through every proxy protocol.

Added by the builder to `proxy/tun/stack.go` and the two ICMP Go additions.

Error replies preserve a bounded quote of the original request: the IPv4 header
and eight payload bytes for IPv4, and at most 1,232 quoted bytes for IPv6. The
IPv6 reply, including its outer header, fits the 1,280-byte minimum MTU. The
maintained ICMP regression checks short, Ethernet-sized and maximum-sized request
quotes for both address families.

### X12 — Private executable commands

- `wayrill-control` is a bounded client of upstream `RoutingService`, reached
  through Wayrill's authenticated local SOCKS route. It prepares candidate and
  rollback table sizes against the server limit, applies `AddRule` when requested
  and checks the channel with `ListRule`. It adds no routing or outbound RPC.
- `wayrill-fakedns` reads a bounded configuration from stdin, starts the native
  holder, opens the authenticated mapping authority and reports readiness.

The builder copies `service/core-control/*.go` into the worker's `main` package.
These commands are not available in the official upstream executable. The main
`xray.exe` does not include them.

## Complete file index

Paths in this first table are relative to the extracted upstream source and are
delivered by `service/xray-patches/shared-fakedns.patch`. Multiple IDs indicate a
file containing more than one responsibility.

| Upstream path | Change IDs |
| --- | --- |
| `app/dispatcher/fakednssniffer.go` | X05 |
| `app/dispatcher/sniffer.go` | X05 |
| `app/dns/cache_controller.go` | X02 |
| `app/dns/dns.go` | X02, X03 |
| `app/dns/fakedns/address_width_test.go` | X07 tests |
| `app/dns/fakedns/command/command.pb.go` | X04, X08 generated binding |
| `app/dns/fakedns/command/command.proto` | X04, X08 protocol |
| `app/dns/fakedns/command/command_grpc.pb.go` | X04 generated binding |
| `app/dns/fakedns/fake.go` | X04, X07 |
| `app/dns/fakedns/logging_test.go` | X07, X08 tests |
| `app/dns/fakedns/stats.go` | X08 |
| `app/dns/fakedns/stats_test.go` | X08 tests |
| `app/dns/fakedns/wayrill_lifecycle_test.go` | X06 tests |
| `app/dns/fakedns/wayrill_native_context_test.go` | X05 tests |
| `app/dns/fakedns/wayrill_request_context_test.go` | X04, X05 tests |
| `app/dns/fakedns/wayrill_resolver.go` | X06 |
| `app/dns/fakedns/wayrill_resolver_test.go` | X06 tests |
| `app/dns/fakedns/wayrill_shared.go` | X04, X08 |
| `app/dns/fakedns/wayrill_shared_test.go` | X04 tests |
| `app/dns/fakedns/wayrill_usage_test.go` | X04, X08 tests |
| `app/dns/nameserver.go` | X02, X06 |
| `app/dns/nameserver_cached.go` | X02 |
| `app/dns/nameserver_fakedns.go` | X05 |
| `app/dns/nameserver_tcp.go` | X02 |
| `app/dns/query_group.go` | X02 |
| `app/dns/script.go` | X03 |
| `app/dns/wayrill_cached_context_test.go` | X02, X03 tests |
| `app/dns/wayrill_context_test.go` | X03 tests |
| `app/dns/wayrill_query_group_test.go` | X02 tests |
| `app/dns/wayrill_shared_ttl_test.go` | X02 tests |
| `app/metrics/metrics.go` | X08 |
| `app/metrics/wayrill_usage_test.go` | X08 tests |
| `common/cache/wayrill_usage.go` | X08 |
| `features/dns/fakedns.go` | X05, X08 |
| `proxy/dns/dns.go` | X06 |

The remaining core additions are stored in Wayrill. Tests are compiled only into
test binaries. Core builds discover regression cases from these maintained test
files and the patch's test files, plus the upstream Lua DNS compatibility control.
Broad upstream test audits remain separate from the contributor build gate.

| Wayrill source | Upstream destination | IDs |
| --- | --- | --- |
| `service/core-init/udp_windows.go` | `main/wayrill_init_udp_windows.go` | X01 |
| `service/core-init/udp_windows_test.go` | `main/wayrill_init_udp_windows_test.go` | X01 and merged UDP repair tests |
| `service/core-control/fakedns.go` | `main/wayrill_control_fakedns.go` | X12 |
| `service/core-control/main.go` | `main/wayrill_control_main.go` | X12 |
| `service/core-control/main_test.go` | `main/wayrill_control_main_test.go` | X12 tests |
| `service/core-control/routing_test.go` | `main/wayrill_control_routing_test.go` | X12 tests |
| `service/tun-core/wayrill_windows.go` | `proxy/tun/wayrill_windows.go` | X09, X10 |
| `service/tun-core/wayrill_windows_test.go` | `proxy/tun/wayrill_windows_test.go` | X09, X10 tests |
| `service/tun-core/wayrill_icmp_windows.go` | `proxy/tun/wayrill_icmp_windows.go` | X11 |
| `service/tun-core/wayrill_icmp_stack_windows.go` | `proxy/tun/wayrill_icmp_stack_windows.go` | X11 |
| `service/tun-core/wayrill_icmp_test.go` | `proxy/tun/wayrill_icmp_test.go` | X11 deterministic packet/lifecycle tests; native uplink probes are maintained privately |

| Additional upstream file edited by the builder | IDs |
| --- | --- |
| `proxy/tun/handler.go` | X09: pre-dispatch identity hook |
| `proxy/tun/stack.go` | X11: ownership, echo interception and shutdown |
| `proxy/tun/tun_windows.go` | X10: native settings reuse |

The builder also sets the main executable's `core.build` version marker to the
pinned `Wayrill-socket-defaults` label. That label is not a complete list of its
features. The private worker uses the upstream default build marker; its actual
identity is the pinned executable hash. Both source archives contain the exact
corresponding source for their executable variant.

## Merged, removed and unshipped work

| Work | Current disposition |
| --- | --- |
| UDP dialer controllers receiving the remote destination | [#7201](https://github.com/XTLS/Xray-core/pull/7201) merged; included in the pinned base. No separate active backport; regression remains in X01's test file. |
| Early SOCKS UDP association timer initialization | Fangliding's [#7203](https://github.com/XTLS/Xray-core/pull/7203) merged; included in the pinned base. Older local cleanup/timer workarounds and backport removed; regression retained. |
| Windows single-family interface binding | [#7214](https://github.com/XTLS/Xray-core/pull/7214) merged and included in v26.10.29. Both cores use upstream's family-restricted retry and TUN binding implementation, without a local backport. The build runs upstream's UDP binding regression. |
| Live outbound replacement engine / `ReplaceOutbounds` / `AlterOutbound` wrapper | Removed from the packaged cores. Outbound changes use the service's guarded core restart; do not treat old proposal branches or reports as shipped functionality. |
| Dedicated UDP sockopts proposal | Not shipped as a new Xray configuration API. Current listener behavior is X01 using the existing hook. |
| gVisor-era TUN/ICMP integration | Retired. The pinned core uses the lightweight stack; the builder rejects gVisor packages in the Windows runtime dependency graph. An indirect module used by upstream tests is not evidence that it is linked into the executable. |
| Separate app-owned Go extension module | Audit/prototype only; migration **shelved**. The current build layout remains authoritative. See [boundary audit](xray-integration.md). |
