param([string]$FixtureParent=[IO.Path]::GetTempPath())
$ErrorActionPreference='Stop'
$fixture=Join-Path $FixtureParent ('wayrill-pinned-resources-'+[Guid]::NewGuid().ToString('N'))
function Expect-Failure([scriptblock]$Action,[string]$Message) {
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -notlike $Message) { throw }
        return
    }
    throw "Expected failure: $Message"
}
New-Item -ItemType Directory -Path (Join-Path $fixture 'tools'),(Join-Path $fixture 'service'),(Join-Path $fixture 'source'),(Join-Path $fixture '.tools/downloads/resources') -Force | Out-Null
try {
    foreach ($name in @('Get-ResourceAssets.ps1','Get-PinnedDependency.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $fixture 'tools')
    }
    # A complete pinned archive must be usable offline. Any download is a failure.
    [IO.File]::WriteAllText((Join-Path $fixture 'tools/Get-Curl.ps1'), "return 'unexpected-network-command'")
    $files=@(foreach ($name in @('geoip.dat','geosite.dat')) {
        $path=Join-Path $fixture ('source/'+$name)
        [IO.File]::WriteAllText($path,'synthetic '+$name)
        [ordered]@{path=$name;bytes=(Get-Item -LiteralPath $path).Length;sha256=(Get-FileHash -LiteralPath $path).Hash;sourceSha256=(Get-FileHash -LiteralPath $path).Hash;sourceUrl='https://fixture.invalid/xray.zip';archiveEntry=$name}
    })
    $zip=Join-Path $fixture 'source.zip'
    Compress-Archive -LiteralPath (Join-Path $fixture 'source/geoip.dat'),(Join-Path $fixture 'source/geosite.dat') -DestinationPath $zip
    $hash=(Get-FileHash -LiteralPath $zip).Hash
    $archive=Join-Path $fixture ('.tools/downloads/resources/'+$hash.ToLowerInvariant()+'.zip')
    Copy-Item -LiteralPath $zip -Destination $archive
    foreach ($file in $files) { $file.archiveSha256=$hash }
    $manifest=Join-Path $fixture 'service/dependencies.json'
    function Write-Manifest { @{resourceData=@{files=$files}} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM }
    $script=Join-Path $fixture 'tools/Get-ResourceAssets.ps1'
    Write-Manifest
    [IO.File]::WriteAllText($archive,'broken archive')
    Expect-Failure { & $script } '*Dependency archive SHA-256 mismatch*'
    Copy-Item -LiteralPath $zip -Destination $archive -Force
    $expected=$files[0].sha256
    $files[0].sha256='0'*64;$files[0].sourceSha256='0'*64
    Write-Manifest
    Expect-Failure { & $script } '*Resource integrity failure*'
    $target=Join-Path $fixture 'service/resource-assets/geoip.dat'
    if (Test-Path -LiteralPath $target) { throw 'An unverified archive member was published.' }
    $files[0].sha256=$expected;$files[0].sourceSha256=$expected
    Write-Manifest
    & $script | Out-Null
    foreach ($file in $files) {
        if ((Get-FileHash -LiteralPath (Join-Path $fixture ('service/resource-assets/'+$file.path))).Hash -ne $file.sha256) { throw 'A pinned resource was not extracted correctly.' }
    }
    [IO.File]::WriteAllText($target,'local changes')
    Expect-Failure { & $script } '*Resource differs from its pin*'
    if ([IO.File]::ReadAllText($target) -ne 'local changes') { throw 'An existing resource was overwritten.' }
    if (Get-ChildItem -LiteralPath (Join-Path $fixture '.tools/downloads/resources') -Filter '*.partial') { throw 'Failed extraction left temporary data.' }
    [ordered]@{passed=$true;cases=@('offline-archive','archive-integrity','member-integrity','preserve-local-changes','temporary-cleanup')} | ConvertTo-Json -Compress
} finally {
    $absolute=[IO.Path]::GetFullPath($fixture)
    if ((Split-Path $absolute -Parent) -ne [IO.Path]::GetFullPath($FixtureParent).TrimEnd('\') -or (Split-Path $absolute -Leaf) -notmatch '^wayrill-pinned-resources-[a-f0-9]{32}$') { throw 'Unsafe pinned-resource fixture cleanup path.' }
    if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
