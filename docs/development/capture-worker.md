# Rust capture and attribution workers

`service/capture` is a separate GPL-3.0-only Rust leaf workspace. It builds
`wayrill-capture.exe` with the WinDivert feature and `wayrill-attribution.exe`
without it. Neither is linked into the MIT coordinator. Each is verified against
its own packaged integrity manifest and launched in a one-process, 512-MiB,
kill-on-close job under the service.

## Build and corresponding source

Use the prepared Rust/MSVC/Windows SDK environment and `tools/Build-Capture.ps1`.
The leaf uses optimization level 3, LTO and static CRT independently of the
coordinator's size profile. The package build checks formatting and strict Clippy;
tests run unless explicitly skipped. Product builds and deployment require no
.NET runtime.

`capture-source.zip` contains the exact worker sources, lockfile, build script,
dependency licenses and vendored dependencies/configuration for an offline
rebuild. Rust/MSVC/Windows SDK remain external prerequisites. The source archive's
[README](../../service/capture/README.md) lists commands for both feature sets.
`provenance.json` retains the original adapted v2rayN attribution and source hashes.

The one-time C# port comparison is historical evidence, not a maintained shipping
implementation. Its two ignored oracle adapters were retired during cleanup;
they depended on private output from the removed C# harness. Self-contained Rust
tests retain independent checksum calculations, malformed packet/fragment bounds,
TCP resets, policy precedence, process generations, packages/services and native
ownership behavior. Do not regenerate historical expectations from Rust itself.

## Runtime boundaries

Fixed UTF-8 commands use inherited pipes; the worker exposes no arbitrary
privileged execution, caller-selected path or public command listener. Capture
owns its WinDivert handles, ETW observations and scoped TCP reflection rule. It
does not unload the shared driver. The driver-independent attribution build
excludes capture handles, driver operations, reflection firewall and UDP relay
code. It provides process/NAT attribution and fixed catalogue, loopback and
sharing operations. Its authenticated loopback TUN bridge is private runtime
infrastructure. See [Windows capture](windows-capture.md) and [TUN](../guide/capture.md).

Packet/byte/flow budgets and fail-closed identity checks remain mandatory. A
missing, ended or panicked observer invalidates the relevant cached authority.
Owner-table reads use bounded headroom and growth, validate the native returned
length and publish no partial snapshot on failure. PID reuse is distinguished
by process generation. Temporary composite policy targets do not accumulate in
the concrete target cache, and retired TCP mappings cannot forward late packets.

Native buffers use aligned initialized storage with checked views. OS randomness
uses the safe getrandom API. Native table decoding keeps generated Windows ABI
types and allocation/range checks. Cargo denies undocumented unsafe blocks and
unsafe operations hidden inside unsafe functions. Packet parsing and policy
selection use safe Rust. Historical unsafe-block counts describe their snapshots;
they are not current counts or a safety guarantee.

## Lifetime and failure handling

Create UDP completion guards before task spawn so aborting an unpolled future
still signals completion. Cancellation takes precedence over socket setup.
Health checks include the attribution accept, process/socket refresh and NAT
refresh tasks; a finished task cannot remain advertised as healthy.

Explicit retirement drains the companion through its fixed Stop command before
ending the job, and attempts independent adapter/sharing cleanup even on error.
Drop is a bounded best-effort fallback. A timed-out, malformed or disconnected
exchange permanently invalidates that transport; never pair a late response with
a later command or replay a sharing mutation on an uncertain stream.

Native ICS mutations run on an owned STA thread and stream request-correlated
phase observations. Valid observations renew inactivity waits; there is no fixed
total completion deadline. A slow Windows call does not authorize overlapping
rollback. Durable pending mutations must be reconciled with actual Windows state.
The coordinator owns settings journals, sharing intent and transition ordering;
see the authoritative [lifecycle contract](lifecycle.md).

Worker/service death may release packet handles; capture is not an atomic firewall
kill switch. Native traffic/mutation checks belong in the authorized Hyper-V VM,
without changing the host's running configuration.
