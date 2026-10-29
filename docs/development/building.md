# Building on Windows

## Prerequisites

- Windows x64 and PowerShell 7.
- Node.js 24/npm; dependencies are locked by package-lock.json.
- Rust MSVC toolchain (tested with 1.99), Visual Studio 2022 C++ Build Tools and
  a Windows SDK. Use x64 Developer PowerShell with cl/link/rc available.
- Git and curl-mingw with OpenSSL or LibreSSL. Set WAYRILL_CURL when it
  is not detected. The scripts deliberately avoid Windows' bundled curl.
- Python 3 only for regenerating audited protocol/default catalogues, not normal
  frontend, native or installer builds.

The Windows native CI jobs pin Rust 1.99.0 and use the same locked Cargo
workspaces. They run independently of installer packaging; see [tests](testing.md)
for their fixtures and desktop configuration.

No .NET runtime/SDK is required. Go is downloaded from its pinned vendor archive
for core builds; build inputs are recorded in service/dependencies.json.

## Frontend

```powershell
npm ci
npm run check
npm test
npm run build
npm run dev
```

The browser preview is an editor, not a Windows networking runtime. It does not
install/start the service. Generated `dist/` is ignored.

## Complete installer

From the repository root, in Developer PowerShell:

```powershell
npm ci
$env:WAYRILL_CURL = 'C:\path\to\curl-mingw\curl.exe'
& .\tools\Build-Windows.ps1
```

The script uses standard installed tools, or an optional existing project-local
toolchain under `.tools/`. It changes only this shell's environment. It runs
frontend/native/core checks, builds the separate capture/attribution binaries,
rebuilds pinned custom Xray cores, stages the service, verifies resource mappings
and builds the Tauri/NSIS installer. `-SkipTests` skips tests, not integrity/lint.

Only the two XTLS DATs are bundled. Missing build inputs are downloaded from
immutable manifest URLs and checked against size/SHA-256; mismatched files fail
rather than being replaced silently. Normal service tests also download the
regional datasets as fixtures; `-SkipTests` needs only XTLS. These fixture pins
do not govern installation or app updates. When selected during fresh/clean
installation, regional files come from the provider's latest release, resolved
at setup time. Setup checks the matching upstream SHA-256 files and bounds the
download size before the existing app or service is stopped. Upgrades preserve
installed resource files and skip
resource selection/downloads. Resource versions are independent from the core.
If an upstream removes an old asset, use a hash-matching copy from the matching
release materials; do not change the pin merely to accept a different dataset.

Generated locations:

| Path                                                           | Contents                                        |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `.tools/target/`                                               | Cargo/Tauri output                              |
| `.tools/target/x86_64-pc-windows-msvc/release/bundle/nsis/`    | Installer                                       |
| `.tools/installer-service/`                                    | Matching staged service payload                 |
| `.tools/downloads/`, `service-deps/`, `go-sdk/`, `tun-source/` | Verified/generated build caches under `.tools/` |
| `.tools/logs/`                                                 | Build logs                                      |

Do not upload caches or installer binaries as repository source. Release assets
are published separately after review. A reproducibility claim requires comparing
actual results; matching source pins alone is not proof of an identical binary.

## Focused native work

```powershell
. .\tools\Enter-BuildEnvironment.ps1
cargo test --manifest-path service/Cargo.toml --workspace --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path service/capture/Cargo.toml --locked
cargo test --manifest-path service/capture/Cargo.toml --locked --no-default-features
```

See [tests](testing.md), [core integration](xray-integration.md) and
[default/schema regeneration](core-defaults.md). Never disable hash checks to
accept an unreviewed core or use private-TUN source as the main-core audit input.
