param([Parameter(Mandatory)][string]$Archive,[Parameter(Mandatory)][string]$ArchiveHash,[Parameter(Mandatory)][string]$CacheRoot)
$ErrorActionPreference='Stop'
if($ArchiveHash -notmatch '^[0-9a-fA-F]{64}$'){throw 'Dependency archive pin must be SHA-256.'}
$taskHash=$ArchiveHash.ToUpperInvariant()
$taskCache=Join-Path ([IO.Path]::GetFullPath($CacheRoot)) $taskHash.ToLowerInvariant()
$taskManifest=Join-Path $taskCache '.wayrill-dependency.json'
# Immutable caches let offline tests execute Xray while another build packages it.
# Only archive entries enter the package; unrelated local test assets stay local.
if (-not (Test-Path -LiteralPath $taskCache)) {
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $taskHash) { throw 'Dependency archive SHA-256 mismatch.' }
    New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
    $taskStage=Join-Path ([IO.Path]::GetFullPath($CacheRoot)) ('.extract-'+[Guid]::NewGuid().ToString('N'))
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $taskZip=[IO.Compression.ZipFile]::OpenRead($Archive)
        try {
            foreach ($taskEntry in $taskZip.Entries) {
                $taskPath=[IO.Path]::GetFullPath((Join-Path $taskStage $taskEntry.FullName))
                if (-not $taskPath.StartsWith($taskStage+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe dependency archive entry.' }
            }
        } finally { $taskZip.Dispose() }
        Expand-Archive -LiteralPath $Archive -DestinationPath $taskStage -ErrorAction Stop
        $taskFiles=@(Get-ChildItem -LiteralPath $taskStage -Recurse -File | ForEach-Object {
            [ordered]@{path=$_.FullName.Substring($taskStage.Length+1);bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
        })
        [ordered]@{archiveSha256=$taskHash;files=$taskFiles} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskStage '.wayrill-dependency.json') -Encoding utf8NoBOM
        Move-Item -LiteralPath $taskStage -Destination $taskCache
    } finally {
        if (Test-Path -LiteralPath $taskStage) {
            if ((Split-Path $taskStage -Parent) -ne [IO.Path]::GetFullPath($CacheRoot) -or (Get-Item -LiteralPath $taskStage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or @(Get-ChildItem -LiteralPath $taskStage -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Unsafe dependency staging cleanup.' }
            Remove-Item -LiteralPath $taskStage -Recurse -Force
        }
    }
}
if ((Get-Item -LiteralPath $taskCache -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or @(Get-ChildItem -LiteralPath $taskCache -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Dependency cache contains a reparse point.' }
$taskPackage=Get-Content -LiteralPath $taskManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskPackage.archiveSha256 -ne $taskHash -or -not $taskPackage.files.Count) { throw 'Dependency cache manifest is invalid.' }
foreach ($taskFile in $taskPackage.files) {
    $taskPath=[IO.Path]::GetFullPath((Join-Path $taskCache $taskFile.path))
    if (-not $taskPath.StartsWith($taskCache+'\',[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $taskPath).Length -ne $taskFile.bytes -or (Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash -ne $taskFile.sha256) { throw 'Dependency cache integrity check failed. Preserve the cache and rebuild it explicitly.' }
}
[pscustomobject]@{Root=$taskCache;Files=$taskPackage.files}
