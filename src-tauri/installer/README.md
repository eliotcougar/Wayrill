# NSIS template

Vendored from [Tauri installer.nsi](https://github.com/tauri-apps/tauri/blob/587ae48f1a52f5d3ab213d791f71d33a2dd19259/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi), under its MIT license.

Wayrill changes the maintenance page to default to installation over existing files for upgrades and same-version reinstalls. The second option is Clean install, invoking the existing uninstaller first. Saved data is kept unless explicitly removed in the uninstaller. Passive/update runs preserve the existing installation. The upstream downgrade restriction is retained. Keep these changes focused when updating the template alongside the Tauri bundler.

The final service section updates the page heading before registering/starting the coordinator and waiting for routing resumption. Failures still abort with the Unicode diagnostic log; the finish page is reached only after service health is verified. Installation does not probe or warn about a loaded shared WinDivert driver. Runtime activation retains its ownership checks.

The Resource files page offers Original, Russian, Iranian and Chinese GeoIP/GeoSite sets. The successful bitmask is remembered in the machine registry; /RESOURCES=N can choose it for unattended installs. Existing unselected DATs remain. Missing unselected DATs are accepted only by in-place installation; external bundles retain complete hash validation. Russian full files use ru- names and older russian- files are migrated before service resumption.
