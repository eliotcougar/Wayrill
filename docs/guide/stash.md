# Stash and subscriptions

Stash stores subscriptions, outbounds, groups and chains. Graph instances share
definitions. Adding an outbound creates a manual Default entry; graph editing
updates its Stash version. Deletion offers a separate library-removal choice.

Import links/configs or add a URL/file subscription. Name it, choose download
behavior and its per-subscription automatic interval. Service-owned updates
continue with the editor closed. Requested download through Wayrill needs a
running suitable proxy and does not silently fall back to Direct.

Remove unreachable servers tests each downloaded set with the retry policy and
removes failures; next refresh downloads/tests again. There is no Disabled-server
state. Locks and explicit graph/manual-member/fallback/chain references protect
entries from deletion. Known unlocked settings can update active uses through
service activation. Locks remain intact; changed provider data can be separate.
Failure preserves accepted data. Review URLs for credentials before sharing.

## Groups, chains and switching

Groups combine filtered subscriptions/manual members. Preview candidates and
choose strategy/fallback; connect Observatory for health/delay. A core process
shares observation settings; separate execution groups can use separate cores.

Chains apply ordered hops from first carrier to final exit, not parallel
alternatives. Edit reusable groups/chains in Stash or a linked graph instance.
All three outbound types replace each other while retaining compatible links,
including Observation.

Star favorites; mark one outbound Main for tray switching. Right-click → Replace
and tray Replace offer favorites/Select from Stash. The new route applies
immediately; unrelated graph edits remain drafts.
