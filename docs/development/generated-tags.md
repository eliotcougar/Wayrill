# Generated Xray tags

User-authored tags retain their spelling. Compiler-owned identities use unpadded
Base64url: 64 ASCII symbols, safe in JSON, URLs and exact selectors without
escaping. A 128-bit identity takes 22 characters instead of 32 hexadecimal digits.
The encoding changes representation, not identity strength. It is not a secret.

| Prefix | Purpose |
| --- | --- |
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
