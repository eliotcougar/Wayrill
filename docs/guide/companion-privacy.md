# Companion privacy

Wayrill Companion shows the domains requested by the current tab and the routes
observed by the Wayrill application on the same Windows computer.

The extension keeps domain names or IP addresses, request types and counts,
timestamps, and cache/error counts in browser session storage. It does not keep
full URLs, paths, query strings, page content, headers, cookies or credentials.
Private browsing is excluded. Captured data is bounded and clears when the
browser session ends, the extension reloads, or the corresponding tab closes.

When you open the popup, the extension sends the page's destination hostnames to
Wayrill through Firefox or Chromium native messaging. Wayrill returns matching
local routing observations: rule, output, outbound, port, protocol and observation
time. Choosing **Add to rule** sends the selected domain and relevant filter IDs
to the local app so you can edit a rule. The extension cannot activate routing.

This communication stays on your computer. The extension has no analytics,
advertising, remote scripts, developer-operated collection endpoint, or external
uploads. It does not change your browser's proxy settings or intercept page content.
The separately installed Wayrill app handles traffic according to your graph.

Chromium's optional **Timezone override · Experimental** applies one selected
timezone across regular web tabs. The manual mode makes no external lookup.
**Main outbound** and **Custom outbound** ask the local Wayrill service to query
`ipwho.is` through the applied Main or the selected Stash outbound. That provider sees the outbound's exit IP, without
receiving the page's destination names or browsing history. The selected zone
and lookup metadata stay in the local service's protected settings so routing and
extension restarts can preserve the override. Stash choices include names and
stable IDs; connection credentials stay outside the extension. The normal-user
native bridge identifies its browser from Windows process ancestry. The service
applies its policy to that browser's main process as the normal user. The same
service can manage applications selected in Wayrill, independently of Companion.
No debugger permission is used.
The feature does not read page content or change Windows'
timezone, and it is absent from the signed Firefox package.

Firefox classifies hostnames sent to a native application as **Browsing activity**
transmission, even when the recipient runs on the same computer. Companion
declares this required permission for that local functionality. It does not send
your browsing activity to Mozilla, the developers, or an external service.

Disable or remove the extension to stop capture. **Tools > Browser Companion >
Disconnect all browsers** in Wayrill removes this Windows user's bridge
registrations. It does not stop Wayrill routing or remove browser profiles.

Questions and source: [eliotcougar/Wayrill](https://github.com/eliotcougar/Wayrill).
