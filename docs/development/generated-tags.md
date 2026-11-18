# Generated Xray tags

Imported tags retain their spelling. Editors generate internal node tags from the
initial name and node identity, then retain them when a card is renamed. Equal
names still produce distinct tags. Names can contain Unicode and do not affect
the fixed tag width. Ordinary reference controls search by name and retain native
prefix expressions and external references in an advanced section.

Tagless native imports still round-trip unchanged. Editor previews derive stable
identities from node IDs; an explicit edit saves those identities into the draft.
Opening or cancelling an editor leaves the imported graph untouched. Copying a
set of nodes remaps its exact references to the copies. Native selector prefixes
remain global queries and retain their spelling.

Exact outbound references share a schema-aware walk in
[`outboundReferences.ts`](../../packages/core/src/outboundReferences.ts). Validation,
chain expansion and isolated outbound tests follow the active transport, including
XHTTP download settings and inherited socket settings. Copying or renaming nodes
also updates dormant transport references, so changing transport later does not
reconnect a copy to the original. Headers, credentials and other payload strings
are never rewritten as references. Inbound and outbound namespaces stay separate.

Test deduplication uses the same exact-reference model. Native prefix selectors
are compared by their actual membership; least-load cost expressions retain tag
names when those names can affect selection. Name pickers offer concrete outbound
handlers for socket dial-through. Multi-hop routes belong in Proxy chains.

Compiler-owned identities use unpadded
Base64url: 64 ASCII symbols, safe in JSON, URLs and exact selectors without
escaping. A 128-bit identity takes 22 characters instead of 32 hexadecimal digits.
The encoding changes representation, not identity strength. It is not a secret.

| Prefix | Purpose |
| --- | --- |
| `in-`, `out-`, `pg-`, `chain-`, `dns-` | Editor-created node identities, at most 28 ASCII characters |
| `node-` | Stable identity assigned to a previously tagless native node when editing |
| `wpp-` | Subscription profile in a policy group |
| `wpi-`, `wpe-`, `wpm-` | Policy inner transport, empty selector, exact member |
| `wob-`, `woi-` | Observation alias and inner transport |
| `wc-`, `wcr-` | Chain expansion and reinjection |
| `wri-` | Fragmentation inner transport |
| `wds-`, `wdg-` | DNS server and global DNS query source |
| `wte-`, `wti`, `wtu` | Test outbound root, HTTP test inbound, UDP test inbound |
| `wtr-` | Private TUN relay |
| `wdr-`, `wdr-n-`, `wdo-` | DNS resolver, native resolver, DNS outbound relay |
| `wi6-` | Shared IPv6 relay copied into the host worker |
| `wrr-` | Runtime routing-log rule identity |
| `wa-`, `wl-`, `wt-` | Control, local-only and telemetry outbounds |

Fixed tags include `wr-u` (unmatched Block), `wr-a` (ambiguous ownership Block)
and `wr-n` (NAT traffic scope). Control/local/telemetry tags retain a leading
private marker chosen outside user selector prefixes, so shortening a tag cannot
make a private path an unintended policy candidate.

Frontend identities are derived in [`tags.ts`](../../src/graph/tags.ts).
Service-generated random tags retain 128 random bits. Individual counters use
base 64; tuples use unsigned varints followed by Base64url, avoiding collisions
from joining variable-length numbers with a character in the encoding alphabet.
See [`tags.rs`](../../service/daemon/src/tags.rs).

Observation aliases are opaque. The compiler supplies an explicit alias-to-public
tag map with applied display metadata; the service does not recompute hashes for
every subscription item while polling. Internal graph IDs, saved profile IDs,
adapter GUIDs, credentials and authentication tokens use their existing formats.
