param([string]$CorePath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
$taskPins = Get-Content -LiteralPath (Join-Path $taskProject 'service/dependencies.json') -Raw | ConvertFrom-Json
if (-not $CorePath) { $CorePath = Join-Path $taskProject '.tools/installer-service/xray/xray.exe' }
if (-not (Test-Path -LiteralPath $CorePath)) { throw 'Build tools/Build-Networking-Service.ps1 first; Aquifer acceptance checks need the pinned test core.' }
if ((Get-FileHash -LiteralPath $CorePath).Hash -ine $taskPins.xray.executableSha256) { throw 'The Aquifer test core does not match the pinned main core.' }
$CorePath = (Resolve-Path -LiteralPath $CorePath).Path
$taskFixture = Join-Path $taskProject ('.tools/aquifer-core-tests/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskFixture -Force | Out-Null
$taskEnvironment = @{}
foreach ($taskKey in @('WAYRILL_REMOTE_TEST_CORE','WAYRILL_REMOTE_EDITOR_CORE','WAYRILL_REMOTE_TEST_CERTIFICATE','WAYRILL_REMOTE_TEST_KEY')) { $taskEnvironment[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey,'Process') }
Push-Location $taskFixture
try {
    & $CorePath tls cert -domain=localhost -file=server *> cert-generation.log
    if ($LASTEXITCODE) { throw 'Could not prepare the synthetic TLS certificate.' }
    $env:WAYRILL_REMOTE_TEST_CORE = $CorePath
    $env:WAYRILL_REMOTE_EDITOR_CORE = $CorePath
    $env:WAYRILL_REMOTE_TEST_CERTIFICATE = Join-Path $taskFixture 'server.crt'
    $env:WAYRILL_REMOTE_TEST_KEY = Join-Path $taskFixture 'server.key'
    if (-not (Test-Path -LiteralPath $env:WAYRILL_REMOTE_TEST_CERTIFICATE) -or -not (Test-Path -LiteralPath $env:WAYRILL_REMOTE_TEST_KEY)) { throw 'The synthetic TLS certificate was not generated.' }
    Push-Location (Join-Path $taskProject 'aquifer')
    try { & npm.cmd exec -- vitest run --config vitest.core.config.ts }
    finally { Pop-Location }
    if ($LASTEXITCODE) { throw 'Aquifer Xray acceptance checks failed.' }
} finally {
    foreach ($taskKey in $taskEnvironment.Keys) { [Environment]::SetEnvironmentVariable($taskKey,$taskEnvironment[$taskKey],'Process') }
    Pop-Location
}
