# Complete Xray configuration import and export

Wayrill provides **File → Import Xray config as graph** and **File → Export Xray configuration**. Import a file, paste JSON/JSONC, or use the service's applied configuration. Review the conversion before replacing the workspace; import is one undoable edit and does not activate networking.

The converter compares the source with the compiled graph and refuses an import that would change any JSON value. Save/open retains the native snapshots, section presence, tag identities, ordered arrays and comparison baselines. Formatting and comments are not reproduced. Credentials are included in deliberate graph/config exports; normal Windows workspace storage remains protected with current-user DPAPI.

## Fix capitalization in place

Review recognizes noncanonical capitalization of supported field and group names, including nested protocol, transport, DNS, routing, policy and observatory settings. For example, `Observatory`, `probeUrl`, `tlssettings` and `xhttpsettings` can be corrected to `observatory`, `probeURL`, `tlsSettings` and `xhttpSettings`.

When corrections are needed, **Import graph** stays disabled and a short list shows the affected JSON paths. Choose **Fix capitalization in JSON** to replace the name tokens in the editor and review conversion again automatically. **Undo capitalization fix** restores the exact original text. Editing or opening different JSON clears the old review and correction state. The action and subsequent result receive keyboard focus so they remain visible in compact dialogs.

The repair preserves all values, credentials, tags, array order, user-defined map keys, comments, whitespace and line endings. It never overwrites the source file. The graph's preservation baseline is the corrected JSON; graph/config export still follows the existing structural-equality contract and does not reproduce comments or formatting. Fixing capitalization does not apply the graph or start networking.

Corrections are schema-aware: DNS host names, HTTP header names, policy-level map keys, unknown extensions and unknown protocol bodies are not blindly case-folded. Typos beyond capitalization, such as `sockopts` instead of `sockopt`, remain unchanged. Competing aliases such as `Outbounds` and `outbounds` in the same object are rejected even when their values match; no automatic merge selects or discards a value. Other import errors remain visible after a successful repair, with Undo still available.

`src/graph/xrayConfigNames.json` records JSON field names and child types from the embedded core's source pin, plus known protocol/loader shapes and the reviewed account catalogue. The one preferred root-spelling exception is `fakedns`: Wayrill's existing compiler and service use it, and Xray accepts it case-insensitively although its Go JSON tag is `fakeDns`.

On a core update, review the new JSON tags and dynamic loader shapes, regenerate the protocol catalogue first, then run:

```powershell
$XraySource = 'C:\path\to\audited-main-Xray-source'
python tools/Generate-ConfigNames.py --root . --source $XraySource
```

Run from the Wayrill project root with the configured Python interpreter. The generator requires the checkout's HEAD to match `service/dependencies.json`; use the audited main-core source described in [CORE-DEFAULTS.md](../development/core-defaults.md), before private TUN hooks. An old reference checkout or a packaged source archive without Git metadata is not interchangeable with that generator input. The existing build guard also checks this catalogue's core pin and protocol-schema hash; setting `WAYRILL_XRAY_SOURCE` verifies its recorded source-file hashes. Review raw-message traversal exceptions and run capitalization/import tests after regeneration. Unknown extensible bodies deliberately remain opaque rather than guessing their schema.

See [capitalization validation](../development/testing.md) for automated coverage, the native Windows check and the remaining API-routing boundary.

## Visual controls

- **Proxy inbound (SOCKS / HTTP / Mixed):** listener, authentication and multiple accounts, UDP relay, policy level, name detection and stream settings. It exposes Data and DNS connection points; on a native import both retain the global ordered filter, without adding preclassification rules. Imported SOCKS inputs retain their original `socks` protocol and account spelling; the mode selector describes the core's existing HTTP compatibility. No port-53 preclassification rules are invented during native import.
- **VLESS, SOCKS, Direct, Block:** known configurations use their outbound controls. SOCKS supports flat Xray client fields, optional username/password, TLS/REALITY, transports, mux and socket tuning. SOCKS5 UDP is negotiated by the client/core; there is no invented outbound UDP checkbox or SOCKS version selector.
- **Global routing filter:** one top-to-bottom native rule list. Rules retain unmodeled properties and native conditions; output connections select outbound or policy-group tags. The default connection selects the first outbound, matching Xray's unmatched-traffic behavior without adding a catch-all rule.
- **Policy group and shared observatory:** native prefix matching, membership, strategy, fallback and observation settings. The internal candidate set is derived from actual tag matches; candidates and fallback have no canvas wires. The node is an outbound with an optional observatory settings link. Renaming tags updates unchanged imported references in their own inbound/outbound namespaces.
- **Xray DNS handler:** address family, query tag, EDNS client IP, cache/stale answers, fallback, parallel queries, system hosts and static hosts. Ordered, named resolver outputs assemble the core's server list. Adding, renaming, moving and removing outputs are atomic with Apply; Cancel leaves connections intact.
- **Xray DNS server(s):** one or more entries with address/port, domain preferences, expected/rejected answer IPs, fallback participation, final-query flag, address family, query tag, EDNS IP, timeout and cache overrides. Address-only string entries stay strings; additional options use object entries. The legacy `expectIPs` spelling and empty/false/zero fields survive an unchanged export. Editing an answer check resolves competing aliases to one authoritative field.
- **Xray core options:** separate Logging & routing, Policy levels, Statistics & metrics and Native JSON tabs. Policy controls cover all level timeouts, buffer size, user counters and system counters in the pinned core. Metrics supports tag-only and an optional HTTP listener. These controls and the core settings in Global Defaults stay synchronized. Clearing a field preserves its omission rather than inserting an explicit default.

DNS preferences retain Xray's resolver-selection/fallback semantics. They do not become first-match traffic rules. Nonlocal resolver queries have derived connections to the global routing filter; `localhost` and supported `+local` transports keep their local bypass. Changing a server transport updates that dependency automatically.

## Native fields and supported boundaries

Every imported node keeps fields that its named controls do not represent. DNS and core editors offer Native JSON tabs. All registered protocol families now use named protocol nodes with source-defined forms; legacy endpoint/account arrays remain editable. Extended layouts without an exact typed projection retain generic native nodes with the protocol editor and Native JSON. See [protocol nodes](protocols.md). Unknown native fields are retained; their presence does not guarantee support in the installed core or service.

Routing controls display the effective native predicate: `domains` overrides `domain`, while `sourceIP` overrides legacy `source`. A null preferred field uses the other spelling; an explicit empty list overrides it with no condition. Unedited export preserves both fields exactly. Editing or clearing that named predicate removes its competing alias, so a hidden native value cannot override the edit or become active again.

Native imports use a single global filter, DNS module and observation provider. Ordinary authored graphs keep the existing Data/DNS branches and explicit scoped routing compiler. The library offers the node types appropriate to each mode. The converter does not flatten arbitrary authored graph shapes or invent capture metadata.

Input is bounded to 16 MiB, 500 visible graph nodes, 16,384 executed outbounds/routing rules and 128 DNS entries/outputs. Large outbound arrays use an internal pool while preserving native order and settings; defaults and explicitly routed destinations stay visible. Export flattens chained/shared traffic filters; subsequent import need not retain their topology. Duplicate JSON keys, unsafe property names, integers outside JavaScript's exact range and ambiguous managed sections are rejected. Missing destinations, invalid ports, duplicate tags/connections, prefix-membership disagreement and missing required outputs are graph errors. Asset and service-execution restrictions are shown separately.

## Export versus service execution

Native projection metadata includes optional `editedKeys` for explicit edits to shared settings. This records intent when a value equals an import-time placeholder, such as typing `0` into an omitted socket option. The field then becomes an explicit zero in exported Xray JSON. Reset removes that field's edit intent and adopts the current graph/core defaults; a later Native JSON omission supersedes a named edit. No-edit imports retain structural equality. This is internal Wayrill graph metadata, not an Xray or service API field. See [defaults UI verification](../development/testing.md).

Export preserves imported listeners and root settings. The Windows service separately restricts execution to its supported protocol/root-section subset, explicit IPv4/IPv6 input addresses and ports 1–65535. A metrics listener must use an unused loopback port from 1024–65535. See [LISTENERS.md](../guide/capture.md). Tag-only metrics is supported. Log destinations remain service-owned. Native import uses API v1 capability `xray.nativeImport`; an older service cannot run it through the graph activation controls.

`geosite:`, `geoip:` and `ext:` references require matching assets beside the executed core. Graph export does not embed or download them. Keep credential-bearing profiles out of public reports and use matching dataset snapshots when checking equivalence.

Structural equality is stronger than comparing selected fields, but does not prove every external network behavior. Keep configuration acceptance and actual traffic evidence distinct; see [testing](../development/testing.md).

## File-read continuity

Choosing a new file immediately clears the previous conversion review. Import stays disabled until the currently displayed JSON is reviewed again. A newer file, pasted JSON, graph-name edit, applied-config selection, review action or closed window invalidates an earlier asynchronous read; late content and errors cannot replace the user's newer choice. The source file remains unchanged.

## Windows file encoding

Local graph, Stash, subscription, Xray and routing-file imports accept UTF-8 and BOM-marked UTF-16LE/BE. Decoding is strict: malformed or unmarked legacy-encoded files are rejected instead of silently replacing profile names, paths or credentials. URL subscriptions and Base64 link lists retain their UTF-8 format. Saved exports remain UTF-8.
