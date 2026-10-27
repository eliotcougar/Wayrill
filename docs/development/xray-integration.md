# Embedded Xray integration

[Custom Xray change inventory](xray-customizations.md) is the maintained list of
every active patch, added Go file and build-script edit, with its purpose, scope,
upstream status and verification requirements. Reconcile it whenever the custom
core or its upstream base changes.

The current base is Xray v26.10.21, commit
`1b1647cd9ddf0abc34b981d4611fc03bcac1ca74`. Both packaged cores are audited
source builds. The main core is not the unmodified upstream release executable.
`service/dependencies.json` pins the base source archive, patches, initializer
files, Go toolchain and main executable. The private worker has its own integrity
manifest. [Core defaults](core-defaults.md) records the generated schema/defaults
audit and the current main executable hash.

Both cores require the pinned **Go 1.27.3** toolchain. The v26.10.21 security
release includes an updated fallback CA bundle; Go 1.27.3 additionally rejects
compromised certificate public keys, including chains accepted by the Windows
system verifier. The source version alone is insufficient: preserve the Go SDK
pin when rebuilding. The build selects a versioned SDK under `.tools`, verifies
its archive SHA-256 and checks its reported version before compiling either core.

Shared DNS work is owned by each nameserver and coalesced per address family.
Waiters retain their own deadlines; one caller cannot cancel another's query.
A completed family remains usable when the other times out. Work is cancelled
when its last waiter leaves or DNS closes, and also has an eight-second maximum
(extended for a longer configured nameserver timeout). TCP cancellation closes
the owned connection. Single-family answers preserve their upstream TTL on both
cache misses and cache hits; the shared merge retains existing dual-stack TTL behavior. Native FakeDNS queries and metadata sniffing preserve
request contexts through the optional mapping capability and reusable gRPC
client. Existing context-free local engines remain supported.

An ended mapping-client lifetime rejects new work before RPC admission; shutdown
also cancels already active and queued requests. Reverse-lookup misses release
the allocator lock before logging, allowing a log handler to inspect occupancy
without deadlocking the pool.

[Xray control and integration](xray-control.md) catalogs the upstream RPCs,
public Go hooks, reload mechanisms and their limits. It distinguishes stock
capabilities from source-pinned seams and Wayrill's private extensions.

The [extension boundary audit](xray-integration.md) verifies that an
app-owned FakeDNS engine and socket initializer can use the pinned upstream
feature/hooks without modifying their implementation packages. It separates
that migration plan from the native cancellation, allocator and Windows TUN
changes still needed to preserve behavior. That module migration is shelved;
the audit records feasibility rather than an active implementation plan.

`tools/Build-XrayCores.ps1` constructs both builds from a clean extracted source
tree under an exclusive build lease. It rejects reparse points, patch/hash drift
and changed hook anchors rather than layering over a previous source tree.

Read-only FakeDNS occupancy is included in the existing metrics response for local pools and authenticated GetPools response for shared pools. It reports only pool prefixes, used slots and capacity; it does not expose domains or change allocation, eviction or lifecycle. The optional `FakeDNSStatsProvider` capability is independent of the mapping RPCs. Allocator publication and snapshots share the holder lock. Custom pools with leading zero address bytes retain their full IPv4/IPv6 width during allocation and wraparound. These are private, source-pinned integrations rather than upstream APIs.

Shared changes are the app-owned UDP listener initializer and shared FakeDNS
bridge. Shared mapping RPCs use reusable authenticated local gRPC connections;
their protobuf schema comes from the general FakeDNS proposal, while endpoint
injection, authentication and process health remain Wayrill-owned. The initializer reads receive/send sizes supplied by the graph through
Xray’s existing environment map; it contains no buffer-size default. Global
defaults owns the app preset; absent/zero sizes retain Windows defaults. Outbound changes use a validated configuration and guarded core restart;
the build does not carry the experimental outbound replacement API or its extra
loopback listener. Rule-only updates use the upstream RoutingService through a
private, password-authenticated loopback SOCKS input routed to commander. This
keeps control local without exposing an unauthenticated API listener.

The SOCKS UDP timer and dialer destination
repairs are now upstream in v26.10.21 (PRs #7203 and #7201); their old backport
patch is removed. App-owned regression tests continue to exercise both behaviors
without patching upstream production code. See `service/core-init`,
`service/xray-patches`, [FakeDNS](../guide/dns.md), [live Apply](lifecycle.md) and
[UDP socket buffers](xray-customizations.md).

The private TUN/ICS build adds authenticated process/NAT attribution, service-owned
adapter/settings reuse, bounded upstream ICMP passthrough and private runtime
control. Its attribution hook precedes dispatch. Native addresses use plain IP
literals, including IPv6, on the Rust bridge. Exported Xray configurations contain
no private capture plan or privileged control endpoints.

Xray v26.10.21 uses its lightweight packet stack. The old gVisor ICMP adapters and
readiness flag are gone. ICMP interception is attached only to real TUN handlers;
WireGuard/MASQUE consumers retain upstream stack behavior. The build rejects
gVisor packages in the Windows runtime dependency graph. An indirect gVisor module
may still be required by WireGuard's upstream tests; a module-lock entry alone
does not mean it is linked into the Windows executable.

Corresponding source archives are packaged for both binaries. Wintun has a separate
pin. Preserve static CRT/containment and the versioned source/defaults guard;
never update executable hashes without reviewing configuration/runtime changes.
Build commands are in [Windows builds](building.md). Exact release checks and
runtime limitations belong in [service validation](testing.md), not in
claims that all previous tests or VM states remain current.
