# Windows traffic capture

Choose an entry point that matches the apps you want to route. A configured proxy
is sufficient for apps that use it. TUN captures host traffic without per-app
proxy setup. WinDivert is an alternative packet-capture mechanism. ICS TUN routes
a shared connection; it has a [separate setup guide](sharing.md).

Begin with one mechanism and verify it before combining sources. Multiple active
sources need deliberate paths, especially when other VPNs are installed.

## Use a local proxy

Add a **Proxy** inbound and choose SOCKS, HTTP or Mixed mode. Mixed accepts both
on the same port. The default local listener is `127.0.0.1:10808`.

Connect Data to your outbound or traffic filter. Connect DNS to a handler when
DNS reaching this proxy should use your DNS graph. Start routing, then point an
app at the listener or use the Windows proxy assignment below.

Listeners can use public addresses and ports from 1 to 65535. If other clients
will connect, choose the intended listen address, authentication and Windows
firewall access. A loopback listener accepts this PC only.

## Capture the host with TUN

Load **TUN → Direct** for a complete starter, or add **TUN adapter** from Local capture
and connect its Data and DNS paths. The default adapter name is **Wayrill-TUN**.

In the TUN editor:

- **Capture this PC · IPv4 + IPv6** supplies the dual-stack capture routes.
  **Capture IPv4 only** leaves IPv6 outside this capture scope.
- **Uplink** chooses the underlying Internet path. **Automatic · current Windows
  route** follows eligible Windows routing; choose a specific adapter when that
  choice is intentional.
- **DNS** must point into the captured scope if requests should reach the
  connected DNS handler. A loopback resolver can bypass it; see [DNS](dns.md).

Apply/Start creates or reuses Wayrill's adapter and installs its owned settings.
Stop removes those active settings and parks or removes the adapter according
to the management mode. Other VPN adapters are not Wayrill-owned resources.

Automatic uplink selection reconciles network changes. An explicitly named
adapter is not silently replaced by an unrelated interface when it disappears.
Use Run graph and Application logs to inspect waiting or recovery states after
a Wi-Fi or adapter change.

### Retain or remove adapters

Open **Settings → TUN adapters…**. **Keep and reuse** disables retained adapters
on Stop and enables them on the next start. **Disposable** removes used adapters
when routing stops. Stop routing before changing this mode.

The same window lists Wayrill-owned adapters and offers removal when safe,
including an unused adapter whose node was deleted from the graph. Renaming a
TUN node changes its adapter name while preserving the owned adapter identity
when reuse is possible. Read a startup error before deleting adapters as a
general repair: deletion also removes evidence needed to diagnose it.

### Other VPNs and Direct

A Direct outbound uses an upstream interface; inspect the interface shown on its
card or select one explicitly in **Network Interface**. “Direct” does not prove
that another VPN's Windows routes are bypassed.

For a VPN carried inside Wayrill, the outer Xray connection must keep a working
upstream path rather than entering its own TUN again. Check both applications'
routes and interface choices. The beta's coverage of VPN combinations is limited.
TUN ICMP echo uses the direct upstream, so Windows ping does not measure the
selected proxy's latency. Use [outbound tests](testing-statistics.md) for that.

### Windows NAT sessions

If Windows NAT is carrying traffic from a VM, **Separate Windows NAT traffic**
adds **NAT Data** and **NAT DNS** outputs to the host TUN. Connect them to the
intended guest paths, for example Direct for guest data, instead of relying on
the host application's process rules to distinguish translated sessions. This
requires sessions the Windows NAT integration can identify; it does not add
per-client identification to ICS sharing.

## Use WinDivert

Load **WinDivert → Direct**, or add WinDivert from Local capture and connect Data
and DNS. Open **Settings → System traffic capture… → WinDivert** to select the
monitored adapters. Use Refresh adapters, Select active adapters or Clear
selection as needed, then apply the graph's capture settings.

Wayrill's TUN and ICS TUN adapters cannot be monitored by WinDivert. Capturing them
would risk recapturing traffic already handled by Wayrill. Existing capture use
by another app is checked before activation. Resolve a reported conflict before
starting both clients; installing Wayrill does not authorize unloading their
shared driver.

The WinDivert panel has explicit capture and driver controls. Install/uninstall
affects Wayrill's driver registration, not every application using WinDivert.
If Windows security software blocks the driver, inspect its recorded reason.

## Assign Windows proxy settings

Open **Settings → System traffic capture…**. These panels change Windows settings
immediately; they do not wait for graph Apply. For a Graph input assignment,
start the graph first and choose an active compatible Proxy inbound.

| Panel | Choose it for |
| --- | --- |
| **Windows proxy** | Apps using the Windows default LAN proxy, PAC or automatic discovery. Scope can be Per-user or Machine-wide · all users. |
| **Environment** | Programs reading `http_proxy`, `https_proxy`, `ftp_proxy`, `all_proxy` and `no_proxy`. Choose This user or System. |
| **WinHTTP** | Programs using WinHTTP settings. Legacy machine, Machine · advanced and This user · advanced are separate channels. |

**Set** installs the chosen assignment. **Clear** clears the selected channel's
settings. **Restore previous** restores the prior assignment that Wayrill still
owns. None is a universal “remove every proxy from Windows” action. Switching
Windows proxy scope restores the previous Wayrill assignment before changing
the scope. A machine-wide scope applies to all users, so review that choice when
other accounts use the PC.

Another app can change these settings. If Wayrill reports External changes,
review the current values and its restore/keep choices. Stop restores settings
only where ownership still matches; it preserves unrelated edits.

### Environment variables need a new process environment

Existing apps do not receive a new environment merely because a variable was
saved. The panel provides commands for an immediate terminal session. Launch the
target program from that session, or sign out and back in before testing the
persistent user values. Services may need a restart to read system values.
User variables can override system variables; check both scopes if clearing one
appears ineffective. `socks5h` lets the proxy resolve names; `socks5` requests
local resolution in clients that follow that convention.

### Inspect WinHTTP by channel

Start with **Legacy machine** when investigating an ordinary machine-wide
WinHTTP proxy. An advanced user channel can be Off while the legacy channel
still contains a proxy. Clear the channel that actually holds the assignment.
On supported Windows versions, advanced channels also expose automatic settings.

Use the panel's diagnostics when a state is unfamiliar. Include the selected
channel and raw diagnostics in a report; localized command output alone should
not be interpreted as proof that another scope is off.

## Loopback permissions and app protection

In **Loopback**, select the packaged Windows apps that need AppContainer
permission to reach a local proxy, then choose **Apply permissions**. Search and
selection prepare a change; Apply commits it. These permissions are system-wide
and remain after routing stops. They are separate from the routing rule that
keeps `127.0.0.0/8` and IPv6 loopback local, subject to explicit Block rules.

In **App protection**, select exact executable paths or AppContainer packages to
block during routing restarts and installation over an existing version. Include
networking helpers if they are separate processes. The barrier is released after
successful routing recovery; explicit Stop releases it. This protects transitions,
not every possible period of direct connectivity.

If an interrupted update leaves selected apps blocked, finish installation or
start the service and explicitly Stop. Collect [diagnostics](troubleshooting.md)
before changing unrelated firewall rules.
