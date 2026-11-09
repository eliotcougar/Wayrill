# Companion timezone prototype

This experiment adds an opt-in timezone override to the Chromium Companion.
It does not change the Windows timezone, browser language, geolocation permission
or Wayrill's active routes. Firefox's signed package is unchanged.

## Using the prototype

Open an ordinary HTTP(S) tab, open the Companion and expand **Timezone override**.
Choose **Manual** with the timezone dropdown, **Main outbound**, or
**Custom outbound** with a saved Stash server, chain or policy group.
**Apply and reload web tabs** reloads regular web tabs
with the native override enabled. **Off** detaches the debuggers and reloads
those tabs with the system zone. The default is Off; incognito and internal
browser pages are excluded. The control is marked **Experimental** in the
regular Companion UI.

One zone applies to the browser session. Chromium shares some renderer/worker
processes, so the prototype deliberately does not offer per-tab zones. Newly
opened web tabs are attached and reloaded too; their first navigation can briefly
run before attachment. This is not a guarantee against every first-read race.

Main uses the applied graph's Main definition, not an unrelated editor draft.
An isolated outbound probe requests `https://ipwho.is/` through that definition
and reads the returned IANA timezone. It reuses the existing probe isolation,
upstream binding and policy-selection logic. The browser receives only the zone,
exit IP, display name, outbound tag and applied revision. It cannot supply a
configuration, endpoint or arbitrary service method. Custom references use the
service-owned Stash version and existing isolated test planner in a restricted
helper. A changed applied revision or Stash version
invalidates the lookup. Failure preserves a previously enabled override.

Routing restarts do not own browser emulation. The chosen zone is saved locally
and restored after extension/browser reload without contacting the service.

This is a snapshot when Apply is pressed. Apply again after changing Main.
Policy groups can select a different exit later; other routing rules may send
individual requests elsewhere. IP geolocation is an estimate, not proof of the
server's physical location. The external lookup receives the selected exit IP.

## Native browser behavior

The extension uses `chrome.debugger` and `Emulation.setTimezoneOverride`, not
injected replacements for `Date` or `Intl`. Chromium displays its debugging
banner while attached. Canceling or dismissing that banner stops the override;
the extension records the detachment and does not silently attach again.
Opening DevTools can also detach the extension. No suppression flags are used.

Child targets are configured recursively, with bounded commands and an
unconditional resume on failure. Service workers must be resumed before their
Emulation command: waiting for that command while startup is paused stalls
registration. This means the prototype does not promise a race-free timezone
read at every service worker's first instruction. Existing workers and contexts
which cached their zone before enabling the feature are another limitation.

The VM checks exercise page scripts, blank/same-origin/cross-origin/sandboxed
frames, classic/module/blob/shared/service workers, winter/summer offsets,
explicit UTC formatting, disabling and additional same-origin tabs. Passing those
cases is not a general fingerprinting guarantee. Chromium can share renderer or
worker processes, which is why the feature uses one browser-wide zone. Cross-tab
shared-worker lifetimes still need further investigation before a production rollout.

## Building

Build the native service and Companion, then package the Chromium extension:

```powershell
node tools/Build-CompanionExtension.mjs --browser chromium --output <private-output-directory>
```

The manifest requests the `debugger` permission; the experimental control is opt-in.
The package requires Chromium 144 or newer. Flattened sessions exist from 125,
but older Chromium builds had a renderer crash when timezone emulation was sent
to a worker. This floor includes the upstream worker-safety fix; runtime coverage
is currently Chrome 156.
Chromium uses its own background entry point and additive popup fragment/styles.
Firefox keeps the shared observation UI and its independent signed release
version from `extensions/signed/firefox.json`. The signed-source consistency
guard remains enabled: every shared Firefox source must still match the XPI.
Chromium-only features therefore do not require changing that signed package.
