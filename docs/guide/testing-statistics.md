# Test routes and inspect traffic

Use outbound tests to check a server or assembled route. Use Traffic statistics
to measure traffic passing through Wayrill, and a filter's Traffic log to explain
why a connection took its route. Each answers a different question.

## Run an outbound test

Delay tests and speed tests have distinct icons. They are available on the main
toolbar, in Stash, and in an outbound node's right-click menu. Block is excluded.
The result window also has per-row buttons to repeat either test without closing
it. Testing a subset retains other entries' earlier results.

| Test | What the result tells you |
| --- | --- |
| Delay | Time for the configured HTTP test request through that route. |
| Country / exit IP | The address and country reported by the selected lookup service. |
| Optional UDP | Whether the chosen UDP probe received an acceptable response. |
| Speed | Download throughput from the configured file URL during the bounded test. |

The main-screen test expands the graph's policy candidates, deduplicates
outbounds and tests chains as assembled routes. Stash actions let you test
individual entries or the current tab's set. A speed test of a policy group uses
its current winner. A chain test traverses its configured sequence of hops.

Testing Direct uses its resolved upstream; inspect the interface on its card or
choose it explicitly if another VPN changes the result. A successful HTTP test
does not prove that UDP or every destination will work. A test failure can also
come from the chosen endpoint being blocked or unavailable.

## Choose test destinations

Open **Settings → Outbound tests…**:

- **Latency test URL** should return a successful response without a redirect.
- **Test UDP with delay tests** adds the UDP probe. Choose a **UDP test
  destination**: STUN checks UDP connectivity, while DNS tests UDP to that
  resolver only.
- **Country / exit IP URL** expects a supported JSON response. Leave it blank
  to disable that lookup.
- **Speed test URL** should point to a download file.

Each field has an editable dropdown with suggested destinations. Opening its
menu shows the full list; you may type a different value. The latency suggestions
are also available for Observatory probe URLs.

Speed tests download for up to five seconds or 256 MiB per route and consume
real bandwidth. Test a small selection first on a metered connection. Endpoint
location, remote load and your local link can all limit the result.

## Explain a route or test DNS

Open **Service → Routing playground…**, or right-click a node and choose
**Evaluate route…**. Select the edited graph or the applied revision, choose a
traffic source, and enter a destination, port and network. The result identifies
the first matching Xray rule and outbound or policy group. A linked filter rule
opens its editor. This evaluates routing; it does not send an application
connection or prove that its destination is reachable.

Expand **Application and connection details** to supply an executable, its
parent chain, a Windows app/service identity, source address or resolved
destination IPs. These values describe the flow you want to simulate. If Xray
needs IPs and none were supplied, or application identity is missing, the result
is marked provisional. Policy-group selection is reported without rotating the
running group's winner. Native Lua routing scripts and native `self/`/`xray/`
process identities cannot be simulated by this tool.

For DNS, choose **Service → Test this domain…**, use a DNS node's right-click
menu, or click **Test this domain…** in a DNS editor. Choose the handler, domain
and record type. Unsaved DNS editor settings can be tested without applying them.
The original DNS destination matters for policies that forward the original
query; normal A/AAAA resolution uses the handler's configured resolvers.

The test uses Xray's DNS outbound and resolver logic, including request policies,
static hosts, expected-IP checks and fallback. It shows returned records, TTLs,
response code and resolver activity. FakeDNS answers are labeled synthetic test
mappings. Each test has fresh caches and mappings; policy observations also start
fresh and may initially select a fallback. No test applies the graph, restarts
active routing or configures a network adapter. DNS probes do send real requests
through the selected configuration's outbound paths.

## Read card results and observations

Delay/UDP results appear on outbound cards. The UDP marker is shown only when a
UDP test was performed: green for success and struck through for failure.
Country information belongs to the exit-IP details.

An Observatory connection can keep health/delay data current for a server, chain
or policy group. Group summaries use the lowest available delay for latency/load
strategies and an average for random/round-robin. Those summaries describe
observed candidates; they are different from a speed test of the current winner.
Missing data is not a zero-millisecond result.

## Inspect live traffic

Open **View → Traffic statistics…** or use the toolbar button beside the live
upload/download rates. The window includes overview totals and rate history,
plus **Traffic sources** and **Outbounds** tables.

Click a table header to sort; click again to change direction. Sorting and the
chosen rate/amount units are remembered. The chart's time window changes the
displayed history. A dash means a rate measurement is unavailable; a measured
zero means the sampled route was idle.

These are observed payload counters through Xray, not a complete Windows adapter
meter. Policy groups, aliases and chains are compiled routes, so a graph card
does not necessarily correspond to one independent network counter. Do not add
every composite/member row together as if it represented unrelated traffic.

**Pause** holds the display while collection continues. **Reset counters** resets
session, accumulated and endpoint counters and clears chart history. It does not
reset Windows counters or a provider's quota.

If a rate looks implausible, record the time and whether routing was restarting
or counters were reset, then save [diagnostics](troubleshooting.md). For one
misrouted destination, start with the filter's [Traffic log](traffic-rules.md)
instead of aggregate totals.
