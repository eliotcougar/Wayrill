param([string]$CurlPath,[switch]$IncludeRegional)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dependencies = Get-Content -LiteralPath (Join-Path $root 'service/dependencies.json') -Raw | ConvertFrom-Json
. (Join-Path $root 'service/scripts/Resource-Downloads.ps1')

$plan = @($dependencies.resourceData.files | ForEach-Object {
    [pscustomobject]@{ path = $_.path; asset = $_.asset; repository = $_.sourceRepository; folder = 'resource-assets' }
})
if ($IncludeRegional) {
    $plan += @(Get-WayrillInstallerResourcePlan $dependencies 14 | ForEach-Object {
        [pscustomobject]@{ path = $_.path; asset = $_.asset; repository = $_.repository; folder = 'routing-assets' }
    })
}
$curl = & (Join-Path $PSScriptRoot 'Get-Curl.ps1') -Path $CurlPath
$curlOptions = @('--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--retry', '2')
$apiToken = $env:WAYRILL_GEODATA_API_TOKEN
if ($apiToken -and $apiToken -cnotmatch '\A[A-Za-z0-9_.-]+\z') { throw 'Invalid GitHub geodata API credential.' }
$cache = Join-Path $root '.tools/downloads/resources'
New-Item -ItemType Directory -Path $cache -Force | Out-Null

# Resolve one release per provider so the DAT pair always comes from the same release.
foreach ($group in $plan | Group-Object repository) {
    if ($group.Name -notmatch '^https://github\.com/([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)$') { throw 'Invalid resource repository.' }
    $api = "https://api.github.com/repos/$($Matches[1])/releases/latest"
    $json = if ($apiToken) {
        # Authenticate only the fixed GitHub API host. Keep the token off the
        # command line and out of asset requests and redirects.
        'header = "Authorization: Bearer ' + $apiToken + '"' |
            & $curl @curlOptions --no-location --config - --max-time 60 $api
    } else {
        & $curl @curlOptions --max-time 60 $api
    }
    if ($LASTEXITCODE) { throw "Could not resolve the latest geodata release for $($group.Name)." }
    $release = ($json -join "`n") | ConvertFrom-Json
    if ($release.tag_name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') { throw "Invalid geodata release tag for $($group.Name)." }

    $staged = [ordered]@{}
    try {
        foreach ($file in $group.Group) {
            if ($file.path -notmatch '^[a-z0-9-]+\.dat$' -or $file.asset -notmatch '^[a-z0-9-]+\.dat$') { throw 'Invalid geodata filename.' }
            $asset = @($release.assets | Where-Object name -CEQ $file.asset)
            if ($asset.Count -ne 1 -or $asset[0].size -le 0 -or $asset[0].size -gt 128MB -or $asset[0].digest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
                throw "Missing verified asset metadata for $($file.asset) in $($group.Name) $($release.tag_name)."
            }
            $expectedHash = $Matches[1]
            $expectedSize = $asset[0].size
            $folder = Join-Path $root ('service/' + $file.folder)
            New-Item -ItemType Directory -Path $folder -Force | Out-Null
            $target = Join-Path $folder $file.path
            if ((Test-Path -LiteralPath $target -PathType Leaf) -and
                (Get-Item -LiteralPath $target).Length -eq $expectedSize -and
                (Get-FileHash -LiteralPath $target).Hash -eq $expectedHash) { continue }

            $temporary = Join-Path $cache ([Guid]::NewGuid().ToString('N') + '.partial')
            $staged[$target] = $temporary
            $url = "$($group.Name)/releases/download/$($release.tag_name)/$($file.asset)"
            & $curl @curlOptions --max-time 600 --max-filesize $expectedSize --output $temporary $url
            if ($LASTEXITCODE) { throw "Geodata download failed for $($file.asset) in $($group.Name) $($release.tag_name)." }
            if ((Get-Item -LiteralPath $temporary).Length -ne $expectedSize -or (Get-FileHash -LiteralPath $temporary).Hash -ne $expectedHash) {
                throw "Geodata integrity check failed for $($file.asset) in $($group.Name) $($release.tag_name)."
            }
        }
        foreach ($file in $staged.GetEnumerator()) { [IO.File]::Move($file.Value, $file.Key, $true) }
        Write-Host "Verified $($group.Name) $($release.tag_name) geodata; $($staged.Count) downloaded."
    } finally {
        foreach ($temporary in $staged.Values) {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        }
    }
}
