# Stash and subscriptions

Stash is the reusable library behind the graph. Keep server profiles under
**Outbounds**, build **Policy groups** and **Proxy chains**, and manage downloads
under **Subscriptions**. Large server lists can stay here while the graph shows
only the routes you actually use.

Open it with the toolbar's **Stash** button or
**File → Configuration stash / import…**.

## Import and organize servers

Choose **Import / add subscription** for a URL or pasted configuration content,
or **Import file** for a local file. Share links, plain/Base64 subscription lists
and supported configuration JSON are accepted. Review unsupported entries before
assuming that every imported profile can run.

Give a URL subscription a recognizable **Group name**. **Download via** selects
Direct connection or Running Wayrill proxy. The proxy choice needs a working
running proxy and does not silently fall back to Direct if it is unavailable.
Advanced request settings cover a custom User-Agent, headers and explicitly
allowed unencrypted HTTP when a provider requires them.

Search and filter the Stash view to find servers. Test an entry before relying
on it, star favorites for quick access, and edit names to distinguish similar
profiles. URLs may contain private subscription tokens; they are shown while
editing, so review screenshots and exports before sharing them.

## Put an entry on the graph

Add a Stash entry to create a linked outbound node. To use an existing position,
right-click the graph outbound and choose **Replace → Select from Stash…** or a
starred entry. Servers, policy groups and chains can replace one another while
keeping compatible links, including Observation.

While routing runs, Replace switches that applied route immediately. It does
not apply unrelated draft changes. When routing is stopped, Start activates the
replacement with the rest of the draft.

Linked definitions are shared: editing an outbound on the graph also edits its
Stash version. Its graph position, tag and connections remain local to the graph.
Ordinary server/group/chain edits remain drafts until explicit activation;
saving the library is not an Apply. A provider refresh or explicit Replace has
the active-update behavior described here.
Adding a new outbound directly on the graph creates a manual entry in the
**Default** group. Deleting a graph node asks separately whether to remove the
Stash entry too. Duplicate a definition when you need an independent variant.

## Refresh a subscription

In **Subscriptions**, edit the group to rename it, change its URL or download
path, and configure **Refresh automatically** with its **Update interval
(minutes)**. The interval belongs to that subscription, not the entire Stash.
The networking service performs scheduled maintenance with the editor closed.

Manual refresh is available even when automatic maintenance is paused. The
group's actions also include pause/resume, **Retest group**, cancellation of the
current run, **Update from file…**, and export/removal. Read its progress and last
error instead of starting overlapping downloads when a run is still active.

### Remove unreachable servers

With **Remove unreachable servers** enabled, a downloaded set is tested before
unreachable entries are removed. **Max retries after the first attempt** adds
retries: zero means one attempt. Each subsequent refresh downloads and tests the
provider's set again, so a previously unreachable server can return.

The service protects deliberate dependencies:

| Entry | Update behavior |
| --- | --- |
| Explicitly used by the graph, a manual policy member, fallback or chain | Retained if omitted by the provider or unreachable during this update. Known unlocked connection settings can still be updated. |
| Locked | Kept intact. Changed provider settings can appear as a separate entry. |
| Only selected through a subscription filter | Membership follows the refreshed candidate set; a removed/unreachable entry can leave the group. |

Check that policy groups have a suitable fallback when their filtered candidate
set becomes empty. Choose Block if using an unintended direct route would be
unacceptable. Refresh failures preserve accepted data and report the cause.
Changes to active linked outbound settings go through the service's guarded
activation workflow; compatible Windows adapters/sharing are retained where
possible.

## Build a policy group

Create a group in **Policy groups**, name it and choose its candidate sources:
a filtered subscription, manually selected outbounds, or both. Preview the
resulting candidates before saving. A name filter that is too narrow can leave
an apparently configured group with no servers.

Choose a strategy and fallback. Lowest latency needs observed health/delay data;
least-load selection uses its configured observations and qualifications, not a
live bandwidth meter. Random and round-robin serve different selection needs.

Connect the group's optional **Observation** point to an Observatory. Automatic
subjects include connected outbounds and policy candidates. Reuse a common
Observatory where the probe settings should match. Separate observatories with
different settings are supported in separate execution subgraphs; Xray provides
one shared observation provider per core process.

Regular outbounds and chains can also connect to an Observatory to keep their
card's availability/delay current. This connection survives compatible replacement.

## Build a proxy chain

Create a chain in **Proxy chains** and add its hops in order:

```text
this PC → first hop → second hop → destination
```

The first hop carries the connection to the next; the last hop is the exit.
Select working profiles and verify that the required protocols support the path.
A chain is a sequence, not a set of alternative servers. Test the assembled
chain, not just its members independently.

## Switch from the tray

Star the entries you want to switch between and mark one graph outbound as
**Main**. Its distinct card identifies the tray's replacement target. The tray's
Replace menu offers starred entries and **Select from Stash…**. This is useful
for changing a server, group or chain without opening the full graph.

Use [Back up…](backups.md) to carry the Stash and its relationships to another
installation. Use [outbound tests](testing-statistics.md) to interpret latency,
UDP, exit-IP and speed results.
