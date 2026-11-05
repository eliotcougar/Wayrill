# NSIS template

Vendored from [Tauri installer.nsi](https://github.com/tauri-apps/tauri/blob/587ae48f1a52f5d3ab213d791f71d33a2dd19259/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi), under its MIT license.

Wayrill changes the maintenance page to default to installation over existing files for upgrades and same-version reinstalls. The second option is Clean install, invoking the existing uninstaller first. Saved data is kept unless explicitly removed in the uninstaller. Passive/update runs preserve the existing installation. The upstream downgrade restriction is retained. Keep these changes focused when updating the template alongside the Tauri bundler.

The final service section updates the page heading before registering/starting the coordinator and waiting for routing resumption. Failures still abort with the Unicode diagnostic log; the finish page is reached only after service health is verified. Installation does not probe or warn about a loaded shared WinDivert driver. Runtime activation retains its ownership checks.

The Resource files page offers Original, Russian, Iranian and Chinese GeoIP/GeoSite sets. The successful bitmask is remembered in the machine registry; /RESOURCES=N can choose it for unattended installs. Existing unselected DATs remain. Missing unselected DATs are accepted only by in-place installation; external bundles retain complete hash validation. Russian full files use ru- names and older russian- files are migrated before service resumption.

The bundle also includes Wayrill Aquifer under `Aquifer/`. Both install and uninstall check only the installed Aquifer executable for write availability before touching the main application or networking service. A locked image produces Retry/Cancel (or a nonzero unattended exit), rather than killing a process or losing an unsaved server draft. No unrelated portable copy is inspected. The Aquifer Start-menu shortcut follows the selected folder and /NS preference, and is removed only when its target belongs to this installation. Its user settings and remote server jobs are not deleted by uninstalling the Windows bundle.

Setup installs Aquifer without launching it, including on upgrades. The finish-page Run option and unattended /R option continue to apply only to the main Wayrill application. Aquifer opens only through an explicit shortcut, executable launch or File-menu command.
