# Windows capture

Start with one mechanism. Duplicate capture or the wrong VPN uplink can loop.
Checks/service guards reject unsupported paths.

## Proxy

Choose SOCKS, HTTP or Mixed; set listen address, port and authentication. Public
listeners/low ports are supported. Secure their firewall/access policy.
Localhost is the default. Not all apps obey Windows proxy settings.

## Host TUN

Add TUN from Local capture; connect Data/DNS. Wayrill-TUN is the default name.
Choose automatic/explicit uplink, routes, families and adapter DNS. Only proven
Wayrill adapters are managed, not other VPN interfaces.

Global adapter management chooses retained/disposable operation. Retained
adapters are disabled/reused and removable from app management even after node
deletion. Rename should preserve identity. Inspect errors before deleting them.
Automatic uplink reconciles network changes; explicit selection stays deliberate.
For VPN-in-TUN ensure the outer connection cannot re-enter itself. ICMP echo
uses Direct upstream, not selected-proxy latency.

## WinDivert

Connect Data/DNS and choose monitored adapters in System traffic capture.
Wayrill TUN/ICS adapters cannot be monitored. Conflicting use is detected;
installation should not unload another app's driver. Driver maintenance is
explicit. Inspect security-product events if it is blocked.

## System traffic capture

| Panel | Scope/effect |
| --- | --- |
| Windows proxy | WinINet/default LAN proxy, PAC/discovery; per-user/machine-wide scope. |
| Environment | Selected user/machine proxy variables; restart programs to inherit changes. |
| WinHTTP | Legacy machine default and separate advanced user/machine channels where supported. |
| WinDivert | Applied state and monitored-adapter draft settings. |
| Loopback | Persistent AppContainer permissions, not temporary graph routes. |

Set/Clear act on the selected scope immediately. Restore previous uses owned
snapshots and preserves external edits. Opening the panel changes nothing.
Proxy assignments and graph activation are distinct. Per-app/browser/VPN
settings can still control individual programs.
Loopback remains local through capture/DNS/chains/tests; explicit Block survives.

## App protection

Choose exact executable paths/AppContainer packages for restart/update
protection. Selected non-loopback access is blocked during deliberate retirement
until successful recovery. Include networking helpers separately. This is not
permanent containment and cannot retroactively cover an unobserved failure.
Interrupted setup may leave apps blocked: finish setup or start the service and
explicitly Stop; inspect logs before changing unrelated firewall rules.
