# Troubleshooting

Start with the smallest failing case: one app, one destination and the route you
expected it to use. Avoid changing capture, DNS and server settings together;
you otherwise lose the information needed to tell which change helped.

## Find the failing part of the path

| Symptom | First check |
| --- | --- |
| No routing starts | Read Check/Validate and the current error in Service → Run graph…. Confirm the complete matching service is installed. |
| An outbound test fails | Try a known working profile and inspect the selected test URL. The server or the test endpoint may be unreachable. |
| Outbound tests pass, but an app fails | Confirm that the app enters the graph through the intended proxy or capture source. Inspect DNS and the filter Traffic log. |
| A destination appears on the wrong output | Inspect rule order, the matched rule and any domain/IP/application alternatives. |
| A destination never appears in the filter log | Reset log filters; check whether traffic reaches this filter at all. DNS, capture or process attribution may fail earlier. |
| Existing connections work, new ones fail | Test a fresh connection and inspect DNS/attribution logs. A still-open connection does not prove that new connections can be created. |
| Direct reports an unexpected exit IP | Inspect its resolved interface and other VPN routes; choose the intended interface explicitly if needed. |

Check finds graph problems, Validate checks the generated configuration, outbound
tests exercise a server path, and a real app request checks capture plus routing.
A Windows “Internet available” indicator is not a substitute for these checks.

## TUN is running, but sites do not open

1. Open the TUN node and verify its **Uplink**. A named adapter must exist and
   provide the intended upstream. Check Direct's interface as well.
2. Confirm Data reaches a usable outbound or Traffic filter. A disabled source
   keeps its links visually but does not capture traffic.
3. Follow DNS from the adapter setting to its handler, selected DNS server group
   and Query traffic route. A loopback resolver can bypass the handler; a DoH
   hostname may need bootstrap. See [DNS](dns.md).
4. Reset the filter's Traffic log filters and try a fresh request. If no row
   appears, inspect Application logs for capture and attribution messages.
5. Check other proxy/VPN settings. Start with one capture mechanism before
   investigating a combined setup.

If Windows ICS is enabled, use the [sharing workflow](sharing.md); repeatedly
changing the native pair while Wayrill is handling it can create a real conflict.
If startup reports an existing adapter or ownership problem, collect logs before
deleting devices. **Settings → TUN adapters…** manages safely removable owned
adapters, including ones no longer present on the graph.

## An application rule does not work

Check the exact executable path and whether a separate child/helper performs
networking. A launcher and its network process can be different files. Enable
child-process matching where appropriate and verify the process is observable.
Services and packaged apps have their own selectors.

Ambiguous TUN ownership is a separate policy, with Block as the default. Allowing
it sends the connection to the configured ambiguity route; it does not make a
process-specific rule match an unknown process. Remote proxy clients and ICS
clients do not have local process identities.

When an app works after disabling its process rule, record the failing time and
save logs with that rule enabled. If the connection never reached the Traffic
log, a wrong output is not yet established as the cause.

## A resource, subscription or Windows setting looks wrong

- **Missing GeoSite/GeoIP group:** verify the selected default file or explicit
  `ext:` file. Inspect update warnings. A rule emptied by missing positive
  entries is skipped/disabled, so later rules or fallback may now be used.
- **A refreshed subscription lost candidates:** inspect the name filter,
  Remove unreachable servers results and the group's fallback. Explicit uses
  and locks are protected differently from filtered membership.
- **WinHTTP appears Off, but a proxy remains:** inspect Legacy machine and both
  advanced channels. Clear acts on the selected channel only. Save its raw
  diagnostics for unfamiliar output.
- **Environment proxy changes do not take effect:** check both user and system
  scopes, then launch the app with an updated environment. Existing processes
  can retain older values.
- **Windows settings show External changes:** review the current values and
  restore/keep choices. Wayrill deliberately preserves settings it no longer
  owns. See [Windows capture](capture.md).

## Read and export application logs

Open **Help → Application logs…**. **Sources** and **Levels** are checkbox
filters, each with **All** at the top. Reset filters when you need the full view.
The window updates while open; Pause freezes the display while collection
continues. Resume shows the latest retained entries from the bounded history.

Xray messages are collected by the networking service and sharing components;
look here rather than searching for a separate `xray.log` beside the executable.
The default core log level is warning. For a specific investigation, change
**Settings → Global defaults… → Core, routing & policy → Core log level**, save
and Apply. Restore a quieter level afterward if detailed logs are no longer
needed.

**Open folder** opens the relevant component's log directory. **Save diagnostics…**
exports retained history matching the selected sources and levels. For a full
report, select All in both filters first. Folder access and diagnostics export
are available even when the service connection is unavailable.

| Component | Windows folder |
| --- | --- |
| Desktop | `%LOCALAPPDATA%\app.wayrill.desktop\Logs` |
| Networking service and sharing | `%ProgramData%\Wayrill\Logs` |

Logs rotate, and the installation owner can read the service logs. Protected
profiles remain restricted. Logs and exported configuration are different:
a diagnostic export is not a backup of your graph.

## Report a useful problem

Include the Wayrill/core versions, Windows version, approximate failure time,
capture mode and reproduction steps. Explain the intended route and what the
Traffic log showed instead. For lifecycle failures, say whether they followed
Apply, Stop, an update, reboot, sleep or an uplink change, and whether ICS was
enabled.

Export logs near the failure before older entries rotate out. A minimal sanitized
graph helps when the issue depends on topology. Review attachments for passwords,
private keys, subscription tokens, paths and destinations; graph exports can
contain credentials. Log masking is configurable and is not a guarantee that an
attachment is safe to publish.

Use [GitHub issues](https://github.com/eliotcougar/Wayrill/issues/new/choose) for
ordinary reports and the [security reporting process](../../SECURITY.md) for
security vulnerabilities.
