# Bundled examples

Open **File → Load Example** to load a starter or a focused demonstration. Each
example is small enough to trace from its source to its outbounds.

Loading an example replaces the current draft and supports Undo. It does not
start routing or change Windows settings. If the current graph matters, export
it or make a [backup](backups.md) before using examples as a new workspace.

## Start with an entry point

| Example | What it does | What to do next |
| --- | --- | --- |
| **Local proxy → Direct** | Opens a Mixed SOCKS/HTTP proxy at `127.0.0.1:10808`; Data and incoming DNS traffic go Direct. This is the new-workspace default. | Start it and point an app at the proxy. Replace Direct with your profile to try a remote exit. |
| **TUN → Direct** | Captures host IPv4 and IPv6 traffic. DNS reaches a handler and Cloudflare DoH, whose queries also go Direct. Uplink selection is Automatic. | Check the uplink, then Check → Validate → Start. It needs the installed Windows service. |
| **WinDivert → Direct** | Captures packets with a separate DNS path. | Review monitored adapters in System traffic capture, then start. Resolve any capture conflict first. |

These starters use your existing Internet connection. A successful Direct route
does not bypass restrictions imposed by that network. TUN is the practical next
step when apps ignore system proxy settings; see [Getting started](getting-started.md).

## Learn a feature

| Example | What to look for | Preparation |
| --- | --- | --- |
| **Traffic rules** | A domain Block rule, private-network Direct rule and Main proxy fallback. Read the filter from top to bottom and inspect its Traffic log. | Replace Main proxy with a working Stash entry. |
| **DNS routing** | `example.org` prefers Quad9; other requests use Cloudflare DoH. Each DNS server group has an explicit Query traffic path. | Send DNS through the Proxy input. This example does not redirect all Windows DNS. |
| **FakeDNS with TUN** | TUN DNS enters the handler; the DNS filter's dedicated FakeDNS connection supplies synthetic answers. A real resolver remains on Fallback. | Start it, make a fresh DNS request through the captured path and watch the FakeDNS mapping count. |
| **Policy group + Observatory** | Lowest latency selection over two manual candidates, with monitoring and Block fallback. | Replace Server A and Server B inside the group. |
| **Proxy chain** | The path is this PC → Server A → Server B → destination. | Replace both hops. Both must support the intended chain. |
| **Chained filters** | Web ports enter a second filter that blocks `example.com`; other destinations and traffic go Direct. The child filter completes its own path. | No remote proxy is required. |

The server examples use documentation addresses and fictional credentials. They
cannot connect until you replace those placeholders; Check/Start reports the
unfinished setup. For a group or chain, edit its members in its editor, not by
looking for separate server cards on the canvas.

## A useful way to explore

Load one example, follow its connections, and change one thing at a time. Run
Check/Validate before activation. Use [outbound tests](testing-statistics.md) to
check the exit and a traffic filter's log to check rule selection.

Keep a real DNS path while experimenting with FakeDNS. The
[DNS guide](dns.md) explains why synthetic answers and real resolution are both
needed. The [sharing guide](sharing.md) describes adding ICS TUN to an existing
Windows sharing setup; the examples do not create a native ICS pair for you.
