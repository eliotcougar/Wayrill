# Schematic connections

Connections use the object-avoiding orthogonal router from **libavoid**, through pinned `libavoid-js` 0.4.5. The previous vertical-lane-only routing implementation has been removed. The library computes a visibility graph around obstacles, searches for orthogonal routes and nudges parallel segments in both axes. Wayrill supplies actual node bodies, measured port positions and permitted directions, then independently checks the returned geometry.

## Connection roles

| Role               | Color          | Meaning and compatible inputs                                                                                                                                                                                                                                                     |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traffic            | Blue           | Packet traffic from inputs and routing filters; goes to traffic filters, DNS handlers, policy groups or executable outbounds.                                                                                                                                                     |
| DNS traffic        | Gold           | Destination-port-53 traffic arriving at SOCKS/HTTP inputs, or requests made by DNS servers. A traffic subtype: may enter ordinary traffic filters/groups/outbounds. Authored DNS-server requests use an outbound or policy group; the handler's forwarding path uses an outbound. |
| Resolver selection | Purple, dotted | DNS-handler preferences and server configuration. Authored handler → authored DNS filter/server; authored DNS filter → authored DNS server. Imported global Xray DNS → imported native server nodes.                                                                              |
| Observatory        | Slate, dashed  | Shared observatory settings selected by a policy group. Goes only to an observatory. This is a settings dependency; no live health data flows along the link.                                                                                                                     |

There are two traffic families and two configuration relationships. Colors describe a connection's role, not proof of its packet contents. Ordinary traffic can contain DNS; an ordinary input can feed the DNS handler. Encrypted DNS on ports other than 53 is ordinary traffic at the input. These ports do not imply Windows DNS capture.

Multi-role input dots show segments of each accepted color. Their tooltips list accepted roles; output tooltips describe what the output represents. Labels and different line patterns supplement the colors.

`connectionKinds.ts` contains dependency-free presentation metadata. `connectionTypes.ts` classifies actual node/port roles and implements the compatibility rules used by both interactive connections and structural graph validation. Classification uses the source node kind, so a user-named traffic-filter output called “dns”, “resolver” or “observation” remains Traffic. Native and authored resolver nodes retain their different compiler contracts. Native server query links still follow the imported global routing filter.

## Geometry contract

- Every link consists of horizontal/vertical segments with square corners. Orthogonal crossings carry no junction dot.
- Every measured visible node is an obstacle, including unconnected nodes. Connections leave and enter their actual handles in the permitted direction; they do not run through their own bodies.
- Parallel overlaps are rejected unless they form a contiguous shared suffix into the **same target node and input port**. Connections may join on their final approach, but cannot combine and split again.
- A junction dot marks the start of a real shared approach. Different connection roles on that approach are painted as an alternating-color bundle. Derived edge render order is deterministic and selection does not elevate a solid stroke above that bundle.
- The preferred lane separation is 16 graph units. Obstacle clearance retries at 16, 8 and 0 for narrow gaps; actual node-body exclusion remains mandatory. Numeric solver noise is normalized without moving real endpoint anchors.
- If fixed/covered ports or an unsatisfiable arrangement cannot produce a valid path, the connection remains in the graph but is not drawn misleadingly. The status bar reports **Connections need more space**; move overlapping nodes or increase separation. Graph execution semantics do not depend on visual placement.
- Labels remain anchored to their link, with candidate positions scored to avoid nodes and other labels. Layout is recomputed for node/port measurement and position changes. Selection, pan and zoom alone do not change routing coordinates. Geometry is excluded from saved graphs and Xray configurations.

`libavoid.ts` provides a narrow binding boundary matching the pinned stable WebIDL API, whose published package declarations differ from its runtime. A router transaction is owned and destroyed for each layout; temporary objects and borrowed wrapper-cache entries are released. The allocation regression case covers repeated edits. The WASM asset is loaded once before React starts. The desktop CSP permits same-origin WebAssembly compilation with `wasm-unsafe-eval`, without enabling arbitrary JavaScript eval.

## Connection authoring and inspection

The third icon-only toolbar tool, **Add connection**, **Graph → Add connection…** and the Inspector's unused outputs open an endpoint chooser. Source node/output and a searchable destination list provide an alternative to dragging for pointer and keyboard users. Roles and accepted inputs are stated in text; unavailable destinations can be revealed with their validator reason. Occupied outputs offer explicit editing of the existing wire. No route or fallback is implicitly replaced.

The Inspector's textual connection list selects and frames a wire, names both endpoint ports and identifies the actual incoming/outgoing role. Selected wires offer Show endpoints and Edit; double-clicking a line also opens the editor. Current/proposed endpoints remain visible while controls scroll. Apply retains edge identity/metadata and commits one undoable draft edit. Cancel/Escape leave the graph intact; no-op edits add no history. The same validator is used for dragging and dialog edits, with an additional mutation-time check against the current graph.

Native DNS server query paths are generated by imported Xray settings, labeled Generated and protected from direct editing/deletion. Edit their DNS server settings instead. This protection does not change their traffic role or automatic routing dependency. See [pass 5 validation and limitations](testing.md).

## Dependency references

- [libavoid routing API](https://www.adaptagrams.org/documentation/namespaceAvoid.html)
- [Routing parameters and nudging options](https://www.adaptagrams.org/documentation/router_8h.html)
- [libavoid-js source](https://github.com/Aksem/libavoid-js/tree/28a6fe20c2f1f809afdbeca8d789e65357614c4f)
- [Third-party notices and source/build inputs](../../THIRD_PARTY_NOTICES.md)

## Routing lifetime and spacing recovery

Schematic routing runs in a dedicated worker. At most one transaction executes and one newest request waits; new requests sample the latest geometry after 16 ms without extending the timer. A four-second timeout terminates the worker and offers Retry connection layout. It is retired after 32 transactions so the complete WASM heap can be reclaimed. Completed intermediate drag layouts supply display lanes while endpoints are projected onto current geometry; stale errors are ignored. The final completed layout must match current geometry. Unroutable connections remain explicit diagnostics; the original native memory-failure cause is not proven by this change.

Retirement detaches message, error and deserialization handlers before terminating the worker. Late events from a retired transaction cannot fail the replacement layout or invoke callbacks after disposal.

New cards use measured collision-aware placement near the requested canvas location. **Graph → Space overlapping nodes** resolves collisions after cards grow while retaining unaffected positions and node/edge identities; it is one undoable draft edit. It is an explicit recovery action, not an automatic topological relayout. Palette drops outside the canvas and canceled gestures do not add nodes. Click/keyboard insertion remains available.

## Continuous drag display and toolbar

Previously, each position/measurement change cleared every rendered route before the asynchronous worker completed. Continuous dragging repeatedly invalidated pending layouts and made all links blink. The hook now retains completed lanes and projects each existing link onto its current measured ports until the latest layout completes. Deleted links disappear immediately; replaced endpoints and new/unmeasured links cannot borrow an unrelated path. Empty graphs create no worker job.

The provisional drag display uses orthogonal rubber-band segments with outward port stubs; equally translated endpoints move together. Junction/bundle decorations are withheld until the validated layout completes. This transient display is not an obstacle solution and may cross a moving node or overlap another lane while the worker catches up. Final paths still use the unchanged libavoid obstacle/overlap validator, including explicit blocked routes and Retry recovery. Preview geometry is never saved or compiled.

Fit graph now sits beside the bottom zoom buttons and retains the F shortcut. The first three tools are Select, Pan, and icon-only Add connection. Check, the dynamic Start/Restart/Apply action, and Stop appear together in the main toolbar. Validation is available in the Check results after error-free checks. Toolbar and Runtime panel share draft eligibility, service capabilities, capture ownership and Windows proxy choice. Check is local; Validate calls Xray; Start/Restart/Apply explicitly activates the draft; Stop remains available for cleanup even when the draft is invalid. Successful commands report completion; rejected commands open Runtime details.

Regression coverage exercises changing endpoints, group translation, removed/replaced/blocked links, orthogonal segments and asynchronous layout completion/error/retry. Shared runtime-action tests cover current draft/revision submission, proxy preference persistence, capabilities/budgets, foreign capture guards and failed commands.

## Node context menu and simplified toolbar

The first toolbar control toggles the node library and carries a plus badge. N and Graph → Add node… open/focus its search. The duplicate toolbar Add node and infrequent Export graph controls were removed; File export/Ctrl+S remain.

Right-click any card, or use Shift+F10 / the ContextMenu key on its focused wrapper. Actions operate on the clicked node: Edit, Rename, Duplicate, Delete, plus Add connection for authorable outputs and Replace for outbound/policy nodes. Generated DNS query paths are excluded from Add connection. Duplicate respects singleton/native-root restrictions. All graph changes use existing undo history; editing a rule opens its existing atomic editor.

The viewport-clamped menu supports arrows, Home/End, letter search and Escape. Escape restores node focus; dismissal outside does not steal focus. Focus returns to the node before opening an editor/replacement chooser, which supplies the editor's return target. Menu keystrokes cannot trigger canvas shortcuts. A disappearance, canvas movement, window blur or resize dismisses the menu. Dismissal is idempotent when focus restoration causes a blur event.

## Continuous drag scheduling and bend projection

The 80 ms trailing debounce reset on every movement and could starve the router until release. Requests now sample the newest position after 16 ms without extending that timer. A running transaction still owns only one newest pending slot, dispatched immediately on completion. The four-second deadline and 32-transaction worker retirement remain.

Live projection moves the bends adjacent to changed endpoints instead of joining back through old corners. When a port crosses its old bend, a bounded local orthogonal detour preserves outward endpoint directions and rejects collinear retracing. Unchanged links keep their placed label, junctions and mixed-role bundle markings. Equal group translation moves their full geometry and decorations together. An outdated blocked worker result cannot blank an already usable link after the pointer has moved away; an exact current blocked result remains authoritative.

This is still provisional display geometry while the worker solves obstacles. It may temporarily overlap a different lane or moving obstacle. Final libavoid geometry, obstacle exclusion, shared-suffix validation and explicit spacing diagnostics are unchanged. Projection is never saved or compiled.

Regression cases cover uninterrupted movement, a slow worker with a bounded newest slot, endpoint directions, translated decorations, unchanged labels, old-bend retracing and blocked intermediate/current results. Browser QA should exercise actual pointer dragging, obstacles, Undo and zoom; geometry assertions alone do not establish smooth rendering. See [testing](testing.md).

## Card selection and output order

Selected cards use an accent border plus a one-pixel adjoining outline (two-pixel visible stroke) and layered raised-card shadow. Outline/shadow do not change node/body/handle dimensions; selection does not require geometry recomputation. Forced-colors selection retains a visible accent outline.

Traffic/DNS output editors share a pointer-captured drag list with a dedicated grip, drop indicator and keyboard alternatives. Output IDs and edge identities remain unchanged; only port presentation order changes. The existing port signature triggers React Flow handle remeasurement after Apply, then the schematic router recomputes paths for the new anchors. Preferences, traffic rules/defaults, DNS fallback policy and generated configuration retain their semantics. DNS Fallback keeps its permanent name/role while its presentation position can move.
