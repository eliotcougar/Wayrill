param([string]$CorePath, [string]$SourceDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
$taskPins = Get-Content -LiteralPath (Join-Path $taskProject 'service/dependencies.json') -Raw | ConvertFrom-Json
if (-not $CorePath) { $CorePath = Join-Path $taskProject '.tools/installer-service/xray/xray.exe' }
if (-not $SourceDirectory) { $SourceDirectory = Join-Path $taskProject ('.tools/tun-source/Xray-core-' + $taskPins.xray.sourceCommit) }
if (-not (Test-Path -LiteralPath $CorePath) -or -not (Test-Path -LiteralPath (Join-Path $SourceDirectory 'infra/conf'))) {
    throw 'Build the public core and service package first: tools/Build-Networking-Service.ps1. Then run npm run test:core. No installed service or VM is required.'
}
if ((Get-FileHash -LiteralPath $CorePath).Hash -ne $taskPins.xray.executableSha256) { throw 'The test core does not match service/dependencies.json.' }
$CorePath = (Resolve-Path -LiteralPath $CorePath).Path
$SourceDirectory = (Resolve-Path -LiteralPath $SourceDirectory).Path
$taskVitest = Join-Path $taskProject 'node_modules/.bin/vitest.cmd'
if (-not (Test-Path -LiteralPath $taskVitest)) { throw 'Run npm ci before core integration tests.' }
& (Join-Path $PSScriptRoot 'Get-ResourceAssets.ps1')
$taskFixture = Join-Path $taskProject ('.tools/core-tests/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskFixture -Force | Out-Null
foreach ($taskFile in $taskPins.resourceData.files) {
    Copy-Item -LiteralPath (Join-Path $taskProject ('service/resource-assets/' + $taskFile.path)) -Destination $taskFixture
}
$taskEnvironment = @{}
foreach ($taskName in @('WAYRILL_XRAY_TEST_EXE', 'WAYRILL_XRAY_FIXTURE_DIR', 'WAYRILL_XRAY_SOURCE', 'XRAY_LOCATION_ASSET', 'RUSTFLAGS')) {
    $taskEnvironment[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process')
}
Push-Location $taskProject
try {
    $env:WAYRILL_XRAY_TEST_EXE = $CorePath
    $env:WAYRILL_XRAY_FIXTURE_DIR = $taskFixture
    $env:WAYRILL_XRAY_SOURCE = $SourceDirectory
    $env:XRAY_LOCATION_ASSET = $taskFixture
    $env:RUSTFLAGS = ($env:RUSTFLAGS + ' -C target-feature=+crt-static').Trim()
    & $taskVitest run --config vitest.core.config.ts
    if ($LASTEXITCODE) { throw 'Graph/core integration tests failed.' }
    & cargo clippy --manifest-path service/Cargo.toml --locked -p wayrill-service --features core-integration --all-targets -- -D warnings
    if ($LASTEXITCODE) { throw 'Service/core integration lint failed.' }
    $taskCoreArgs = @('--manifest-path', 'service/Cargo.toml', '--locked', '-p', 'wayrill-service', '--features', 'core-integration', 'core_integration_')
    $taskTests = @(& cargo test @taskCoreArgs -- --list)
    if ($LASTEXITCODE) { throw 'Service/core test discovery failed.' }
    if (-not @($taskTests | Where-Object { $_ -match ': test$' }).Count) { throw 'No service/core integration tests were discovered.' }
    & cargo test @taskCoreArgs
    if ($LASTEXITCODE) { throw 'Service/core integration tests failed.' }
    Write-Host "Core integration checks passed. Generated configurations and logs: $taskFixture"
} finally {
    foreach ($taskName in $taskEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($taskName, $taskEnvironment[$taskName], 'Process')
    }
    Pop-Location
}
