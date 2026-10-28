# Getting started

This guide takes you from installation to a working connection, then shows how
to capture apps that do not use a proxy. It describes **Wayrill 0.31.20**, the
current public beta for Windows 10 and 11 on x64.

Have a working server profile or subscription URL ready if you want to use a
remote proxy. You can also try the Direct examples using your existing Internet
connection. Wayrill does not supply servers or subscriptions.

## Install Wayrill

1. Download **Wayrill_0.31.20_x64-setup.exe** from the
   [beta release](https://github.com/eliotcougar/Wayrill/releases/tag/v0.31.20).
   Use the complete installer: it includes the desktop app, networking service
   and matching core components.
2. Run setup and approve the administrator prompt. The installer is unsigned,
   so Windows may display a publisher or reputation warning. The desktop itself
   runs under your normal Windows account.
3. Choose your resource files. **Original** is a reasonable starting choice;
   regional sets are useful for the corresponding routing presets. You can
   [manage resources](resources-defaults.md) later.
4. Open Wayrill. On a new workspace, the graph contains **Local proxy** connected
   to **Direct**. It is a starting configuration, not an active remote connection.

The desktop requires Microsoft Edge WebView2. Setup checks for the runtime and
provides its installation when needed.

If you already have a development build, export a [backup](backups.md), then use
**Install over existing version**. **Clean install** reinstalls the application
files; it does not mean “erase my configuration.” Removing saved user data is a
separate uninstaller choice.

## Import a profile or subscription

1. Click **Stash** on the main toolbar, or open
   **File → Configuration stash / import…**.
2. Choose **Import / add subscription**.
3. For a subscription, select **Subscription URL**, enter a group name and URL,
   and choose **Add & download**. For a share link or configuration text, select
   **Paste configurations** and use **Import into stash**. **Import file** is
   available in the Stash window for files.
4. Find the imported server under **Outbounds**. Run its delay test to check
   that the profile works on your network.

Subscription downloads can use **Direct connection** or **Running Wayrill proxy**.
The latter needs an already working Wayrill proxy; it cannot establish the first
connection on its own. If the subscription is blocked on your network, import
one working profile first or download the subscription separately and import it
from a file.

New URL subscriptions start with **Refresh automatically** and **Remove
unreachable servers** enabled. Review those choices before downloading; turn off
removal if you want to keep the full downloaded list while you investigate
connectivity. The
[Stash guide](stash.md) explains testing, protected entries and refresh behavior.

## Make your first proxy connection

The initial **Local proxy** accepts both HTTP and SOCKS on `127.0.0.1:10808`.
Its Direct outbound currently uses the normal upstream connection.

1. Close Stash, right-click **Direct** on the graph and choose
   **Replace → Select from Stash…**.
2. Select your working profile, then click **Replace** at the bottom of Stash.
   The connections stay attached to the replacement.
3. Click **Check**. Correct any errors. When only warnings remain, the results
   window enables **Validate**; use it to check the generated core configuration.
4. Close the results and click **Start**. Wait for routing to show **Running**.
5. Open **Settings → System traffic capture… → Windows proxy**. Choose
   **Per-user** scope, **Graph input** mode and the Local proxy inbound, then
   click **Set**.
6. Open a new page in a browser that uses Windows proxy settings. You can instead
   configure one app directly: HTTP or SOCKS proxy, address `127.0.0.1`, port
   `10808`.

Check/Validate verifies the configuration; it does not contact every server or
start routing. An outbound test checks the server path, while opening a page
through the configured app checks that the app is actually using it.

A proxy listener does not automatically capture every app. If a browser works
but another program does not follow the route, use TUN or configure that
program's own proxy settings.

## Capture this PC with TUN

TUN is useful when you want applications to follow the graph without setting a
proxy in each one. Wayrill creates and manages its own Windows adapter.

1. Finish the first connection above and keep the working profile in Stash.
   Back up any graph you want to keep, then press **Stop**.
2. Choose **File → Load Example → TUN → Direct**. Loading an example replaces
   the draft graph; it does not start capture. Undo is available.
3. Right-click Direct and replace it with your profile from Stash.
4. Open the TUN node. Start with **Automatic · current Windows route** for
   **Uplink**, or deliberately choose the physical adapter providing Internet
   access. The starter includes a connected DNS handler and real DNS server.
5. Run **Check → Validate**, then **Start**. Wait for **Running** and try a new
   connection from an app.

You do not need to enable Windows proxy settings for this TUN setup. Wayrill
manages the adapter, routes and configured adapter DNS through its service.
If another VPN or Windows Internet Connection Sharing is present, read
[Windows capture](capture.md) and [Internet sharing](sharing.md) before combining
them with this setup.

Start with one capture mechanism. Add Proxy, WinDivert or sharing paths when you
have a specific reason to use them together.

## Add routing rules and verify them

Once the basic connection works, add a **Routing filter** from **Rules & filters**
between the source's Data output and your outbounds. For example, send private
network addresses to Direct and use the proxy for Unmatched traffic. The
[traffic-rules guide](traffic-rules.md) walks through the editor.

Open the filter's **Traffic log** to see the destination, matched rule and chosen
output. Search for a site you just opened. The Direct starters do not contain a
filter, so they do not have a filter traffic log until you add one.

For ready-made demonstrations, see the [examples guide](examples.md). Examples
with remote servers use fictional profiles that you must replace.

## Understand Apply, Stop and Close

| Action | Result |
| --- | --- |
| Edit a node or open a graph | Change the draft. |
| Check, then Validate | Review the draft and generated configuration. |
| Start | Activate the draft while routing is stopped. |
| Apply | Activate changes to the running graph. |
| Restart | Restart the current configuration when the draft already matches. |
| Replace an outbound while routing runs | Switch that active route immediately, leaving unrelated draft edits unapplied. |
| Stop | End routing and restore Windows settings still owned by Wayrill. |
| Close the window | Hide the editor in the tray; routing continues. |
| File → Close Wayrill | Exit the editor; service-owned routing can continue. |

If you manually entered a proxy in another app, remove it there after stopping
Wayrill. An app cannot connect to a local proxy that is no longer listening.

The Windows controller service remains available while routing is stopped.
Windows Services showing it as Running does not mean that your graph is active;
use Wayrill's routing status to check that.

After verifying a working setup, **Settings → Startup…** can enable **Start
routing at boot before sign-in**. It uses the applied configuration. A Stop
cancels the current run; with this option enabled, the next Windows boot starts
a new run. [Back up](backups.md) the setup before making larger changes.

If something fails, use [Troubleshooting](troubleshooting.md) to distinguish a
server problem from capture, DNS or rule selection.
