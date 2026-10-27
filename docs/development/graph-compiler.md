# Ordered routing paths

Chained traffic filters and shared branches are editing conveniences. Xray still receives one ordered `routing.rules` array. Importing that array produces a flat filter; it need not reconstruct the graph that produced it. Labels, positions, subscription filters and node topology remain in saved Wayrill graphs, not exported Xray JSON. The round-trip contract concerns supported core behavior.

## Precedence

1. Generated resolver-query transport rules come first.
2. SOCKS/HTTP destination-port-53 branches come before all Data branches. HTTP classifies TCP only. This does not capture Windows DNS outside these listeners.
3. Each inbound's Data/Traffic branch is scoped to its inbound tag.
4. A filter evaluates enabled rows top to bottom. The first match chooses a path. A selected child evaluates its own rows and finishes through its own fallback. Evaluation never returns to a later parent row.
5. Compilation expands each selected child in place, including its fallback, before emitting the next parent row. Shared children are expanded separately with each entering predicate and inbound scope.
6. A filter's default follows its rows. A match-all row ends that filter. Imported native graphs retain their implicit first-outbound default when it is unguarded; a guarded child fallback is an explicit rule.

For example, a parent `port:443` path into a domain filter emits the domain match combined with port 443, then a port-443 fallback, then the parent's next rule. That fallback prevents rejected HTTPS traffic from reaching a later parent rule.

## Predicate intersections and errors

Different condition fields are ANDed. Multiple entries within one field remain ORed. Repeated fields are intersected, never concatenated: port ranges, network/protocol/user/tag sets, full/domain literal names, and IPv4/IPv6 CIDRs have representable intersections. Disjoint paths emit no rule and receive a warning. Identical geosite/GeoIP/regexp predicates are retained.

Native `domains`/`domain` and `sourceIP`/`source` aliases follow the core's precedence before intersecting the same predicate along a path. A child alias cannot override its parent guard. Empty matcher lists add no condition; they retain the other entering predicate rather than making the path disjoint. Uncombined native rules keep their original JSON spelling and values.

Different opaque predicates in the same field can require an AND that Xray's single native OR list cannot express. These paths receive a node-attached error. Use different fields, identical opaque conditions, literal compatible domains/IPs, or express the final conjunction in one filter. Distinct HTTP attribute expressions for the same attribute also cannot be silently merged. Native rule metadata with side effects cannot be copied across a child filter; shared expansion that duplicates native `ruleTag` values is rejected.

Cycles, missing/default outputs, dangling destinations, incompatible ports, and existing listener/dependency problems remain errors. Expansion stops at 16,384 emitted rules or 65,536 visited path steps. See [runtime budgets](../reference/limits.md). DNS resolver preference/fallback rules keep their separate native semantics; these first-match traffic rules do not replace them.

Chained filters always use background analysis, including small canvases whose shared paths can expand exponentially. Ordinary graphs also use background analysis when their settings exceed 64 KiB or their native outbound pool exceeds 500 entries. These are UI scheduling thresholds, not runtime capacity limits.

## Verification

`routingPaths.test.ts` independently traverses the editing graph and compares it with first-match evaluation of compiled rules over packet matrices. Cases cover precedence, child fallbacks, disabled rules, shared branches, multiple sources, intersections, rejected opaque conjunctions and expansion limits. Flattened configs are imported/exported without requiring topology equality. The public Chained filters example combines a parent port guard with a child domain rule; policy groups/Observatory have a separate example. Optional core checks use run -test; see [testing](testing.md) for the distinction between acceptance and actual traffic.

Pinned source: [Xray router first-match evaluation](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/app/router/router.go).
