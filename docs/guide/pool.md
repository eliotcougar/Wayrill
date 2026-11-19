# Wayrill Pool

Wayrill Pool is a desktop application for administering routing on behalf of
other people. Open **Wayrill Pool** from the Windows Start menu or from
**Tools → Wayrill Pool** in Wayrill.

**Preview only. Wayrill Pool is not final and is not ready for production use.**
Use test users and configurations while evaluating it.

## Create a Pool

1. Choose **Create Pool**, give it a name, and select the local folder where
   Pool will write encrypted deliveries. For subscribers on another PC,
   choose **Through a Windows share** and enter the share path
   (for example, `\\server\WayrillPool`), or choose **Through HTTPS** and
   enter the URL that serves the folder. Set up the share or web hosting
   first so subscribers can read the deliveries. Use **On this computer**
   when testing and publishing on the same PC.
2. Choose **Use starter graph** to try the flow with Direct routing and both
   capture modes already wired. Use **Design graph** if you need a proxy or
   custom rules in place before publishing. To reuse a Wayrill graph, export
   it from **File → Export graph to Pool**, then open **Review exports** in Pool.
3. Name the first user and choose **Review delivery**. With one graph, Pool
   selects it automatically. Expand the delivery options if this user needs
   optional layers, app settings, or a private Aquifer account.
4. Check the default graph and Main outbound, then choose **Publish delivery**.
   From **Invitation ready**, choose **Test as subscriber** to verify the
   published invitation, or **Copy invitation** to send it privately.

## Edit and assign layers

Each user can receive several graphs and layers. Every graph includes its
default filters and outbounds. In **Edit graph**, select an outbound and enable
**Outbound placeholder** in Properties to let the subscriber replace it with a
server, chain or policy group from their delivered Stash.

A graph template needs exactly one **Proxy capture** and one **TUN capture**
Inbound Placeholder, each with its Data output connected. They can lead to
the same path or different paths. New templates start with both. In an older
template, the editor adds the missing capture entries using an existing path
as a starting point. Existing assignments retain their original entry IDs.
To add an entry yourself, choose **Inbound Placeholder** in the node library
and set **Local capture** in Properties. Additional inbounds, such as ICS,
can use an **Any inbound** placeholder. Enable the DNS, Encrypted DNS, or
NAT outputs when you need separate paths. When exporting a Wayrill graph,
selected inbounds retain their wiring as placeholders. Older invitations
still work. Subscribers need a client with the dedicated capture choices
to open newly saved templates.

Choose **New layer → Stash** to assemble a separate set of servers, chains,
and policy groups. Use **Edit Stash** to update a saved layer. You can also
send selected groups from Wayrill through **File → Export Stash layer to
Pool**. Subscriber deliveries contain the selected configurations.
Subscription URLs and request headers stay on the administrator’s machine.

Choose **New layer → Traffic filter** or **DNS filter** and select the filter
whose outputs the layer should use. Start with an empty rule list or copy the
selected filter’s rules. Use **Edit rules** to update the layer. Edit the base
graph when the output connections need to change. You can also send filters
from Wayrill using **Export → Export to Pool**.

In **Edit graph → Linked layers**, choose a saved Traffic or DNS filter layer
for each filter node and select the Stashes the graph should include. Link one
filter layer to multiple nodes when they should share the same rules. Keep the
graph’s output wiring and connect any new ports added from the source. Make
changes to shared rules and Stash entries in their source layers. A source edit
marks affected deliveries for publishing, even for users who received the
layer only through their graph. Use **Publish** to deliver the latest content.

Use **Manage** on a layer to rename it, duplicate it, export it as a file, or
assign it to multiple users. In **Assign users**, search by name and use
**Select shown** or **Clear shown** to change only the matching users.
**View users** opens the list of people assigned to that layer.
Layer files may contain plaintext credentials.
Use **Import layer file** or **Review exports** to add a layer or replace a
saved one. Filters can be reused when their output IDs or unambiguous output
names match the destination filter. Subscribers can choose one layer per
filter node. Deleting an assigned layer shows the affected users.
When deleting a base graph, choose a replacement or leave those users
unassigned until their next graph is ready.

Use **Add similar user** to start with someone’s graph, layer and default choices.
The new user gets their own invitation. Assign their private Aquifer accounts
separately. You can also copy graph and layer assignments in **Edit delivery**.
**Preview** shows what is applied by default and what subscribers can choose.
Open **Edit delivery** from the preview to correct an assignment.

### Route by application

In a Pool traffic filter, use **Pool applications** to create an entry, reuse
one from another rule, or import a Wayrill application identity file. Enter
exact Windows package family names or internal service names. An entry can
include alternate identities for editions published under different names.
On a PC where the app is installed, the regular traffic rule editor can export
an identity from a Windows application selector.

To let subscribers choose an executable, leave the published identities blank.
They can select a running app, browse for its executable, or choose a Windows
package or service in **Applications on this PC** during enrollment. They can
change the choice later under **Edit configuration choices**. The choice stays
on that PC and survives later deliveries. If the Pool requires a local choice,
Wayrill keeps the last applied delivery until the user makes that choice.

**Include child processes** applies to a package or executable when Wayrill
can verify the process tree. Use TUN for packages, services, and child
processes. With Proxy capture, the filter can still match supported executable
selectors and any independent destination alternatives.

### Reuse users, Stashes and filters

Choose **Add similar user** next to a user whose setup is close to the one you
need. Enter the new name, then enable **Make separate copies of this user’s
Stashes** when their servers need different credentials. Saving creates and
assigns private copies and opens the first copy for editing. Optional Stashes
keep their optional status. Shared source Stashes and existing users keep their
own settings. Private Aquifer account assignments must be chosen for the new user.

Each layer has a **Duplicate** action. Give the copy a name and choose
**Create copy and edit**. A copied Stash retains its servers, policy groups,
chains and their references. In **Edit credentials**, change account IDs,
passwords or keys together, then apply the changes and save the Stash. Referencing
policy groups and chains follow the edited server entries. Use the usual
outbound editor for endpoint, transport and other connection settings.
Traffic and DNS filter copies retain their rules and output mappings and can be
edited independently before being linked or assigned.

In a Stash editor, use **Copy / move from Stash** to select servers, policy groups
or chains from another saved Stash. Search or filter by entry type, select the
entries, then copy them. Referenced servers and dynamic subscription pools are
included automatically. Enable **Move selected entries out of the source Stash**
to move the selected entries when you save. A server still used by the source’s
policy groups or chains must be copied. Saving commits both Stashes together.
Closing without saving discards the pending transfer.

Use **Import from Aquifer** to browse cached server configurations. Search by
account name, inbound or server address and select the accounts to copy into this
Stash. Choose **All cached servers** to collect one user’s accounts across
several servers in one step. Accounts already imported into the Stash are omitted.
To update an existing server, use its **Replace with an Aquifer account** button
and select the new account. Its name and references from policy groups and chains
are retained. Read a server in
Aquifer first to refresh the cache. These imported connections are snapshots.
For accounts that should follow future Aquifer observations when published,
use **Aquifer server accounts** in the user’s delivery instead.

## Publish app settings

In **Layers → Manage → Graph settings**, choose which settings a graph supplies.
In **Users → Edit delivery → App settings overrides**, set values for a specific
user across all their assigned graphs. The user’s override takes precedence over
the selected graph’s setting. If both inherit, Wayrill uses the subscriber’s
local default. Delivery Preview shows the values each graph will supply.

Pool can manage routing domain strategy, core log level, UDP listener buffer sizes,
and the default files for plain `geosite:` and `geoip:` rules. Leave a buffer
field blank to inherit, or enter **0** to use the Windows socket default.

To publish filters that use Russian groups, choose `ru-geosite.dat` and
`ru-geoip.dat` in **Graph settings**, according to which groups the filters use.
Exporting a graph from Wayrill to Pool carries over its default geodata
filenames. During enrollment or an update, Wayrill fetches missing packaged
files referenced by the selected graph. Custom filenames require the matching
DAT on the subscriber or a download source configured for it in **Resource
files**. Explicit `ext:` selectors still name their own files.

Wayrill shows the supplied settings during enrollment and next to the local
defaults. Local resource selections and update schedules stay with the
subscriber. Removing an override takes effect on the next published update.

Update subscribers to a Wayrill build that supports the settings you plan
to publish. Older clients keep their last
working configuration when they encounter the new format.

## Use accounts observed by Aquifer

Read the server configuration in Aquifer. On the same Windows account, open
a user’s delivery in Pool and choose the server configuration and account
under **Aquifer servers for this user**. Add accounts from any observed server
that user should receive. Pool puts the selected connections in that person’s
Stash. To route through one immediately after the user receives the update,
select it as **Main outbound** and use a dedicated server placeholder marked
**Main** in the base graph. Expand **Use a different public endpoint** if clients
connect through a different host or port. Set **Stash entry name** when adding
the account, or change it later under **Edit entry settings**. Leave it blank
to use the generated name. A custom name carries forward when Aquifer observes
new connection settings for that account.

Aquifer refreshes the cache when it reads a remote configuration or verifies a
successful deployment. The cache is encrypted for the current Windows user.
In Pool, **Refresh Aquifer accounts** checks for changes. A changed connection
is available at the next publication. If an account has disappeared or its
identity has changed, edit the assignment before publishing. Previously
imported accounts remain available in their existing deliveries until replaced
or removed.

## Publish, withdraw, or move a Pool

In **Publishing**, search by user, graph or layer and filter by delivery status.
The main publish button applies pending deliveries for the users in view. Use
**Assign graph** to fix a user who needs a default graph. A pending edit
leaves the previous delivery and its invitation available until
publication succeeds. **New invitation** withdraws the old delivery and
prepares a fresh key. Publish the replacement, then copy its invitation.

Use **Withdraw** to pause delivery for a user. Subscribers retain their last
working configuration. Use **Resume publishing** to make a new delivery
available. To move the publishing folder, withdraw all deliveries first,
change the folder under **Pool settings**, then resume publishing. Send new
invitations if the subscriber URL or folder address changed.

Removing a user or deleting a Pool withdraws its deliveries. Deleting a Pool
also removes its saved layers and assignments. Revoke previously distributed
server credentials on the server to end access.

## Test a published invitation

Choose **Test invitation** next to a user in **Users** or **Publishing**.
Wayrill opens a separate window with the user’s invitation filled in and
reads the delivery from the same folder or URL the subscriber will use.
If you have pending edits, publish them first to test those changes.

Choose a capture mode and select **Review configuration**. Try the defaults
or customize the graph, layers, outbounds and inbound assignments as a new
subscriber would.
Choose **Open simulated graph** to explore the resulting graph, rules and Stash.
Use **Routing playground** to enter a destination and see which rule and
outbound or policy group Xray selects. The playground uses Wayrill’s networking
service to evaluate the rules. It sends no traffic to the destination.

Edits stay in the simulation. **Review invitation** starts a fresh review,
and closing the window discards the simulation.

## Connect as a subscriber

1. Open **Tools → Connect to Pool** and paste the invitation. Wayrill shows its
   folder or URL. If you received the private key separately, enter it and use
   **Enter folder or URL manually** to supply the source.
2. Choose **Proxy** for apps you point at a local listener, **TUN** for
   whole-computer capture, or **Both**. If you already have custom inbounds,
   **Keep existing inbounds** preserves them. Choose **Review configuration**.
3. Check the selected graph and where each local input goes. When several
   graphs are available, choose one for this computer. Expand **Customize layers
   and outbounds** or **Inbound assignments** if you need different choices.
   **Start routing if stopped** controls whether Wayrill starts routing during
   enrollment. Choose **Connect to Pool** to apply the reviewed configuration.
4. If you chose Proxy, use the shown address and port in your apps or open
   Windows capture settings. **Test outbounds** checks the configured server
   paths. The canvas opens the applied graph automatically.
   Use **Edit configuration choices** to change layers, outbounds or local
   capture later.

After enrollment, refreshes keep the existing inbounds and their settings.
To change them, choose **Edit configuration choices → Change local capture**.
Wayrill saves assignments by node ID. Renaming or moving a placeholder
preserves its assignments. A new placeholder stays unused until assigned.
If a publisher recreates a capture placeholder, Wayrill can reconnect it when
exactly one compatible entry leads every local output to the same destination.
If the intended path is unclear, the current routing stays in place.

### Make this computer your own

| What you want to change | Where to change it | What the next delivery does |
| --- | --- | --- |
| Use the administrator’s current default graph, even if it changes | **Edit configuration choices → Graph for this computer → Follow Pool default** | Follows the published default. Select a named graph to keep using that template. |
| Include or exclude an optional Stash | **Edit configuration choices → Customize layers and outbounds → Stash layers** | Keeps that preference on this computer, even when you follow the Pool’s changing default graph. Other Stashes continue to follow their published defaults. |
| Choose a different traffic filter, DNS filter or outbound | **Edit configuration choices → Customize layers and outbounds** | Pins this graph so the chosen filter or outbound stays attached to the intended node. Other filters can still follow their published defaults. Selecting **Follow Pool default** again clears graph-specific selections and keeps your Stash preferences. |
| Add a domain, IP or application exception | Open the traffic filter and add a personal **Before** or **After** rule | Carries your rules into the updated filter. |
| Add a static DNS record, tune DNS caching or probing, or change an independent outbound’s socket and transport defaults | Edit the node and **Apply** | Keeps your changed fields on that node. Static DNS records merge by host, so a local printer entry and the Pool’s updated bootstrap addresses can coexist. Under **Edit configuration choices → Personal node settings**, clear individual preferences to resume following the Pool. |
| Use a different log level, domain strategy, UDP buffer size or primary geofile | Change the value or primary file in **Global defaults**, then save and apply | Editing selects **Use my … on this computer** for that setting. You can also check it to keep the current value. Clear it to follow the Pool again. |

Personal node settings belong to a particular graph and node. A newly selected
template uses its own settings. To change a Stash-linked connection, select a
published alternative in **Edit configuration choices**. Rewiring the graph or
editing the publisher’s connection credentials directly requires taking control
of the routes and pauses automatic routing updates.

### When a delivery cannot be used

| What happened | How routing and recovery work |
| --- | --- |
| The source is offline, access was withdrawn, or the file is incomplete | The service keeps the applied configuration. It checks again on the configured timer, even with the desktop closed. |
| A selected optional Stash was withdrawn | A subscriber using individual Stash preferences receives the remaining Stashes. If a chosen outbound needs the withdrawn entry, the service retains the last working delivery. |
| A graph, selected outbound, filter output or capture path is missing or ambiguous | Open **Edit configuration choices**. Review the named conflict, select a replacement, or review the remaining available choices before applying. |
| The publication or local routing changed during setup | Choose **Review latest delivery**. Check the refreshed assignments before applying. |
| Existing local inbounds cannot be reused | Review with **Proxy** or **TUN** to see a fresh capture setup before applying it. |
| Resources, validation or activation fail | The service checks the candidate and required geofiles before switching. If activation has already begun, its recovery checkpoint protects the previous configuration. Check the reported cause, such as a missing custom DAT. A later corrected delivery can apply unattended. |

The main graph header shows the connected Pool. Click its indicator to see the
last check, change the update interval or resolve a paused or failed update.
The networking service checks for updates while Wayrill is closed. The default
interval is five minutes and can be set from 1 to 1,440 minutes under
**Connection settings**. **Check for updates**
runs an immediate check and reports whether a delivery was applied. The connection
window shows the last check since service startup and when the Pool configuration
was last applied. A failed update keeps the last working configuration.
The canvas follows the applied graph, including its traffic and DNS filters.
**Pool graph up to date** means you are looking at the service’s applied source.
Moving a node or panning the canvas keeps that status. **Unapplied local edits**
means the editor also contains changes you have made. Compatible edits carry
forward when a new delivery arrives. If the same setting changed on both sides,
the canvas shows the working delivery. Under **Connection settings → Export
previous local graph**, you can save the most recently displaced draft, including
its local settings and rules. **Show applied Pool graph** also takes you back
from a separately opened graph. Opening a graph in the editor does not start routing.

On each timer tick Wayrill checks the publication. HTTPS servers with a strong
ETag can answer that the saved publication is current without resending it.
An unchanged delivery leaves the running revision and its connections in place.
If you explicitly stop routing, later updates keep routing stopped.

Regular Stash subscriptions refresh independently. Received entries have a
**Pool ·** prefix. Disconnect to end Pool updates, and choose whether to keep
the entries delivered by that invitation in the Stash. The applied graph can
still use its saved server settings. Pool updates carry forward device capture
settings and independent Stash entries. Applying a different local graph or
changing the published rules directly pauses automatic updates so your applied
changes stay in effect. Use **Edit configuration choices → Apply choices** to
resume and activate the Pool's routing again. An existing enrollment may ask you to
review and apply your choices once when the first new delivery arrives after
upgrading Wayrill.

### Personal traffic rules

Open a Pool routing filter and choose **Add Before rule** or **Add After rule**.
Save the rule, then **Apply** the graph. Before rules can override a published
match, including a Block rule. After rules only match traffic that the published
rules leave unmatched, before the filter's **Unmatched traffic** output. Rules
run in order within each group, and the first enabled match wins.

Wayrill keeps applied personal rules on this computer as the Pool updates the
same filter. Choose existing outputs. If a delivery removes the filter or one of
those outputs, the service keeps the last working configuration and identifies
the conflict. Edit or remove the affected personal rule in the applied graph,
apply that change, then check for updates again.
