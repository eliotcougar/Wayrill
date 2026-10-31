# Building Wayrill

Start with the part you want to change. Working on the graph editor does not
require a Windows service, driver, subscription, test VM or installed copy of
Wayrill. The complete installer is a separate build that includes the networking
components and their corresponding sources.

## Graph editor

Install Node.js 26 LTS and Git, then clone your fork or this repository:

```powershell
git clone https://github.com/eliotcougar/Wayrill.git
cd Wayrill
npm ci
npm run check
npm test
npm run dev
```

Open the local URL printed by Vite. The browser runs the editor without starting
Windows routing. Use the bundled synthetic examples to work on graph behavior.
`npm run build` produces the frontend in `dist/`.

The `.node-version` file selects the supported Node major for version managers
and CI. Use its latest LTS patch release; the installed application does not
require Node.js.

`npm run typecheck` uses the native TypeScript 7 compiler through the
`@typescript/native` package alias. Linting uses Oxlint with its native type-aware
backend. The `typescript` 6.x library and ESLint peer dependency remain for the
React JavaScript plugins that check component lifecycles and resource cleanup;
routine checks do not invoke the TypeScript 6 compiler or the ESLint CLI.
Use the npm scripts so compiler selection is explicit.

## Windows desktop and native components

For Tauri or Rust work, also install:

- Windows x64 and PowerShell 7 (`pwsh`).
- Rustup. The repository's `rust-toolchain.toml` selects the compiler, rustfmt and
  Clippy; do not substitute a floating compiler version.
- Visual Studio 2022 Build Tools with **Desktop development with C++** and a
  Windows SDK. The scripts discover this installation automatically. An existing
  x64 Developer PowerShell also works.

Run the same native checks used by GitHub:

```powershell
pwsh -NoProfile -File tools/Check-Native.ps1
# Or select one workspace:
pwsh -NoProfile -File tools/Check-Native.ps1 -Component capture
```

Run `npm ci` first for the service or desktop workspace. Capture is a separate
Rust workspace and does not need Node. The service checks obtain public geodata
fixtures; see the download requirement below. Native checks do not install a
service or driver, change adapters, or alter Windows proxy/sharing settings.

To work on the desktop shell without building networking payloads:

```powershell
npm run desktop:dev
```

This uses a development configuration without installer resources and a separate
application-data identity. An absent networking service is expected in this mode;
use an isolated Windows test machine when testing privileged routing behavior.

## Complete installer

In addition to the tools above, provide curl built with OpenSSL or LibreSSL.
The scripts deliberately avoid Windows' bundled curl. Set its path if automatic
discovery does not find it:

```powershell
$env:WAYRILL_CURL = 'C:\path\to\curl-mingw\curl.exe'
pwsh -NoProfile -File tools/Build-Windows.ps1
```

Some security policies quarantine capture-driver archives. Review any detection
against the official release under your machine's policy, or use the isolated
GitHub build workflow. The scripts do not change antivirus exclusions.

The first build downloads public, pinned Xray/Go/WinDivert inputs and geodata.
It verifies their hashes, builds both custom cores and capture workers, runs
ordinary checks, maintained core-extension regressions and executable-backed
compatibility tests, then packages the service and
desktop installer. No running Wayrill, credentials or VM is required. Building
does not install the result or change the machine's networking.

Base XTLS geodata comes from a pinned Xray release archive, with both archive
and extracted-file hashes checked. Daily rules releases are pruned upstream and
are unsuitable as long-lived build inputs. Core compilation and its maintained
Go regressions do not require geodata downloads.

The installer is written under
`.tools/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. Build logs are under
`.tools/logs/`. `-SkipTests` is available for a build iteration; it still runs lint
and integrity checks, but is not a substitute for verification before submitting.

Only XTLS geodata is bundled. Regional data used by tests is not installer
payload. Fresh/clean installation downloads any selected regional sources from
their latest upstream release; upgrades preserve existing resource files.

You can also build remotely in your fork: enable Actions, open **Actions → Windows
installer → Run workflow**, and select your branch. It executes this same build
script on a fresh Windows runner.
The installer and logs are retained as workflow artifacts, without creating a
GitHub release. No repository secrets or maintainer test infrastructure are used.

## Core integration without rebuilding the desktop

```powershell
pwsh -NoProfile -File tools/Build-Networking-Service.ps1
npm run test:core
```

The service-package build prepares the pinned executable and source; it does not
install the service. The test command creates its own synthetic configurations
and resource directory, then asks Xray to validate them. It also exercises the
service's loopback, logging and missing-resource transformations against that
executable. Missing or mismatched inputs are errors, not skipped tests.

## Generated files and integrity

`.tools/` is disposable build output/cache. It is never a required checked-in
toolchain. The optional portable MSVC cache is supported for local development;
standard Visual Studio installations are the public build path. No .NET SDK is
needed. Python is needed only when regenerating source/default catalogues, not
for normal checks or installer builds.

Core and capture builds regenerate worker-integrity manifests in
`service/daemon/src/`. Review these changes when altering those components; never
disable hash checks to make an unrelated executable pass. Pinned build inputs
are distinct from the latest geodata downloaded by installed apps. If a pinned
asset disappears upstream, report the unavailable input rather than changing its
hash to accept different content.

See [testing](testing.md), [core integration](xray-integration.md) and
[catalogue regeneration](core-defaults.md) for the corresponding contracts.
