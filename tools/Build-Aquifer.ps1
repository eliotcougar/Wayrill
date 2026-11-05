param([switch]$SkipTests, [string]$OutputDirectory, [string]$CurlPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskProject '.tools/installer-aquifer' }
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
$taskAquifer = Join-Path $taskProject 'aquifer'
Push-Location $taskProject
try {
    & npm.cmd run aquifer:check
    if ($LASTEXITCODE) { throw 'Aquifer frontend checks failed.' }
    if (-not $SkipTests) {
        & npm.cmd run aquifer:test
        if ($LASTEXITCODE) { throw 'Aquifer frontend tests failed.' }
    }
    & (Join-Path $PSScriptRoot 'Check-Native.ps1') -Component aquifer -SkipTests:$SkipTests
    $taskPreviousFlags = $env:RUSTFLAGS
    try {
        $env:RUSTFLAGS = ($env:RUSTFLAGS + ' -C target-feature=+crt-static').Trim()
        Push-Location $taskAquifer
        try { & npm.cmd run desktop:build -- --target x86_64-pc-windows-msvc --ci --no-bundle -- --locked }
        finally { Pop-Location }
        if ($LASTEXITCODE) { throw 'Aquifer desktop build failed.' }
    } finally { $env:RUSTFLAGS = $taskPreviousFlags }
    & (Join-Path $PSScriptRoot 'Package-Aquifer.ps1') -BinaryPath (Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release/wayrill-aquifer.exe') -OutputDirectory $taskOutput -CurlPath $CurlPath
    if (-not $SkipTests) { & (Join-Path $PSScriptRoot 'Test-AquiferPackaging.ps1') -Package $taskOutput }
    Write-Host "Wayrill Aquifer standalone package: $taskOutput"
} finally { Pop-Location }
