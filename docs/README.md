# Wayrill documentation

These guides describe **Wayrill 0.31.20**, the current Windows x64 beta. Start with
a small working connection, then add routing rules, DNS and automatic maintenance
as you need them.

## First connection

1. [Install and make a working connection](guide/getting-started.md).
2. [Choose a starter or feature example](guide/examples.md).
3. [Build, check and apply a graph](guide/graphs.md).

The [beta scope and limitations](BETA.md) explain the supported platforms,
sharing boundaries and capture behavior.

## Configure a setup

| I want to… | Guide |
| --- | --- |
| Route selected apps or destinations to different exits | [Traffic rules](guide/traffic-rules.md) |
| Choose DNS resolvers, fallback or FakeDNS | [DNS and FakeDNS](guide/dns.md) |
| Use TUN/WinDivert or assign Windows proxy settings | [Windows capture](guide/capture.md) |
| Route a TV/router through Windows sharing | [Internet sharing](guide/sharing.md) |
| Import subscriptions and build reusable groups/chains | [Stash and subscriptions](guide/stash.md) |
| Test a route or inspect traffic rates/history | [Testing and statistics](guide/testing-statistics.md) |
| Select/update GeoSite/GeoIP files or change shared defaults | [Resources and defaults](guide/resources-defaults.md) |
| Back up, move or restore a configuration/filter | [Backup and restore](guide/backups.md) |
| Find a failed route, read logs or report a bug | [Troubleshooting](guide/troubleshooting.md) |

## Reference

- [Protocols and native settings](reference/protocols.md): node families,
  listeners, transport fields and socket buffers.
- [Defaults and inheritance](reference/defaults-catalog.md): effective values,
  overrides, category guide and imported omissions.
- [Xray configuration import/export](reference/xray-import.md): conversion,
  preservation, capitalization repair and execution boundaries.
- [Configuration sizes and limits](reference/limits.md): large subscriptions,
  visible nodes and compiled configurations.

## Contribute

For source work, begin with [Contributing](../CONTRIBUTING.md),
[Windows builds](development/building.md) and [Architecture](development/architecture.md).
The development references cover [tests](development/testing.md),
[releases](development/releasing.md), [service API](development/service-api.md),
[lifecycle](development/lifecycle.md), [reliability](development/reliability.md),
[graph compilation](development/graph-compiler.md) and
[connection layout](development/edge-routing.md).

Core contributors should read the [integration guide](development/xray-integration.md),
[customization inventory](development/xray-customizations.md),
[control mechanisms](development/xray-control.md) and
[default maintenance](development/core-defaults.md). Windows-specific internals
are covered by [capture](development/windows-capture.md),
[the worker](development/capture-worker.md) and [encoding](development/windows-encoding.md).

See [Security](../SECURITY.md) for private vulnerability reports and
[third-party notices](../THIRD_PARTY_NOTICES.md) for component licenses.
