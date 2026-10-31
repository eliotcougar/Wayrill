param([string]$OutputDirectory, [switch]$SkipChecks)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskProject '.tools/companion' }
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $SkipChecks) {
    Push-Location $taskProject
    try {
        & npm run check:companion
        if ($LASTEXITCODE) { throw 'Companion type check failed.' }
        & npm run test:companion
        if ($LASTEXITCODE) { throw 'Companion browser contracts failed.' }
        & (Join-Path $PSScriptRoot 'Check-Native.ps1') -Component service
    } finally { Pop-Location }
}
$taskPreviousFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = ($env:RUSTFLAGS + ' -C target-feature=+crt-static').Trim()
    & cargo build --manifest-path (Join-Path $taskProject 'service/Cargo.toml') --locked --release -p wayrill-companion
    if ($LASTEXITCODE) { throw 'Companion host build failed.' }
} finally { $env:RUSTFLAGS = $taskPreviousFlags }
$taskExtension = Join-Path $taskOutput 'extension'
New-Item -ItemType Directory -Path $taskExtension -Force | Out-Null
foreach ($taskFile in @('manifest.json', 'background.js', 'capture.js', 'native.js', 'popup.js', 'popup.html', 'popup.css', 'mark.svg', 'icon.png')) {
    Copy-Item -LiteralPath (Join-Path $taskProject "extensions/companion/$taskFile") -Destination $taskExtension -Force
}
Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/wayrill-companion.exe') -Destination $taskOutput -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Register-Companion.ps1') -Destination $taskOutput -Force
Copy-Item -LiteralPath (Join-Path $taskProject 'service/scripts/Companion-Setup.ps1') -Destination $taskOutput -Force
$taskReadme = @'
# Wayrill Companion 0.2.0 preview

Requires Windows and a matching Wayrill build that supports `companion.routes`.
This package does not install or upgrade the Wayrill networking service.

The installed app includes these files. Prefer Settings > Browser Companion to
enable/repair or disconnect the shared native bridge and open the extension manager.

Standalone setup:
1. Open chrome://extensions, edge://extensions or opera://extensions and enable Developer mode.
2. Choose Load unpacked and select this package's `extension` folder.
3. From this package folder, run Windows PowerShell:

   powershell -NoProfile -ExecutionPolicy Bypass -File ./Register-Companion.ps1

   Edge, Chrome, Opera, Chromium and compatible browsers share this connection.
   Registration is for the current
   Windows user only, with host manifests under LocalAppData\Wayrill\Companion.
   For the installed host, pass -HostPath "C:\Program Files\Wayrill\Service\wayrill-companion.exe".
   Extension IDs remain stable across package paths. Repair registration after
   moving a portable host.
4. Start routing the browser through the matching Wayrill service, reload a
   webpage, and click the Companion toolbar button.

The popup applies to the current tab. Expand a domain for request types/counts
and last known Wayrill routes, including Block. Observations are matched by exact
destination across apps/tabs; they do not prove an individual request's route.
They retain their observation time/revision across route changes and Stop. They
remain available in bounded per-domain service memory until eviction or restart;
an open popup also keeps its last route through empty lookups or bridge failures.
Unknown does not mean Direct. Cache/coalescing or IP-only logs can prevent matches.
IPIfNonMatch implicit defaults and native script routers have no inferred route
observations; explicit IPIfNonMatch rule matches remain observable.

Request metadata stays in browser session memory, without URL paths, queries,
headers or bodies. No analytics or external uploads. Incognito is disabled.

To disconnect all browsers, use the current script with -Unregister. No older
script, binary, package path or extension ID is required. Remove the
unpacked extension in the browser. Neither operation stops Wayrill routing.
See docs/guide/browser-companion.md in the matching source checkout for details.
'@
[IO.File]::WriteAllText((Join-Path $taskOutput 'README.md'), $taskReadme, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $taskProject 'LICENSE') -Destination $taskOutput -Force
Write-Host "Companion package: $taskOutput"
Write-Host 'Use Settings > Browser Companion in Wayrill, or load this folder unpacked and run the packaged Register-Companion.ps1. No copied ID is needed.'
