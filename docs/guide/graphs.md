# Graphs and activation

Add nodes from the library. Drag an Output to a compatible Input, or use the
connection tool. Double-click to edit. Context menus/inspector provide editing,
duplication, replacement and deletion. Pan, zoom, Fit graph and Undo/Redo operate
on the draft.

Inbounds accept connections; Local capture sources operate on host/shared
traffic; Outbounds send or block. Data, DNS traffic, resolver selection and
Observation have distinct roles. Proxy DNS classifies port-53 traffic reaching
that input, not every Windows DNS request. Disabled sources keep settings/wires
without executing; their cards/links are subdued.

## Activation

1. Check finds errors and warns about unsupported/suspicious paths.
2. With no errors, Validate in its results checks generated core configuration.
3. Start activates stopped routing; Apply activates changes; Restart restarts
   an unchanged draft.
4. Runtime shows applied state separately. A failed Apply attempts previous-state
   restoration; inspect recovery status and logs.

Compatible rules use live updates. Changed outbounds use guarded restarts.
Compatible adapters/sharing are retained where possible; zero disruption is not
guaranteed.

Open graph stages a draft. Export graph deliberately writes plaintext.
[Backups](backups.md) can be encrypted. [Xray import/export](../reference/xray-import.md)
targets supported behavior, not restoration of original canvas/chain structure.
[Linked Stash definitions](stash.md) are shared. Replacing an outbound immediately
applies that route while leaving unrelated draft edits unapplied.
