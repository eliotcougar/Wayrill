# Building and running a graph

A graph describes where traffic enters, which rules it meets and how it leaves.
The canvas is the configuration editor. The running configuration is the version
that you have successfully started or applied.

## Know the node library

| Group | Purpose |
| --- | --- |
| Inbounds | Accept connections from an app or another client, such as a SOCKS/HTTP proxy listener. |
| Local capture | Capture this PC's traffic with TUN or WinDivert, or the shared connection with ICS TUN. |
| Rules & filters | Classify traffic, handle DNS requests and select resolvers. An Observatory probes outbounds and supplies health and delay information. |
| Outbounds | Send traffic Direct, Block it, or use a server, policy group or proxy chain. DNS server(s) and FakeDNS nodes also appear here. |

A node has Inputs and Outputs for links. Different connection types have
different roles: Data carries application traffic, DNS carries captured DNS
requests, resolver connections select how names are answered, and Observation
links provide monitoring. The editor allows compatible connections and Check
reports incomplete paths.

A Proxy node's DNS output classifies DNS traffic reaching that listener. It does
not, by itself, capture Windows DNS. See [DNS](dns.md).

## Edit the canvas

Use the node library on the left to add a node. Select it to see Properties on
the right, or double-click it to open its editor. The first toolbar button shows
or hides the library. View controls also show or hide the side panels.

Drag an Output to a compatible Input to connect nodes. The connection tool lets
you work on links explicitly; selecting a link exposes its editable endpoints.
Use **Graph → Edit selected connection…** to change an existing connection.

Right-click a node for editing, duplication, deletion and relevant actions.
Outbounds also have Replace and testing actions. Deleting a filter output removes
its attached link when the editor's changes are accepted. Drag-reordering outputs
changes their position on the card without changing which output the links use.

Use the Select and Pan tools, the zoom controls and **Fit graph** to navigate.
**F** fits the graph. **Help → Keyboard & canvas** lists the other shortcuts.
Undo/Redo includes graph edits and accepted node-editor changes.

Inbounds and Local capture nodes can be disabled without losing their settings
or links. Their cards are hatched and their links subdued. Check and execution
use enabled sources.

## Save an editor, then activate the graph

Accepting changes inside a node editor saves them into the graph. It is separate
from the main toolbar's Apply action, which changes running routing.

1. Click **Check** to find missing connections, invalid conditions and unsupported
   combinations. Use a result to locate the affected node or field.
2. Correct errors. Warnings do not prevent **Validate** from becoming available
   in the Check window.
3. Click **Validate** to ask the embedded core to check the generated
   configuration. This does not test Internet reachability.
4. Use **Start**, **Apply** or **Restart** on the main toolbar. Its label reflects
   whether routing is stopped and whether the draft differs from the applied
   configuration.
5. Inspect **Service → Run graph…** for the actual running state and applied
   revision. The graph's appearance alone does not establish that it is active.

During startup and shutdown, a progress overlay shows the current stage and
blocks canvas changes. Compatible rule changes can be applied live. Changed
outbounds use a guarded core restart; compatible adapters and sharing are reused
where possible. Failed activation attempts to restore the previous configuration.
Read the reported error and recovery state if it cannot finish.

## Drafts, Stash and immediate actions

Opening a graph or loading an example changes the draft. **Export graph…** writes
a readable graph file; [Back up…](backups.md) also offers encryption and other
scopes. Neither action starts routing.

Outbounds linked to [Stash](stash.md) share their connection definition. Editing
a linked graph node updates its Stash entry too. Its canvas position and graph
connections remain part of the graph.

**Replace** is an explicit switch: while routing is active, it updates that
applied outbound without applying unrelated draft edits. When routing is stopped,
the replacement remains in the draft until Start. Subscription maintenance can
also update active linked server settings through the service.

Windows proxy assignments made in **System traffic capture** are immediate
system actions. They do not wait for the main Apply button.

## Organize a larger graph

Use named outputs to describe a rule's intent, such as Local, Work or Streaming.
Keep a deliberate Unmatched traffic route on every traffic filter. A child
filter finishes its selected path, including its own default; traffic does not
return to the next rule in the parent. Wayrill flattens supported chains into
ordered Xray rules.

For large subscriptions, keep servers in Stash and use a policy group's candidate
filter instead of placing every server on the canvas. See
[traffic rules](traffic-rules.md), [Stash](stash.md) and the
[execution limits](../reference/limits.md).
