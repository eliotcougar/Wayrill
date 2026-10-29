# Embedded core defaults

Empty controls show the value that will be used. Node fields inherit an explicitly configured workspace value first, then the embedded Xray default. Empty global fields show the Xray default. The hint is pale and italic; a source label and hover provenance identify where it comes from. Zero and false remain explicit values, including Xray zero sentinels whose effective behavior is explained in the hint.

The workspace's factory presets are app choices, not Xray defaults. New workspaces retain the existing presets. **Use Xray default** removes a workspace setting; **Use all Xray defaults** removes all 80. Factory restores the app preset. **Use default** on a node removes its override and follows the current workspace/core hierarchy. Clearing an inheritable numeric node field has the same effect. Editing, resetting and Undo retain these distinctions.

Imported configs preserve both explicit values and omitted fields. A preserved native omission follows Xray even when this workspace has an app preset; choosing Use default deliberately adopts the workspace hierarchy. The compiler keeps inherited core fields omitted, so it does not accidentally turn a context-sensitive default into a constant. Advanced JSON still supplies explicit native options when the overlapping named global is unset. Required credentials show **Required — no default**.

## Store and source review

`src/graph/xrayCoreDefaults.json` contains 536 field entries, 80 shared-setting bindings, the core version, source commit, Windows/amd64 target, binary SHA-256, audit/schema digests and provenance. `src/graph/coreDefaults.ts` resolves hints and context; `src/graph/defaults.ts` resolves workspace/node inheritance. The derived node `coreDefaults` list is never serialized; saved graphs retain absent global keys and explicit node override arrays.

The embedded core is **Xray 26.10.21**, built with **Go 1.27.3** for the upstream certificate-security update, source commit **1b1647cd9ddf0abc34b981d4611fc03bcac1ca74**, with the app-owned UDP listener initializer, shared FakeDNS bridge; the SOCKS lifecycle and UDP destination repairs are included upstream. Binary SHA-256: **32D071B52DA365542C9E0750779760835670E7C88995F43E677842CEB4AFDBFC**. The listener initializer applies graph-configured Windows UDP buffer values through Xray’s public hook, leaving Windows defaults unchanged when unset/zero; outbound options and ordinary listener overrides remain authoritative. SOCKS UDP uses the shared default because the upstream hook has no inbound identity; see [UDP loss](xray-customizations.md). Its pin is in `service/dependencies.json`.

`.tools/core-defaults-audit.json` records 213 reviewed source-file hashes and explicit exceptions to Go zero values. `tools/Generate-CoreDefaults.py` combines the audit with the source-defined field catalogue. Optional settings may be disabled, empty, automatic, conditional or required; they do not all have a fixed scalar default. The generator intentionally does not infer runtime defaults by matching arbitrary Go expressions.

Examples of source-sensitive behavior: outbound TCP keepalive uses 45 seconds, listeners use system timing; native policy uses a 60-second handshake; mKCP's sending window is 2 MiB; DNS server fields inherit handler values; TLS ALPN depends on the transport; the generated Chrome User-Agent varies with date/CPU. Windows socket options that are not applied on Windows say so. Policy buffer size may be changed by Xray's environment.

QUIC values also depend on the locked [apernet/quic-go configuration](https://github.com/apernet/quic-go/blob/184d081eef3e/config.go), [Chrome emulation](https://github.com/apernet/quic-go/blob/184d081eef3e/chrome_parrot.go) and [protocol constants](https://github.com/apernet/quic-go/blob/184d081eef3e/internal/protocol/params.go). The audit records those immutable source URLs and hashes, alongside Xray's Go dependency locks. Context entries distinguish Hysteria, MASQUE, HTTP/3, listener/client direction and Chrome emulation. Inspect the dependency when its lock changes.

## Updating the embedded core

1. Read [core integration](xray-integration.md). Obtain the official release and its exact source commit; update the version, official archive/executable hashes and sourceCommit together. Audit every shared patch and app-owned initializer, removing a backport only when the new base contains its repair. Keep official and source-built binary/source pins distinct. Prepare the reviewed **main-core** source, including shared patches and initializers, before the audit/generation steps below. Do not use the private TUN tree after its additional hooks have been applied.
2. Review the source-commit guards in the generators/build scripts as part of the upgrade; update them only after the new base and hook anchors have been audited. Regenerate/review the protocol field catalogue according to [PROTOCOL-NODES.md](../reference/protocols.md). Review changed config builders, runtime defaults, platform behavior and locked dependencies against the existing audit. Re-audit Basic/Advanced layout metadata and its exhaustive coverage tests in [SETTINGS-LAYOUT.md](../guide/graphs.md). Update audited hashes, exceptions, contextual hints, required fields and shared-setting encodings. Hash changes alone are not a semantic review.
3. Regenerate the store from that exact reviewed main-core checkout, using the configured Python interpreter:

   ```powershell
   $XraySource = 'C:\path\to\audited-main-Xray-source'
   python tools/Generate-CoreDefaults.py --source $XraySource
   python tools/Generate-CoreDefaults.py --source $XraySource --check
   ```

4. Build the public core/service package, then run `npm run check`, `npm test`, `npm run test:core`, `npm run build` and affected editor/runtime checks. The core test runner verifies the executable pin and prepares its source/resource inputs; there is no private fixture to configure. Upstream-release comparisons are separate controls, not substitutes for testing the shipped build. Add meaningful regression cases for changed defaults.

`npm` pretest/prebuild and the service packaging script run `tools/Check-CoreDefaults.mjs`. It rejects mismatched binary/version/commit pins, audit/catalogue changes, edited generated fields or bindings, and changed audited source files when the source path is supplied. Routine builds do not need a source checkout. An upgrade is deliberately blocked until its defaults audit and generated store agree; this is a review gate, not an automated claim to understand upstream semantic changes.

Factory presets can remain stable across core upgrades. Unset settings follow the updated embedded core; explicit app values and node overrides retain their saved values. Saving a workspace does not change an already-running configuration. Check the graph, validate it in the Check results, then use Start or Apply to activate it.
