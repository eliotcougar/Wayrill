# UI consistency with Wayrill

Remote follows the main app's menu, toolbar, graph and editor conventions. Its menu popup, context menu and focus-boundary implementation are reused from Wayrill 0.32.27; `vendor-source.json` records their source hashes. The graph compiler remains on its separately recorded source baseline.

## Shared structure

- **File:** new/open/export Xray configuration, Configuration stash, Load Example submenu and Close configuration.
- **Edit:** edit the selected node, manage User sets and reset user assignments.
- **View:** search node library, fit/zoom, navigation/properties visibility and Source JSON.
- **Graph:** Check graph and Select/Pan tools.
- **Settings:** Core settings and WinSCP setup.
- **Server:** read/refresh the selected server or file, validate/apply its draft, inspect Server status and refresh saved sessions.
- **Help:** Keyboard & canvas and About Wayrill Aquifer.

The toolbar keeps canvas tools, Check, Stash and pane toggles. Less frequent export, settings and source-inspection actions live in menus. Fit graph stays beside the bottom zoom controls. Node double-click and **Edit…** context actions select inline settings for simple nodes or open the full editor for complex nodes; **Properties** and **JSON** context actions open the same right pane used by card selection. Pane visibility preserves selection. Editor commits use **Apply changes** and remain local drafts.

While Properties is visible, its space stays reserved when selection is cleared. Selecting a card does not resize the canvas before a second click. Core and node editors use conventional forms rather than a native-property builder; see [settings workflow](SETTINGS-WORKFLOW.md).

## Vocabulary

| Concept | Shared UI term | Native data |
| --- | --- | --- |
| External listeners | Inbounds | Xray `inbounds` |
| Local interface capture | Local capture | TUN remains a native inbound in JSON |
| Routing targets | Outbounds | Xray `outbounds` |
| Points on nodes | Inputs / Outputs | Stable handle identifiers are unchanged |
| Main inbound output | Data | Existing data/traffic handle IDs are unchanged |
| Direct / blocked traffic | Direct / Block | `freedom` / `blackhole` protocols |
| SOCKS, HTTP and Mixed listeners | Proxy with its mode | Native protocol remains socks/http/mixed |
| DNS processing / resolvers | DNS handler / DNS servers | Native DNS JSON is preserved |
| Balancer | Policy group, Edit Group | Native `balancers` and tags are preserved |
| Observation connection | Observation | Existing observation handle/type |
| Root core options | Core settings | Actual server config, not client inheritance defaults |
| Node details pane | Properties / JSON | Source JSON remains a separate original snapshot |
| Shared candidate store | Configuration stash, Stash shortcut | Outbounds, Policy groups and Proxy chains include graph and pooled entries |

Node library groups use Inbounds, Rules & filters, Outbounds and User sets. It lists creatable types, not existing cards. The Linux server library excludes Windows TUN/ICS capture nodes. Existing singleton handlers open their settings without being duplicated or dirtying the draft. Display labels never rewrite user tags, addresses, conditions, protocols or stored credential sets.

## Deliberate Remote differences

The left pane chooses SSH sessions and provides a searchable node library. Click or drag a type to add it. Complex nodes open their editor; simple outbounds and DNS servers have inline right-pane forms with an Advanced disclosure where needed. Unsaved inline edits are protected before changing selection or hiding their editor. Server replaces the main app's Service menu. Remote has no local routing Start/Stop, Windows capture settings or client Global defaults. Core settings edits the loaded server configuration; it does not invent an inheritance layer. Check graph validates local graph compilation and is not a claim that the live server accepted or activated the draft.

Shortcuts: Ctrl+N new, Ctrl+O open, Ctrl+S export, Ctrl+R read server, Ctrl+F search node library, F fit, Enter edit selected node, Ctrl++/Ctrl+− zoom. Text entry and open dialogs/menus keep their normal keyboard handling. Server operations retain existing authorization/confirmation behavior.

Dedicated API plumbing is not a user traffic path on the canvas. API settings, including imported dedicated listener addresses/ports, live in Core settings. A shared ordinary/API listener remains visible to avoid concealing traffic. User sets distinguish Save to library from Apply to graph; one action never silently performs the other. Stash offers Add to graph for hidden outbounds and Locate on graph for visible definitions, without duplicating their native definition. New graph outbounds also appear in Stash.

The Apply action opens a separate validation and deployment dialog bound to the server and file that supplied the graph. A local/new draft can be bound to the selected server: Apply first reads the displayed remote path and captures current config/companion hashes without replacing the draft. Validation and explicit confirmation still precede any server mutation. Creating a new config while a server is open retains the original snapshot as the replacement baseline. The Check result can lead into server validation. Applying requires a fresh validation and an explicit Apply & restart confirmation; Close leaves a submitted detached job running.
