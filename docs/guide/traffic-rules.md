# Traffic rules

A Traffic filter sends connections to named Outputs. Rules run from top to
bottom, and the **first enabled match wins**. **Unmatched traffic** is the final
route when none of those rules matches.

For example, put a private-network rule leading to Direct above a streaming-site
rule leading to a proxy group, then choose your normal proxy for Unmatched
traffic. The order matters when conditions overlap.

## Build a rule

1. Add a **Routing filter** from **Rules & filters** and connect an enabled
   source's Data output to it.
2. Open **Edit rules…**. On **Outputs**, create meaningful names, then return to
   **Rules**. You can reorder outputs without breaking their existing connections.
3. Add a rule, give it a name and choose its output.
4. Enter destination or application conditions. Choose how to **Combine these
   alternatives**: **OR — domain, IP or application** matches any populated
   alternative; **AND — all populated fields (native Xray)** requires them all.
5. Add network, port or other conditions under **AND · Additional conditions**
   when needed. These further restrict the alternatives above.
6. Put the rule in the intended order and set **Unmatched traffic**. Choose
   **Apply changes** to close the editor.
7. Connect the filter's outputs to outbounds on the canvas, then Check/Validate
   and Apply the graph.

Multiple entries in a domain or IP field represent alternatives within that
field. Use one entry per line. Domain expressions such as `full:example.org`
match one exact name; `domain:example.org` also covers its subdomains. Use the
resource-browser button beside domain/IP fields to insert and preview GeoSite
or GeoIP expressions. See [Resources](resources-defaults.md).

TCP/UDP network selection and detected protocols are different conditions. An
HTTPS connection commonly uses TCP and may be recognized as TLS. **No detected
protocols selected means any protocol**. Name detection depends on the incoming
traffic and cannot recover every encrypted name or protocol.

## Match applications

Host TUN and WinDivert can match executable names, exact paths, folders, child
processes, Windows services and packaged apps. Use **Choose from this PC** to
avoid typing a path or package identity by hand. Review the full path before
selecting an executable; different installations can have the same filename.

Enable child-process matching when an app delegates networking to another
process. It follows the observed process relationship; selecting only a launcher
without its children may miss its networking helper.

Shared ICS traffic and connections from remote proxy clients do not carry the
local application's identity. A shared-only filter uses destination conditions.
If a filter is shared by host and ICS sources, its application conditions apply
to this PC; the shared path uses eligible destination alternatives and fallback.

**Ambiguous TUN ownership** handles a connection that cannot safely be assigned
to one local process. Its default is Block. You may allow it to reach Unmatched
traffic or choose a specific output. Allowing ambiguity does not turn an unknown
owner into a match for a particular application.

## Reuse and update rule sources

The editor can import Wayrill or compatible v2rayN rules from a file or URL.

1. Open **Edit rules… → Import** and choose **Open routing file…**, or enter a
   **Routing URL** and choose **Load URL**.
2. Review the preview and map imported destinations to the filter's outputs.
   **Replace rules** replaces the list; **Append rules · keep current default**
   keeps the existing default route.
3. Accept the import and connect any new outputs. Check the graph before Apply.

An attached source can be refreshed with **Update from source**. User-added
domain, IP and application entries, new rules and supported local changes survive
merging and de-duplication. Customized rules that disappear from the provider are
kept locally. A failed download or conversion keeps the accepted rules.

Disable a source rule to keep it off through future updates. Deleting it is a
different choice: the provider may supply it again on the next update.
**Detach source** keeps the effective rules as local rules and removes the
source relationship. Source updates are manual in this beta.

Regional presets are starting points. Check that their referenced resource files
are installed and that the outputs lead to the intended exits.

## Export a filter

Use the filter's **Export rules…** action and choose a format:

- **Wayrill** preserves Wayrill settings. With **Embed overrides** off, it retains
  the source and local overrides separately. Turn it on to export the effective
  rules with the overrides applied.
- **Compatible v2rayN** exports the effective rules and reports omitted features,
  such as Windows service selectors or child-process details. Outputs leading to
  Main, Direct and Block map to `proxy`, `direct` and `block`. Review other output
  names and supply matching resources and inbound tags in the receiving app.

Use [filter backups](backups.md) to move Traffic or DNS filters within Wayrill,
including their supported dependencies.

## Inspect the traffic log

Click **Traffic log** on the filter card. Each row records time, destination,
chosen output and matched rule. Search destinations, or filter Outputs and Rules.
The **All** checkbox selects or clears a filter's items; **Reset filters** returns
to the full view. Selections are remembered for each filter.

New rows stay in view while the display runs. **Pause** freezes the display for
inspection; collection continues into a bounded buffer. Resume shows the latest
retained entries. Old rows can age out while paused.

Copy selected text or use Ctrl+C to copy an unmasked destination into a rule.
Deliberate bulk copy/export uses the configured masking. Display filters and
search never change routing or what the service collects.

If a request is absent, reset display filters first, then check capture and DNS.
If it is present on the wrong output, inspect rule order and conditions. See
[Troubleshooting](troubleshooting.md).
