# Runtime lifecycle

Wayrill's service serializes mutations under the kernel lock. Native Windows
ownership remains in the managers and their durable journals. This model gives
those managers a common transition and failure contract; it does not replace
native ownership checks with an in-memory state flag.

The authenticated IPC listener runs independently of native startup recovery.
`service.activity` remains available while the kernel is busy restoring routing;
ordinary commands still use the same serialized kernel and operation gate.
Background maintenance starts only after startup recovery has drained. Listener
ownership also covers initialization failure, so no detached accept loop survives
a failed service run.

## Activation

`activation.rs` owns one sequence:

1. Validate the candidate and choose its plan without retiring healthy routing.
2. Save the protected checkpoint before the first candidate mutation.
3. Retire the scope required by the selected plan.
4. Persist the candidate profile when this is an Apply.
5. Activate and prove readiness.
6. Reconcile owned Windows assignments.
7. Commit by releasing the checkpoint.

Validation/checkpoint failures return directly. Every failure after the checkpoint
runs one guarded inverse. The response identifies the failed phase and preserves
both the initial cause and any recovery failure. A failed inverse retains the
checkpoint; a later Start/Apply cannot overwrite it. Explicit Stop can complete
recovery. Revision checks and monotonic rollback revisions are unchanged.

`kernel/activation.rs` owns the candidate and one immutable `PreviousRuntime`:
profile, prior running state, bootstrap addresses and FakeDNS authority. The old
authority remains alive until the whole transaction commits, rather than only
until a candidate core becomes ready.

Identical healthy Apply/Start can return after health/ownership checks. When a
transaction is needed, exactly one `ActivationPlan` is selected:

| Plan | Changed scope | Inverse |
| --- | --- | --- |
| Rename | Owned adapter aliases | Restore old aliases |
| Rules | Routing tables | Restore the previous tables; use guarded runtime recovery if a control channel fails |
| Replace, preserve network | Runtime cores and required companions | Replace with old runtime using existing owned network |
| Replace, reconfigure | Runtime and required Windows network ownership | Guarded restoration and old runtime activation |

An unsuccessful in-place inverse escalates to guarded replacement. A failed
network-preserving inverse may attempt one cold recovery. Native ownership
proofs still apply; neither path overwrites foreign Windows edits. All successful
inverses use the same profile restoration and settings/checkpoint completion.
If routing was restored but settings or checkpoint completion still fails, the
supervisor retries the pending inverse; a healthy process alone cannot clear it.

Start/Restart and resource reload use the same transaction with `Restart` intent;
they retain the applied revision and deliberately replace the runtime. Apply
allows an in-place plan and advances the profile revision. There are no independent
"allow live" and "replace profile" flags to combine accidentally.

## Retirement and faults

Callers supply a `Retirement` intent rather than independent restore/retain
booleans. The shared policy is in `lifecycle.rs`.

| Intent | Windows proxy assignments | Packet capture / TUN network | FakeDNS authority |
| --- | --- | --- | --- |
| Explicit Stop | Restore still-owned values | Retire; hand back only when sharing is enabled | Release |
| Windows shutdown, Running intent | Retain | Retire; hand back only when sharing is enabled | Release |
| Unexpected service exit, Running intent | Retain | Retire; suspend sharing for recovery | Release |
| Replace, preserve network | Retain | Retain network; replace runtime | Retain until commit |
| Replace, reconfigure | Retain | Retain WinDivert handle; reconfigure TUN network | Retain until commit |
| Main-core fault | Retain | Retain healthy workers and network | Retain |
| Capture, TUN or network fault | Retain | Retire dependent routing; suspend sharing for recovery | Retain healthy authority for recovery |
| FakeDNS fault | Retain | Retire dependent routing; suspend sharing for recovery | Release failed authority |

Core state is a typed enum, serialized as the existing lowercase API strings.
`core.failureSource` identifies a health fault (`core`, `fakeDns`, `capture`, `tun`
or `network`); it is null after a successful start or explicit retirement.

Health evaluation handles one fault per tick, preserving its cause across
cleanup. Desired routing and recovery phase are separate: faults schedule the
single service-owned recovery supervisor, with capped backoff and no total retry
expiry. A successful spawn does not reset backoff until sustained health. A failed
main core retains healthy workers, so those workers continue to be monitored.
A subsequent fault retires that scope and is appended to the original error.
Failure retirement emits its terminal failure after cleanup; it does not briefly
advertise a successful Stop. Unexpected child exit retains the committed Running intent.

This remains an application router rather than an atomic firewall boundary.
Ending TUN or WinDivert capture can release applications to Windows networking.
Native ICS handback can return shared clients to native routing. Retained proxy
assignments do not establish that all applications are contained.

Opt-in app protection adds a separate service-owned WFP barrier around disruptive
transitions. Arm it before retiring routing; readiness and owned Windows settings
must be proved before release. Failed cutover retains the barrier during recovery.
A failed arm must not retire an intact prior generation. Persistent filter
ownership is independent of process/job lifetime. Explicit Stop releases it;
installer retirement retains it across SCM Stop and replacement. This does not
provide continuous containment between transitions; see SYSTEM-TRAFFIC-CAPTURE.md.

## Cleanup contract

`Cleanup` collects results of independent retirement steps. Every step runs;
the first error keeps its API code and subsequent failures retain their named
causes. This contract is used for coordinator, TUN, capture, Windows assignments
and rollback cleanup. It does not parallelize native mutations or continue past
an ownership prerequisite: shared handback still precedes disabling its adapter.

Explicit Stop is the accountable cleanup path and returns failures. `Drop` is
only a final best-effort safety net. Durable recovery journals are removed only
after successful restoration or explicit acknowledgement of external changes.
Telemetry persistence/read failure remains independent of routing health.

A confirmed dead ICS keeper cannot acknowledge preparation or Stop. Retirement
then acquires the existing adapter/mutation locks and reconciles the durable
sharing journal in the coordinator. A live keeper with a transport failure still
blocks that handoff: a lost reply is not proof that its native mutation ended.
This distinction applies to preparation as well as the final Stop, so a dead
helper does not leave the host packet worker running or block every later Start.

The keeper uses one typed, request-correlated completion contract for every
command: native observation plus success/error outcome. Progress is a separate
frame and cannot acknowledge a mutation. Observation, command outcome and process
exit are independent: a failed command publishes the actual retained resources;
a lost/invalid response preserves the last identity and explicitly reports an
uncertain recovery outcome. Only a correlated completion clears uncertainty.
Stop/Keep must additionally observe keeper exit before releasing its client.
Confirmed process death permits guarded journal recovery, never an assumption
that Windows restoration succeeded. Error observations do not drain routing logs.

Repair permission belongs to each resource. A stopped, exclusively available
owned host slot can be explicitly removed even while an independent sharing
recovery is pending. The shared slot remains protected until its keeper and
sharing recovery retire. UI availability and service mutations use the same
resource decision; mutation still verifies the exact installation identity,
protected device token and recorded/observed GUIDs against native sharing. An
aggregate failed/stopped label is never ownership proof.

## Adding another runtime component

1. Put its live resources and durable ownership journal in one manager.
2. Define health/readiness checks and an idempotent explicit retirement method.
3. Choose its retention policy in the existing retirement model.
4. Retain old authority in `PreviousRuntime` if activation rollback needs it.
5. Add its independent cleanup result to `Cleanup`; do not discard it or return
   early before unrelated cleanup runs.
6. Test validation rejection, partial start, post-readiness failure, explicit Stop,
   unexpected exit and service restart. Include actual Windows restoration tests.

Keep asynchronous telemetry generation/epoch checks and bounded startup/network
reconnect scheduling in their existing owners. This model does not introduce a
general event bus, plugin registry, arbitrary transition callbacks or a second
background recovery scheduler.

## Unattended recovery supervisor

The product requirement is [long unattended operation](reliability.md). The
protected `routing-intent.json` preserves desired Running/Stopped state across
desktop closure, worker/core death, coordinator replacement and Windows restart.
It is independent of a process handle and does not contain graph credentials.
An unavailable or invalid intent remains visible; it cannot authorize routing.

The existing serialized kernel owns the sole activation retry schedule. Boot
resumption, runtime faults and failed network reconnects converge on the same
authenticated profile/checkpoint and ownership-checked activation transaction.
Retries back off to at most one per minute and have no total expiry. Thirty seconds
of continuous component health resets crash-loop backoff. Native notifications
still detect/settle link changes; they no longer own a second retry timer.

An explicit Stop cancels durable Running intent before cleanup. The saved boot
auto-start preference can start a new run at the next Windows boot, even after a
previous-session Stop; it cannot re-arm Stop on a same-session service restart.
Failed cleanup can retry toward Stopped without starting a core. A failed intent write is retried
alongside retirement, so successful native cleanup cannot leave a saved Running
intent that would reactivate routing on the next service restart.
The supervisor owns this persistence retry for every Stop caller. Applying a
stopped profile cancels intent before committing the profile, so failure to save
the cancellation leaves the persisted and in-memory profile unchanged.
Windows pre-shutdown restores native sharing and parks capture, but retains owned proxy/environment/WinHTTP
assignments and Running intent for resumption; unexpected coordinator failure
preserves intent and owned assignments for SCM restart. Deliberately disabled
sharing, invalid ownership and integrity failures cannot be bypassed by retries.

The keeper admits one outstanding command. After timeout/lost response, later
attempts observe that command's correlated completion or confirmed process death
before submitting another mutation. Native liveness/progress never constitutes
completion. API status separates desired state, current recovery phase, attempts,
next attempt and last cause; an open desktop is not required.

## Native ICS progress

Native sharing operations run on an owned STA thread. The inherited worker pipe
streams typed, request-correlated observations while Windows is checking,
enabling/disabling sharing, restoring private gateway services, waiting for
private adapter IP/DHCP readiness, and verifying the resulting checkpoint.
Windows COM exposes no fractional completion or reliable cancellation; a report
that the call is still running is liveness, not proof of forward progress.

There is no total native completion deadline. Private adapter readiness is
observed until its expected state is stable; the previous four-second failure
window has been removed. Ownership guards still reject definite foreign changes.
Reports renew inactivity waits through the contained worker, sharing keeper and
public service IPC. Short write/silence bounds remain. Only correctly correlated,
valid phase reports renew them; a progress frame never acknowledges success.

Scoped observers send a bounded latest-value response channel and lightweight
`runtime.activity` events without borrowing the kernel again. The UI shows the
observed phase and elapsed time, using an indeterminate bar during native work.
Later lifecycle snapshots clear the transient detail. Reporting does not control
routing; losing a public client does not replay or cancel the native mutation.

An observer failure in the leaf drains the owned native thread before returning.
Transport loss/process death is an uncertain outcome: retain the durable pending
mutation and reconcile observed roles/checkpoints before any recovery mutation.
Never initiate overlapping rollback merely because Windows is taking a long time.

## Sharing intent

An explicit Stop restores native ICS only while sharing remains enabled. Disabling
ICS TUN and applying, removing an active ICS TUN node, or pressing Stop with a
disabled ICS TUN draft turns sharing off and retains the confirmed adapter pair.
A strict subtraction of the active owned Windows sharing roles is also treated as
sharing-off intent; foreign pairs, mappings and private configuration edits remain
conflicts and are preserved. Missing adapters during boot are not a user disable.
The off intent is protected persistent state and survives service restarts. Automatic
boot routing cannot override it; manual Start/Apply re-enables sharing. An explicit
Windows disable of the owned ICS adapter is also respected; activation re-enables
only its verified owned device.

Enabling ICS TUN reuses the remembered pair without first enabling native ICS, and
re-arms native handback for the next explicit Stop. Apply/Restart retains compatible
network ownership; a cold replacement suspends sharing without enabling native ICS.
A failed activation restores the previous profile and its sharing intent. IPv6
client advertisements and owned leases are released when sharing is disabled;
remembered uplink forwarding is restored on native handback after re-enabling.

`core.stop` accepts optional `disableSharing: true` so Stop can honor a disabled
canvas node even when the draft has not been applied. An applied disabled ICS node
is represented by `capture.sharingDisabled: true`, mutually exclusive with active
`tunSharing`. This is coordinator metadata, never an Xray configuration field.

Native IPv4/IPv6 interface and address notifications invalidate idle ICS snapshots.
Callbacks only increment a static generation counter; the serialized manager
coalesces bursts and inspects the actual COM sharing roles. One inspection at a
time and a two-second minimum spacing prevent notification storms from starting
helper processes repeatedly. A change during an inspection requests one follow-up
snapshot. A ten-second periodic reconciliation remains, because an ICS role edit
is not guaranteed to emit an IP notification. An uplink loss is never by itself
sharing-off intent. Registrations are canceled on manager retirement, outside
callbacks; callback state outlives the process's managers.

Before closing any Wintun adapter, retirement acknowledges an owned ICS device
that Windows PnP disabled. It persists sharing-off intent, reactivates only the
verified owned devnode, and parks the interface administratively down. This
prevents Wintun's orphan maintenance from deleting the retained device, without
re-enabling sharing. The same prerequisite protects the host TUN before worker closure and runs
before startup rehydration and adapter acquisition; foreign devices remain
untouched.

Boot sharing recovery retries only missing-network conditions. A definite Windows
COM failure, invalid ownership record or conflict ends automatic retries and
retains its journal and error for guarded recovery. Progress is never treated as
success, and a still-armed boot window does not authorize repeatedly replaying a
failed native sharing mutation.


## Outbound updates

Changed outbound definitions use the common guarded activation/recovery
transaction, including subscription changes and replacement in the graph.
Candidate configuration is validated before disturbing the current runtime.
Compatible TUN/ICS adapters, sharing ownership and Windows proxy assignments
remain held across runtime replacement. Failure restores the previous profile;
unfinished recovery retains its checkpoint and Running intent.

Only eligible rule changes use the upstream RoutingService without a core
restart. See [Apply plans](lifecycle.md).

## Keeper channel failure and cooperative drain

Host capture is administratively parked while retaining its Wintun handle and
exclusive slot lease before asking the ICS keeper to prepare retirement. If its
response channel is lost, close the request channel and stop accepting replies;
EOF asks the existing owner to drain its in-flight operation, never to cancel or
replay it. Closing the response receiver bounds queued progress during recovery.

The keeper accepts a read-only proof that host capture is already Down/absent;
it must not acquire the same exclusive host lease held by the waiting parent.
Wintun handles remain live until the keeper is prepared or confirmed exited.
A failed native EOF handback can leave a read-only guardian alive; the coordinator
may reconcile its guarded journal only after acquiring the existing keeper/native
mutation locks. It does not kill or supersede an in-flight Windows operation.
Emergency EOF retains the established guarded native-sharing handback behavior.

Incomplete retirement remains an explicit pending transition. The sole supervisor
finishes it before checking whether another activation is permitted, including
when sharing was disabled. Ordinary preflight does the same before selecting a
new plan. Pending retirement is never eligible for healthy network reuse.

## Maintenance admission

The kernel remains the only routing-mutation authority. Service request dispatch
acquires a scoped maintenance-admission reservation before taking its mutex for
competing commands. The maintenance actor owns one cancellable background
reservation; an admitted foreground request cancels/drains it first, without
holding the kernel. Public outbound-test jobs retain their reservation until
completion, including exceptional completion. Library parsing/saves have their
own serialized actor lane and do not own Windows settings or runtime resources.

Reservation lifetime follows executing work rather than a client's connection or
a wall-clock lease. After a candidate enters the existing activation transaction,
its checkpoint/readiness/inverse completes before yielding. Stop therefore cannot
race a late background commit. Service shutdown cancels admission waits and drains
owned work. No frontend pause timer, second activation journal or second retry
supervisor participates in this ordering. See SUBSCRIPTION-MAINTENANCE.md.
