# Documentation

User guides explain the app. References describe the current source and pinned
Xray version. Development notes are for contributors. Local test reports, VM
access instructions and historical research are not published here.

## User guides

| Task | Guide |
| --- | --- |
| Install, start, stop and use the tray | [Getting started](guide/getting-started.md) |
| Build, check and apply a graph | [Graphs](guide/graphs.md) |
| Choose a starter or demonstration | [Examples](guide/examples.md) |
| Define rules and maintain external sources | [Traffic rules](guide/traffic-rules.md) |
| Configure real DNS, fallback and FakeDNS | [DNS](guide/dns.md) |
| Capture traffic and manage Windows proxy settings | [Windows capture](guide/capture.md) |
| Route the Windows shared connection | [Internet sharing](guide/sharing.md) |
| Manage profiles, subscriptions, groups and chains | [Stash](guide/stash.md) |
| Test outbounds and inspect live traffic | [Tests and statistics](guide/testing-statistics.md) |
| Manage GeoSite/GeoIP and defaults | [Resources and defaults](guide/resources-defaults.md) |
| Move or protect configurations | [Backup and restore](guide/backups.md) |
| Find logs and diagnose failures | [Troubleshooting](guide/troubleshooting.md) |

Read the [beta boundaries](BETA.md) before relying on an unfamiliar setup.

## References

- [Protocols/native fields](reference/protocols.md), [Xray import/export](reference/xray-import.md)
- [Defaults catalogue](reference/defaults-catalog.md), [execution limits](reference/limits.md)

## Development

- [Windows builds](development/building.md), [tests](development/testing.md), [releases](development/releasing.md)
- [Architecture](development/architecture.md), [service API](development/service-api.md),
  [lifecycle](development/lifecycle.md), [reliability](development/reliability.md)
- [Graph compiler](development/graph-compiler.md), [orthogonal links](development/edge-routing.md)
- [Windows capture](development/windows-capture.md), [worker](development/capture-worker.md),
  [encoding](development/windows-encoding.md)
- [Xray integration](development/xray-integration.md), [customizations](development/xray-customizations.md),
  [control mechanisms](development/xray-control.md), [source inventory](development/xray-control-inventory.json),
  [core defaults](development/core-defaults.md)

[Project notices](../THIRD_PARTY_NOTICES.md) link to component licenses.
