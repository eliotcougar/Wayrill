# DNS and FakeDNS

`source DNS → handler → DNS routing filter → DNS server(s) → Query traffic → outbound`

The handler can connect directly to a server group. Data is separate. Groups
hold multiple servers; Query traffic selects their routed request path.
Explicitly local resolver transports bypass it.

The handler controls static/system hosts, address family, blocking and defaults.
Preferences select groups by domain and can validate returned IPs. DNS is not
first-match traffic routing: several preferred groups can be eligible; fallback
and stop-after-group matter. Keep real Fallback unless deliberately disabling it.

Resolver hostnames need bootstrap without re-entry: full:dns.google mapped to
IP literals is one example. DNSCrypt/other local resolvers have independent
upstream requirements. TUN adapter DNS must actually enter the handler; an
unrelated loopback resolver can bypass it. Check warns about that arrangement.
Proxy DNS alone does not capture Windows DNS.

## FakeDNS

FakeDNS returns synthetic addresses, not real destination IPs. Name recovery
restores the domain when captured traffic targets one. A remote proxy can
resolve it, or Direct can use real DNS when it needs an actual IP.

Connect FakeDNS to the DNS filter's dedicated port and retain real DNS on
Fallback. The workflow generates preferences/recovery. Capture must cover the
synthetic pools; adapter DNS must reach the handler; pool/adapter ranges must
not overlap. The card's mapping count confirms use.

Isolated cores share mappings through Wayrill's custom integration. This does
not automatically redirect [ICS gateway DNS](sharing.md) into the handler.
FakeDNS preserves domain identity across IP-based capture, not universal
independence from real DNS. Load FakeDNS with TUN or DNS routing to explore.
