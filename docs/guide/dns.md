# DNS and FakeDNS

DNS has two decisions of its own: **which resolver answers a name**, and **which
outbound carries the request to that resolver**. Keeping both paths visible makes
split DNS easier to understand and helps avoid a resolver depending on itself.

## Follow the connections

| Connection | Meaning |
| --- | --- |
| Source DNS → DNS handler | Send captured DNS requests to Wayrill's DNS handling. |
| Handler Resolver → DNS filter or DNS server(s) | Choose how names are resolved. |
| DNS filter output → DNS server(s) | Use a resolver group for the selected domains or fallback. |
| DNS server(s) Query traffic → outbound or traffic filter | Choose the network route to a nonlocal resolver. |
| Source Data → traffic filter/outbound | Route the application's connection separately. |

The DNS handler can connect directly to DNS server(s) when no split DNS is needed.
A server group may contain one or several resolvers. Explicitly local resolver
transports use their local path instead of the graph's Query traffic connection.

## Set up split DNS

Start from **File → Load Example → DNS routing** to inspect a complete small
example, or extend an existing graph:

1. Connect the source's DNS output to a **DNS handler**.
2. Connect the handler's Resolver output to a **DNS routing filter**.
3. Add two **DNS server(s)** nodes, for example a local resolver group and a
   remote DoH group. Enter their actual server addresses.
4. In the DNS filter, create a named output for the domains needing the local
   group. Add a preference with those domains and choose that output.
5. Connect the preference output to the local group and **Fallback** to the
   remote group.
6. Connect each group's **Query traffic** to the outbound that can reach it.
   Check/Validate and Apply the graph.

For example, a domain preference can select a local resolver for a regional set,
while Fallback uses a public DoH resolver. The local resolver's queries can go
Direct and the DoH queries through a proxy. Application data still follows the
Traffic filter.

The handler also controls static hosts, **Use system hosts file**, address-family
strategy and policies for DNS requests/record types. Handler policies use their
first enabled match. Resolver preferences follow Xray's DNS selection semantics:
several preferred servers can be eligible, and order alone is not an exclusive
traffic-routing rule. Use the preference's stop/final-query controls deliberately.
Expected/rejected answer-IP checks can reject an otherwise successful answer.

## Choose fallback behavior

The collapsible **Fallback** section is below the preference list. The fixed
Fallback output remains on the node; its policy controls when it is used.

| Policy | Result |
| --- | --- |
| **After matching preferences fail** | Use matching preferred resolvers first; if they do not produce an acceptable answer, allow fallback. Unmatched names can also use fallback. |
| **Only when no preference matches** | A matching preference excludes fallback, even if its resolvers fail. Unmatched names can use fallback. |
| **Disabled** | Do not use fallback resolvers. Names need a suitable preferred resolver. |

The second choice is useful when falling back would expose a private name to the
wrong resolver. It can also explain why a name fails even though the fallback
resolver works. Keep a connected real fallback for an ordinary general-purpose
setup. Managed FakeDNS requires it for real-IP lookups.

## Make sure DNS reaches the handler

Connecting a DNS node does not redirect every DNS request made by Windows.

- A Proxy inbound's DNS output handles DNS traffic that reaches that proxy.
  A browser using its own DoH, or resolving locally before connecting, may take
  another path.
- In TUN mode, the adapter DNS destination must lie within the captured route
  scope. The TUN starter supplies such a destination and a DNS path.
- A DNS service at `127.0.0.1`, such as DNSCrypt, is local. Loopback traffic stays
  local, so pointing the TUN adapter at it can bypass the connected handler.
  Use that intentionally when you want the separate resolver; use a captured
  DNS destination when you want Wayrill to answer.
- ICS gateway DNS does not automatically enter the host handler. See
  [Internet sharing](sharing.md).

Check warns when the TUN DNS setting bypasses its connected handler. If FakeDNS
never creates mappings, this is one of the first things to inspect.

## Avoid resolver loops

A resolver URL such as `https://dns.google/dns-query` needs an address for its
hostname before it can answer other names. In the DNS handler's **Static hosts /
bootstrap (JSON)**, a mapping such as this supplies that address without another
lookup:

```json
{
  "full:dns.google": ["8.8.8.8", "8.8.4.4"]
}
```

Use addresses appropriate to the actual resolver. Alternatively, choose a
supported IP-address endpoint or ensure a separate resolution path can bootstrap
the hostname. A Query traffic link controls transport routing; it does not by
itself solve hostname bootstrap. An external local resolver has its own upstream
configuration and reachability requirements.

## Use FakeDNS

FakeDNS answers a name with a synthetic IP and remembers the mapping. When an app
connects to that IP through capture, name recovery restores the original domain
for routing. The eventual proxy or Direct outbound obtains a real address when
it needs one. FakeDNS itself does not discover the destination's real IP.

The simplest starting point is **File → Load Example → FakeDNS with TUN**.
For an existing graph:

1. Route captured DNS through a handler and DNS filter as above.
2. Connect the DNS filter's dedicated **FakeDNS** output to a FakeDNS node.
3. Keep **Fallback** connected to real DNS server(s), with a working Query
   traffic path. The managed workflow sets the required fallback and name
   recovery configuration.
4. Make sure the TUN DNS destination is captured and the synthetic pools do not
   overlap adapter networks. The defaults separate host TUN, ICS TUN and FakeDNS.
5. Apply, then make a fresh DNS request through the captured path. Watch the
   mapping count on the FakeDNS card.

Existing DNS caches can delay new mappings. A name deliberately handled by a real
resolver need not allocate one. If mappings increase but connections fail, check
the data route and the real fallback path. Wayrill shares mappings between its
separate core processes so host and sharing paths can recover the same names.
