# First beta: scope and limitations

**Wayrill 0.31.22** is a public beta for Windows 10 and 11 on x64.
Download the [complete installer](https://github.com/eliotcougar/Wayrill/releases/tag/v0.31.22)
and follow [Getting started](guide/getting-started.md) for a first connection.
Servers and subscriptions must be supplied by you.

The installer includes the desktop, networking service, matching custom cores
and original XTLS resource files. Fresh and clean installations can download
additional regional resources; upgrades preserve installed files. It is unsigned;
Windows may show an unknown-publisher or reputation warning. Release checksums let you compare the
downloaded bytes, but do not provide an Authenticode publisher identity.

## What to expect

The beta includes graph-based traffic and DNS routing, host TUN, ICS sharing,
WinDivert, proxy listeners, reusable Stash outbounds/groups/chains, maintenance,
diagnostics and portable backups. Development validation includes Windows 10
Hyper-V scenarios and real Windows 11 use. Physical adapter, network and VPN
combinations need broader testing; there has been no independent security audit.

Keep a backup of a working setup before major changes. On a remotely managed PC,
keep an alternative access path when testing capture or sharing.

## Important boundaries

| Area | First-beta behavior |
| --- | --- |
| Platforms | Windows x64 desktop/service. Linux, macOS, ARM64 and mobile builds are not supplied. |
| Shared connection | Uses Windows ICS and an accepted native adapter pair. Destination-based routing is supported; per-client IP/MAC selection is unavailable. |
| Shared IPv6 | Requires host TUN and the documented private-link/client prerequisites. It is not general DHCPv6, delegated-prefix or NAT66 support. |
| Other VPNs and uplinks | Explicitly selected interfaces stay deliberate; they are not silently replaced by unrelated adapters. Validate coexistence on your own setup. |
| App protection | Blocks selected apps during routing transitions and updates, not as a permanent always-on kill switch. |
| Loopback and ICMP | Loopback remains local, subject to explicit Block rules. TUN ICMP echo uses the direct upstream, not the selected proxy. |
| Xray import/export | Preserves supported native values/behavior; original comments, formatting and graph topology are not reconstructed. |

Use [Windows capture](guide/capture.md) and [Internet sharing](guide/sharing.md)
for the required setup and restoration behavior. Test a route with a new
connection; existing sessions and Windows Internet indicators can be misleading.

Wayrill uses custom Xray executables for Windows integration and shared FakeDNS.
The [customization inventory](development/xray-customizations.md), pinned build
inputs and corresponding source describe those changes. Component licensing is
listed in [third-party notices](../THIRD_PARTY_NOTICES.md).

## Useful beta feedback

Reports are especially helpful for sleep/reboot/uplink recovery, other VPNs,
sharing transitions, large subscriptions and confusing configuration steps.
Describe the intended route, the actual behavior and whether it is visible in
the filter's Traffic log. Include versions, failure time and sanitized logs;
see [Troubleshooting](guide/troubleshooting.md).

Routing continues with the editor closed. To deliberately end a run, use Stop.
If Start at boot before sign-in is enabled, the next Windows boot starts a new
run from the applied configuration. See [Getting started](guide/getting-started.md)
for the distinction between editing, applying, stopping and closing.
