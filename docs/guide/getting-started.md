# Getting started

## Install

Use the complete x64 installer from Releases when available. It installs the
desktop and matching service under Program Files. Administrator approval is
needed for system work; the desktop runs as your account. WebView2 is required.
Copying only the desktop executable does not install networking components.

Install over existing version is the normal update mode. Clean install replaces
app files; data remains unless explicitly removed in the uninstaller. Choose
Original, Russian, Iranian and/or Chinese resources; setup remembers the choice.

## First connection

New workspaces contain Mixed proxy 127.0.0.1:10808 connected to Direct. Import
your profiles/subscription into Stash and right-click the outbound to replace it.
Add filters or load an [example](examples.md) as needed.

Use Check, then Validate in its results. Start activates the draft. Point apps
at the proxy, select Windows proxy through System traffic capture, or use a
[local capture source](capture.md). A Proxy input alone captures neither every
app nor Windows DNS; not all apps obey Windows proxy settings.

## Apply, stop and close

Edits change the draft. Apply activates them; Restart restarts an unchanged
draft. Check/Validate do not start routing. Runtime names the applied revision.

Stop deliberately ends routing and restores owned settings where safe. Window
Close hides the editor in the tray. File → Close Wayrill and tray Close exit the
editor; service-owned routing may continue. Tray Start uses the last applied
configuration, not graph drafts.

Startup settings offer routing with Windows before sign-in. Enable it after
validating the applied setup. Appearance chooses light/dark/system theme.
Keep a [backup](backups.md); inspect [diagnostics](troubleshooting.md) before
deleting adapters to repair a failure.
