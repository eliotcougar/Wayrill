# Wayrill Aquifer third-party components

Wayrill Aquifer and the shared frontend packages are MIT licensed. Dependencies retain their own licenses.

- libavoid-js 0.4.5 and libavoid: LGPL-2.1-or-later. The package, matching wrapper source and adaptagrams source are bundled in `third-party/`, with hashes and licenses. The binding is unchanged. See the adjacent libavoid notice for rebuilding/replacing it, then rebuild with `tools/Build-Aquifer.ps1`.
- The unmodified WinSCP 6.5.7 console helper is GPLv3 by Martin Prikryl and contributors. Its complete corresponding source is `third-party/WinSCP-6.5.7-source.zip`; license and notice are under `licenses/`. It is extracted as a separate process. Users supply WinSCP.exe.
- React, React DOM and React Flow: MIT; Lucide: ISC. Tauri and Rust dependencies retain the licenses in their pinned npm/Cargo distributions. The root package-lock.json and aquifer/src-tauri/Cargo.lock identify their resolved versions.

Aquifer does not bundle Xray, WinDivert, the Windows networking service or a VPN adapter driver. The main Wayrill bundle documents those separate components in its root notices. Shared-source extraction does not change these boundaries.
