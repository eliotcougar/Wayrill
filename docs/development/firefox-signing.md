# Firefox Companion signing

The Chromium and Firefox packages share the request-observation JavaScript, HTML
and CSS. Chromium adds a separate background entry point and popup fragment for
its experimental native timezone override. Those files and its restoration-alarm
permission are excluded from Firefox. Neither package requests debugger access.
`tools/Build-CompanionExtension.mjs` generates Firefox's module event page,
stable Gecko ID, minimum Firefox version, data-transmission declaration and
independent release version from `extensions/signed/firefox.json`. No bundler,
minifier, transpiler or third-party JavaScript library is used in the extension.

## Build and validate

From the repository root with the normal Node prerequisites:

```powershell
npm ci
npm run check
npm run test:companion
node tools/Build-CompanionExtension.mjs --browser firefox
npx --yes --package=web-ext@10.8.0 web-ext lint --source-dir .tools/companion-extensions/firefox --warnings-as-errors
npx --yes --package=web-ext@10.8.0 web-ext build --source-dir .tools/companion-extensions/firefox --artifacts-dir .tools/firefox-artifacts
```

Only the contents of the generated Firefox extension directory belong in the
Mozilla upload ZIP, with `manifest.json` at its root. Do not upload the standalone
Windows bridge package, app installer, test profiles or private QA files as the
extension. The JavaScript is already readable. Provide a source-code archive
containing `extensions/companion/`, `tools/Build-CompanionExtension.mjs`, `LICENSE`
`extensions/signed/firefox.json` and the Node command above, so Mozilla can
reproduce the generated manifest.

The stable signing ID is `wayrill-companion@eliotcougar.github.io`. Keep this ID
when submitting updates: Firefox and the Windows native-host allowlist use it to
identify the same add-on. Increment the Firefox release metadata version for
every submitted update. Do not place AMO credentials or API secrets in source.

## Submit

In Mozilla's [Developer Hub](https://addons.mozilla.org/developers/), submit the
generated ZIP. Choose **On your own**: Wayrill bundles the signed add-on rather
than publishing a public AMO listing. Target desktop Firefox, not Android; the
extension requires the Wayrill Windows app and native bridge.

The native connection carries destination hostnames to the local app. Under
Mozilla's taxonomy this is `browsingActivity`, even though no remote upload takes
place. Keep the declaration accurate and include the
[privacy text](../guide/companion-privacy.md) and native-app requirement in the
submission. The native bridge source is in `service/companion/`; it accepts
bounded route lookups and requests to open the local rule editor, not arbitrary
commands or privileged service calls.

Download the Mozilla-signed XPI after signing and distribute that file. The
unsigned ZIP cannot be installed permanently in normal Firefox. Self-distributed
updates need a separately signed XPI and an explicit update-distribution plan;
updating the Windows app does not replace files inside a signed Firefox add-on.
Do not add an update URL until that endpoint actually exists and is maintained.

The small signed redistributable is committed at `extensions/signed/firefox.xpi`,
with its signing provenance and SHA-256 in `extensions/signed/firefox.json`.
Builds use this copy without depending on AMO download access or credentials.
Replace both files after signing an update. Packaging
checks its hash, identity and every non-signature file against the generated
Firefox source, then bundles it as `Service/companion-firefox.xpi`. Changes to
shared runtime files require a newly signed XPI before building an installer.

## Check the installed experience

Use a disposable Windows environment with a matching Wayrill build. Enable the
bridge in **Tools > Browser Companion**, install the signed XPI through
Firefox's Add-ons Manager, and grant its requested permissions. A developer can
load the generated manifest temporarily through `about:debugging` before signing.

Verify real request capture, subframes, navigation, and native route lookups.
Check **Add to rule** both with Wayrill open and with only its service running.
Closing the popup and Firefox must leave the desktop app alive. Firefox owns a
native-host job that kills its children on disconnect; the bridge uses Firefox's
documented Windows breakaway behavior only for a Firefox caller. Chromium keeps
the existing launch behavior.

Recheck Chromium registration, existing custom IDs, Firefox's separate
`allowed_extensions` list, repair, rollback and disconnect. Registration is
transactional and per-user; never replace unrelated native hosts or browser
profiles. The app does not enable private browsing capture.

References: [submission](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/),
[native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging),
[Windows job behavior](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#app_persistence).
