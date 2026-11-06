# Wayrill Aquifer 0.2.3

Aquifer manages Linux Xray servers over SSH using Wayrill graphs. It is part of the Wayrill source/bundle and can also be built and run separately as `wayrill-aquifer.exe`. It uses WebView2 and an installed WinSCP, without installing a local routing service, driver or VPN adapter. Install WinSCP separately, or extract its portable package with both `WinSCP.exe` and `WinSCP.com` in the same folder. Aquifer does not bundle or download WinSCP.

## Use

1. Choose a saved WinSCP session. Settings → WinSCP setup selects a portable/custom executable or INI; credentials and host-key trust stay in WinSCP.
2. Read server, or use File → New configuration. Discovery prefers xray.service and the standard config paths; other configurations remain selectable. File → Open supports local JSON/JSONC.
3. The left node library adds nodes by click or drag. Simple outbounds/DNS servers edit in Properties; complex nodes use structured editors. Core settings controls native server options and the API. User sets connect to compatible inbound Users inputs.
4. Stash contains outbounds, policy groups and proxy chains. Add to graph places hidden definitions; Locate on graph focuses existing cards.
5. Check and server-side validation precede explicit Apply confirmation. Deployment backs up configuration and its companion and automatically restores them on failure. See [deployment](docs/CONFIG-DEPLOYMENT.md).

Aquifer saves `config.wayrill.json` beside `config.json`, with names adjusted for other configs. It restores layouts only after verifying that their executable graph compiles to the downloaded Xray config. Dedicated API plumbing remains in Core settings. The runtime graph/compiler remains the export source of truth.

The Routing filter editor uses the same ordering controls as Wayrill. Drag a rule by its grip, or use Alt+Up/Down to reorder it; the first matching rule wins. Expand the domain or IP field for longer lists. The Outputs tab names and orders graph connections and selects their outbound or policy group. Changing a destination updates the rules using that output; deleting a used output asks before removing its rules. Display names and output order are saved in the companion file, keeping native Xray JSON free of editor metadata. Unmatched traffic continues to use Xray's first outbound.

Server status provides Xray/service versions, reboot status, APT updates and confirmed maintenance actions. An existing root login is used directly; otherwise fixed administrative jobs use noninteractive sudo. Closing Aquifer does not cancel a submitted package/deployment job.

## Build from the Wayrill checkout

```powershell
npm ci
npm run aquifer:check
npm run aquifer:test
npm run aquifer:build
pwsh -NoProfile -File tools/Build-Aquifer.ps1
```

The Windows build uses the parent repository's pinned Rust/MSVC setup. The result is `.tools/installer-aquifer/`, usable as a standalone package. `tools/Build-Windows.ps1` builds and includes it under `Aquifer/` in the main installer, with a Start-menu shortcut and File → Wayrill Aquifer launcher. Running Aquifer must be closed before its installed binary is replaced; setup never kills it or unrelated portable copies.

Python worker contracts: `python -m unittest discover -s aquifer/tests -v`. Executable acceptance: `pwsh -NoProfile -File tools/Check-AquiferCore.ps1`, after preparing the parent's pinned core. This suite generates synthetic TLS fixtures and runs Xray `-test`; missing prerequisites fail with instructions. Ordinary frontend checks need no core, private profile, installed app or server.

Run browser development with `npm run aquifer:dev`; it has its own local port. The shared packages and root npm lock are required source dependencies. Independent app versions/builds do not require separate copies of shared code. See [shared packages](../packages/README.md).

## Storage and boundaries

Aquifer writes user preferences and DPAPI-protected User sets under `%LOCALAPPDATA%\app.wayrill.aquifer`. Until a new file is saved, it can read the corresponding legacy `app.wayrill.remote.poc` file. It does not overwrite the old store or copy plaintext credentials. WinSCP retains all SSH secrets. Temporary uploads use the new identity.

The `wayrill.remote` graph-document marker and `/var/lib/wayrill-remote` fixed job protocol remain stable so existing companion layouts and recovery records remain readable. They are protocol identifiers, not application branding. Graph format compatibility is otherwise not a public guarantee at this development stage.

Deployment currently requires an active supported systemd service and one explicit config file. Xray installation, interactive SSH/password prompts, merged configurations and container discovery are not implemented. Imported native values and unknown fields are preserved where supported; remote installed-core version reporting is independent of the editor's pinned schema/default catalog.

## License and provenance

See [third-party notices](THIRD_PARTY_NOTICES.md) and [MIT license](LICENSE). The package contains corresponding libavoid source archives and licenses. `vendor-source.json` records the original graph baseline; current shared modules live in the parent packages directory. Private server snapshots, test profiles and historical machine-specific QA reports are excluded from published source.
