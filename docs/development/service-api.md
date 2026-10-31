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

`wayrillctl` is a diagnostic client of this same fixed API. For commands use its
help and current schema; it is not a privileged shell. Exported profiles and
diagnostics may contain sensitive data. Keep private test receipts outside Git.

See [lifecycle](lifecycle.md), [architecture](architecture.md) and
[capture scopes](../guide/capture.md).
