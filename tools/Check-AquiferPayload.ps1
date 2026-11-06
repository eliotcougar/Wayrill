param([string]$Package, [string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
if (-not $Package) { $Package = Join-Path $taskProject '.tools/installer-aquifer' }
$taskRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Package))
if ((Get-Item -LiteralPath $taskRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Aquifer payload must be a regular directory.' }
if (@(Get-ChildItem -LiteralPath $taskRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Aquifer payload cannot contain symbolic links or junctions.' }
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'manifest.json') -Raw | ConvertFrom-Json
$taskExpected = if ($ExpectedVersion) { $ExpectedVersion } else { (Get-Content -LiteralPath (Join-Path $taskProject 'aquifer/package.json') -Raw | ConvertFrom-Json).version }
if ($taskManifest.product -ne 'Wayrill Aquifer' -or $taskManifest.version -ne $taskExpected) { throw 'Aquifer payload version does not match source.' }
$taskSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($taskFile in $taskManifest.files) {
    $taskPath = [IO.Path]::GetFullPath((Join-Path $taskRoot $taskFile.path))
    if (-not $taskPath.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or -not $taskSeen.Add($taskPath)) { throw 'Invalid or duplicate Aquifer payload path.' }
    if ((Get-FileHash -LiteralPath $taskPath).Hash -ine $taskFile.sha256) { throw "Aquifer payload changed: $($taskFile.path)" }
}
$taskSources = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'third-party-sources.json') -Raw | ConvertFrom-Json
$taskRequired = @('wayrill-aquifer.exe','LICENSE','THIRD_PARTY_NOTICES.md','licenses/libavoid-LGPL-2.1.txt','third-party/SHA256.json')
$taskRequired += @($taskSources.files | ForEach-Object { 'third-party/' + $_.name })
foreach ($taskName in $taskRequired) {
    if (-not $taskSeen.Contains([IO.Path]::GetFullPath((Join-Path $taskRoot $taskName)))) { throw "Missing Aquifer payload: $taskName" }
}
$taskExecutable = Get-Item -LiteralPath (Join-Path $taskRoot 'wayrill-aquifer.exe')
if ($taskExecutable.VersionInfo.ProductName -ne 'Wayrill Aquifer' -or $taskExecutable.VersionInfo.ProductVersion -ne $taskExpected) { throw 'Aquifer executable identity does not match its manifest.' }
$taskActual = @(Get-ChildItem -LiteralPath $taskRoot -File -Recurse -Force | Where-Object FullName -ne (Join-Path $taskRoot 'manifest.json'))
if ($taskActual.Count -ne $taskSeen.Count) { throw 'Unexpected files in the Aquifer payload.' }
Write-Host "Verified Wayrill Aquifer $taskExpected payload ($($taskSeen.Count) files)."
