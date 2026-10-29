# Testing

Routine checks must work from a clean clone using documented tools and public
inputs. They must not depend on an installed Wayrill, a maintainer's profiles,
subscriptions, VM addresses or private files.

| What you changed | Command | Requirements |
| --- | --- | --- |
| Editor, graph compiler or shared TypeScript | `npm run check`, `npm test`, `npm run build` | Node.js 24 and `npm ci` |
| Windows service, desktop shell or capture | `pwsh -NoProfile -File tools/Check-Native.ps1` | Pinned Rust, MSVC/SDK; Node dependencies for service/desktop |
| Xray configuration compatibility or service transformations | `npm run test:core` | Public core/service package built from this checkout |
| Complete package | `pwsh -NoProfile -File tools/Build-Windows.ps1` | Windows build prerequisites and public downloads |

## Ordinary checks

`npm test` runs the self-contained suite. It uses synthetic fixtures and does not
discover the executable-backed integration files. `npm run check` also checks
their types and style, so separating execution does not hide broken source.

`tools/Check-Native.ps1` runs formatting, strict all-target Clippy and locked tests.
Use `-Component service`, `desktop` or `capture` to select a workspace. Capture
always covers default and attribution-only features. Service checks also run the
self-contained installer PowerShell contracts with temporary files and mocked
system calls. No service installation, routing activation or elevation is needed.

Local builds and GitHub **Checks** invoke these same commands. The Rust pin,
capture features, static CRT settings, fixture verification and desktop test
configuration are shared. `-SkipTests` retains formatting and Clippy; CI does not
use it. Desktop tests use the same resource-free configuration as desktop dev,
restoring the caller's environment afterwards.

## Core integration

Build the public service/core package with `tools/Build-Networking-Service.ps1`,
then run `npm run test:core`. The command verifies the executable's pin, prepares
its own resource/configuration directory and runs both TypeScript and Rust
acceptance tests. Xray is invoked with `run -test`; it validates configurations
without activating traffic capture or system proxy settings.

There are no optional private inputs and no success-by-early-return cases. If
the executable or source is missing, the command explains what to build. Generated
configurations and core output are under `.tools/core-tests/`. The complete
installer build invokes this suite after building its payload. The manual GitHub
**Windows installer** workflow exercises the same path on an independent runner.

Core builds also run the Go regressions declared in Wayrill's copied/patch test
files and the Lua DNS compatibility control. Cases are discovered from those files
automatically. Broad upstream test-suite and performance audits are separate
maintainer work; unrelated vendor timing assertions do not gate an app build.

## What deserves a regression

Protect observable behavior: routing precedence, lossless import/save,
subscription updates, settings ownership, cancellation, recovery and bounded work.
Prefer a complete representative workflow over multiple tests of its helpers.
A test should fail when supported behavior breaks, not because an internal
representation, label, CSS rule, control placement or catalogue count changes.

Use synthetic profiles and local fake peers. Do not add a dependency on a real
subscription, personal configuration, commercial server or public speed-test
endpoint. Remove superseded tests and unused fixtures instead of leaving them
permanently skipped. A new integration test needs a reproducible setup and an
explicit command, not an undocumented environment-variable switch.

## Testing actual Windows networking

Changes to adapters, sharing, process attribution, protection or installer
lifecycle still require hands-on testing on an isolated Windows machine. This is
separate from ordinary checks. Contributors can use their own disposable setup;
no particular hypervisor or maintainer VM is required.

Record the initial settings and exercise the affected user workflows: activation,
Apply, explicit Stop/restoration, upgrade, service failure or reboot as relevant.
Use synthetic/local traffic to verify routing independently of process health.
Performance measurements should record the graph, peer, packet sizes, offered
rate and machine characteristics; a fixed throughput threshold is not a portable
regression assertion.

Keep machine access, personal profiles, one-off traffic probes, benchmark results
and diagnostic captures outside published source. A contribution should state
which ordinary checks, core tests and installed-system scenarios were actually
run. Passing CI is not a claim that every Windows networking combination was tested.
