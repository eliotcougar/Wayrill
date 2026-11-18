# Custom Xray change inventory

This is the maintained inventory of changes compiled into Wayrill's Xray
executables. It covers patches, added Go files and build-script edits. Existing
upstream APIs used by Wayrill are identified separately from custom APIs.

The patch inventory tracks the pinned build below. The upstream PR status
notes record the state at the time of their review.

## Build baseline and scope

| Item | Current source of truth |
| --- | --- |
| Upstream base | Xray **v26.11.9**, commit `676eaf66f8f05d4d558ee7a74b4736623d3feeb9` |
| Main executable | `xray.exe`; upstream base plus the shared patches and socket initializer |
| Private worker executable | `wayrill-tun.exe`; main-core changes plus TUN hooks and helper commands |
| Shared FakeDNS authority | Separate restricted process running `wayrill-tun.exe wayrill-fakedns`; not a third independently maintained binary |
| Patches | [Shared FakeDNS](../../service/xray-patches/shared-fakedns.patch), [relay telemetry](../../service/xray-patches/relay-telemetry.patch), [uTLS handshake timeout](../../service/xray-patches/utls-handshake-timeout.patch), [resolver activity](../../service/xray-patches/resolver-activity.patch), [UDP association and datagram handling](../../service/xray-patches/udp-safety.patch) |
| Private worker patch | [Attributed UDP routing](../../service/xray-patches/tun-udp-routes.patch) |
| Initializers and additions | [core-init](../../service/core-init), [core-control](../../service/core-control), [tun-core](../../service/tun-core) |
| Application of every change | [tools/Build-XrayCores.ps1](../../tools/Build-XrayCores.ps1) |
| Main/source/patch/SDK/Wintun pins | [service/dependencies.json](../../service/dependencies.json) |
| Private worker identity | [tun-core-manifest.json](../../service/daemon/src/tun-core-manifest.json) |

Both executable variants are custom source builds using Go **1.27.3**. A public
Go extension hook still requires linked executable code; it cannot be injected
into the official release binary. Exact current hashes belong in the manifests
above rather than a second manually maintained hash table here.

The shared FakeDNS patch includes real-DNS cancellation, allocator
correctness and telemetry as well as shared FakeDNS. The patch currently covers
**35 paths**, including tests and generated bindings. The file index below also
lists the Go files and hooks that the builder adds to the private worker.

## Active changes

The service also instruments its runtime configuration using upstream `ruleTag`
and dispatcher Info logs, in [routing_log.rs](../../service/daemon/src/routing_log.rs).
Explicit routing rules are observed for the browser Companion. An explicit
first-outbound fallback is added only when it preserves routing semantics;
`IPIfNonMatch` keeps its implicit fallback so DNS/IP rule retry still occurs.
Script routers remain untouched and do not supply Companion observations.
Traffic-filter metadata adds
display trails; simple graphs need no filter. Instrumentation operates on the
runtime clone, preserves rule order/destinations, and requires no new core API or
binary patch. The bounded log supplies observations rather than per-tab attribution.

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
| X13 | Per-flow policy-group selection telemetry | Shared | Private loopback SOCKS relay integration |
| X14 | uTLS handshake deadline | Shared | Uses the implementation from unmerged [#7427](https://github.com/XTLS/Xray-core/pull/7427) |
| X15 | Per-destination UDP routing with route-scoped FullCone | Worker | Adapts [#7346](https://github.com/XTLS/Xray-core/pull/7346) to the attributed Wayrill dispatcher |
| X16 | DNS resolver attempt counters | Shared | Uses the existing stats manager and metrics handler. The query counter is a private hook. |
| X17 | XUDP resumption boundaries and large Direct UDP replies | Shared | Source-pinned fixes for the XUDP server and Freedom packet reader |

### X16 — DNS resolver attempts

The [resolver activity patch](../../service/xray-patches/resolver-activity.patch)
changes `app/dns/nameserver.go`. The service assigns each generated resolver
entry an opaque ID on the runtime copy, using the order of the compiled DNS
servers. The ID identifies its graph branch independently of the transport
routing tag. User-defined native DNS scripts retain their resolver IDs.
Xray increments the counter as it enters that resolver, before cache lookup
or FakeDNS synthesis. Configured resolvers that Xray skips contribute no glow.
The service reads the counters through the existing authenticated metrics path
and through the host TUN and ICS workers' private control listeners. The
internal DNS bridge carries no resolver ID. Sampling keeps independent baselines
per core and clears them when the applied revision or core generation changes.

### X15 — Per-destination UDP routing

The TUN stack resolves native ownership and runs the normal Xray dispatcher
for each new UDP destination. Rule matching uses the same process, ancestor,
service, package, NAT and sniffing context as other TUN flows. After dispatch
selection, compatible destinations can share a FullCone association through
plain Direct (`freedom`). Sharing requires the same wire socket, attributed
origin, process generation and mask, matched rule, outbound, and IP family.
Redirects, mux/XUDP, proxy chains, policy relays, and rewritten targets use
separate associations so each destination keeps its own outbound behavior
and reply mapping.

The worker asks for attribution in bounded UDP batches. The companion shares
verified local socket ownership and process ancestry within each fresh native
snapshot. A new batch requires a new observation. Forwarded flows still need
an exact NAT tuple, and each destination still runs through Xray's dispatcher.
The helper returns unresolved tuples after the first fresh observation. A
separate bounded batch queue retries those tuples within the caller's original
deadline, so waiting for NAT or ancestry does not occupy initial lookup workers.

Additional destinations use a separate FIFO cache of up to 16,384 aliases,
each valid for one minute. An expired or evicted alias goes through attribution
and routing again. It can rejoin the same open socket if its new decision is
compatible. Aliases do not consume slots for new flows.
Forwarded replies require a live alias for their peer. Expiry and eviction
have the same effect even when the client sends no more packets. Ordinary
local FullCone sockets can still receive unsolicited replies.

Attributed destinations refresh their Windows socket ownership or NAT proof
within a two-second lease. Sends and replies both require a current proof. A
changed owner retires the association and discards packets held for its old
owner. The next packet is dispatched independently. A brief snapshot failure
withholds traffic and allows a retry on the existing socket. Native ownership
comes from snapshots, so a rebind between samples can be invisible.
Each stack limits queued UDP buffer storage to 64 MiB across pending and
established flows. Rule generation changes reject stale queued packets and
retired reply writers. Closing the stack cancels pending ownership checks and
releases its queues.
TUN downlink UDP bytes are counted after the complete datagram reaches the
packet sink. A full Wintun ring drops that datagram and preserves the
association. With inbound downlink statistics enabled, per-inbound
`udp-drop>>>ring-full` and `udp-drop>>>ownership` counters count discarded
datagrams. Adapter shutdown and other write errors still terminate the flow.
WinDivert already routes each UDP datagram before choosing a relay.

### X17 — XUDP resumption and Direct UDP replies

The server scopes XUDP resumption to the initial target, inbound and
authenticated user as well as the wire ID. Each independently dispatched TUN
association uses its own resume ID, including when the peer uses an older
server. Resumption detaches the previous downlink reader without closing or
draining the shared pipe, so the association can retain its remote socket.

Freedom uses full-size pooled scratch storage for native TUN replies. Paths
that use smaller legacy frame buffers keep a small read buffer, detect
truncation, and skip oversized replies without ending their associations.

### X14 — uTLS handshake deadline

Xray's shared uTLS wrapper caps `HandshakeContext` at 30 seconds. A silent TLS
peer can otherwise leave HTTP/2 requests waiting on the same XHTTP dial.
The deadline applies to fingerprinted TLS connections that use this wrapper
and ends when the handshake completes.

The backport changes `transport/internet/tls/tls.go`. A Wayrill regression
exercises a silent peer with an in-memory connection and tests timeout and
socket cleanup. [Upstream commit 87bd0381](https://github.com/XTLS/Xray-core/commit/87bd03816a806fbdc8338e541f3720782e3dfb27)

### X13 — Per-flow policy-group selection

The TUN worker logs the matched rule with an opaque flow ID. For policy-group
routes, it passes that ID over the existing authenticated loopback SOCKS5 relay.
The main core logs the actual selected outbound with the same ID. Wayrill joins
the observations in memory, including when the ICS worker's log arrives late.
The connector keeps the configured account identity and requires its existing
secret. Ordinary SOCKS accounts retain their usual authentication and never
carry a flow ID.

The patch adds the context and SOCKS helpers in `common/session` and
`proxy/socks`, with call sites in the SOCKS client, server, authentication
handler and `app/dispatcher/default.go`.

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
needs it. The last waiter leaving cancels foreground work. Stale cache hits
start or retain one refresh per name and address family, using the nameserver
budget without a separate waiter. DNS shutdown cancels both kinds of work.
The default shared deadline is eight seconds and extends for longer configured
nameserver timeouts. Cleanup replaces expired cached records so active readers
can finish using an immutable snapshot.
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
tags (`wdr-n-` followed by an unpadded Base64url identity) and requires local
authenticated access. Frame sizes, concurrency and query time are bounded.
The private TCP connection carries one request. A caller disconnect cancels the
native lookup, and expiry or shutdown releases the socket even if the request
frame is incomplete.

Ordinary DNS wire messages do not encode the distinction between synthetic client
answers and internal lookups needing real addresses. Losing that distinction
can feed a synthetic answer back into Direct or upstream ICMP resolution.
This is why the bridge is separate from the mapping RPCs and from normal DNS
forwarding. The private scheme cannot be selected in a saved public profile.

### X07 — FakeDNS allocator correctness

Native allocation preserves the full four-/sixteen-byte address width, including
leading-zero custom pools and wraparound. A persistent cursor starts at a random
point in each pool and avoids rescanning the same occupied addresses during
DNS bursts. It skips live mappings and leaves eviction to the native LRU.
Holder initialization/publication,
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

The private TUN build also carries optional application-match evidence from the
bridge to the dispatcher's rule decision. The service shows executable names
and PIDs for the predicates of the winning route in the traffic log. The
evidence does not enter routing predicates or change the relay account.

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
quotes for both address families. Error construction concatenates the fixed
header and bounded quote with one allocation, without calculating its size from
packet data.

### X12 — Private executable commands

- `wayrill-control` is a bounded client of upstream `RoutingService`, reached
  through Wayrill's authenticated local SOCKS route. It prepares candidate and
  rollback table sizes against the server limit, applies `AddRule` when requested
  and checks the channel with `ListRule`. It adds no routing or outbound RPC.
- `wayrill-fakedns` reads a bounded configuration from stdin, starts the native
  holder, opens the authenticated mapping authority and reports readiness.
- `wayrill-diagnose` evaluates a supplied flow with upstream `router.Router`,
  or sends a wire query through an isolated DNS outbound. It has no listener,
  active-core command channel or adapter initialization. Routing simulation
  suppresses webhooks and returns the selected balancer without advancing it;
  DNS diagnostics use fresh caches and FakeDNS mappings. They retain DNS and
  loopback routing scopes, starting fresh observations only when a reachable
  rule still references a policy group. Native process evidence is required
  only when an otherwise matching rule could decide the simulated route.
- The same diagnostic command supports offline reverse GeoSite lookup. It reads
  one bounded installed DAT file, streams its groups and uses upstream
  `strmatcher` for full, domain, substring and regex matches. It returns paged
  matching group names and one matching entry per group, without initializing
  routing, DNS, adapters or listeners. Invalid individual patterns are skipped
  like upstream's geosite loader.

The service binds an isolated DNS outbound's forwarded requests to the selected
uplink (or loopback for a local resolver), as well as binding ordinary outbound
transports. Forwarded requests dial through the handler rather than the DNS
client's routing path, and must not be recaptured by an active TUN.

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
| `service/core-control/diagnostics.go` | `main/wayrill_control_diagnostics.go` | X12 isolated routing/DNS diagnostics |
| `service/core-control/diagnostics_test.go` | `main/wayrill_control_diagnostics_test.go` | X12 matcher, DNS policy/fallback and cancellation tests |
| `service/core-control/geosite.go` | `main/wayrill_control_geosite.go` | X12 offline reverse GeoSite lookup |
| `service/core-control/geosite_test.go` | `main/wayrill_control_geosite_test.go` | X12 domain match boundaries, case, regex and cancellation tests |
| `service/core-control/main.go` | `main/wayrill_control_main.go` | X12 |
| `service/core-control/main_test.go` | `main/wayrill_control_main_test.go` | X12 tests |
| `service/core-control/routing_test.go` | `main/wayrill_control_routing_test.go` | X12 tests |
| `service/tun-core/wayrill_windows.go` | `proxy/tun/wayrill_windows.go` | X09, X10 |
| `service/tun-core/wayrill_windows_test.go` | `proxy/tun/wayrill_windows_test.go` | X09, X10 tests |
| `service/tun-core/wayrill_icmp_windows.go` | `proxy/tun/wayrill_icmp_windows.go` | X11 |
| `service/tun-core/wayrill_icmp_stack_windows.go` | `proxy/tun/wayrill_icmp_stack_windows.go` | X11 |
| `service/tun-core/wayrill_icmp_test.go` | `proxy/tun/wayrill_icmp_test.go` | X11 deterministic packet/lifecycle tests; native uplink probes are maintained privately |
| `service/tun-core/wayrill_udp_windows.go` | `proxy/tun/wayrill_udp_windows.go` | X15 attributed UDP association table |
| `service/tun-core/wayrill_udp_attribution_windows.go` | `proxy/tun/wayrill_udp_attribution_windows.go` | X15 bounded attribution requests |
| `service/tun-core/wayrill_udp_windows_test.go` | `proxy/tun/wayrill_udp_windows_test.go` | X15 Xray dispatcher and attribution integration |

| Additional upstream file edited by the builder | IDs |
| --- | --- |
| `proxy/tun/handler.go` | X09: pre-dispatch identity hook |
| `common/session/session.go`, `app/dispatcher/default.go` | X09: private TUN application-match evidence in dispatcher decisions |
| `proxy/tun/stack.go` | X11: ownership, echo interception and shutdown |
| `proxy/tun/tun_windows.go` | X10: native settings reuse |
| `app/dispatcher/default.go`, `app/proxyman/outbound/handler.go`, `app/router/router.go`, `common/session/session.go`, `common/session/wayrill_udp.go`, `proxy/tun/handler.go`, `proxy/tun/stack.go`, `proxy/tun/udp_fullcone.go` | X15: [private worker patch](../../service/xray-patches/tun-udp-routes.patch) |
| `common/mux/server.go`, `common/mux/session.go`, `common/mux/xudp_scope_test.go`, `common/xudp/xudp.go`, `common/xudp/xudp_test.go`, `proxy/freedom/freedom.go`, `proxy/freedom/udp_datagram_test.go`, `transport/pipe/impl.go`, `transport/pipe/reader.go` | X17: [shared UDP patch](../../service/xray-patches/udp-safety.patch) |

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
