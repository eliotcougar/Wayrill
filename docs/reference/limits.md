# Configuration sizes and limits

The first beta supports large subscriptions, but the library, visible graph and
executed Xray configuration have different limits. Keep a large server set in
Stash and select candidates with a policy group instead of adding thousands of
cards to the canvas.

| Item | Limit |
| --- | ---: |
| Stash/source entries | 50,000 |
| Subscription groups in Stash | 500 |
| Visible graph nodes | 500 |
| Executed outbounds in one core configuration | 16,384 |
| Emitted traffic rules in one core configuration | 16,384 |
| Serialized core configuration / Xray JSON import | 16 MiB |
| Graph/workspace file | 64 MiB |
| DNS entries/outputs in a native import | 128 |
| Executed socket inbounds in one core configuration | 16 |

Generated helpers count toward the execution limit. A policy group with 16,384
server members may therefore be too large once DNS, aliases, fragmentation or
other internal outbounds are included. Chained filters can also produce more
Xray rules than the visible rule count suggests. Check reports an oversized or
overly complex result; it does not silently discard members.

## Importing large Xray configurations

For a native configuration with more than 256 outbounds, Wayrill can keep
unreferenced candidates in an internal pool. The default outbound, explicit
rule destinations and group fallbacks remain visible. Group previews and
pickers let you work with the pool without turning every candidate into a card.
Unchanged export retains the native outbounds and their original ordering.

A configuration that genuinely needs more than 500 distinct visible nodes still
exceeds the canvas limit. Reduce its visible routing complexity or split the
setup where appropriate; see [Xray import/export](xray-import.md).

## Checks and large tables

Large graph checks run in the background. Editing the draft invalidates its old
results. If a check fails or exceeds its execution time, it produces a blocking
error; an unfinished result cannot validate the new graph.

Traffic statistics retains endpoint counters in the service and retrieves large
tables in pages. A compact live snapshot is not a statement that later rows have
zero traffic. Search/page the relevant view rather than expecting the service to
send the entire library with every update.

The executable budgets are recorded in [service/limits.json](../../service/limits.json).
Other service and transport bounds protect individual requests and operations;
they are not additional subscription capacity. The app checks the connected
service's capabilities before activation.
