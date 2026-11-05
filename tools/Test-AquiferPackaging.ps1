param([string]$Package)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
if (-not $Package) { $Package = Join-Path $taskProject '.tools/installer-aquifer' }
& (Join-Path $PSScriptRoot 'Check-AquiferPayload.ps1') -Package $Package
$taskBinary = Join-Path ([IO.Path]::GetFullPath($Package)) 'wayrill-aquifer.exe'
$taskTests = Join-Path $taskProject '.tools/aquifer-package-tests'
$taskRoot = Join-Path $taskTests ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
try {
    $taskOutput = Join-Path $taskRoot 'package'
    Copy-Item -LiteralPath $Package -Destination $taskOutput -Recurse
    $taskManifestPath = Join-Path $taskOutput 'manifest.json'
    $taskObsolete = Join-Path $taskOutput 'obsolete-owned.txt'
    [IO.File]::WriteAllText($taskObsolete, 'Synthetic old package file.')
    $taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw | ConvertFrom-Json
    $taskManifest.files += @{path='obsolete-owned.txt';sha256=(Get-FileHash -LiteralPath $taskObsolete).Hash}
    $taskManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $taskManifestPath -Encoding utf8
    & (Join-Path $PSScriptRoot 'Package-Aquifer.ps1') -BinaryPath $taskBinary -OutputDirectory $taskOutput
    if (Test-Path -LiteralPath $taskObsolete) { throw 'Repackaging retained an obsolete owned file.' }
    $taskBefore = (Get-FileHash -LiteralPath $taskManifestPath).Hash
    foreach ($taskRelative in @('unmanaged.txt', 'extras/manifest.json', '.hidden-unmanaged.txt')) {
        $taskUnmanaged = Join-Path $taskOutput $taskRelative
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($taskUnmanaged)) -Force | Out-Null
        [IO.File]::WriteAllText($taskUnmanaged, 'This is not part of the package.')
        if ($taskRelative.StartsWith('.')) { (Get-Item -LiteralPath $taskUnmanaged -Force).Attributes = [IO.FileAttributes]::Hidden }
        $taskRejected = $false
        try { & (Join-Path $PSScriptRoot 'Package-Aquifer.ps1') -BinaryPath $taskBinary -OutputDirectory $taskOutput } catch { $taskRejected = $true }
        if (-not $taskRejected -or -not (Test-Path -LiteralPath $taskUnmanaged) -or (Get-FileHash -LiteralPath $taskManifestPath).Hash -ne $taskBefore) { throw "An unmanaged file was absorbed or removed: $taskRelative" }
        Remove-Item -LiteralPath $taskUnmanaged -Force
    }
    $taskReadme = Join-Path $taskOutput 'README.md'
    $taskReadmeBytes = [IO.File]::ReadAllBytes($taskReadme)
    [IO.File]::AppendAllText($taskReadme, 'Synthetic external edit.')
    $taskModifiedHash = (Get-FileHash -LiteralPath $taskReadme).Hash
    $taskRejected = $false
    try { & (Join-Path $PSScriptRoot 'Package-Aquifer.ps1') -BinaryPath $taskBinary -OutputDirectory $taskOutput } catch { $taskRejected = $true }
    if (-not $taskRejected -or (Get-FileHash -LiteralPath $taskReadme).Hash -ne $taskModifiedHash) { throw 'Repackaging overwrote an external payload edit.' }
    [IO.File]::WriteAllBytes($taskReadme, $taskReadmeBytes)
    $taskLock = [IO.File]::Open((Join-Path $taskOutput 'wayrill-aquifer.exe'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $taskRejected = $false
        try { & (Join-Path $PSScriptRoot 'Package-Aquifer.ps1') -BinaryPath $taskBinary -OutputDirectory $taskOutput } catch { $taskRejected = $true }
        if (-not $taskRejected -or (Get-FileHash -LiteralPath $taskManifestPath).Hash -ne $taskBefore) { throw 'A locked executable allowed package replacement.' }
    } finally { $taskLock.Dispose() }
    $taskInvalidBinary = Join-Path $taskRoot 'invalid.exe'
    [IO.File]::WriteAllText($taskInvalidBinary, 'Synthetic invalid executable.')
    $taskRejected = $false
    try { & (Join-Path $PSScriptRoot 'Package-Aquifer.ps1') -BinaryPath $taskInvalidBinary -OutputDirectory $taskOutput } catch { $taskRejected = $true }
    if (-not $taskRejected -or (Get-FileHash -LiteralPath $taskManifestPath).Hash -ne $taskBefore) { throw 'A failed staging build damaged the previous package.' }
    & (Join-Path $PSScriptRoot 'Check-AquiferPayload.ps1') -Package $taskOutput
    if (@(Get-ChildItem -LiteralPath $taskRoot -Directory | Where-Object Name -Like '*.stage-*').Count) { throw 'Staging files were left after a failed build.' }
    Write-Host 'Aquifer packaging regressions passed: obsolete files removed, unmanaged files rejected, previous package preserved on failure.'
} finally {
    $taskAbsolute = [IO.Path]::GetFullPath($taskRoot)
    if ([IO.Directory]::GetParent($taskAbsolute).FullName -ne [IO.Path]::GetFullPath($taskTests)) { throw 'Refusing cleanup outside packaging test root.' }
    Remove-Item -LiteralPath $taskAbsolute -Recurse -Force
}
