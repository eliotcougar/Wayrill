# Wayrill Companion (preview)

Companion is a Manifest V3 extension for Firefox and Chrome-based browsers on Windows. Click
its toolbar button to inspect domains requested by the **current tab**, including
subframes and WebSocket handshakes. Expand a domain for request types, counts,
cache/error counts, and last known Wayrill routes, including Block.

## Set up from the Windows app

Open **Tools > Browser Companion** in Wayrill. The installer includes the
extension and bridge; downloading a separate package or running PowerShell is
not required.

### Firefox

Choose **Enable bridge**, select Firefox and open its Add-ons Manager. Choose
**Install Add-on From File** and select the bundled `companion-firefox.xpi`.
Wayrill's **Open folder** button selects this signed file in Explorer; the path
can also be copied into Firefox's file picker. Accept
the requested permissions, reload a webpage and click Companion's toolbar button.
Firefox does not use the Chromium unpacked folder or Developer mode. The unsigned
signing ZIP is for Mozilla submission, not permanent installation.

Firefox's **Browsing activity** permission covers sending destination hostnames
to the local Wayrill app. It does not authorize remote uploads; see
[Companion privacy](companion-privacy.md). A signed Firefox update is installed
by Firefox or from a newer signed XPI, independently of Windows app updates.

### Chromium browsers

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
   Keep Developer mode enabled while using the unpacked extension.
4. Remove older Companion copies from the browser's Extensions page. The bundled
   extension has a fixed ID across installation paths. Future updates replace its
   files in the same installed folder. When Companion next connects, a matching
   updated bridge and extension package trigger the browser's own extension reload,
   even if request capture failed to start or the networking service is offline.
   The popup may close once; reopen it. Reloading clears the captured request list;
   reload a webpage to capture requests it already made. If an older copy cannot
   reconnect, reload it manually from the browser's Extensions page.
   An app upgrade disconnects open bridge sessions before replacing their files;
   browsers can stay open. The popup reconnects when the new bridge is available.

The native bridge is shared: Firefox has a separate Mozilla registration and
add-on allowlist; Chrome and Opera use the same registry location,
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

The standalone bridge can open the rule editor in a normally installed Wayrill.
For a portable app, keep the bridge beside `wayrill.exe` or in its `Service` folder.

Scripts support Windows PowerShell 5.1 and PowerShell 7. Start routing with the
browser included in Local capture or pointed at a Wayrill Proxy inbound. Reload a
regular webpage and open Companion. Traffic filters supply rule/output trails;
simple graphs show the observed outbound.

## What route observations mean

The browser associates requests with a tab. Wayrill's in-memory routing log
records destinations and selected outbounds, without browser tab/request IDs.
Companion correlates **exact destination hostnames** from this PC's traffic,
including normalized IP literals. It shows up to three distinct routes from the
last observed revision per domain, their port and TCP/UDP transport, and the
matching rule/output trail. The main core may reveal a selected policy member;
a capture worker can report only its graph output.

Internet-sharing clients are excluded, including shared IPv6 handled by the host
TUN. Their decisions remain in the filters' traffic logs and do not replace this
PC's retained observations when a TV or another device accesses the same domain.

These are observations across applications and tabs on this PC, not proof of
which route carried an individual browser request. **Last known** observations
do not expire with age. A route change or Stop retains the old observation with
its original time, revision and generation until a new matching decision is observed. Block
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

## Add a domain to a traffic rule

Expand a domain and choose **Add to rule…**. Wayrill opens even if only its
networking service is running; an app already in the tray comes to the front.
An open editor keeps its unsaved changes, and the request waits until you close it.

Choose a traffic filter and an existing rule, or **New rule…** and an output.
An observed Unmatched traffic path preselects its filter when that filter still
exists in the draft. Choose an entry:

- `full:example.net` matches that exact name.
- `domain:example.net` matches the name and its subdomains.
- `example.net` matches names containing that text.
- **Custom** lets you edit a single Xray domain condition before adding it.

**Find matching GeoSite groups** searches the selected installed resource file
using the embedded core's string matchers, including regular expressions. It
starts with the default geosite file and can search configured extra files too.
Results show the matching entry and group size. Selecting a group adds the whole
group, not just the current domain. A result from an extra file uses `ext:`.

**Add to draft** preserves the rule's other conditions, priority and enabled state.
Additions to a URL/file-synced rule become local overrides and survive refreshes.
Routing continues unchanged until you **Apply** the graph. Existing observations
may describe an older applied graph; they do not guarantee that a chosen rule in
the draft will match every request from that domain.

## Timezone override (Chromium)

Expand **Timezone override** in the Companion. Choose **Main outbound**,
**Custom outbound** to select a Stash server, chain or policy group, or **Manual**
to select a timezone from the dropdown. Then choose
**Apply and reload web tabs**. The default is Off. One timezone applies to all
regular web tabs in that browser session, including newly opened tabs. Chromium
can share worker/renderer processes, so separate per-tab zones are not offered.

Main probes the applied graph's Main outbound through Wayrill and asks
`ipwho.is` for its exit-IP timezone. Custom uses the selected saved Stash definition,
including its chain or policy selection. Apply again after changing the outbound. A policy
group may later choose a different exit, and individual routing rules may use
other outbounds; one browser timezone cannot match all those paths. The lookup
is an IP-geolocation estimate. A failed lookup preserves an existing override.

The Companion configures Wayrill's native override for its own browser. It does
not use debugger access and shows no debugging banner. The service saves the
preference separately from routing. Closing the desktop window, restarting routing,
or opening DevTools leaves the override active. The service restores the saved
zone when the browser starts, even without Companion and without repeating an outbound lookup. **Off** restores
the system timezone for that browser. Apply reloads open web tabs; background
restoration does not. If the service is temporarily unavailable, restoration retries
automatically.

The service runs a normal-user adapter that loads a small Rust override into the browser's main
process. Chromium propagates timezone changes to its renderers, workers and
iframes through its own notification mechanism. Protected subprocesses are left
alone. Both x86 and x64 browsers are supported on x64 Windows. Windows groups some IANA
zones under one native timezone; the popup shows the browser's actual zone name.
Pages may execute before startup restoration finishes, and an application may
retain previously created date formatters. Windows' timezone, language and
geolocation settings are unchanged. Firefox's signed add-on does not include it.

You can also configure browsers without the extension in **Tools > Timezone
spoofing**. That window detects installed browsers and lets you add an executable,
running application or installed package. Protected apps and apps with their own
timezone handling may refuse or ignore an override.
Recognized Electron and Node.js applications use startup initialization, because their
JavaScript runtimes can cache timezone offsets before a live override arrives.
Save the setting, wait for **startup timezone prepared**, then fully quit and
reopen the application. Do this after each change, including switching Off.
Wayrill sets `TZ` only inside that application's process, before Node initializes;
it does not change your Windows user or system environment.
For an installed-package policy, launch the app once so Wayrill can discover its
executable, then restart it after preparation finishes. A new executable path
after an app update may also need this discovery/restart step.
Firefox also uses a startup override and requires a complete restart after changes.
The signed Firefox extension remains unchanged; configure this in Wayrill itself.
Custom Stash selection works without an applied graph. With no graph DNS context,
local name lookups use Windows' configured resolver; a failed DNS path can still
prevent the exit lookup from completing.
**Initialization → Automatic** also prepares recognized .NET, Go, Python, JVM and
Qt runtimes before launch. If another app keeps its old timezone, choose
**Before the app starts**, save, wait for preparation and completely quit and reopen
it. Repeat that restart after changing its zone, switching Off or upgrading Wayrill.
Selecting a shared executable such as `java.exe` or `python.exe` affects every app
using that executable. Wayrill supports x86, x64, and compatible AnyCPU applications
on x64 Windows. Native ARM64 apps are currently unsupported.
WebView2 content can follow its host's live setting. Apps with their own explicit
timezone handling or previously cached date formatters may still ignore an override.
The setting does not change server/account timezones or clocks in WSL, containers
or virtual machines.

## Privacy and limits

The extension passively observes requests; it does not redirect or block them.
It needs `webRequest` and host access to observe a page's cross-origin requests,
`webNavigation` to reset capture when back/forward navigation restores a cached
document without a new network request, `storage` to survive extension worker
suspension, and `nativeMessaging` to read Wayrill observations. There are no
content scripts, remote scripts, analytics,
uploads, or remote scripts. The optional Main-timezone lookup is performed by
Wayrill through the chosen outbound; the provider sees that outbound's exit IP,
not the page's browsing history. The manual timezone mode makes no lookup.

Capture retains hostnames, request types/counts/times, document identities and
bounded in-flight request IDs in `chrome.storage.session`. It never retains URL
paths, queries, headers, bodies or page content. Session data clears with the browser session, extension
reload/disable, or tab closure; navigation starts a fresh page capture. Incognito
is disabled. Up to 48 recent tabs and 128 domains per tab are retained; truncation
is displayed. A very recent batch can be lost if the worker is terminated before
its 250 ms session checkpoint.

The bridge includes its compiled extension version in its replies. Automatic
reload also requires this copy's local manifest to match that version and public
key. A separately extracted older copy is not overwritten, and an older bridge
remains usable without automatic reload. Setup never edits browser profiles,
approves extension permissions or restarts the browser.

The normal-user bridge accepts bounded `routes` lookups through the existing
authenticated service pipe, and `editDomain` requests that open the installed
desktop with a domain and optional filter IDs. The browser cannot select an
executable, edit the graph itself or activate routing. The bridge opens no HTTP
listener and exposes no arbitrary-command interface.
Chromium also accepts a `timezone` lookup of the applied Main outbound or a
versioned Stash reference, returning only its zone, exit IP, display name and
applied revision. Its Stash picker reads display names, types and stable IDs;
it receives no connection credentials or editable core configuration.

The implementation follows Chromium's [request observation API](https://developer.chrome.com/docs/extensions/reference/api/webRequest),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
and Microsoft's [Edge native messaging registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging).
