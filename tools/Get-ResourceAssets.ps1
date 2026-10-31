param([string]$CurlPath,[switch]$IncludeRegional)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pins = Get-Content -LiteralPath (Join-Path $root 'service\dependencies.json') -Raw | ConvertFrom-Json
$cache = Join-Path $root '.tools\downloads\resources'
$downloaded = 0
$curl = $null
$archives = @{}
$sets = @(@{ pin = $pins.resourceData; folder = 'resource-assets' })
if ($IncludeRegional) { $sets += @{ pin = $pins.routingData; folder = 'routing-assets' } }
foreach ($set in $sets) {
    foreach ($file in $set.pin.files) {
        if ($file.path -notmatch '^[a-z0-9-]+\.dat$' -or $file.sourceUrl -notmatch '^https://') { throw 'Unsafe resource manifest entry.' }
        $folder = Join-Path $root ('service\' + $set.folder)
        $target = Join-Path $folder $file.path
        if (Test-Path -LiteralPath $target) {
            if ((Get-Item -LiteralPath $target).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $target).Hash -ne $file.sha256) { throw "Resource differs from its pin: $target. Preserve local changes before replacing it." }
            continue
        }
        if ($file.sourceSha256 -ne $file.sha256) { throw 'Resource needs a reviewed transformation; downloading alone cannot reproduce it.' }
        if (-not $curl) { $curl = & (Join-Path $PSScriptRoot 'Get-Curl.ps1') -Path $CurlPath }
        New-Item -ItemType Directory -Path $folder, $cache -Force | Out-Null
        $temporary = Join-Path $cache ([Guid]::NewGuid().ToString('N') + '.partial')
        try {
            if ($file.archiveEntry) {
                if ($file.archiveEntry -notmatch '^[a-z0-9-]+\.dat$' -or $file.archiveSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Unsafe resource archive entry.' }
                $archiveHash = $file.archiveSha256.ToLowerInvariant()
                if (-not $archives.ContainsKey($archiveHash)) {
                    $archive = Join-Path $cache ($archiveHash + '.zip')
                    if (-not (Test-Path -LiteralPath $archive)) {
                        & $curl --fail --location --silent --show-error $file.sourceUrl --output $temporary
                        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($file.path)" }
                        if ((Get-FileHash -LiteralPath $temporary).Hash -ne $file.archiveSha256) { throw "Resource archive integrity failure: $($file.path)" }
                        Move-Item -LiteralPath $temporary -Destination $archive
                    }
                    $archives[$archiveHash] = & (Join-Path $PSScriptRoot 'Get-PinnedDependency.ps1') -Archive $archive -ArchiveHash $file.archiveSha256 -CacheRoot (Join-Path $cache 'archives')
                }
                Copy-Item -LiteralPath (Join-Path $archives[$archiveHash].Root $file.archiveEntry) -Destination $temporary
            } else {
                & $curl --fail --location --silent --show-error $file.sourceUrl --output $temporary
                if ($LASTEXITCODE -ne 0) { throw "Download failed: $($file.path)" }
            }
            if ((Get-Item -LiteralPath $temporary).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $temporary).Hash -ne $file.sha256) { throw "Resource integrity failure: $($file.path)" }
            Move-Item -LiteralPath $temporary -Destination $target
            $downloaded++
        } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
    }
}
Write-Host "Pinned resources verified; $downloaded downloaded."
