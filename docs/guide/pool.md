# Wayrill Pool

Wayrill Pool is a desktop application for administering routing on behalf of
other people. Open **Wayrill Pool** from the Windows Start menu or from
**Tools → Wayrill Pool** in Wayrill.

**Preview only. Wayrill Pool is not final and is not ready for production use.**
Use test users and configurations while evaluating it.

## Create a Pool

1. Choose **Create Pool**, name it, and choose a local publishing folder. If an
   HTTPS server serves that folder, enter its base URL. Invitations use that
   URL. For folder-based enrollment, subscribers need read access to the
   folder or its network share.
2. In the first-delivery guide, choose **Create graph**. The suggested starter
   connects subscriber traffic to a routing filter with Direct and Block
   outputs. Traffic uses Direct until you add rules or choose another outbound.
   Review the graph and choose **Save layer**. To start from an existing graph,
   choose **File → Export graph to Pool** in Wayrill, select the inbounds to
   convert, and open **Review exports** in Pool.
3. Choose **Set up user**. Pool preselects the graph when there is only one.
   Add any Stash layers, filter layers or private server accounts this user needs.
   Choose **Save and continue to publishing**, then **Review delivery**.
4. Choose **Publish delivery** and **Copy invitation**. Send each user their own
   invitation privately. It contains their access key for the encrypted delivery.

## Edit and assign layers

Each user can receive several graphs and layers. Every graph includes its
default filters and outbounds. In **Edit graph**, select an outbound and enable
**Outbound placeholder** in Properties to let the subscriber replace it with a
server, chain or policy group from their delivered Stash. Add **Inbound
Placeholder** nodes from the Inbounds library. Name them for their purpose and
connect each Data output. Enable the DNS, Encrypted DNS, or NAT outputs in
Properties when you need separate paths. Exporting a Wayrill graph converts
the selected real inbounds into placeholders and keeps their connections.
Subscribers supply the actual listeners and capture settings.

Existing Pool graphs open with editable placeholders for their published
entry paths. Subscribers need Wayrill 0.37.9 or later to receive deliveries
published with selectable layers. Existing invitations still work with the
new version.

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

## Publish app settings

In **Layers → Manage → Graph settings**, choose which settings a graph supplies.
In **Users → Edit delivery → App settings overrides**, set values for a specific
user across all their assigned graphs. The user’s override takes precedence over
the selected graph’s setting. If both inherit, Wayrill uses the subscriber’s
local default. Delivery Preview shows the values each graph will supply.

Pool can manage routing domain strategy, core log level, and the UDP listener
buffer sizes. Leave a buffer field blank to inherit, or enter **0** to use the
Windows socket default. Windows capture, log privacy, resource files, and other
local preferences stay with the subscriber. Wayrill shows the supplied settings
during enrollment and next to the corresponding local defaults. Removing an
override takes effect on the next published update.

Update subscribers to a Wayrill build that supports app settings overrides
before publishing a delivery that uses them. Older clients keep their last
working configuration when they encounter the new format.

## Use accounts observed by Aquifer

Read the server configuration in Aquifer. On the same Windows account, open
a user’s delivery in Pool and choose the server configuration and account
under **Aquifer servers for this user**. Add accounts from any observed server
that user should receive. Pool puts the selected connections in that person’s
Stash. To route through one immediately after the user receives the update,
select it as **Main outbound** and use a dedicated server placeholder marked
**Main** in the base graph. Expand **Use a different public endpoint** if clients
connect through a different host or port.

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

## Connect as a subscriber

1. In Wayrill, open **Tools → Connect to Pool** and paste into
   **Invitation or private access key**. The invitation fills in the source
   automatically. You can also enter the folder or URL and private key separately.
2. Keep your applied capture setup or choose a local proxy or TUN. The default
   for a new machine is a local proxy. Choose **Review Pool configuration**.
   Continue with the defaults, or open **Customize configuration** to choose a
   graph for this computer, Stash layers, filter rules and outbound replacements.
   Review where your traffic will go. Wayrill fills in a single route automatically.
   If there are several routes, choose one for each enabled local inbound.
   The Data path also handles traffic
   from local outputs without a separate path on the placeholder.
3. Connect, then choose **Test connections** to test the applied Pool graph.
   Use **Open applied graph** to load it into the editor. Use **Edit configuration
   choices** to revisit the setup later.

Wayrill saves assignments by node ID. Renaming or moving a placeholder
preserves its assignments. A new placeholder stays unused until assigned.
If a publication removes a selected graph, layer, outbound or assigned
placeholder, Wayrill keeps the last working configuration until you review
and apply new choices.

The main graph header shows the connected Pool. Click its indicator to see the
last check, change the update interval or resolve a paused or failed update.
The networking service checks for updates while Wayrill is closed. The default
interval is five minutes and can be set from 1 to 1,440 minutes. **Check now**
runs an immediate check and reports whether a delivery was applied. The connection
window shows the last check since service startup and when the Pool configuration
was last applied. A failed update keeps the last working configuration.
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
