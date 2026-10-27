# Internet sharing

ICS TUN independently routes Windows sharing. Windows retains IPv4 DHCP,
gateway DNS, NAT and firewall. One ICS TUN per graph supplies Data to filters,
groups/chains or Direct.

## Setup

1. Verify native ICS once: public/private pair, private host 192.168.137.1/24,
   no custom private DNS or enabled custom port mappings.
2. Add ICS TUN and confirm identities. Existing nodes, including disabled ones,
   are reused.
3. Keep Direct — ICS upstream, or filter selected destinations to other exits.
4. Check, Validate, Start/Apply. The remembered pair can be reused while native
   sharing is off.

Wayrill-ICS is the default name. Internal 10.91.0.1/32 is separate from clients'
DHCP subnet and default FakeDNS pools.

Match destinations/ports, inspected domains, TCP/UDP and detected protocols.
Host process/children/services/packages do not identify clients. IPv4 NAT hides
their identities here; per-client IP/MAC selection is unavailable.

ICS TUN has Data only. Gateway DNS follows the Windows resolver path, not
automatically the connected host handler. External DNS can match destination
rules. Clients receiving FakeDNS addresses use the common mapping table.

## IPv6

Share IPv6 with clients needs working dual-stack host TUN. The app can stage one.
Private link needs link-local IPv6, MTU ≥1280 and no foreign non-link-local IPv6
network. Owned ULA /64, forwarding and router advertisements support SLAAC; DNS
remains available via IPv4 DHCP. No DHCPv6, RDNSS, delegated prefix or NAT66.
IPv6-only clients requiring these are outside this mode. Direct needs IPv6
upstream; suitable proxies may reach IPv6 over an IPv4 carrier.

## Intent

| Action | Result |
| --- | --- |
| Enable ICS TUN and Apply | Wayrill sharing; remember native handback |
| Compatible Apply/Restart | Retain sharing, avoiding brief native toggles |
| Disable/remove ICS TUN and Apply | Sharing off; retain remembered pair |
| Explicit Stop while sharing enabled | Restore owned native IPv4 pair |
| Stop with ICS TUN disabled | Sharing stays off |

Protected journals support failure/boot recovery. External edits are reconciled,
not blindly overwritten. Native handback does not continue IPv6 advertisements.
