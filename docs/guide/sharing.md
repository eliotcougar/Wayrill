# Route a shared Internet connection

**ICS TUN** gives Windows Internet Connection Sharing its own path through the
graph. You can send streaming destinations through one proxy and leave other
shared traffic Direct, independently of the host's rules.

Windows continues to provide IPv4 DHCP, NAT, gateway DNS and its sharing firewall.
Wayrill manages the sharing transition through its service. This beta supports
one ICS TUN node per graph.

## Prepare native Windows sharing once

Begin with a working native ICS pair: an Internet-facing public adapter and a
private adapter connected to your TV, router or other clients. Verify that a
client receives an address and reaches the Internet before adding Wayrill.

The supported private IPv4 setup uses `192.168.137.1/24` on the Windows host.
Custom private DNS settings and enabled custom ICS service/port mappings are
outside the supported handoff. Disabled default entries in Windows' Sharing
Settings list are not active mappings.

Once Wayrill has accepted the pair, it remembers its identities. It can start
ICS TUN later without requiring native sharing to be active first.

## Add ICS TUN to the graph

1. Start from a working host graph or a [starter](examples.md).
2. Add **ICS TUN** from Local capture. If Wayrill offers to configure detected
   sharing, follow that setup and review the public/private adapter pair. Reuse
   an existing ICS TUN node, including a disabled one, instead of adding another.
3. Keep the provided **Direct — ICS upstream** path for an initial test. The
   default adapter name is **Wayrill-ICS**. Its internal `10.91.0.1/32` address is
   separate from the clients' DHCP subnet and the default FakeDNS pools.
4. Run **Check → Validate**, then Start/Apply. Allow the native sharing operation
   to complete; the progress window shows the current stage.
5. Check a new connection from a shared client. Then insert a Traffic filter on
   the ICS TUN Data path to split destinations between Direct and other outbounds.

Use a separate filter when host and shared traffic need different fallback routes.
For example, give the sharing filter a streaming-domain rule to a proxy group
and set its Unmatched traffic to Direct — ICS upstream. This routes those
destinations for all shared clients.

## Which rules work for shared traffic?

Use destination IPs, ports, TCP/UDP, detected protocols and domains available from
name inspection. Process names, child processes, Windows services and packages
identify applications on the host, not applications on the TV or router.

IPv4 reaches this capture after ICS NAT. The original client IP/MAC is not
available for per-client routing. A domain rule applies to eligible traffic from
every shared client. Connecting a router can also hide several clients behind
that router's own NAT.

ICS TUN has a **Data** output. Windows gateway DNS does not automatically enter
the host DNS handler. Traffic to external DNS servers can be classified by
destination rules, but connecting a host DNS graph does not by itself replace
the ICS gateway's resolver. FakeDNS mappings are shared between Wayrill's cores
when clients do receive synthetic addresses.

## Stop, disable and restart mean different things

| Action | Sharing result |
| --- | --- |
| Enable ICS TUN and Apply | Start Wayrill-managed sharing using the remembered pair. |
| Apply a compatible change or Restart | Keep compatible sharing/adapters rather than briefly returning to native ICS. |
| Disable/remove ICS TUN and Apply | Turn sharing off and remember the pair for later. |
| Press Stop while ICS TUN is enabled | Restore the owned native IPv4 sharing pair. |
| Press Stop with ICS TUN disabled | Leave sharing off. |

Disabling the owned sharing adapter in Windows also signals an intention to turn
sharing off. Network disappearance during boot or an uplink outage is a different
condition and can be retried. Enabling ICS TUN again re-enables Wayrill sharing
and restores the ability to hand back to native ICS on a later explicit Stop.

If you change the native pair, addresses or mappings outside Wayrill, review any
conflict before continuing. The service preserves external changes instead of
blindly applying its older snapshot. A remembered pair is useful recovery state,
not a reason to ignore the current Windows configuration.

## Share IPv6

Shared IPv6 additionally needs a working dual-stack **host TUN**. The setup can
stage one when required. The private adapter must have link-local IPv6, an MTU
of at least 1280, and no conflicting non-link-local IPv6 network.

Wayrill supplies an owned ULA `/64`, forwarding and router advertisements for
SLAAC. DNS remains available through IPv4 DHCP. This mode does not supply DHCPv6,
RDNSS, a delegated public prefix or NAT66. Clients must work with these
constraints. Direct IPv6 needs a usable IPv6 upstream; a compatible proxy may
carry IPv6 destinations through an IPv4 connection.

Returning to native ICS restores the IPv4 pair; Wayrill's IPv6 advertisements do
not continue after handback.

## If sharing fails

Read the current stage in Run graph, then inspect Application logs with all
sources and levels selected. Record which public/private adapters were intended
and whether the failure followed Apply, Stop, a reboot or an external Windows
change. Native ICS can take time; continuing progress is not proof of failure.

Do not repeatedly toggle Sharing or delete adapters while an operation is still
in progress. Use the reported recovery state and
[troubleshooting steps](troubleshooting.md) to collect evidence first.
