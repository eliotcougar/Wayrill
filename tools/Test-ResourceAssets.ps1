param([string]$FixtureParent = [IO.Path]::GetTempPath())
$ErrorActionPreference = 'Stop'
$fixture = Join-Path $FixtureParent ('wayrill-resource-test-' + [Guid]::NewGuid().ToString('N'))
$tools = Join-Path $fixture 'tools'
$service = Join-Path $fixture 'service'
$repo = 'https://github.com/fixture/rules'
$files = @(
    @{ path = 'geoip.dat'; asset = 'geoip-lite.dat'; sourceRepository = $repo },
    @{ path = 'geosite.dat'; asset = 'geosite.dat'; sourceRepository = $repo }
)

function Set-LatestRelease([string]$Tag) {
    $source = Join-Path $fixture $Tag
    New-Item -ItemType Directory -Path $source | Out-Null
    $assets = foreach ($file in $files) {
        $asset = Join-Path $source $file.asset
        [IO.File]::WriteAllText($asset, "$Tag $($file.asset)")
        @{ name = $file.asset; size = (Get-Item -LiteralPath $asset).Length; digest = 'sha256:' + (Get-FileHash -LiteralPath $asset).Hash }
    }
    @{ tag_name = $Tag; assets = @($assets) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $fixture 'latest.json') -Encoding utf8NoBOM
}

function Assert-InstalledRelease([string]$Tag) {
    foreach ($file in $files) {
        if ([IO.File]::ReadAllText((Join-Path $service ('resource-assets/' + $file.path))) -cne "$Tag $($file.asset)") {
            throw "Unexpected installed $($file.path)."
        }
    }
}

New-Item -ItemType Directory -Path $tools,(Join-Path $service 'scripts') -Force | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Get-ResourceAssets.ps1') -Destination $tools
    Copy-Item -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'service/scripts/Resource-Downloads.ps1') -Destination (Join-Path $service 'scripts')
    @{ resourceData = @{ files = $files } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $service 'dependencies.json') -Encoding utf8NoBOM
    'Join-Path $PSScriptRoot curl.ps1' | Set-Content -LiteralPath (Join-Path $tools 'Get-Curl.ps1')
    @'
$root = Split-Path $PSScriptRoot -Parent
$url = $args[-1]
if ($url -eq 'https://api.github.com/repos/fixture/rules/releases/latest') {
    Get-Content -LiteralPath (Join-Path $root 'latest.json') -Raw
    exit 0
}
if ($url -notmatch '^https://github\.com/fixture/rules/releases/download/(release-[12])/(geoip-lite|geosite)\.dat$') {
    throw "Unexpected fixture request $url."
}
Copy-Item -LiteralPath (Join-Path $root "$($Matches[1])/$($Matches[2]).dat") -Destination $args[$args.IndexOf('--output') + 1]
exit 0
'@ | Set-Content -LiteralPath (Join-Path $tools 'curl.ps1')

    $download = Join-Path $tools 'Get-ResourceAssets.ps1'
    Set-LatestRelease 'release-1'
    & $download
    Assert-InstalledRelease 'release-1'

    Set-LatestRelease 'release-2'
    $corruptAsset = Join-Path $fixture 'release-2/geosite.dat'
    [IO.File]::WriteAllText($corruptAsset, 'releAse-2 geosite.dat')
    $failed = $false
    try { & $download } catch {
        if ($_.Exception.Message -notlike 'Geodata integrity check failed*') { throw }
        $failed = $true
    }
    if (-not $failed) { throw 'Accepted a corrupted asset.' }
    Assert-InstalledRelease 'release-1'
    if (Get-ChildItem -LiteralPath (Join-Path $fixture '.tools/downloads/resources') -Filter '*.partial') { throw 'Failed download left temporary data.' }

    [IO.File]::WriteAllText($corruptAsset, 'release-2 geosite.dat')
    & $download
    Assert-InstalledRelease 'release-2'
    foreach ($file in $files) { Remove-Item -LiteralPath (Join-Path $fixture ('release-2/' + $file.asset)) }
    & $download
    Assert-InstalledRelease 'release-2'
} finally {
    $absolute = [IO.Path]::GetFullPath($fixture)
    if ((Split-Path $absolute -Parent) -ne [IO.Path]::GetFullPath($FixtureParent).TrimEnd('\') -or
        (Split-Path $absolute -Leaf) -notmatch '^wayrill-resource-test-[a-f0-9]{32}$') { throw 'Unsafe resource fixture cleanup path.' }
    if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
