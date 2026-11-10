# Experimental native application timezone override

The Chromium Companion is a controller for a service-owned browser preference.
It requests no debugger permission and sends no DevTools commands. Firefox's
independently signed package is unchanged and does not expose these controls.

## Responsibilities

- The popup chooses Off, Manual, Main outbound or a saved Stash definition.
  Main/Custom reuse the existing isolated outbound exit-IP probe. A failed probe
  preserves the previous policy; no traffic-path or DNS setting is changed.
- The service stores application policies in protected `browser-timezones.json`,
  independently of routing. A single serialized store validates revisions and
  commits the file atomically before publishing an immutable policy snapshot.
  Reads and reconciliation reuse that snapshot; edits never hold the process
  inventory lock during disk I/O. The file is service-owned and loaded on service
  startup, rather than a file-watching configuration interface. The browser image path,
  PID creation time and owner SID are checked against Windows, not accepted as
  proof merely because the extension supplied them.
- The attribution helper provides a cached, owner-scoped process inventory and
  detects installed browsers independently of Companion registration. The service
  supervises saved executable and package policies even while routing is stopped.
- One reconciliation actor owns native operations, retries and process-lifetime
  caches. Each pass reconciles startup registrations first, then live processes,
  and publishes their statuses together. Native work holds neither the intent
  store nor UI snapshot lock. Startup zone resolution is shared within a pass,
  so multiple images using one zone do not each launch a resolver helper.
  Enabled policies keep watching for new processes. With every policy Off,
  discovery can stop after surviving processes are reconciled and the editor's
  inventory lease expires. The next edit, service restart or editor visit
  requests the required discovery again.
- The native host discovers its own browser from OS ancestry. It persists policy
  through authenticated IPC; it no longer performs native application itself.
  The service starts the fixed timezone adapter as a restricted owner token in
  the target desktop session. PID, creation time, image and owner are rechecked.
  DLL paths always come from the installed hash-named asset, never an API request.
- The Rust DLL intercepts native timezone getters, GetLocalTime, default UTC/local
  conversions and file-time conversions. Null/default zone arguments use the
  selected zone; explicit zone arguments retain their original meaning. Its
  read-only registry view covers only the current Windows timezone key, including
  already-open handles. The installed zone catalogue and all writes stay native.
  Live Chromium
  overrides load it in the browser's main process. Microsoft Detours provides
  transactional entry-point replacement.
  Windows timezone notifications let Chromium update its own ICU/V8 clients,
  including renderers, workers and iframes. Live updates leave protected
  subprocesses to Chromium's notification mechanism. Firefox and Node/Electron
  use the startup path described below. Sandbox and mitigation settings remain
  unchanged.

## Lifecycle

Persist desired policy first, then apply it. A failed live apply remains a
visible error and a retryable saved preference, rather than silently becoming
Off. The in-process policy rejects older revisions, so a delayed native host
cannot undo a newer choice. Browser installations have separate identities;
numeric version folders are ignored so ordinary browser updates keep the choice.

The DLL remains loaded until browser exit. For live overrides, Off selects the original APIs rather
than detaching callbacks while other threads might still execute them. UTC and
the system timezone are unchanged. Routing/service/desktop restarts do not unload
the application's override. A service-owned actor uses the existing attribution
executable to discover owner processes, reapplies settings on new launches and
retries native failures. It runs independently of the routing kernel. Removing a
target retains a hidden Off record so service recovery can restore surviving apps.
Explicit executable policies take precedence over package-wide policies.
Removing an executable override resumes an active package policy. Hidden Off
records exist only to clean up hooks when there is no remaining active policy.
Package policies apply to executables inside the package's installation directory;
Windows brokers carrying its identity are excluded. Setup grants AppContainer
read/execute access to the public override DLL, without granting writes or access
to protected settings. Startup registrations reconcile independently of discovery,
so a failed attribution helper cannot prevent disabling Firefox's override.
Companion is an optional controller and confirmation surface. Its alarm keeps
its displayed state synchronized; it is not required to apply the policy.
Native application is idempotent at an
unchanged revision. An in-flight hook installation rejects concurrent retries
instead of retaining additional waiting threads in the browser.
Only an explicit Apply reloads web tabs.

Tools > Timezone spoofing lists detected browsers and configured applications.
Users may add a local executable, running application or installed package, and
choose Off, Manual, Main outbound or a saved Stash outbound. Main/Custom resolve
on Save; the resolved zone persists through routing restarts. Writes compare the
displayed revision, so a background refresh cannot authorize stale edits.

Chromium child roles are identified from cached process metadata, including
Electron executables with application-specific names. Sandboxed renderers and
services receive the browser process's update rather than separate injection;
unsandboxed utility code remains managed for its own native API calls and Off
cleanup. A WebView2 browser process can inherit its verified host's
policy, with matching owner and desktop session. Explicit engine settings take
precedence; removing them resumes inheritance. The proven host identity remains
associated with that engine generation until exit, including for Off cleanup.
Arbitrary child applications and Wayrill's own embedded views do not inherit
native policy selection. A Node/Electron process's `TZ` can be inherited through
the normal child environment, as described below.
After activation, the supervisor repeats platform notifications over a bounded
settling phase, covering windows and timezone monitors created asynchronously.
It then stops refreshing until that application's effective policy changes;
editing a different app does not restart this phase.

Versioned installation directories, including Squirrel's `app-<version>` layout,
share an application identity. Older saved keys are normalized from their paths;
if several versions had separate settings, the latest revision wins, including
a later Off or removal.

Chromium's timezone monitor initializes asynchronously. A notification delivered
before its initial platform-zone reply can be consumed without updating clients.
The Companion checks its observed worker timezone and retries notifications with
a bounded deadline. It reports failure if the browser never confirms the change.
For live Chromium only, the legacy getter leaves its optional localized StandardName
empty for a synthetic override. Native and startup-initialized applications retain
the localized names used by their runtimes. Chromium re-detects the dynamic timezone on notification even
if its initial name query raced activation. The dynamic getter retains the full
Windows key, localized names and transition rules. No temporary switch to the
system zone is needed to invalidate the cache.

## Native boundary and packaging

The helper and DLL are Rust, using Windows APIs through `windows-sys`. The pinned
Microsoft Detours library remains third-party C++. Its allocation symbols use a
private heap: enrolling threads suspends them, and allocating through a heap lock
held by a suspended browser thread could deadlock. Rust allocations needed for
the transaction are prepared before suspending threads.

`tools/Build-Timezone.ps1` downloads and verifies the pinned source, builds Detours,
then builds the Rust component with the service's static-CRT settings. The DLL's
hash forms its installed filename, so an upgrade can install a new binary while
an existing browser still maps the old one. Compatible loaded versions are reused
until browser exit. The helper accepts its installed asset directory and the
protected System32 startup-provider location. Fully quit and reopen selected apps
after an upgrade to pick up newly added native hooks. The
service package manifest covers the helper, asset descriptor, DLL and license.

Firefox, Node.js and recognized cached runtimes use an Application Verifier provider
at process startup, before their runtimes cache the timezone. Automatic detection
also recognizes managed .NET images, common .NET apphosts, Microsoft's single-file
bundle marker, Go build metadata and Python, JVM and Qt imports. Detection reads PE metadata without executing the image;
it is a compatibility heuristic, not a universal runtime classifier. The user can
choose **Before the app starts** for an unrecognized application. AnyCPU images
without Required32Bit or Preferred32Bit are supported on x64 Windows. The service registers only the selected
executable's full path, publishes its native Windows zone and registration in
one registry transaction, and removes its owned registration when switched Off
or uninstalled. Other verifier/debugger settings are preserved. Changes require
restarting the application. The immutable provider resides in System32, as required by
the verifier loader; it reads the current user's application policy and does
nothing for users without one. No timezone lookup or library loading occurs
inside the loader callback. This provider interface is experimental rather than
a documented general-purpose application extension contract.

Node/Electron detection reads the PE export table for Node's addon ABI; it never
loads or executes the selected image. It also recognizes a Chromium launcher
with the Node ABI in its adjacent `chrome.dll`, without classifying other
executables in that directory as Node applications. The provider sets the process-local IANA
`TZ` variable before Node initializes ICU/V8. Node workers and utility processes
inherit the environment normally. This uses neither `NODE_OPTIONS` (restricted
in packaged Electron applications), an inspector port nor a private V8 API.
See [Node's TZ contract](https://nodejs.org/api/cli.html#tz) and
[Electron's environment-variable restrictions](https://www.electronjs.org/docs/latest/api/environment-variables#node_options).
Native getters, conversions and default-registry reads remain intercepted for
other code in the selected image. Other runtime families receive no environment
variable changes. Their native initialization sees a complete Windows zone,
including names and transition rules.
Registrations identify exact executable paths; policy identity still spans
version directories. Verified package membership is retained with the owned
registration so Off/removal can reconcile it after a service restart, even with
no running app. Newly observed package executables and updated version paths
are prepared separately and may require one discovery launch followed by a restart.

Native checks use `tools/Check-Native.ps1 -Component service`; ordinary test runs
do not inject into a workstation browser. Live compatibility checks belong in a
disposable Windows VM.

## Limits

This currently targets x64 and compatible AnyCPU Windows applications. Native x86
and ARM64 applications require matching helper/provider binaries and are not
supported by the current package. Protected processes,
apps that use explicit zones and app-specific caches may not follow an override.
Package selection is not a way around AppContainer or code-integrity restrictions.
Node startup initialization does not invalidate a runtime that was already
running, and an app can replace `TZ` or use an explicitly selected zone itself.
Switching Off removes the owned startup registration; existing processes need
a complete exit and relaunch from outside the app to discard their inherited
environment and caches. WebView2 applications sharing a user-data folder also share
its browser process, so they cannot be treated as independent timezone contexts.
Firefox currently uses startup interception: applying the runtime hook to its
main process does not update page and worker timezones, and loading the DLL into
a running content process can fail. A failed load alone does not establish which
sandbox or code-integrity restriction caused it. The startup provider reads the
saved policy when each process starts, so this implementation requires a complete
browser restart after changes, including switching Off. This is a limitation of
the current integration, not a claim that Firefox cannot support live changes.

Default-zone compatibility has several separate boundaries:

- .NET, Go, Python/CRT, JVM and Qt can cache their default zone. Startup preparation
  addresses initialization; it does not rewrite objects already cached by a running
  runtime. Java's explicit `user.timezone`, explicit timezone objects and an app's
  own `TZ` choice remain authoritative.
- A shared executable such as `java.exe`, `python.exe` or `dotnet.exe` is one
  application target. Independent scripts or assemblies using that same executable
  cannot have different policies through an executable-path setting.
- External brokers, Windows services, WSL, containers and virtual machines have
  separate execution contexts. They do not inherit a selected Windows app's native
  API view. Server/account-defined zones and intentional UTC displays are also
  independent of the Windows default.
- CEF/QtWebEngine and embedded ICU engines may cache their own zone. Startup is
  available when live notifications are insufficient; this does not imply coverage
  of every embedding or protected renderer.
- Windows Runtime Calendar consumers can use startup preparation. Dart/Flutter's
  Windows implementation also uses the default-year and UTC/local conversion APIs
  intercepted here. Native-library coverage is distinct from verifying every
  framework's application-level caches.

See [.NET cache semantics](https://learn.microsoft.com/en-us/dotnet/api/system.timezoneinfo.clearcacheddata),
[Go's Windows initialization](https://go.dev/src/time/zoneinfo_windows.go),
[Java's default-zone precedence](https://docs.oracle.com/en/java/javase/24/docs/api/java.base/java/util/TimeZone.html#getDefault()),
[Qt's Windows registry lookup](https://code.qt.io/cgit/qt/qtbase.git/tree/src/corelib/time/qtimezoneprivate_win.cpp),
and [Windows' default conversion contract](https://learn.microsoft.com/en-us/windows/win32/api/timezoneapi/nf-timezoneapi-systemtimetotzspecificlocaltime).
The [Dart Windows runtime](https://github.com/dart-lang/sdk/blob/main/runtime/vm/os_win.cc)
and Rust's [time crate](https://github.com/time-rs/time/blob/main/time/src/sys/local_offset_at/windows.rs)
illustrate default conversion consumers; Rust's standard UTC/monotonic clocks
are intentionally unchanged.

Some IANA zones share one Windows
zone. The Companion confirms current and seasonal wall-clock rules and displays
the actual browser zone name. A page may execute before startup restoration, and
already-created formatters may retain their old timezone. There is no claim of
first-script protection or universal fingerprint resistance. Browser sandbox
changes, IFEO debugger registration and all-process injection are not used.
