# Executable subscription budgets

The shared budget lives in `service/limits.json`. TypeScript imports it; Rust boundary constants are checked against it by a regression test. Desktop activation also checks the connected service's advertised capacity.

| Resource | Limit |
| --- | ---: |
| Total core outbounds per config | 16,384 |
| Emitted traffic rules per config | 16,384 |
| Serialized UTF-8 core config | 16 MiB |
| Named-pipe frame including LF | 32 MiB |
| Metrics response | 8 MiB |
| Endpoints in a periodic snapshot | 128 |
| Endpoint page | 100 |
| Routing path visits | 65,536 |

All core outbounds count, including visible destinations, policy aliases, fragment stages, DNS helpers and the implicit unmatched blocker in authored graphs. The sample maximum pool contains 16,380 members plus four existing/generated outbounds. Larger drafts receive explicit errors; no members are discarded. Stashes and saved source snapshots still support 50,000 entries, so filtering substantial subscriptions remains independent of the execution budget. Graph/workspace files permit 64 MiB.

Large graph checks run in an owned Web Worker after a 100 ms edit debounce, with a 60-second execution limit. Changing the draft cancels unfinished work by terminating its worker; completed workers can be reused. Startup failures, crashes and timeouts produce a blocking check error and retire the worker. A later draft retries with a fresh worker. Results are tied to both draft identity and analysis scope, so stale replies cannot validate a newer draft.

Exact candidate sets use aliases when an outbound tag would accidentally select another outbound by prefix. For sets of at least 128 members, selectors are compressed after every group and helper is built. A prefix is usable only when every final core tag it selects belongs to that group. Unicode prefixes end at whole code points. Explicit native prefix selectors retain their original behavior. Xray caches selections and sorts selected tags; compaction reduces cold selection work and selector JSON without changing membership or selection ordering. See [pinned outbound manager](https://github.com/XTLS/Xray-core/blob/b26a91de4f3294e26a0ad0a970b81a386a41f789/app/proxyman/outbound/outbound.go).

Imported native configs with more than 256 outbounds keep unreferenced candidates in an internal raw pool. The default outbound, rule destinations and group fallbacks remain visible. The editor's 500-canvas-node limit remains; a config needing too many distinct visible nodes is rejected. Policy previews search/page the pool; manual selection has a paged imported-pool picker. Export preserves every native outbound and its original order/settings.

Statistics retain all endpoint counters once in the service. Periodic snapshots/event replay include at most 128 rows and counts; large tables request 100-row pages. Replies carry generation, revision and sample identity. The frontend discards responses from a previous core/service session and hides stale rates while refreshing. History and exact decimal-string byte totals are unchanged. Endpoint tags at the service boundary are bounded to 1 KiB UTF-8, above the editor's ordinary tag budget including generated tags.
