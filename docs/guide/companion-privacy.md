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

Firefox classifies hostnames sent to a native application as **Browsing activity**
transmission, even when the recipient runs on the same computer. Companion
declares this required permission for that local functionality. It does not send
your browsing activity to Mozilla, the developers, or an external service.

Disable or remove the extension to stop capture. **Settings > Browser Companion >
Disconnect all browsers** in Wayrill removes this Windows user's bridge
registrations. It does not stop Wayrill routing or remove browser profiles.

Questions and source: [eliotcougar/Wayrill](https://github.com/eliotcougar/Wayrill).
