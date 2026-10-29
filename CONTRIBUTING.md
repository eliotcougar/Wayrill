# Contributing

Contributors submit changes from a branch through a pull request. PRs require
passing frontend/native checks, dependency review and CodeQL analysis against the
current base, with review conversations resolved. This single-maintainer project
does not require a second person's approval. Repository administrators retain
direct-push access for owner/agent work after appropriate local checks; CI and
CodeQL run afterward. Administrators should use the normal checked path when
merging PRs. An available bypass is not evidence that validation passed.

Deletion and force pushes to the default branch are blocked for everyone,
including administrators. The two policies are recorded in
[.github/rulesets](.github/rulesets).
Repository administrators apply them in GitHub Rulesets; cloning or building the
project does not change a fork's settings. Update the checked-in policy and the
GitHub configuration together when changing requirements or check names.

Read the [architecture](docs/development/architecture.md) and the relevant source
contract before changing networking. The Windows service owns privileged actions;
the frontend stages user intent. Keep changes focused and preserve that boundary.

Use [build instructions](docs/development/building.md) and [tests](docs/development/testing.md).
For editor work, start with `npm ci`, `npm run check` and `npm test`; no installed
Wayrill or VM is needed. Native checks share `tools/Check-Native.ps1` with CI.
Core acceptance has its own explicit `npm run test:core` command after building
the public core package. The manual **Windows installer** GitHub workflow builds
the complete installer using public inputs and needs no repository secrets.
For frontend appearance changes, follow the [styling guide](docs/development/styling.md).
Include a minimal reproduction, behavior change, validation and limitations in
pull requests. Keep fixtures synthetic and independent; retain useful regression
tests. Never use a contributor's active VPN or network as an automatic test target.

Report user-visible bugs with versions, steps and sanitized diagnostics. Do not
commit credentials, private subscriptions, machine-specific graphs or VM access
instructions. Use `.local/` for private working files; `.tools/` is a generated
cache. Maintained build scripts belong in `tools/`.
Do not add maintainer-specific probes to ordinary suites or make tests silently
succeed when a private fixture is absent. Preserve useful behavior checks with
synthetic inputs and reproducible setup.

Preserve per-component licenses. Core changes require updating the
[customization inventory](docs/development/xray-customizations.md), corresponding
source and binary/source pins. Do not bypass integrity checks to make a build pass.

Before proposing a release, follow the [release checklist](docs/development/releasing.md).
