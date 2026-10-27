# First beta notes

The first public beta is 0.31.18. Download the complete Windows x64 installer
and checksums from [Releases](https://github.com/eliotcougar/Wayrill/releases).
Source and third-party source archives accompany the installer.

Supported scope: Windows 10/11 x64 desktop/service, proxy inputs, host TUN,
ICS TUN, optional WinDivert, graph rules, DNS/FakeDNS, reusable outbounds,
maintenance, diagnostics and backups.

Development testing includes Windows 10 Hyper-V. Windows 11 has real-user use
and issue reports, not exhaustive hardware/adapter/VPN certification. No
independent security audit is claimed.

The prepared installer is unsigned. Checksums verify file contents, not an
Authenticode publisher identity; Windows may display publisher/reputation warnings.

## Boundaries

- No remote server service is supplied.
- Sharing is ICS-based; configure the native pair first. Destination-based
  shared routing is supported; per-client selection is unavailable.
- Shared IPv6 needs host TUN and the [private-network prerequisites](guide/sharing.md).
- An explicitly selected uplink is not silently replaced with an unrelated
  interface. Verify coexistence with other VPNs before relying on it.
- Loopback stays local, subject to explicit Block rules. ICMP echo uses the TUN
  upstream; ping does not measure a selected proxy's latency.
- App protection is a transition barrier, not permanent containment.
- Import/export preserves supported behavior, not JSON formatting, canvas
  layout or an original chained-filter structure.
- Custom Xray builds are required; see the [inventory](development/xray-customizations.md).

Use the complete installer, keep backups and verify required routes before
unattended operation. Report [sanitized diagnostics](guide/troubleshooting.md).
