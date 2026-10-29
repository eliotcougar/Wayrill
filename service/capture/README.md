# Contained Windows capture worker

This GPL-3.0-only Rust component ports Wayrill's adapted v2rayN capture worker. It is a separate SYSTEM process, never linked into the coordinator. The coordinator verifies its exact packaged files and starts it in a one-process, 512-MiB, kill-on-close job. Only inherited UTF-8 JSON pipes carry its fixed commands; no public listener, generic execution, arbitrary native filter or caller-selected privileged path is exposed. The authenticated loopback TUN attribution bridge is private runtime infrastructure.

The worker owns its WinDivert handles, installation-scoped ETW observation and signed scoped TCP reflection rule. It does not unload the shared driver. Windows setting ownership and recovery journals remain in the coordinator. Native ICS changes require the current role/private-state checkpoint and preserve external edits. The complete pair transition follows the coordinator's ordering.

## Rebuild the source archive

Use the Rust/Cargo version pinned in `rust-toolchain.toml`, an x64 MSVC compiler and Windows SDK. From the extracted archive root in PowerShell:

```powershell
$env:RUSTFLAGS='-C target-feature=+crt-static'
cargo fmt --check
cargo clippy --offline --locked --all-targets -- -D warnings
cargo test --offline --locked
cargo build --offline --locked --release --target x86_64-pc-windows-msvc --bin wayrill-capture
cargo clippy --offline --locked --all-targets --no-default-features -- -D warnings
cargo test --offline --locked --no-default-features
cargo build --offline --locked --release --target x86_64-pc-windows-msvc --no-default-features --bin wayrill-attribution
```

The archive includes its lockfile and vendored dependency sources/configuration. The standard Rust/MSVC/Windows toolchain is not included. The leaf workspace preserves optimization level 3 independently from the coordinator's size profile. Runtime WinDivert 2.2.2-A files belong in the sibling `windivert/` directory and remain subject to the coordinator's pinned dependency checks. The separate `wayrill-attribution` build excludes the WinDivert feature and accepts only application/NAT attribution, catalogue, loopback-permission and sharing operations. Install it in `attribution/` with its independent manifest; it requires no WinDivert DLL, driver or capture executable. Keep both binaries in their independent coordinator-owned jobs. Default Cargo tests do not open capture handles or mutate adapters. WinDivert-only tests/probes declare their required feature; attribution-only tests still include every compatible integration test. Live NAT-witness and mutating VM scenarios remain explicitly ignored and must be selected only in the authorized fixture. The `examples/` programs are explicitly invoked QA tools and are not shipped as executables.

Maintained tests use independent checksums and self-contained packet, process, policy and lifecycle cases. Run native traffic and mutation scenarios only in a disposable Windows VM; never change a workstation's active routing for routine QA.

Original adaptation/license provenance is in `provenance.json`. Dependency licenses and original notices remain in `vendor/` in the source archive; the package lists resolved dependencies in `THIRD-PARTY-NOTICES.md`.
