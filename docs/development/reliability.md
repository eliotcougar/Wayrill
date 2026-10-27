# Reliability and unattended operation

Wayrill is intended for very long unattended runs. This is a core product
requirement, not an optional optimization or a temporary testing exception.

The user's instruction is: the app must remain operational through network
disruptions, restarts and failures, and stop only following an explicit user
action. A transient failure does not revoke the user's routing intent.

The Windows service is the privileged controller and remains available while
routing is stopped. App Start/Stop controls the routing runtime (Xray, capture,
TUN and sharing), rather than the controller's Windows service state. The saved
boot preference starts routing; merely observing a running service is not proof
that routing is active or healthy.

## Required behavior

- Keep desired routing state separate from observed process/network state.
  Once the user starts routing successfully, preserve that intent across desktop
  closure, worker/core crashes, service restarts, Windows restarts, sleep and
  network changes. Only an explicit user/administrator stop changes it to Stopped. The saved
  **Start at boot before sign-in** preference is authorization to start a new run
  on the next Windows boot, even if the previous session was stopped. A service
  restart within the same Windows session must not re-arm that Stop.
- Automatically recover the last committed working configuration without an open
  desktop, a signed-in operator, a confirmation dialog or a Start/Retry click.
  Pre-sign-in execution requires a validated restricted service identity and
  accessible configuration assets; expose that requirement clearly.
- Retry intermittent failures for as long as the desired state requires it.
  Backoff must limit CPU/process churn and restart storms, rather than expire
  recovery after a total duration or a fixed number of failures. Reset backoff
  only after sustained health, not merely a successful process spawn.
- Observe dependencies and native ownership before acting. Timeouts and lost
  replies mean uncertain completion, not cancellation. Never submit overlapping
  native mutations or start rollback against an operation still in flight.
- Reconcile partial starts/stops, protected checkpoints, retained adapters,
  Windows assignments and sharing journals idempotently. Reuse healthy resources;
  retire/recreate only the scope that actually requires it.
- Keep recovery safe: do not adopt foreign devices, overwrite external Windows
  changes, bypass authentication/integrity checks or silently route through Direct
  to claim success. Explicitly disabled sharing/capture remains disabled.
- Keep unresolved conditions visible while preserving desired intent and useful
  diagnostics. An unsatisfied external prerequisite is not a successful Stop or
  proof that routing works. Monitoring and diagnostics faults should not take down
  otherwise healthy routing.
- An explicit Stop cancels pending activation/recovery before cleanup starts.
  Failed cleanup can retry toward Stopped; it must not re-arm Running. An Apply
  or shutdown must not race watchdog recovery. Preserve these decisions durably.
- Bound every queue, cache, log, history and task lifetime needed for indefinite
  operation. Test repeated faults and long outages, not just a single happy path.
