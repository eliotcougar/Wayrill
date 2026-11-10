# Local service API

The desktop communicates with the networking service through
`\\.\pipe\Wayrill.Service.v1`. It is a local authenticated Windows transport, not
an HTTP listener. The service authorizes the caller and privileged operation;
pipe access alone is not permission for arbitrary execution or file access.

## Sources of truth

- [Protocol types and envelopes](../../service/protocol/src/lib.rs)
- [JSON schema](../../service/api.schema.json)
- [IPC framing/client](../../service/ipc/src/lib.rs)
- [Service implementation](../../service/daemon/src)
- [Frontend client](../../src/serviceClient.ts)

These sources define exact fields, limits and errors. Avoid maintaining a second
handwritten copy of every response shape here. Requests identify API version 1;
incompatible versions and unsupported operations are rejected. Capability/state
responses determine which controls a client can offer.

## Interaction model

Requests/responses/events are bounded UTF-8 JSON frames. Correlation identifiers
separate replies from asynchronous events. Clients must handle disconnects,
timeouts and unsolicited state updates without accepting stale operation state.
Inspect advertised capability/availability before enabling a control.

The service's status is authoritative for applied configuration, routing state,
maintenance and Windows ownership. Its SCM Running state is not equivalent to
active routing. UI-local graphs and protected editor saves are not the service's
applied profile or authoritative subscription library.

Activation validates a candidate, chooses a live-update or guarded-restart plan,
prepares rollback state, changes owned components and commits only after readiness.
All competing activations/maintenance use the common admission and lifecycle
logic. Failed retirement/recovery remains visible rather than being rewritten
as an idle success.

Versioned writes reject stale baselines. Refresh/read current state before
merging a concurrent edit; never retry a stale save as an unconditional overwrite.
Large subscription documents use bounded reads/staging and a validated commit.
The accepted source/hash and applied revision distinguish library changes from
activation. A disconnected UI does not cancel healthy service-owned maintenance.
Background context updates coalesce without holding the library-save lane.
Explicit library saves and outbound assignments interrupt maintenance checks or
downloads; their completed work is retained and drained before the edit runs.

Settings methods select Windows scope explicitly. Clear/Restore are distinct:
clear changes the selected channel, restore checks its owned snapshot. Resource
updates track content/reload generations independently from authored graph
revision. Probe jobs have explicit lifetimes and preserve unrelated prior results.

`routing.diagnosticStart` accepts a normalized configuration snapshot and either
a synthetic routing context or a DNS query. It returns a job token; poll
`routing.diagnosticGet`, and cancel with `routing.diagnosticCancel`. The job
holds maintenance admission until completion, blocks resource-file replacement,
and is canceled/drained during service shutdown. It never applies a profile or
changes Windows settings. The private restricted worker has a 12-second query
deadline and an outer process deadline. Responses contain a matched original
rule index/action or DNS answers/rcode plus a bounded resolver trace. Application
contexts are supplied identities, not assertions about live socket ownership.
The capture companion evaluates child/app/service selectors with its live matcher;
native process conditions retain Xray's process-name/path matching semantics.
Accepted native field spellings are normalized before service inspection, including
DNS server tags, forwarding addresses, routing webhooks/scripts and socket options.
Dictionary keys and user values retain their original spelling.

Applied display metadata also carries an optional `observed` map from a generated
probe alias to its public outbound tag. The service validates both tags against
the applied config and uses this map to report Observatory results for plain
outbounds and chains. It is presentation metadata, not a routing instruction;
opaque compact aliases do not need to be decoded on each polling cycle.

`routing.activity` is an optional read-only graph decoration feed. It returns
counts by compiled rule index over the previous two seconds, scoped to the
current routing generation and revision. It reuses the bounded routing log and
monotonic arrival times; it neither drains the log nor includes destinations.
The editor polls once a second only while the glow is enabled and visible,
rejects stale replies, and fades after telemetry loss. Compiler provenance maps
each matched rule to its selected wires; sharing an outbound is not evidence of
activity on another branch. Primary inbound Data ports reuse byte-rate telemetry.
No Xray modification or routing configuration change is needed for collection.

`companion.routes` accepts at most 128 exact ASCII/IDNA hosts or IP literals. It
projects the memory-only routing log into bounded last known destination observations,
with display names, observed Block actions and rule trails. Matches retain their
own generation/revision and timestamp across activation and Stop, without an age
expiry; a newly observed epoch replaces the older route set for that host. Log
history/cache capacity and service restart still bound retention. Results are destination correlations across apps, not per-tab attribution
or route predictions. The separate `wayrill-companion` native messaging host exposes
this read operation to the unpacked [browser Companion](../guide/browser-companion.md).
Its separate `editDomain` method validates one hostname and at most eight filter
IDs, then launches the fixed installed desktop as the same Windows user. It does
not forward a service mutation. The desktop queues the intent, waits for existing
editors, and changes only its draft after user confirmation. Requests remain queued
until dismissal so a renderer remount cannot consume an unseen intent.
The desktop launch inherits no Windows handles from the bridge, so closing a
browser cannot leave its messaging/control pipes held open by the desktop.
Its native-messaging envelope reports the bridge's compiled `extensionVersion` in
both success and error replies, independently of the routing service's availability.

The Chromium native host also exposes `timezoneGet`, `timezoneSet` and
`timezoneNotify`. Set accepts `{policy, expectedRevision}`; policy contains mode,
IANA zone and optional Stash selection/lookup metadata. Browser identity is
discovered by the native helper, never supplied by the extension. The service's
`companion.timezoneGet/Set` verify that OS process identity and persist a separate
browser preference. Live native application runs as the normal browser user,
outside the kernel lock. See [timezone lifecycle](companion-timezone-prototype.md).
The desktop uses `browserTimezone.list`, `.refresh`, `.add`, `.set` and `.remove`. Add accepts
one local executable `path` or a catalogued package `package` family. Set accepts
a configured/detected record `id`, `expectedRevision` and validated `policy`.
Remove preserves a hidden Off record for recovery of surviving processes. The
service's independent supervisor uses the attribution helper's `timezone.scan`
inventory and applies as the owner in the target desktop session, without
requiring routing or Companion. Explicit executable policy wins over package
policy. `timezone.probeStart` aliases the existing isolated outbound timezone job.
Both timezone pickers use `subscriptions.timezoneChoices`. It searches cached
metadata for the current Stash version outside the routing lock and returns up
to 200 matching outbounds. An optional `selected` reference returns its display
metadata independently of the filter, so a saved choice can stay selected outside
the results. The response version is required when starting the outbound probe.
Firefox and detected Node/Electron images report `phase: startup` once their
owned exact-path startup registration is prepared. Changes, including Off,
require fully quitting and reopening those apps; this is distinct from live
native activation. Package executables are discovered from verified process
identity and remain reconcilable while closed and across service restarts.
This is package identity, not a service command: an unpacked copy may use the
browser's reload API only after its local manifest matches that version and key.

`resources.browse` also accepts `domain` for an offline reverse GeoSite lookup.
It is mutually exclusive with entry/group/attribute search. The existing bounded
worker runs the private core's isolated matcher as LocalService, without starting
a routing core or changing Windows settings. File generation and stamps guard the
cached result, and the normal `ready`/pagination contract remains unchanged.

`wayrillctl` is a diagnostic client of this same fixed API. For commands use its
help and current schema; it is not a privileged shell. Exported profiles and
diagnostics may contain sensitive data. Keep private test receipts outside Git.

See [lifecycle](lifecycle.md), [architecture](architecture.md) and
[capture scopes](../guide/capture.md).
