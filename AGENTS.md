# Wayrill contributor instructions

Windows routing application: React/TypeScript/React Flow, Tauri, a privileged
Rust service, separate capture/attribution workers and custom pinned Xray cores.

## Preserve the boundaries

- Keep instructions durable. Task progress, temporary permissions and private
  test evidence do not belong in source instructions or public documentation.
- Preserve unrelated work, private profiles, credentials and ownership journals.
  Use recovery snapshots when version history is unavailable.
- Never use a workstation's active VPN/remote-access connection as a mutation
  test target. Native networking tests belong in a disposable Windows environment.
  An optional ignored `.local/VM-CONTROL.md` may describe a local fixture.
- The editor owns drafts and user intent; the service owns activation, privileged
  settings and recovery. Follow [architecture](docs/development/architecture.md),
  [lifecycle](docs/development/lifecycle.md) and [reliability](docs/development/reliability.md).
- Long unattended runs are a product requirement. Preserve Running intent across
  transient failures; only explicit user/admin action stops routing. Startup
  before logon may begin a new run according to the saved preference.
- Use serialized transactions/checkpoints and the least disruptive supported
  activation plan. Restore only proven-owned settings; preserve external edits.
- Keep draft, shared Stash, applied revision and runtime distinct. Stash-linked
  definitions are shared; replacement may activate a route. Never apply unrelated
  drafts as a side effect.
- Traffic rules are first-match; DNS preferences/fallback have different semantics.
  Proxy DNS outputs do not imply system DNS capture. Use Inbounds, Outbounds,
  Local capture and node Inputs/Outputs consistently.

## Core and helper work

Follow [core integration](docs/development/xray-integration.md) and manifests.
Update [the customization inventory](docs/development/xray-customizations.md)
for every patch, copied Go file, transform or upstream upgrade. Review/rebuild
defaults with core changes. Never bypass binary/source integrity guards.
Use existing upstream mechanisms before adding a core extension.

Capture/attribution is a separate GPL leaf workspace, not linked into the MIT
coordinator. Preserve its contained processes, optimization level 3, static CRT,
source/provenance and notices. Never unload a shared WinDivert driver as cleanup.

## Tools and verification

Maintained scripts live in `tools/`; `.tools/` is ignored cache/output. Use
curl-mingw with OpenSSL/LibreSSL for HTTPS. For native builds, load
`tools/Enter-BuildEnvironment.ps1`; see [building](docs/development/building.md).

- Frontend/graph changes: `npm run check`, `npm test`, `npm run build` and affected
  browser/desktop interactions.
- Native changes: run `tools/Check-Native.ps1` for the affected workspaces. Local
  builds and CI share this entry point and `rust-toolchain.toml`; keep check
  commands there rather than duplicating them in workflows or packaging scripts.
- Core changes: affected Go regressions, source/default guards and executable
  configuration acceptance; acceptance is not live traffic evidence.
- Installer/system changes: affected disposable-VM scenarios and restoration.
  Do not run broad ignored/mutating suites against the host.
- Documentation changes: link, command, source/pin and publication-content checks.
  Distinguish unit, installed VM and physical Windows evidence.

Keep useful independent regressions. Do not replace straightforward logic with
ad-hoc workarounds or add weak tests that only mirror the implementation.
