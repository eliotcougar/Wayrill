# Architecture

| Component | Responsibility |
| --- | --- |
| React/TypeScript editor | Draft graph, atomic editors, library views, checks, user intent and diagnostics |
| Tauri desktop | Windows UI integration, protected owner storage, file dialogs, tray and authenticated service transport |
| Browser Companion and native host | Current-tab request domains and read-only destination correlation with service routing observations |
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

See [lifecycle](lifecycle.md), [reliability](reliability.md), [service API](service-api.md),
[compiler](graph-compiler.md), [generated tags](generated-tags.md) and
[Xray integrations](xray-customizations.md).
