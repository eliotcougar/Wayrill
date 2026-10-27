# Bundled examples

File → Load Example contains three starters followed by focused feature demos.
The initial workspace for a new installation uses the Local proxy starter.
Loading an example changes only the draft, supports Undo and does not start
routing or change Windows settings. Saved workspaces are unaffected.

| Example | Purpose / preparation |
| --- | --- |
| Local proxy → Direct | Mixed SOCKS/HTTP on `127.0.0.1:10808`, with both Data and DNS going Direct. Point an app at it or select the input in System traffic capture. |
| TUN → Direct | One host TUN, automatic uplink, dual-stack capture and an explicit DNS handler/Cloudflare DoH path. Requires the Windows service. |
| WinDivert → Direct | One WinDivert source with an explicit DNS path. Adapter monitoring is controlled in System traffic capture; normal capture ownership checks apply. |
| Traffic rules | Ordered domain Block, private-network Direct and a Main proxy fallback. Replace the sample proxy from Stash before starting. |
| DNS routing | `example.org` uses Quad9; other names use Cloudflare DoH. Both resolver groups have explicit query-traffic paths. This handles DNS submitted to the Proxy input; it does not capture Windows DNS automatically. |
| FakeDNS with TUN | TUN DNS enters the handler and dedicated FakeDNS connection; Fallback retains a real resolver. Name recovery is generated automatically, and the adapter DNS destination is inside the capture routes. |
| Policy group + Observatory | Two manual candidates, Lowest latency selection, a real probe URL and Block fallback. Replace both sample servers. |
| Proxy chain | Two prepared hops, in order from this PC through A and B to the destination. Replace both sample servers. |
| Chained filters | Web ports enter a child domain filter; its fallback and other traffic go Direct. Demonstrates flattened precedence without requiring a remote server. |

Remote-server examples use clearly labelled documentation addresses and fictional
credentials. The existing setup workflow prevents activation until those nodes
are configured/replaced. The starters, DNS and chained-filter demos require no
remote proxy subscription or private credentials. Their Internet reachability
still depends on the user's network.
