# Third-party components and licenses

Wayrill is a collection of separately licensed components, not a claim that all
included code/data is covered by the root MIT license.

| Component | License / corresponding source |
| --- | --- |
| Wayrill desktop/coordinator | [MIT](LICENSE); frontend and Rust application/service source in this repository |
| Contained capture/attribution worker | [GPL-3.0-only](service/capture/LICENSE); [source/provenance](service/capture/README.md) and `service/capture/provenance.json` |
| Modified Xray executables | MPL-2.0; [upstream](https://github.com/XTLS/Xray-core), `service/xray-patches`, `service/core-init`, `service/core-control`, `service/tun-core` and [inventory](docs/development/xray-customizations.md) |
| WinDivert | LGPL-3.0-or-later; unmodified vendor distribution, [source](https://github.com/basil00/WinDivert) |
| Wintun | License/notices supplied with the pinned Xray vendor archive |
| libavoid-js/libavoid | [LGPL-2.1-or-later](public/licenses/libavoid-LGPL-2.1.txt); [notice and source](public/licenses/libavoid-NOTICE.txt) |
| NSIS template from Tauri | [Original MIT notice](docs/licenses/tauri-installer.md); [template provenance](src-tauri/installer/README.md) |
| gRPC/protobuf dependencies | [Notices/full licenses](docs/licenses/grpc.md) and language lockfiles |
| GeoSite/GeoIP resources | Retained GPL notices in `service/routing-assets`; exact upstream releases, hashes and sources in `service/dependencies.json` |

React, React Flow, Tauri, Lucide and other dependencies retain their package
licenses. npm/Cargo/Go lockfiles identify resolved versions. The service's
[detailed notices](service/THIRD-PARTY-NOTICES.md) include embedded subscription
engine licenses; the capture source archive retains vendored notices.

Resource DATs, downloaded SDKs and built executables are not Git source files.
Release packaging must retain vendor licenses and complete corresponding
modified core/worker source archives. Do not substitute a source URL for an
archive that the release actually needs to include. Packaging checks verify
integrity; they do not constitute a third-party legal audit.

## Rebuilding or replacing the schematic router

`tools/Prepare-ThirdPartySources.ps1` prepares the locked npm package, wrapper
source at commit 28a6fe20c2f1f809afdbeca8d789e65357614c4f and adaptagrams v1.0.4
source as separate release assets with hashes. The package is also checked
against npm's locked SHA-512 integrity.

The wrapper documents `python3 tools/generate.py` and `npm run build` using
Python, Git and Docker/Emscripten. Its generator fetches an unpinned binding tool;
review/pin that input for a reproducible rebuild. No byte-for-byte WASM rebuild
claim is made. Retain the 0.4.5 binding interface, replace the compatible package
runtime/WASM, rebuild Wayrill and run geometry/browser regressions. Adapter code
is in src/graph/libavoid.ts and src/graph/edgePaths.ts. The sources are unmodified
vendor inputs; preserve original licenses and notices when redistributing them.
