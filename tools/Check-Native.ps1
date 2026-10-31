param(
    [ValidateSet('service', 'desktop', 'capture')]
    [string[]]$Component = @('service', 'desktop', 'capture'),
    [switch]$SkipTests,
    [string]$CurlPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
Push-Location $taskProject
try {
    foreach ($taskComponent in $Component | Select-Object -Unique) {
        $taskRelativeManifest = switch ($taskComponent) {
            service { 'service/Cargo.toml' }
            desktop { 'src-tauri/Cargo.toml' }
            capture { 'service/capture/Cargo.toml' }
        }
        $taskManifest = Join-Path $taskProject $taskRelativeManifest
        $taskPreviousTauri = $env:TAURI_CONFIG
        $taskPreviousFlags = $env:RUSTFLAGS
        try {
            if ($taskComponent -eq 'desktop') {
                # Unit tests do not package the installer or its service payload.
                $env:TAURI_CONFIG = [IO.File]::ReadAllText((Join-Path $taskProject 'src-tauri/tauri.dev.conf.json'))
            } else {
                # Match the service and capture release builds' static CRT.
                $env:RUSTFLAGS = ($env:RUSTFLAGS + ' -C target-feature=+crt-static').Trim()
            }
            if ($taskComponent -eq 'service') {
                & (Join-Path $PSScriptRoot 'Get-ResourceAssets.ps1') -IncludeRegional:(-not $SkipTests) -CurlPath $CurlPath
                if (-not $SkipTests) {
                    # Synthetic build/installer contracts; no installation or system changes.
                    foreach ($taskScript in @('Test-PackageCleanup.ps1', 'Test-PinnedResources.ps1', 'Test-InstallerResources.ps1', 'Test-InstallerRetirement.ps1', 'Test-CompanionSetup.ps1')) {
                        & (Join-Path $PSScriptRoot $taskScript)
                    }
                }
            }
            Write-Host "Checking native $taskComponent"
            & cargo fmt --manifest-path $taskManifest --all -- --check
            if ($LASTEXITCODE) { throw "$taskComponent formatting failed." }
            $taskCheckArgs = @('--manifest-path', $taskManifest, '--locked')
            if ($taskComponent -eq 'service') { $taskCheckArgs += '--workspace' }
            $taskVariants = @('default')
            if ($taskComponent -eq 'capture') { $taskVariants += 'attribution-only' }
            foreach ($taskVariant in $taskVariants) {
                $taskFeatureArgs = @()
                if ($taskVariant -eq 'attribution-only') { $taskFeatureArgs += '--no-default-features' }
                & cargo clippy @taskCheckArgs @taskFeatureArgs --all-targets -- -D warnings
                if ($LASTEXITCODE) { throw "$taskComponent ($taskVariant) lint failed." }
                if (-not $SkipTests) {
                    & cargo test @taskCheckArgs @taskFeatureArgs
                    if ($LASTEXITCODE) { throw "$taskComponent ($taskVariant) tests failed." }
                }
            }
        } finally {
            $env:TAURI_CONFIG = $taskPreviousTauri
            $env:RUSTFLAGS = $taskPreviousFlags
        }
    }
} finally { Pop-Location }
