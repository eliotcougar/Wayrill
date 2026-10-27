<p align="center"><img src="public/brand/wayrill-mark.svg" width="96" alt="Wayrill"></p>

# Wayrill

**Build your routing as a graph. See where traffic goes, and why.**

[![Checks](https://github.com/eliotcougar/Wayrill/actions/workflows/checks.yml/badge.svg)](https://github.com/eliotcougar/Wayrill/actions/workflows/checks.yml)

Wayrill is a Windows application built around Xray-core. Connect local capture
sources and proxy inbounds to traffic filters, DNS handlers and outbounds on a
visual canvas. Use it for a local proxy, application-specific routing or a shared
connection with several exit paths.

**Beta · Windows 10/11 · x64.** This is early software that
changes Windows networking settings. Keep a working backup and an alternative
way to reach a remotely managed PC. No proxy service or subscription is included.

![Wayrill graph editor](docs/images/wayrill.png)

*Traffic and DNS routing on the same canvas.*

## What makes Wayrill different

- **The graph is the configuration.** Data, DNS requests, resolver selection and
  observation have distinct connections. Follow a path through ordered rules to
  its destination. Chained filters flatten into Xray rules; the live Traffic log
  shows which rule and output each connection used.
- **Outbounds are interchangeable.** Use a server, policy group or proxy chain
  in the same place. Keep reusable definitions in Stash, star favorites and
  replace the Main outbound from the graph or tray. Replacement applies the
  new route without applying unrelated graph edits.
- **Host and shared traffic have separate paths.** TUN captures the host; ICS
  TUN independently routes Windows' shared connection. WinDivert remains
  available. Host rules can include executable paths, child processes, Windows
  services and packaged apps.
- **DNS is visible too.** Connect domain preferences, multiple resolver groups,
  real fallback and FakeDNS. Browse GeoSite/GeoIP groups and preview expressions
  instead of guessing dataset names.
- **The Windows service owns networking.** Routing, subscription/resource
  maintenance and recovery continue with the editor closed. Optional startup
  before sign-in, retained adapters and guarded changes support unattended use.
  The editor remains unprivileged.
- **Maintenance protects deliberate choices.** Refresh large subscriptions,
  optionally remove unreachable servers, retain locks/referenced profiles, and
  update groups/chains. URL/file-backed traffic filters preserve local additions
  and overrides through manual updates.

For example, keep local destinations Direct, send selected apps through a
low-latency group, route TV domains through another exit and inspect the rules
actually used.

## Start here

1. Download the complete x64 installer from [Releases](https://github.com/eliotcougar/Wayrill/releases).
   It includes the matching networking service.
2. New workspaces open **Local proxy → Direct**: a local-proxy starter, not a
   configured remote service.
3. Import your profiles/subscription into **Stash**, then replace Direct with
   the desired outbound, group or chain. Or choose **File → Load Example**.
4. Use **Check**, then **Validate** in its results. **Start / Apply** activates
   routing. Editing or saving alone changes no traffic.
5. Point apps at a proxy input through **System traffic capture**, or use a
   TUN/WinDivert local capture source.

[Getting started](docs/guide/getting-started.md) · [Examples](docs/guide/examples.md) ·
[Documentation](docs/README.md) · [Troubleshooting](docs/guide/troubleshooting.md)

## Included tools

- Protocol editors, native fields, Xray JSON import/export and validation.
- Observatory monitoring, policy groups, ordered chains and tray switching.
- Delay, optional UDP, exit-IP and speed tests; live rates, totals, graphs and
  per-source/outbound counters.
- Windows proxy, proxy environment variables, WinHTTP, adapter selection,
  loopback permissions and selected-app protection during routing transitions.
- Portable full/Graph/Stash/filter backups with optional password encryption;
  light, dark and system themes.

## Beta boundaries

Windows x64 is the current target. Linux, macOS, mobile and ARM64 builds are not
provided. ICS TUN uses Windows ICS; per-client IP/MAC routing is not implemented.
Shared IPv6 needs host TUN and the documented private-network prerequisites.
App protection covers transitions, not unconditional always-on containment.
Import cannot recover an original canvas; unsupported combinations are reported.

Wayrill builds **custom Xray executables** for Windows integration and shared
FakeDNS. They are not the stock release. The [customization inventory](docs/development/xray-customizations.md),
patches and pinned inputs are included. Read the [beta notes](docs/BETA.md).

## Build and contribute

React/TypeScript and Tauri provide the desktop; Rust provides the Windows
service and separate capture/attribution worker. Go supplies Xray integrations.

```sh
npm ci
npm run check
npm test
npm run build
```

These check/build the frontend. A functional installer also needs the native
service and core payloads: follow [Windows builds](docs/development/building.md).
See [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md). Remove private
credentials and subscription tokens from public reports.

## License and credits

Application/coordinator code is MIT-licensed. The contained capture/attribution
worker is GPL-3.0-only; Xray-derived code is MPL-2.0. Other components retain
their licenses. See [LICENSE](LICENSE), the worker's [license](service/capture/LICENSE)
and [third-party notices](THIRD_PARTY_NOTICES.md).

Thanks to [Xray-core](https://github.com/XTLS/Xray-core), [v2rayN](https://github.com/2dust/v2rayN),
[Tauri](https://tauri.app), [React Flow](https://reactflow.dev),
[libavoid-js](https://github.com/Aksem/libavoid-js) and the resource-list maintainers.
