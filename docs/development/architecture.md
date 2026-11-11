# Architecture

| Component | Responsibility |
| --- | --- |
| React/TypeScript editor | Draft graph, atomic editors, library views, checks, user intent and diagnostics |
| Aquifer editor | Remote server graph, SSH/SFTP deployment and server-specific validation |
| Shared core and UI packages | Pure Xray semantics, native-config editing, common controls and graph geometry |
| Tauri desktop | Windows UI integration, protected owner storage, file dialogs, tray and authenticated service transport |
| Browser Companion and native host | Current-tab request domains, read-only route correlation and bounded requests to open the desktop rule editor |
| Rust networking service | Applied state, activation/recovery, core/helper lifetimes, subscriptions/resources and owned system settings |
| Restricted subscription engine helper | Fixed bundled parser/compiler code in QuickJS; no arbitrary OS/network imports |
| Capture/attribution workers | Contained native packet/process/NAT/catalogue/sharing operations; separate GPL leaf workspace |
| Custom Xray processes | Routing, DNS, observations/statistics and isolated TUN execution with shared mapping integration |

Draft, Stash, applied revision and runtime are separate state. Saving a draft is
not activation. The service serializes mutations, stages/validates configuration,
retains rollback state and selects the least disruptive supported plan. Rule-only
updates can be live; outbound changes use guarded restarts. Compatible retained
adapters/sharing ownership survive core replacement.

Running intent survives intermittent failures and drives recovery until explicit
Stop, subject to Windows session/boot behavior and saved startup preference.
The coordinator's SCM Running state is not proof that traffic is routing.
Monitors report observed state; stale replies cannot overwrite newer operations.

System changes use narrow privileged methods and ownership journals. Restore
compares current state against owned leases and preserves foreign changes.
Helpers run in contained jobs; their exit/pipe lifetimes belong to the service.
UI disconnection must not silently retire a healthy runtime.

Wayrill and Aquifer share pure configuration behavior through `packages/core`:
native JSON/projections and field-name correction, routing predicates and aliases,
IP ranges, process selectors, listener validation/import, subscription link parsing,
outbound-settings mapping/validation, default omission, transport tuning and
outbound dependency checks. App wrappers supply their own resource budgets,
defaults and pinned schemas. The shared package
must not import either app's graph model, service client or platform integration.
Stash persistence and subscription maintenance remain app-owned; sharing a
parser does not require identical storage formats or refresh policies.

Common controls and canvas geometry belong in `packages/ui`, including node
placement. Local capture/ICS activation and remote SSH deployment retain separate
owners; similar orchestration code does not imply identical lifecycle semantics.
Test shared behavior once, then exercise the app boundaries where import,
editing, compilation or deployment can change it. The core integration suite
compares both compilers' routing decisions with Xray's `TestRoute` handler.

See [lifecycle](lifecycle.md), [reliability](reliability.md), [service API](service-api.md),
[compiler](graph-compiler.md), [generated tags](generated-tags.md) and
[Xray integrations](xray-customizations.md).
