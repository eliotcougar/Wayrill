# Traffic rules

A Traffic filter has ordered rules and named Outputs. First match wins;
Unmatched traffic supplies the final route. Reordering preserves stable rule,
output and wire identities. No selected detected protocols means any protocol.

Conditions include domains, addresses, ports, TCP/UDP, detected protocol and
supported application selectors. AND/OR follow explicit editor semantics.
Domain/protocol inspection cannot recover every encrypted name/protocol.

Host TUN/WinDivert rules can use executable names/paths/folders, children,
Windows services and packages. Remote Proxy clients and [shared clients](sharing.md)
do not carry host process identities. Checks report inapplicable conditions.
Ambiguous TUN ownership can Block, become unmatched or use a named Output.
Blocking is the conservative default; ambiguity is not an ordinary unmatched app.

Chaining is an authoring convenience. Parent guards combine with child rules
and flatten in precedence order. Unsupported combinations require correction,
not silent approximation.

## Import and source updates

Import Wayrill/compatible v2rayN files or URLs and map their outputs. Regional
presets are starting points requiring matching resources and suitable routes.

Set a URL/file source and refresh manually. Local domain/IP/process rows, edits
and exclusions survive merging/de-duplication. Disable a provider rule to retain
the override; deleting it can let it return later. Detach source keeps effective
local rules. Failure preserves accepted data. Emptied positive rules/alternatives
are skipped/disabled rather than becoming catch-all. Apply activates the draft.

Export rules supports Wayrill and compatible v2rayN. Embed overrides exports the
effective result; unchecked Wayrill export separates source and overrides.
Compatible mode reports unrepresentable Windows/process details. Main, Direct
and Block paths use proxy, direct and block where applicable.

## Traffic log

The card opens time/destination/output/rule history. Search destinations and
filter Outputs/Rules; selections persist per filter. Pause affects display, not
collection; Resume catches up. Selected text remains raw for pasting into rules;
deliberate bulk copy/export applies configured masking. Display filters do not
change collection or routing.
