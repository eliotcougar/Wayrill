# Wayrill Companion (preview)

Companion is a Manifest V3 extension for Chrome-based browsers on Windows. Click
its toolbar button to inspect domains requested by the **current tab**, including
subframes and WebSocket handshakes. Search the list and expand a domain for request
types, counts, cache/error counts, and last known Wayrill routes, including Block.

## Set up from the Windows app

Open **Settings > Browser Companion** in Wayrill. The installer includes the
extension and bridge; downloading a separate package or running PowerShell is
not required.

1. Choose **Enable bridge**. Setup registers the native host for the current
   Windows user; it does not require Administrator privileges or restart routing.
2. Select Edge, Chrome, Opera, Brave, Vivaldi or Chromium and choose **Open
   extensions**. For a browser that is not detected, open its Extensions page
   yourself. Portable browsers can use the displayed folder and a compatible
   native-host registration.
3. In the browser, enable **Developer mode**, choose **Load unpacked**, and select
   the folder shown by Wayrill. **Copy extension folder** and **Open folder** help
   locate it. Browser policy may prevent unpacked extensions; setup does not
   override browser policies or silently approve installation.
4. Remove older Companion copies from the browser's Extensions page. The bundled
   extension has a fixed ID across installation paths. Future updates replace its
   files in the same installed folder; reload the extension after an app update
   if the browser still displays its previous version.

The native bridge is shared: Chrome and Opera use the same registry location,
while Edge can also use fallback registrations. **Bridge registered** reports
registration, not proof that an extension is loaded or that browser traffic is
routed through Wayrill. Open the Companion popup to verify its connection.

To remove Companion, use **Disconnect all browsers** in Wayrill, then remove the
extension in each browser's Extensions page. Close existing Companion popups to
end their already-open bridge connections. Removal does not need the old script,
executable, package path, extension ID or even the current extension files. Setup
preserves unrelated registrations and external package files. It never deletes
browser profiles or changes enterprise policies.

**Older or custom copy** can authorize an existing path-derived extension ID.
**Use bundled copy** resets authorization to the bundled ID. A native-host
registration alone does not replace or uninstall an extension in the browser.

## Standalone/source package

Use the normal [build prerequisites](../development/building.md), install a
matching Wayrill networking service, then run:

```powershell
pwsh -NoProfile -File tools/Build-Companion.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Register-Companion.ps1
```

Load the package's `extension` folder unpacked. Its ID is stable across paths.
The script registers the same shared bridge as the app; `-ExtensionId` optionally
connects an older/custom copy, and `-HostPath` selects a portable host. Repair
registration after moving the host. The current script can disconnect all old
registrations without the former files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Register-Companion.ps1 -Unregister
```

Scripts support Windows PowerShell 5.1 and PowerShell 7. Start routing with the
browser included in Local capture or pointed at a Wayrill Proxy inbound. Reload a
regular webpage and open Companion. Traffic filters supply rule/output trails;
simple graphs show the observed outbound.

## What route observations mean

The browser associates requests with a tab. Wayrill's in-memory routing log
records destinations and selected outbounds, without browser tab/request IDs.
Companion correlates **exact destination hostnames**, including normalized IP
literals. It shows up to three distinct routes from the last observed revision
per domain, their port and
TCP/UDP transport, and the matching rule/output trail. The main core may reveal
a selected policy member; a capture worker can report only its graph output.

These are observations across applications and tabs, not proof of which route
carried an individual browser request. **Last known** observations do not expire
with age. A route change or Stop retains the old observation with its original
time, revision and generation until a new matching decision is observed. Block
is identified from the observed outbound's protocol, including renamed outputs;
a browser request failure alone is not evidence of Block.

History comes from Wayrill's in-memory routing log and a separate last-decision
cache (each bounded to 8,192 entries or 8 MiB). Repeated traffic to other domains
does not erase a retained Block when the connection log rolls over. Enough distinct
destinations can evict old cache entries; restarting the service clears its history.
While the popup stays open, an empty lookup or bridge failure
also retains its last known route. Reopening the popup reads the service history.
Unknown means no retained observation, never Direct. Long-lived connections are
not reconstructed from socket state.
With `IPIfNonMatch`, explicit matched rules remain observable but the implicit
default route is not instrumented, preserving Xray's DNS/IP second pass.
Native script routers are not instrumented in this preview.

Cached requests, reused/coalesced connections, service-worker requests with no
tab ID, destinations logged only as resolved IPs, browser-protected pages, and
traffic outside Wayrill capture may have no matching route. WebSocket messages
and WebTransport traffic are not individually inspected. DNS resolution paths
are not inferred from traffic routes. Request counts include redirect hops.

## Privacy and limits

The extension passively observes requests; it does not redirect or block them.
It needs `webRequest` and host access to observe a page's cross-origin requests,
`storage` to survive extension worker suspension, and `nativeMessaging` to read
Wayrill observations. There are no content scripts, remote scripts, analytics,
uploads, or external network calls made by the extension.

Capture retains hostnames, request types/counts/times, and bounded in-flight request
IDs in `chrome.storage.session`. It never retains URL paths, queries, headers,
bodies or page content. Session data clears with the browser session, extension
reload/disable, or tab closure; navigation starts a fresh page capture. Incognito
is disabled. Up to 48 recent tabs and 128 domains per tab are retained; truncation
is displayed. A very recent batch can be lost if the worker is terminated before
its 250 ms session checkpoint.

The normal-user bridge accepts only bounded `routes` lookups and calls the existing
authenticated local service pipe. It exposes no activation, settings, profile or
arbitrary-command interface and opens no HTTP listener. Registering the bridge
does not grant a browser permission to change Wayrill's routing.

The implementation follows Chromium's [request observation API](https://developer.chrome.com/docs/extensions/reference/api/webRequest),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
and Microsoft's [Edge native messaging registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging).
