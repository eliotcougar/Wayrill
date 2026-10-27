# Xray control and integration reference

Xray supports live gRPC administration, HTTP telemetry/profiling, Go embedding and socket hooks, Lua decision hooks, browser-assisted transport, and several limited automatic reload mechanisms. These facilities have different scopes. None is a general transaction that replaces the whole running configuration and restores Windows networking on failure.

For Wayrill, prefer the existing RPCs for supported live changes, public socket hooks for app-owned socket defaults, and the service's lifecycle transaction for changes that exceed those facilities. An exported Go symbol, a protobuf declaration, and a working operation in the stock executable are three different things.

## Scope and evidence

The source catalog was re-indexed against the pristine pinned **v26.10.21** source, commit `1b1647cd9ddf0abc34b981d4611fc03bcac1ca74`. Its verified archive SHA-256 is `57a862fdd1e978fc0c74c624d94555257cecf4e97e0a7df646168e1272aaff50`. This is the upstream base; Wayrill overlays are documented separately.

The audit covered all 1,181 archive files by structural searches, then read the implementations and call sites of the control surfaces described below. The [source inventory](xray-control-inventory.json) records all six protobuf services, **26 administrative RPCs**, two transport RPCs, 46 CLI usage declarations, 37 explicitly annotated Go API declarations, registration functions, HTTP route registrations, Lua modules and environment reads. Declaration counts include inactive CLI code; availability is explained here.

The reference is scoped to this upstream pin, not every release. The refreshed declaration catalog has the same control interfaces as the earlier audit; this does not claim that all runtime probes were rerun for the beta. Verify behavior with the current source and isolated checks when depending on an integration boundary.

## Navigation

- [Choosing a mechanism](#choosing-an-integration-mechanism)
- [Administrative gRPC API](#1-administrative-grpc-api)
- [CLI and process interaction](#2-cli-and-process-interaction)
- [Telemetry, profiling and routing events](#3-telemetry-profiling-and-routing-events)
- [Public socket hooks](#4-public-socket-hooks)
- [Go embedding and feature interfaces](#5-go-embedding-and-feature-interfaces)
- [Lua and Browser Dialer](#6-lua-decision-hooks-and-browser-assisted-networking)
- [Environment, resource and certificate reloads](#7-environment-resource-and-certificate-reloads)
- [Wayrill integration choices](#8-what-wayrill-can-reuse-and-what-remains-app-owned)
- [Verification and upgrade coverage](#9-verification-and-upgrade-coverage)

## Choosing an integration mechanism

| Need | Official mechanism | Available to an external stock process? | Important boundary |
| --- | --- | --- | --- |
| Replace/append traffic rules and balancers | `RoutingService.AddRule` | Yes, if enabled at startup | Does not replace DNS, router domain strategy or the Lua engine; existing flows keep their handlers |
| Add/remove listeners or outbound handlers | `HandlerService` | Yes | Separate calls, no cross-operation transaction or general replacement RPC |
| Change inbound users | `AlterInbound` user operations | Yes, for implementations with `UserManager` | Not a general inbound settings update |
| Select a policy-group target temporarily | `OverrideBalancerTarget` | Yes | App must validate target; runtime choice is not persisted |
| Ask which outbound a synthetic request would use | `TestRoute` | Yes | May resolve DNS, advance balancing state and fire webhooks; not a connectivity test |
| Collect counters and health observations | `StatsService`, `ObservatoryService`, HTTP metrics | Yes | Polling snapshots; not exact wall-clock rates or complete connection history |
| Inspect CPU/heap/goroutines | HTTP metrics' pprof endpoints | Yes | Diagnostic work with overhead; no built-in authentication |
| Receive rule events | Rule HTTP webhook | Yes, with rule configuration | Asynchronous, per-event HTTP; not a lossless ordered journal |
| Subscribe to route decisions over gRPC | `SubscribeRoutingStats` | **Declared but unwired in standard registration** | A custom Go integration must supply both a channel and event producer |
| Set default socket buffers/protection/binding | Listener/dialer controllers | **Go embedding executable required** | Process-global, setup-time hooks; not a setting in the unchanged `xray.exe` |
| Replace the system dialer | `UseAlternativeSystemDialer` | Go embedding executable required | Substantial responsibility for routing, UDP semantics, context and socket options |
| Generate traffic through the core without a proxy listener | `core.Dial`, `core.DialUDP`, dispatcher interfaces | Go embedding required | UDP helper is beta and has implementation limits |
| Execute custom routing/DNS decisions | Lua hooks | Yes, through configured local scripts | Restricted execution at specific hooks, not a general management API |
| Update resource matchers without restarting | Scheduled geodata reload; in-process registries | Scheduled mode: yes. Immediate registry calls: Go integration | No stock reload-now RPC; not a single atomic transaction across all matcher classes |
| Refresh file-backed TLS certificates | Built-in certificate reload/OCSP timer | Yes | Limited to certificate behavior, not a generic listener reload |
| Manage ICS, Windows proxy, WinHTTP, environment scopes, adapters, ownership or recovery | Wayrill service | No Xray facility | Remains an elevated Windows lifecycle responsibility |

## 1. Administrative gRPC API

### Activation, transport and discovery

The API is opt-in at core construction. A minimal configuration can name services and a local listen address:

```json
{
  "api": {
    "tag": "control",
    "listen": "127.0.0.1:8080",
    "services": [
      "HandlerService", "RoutingService", "StatsService",
      "ObservatoryService", "LoggerService", "ReflectionService"
    ]
  }
}
```

This illustrates the control section only; statistics need their own feature/policy settings, and the observatory needs an observation feature. `api.tag` is required even when using `listen`. Service-name matching is case-insensitive; unknown names are silently ignored by the JSON builder. Successful config construction therefore does not prove a requested service exists. Use reflection or a specific RPC to verify it. [API builder][api-build]

There are two listener arrangements:

- `api.listen` creates the gRPC listener directly. The commander recognizes TCP addresses, or Unix addresses beginning with `/` or `@`; abstract Unix behavior is platform-specific. This is not a native Windows named-pipe endpoint.
- Without `listen`, commander creates a synthetic outbound under the API tag. Route an inbound to that tag to carry the gRPC byte stream. Authentication can belong to that inbound. This is the official composition used by Wayrill's authenticated local SOCKS control bridge.

Commander uses `grpc.NewServer()` with no TLS credentials, authorization interceptor or built-in token. A loopback address alone does not authorize individual local users. Do not expose an administrative endpoint on the LAN. Keep the authenticated bridge and privileged operations in the service. A gRPC transport used by a proxy outbound is a separate data-plane protocol and does not enable administration. [Commander][commander], [transport gRPC service][transport-rpc]

The standard server's default receive limit is **4 MiB per message**. A larger client send limit does not increase the server limit; a large `AddRule` request can be rejected before decoding. The standard CLI also uses a three-second connection/RPC context by default. This matters for thousands of expanded rules or handlers. Reflection exposes schemas and services; it neither grants authorization nor supplies missing implementations.

Registered administrative service names are:

| Service | Canonical protobuf service name | Compatibility alias |
| --- | --- | --- |
| Handler | `xray.app.proxyman.command.HandlerService` | `v2ray.core.app.proxyman.command.HandlerService` |
| Routing | `xray.app.router.command.RoutingService` | `v2ray.core.app.router.command.RoutingService` |
| Statistics | `xray.app.stats.command.StatsService` | `v2ray.core.app.stats.command.StatsService` |
| Logger | `xray.app.log.command.LoggerService` | `v2ray.core.app.log.command.LoggerService` |
| Observatory | `xray.core.app.observatory.command.ObservatoryService` | None registered |

Reflection registers both gRPC reflection v1 and v1alpha. The isolated probe enumerated these **11 names**. The official [API overview](https://xtls.github.io/en/config/api.html) omits ObservatoryService; its availability is established by the builder, registration and runtime check, not by that overview.

### HandlerService: all ten RPCs

| RPC | What it actually does | Boundary |
| --- | --- | --- |
| `AddInbound` | Builds and adds a typed `InboundHandlerConfig` | Rejects an existing tag; attempts `Start` if the manager is running |
| `RemoveInbound` | Closes and removes the tagged inbound | Removes a listener, not a promise that every already-dispatched flow has stopped |
| `AlterInbound` | Instantiates a typed operation implementing `InboundOperation` | Built-in operations are `AddUserOperation` and `RemoveUserOperation` |
| `ListInbounds` | Returns tags only, or receiver/proxy settings | Can expose credentials; not a complete original JSON document |
| `GetInboundUsers` | Lists users, or finds the requested email | Requires the inbound proxy's `UserManager` |
| `GetInboundUsersCount` | Counts those users | Same implementation requirement |
| `AddOutbound` | Builds/adds an `OutboundHandlerConfig` | **Not an upsert**; duplicate tag fails |
| `RemoveOutbound` | Removes the manager's tagged lookup | At this pin it does **not** call the removed handler's `Close` |
| `AlterOutbound` | Accepts a typed object implementing `OutboundOperation` | **No concrete built-in outbound operation exists in the audited tree** |
| `ListOutbounds` | Returns current sender/proxy settings, excluding commander's synthetic outbound | Unordered manager snapshot; can contain secrets and other synthetic handlers |

Sources: [protobuf contract][handler-proto], [RPC implementation][handler-go], [inbound manager][in-manager], [outbound manager][out-manager].

Requests use protobuf messages and Xray's `serial.TypedMessage` (type name plus serialized protobuf bytes). `AlterOutbound` is not a JSON Patch endpoint. Passing an `OutboundHandlerConfig` as its operation in the stock core returns **“not an outbound operation”**, confirmed by the isolated probe.

User-management implementations include VLESS, VMess, Trojan, Shadowsocks, multi-user Shadowsocks 2022, WireGuard, Hysteria and MASQUE, subject to the implementation/build actually used. SOCKS/HTTP accounts are not made dynamically editable by the mere existence of `AlterInbound`. Check `proxy.UserManager` on the actual inbound. User removal changes future authentication; the RPC is not an established-session disconnect primitive. [User-manager interface][user-manager]

Lifecycle limits matter when composing these calls:

- Managers publish an added handler before its `Start` returns. A failed add is not guaranteed to leave no entry or resources. Reconcile the actual state after errors.
- Removing the default outbound clears the default pointer. Adding another handler can then establish a new default; list order is not the original JSON ordering.
- Removing an outbound does not retire its transport at this pin. Even an embedding caller that holds the stable handler interface must explicitly reason about `Close`, existing streams and cached references.
- A sequence of add/remove/routing calls is not atomic or persistent. Neither success nor a client timeout is a multi-step commit acknowledgement. Keep a compiled runtime snapshot, operation journal, guarded cutover and recovery policy in Wayrill.

Wayrill uses guarded core restarts for outbound changes, including subscription refresh. Its experimental replacement API was abandoned and is not part of the packaged build. Rule-only updates use the existing RoutingService over an authenticated local SOCKS route. See [current integration](xray-integration.md) and [live Apply](lifecycle.md).

There are upstream-only compositions to consider before requiring a replacement extension. One can add a new outbound under a versioned tag, cut new routing decisions over with `AddRule`, and then remove the retired tag. This is a design inference from the available calls, not a replacement primitive: chain `dialerProxy` references, balancer selectors/overrides, statistics identities and old sessions all need reconciliation, and stock removal still does not close the old handler. Alternatively, a source-pinned Go host can retain the handler and explicitly retire it through its lifecycle interface. Neither approach supplies a stock atomic same-tag swap. A custom compiled service can coordinate such composition without editing upstream package files, but its API and recovery logic then belong to the application. Choose based on actual identity/lifetime requirements, rather than assuming a private patch is the only possible design.

### RoutingService: all seven RPCs

| RPC | Actual behavior | Boundary |
| --- | --- | --- |
| `AddRule` | Builds a `router.Config` into rule/balancer tables; appends or replaces | `shouldAppend=false` replaces rules **and balancers**; it does not apply every router setting |
| `RemoveRule` | Removes rules with the supplied nonempty `ruleTag` | Does not remove a balancer definition or kill old flows |
| `ListRule` | Returns `ruleTag` and static outbound tag | No predicates, full config, effective balancer member or graph structure |
| `TestRoute` | Calls the current router's `PickRoute` with a supplied context | A decision simulation, not a network reachability or full traffic replay test |
| `GetBalancerInfo` | Returns override and strategy's principal target information where implemented | Not a full balancer/config/status dump; strategy may not implement the query |
| `OverrideBalancerTarget` | Stores a temporary target; empty target clears it | Does not validate that the target is an allowed, existing, healthy member |
| `SubscribeRoutingStats` | Streams a supplied `stats.Channel` | Standard registration passes **nil**, so ordinary configuration cannot enable this stream |

Sources: [routing RPC contract][router-proto], [RPC implementation][router-go], [router reload][router], [balancer implementation][balancing].

`AddRule` builds prospective rule conditions and balancers before publishing the new tables. Rule ordering remains first-match. Nonempty duplicate rule tags and duplicate balancer tags are rejected. An append places new rules after the old ones; broad earlier rules can shadow them. A replacement must include every retained rule and balancer, including Wayrill's private control/telemetry rules. Balancer overrides belong to balancer objects and may be lost when those objects are rebuilt.

**It is not whole-router reload.** `domainStrategy` is assigned in router initialization, and `routing.script` creates its engine there. `ReloadRules` does not update either. If the router has a Lua script, `PickRoute` uses that engine instead of the ordinary table; adding rules does not silently switch back to field rules. This distinction is essential for Apply eligibility.

Existing connections retain their chosen handler. Long-lived UDP dispatcher sessions, DNS resolver connections, mux sessions and transport pools can preserve earlier decisions. “Rules replaced” must not be described as “all existing traffic immediately re-evaluated.” Router updates also do not reconfigure DNS servers, hosts, FakeDNS pools, local policies, observatory schedules or Windows capture.

`TestRoute` accepts inbound/network, source and destination IPs/ports, domain, detected protocol, user, attributes, local endpoints and VLESS route metadata. It has **no explicit PID, parent tree, Windows service or package identity field**. Process rules can trigger the router's live OS lookup from the supplied tuple; this does not reconstruct Wayrill's richer attribution companion state. DNS strategies may resolve names. A balancing strategy may advance selection state, and the normal `PickRoute` path can fire configured webhooks. `PublishResult` only sends the synthetic result when an event channel was supplied. The returned protobuf does not include `ruleTag`, although the in-process `routing.Route` does. The RPC wrapper always reports `SkipDNSResolve=false`; its result converter uses prefix-matched field selectors and does not populate `VlessRoute` in the response. Do not assume a synthetic RPC context is a lossless live-session round trip. [RPC context conversion][router-convert]

`SubscribeRoutingStats` is especially easy to misunderstand: `service.Register` calls `NewRoutingServer(router, nil)` even though it requires a statistics manager. Enabling `stats`, changing a channel name or adding reflection does not fix it. No production dispatcher call site publishes real route decisions into such a channel in this tree. A custom integration needs to wire a producer as well as a channel/server; registering a nonnil channel alone only enables delivery of explicitly published events. The stock failure was verified at runtime.

The dispatcher at this pin closes a request whose chosen outbound tag does not exist. A router error/no-match can still select the default handler. Consequently, missing-tag closure is not a general fail-closed update transaction. Keep Wayrill's explicit blocking guard around multi-step replacement. [Dispatcher behavior][dispatcher]

### StatsService: all seven RPCs

| RPC | Result | Reset behavior |
| --- | --- | --- |
| `GetStats` | One named counter | Optional exchange-to-zero returns its previous value |
| `QueryStats` | Counters whose names contain the supplied substring | Optional reset per visited counter; not an atomic all-counter snapshot |
| `GetSysStats` | Uptime, goroutine count and Go memory/GC statistics | No reset; **no CPU percentage or network rate** |
| `GetStatsOnline` | Unique online-IP count from a named online map | Request's reset field is not used here |
| `GetStatsOnlineIpList` | IP to last-seen Unix timestamp map | No counter reset |
| `GetAllOnlineUsers` | User names with online entries | No counter reset |
| `GetUsersStats` | Online users and their IP entries; optionally traffic | Optional traffic reset, for the returned online-user set |

Sources: [statistics RPC contract][stats-proto], [implementation][stats-go], [stable manager/counter/channel interfaces][stats-feature].

Enable the real statistics manager (`stats: {}`) and the relevant policy flags before expecting data: system inbound/outbound uplink/downlink and per-user level flags. Without them the default no-op manager or missing counters give no usable statistics. Names include `inbound>>>TAG>>>traffic>>>uplink`, `outbound>>>TAG>>>traffic>>>downlink`, and `user>>>EMAIL>>>traffic>>>uplink`; online maps use their own online identifiers.

Bytes are cumulative counters, not sampled rates. The app owns monotonic sample timing, counter reset/restart epochs, rate calculation, retained history and persistence. Multiple readers using reset interfere with each other. Prefer one collector reading non-reset cumulative values; reset the app's presentation baseline unless deliberately taking exclusive ownership of core resets. Physical/core/worker totals must not be added together indiscriminately. `GetSysStats`'s uptime starts with the statistics server object, while its memory fields describe the Go process.

Online maps are per-user accounting supported by the active implementation, not an inventory of all Windows sockets or accurate process ownership. The stable Go manager also offers counter/online-map/channel registration and visitation. Its visitors run under read locks; mutating the same manager/map inside a visitor can deadlock, as documented in the interfaces.

### ObservatoryService and LoggerService

`ObservatoryService.GetOutboundStatus` returns the observation feature's current result: tag, alive state, delay, last error, last try/seen and, for burst observation, health-ping measurements. It reads existing observations; it does **not** launch a requested one-shot test, fetch an exit IP, edit candidates or change the interval. Regular and burst observers implement the same observation feature type. Some burst fields differ: `delay` is in milliseconds, health duration fields are populated from Go durations, and last try/seen are zero in the burst result implementation. Do not render those raw values as interchangeable units or timestamps. The Go `BurstObservatory.Check(tags)` exists for internal/embedding use but is not an administrative RPC. [Observation RPC][observation-rpc], [regular result][observation-proto], [burst observer][burst]

`LoggerService.RestartLogger` closes and starts the existing logger using its existing configuration, useful when reopening rotated files. It does not change log level, paths, masking or subscribe to log messages. There is no logger event-stream RPC. [Logger implementation][logger-rpc]

## 2. CLI and process interaction

### Live API client commands

`xray api` is a gRPC client, not another administration server and not an IPC path that bypasses API activation. Its endpoint is plaintext gRPC; it has no automatic knowledge of Wayrill's authenticated private bridge. Global API flags include `-server`/`-s`, `-timeout`/`-t` (three seconds by default), and `-json`. [CLI registration][api-cli], [shared client][api-shared]

The **23 registered API subcommands** are:

| Purpose | Commands |
| --- | --- |
| Inbound handlers | `adi`, `rmi`, `lsi` |
| Inbound users | `adu`, `rmu`, `inbounduser`, `inboundusercount` |
| Outbound handlers | `ado`, `rmo`, `lso` |
| Routing | `adrules`, `rmrules`, `lsrules`, `sib` |
| Balancers | `bi`, `bo` |
| Statistics | `stats`, `statsquery`, `statssys`, `statsonline`, `statsonlineiplist`, `statsgetallonlineusers` |
| Logging | `restartlogger` |

Some RPCs lack a dedicated CLI command, including `TestRoute`, routing subscription and observatory status. `statsonlineiplist -all` also uses the combined users-statistics path. Handler/rule commands accept core-format JSON fragments and build the required protobufs; they do not send the JSON verbatim to the server. Several commands accept local files, `stdin:` or HTTP(S) sources.

Two traps deserve explicit treatment:

1. `adrules` defaults to replacement. With several input files it calls `AddRule` for each file separately, so without `-append` a later file replaces the prior file's table. It is not one merged atomic update. Wayrill should build and submit one complete intended table.
2. Despite wording in the API documentation about disconnecting connections, **`sib` constructs a source-IP routing rule** targeting the requested outbound. It appends that rule, so earlier matching rules can shadow it. It does not close established TCP connections, create the requested Block outbound, or install a Windows firewall rule. Reset is a separate remove/add sequence. [Rule command][rules-cli], [source-IP command][sib]

### Offline tools and diagnostics

The registered top-level commands in this pin are `run`, `version`, `api`, `base64`, `convert`, `tls`, `uuid`, `x25519`, `wg`, `mldsa65`, `mlkem768`, and `vlessenc`, plus the command framework's help. `tls` has `cert`, `ping`, `hash`, `ech`; `convert` has `pb`, `json`; `base64` has `encode`, `decode`. [Command registration][commands]

- `run -test` loads/builds a configuration and constructs an instance without calling its `Start`. It is useful validation, but not a port-bind, route-restoration or successful-traffic test; constructors and environment initializers are not universally side-effect-free.
- `run -dump` emits merged input configuration. It is **not** a dump of the running process after live API changes.
- `convert pb` builds native protobuf from supported config files. Its debug output is explicitly not normal runnable JSON. `convert json` expands one serialized TypedMessage, not an arbitrary reverse conversion to Wayrill's graph or original user JSON.
- Key/certificate/UUID tools support provisioning. They do not control an existing core. Keep private output out of logs.
- `tls ping` makes direct native TCP/TLS diagnostic connections using the system resolver. It is not ICMP ping, an outbound-tag test, or proof that traffic traversed a particular graph path.

`lua sign` and `ed25519` have source declarations but are **not registered CLI commands in this release**. The privileged Lua flag is commented out too. Do not advertise commands merely because their source files exist. Runtime `help` verified the registered command set. [Run implementation][run], [conversion][convert], [TLS diagnostic][tls-ping]

### Signals, standard streams and input sources

The CLI waits for `os.Interrupt` or `SIGTERM` after starting, then runs deferred `Close`. There is **no SIGHUP/full-config reload handler** in the audited production tree. On Windows, a hard process/job termination is not a graceful console interrupt and must not be assumed to execute deferred cleanup. Xray has no RPC to stop/restart the entire core process or Wayrill service; the owner controls its child process.

`stdin:` supplies startup input, not a continuous command stream. File/HTTP(S)/Unix-socket HTTP config loaders read on invocation; they do not poll the source for changes. Multiple JSON/JSONC, YAML, TOML or protobuf files, directory loading, and merge behavior are startup facilities. Config environment values and credentials can appear in dumps; preserve Wayrill's protected storage/log policy. [Run implementation][run], [config loaders][loaders]

## 3. Telemetry, profiling and routing events

### HTTP metrics and pprof

The metrics feature can listen directly or expose a synthetic outbound reached through routing. JSON config supplies a default tag `Metrics` when only `listen` is given; keep generated control/metrics tags distinct from user tags. The direct listener uses standard `net.Listen`, not Xray's system-listener controller. [Metrics implementation][metrics], [metrics builder][metrics-build]

`GET /debug/vars` returns an expvar JSON object containing process variables such as command line and memory statistics, plus:

- `stats`: nested inbound/outbound/user counters;
- `observatory`: current observation results keyed by outbound tag, or no usable observation when the feature is absent.

This is a read-only alternative to polling the gRPC statistics/observation services, already used by Wayrill. It does not reset counters, store rate history or isolate statistics of multiple embedded instances from all process-global expvars.

The same HTTP mux registers `/debug/pprof/`, `/debug/pprof/cmdline`, `/debug/pprof/profile`, `/debug/pprof/symbol`, `/debug/pprof/trace`; the index also serves named profiles such as heap, goroutine, allocs, block and mutex where supported/enabled by the Go runtime. Go pprof tooling can consume them. Use explicit diagnostic sessions: CPU/trace/profile collection can be expensive and exposes internal information. The server has no built-in authentication. Do not expose it directly or scrape large memory profiles as routine live telemetry. [Official metrics guide](https://xtls.github.io/en/config/metrics.html)

There is no Prometheus endpoint, built-in WebSocket stats feed, exact CPU-utilization counter, independent rate sampler or runtime-configuration export in this metrics handler. An app adapter can supply those presentations without pretending the core already does.

### Rule webhooks

A field rule can configure a webhook URL, custom headers and deduplication interval. On a successful rule decision the router asynchronously POSTs JSON with available source/destination, original/route target, protocol, network, inbound/outbound tags, user information and a seconds timestamp. URL handling also supports the core's HTTP-over-Unix-socket forms. [Webhook implementation][webhook], [router invocation][router]

This provides an official route-event path that we should evaluate before expanding text-log scraping. It has material limits:

- The event does not contain `ruleTag` or Windows process identity. A distinct receiver URL/header can identify the configured rule, but that is app-side composition.
- One goroutine/HTTP operation is launched per unsuppressed event; no bounded event queue, durable delivery, ordering guarantee, replay cursor or retry protocol is provided. The HTTP timeout is five seconds. Deduplication is keyed by nonempty user email, not destination/flow.
- Requests use the webhook's HTTP client, not the Xray dispatcher. They must not be assumed to traverse the selected outbound. Keep a Wayrill collector local and authenticated.
- `TestRoute` follows normal `PickRoute`, so its synthetic decisions can trigger these notifications. Script routing returns before the field-rule webhook path. Unmatched/default dispatch does not create a matching field-rule event.

It is suitable for bounded notifications or a measured local collector experiment; it is not automatically a replacement for Wayrill's complete circular routing log.

### Logs and in-process sinks

An external core can emit console/access/error files. The dispatcher emits rule-selection information at info level and an access record with inbound/outbound detour, but these are textual output conventions rather than a typed remote event API. A message about a selected route is not independently verified OS process attribution. [Dispatcher][dispatcher], [access-message type][access]

For a Go host, `common/log.RegisterHandler` replaces the **single process-global** log handler. It is not an additional subscriber. `app/log.RegisterHandlerCreator` customizes the app logger's sink construction. Constructing the app logger replaces the global handler; `RestartLogger` closes/recreates that feature's sinks without re-registering a globally replaced handler. A host must preserve severity, access routing, masking, nonblocking bounded delivery and sink ownership, and choose deliberately between intercepting the global stream and supplying sink creators. These are unannotated extension points, not a stable native callback ABI. [Global logging][log-hook], [sink creators][log-creators], [logger lifecycle][log-instance]

## 4. Public socket hooks

### Listener and dialer controllers

`internet.RegisterListenerController(func(network, address string, raw syscall.RawConn) error)` and `RegisterDialerController` are explicitly **beta Go APIs**. They run while a socket is being created, before it is used. They can set OS buffer sizes, binding/protection and other descriptor-level options without modifying Xray's config schema or library implementation. They require an app-owned Go executable that embeds/imports Xray; the unchanged official executable cannot receive a Go callback through JSON or gRPC. [Listener hook][listener], [dialer hook][dialer], [system listen entry points][system-listen]

SOCKS UDP association sockets use this call path:

```text
SOCKS UDP ASSOCIATE
  -> ListenSystemPacket(..., nil)
  -> DefaultListener.ListenPacket
  -> registered listener controllers
  -> configured socket options, when supplied by that call path
```

The nil settings argument does **not** bypass the controller. A UDP-only controller can set process defaults on these association sockets. Ordinary callers that supply socket options apply them after controllers, preserving explicit-option precedence. The maintainer's [suggestion](https://github.com/XTLS/Xray-core/pull/7196#issuecomment-6272470342) points to listener injection; the exported registration method avoids touching unexported fields or using `unsafe`/`go:linkname`. [SOCKS call site][socks-listen]

What the hook does **not** provide:

- No inbound tag, session context or per-node settings accompany it. Several SOCKS relays can all bind the same IP with port zero; the callback cannot reliably attribute them to different graph nodes.
- Only newly created sockets change. Active associations keep their old buffers. It is not a congestion controller, retransmission mechanism, traffic shaper, packet-loss cure or per-packet callback.
- Registration is process-global. Listener registration appends without synchronization or public removal. Dialer registration protects append with a mutex, but readers do not use that lock. Register once before any networking starts; do not append on every core restart or swap a growing registry while dialing.
- Listener callback errors are logged and ignored inside the listener's control function. Default dialer callback errors propagate and can fail the dial. A successful Start is not proof that listener options succeeded.
- In this pinned base, both TCP and UDP dialer controllers receive the resolved remote endpoint. The UDP path previously supplied its local bind address; that repair is upstream and is not a separate Wayrill patch. Listener controllers still receive the listener address. Keep those roles distinct when choosing address-family-specific options.
- Only paths that call these helpers are covered. Direct standard-library listeners, webhook clients, browser networking and third-party socket creation require their own call-path audit.

Existing `streamSettings.sockopt.customSockopt` supports network/system-specific numerical options where the protocol actually forwards its settings into the socket constructor. Prefer it for user-selected per-handler values on covered paths; prefer the public callback for app-wide SOCKS association defaults. An accepted JSON field does not prove every socket in a mixed TCP/UDP protocol used that field. On Windows, the implementation supports integer custom options and rejects string-valued custom options. [Windows socket implementation][windows-sockopt]

Wayrill uses this initializer in `service/core-init/udp_windows.go`. Preserve registration-before-start and explicit-option precedence on upgrades. The SOCKS lifetime and UDP destination repairs are already in the upstream base; buffer initialization is a separate concern.

### Alternative system dialer and low-level listen helpers

`UseAlternativeSystemDialer(SystemDialer)` is marked **stable**. Nil restores the default implementation; the caller must prevent races. `SystemDialer` receives context, source address, destination and socket options, and supplies `DestIpAddress`. `WithAdapter` wraps a simpler `Dial(network,address)` object, but drops source/context/socket-option information when forwarding. This is useful for a platform socket-protection integration or controlled host dialer, not a casual substitute for the default implementation. [Dialer implementation][dialer]

The default dialer controllers are not a universal wrapper around a replacement dialer. Registration even returns an unsupported error for a custom dialer after appending the controller. A replacement must deliberately preserve cancellation, TCP/UDP behavior, local bind/interface constraints, socket options, loopback and resolver behavior. `DialSystem` also performs domain-strategy handling and `dialerProxy` redirection before calling the selected system dialer; do not bypass those layers by accident. [DialSystem][transport-dial]

`ListenSystem` and `ListenSystemPacket` are beta helpers for a Go integration to create sockets through Xray's listener path. `RegisterTransportDialer`, `RegisterTransportListener` and `RegisterProtocolConfigCreator` register transport implementations/config creators at initialization; they are broader, unannotated extension plumbing. They are not runtime enable/disable commands and do not retroactively replace a transport used by existing handlers.

## 5. Go embedding and feature interfaces

### Intended API boundary

`core/annotations.go` explicitly distinguishes **stable**, **beta** and deprecated APIs, and says unannotated functions/types should not be used externally. The tree still contains exported, useful extension plumbing; when using it, record the dependency as source-pinned/internal rather than claiming the same compatibility guarantee as a stable entry point. No official Rust/C/C# ABI, DLL control API or generic runtime plugin loader is supplied by this tree. A Go helper with a narrow app-owned IPC protocol is an integration choice. [API annotations][annotations]

The annotated entry points and interface families relevant to Wayrill are:

| Surface | Annotation | Meaning |
| --- | --- | --- |
| `core.StartInstance(format, bytes)` | Stable | Parse, construct and start an instance with linked loaders/features |
| `(*core.Instance).Start` | Stable | Start **once**; failure leaves unknown instance state; a closed instance is not guaranteed restartable |
| `core.Dial(ctx, instance, destination)` | Stable | Open traffic through the instance dispatcher as a virtual `net.Conn` |
| `core.DialUDP(ctx, instance)` | Beta | PacketConn adapter over the UDP dispatcher |
| `features/inbound` Handler, Manager, ManagerType | Stable | Direct handler lookup/add/remove/list and lifecycle |
| `features/outbound` Handler, Manager, ManagerType | Stable | Direct dispatch and manager operations; selector is a separate interface |
| Routing Context, Route, Router, Dispatcher and type helpers | Stable | Supply routing metadata, select routes, dispatch links, manage rule tables |
| DNS Client | Stable | Resolve IPs through the feature, including TTL and address-family/FakeDNS options |
| DNS ClientType | Beta | Feature-type helper |
| Policy Manager and type helper | Stable | Read effective user-level/system policies; no generic policy setter |
| Statistics Counter, OnlineMap, Channel, Manager, type helper | Stable | Read/update counters, accounting maps and app-wired channels |
| System dialer replacement | Stable | Replace process-global socket dialer under caller synchronization |
| Socket controllers, system listen helpers | Beta | Descriptor setup hooks and socket construction |

The complete 37-declaration inventory also contains common Close/Interrupt interfaces/helpers (beta) and bytes-pool helpers (stable). These utility contracts are not additional remote control protocols.

`core.New`, `NewWithContext`, `GetFeature`, `AddFeature`, `RequireFeatures`, `CreateObject`, typed-config builders and instance context plumbing are not individually marked stable in this pin. A pinned Go host can use the factory/feature model, but it must audit those dependencies. `AddFeature` is **not** a general hot-swap mechanism: its running-instance branch starts the supplied feature without adding it to the feature slice or replacing an existing feature. Set up feature dependencies before Start.

The internal `core.toContext` explicitly warns third parties against aliasing it with `go:linkname` or fabricating a context to invoke internal components. Obtain legitimate instance contexts through the core's feature/factory lifecycle instead of copying a private key into an arbitrary context. [Instance lifecycle][instance], [context boundary][core-context]

### Traffic injection and tagged dispatch

For an app-owned Go host, `core.Dial` lets an HTTP client or other stream consumer use the core without opening a local SOCKS listener. Its returned connection's local/remote addresses do not represent real socket endpoints. The routing context can be built through the routing interfaces; actual session metadata/context setters are additional unannotated dependencies, not automatic Windows attribution. [Core functions][functions]

`Dispatcher.Dispatch` returns an Xray reader/writer link and `DispatchLink` accepts an existing link. `outbound.Handler.Dispatch` provides direct dispatch to an obtained handler. These are in-process data-plane interfaces with buffer ownership and context/lifetime responsibilities; Rust cannot call them merely by importing protobufs.

`transport/internet/tagged.Dialer`, installed by `taggedimpl`, creates a virtual connection with a forced outbound tag and DNS-resolution-skip content metadata. It is used by internal probes/downloaders and can help an audited Go wrapper target a specific outbound. It requires a valid instance context and is unannotated. Missing forced tags fail closed in this pin. It is not a remote “dial this outbound” RPC. [Tagged implementation][tagged], [dispatcher][dispatcher]

The beta UDP helper is unsuitable as an assumed high-throughput drop-in OS socket: its receive queue holds 16 packets and drops when full, deadline methods return nil without implementing deadlines, and writes copy into a core buffer rather than providing unrestricted datagram size. Retain datagram boundaries, respect the buffer limit, and close/cancel deliberately. Wayrill's external SOCKS/worker path and its measured performance must not be equated with this helper's behavior. [UDP adapter][udp-dispatch]

For external processes, SOCKS5 CONNECT/UDP ASSOCIATE, HTTP proxy/CONNECT and configured tunnel/protocol inbounds remain official data-plane entry points for tests and app-originated requests. They do not edit configuration. Built-in observatory probes also do not replace exit-IP lookup or full application-level tests.

### DNS, FakeDNS and platform integration

In-process DNS `Client.LookupIP` returns addresses/TTL; FakeDNS feature interfaces provide forward domain-to-fake-IP and reverse fake-IP-to-domain mapping, pool membership and family-specific allocation. These mapping interfaces are not remote synchronization/export/restore APIs. A shared pool across Wayrill's separate main/TUN processes still needs an app-owned bridge; the official DNS protocol alone does not expose reverse pool ownership. [FakeDNS interfaces][fake-feature]

`internet.SkipDNSServers([]netip.Addr)` replaces an atomic process-global skip list used by Xray's local resolver path; nil clears it. This is an upstream integration point for excluding the TUN's DNS endpoints from the core's own system-DNS queries and avoiding recursive resolution. The Windows TUN implementation already calls it. It does not change Windows DNS settings, clear DNS caches, skip arbitrary routed resolver traffic or configure dnscrypt-proxy. It is unannotated and process-local. [Skip list][dns-skip], [local resolver][local-dns], [Windows TUN][windows-tun]

`RegisterAndroidProcessFinder` is Android-only and injects process/UID discovery for routing lookups. Windows uses its own finder; there is no corresponding official register-a-Windows-attribution-provider API. Child trees, services, WinUI packages and Windows NAT session attribution remain richer app integration. `XRAY_TUN_FD` supplies a pre-opened TUN descriptor on the supported Android/Linux/macOS paths; it is not a generic Windows adapter handle or adapter-lifecycle management API. [Android hook][android], [TUN platform sources][tun-files]

Upstream Windows TUN already uses IP Helper route/interface notifications to refresh its selected uplink and check its forwarding guard. It unregisters those callbacks on Close. Its configured automatic route/DNS/WFP behavior is a real built-in facility, but those implementation methods are not a remote adapter-control API or a native ICS handoff/recovery transaction. Audit and reuse their behavior where compatible with Wayrill's ownership model; do not assume every networking change requires polling or a new driver. Conversely, repeated TUN lifecycle operations must account for its use of global dialer controllers and DNS state. [Windows TUN callbacks and cleanup][windows-tun]

### Extension registries and source-pinned seams

| Registration/seam | Scope and use |
| --- | --- |
| `common.RegisterConfig` / `CreateObject` | Process-global mapping from a typed config to object factory; custom features/proxies/services can participate in the construction graph |
| `commander.Service.Register(*grpc.Server)` | A compiled service can register RPCs on commander's server; custom service configs need registry/build integration, not an arbitrary name in `api.services` |
| Transport dialer/listener/config-creator registries | Compile in a transport or replace the distribution composition; duplicate names generally fail |
| `core.RegisterConfigLoader`, `ConfigBuilderForFiles`, `ConfigMergedFormFiles` | Add/replace config loading/build/merge behavior before use |
| `main/confloader.EffectiveConfigFileLoader` | Replace external config-file reading for a host executable |
| `filesystem.NewFileReader` | Replace file reading on covered paths; asset resolution still stats/validates real paths before some reads, and not all file access uses this function |
| `RegisterConfigureFilePostProcessingStage` | Validate/transform decoded config before Build; stages are stored in a map, so do not depend on ordering |
| `common/log.RegisterHandler`, `app/log.RegisterHandlerCreator` | Global logging/sink integration, with replacement/lifecycle caveats above |
| `platform.RegisterEnvReload` | Add a process-local environment refresh handler; not a remote reload command |
| `main/commands/base.RegisterCommand` | Add commands to an app-owned distribution; no extension loaded into an already-running stock binary |
| Lua module registration helpers | Expose specific modules to a host-created Lua state; not a mechanism to install new native modules in the stock process remotely |

These are visible official source seams, mostly **unannotated**. They are not permission to depend on arbitrary unexported globals, call into an instance using unsupported context tricks, or claim an upstream stability guarantee. The configuration factory map and several registries are not synchronized for arbitrary mutation during traffic. Source: [factory registry][factory], [config registry][config-registry], [postprocessors][postprocess], [filesystem seam][filesystem], and the inventory's exact declarations.

Multiple in-process instances are not fully independent: system dialer/DNS/outbound-manager pointers, socket controllers, log handler, environment flags, browser dialer and geodata registries have process-global state. `InitSystemDialer` overwrites shared references when an instance is initialized. Separate worker processes, as Wayrill uses, provide a clearer boundary for independent main/TUN lifetimes than assuming two `Instance` values isolate everything. [Core initialization][instance], [transport globals][transport-dial]

## 6. Lua decision hooks and browser-assisted networking

### Lua is a restricted extension language at three entry points

The audited source has these execution hooks:

| Configured entry | Hook | Available role |
| --- | --- | --- |
| `routing.script` | `HandleRoute` | Choose outbound/rule tag from routing context; call balancer selection, process lookup, DNS and geodata matchers |
| `dns.script` | `HandleDNSQuery` | Select/query configured resolvers, filter results, return addresses/TTL/error |
| FinalMask noise `script` | `HandleNoise` | Build bounded packet/delay noise plans for that mask, using its noise helpers |

Source: [routing script][route-script], [DNS script][dns-script], [noise script][noise-script]. The [official Lua overview](https://xtls.github.io/en/development/lua/) currently lists routing and DNS hooks; the noise hook is additionally present in the source.

Routing passes inbound tag, endpoint ports, lowercased domain, network/protocol, user, VLESS-route and skip-resolution metadata plus an opaque routing context. `xray.router` supplies network constants, local OS, balancer selection and process lookup. `xray.dns` supplies supported resolver queries. `xray.geodata` builds domain/IP matchers with match/filter methods; `xray.log` emits logging. The fifth module is the noise module for noise states, not a universally available module in routing/DNS scripts. [Routing Lua API][route-lua], [DNS Lua API][dns-lua], [geodata Lua API][geodata-lua]

Important current-version limits:

- Only local `.lua` files are accepted by the common compiler. Inline Base64/gzip script forms explicitly return “currently unavailable.” Relative paths resolve through config-dir/config-location, working directory and executable directory; symlinks are resolved and the final extension must be `.lua`.
- Privileged-signature verification and its CLI activation are disabled in the actual call path. Helpers for signing/privileged keys exist in source, but scripts compiled normally remain sandboxed. Do not infer working privileged scripts from those helpers or old instructions.
- The sandbox allows selected base/table/string/math and time functions, plus preloaded modules. It removes file loading, arbitrary module/native loading, I/O, OS execution/environment access and several introspection/mutation functions. It is not an API for setting socket options, editing handlers, restarting cores or changing Windows settings.
- Routing/DNS use exclusive pooled Lua states, six-second execution budgets and 120-second initialization budgets. Globals persist per pooled state, not as one coherent application state. The pool retains at most 16 idle states but currently has no total active-state cap. Do not use Lua globals as a shared connection registry.
- Files compile into retained programs; editing a file does not hot-reload the running engine. `AddRule` does not replace a routing script. Scripts are not per-packet programmable hooks into every transport.
- The noise engine has a source TODO for closing pools when the associated handler is API-removed. Treat repeated dynamic noise-handler replacement as a lifecycle area needing verification before adopting it.

Source: [compiler/sandbox][lua-program], [pool][lua-pool], [script resolution][platform], [noise lifecycle][noise-script]. Ordinary routing attributes are regexp matchers in this release; do not confuse them with arbitrary inline Lua expressions. [Attribute matcher][conditions]

### Browser Dialer

`XRAY_BROWSER_DIALER` starts Xray's browser-dialer HTTP page and WebSocket task channel. A real browser page performs supported HTTP/WebSocket requests and carries data back, rather than merely simulating a browser TLS fingerprint. The Go package has `Reload`, registered through environment reload, and dial methods for WebSocket, GET and packet/body operations. This is an official transport-integration mechanism, not an administrative API. [Implementation][browser], [official guide](https://xtls.github.io/en/config/features/browser_dialer.html)

Potential Wayrill use is an opt-in browser-assisted mode for supported WebSocket/XHTTP transports. The browser needs direct reachability to avoid TUN/proxy recursion. It cannot generally provide arbitrary TCP/UDP, custom SNI, all TLS options or arbitrary forbidden browser headers, and adds browser/CORS/connection-limit/lifecycle costs. The implementation serves a token-bearing page and accepts browser sockets; keep its listener local. `Reload` changes the process-global browser server/connections, so it is not a harmless settings refresh while requests are active.

## 7. Environment, resource and certificate reloads

### Environment variables and refresh

`platform.NewEnvFlag` checks the dotted name first, then its uppercase underscore form. For example, `xray.location.asset` and `XRAY_LOCATION_ASSET` are related names, not two independently merged settings. Configuration's `env` map calls `os.Setenv` in the current core process during config Build, before module construction. It does not edit Windows user/system environment-variable stores or notify already-running applications. [Platform environment helpers][platform], [config Build][config-build], [official environment guide](https://xtls.github.io/en/config/env.html)

| Setting family | Reading/lifetime boundary |
| --- | --- |
| `XRAY_LOCATION_CONFIG`, `XRAY_LOCATION_CONFDIR` | Used to locate startup inputs/scripts; setting in a file cannot locate that same file retroactively |
| `XRAY_LOCATION_ASSET`, `XRAY_LOCATION_CERT` | Used on resource/certificate path resolution; changing them does not itself rebuild existing matchers/certificates |
| `XRAY_JSON_STRICT` | JSON-loader package initialization; supply before process initialization |
| `XRAY_RAY_BUFFER_SIZE` | Refreshable default pipe-buffer policy, in MiB; not an OS UDP socket buffer |
| `XRAY_BUF_READV`, `XRAY_BUF_SPLICE` | Refreshable internal fast-path flags, with exact string semantics in source |
| `XRAY_VMESS_PADDING` | Refreshable VMess flag; presence/value semantics are not ordinary boolean parsing |
| `XRAY_XUDP_SHOW`, `XRAY_XUDP_BASEKEY` | Refreshable XUDP logging/global key inputs; key is sensitive and strictly sized |
| `XRAY_BROWSER_DIALER` | Refresh can recreate/close browser-dialer networking |
| `XRAY_TUN_FD` | Consumed when constructing a supported platform TUN |
| Go runtime variables (`GOGC`, `GOMEMLIMIT`, `GOMAXPROCS`, `GOTRACEBACK`, etc.) | Runtime-specific startup/diagnostic behavior; not a generic Xray reload API |
| Hysteria congestion debug variables | Implementation-specific diagnostics, not a general controller |

`platform.ReloadEnvSettings()` invokes the registered process-local refresh functions and is called on core instance initialization. An embedding host can call it; an external process cannot change the child's existing environment merely by changing its own environment. There is no corresponding gRPC/CLI reload-env command or file watcher. It does not rebuild all policies, existing pipes, sockets or handlers.

The six registrations are readv, freedom splice, default buffer policy, VMess padding, XUDP settings and browser dialer. `RegisterEnvReload` runs a newly registered handler immediately and panics if that initial call fails. Later reloads combine errors; a partial refresh is not rolled back. Names defined as platform constants, such as `UseCone`, are not proof of a live reader; use the inventory/call sites rather than exporting every constant into UI. In this pin readv/splice enable on omitted/`auto`/`enable`, not a generic `true` parser. [Reload registry][env-reload], [policy default][policy-env], [readv reader][readv], [freedom flag][freedom-env]

### Geodata: official scheduled and in-process reload

The `geodata` feature configures a five-field local-time cron schedule. It can reload existing files, or first download HTTPS assets through a chosen outbound (or normal routing), stage replacements, swap files and reload dynamic IP/domain matchers. A still-running scheduled job is skipped. A blank/omitted schedule does not start maintenance. Targets must be existing regular files inside the asset directory; a filesystem reader override does not bypass those path checks. [Feature][geodata], [builder][geodata-build], [downloader][geodata-download], [official guide](https://xtls.github.io/en/config/geodata.html)

The in-process `common/geodata.IPReg.Reload()` and `DomainReg.Reload()` rebuild registered live dynamic matchers and publish replacements without restarting the core. These registries are process-global and unannotated. Both traffic/DNS consumers that use them can benefit; they are not a subscription updater and do not invalidate previously cached DNS answers or re-route established flows. [IP registry][ip-registry], [domain registry][domain-registry]

There is **no stock geodata reload-now RPC, runtime cron edit or download-progress API**. A Go integration can expose a narrow immediate reload command without changing upstream package files, but it must handle asset ownership, errors and serialization itself.

Do not describe the native download/reload path as a globally atomic data transaction: the two registry reloads execute separately and publish matcher replacements individually. File rollback after failure does not automatically undo every matcher already published by an earlier successful registry reload. For Wayrill's central resource manager, choose one owner/scheduler and design a verified recovery path; do not let independent core and service downloaders race over the same files. Live `AddRule` can rebuild traffic-rule conditions, but is not a substitute for reloading all DNS/geodata consumers.

### File-backed TLS certificates and OCSP

TLS certificate code can reload a configured certificate/key pair from paths while refreshing OCSP. Unless one-time loading is enabled, the default check interval is one hour; a nonzero OCSP interval determines the timer period. The reload applies to that certificate setup; changing an unrelated TLS field, inbound port, security mode or outbound settings is not covered. There is no explicit reload-cert RPC. [TLS implementation][tls-config]

This timer is not a generic file-watcher service. In the pinned implementation a file-read error exits the ticker goroutine, and its lifetime is not wired to a general administrative transaction. Verify behavior before relying on repeated in-process listener replacement. Logger restart is a different facility and does not reload certificates.

ECH has a separate DNS-derived configuration cache: `QueryRecord` refreshes expired records under its update lock using DNS TTL. It is not covered by `RestartLogger`, the certificate timer or a public flush-cache RPC. Its exported cache/helper types are unannotated implementation APIs, not a supported general cache-management endpoint. [ECH cache][ech]

## 8. What Wayrill can reuse, and what remains app-owned

| Wayrill area | Current integration / conclusion from this audit |
| --- | --- |
| Rule-only Apply | Already uses the official `AddRule`/`ListRule` path through an authenticated bridge. Preserve domain-strategy/script/DNS eligibility checks and control rules; keep transaction ownership in the service |
| Outbound replacement and subscription refresh | Handler add/remove is official. Wayrill uses a validated configuration and guarded restart for outbound changes, retaining compatible Windows network ownership |
| Telemetry and observatory cards | Already consumes official HTTP `/debug/vars`. gRPC Stats/Observatory are alternatives, not a need to add another parallel collector |
| UDP association defaults | Already uses the public listener controller. No upstream JSON-schema change is needed for app-wide defaults; exact per-SOCKS-node association options remain a separate limitation |
| Direct/chain/outbound tests | External proxy inbounds or an audited Go tagged-dial helper can drive tests. `TestRoute`, `tls ping` and observatory status answer different questions |
| Routing log | Revisit rule webhooks and an app-owned structured sink before extending text parsing. Stock SubscribeRoutingStats cannot simply be enabled; webhooks have the limitations documented above |
| Resource auto-updates | Native scheduled matcher reload and in-process registries are real upstream options worth evaluating. Select one updater, account for DNS consumers and preserve reliable recovery |
| DNS recursion protection | Reuse/audit upstream `SkipDNSServers` where appropriate; it does not replace Windows DNS ownership or dnscrypt-proxy routing |
| Shared FakeDNS | Official in-process pool interfaces exist; cross-process authenticated pool synchronization remains Wayrill functionality |
| Process/service/package/NAT attribution | Basic upstream process lookup and Android injection do not cover the Windows companion contract |
| Adapter retention, uplink changes, TUN/ICS readiness, sharing intent, startup restoration | No equivalent generic Xray administration API; continue using the service's serialized planner/checkpoints and Windows notifications |
| General config replacement or validation | No stock transactional `ReplaceConfig`/validate-current-delta RPC. Build/test prospective state, then choose a supported live plan or the smallest required restart |

Current integration is defined by `service/core-init/udp_windows.go`, `service/core-control/main.go`, `service/daemon/src/live.rs`, `service/daemon/src/traffic.rs` and [the source-build manifest](xray-integration.md). The upstream inventory above remains separate from private app integration.

Reverse-proxy bridges/portals, VLESS reverse behavior, loopback outbounds, fallbacks, DNS protocol listeners, TUN and proxy transports are data-plane features. They can be composed by an app but do not add hidden administration endpoints. Likewise, ordinary OS process control, debugger access, replacing package globals or reaching into a WireGuard/QUIC dependency's internals are not additional supported Xray management APIs.

### Decision process before extending the core

For a future requirement, first identify the exact resource being changed: new socket, handler, rule table, resolver, observation, process or Windows state. Trace that resource's real constructor and lifetime in the pinned source. Check the API implementation, public hooks and embedding path before proposing a JSON field or upstream patch. Establish whether the requirement can be satisfied by an app-owned wrapper around upstream packages. Use a private patch only for a demonstrated gap/defect, with a focused reproduction and a stated stability cost.

For live changes, distinguish admission/decision updates from active-session migration. Check wire-size limits, error/timeout ambiguity, publication-before-start, default-handler behavior, cached resolver/transport state and inverse operations. Do not infer atomicity or persistence from a successful single RPC. Those are concrete design boundaries, not reasons to restart everything by default.

## 9. Upgrade coverage

The source inventory contains declarations, not proof of runtime registration or
reachability. Rebuild it against the verified upstream base on upgrades, review
changed implementations/call sites and run isolated local API checks for any
behavior being relied on. Do not infer current runtime test results from an older
release's probe report. Keep private application extensions separate from stock
upstream facilities.

[api-build]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/infra/conf/api.go
[commander]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/commander/commander.go
[transport-rpc]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/grpc/encoding/stream.proto
[handler-proto]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/proxyman/command/command.proto
[handler-go]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/proxyman/command/command.go
[in-manager]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/proxyman/inbound/inbound.go
[out-manager]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/proxyman/outbound/outbound.go
[user-manager]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/proxy/proxy.go
[router-proto]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/command/command.proto
[router-go]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/command/command.go
[router-convert]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/command/config.go
[router]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/router.go
[balancing]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/balancing.go
[dispatcher]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/dispatcher/default.go
[stats-proto]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/stats/command/command.proto
[stats-go]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/stats/command/command.go
[stats-feature]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/features/stats/stats.go
[observation-rpc]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/observatory/command/command.go
[observation-proto]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/observatory/config.proto
[burst]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/observatory/burst/burstobserver.go
[logger-rpc]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/log/command/command.go
[api-cli]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/commands/all/api/api.go
[api-shared]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/commands/all/api/shared.go
[rules-cli]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/commands/all/api/rules_add.go
[sib]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/commands/all/api/source_ip_block.go
[commands]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/commands/all/commands.go
[run]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/run.go
[convert]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/commands/all/convert/protobuf.go
[tls-ping]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/commands/all/tls/ping.go
[loaders]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/main/confloader/external/external.go
[metrics]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/metrics/metrics.go
[metrics-build]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/infra/conf/metrics.go
[webhook]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/webhook.go
[access]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/log/access.go
[log-hook]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/log/log.go
[log-creators]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/log/log_creator.go
[log-instance]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/log/log.go
[listener]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/system_listener.go
[dialer]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/system_dialer.go
[system-listen]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/tcp_hub.go
[socks-listen]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/proxy/socks/protocol.go
[windows-sockopt]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/sockopt_windows.go
[transport-dial]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/dialer.go
[annotations]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/core/annotations.go
[instance]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/core/xray.go
[core-context]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/core/context.go
[functions]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/core/functions.go
[tagged]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/tagged/taggedimpl/impl.go
[udp-dispatch]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/udp/dispatcher.go
[fake-feature]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/features/dns/fakedns.go
[dns-skip]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/dns_skip.go
[local-dns]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/features/dns/localdns/client.go
[windows-tun]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/proxy/tun/tun_windows.go
[android]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/net/find_process_android.go
[tun-files]: https://github.com/XTLS/Xray-core/tree/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/proxy/tun
[factory]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/type.go
[config-registry]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/core/config.go
[postprocess]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/infra/conf/lint.go
[filesystem]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/platform/filesystem/file.go
[route-script]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/script.go
[dns-script]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/dns/script.go
[noise-script]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/finalmask/noise/script.go
[route-lua]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/lua.go
[dns-lua]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/dns/lua.go
[geodata-lua]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/geodata/lua.go
[lua-program]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/lua/program.go
[lua-pool]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/lua/pool.go
[conditions]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/router/condition.go
[browser]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/browser_dialer/dialer.go
[platform]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/platform/platform.go
[config-build]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/infra/conf/xray.go
[env-reload]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/platform/env_reload.go
[policy-env]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/features/policy/policy.go
[readv]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/buf/readv_reader.go
[freedom-env]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/proxy/freedom/freedom.go
[geodata]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/geodata/geodata.go
[geodata-build]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/infra/conf/geodata.go
[geodata-download]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/geodata/download.go
[ip-registry]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/geodata/ip_registry.go
[domain-registry]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/geodata/domain_registry.go
[tls-config]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/tls/config.go
[ech]: https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/transport/internet/tls/ech.go
