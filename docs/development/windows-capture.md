# Windows traffic capture

A WinDivert Local capture node routes monitored-adapter TCP/UDP through a private authenticated Xray SOCKS relay. Data and port-53 DNS branches use the normal graph compiler. Saving/exporting does not start capture; Start/Apply or the central capture panel is explicit.

With an active owned host/ICS TUN, WinDivert yields packets routed into that adapter so the TUN source remains authoritative. The internal start/reconfigure message contains at most two parsed adapter GUIDs in `excludedInterfaces`; braced Windows IDs are normalized by identity, and a reused index does not exclude a foreign adapter. Foreign-adapter choices remain saved; the editor clears stale selections of owned host/ICS adapters. Foreign VPN adapters retain their selected monitoring policy; leaving the payload adapter unmonitored preserves its native inner routes when its encrypted transport is carried through Xray.

## Routing and application identity

Edit adapters selects monitored interfaces, the default for newly discovered adapters and local discovery bypass. Process, service, package, child-process, protocol and destination-port conditions belong in ordered Routing filter rows. Lower input capture priority wins overlapping inputs; ties follow graph order.

Application entries within a row are OR alternatives; other fields and chained rows are AND constraints. Plain process names/paths/folders use Xray native process matching on ordinary inputs. Service/package/child predicates need TUN or WinDivert on the entering path. A filter shared with ordinary Proxy inbounds projects capture-only alternatives onto capture branches and reports a warning; ordinary traffic retains its supported alternatives and fallback. Unsupported required identities must never be discarded to create a broader ordinary rule. A chained process name AND exact path can be narrowed; name AND folder cannot fit one native Xray OR-list and receives an explicit error.

The worker observes process creation generations, ETW ancestry, socket owners and service/module/package identity. It sends the complete matching identity bitmask in runtime-only authenticated SOCKS metadata; Xray then applies domain, IP, port and protocol rules in flattened first-match order. It does not pick the first process row prematurely. Core/worker exclusions use PID plus creation time, preventing reuse leaks. Ambiguous/stale service ownership must not select a sibling shared-host service.

Budgets: 16 capture inputs, 768 distinct application predicates, 4,096 selectors total and 4,096 compatible identity profiles per input within a 2 MiB sidecar. Disjoint identity pruning bounds masks; excess overlap is diagnosed, never truncated. Runtime credentials rotate on core replacement and remain outside saved/exported state. Original source IP/port at Xray still describes the relay, not arbitrary original socket metadata.

Port-53 traffic is DNS only when it reaches the input; encrypted DNS remains Data. Windows resolver traffic can belong to Dnscache rather than its calling application. WinDivert observes that actual owner. Pure Xray export cannot preserve Windows capture/adapter policy; retain the Wayrill graph. Relays cannot be adopted as a Windows system proxy.

## Interfaces and loopback

Settings → System traffic capture → WinDivert / Loopback contains monitored adapters, a first-seen default for new adapters, local discovery bypass, and AppContainer loopback exemptions. Adapter choices use stable IDs rather than transient interface indexes. The service retains discovered choices in its protected `capture-interfaces.json`; explicit graph choices take precedence. Changing the new-adapter default does not reclassify previously discovered adapters. Apply to graph followed by Start/Apply changes capture policy.

Discovery, DHCP, broadcast/multicast and link-local traffic bypass capture by default, before ordinary selectors. This preserves native local-link behavior; it is not a general private-subnet bypass. Disabling the exception is an explicit graph setting. Adapter changes refresh the immutable policy; stale interface flows are retired by the retained engine.

Loopback exemptions are Windows permissions, independent of the graph. The UI reads the current list, shows installed owner packages, filters rows, and enables/disables visible rows without changing hidden selections. Apply permissions sends only changed package families and a version of the entire SID/attribute list. The service rejects stale versions and unknown families, preserves unmatched exemptions and attributes, and reads back Windows after writing. Refresh after a conflict. Windows' API replaces a list; no cross-application compare-and-swap exists, so another application modifying it in the small read/write interval can still race. No exemptions are changed by starting capture, selecting a package, or closing the editor.

## Lifecycle and containment

See [Windows service](architecture.md) for the fixed worker API, job/token boundaries, dependency integrity, runtime replacement, explicit Stop and failure policies. Healthy capture handles remain open during core replacement/reconfiguration; unexpected core failure retains capture and owned proxy assignments. Worker/service loss can close packet handles and cannot promise an atomic firewall boundary. Selected connector failure must not intentionally bypass to a native route.

The contained worker ships source/license/provenance from the adapted v2rayN engine. TCP reflection owns only a fixed scoped firewall rule, recovered by fingerprint; externally edited rules remain untouched. Diagnostics are separate SNIFF/RECV_ONLY counters and never proof of transparent forwarding.

## Capture ownership

See [WinDivert conflict protection](../guide/capture.md). Passive ownership preflight runs before interrupting a working core; activation repeats the check and retains observation while running. Foreign or unknown capture blocks start. The v2rayN application-routing lease remains a second guard. Never unload a foreign/shared driver or interpret a loaded idle driver as proof of active capture.

## API and verification

API v1 carries a separately validated capture plan; rule processes require windivert.ruleProcesses. Status distinguishes applied input tags, active capture, ownership availability and firewall recovery. windows.catalog is read-only; windows.loopback.get/set use bounded owner packages and optimistic snapshot versions. See [SERVICE-API.md](service-api.md) and [verification](testing.md).

Native reference: [WinDivert documentation](https://reqrypt.org/windivert-doc.html).

## Packet cost and bounded reply batching

The Rust receive path stores parsed addresses by value, preserving IPv4/IPv6 family and link-local interface scope without the earlier C# wire-address cache. Ordinary fragment checks and NAT wire-address comparisons do not allocate address objects. Adapter retirement runs when the immutable interface policy changes. Per-flow rule selection reuses a decision only when its selected target is unchanged.

TCP reflection swaps the two IP addresses, preserving their checksum sums, and updates the two ports using RFC 1624. This fast path requires a plain IP header, WinDivert's valid TCP checksum flag and, for IPv4, its valid IP checksum flag. IP options, IPv6 extension headers and offloaded or incomplete checksums retain full native calculation. Reassembly clears captured checksum-valid flags because the reconstructed IP header differs from the captured fragments. Randomized IPv4/IPv6 comparisons against WinDivertHelperCalcChecksums cover short, odd, MTU-sized and large payloads.

Ready UDP replies transfer pooled buffers to a single injection pump, bounded by both 1,024 packets and 2 MiB. It batches up to 128 currently available replies without a batching timer. A full queue drops the reply and returns its buffer rather than growing without bound. The pump checks the original flow's process/endpoint generation, current rule and interface ownership under the policy-publication lock immediately before injection. Failed native injection is never retried; any retained, unsent batch is discarded so a later policy change cannot release an old reply. Stop closes producers and drains all accepted rentals. TCP resets and policy cutovers keep their existing synchronous ordering.

Measure delivered bandwidth, CPU and loss together against a controlled peer. Native injection and virtual NIC costs can dominate; an older managed-worker benchmark is not evidence for the current Rust worker. Keep exact build/configuration and environment in local test receipts, as described in [testing](testing.md).

## Accepted TCP streams

Capture preserves outgoing replies on remotely initiated TCP streams. SOCKET-layer ACCEPT/CLOSE history distinguishes an accepted endpoint from an application-created CONNECT endpoint. Existing server streams are seeded from an established/SYN_RECEIVED/CLOSE_WAIT row belonging to the same PID and listening endpoint. An observed CONNECT takes precedence over that seed, so binding a client to a listener port does not bypass its application policy. SYN+ACK passes before ACCEPT is delivered; this prevents capturing the server side of the handshake. Client SYNs retain normal capture behavior.

Tests cover accepted ownership, historical packets after close, existing listeners, different PIDs/ports and explicit CONNECT overriding a listener seed. Driver sharing and ownership are unchanged; only Wayrill's handles are closed on Stop.

## Network defaults

Receive/injection batches hold at most 128 packets in a roughly 256-KiB buffer; a single packet still cannot exceed 65,575 bytes. Ready replies retain the existing 1,024-packet / 2-MiB global bound and have no batching timer. Per-association UDP sends are bounded by 128 packets and 128 KiB, with 256-KiB Winsock receive/send buffers. The capture handle uses an 8,192-packet / 8-MiB driver queue, retaining the existing time limit. These are per-handle settings; unrelated WinDivert handles and driver registration are not changed.

Rule/interface revocation, process and endpoint generations, final reply ownership checks, cancellation and partial-injection no-retry behavior are unchanged. Increasing buffers reduces avoidable burst drops, while sustained overload still causes loss. Kernel egress exclusions used in the diagnostic fixture are not production exemptions.

## Owned TUN exclusions

windows.catalog exposes captureExcluded on Wayrill-owned adapters and excludedCaptureInterfaces containing the protected retained slot IDs plus active disposable IDs. Both host and ICS slots are unselectable, including when disabled or absent from the graph. Select active skips them; Apply clears stale monitored selections. The service supplies these exclusions independently to the worker on start/reconfigure; explicit selection and Monitor new interfaces cannot override the worker's GUID-based exclusions. Friendly-name matching is not ownership. Foreign VPN adapters remain selectable; index reuse does not inherit the exclusion.

## Process observation recovery

ETW process-event loss and bounded process-queue overflow request a fresh native
process snapshot instead of permanently ending capture. Windows loss counts are
lifetime totals: only a changed count requests another reconciliation. Queued
events are drained before the native read and merged into the same unpublished
snapshot. Existing generation keys, the observation epoch and proven ancestry
survive reconciliation. Current flow ownership recovers from exact native
creation generations and proven parent relationships even when an ETW start was
lost. This does not invent QPC event timing: historical socket lookups still
require the actual observed lifetime. Missing ancestors or package identity stay
unresolved, so uncertain flows are rejected rather than routed to Direct.
Malformed events, native read failures and untrustworthy socket-event history
still fail closed.

A complete native process-table poll also reconciles ETW-only processes whose
exit event was lost before their first polling sample. Proven absence starts a
ten-second retention window; it does not fabricate an exact process exit time.
Known ancestors of live children remain available, while later births cannot
inherit from a parent already proven absent. Post-snapshot births and visible
PIDs with unavailable query access are not declared dead. Only a complete,
successful native enumeration establishes absence. This prevents repeated lost
exits from accumulating indefinitely into a process-history capacity failure.

The ETW callback copies validated event fields only. Native image/package
normalization runs on the snapshot reader, cached per batch, so slow drive
resolution does not stall event delivery. The ETW session uses 64-KiB buffers,
64 initially and up to 128; the application queue remains bounded at 32,768.
It requests independent session delivery, so another consumer's full/stalled
session cannot suppress our provider events. Raw QPC timing uses normal per-CPU
buffers instead of serializing producers into a shared buffer. These are the
[documented ETW modes](https://learn.microsoft.com/en-us/windows/win32/etw/logging-mode-constants).
Loss reports include the actual free/allocated/maximum buffer counts, buffer size,
written count and mode to distinguish producer pressure from lost delivery buffers.

Authenticated TUN ownership rejections report their last classification stage
(freshness, socket/NAT visibility, process ancestry, service identity or generation
validation). Reports are limited to one per ten seconds, with a count of intervening
failures; authentication secrets and destinations are never logged. Rejection
still closes the flow without a fallback identity.

The TUN attribution bridge reports its original observer error before a generic
ended-task message. A reported runtime fault is distinct from resource cleanup:
Stop joins and closes every observer, and reports any actual release failure
without repeating the earlier runtime fault as a failed retirement. Successful
retirement leaves owned retained adapters available to the next Start; their
identity/route/Windows-sharing proofs remain mandatory.

Process queues also enforce a 16-MiB payload budget for variable-length identities; process history enforces a 64-MiB identity budget alongside its generation limit. A poisoned observer control remains unusable for attribution but is recovered for teardown, so native sessions and reader threads can still be released.


### Attribution review invariants

New ETW/native identities are merged before the complete native presence sample
is applied and parent links are rebuilt. An absent process with an unknown exit
cannot become a newly discovered child's parent based on its PID alone. Existing
proven child links remain valid; a matching explicit parent sequence or exact exit
lifetime can establish a new link. Parent metadata changes invalidate contradictory
cached links. Absent generations remain available for ancestry/history but cannot
be returned as current socket owners.

The SCM service inventory retains the process generations paired with its read;
cached service PIDs are never rebound to a newer process generation. A reused
selected-service PID remains unresolved until a fresh catalog establishes its
identity. Changing the selected service names refreshes that inventory immediately.
Snapshot-local decision caches borrow the verified service name rather than
allocating it again for each socket.

The TUN bridge verifies the live creation generation for ordinary matched and
unmatched processes before returning an identity. Kernel/accepted flows without
a process key preserve their existing exemption; uncertainty never creates one.

Transiently missing native image/package metadata is retried while the original
generation's handle stays live. Native image queries reuse one bounded 64-KiB
scratch buffer per inventory. Device-path normalization reuses its drive-query
buffer rather than allocating one for every drive letter. Quiet socket refreshes
skip ancestry rebuilding; periodic native polling still maintains history and
absence expiry. Shared policy-cache locks cover target interning, not selector
matching or native Unicode comparisons.

Retirement always attempts both trace-session stop and consumer closure, then
joins the reader. Actual release errors survive repeated Close calls and reach
the service instead of being reported as successful cleanup. Windows' successful
asynchronous CloseTrace result is accepted. Scoped orphan reclamation remains the
recovery path after unexpected process termination.

## Explicit TUN ambiguity policy

Traffic filters can explicitly Allow ambiguous host-TUN owners and choose their
Unmatched traffic path or a named output. The compiler reserves an otherwise
unreachable identity outside the complete ordinary mask set and prepares scoped
rules before ordinary filter conditions, while preserving connected DNS branches.
A DNS traffic filter owns its own policy; an unfiltered resolver inherits the Data
filter's choice. The bridge returns that identity
only for a fresh Ambiguous decision. Missing/stale identities, generation changes,
service/NAT uncertainty and observer/authentication failures retain rejection.
No candidate process is guessed. Downstream filters require their own Allow policy;
Block remains the default. ICS clients and WinDivert attribution are unchanged.
The bridge pads ordinary identities if the sentinel requires a wider encoding;
WinDivert keeps its original width. Changing this policy uses the existing
capture-plan activation/recovery transaction.
