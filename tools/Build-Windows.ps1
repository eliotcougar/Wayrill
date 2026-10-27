param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
$taskLogRoot = Join-Path $taskProject ('.tools\logs\build-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskLogRoot -Force | Out-Null
Push-Location $taskProject
try {
    & rustc --version --verbose | Tee-Object -FilePath (Join-Path $taskLogRoot 'rustc.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Rust toolchain is unavailable' }
    & npm.cmd run lint 2>&1 | Tee-Object -FilePath (Join-Path $taskLogRoot 'lint.log')
    if ($LASTEXITCODE -ne 0) { throw 'Frontend lint failed' }
    if (-not $SkipTests) {
        & npm.cmd run test 2>&1 | Tee-Object -FilePath (Join-Path $taskLogRoot 'tests.log')
        if ($LASTEXITCODE -ne 0) { throw 'Graph tests failed' }
    }
    & (Join-Path $PSScriptRoot 'Build-Networking-Service.ps1') -SkipTests:$SkipTests -OutputDirectory (Join-Path $taskProject '.tools\installer-service')
    if ($LASTEXITCODE -ne 0) { throw 'Bundled service build failed' }
    & (Join-Path $PSScriptRoot 'Check-InstallerPayload.ps1')
    & npm.cmd run desktop:build -- --target x86_64-pc-windows-msvc --ci -- --locked 2>&1 | Tee-Object -FilePath (Join-Path $taskLogRoot 'desktop-build.log')
    if ($LASTEXITCODE -ne 0) { throw "Desktop build failed; see $taskLogRoot" }
    Write-Host "Build logs: $taskLogRoot"
} finally {
    Pop-Location
}
