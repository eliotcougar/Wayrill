# Contributing

Read the [architecture](docs/development/architecture.md) and the relevant source
contract before changing networking. The Windows service owns privileged actions;
the frontend stages user intent. Keep changes focused and preserve that boundary.

Use [build instructions](docs/development/building.md) and [tests](docs/development/testing.md).
Include a minimal reproduction, behavior change, validation and limitations in
pull requests. Keep fixtures synthetic and independent; retain useful regression
tests. Never use a contributor's active VPN or network as an automatic test target.

Report user-visible bugs with versions, steps and sanitized diagnostics. Do not
commit credentials, private subscriptions, machine-specific graphs or VM access
instructions. Use `.local/` for private working files; `.tools/` is a generated
cache. Maintained build scripts belong in `tools/`.

Preserve per-component licenses. Core changes require updating the
[customization inventory](docs/development/xray-customizations.md), corresponding
source and binary/source pins. Do not bypass integrity checks to make a build pass.

Before proposing a release, follow the [release checklist](docs/development/releasing.md).
