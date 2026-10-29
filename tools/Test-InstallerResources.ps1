param([string]$FixtureParent=[IO.Path]::GetTempPath())
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'service\scripts\Resource-Downloads.ps1')
$latestResolver=${function:Get-WayrillLatestResourceRelease}
$receiver=${function:Receive-WayrillResourceFile}
$fixture=Join-Path $FixtureParent ('wayrill-resources-'+[Guid]::NewGuid().ToString('N'))
$script:checks=0
function Assert-Resource($Condition,[string]$Message) { $script:checks++; if (-not $Condition) { throw $Message } }
function Expect-ResourceFailure([scriptblock]$Action,[string]$Message,[string]$Expected='*') {
    $failed=$false
    try { & $Action | Out-Null } catch {
        $failed=$true
        if ($_.Exception.Message -notlike $Expected) { throw ('Unexpected resource failure: '+$_.Exception.Message) }
    }
    Assert-Resource $failed $Message
}
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $script:payloads=@{};$script:hashes=@{}
    foreach($version in @('one','two')){
        $script:payloads[$version]=[Text.Encoding]::UTF8.GetBytes('current dataset '+$version)
        $sample=Join-Path $fixture ($version+'.dat')
        [IO.File]::WriteAllBytes($sample,$script:payloads[$version])
        $script:hashes[$version]=(Get-FileHash -LiteralPath $sample).Hash
    }
    $entries=@(foreach ($prefix in @('ru','ir','cn')) { foreach ($kind in @('geoip','geosite')) {
        # Deliberately obsolete build pins must never govern installation.
        [pscustomobject]@{path=$prefix+'-'+$kind+'.dat';bytes=1;sha256=('0'*64);sourceUrl='https://obsolete.invalid/removed.dat';sourceRepository='https://github.com/fixture/'+$prefix}
    } })
    $pins=[pscustomobject]@{routingData=[pscustomobject]@{files=$entries}}
    $script:received=[Collections.Generic.List[string]]::new()
    $script:resolved=[Collections.Generic.List[string]]::new()
    $script:latest='one';$script:mode='ok'
    function Get-WayrillLatestResourceRelease([string]$Repository) {
        $script:resolved.Add($Repository)
        return $Repository+'/releases/download/'+$script:latest
    }
    function Receive-WayrillResourceFile([string]$Url,[string]$Destination,[long]$MaxBytes=128MB) {
        $script:received.Add($Url)
        $version=([Uri]$Url).Segments[-2].TrimEnd('/')
        $asset=([Uri]$Url).Segments[-1]
        if($asset.EndsWith('.sha256sum')){
            $name=$asset.Replace('.sha256sum','')
            if($script:mode -eq 'wrong-checksum-name'){$name='another.dat'}
            [IO.File]::WriteAllText($Destination,($script:hashes[$version]+'  release/'+$name+"`n"))
            return
        }
        if ($script:mode -eq 'fail-second' -and $asset -eq 'geosite.dat') {
            [IO.File]::WriteAllText($Destination,'partial')
            throw 'Synthetic interrupted transfer'
        }
        if ($script:mode -eq 'corrupt') {
            $bad=$script:payloads[$version].Clone();$bad[0]=0
            [IO.File]::WriteAllBytes($Destination,$bad);return
        }
        [IO.File]::WriteAllBytes($Destination,$script:payloads[$version])
        if($script:mode -eq 'publish-during-download'){$script:latest='two'}
    }
    $stage=Join-Path $fixture 'download'
    Save-WayrillInstallerResources $pins 1 $stage | Out-Null
    Assert-Resource ($script:received.Count -eq 0 -and $script:resolved.Count -eq 0 -and -not (Test-Path -LiteralPath $stage)) 'XTLS-only setup attempted a download.'
    $script:mode='fail-second'
    Expect-ResourceFailure { Save-WayrillInstallerResources $pins 3 $stage } 'An interrupted transfer succeeded.' '*Synthetic interrupted transfer*'
    Assert-Resource ((Get-FileHash -LiteralPath (Join-Path $stage 'ru-geoip.dat')).Hash -eq $script:hashes.one) 'A verified completed download was lost.'
    Assert-Resource (-not (Test-Path -LiteralPath (Join-Path $stage 'ru-geosite.dat'))) 'A partial download was published.'
    Assert-Resource (-not (Get-ChildItem -LiteralPath $stage -Filter '*.partial')) 'An interrupted temporary file was retained.'
    $script:received.Clear();$script:resolved.Clear();$script:mode='ok'
    Save-WayrillInstallerResources $pins 3 $stage | Out-Null
    $data=@($script:received|Where-Object {-not $_.EndsWith('.sha256sum')})
    Assert-Resource ($data.Count -eq 1 -and $data[0] -like '*/one/geosite.dat') 'Retry downloaded already verified files or wrong data.'
    Assert-Resource ($script:resolved.Count -eq 1) 'A provider was resolved repeatedly within one download batch.'
    $script:received.Clear()
    Save-WayrillInstallerResources $pins 3 $stage | Out-Null
    Assert-Resource (@($script:received|Where-Object {-not $_.EndsWith('.sha256sum')}).Count -eq 0) 'Completed files were downloaded again.'
    Assert-Resource ($script:received.Count -eq 2) 'Retry did not recheck upstream checksums.'
    $script:latest='two';$script:received.Clear()
    Save-WayrillInstallerResources $pins 3 $stage | Out-Null
    Assert-Resource (@($script:received|Where-Object {-not $_.EndsWith('.sha256sum')}).Count -eq 2) 'A new release reused stale staged files.'
    Assert-Resource ((Get-FileHash -LiteralPath (Join-Path $stage 'ru-geoip.dat')).Hash -eq $script:hashes.two) 'A newer upstream file was not installed.'
    $script:latest='one';$script:mode='publish-during-download';$script:received.Clear()
    Save-WayrillInstallerResources $pins 3 (Join-Path $fixture 'rollover') | Out-Null
    Assert-Resource (@($script:received|Where-Object {$_ -notlike '*/one/*'}).Count -eq 0) 'One provider mixed different releases within a batch.'
    $script:mode='corrupt'
    Expect-ResourceFailure { Save-WayrillInstallerResources $pins 9 (Join-Path $fixture 'corrupt') } 'Corrupt content was accepted.' '*Resource integrity check failed*'
    Assert-Resource (-not (Test-Path -LiteralPath (Join-Path $fixture 'corrupt\cn-geoip.dat'))) 'Corrupt data was published.'
    Assert-Resource (-not (Get-ChildItem -LiteralPath (Join-Path $fixture 'corrupt') -Filter '*.partial')) 'Corrupt temporary data was retained.'
    $script:mode='wrong-checksum-name';$script:received.Clear()
    Expect-ResourceFailure { Save-WayrillInstallerResources $pins 3 $stage } 'An unrelated checksum was accepted.' '*Invalid upstream checksum*'
    Assert-Resource (@($script:received|Where-Object {-not $_.EndsWith('.sha256sum')}).Count -eq 0) 'A malformed checksum reached the data downloader.'
    Assert-Resource ((Get-FileHash -LiteralPath (Join-Path $stage 'ru-geoip.dat')).Hash -eq $script:hashes.two) 'A failed update damaged an existing file.'
    $script:mode='ok';$script:received.Clear();$script:resolved.Clear()
    Save-WayrillInstallerResources $pins 9 (Join-Path $fixture 'chinese') | Out-Null
    Assert-Resource (@($script:received|Where-Object {$_ -notlike 'https://github.com/fixture/cn/*'}).Count -eq 0) 'Selection downloaded the wrong datasets.'
    Assert-Resource ($script:received.Count -eq 4 -and $script:resolved.Count -eq 1) 'Selection omitted data/checksums or resolved an unselected source.'
    foreach ($change in @(
        {param($p) $p.routingData.files[0].path='../escape.dat'},
        {param($p) $p.routingData.files[0].sourceRepository='http://github.com/fixture/ru'},
        {param($p) $p.routingData.files[0].sourceRepository='https://user:password@github.com/fixture/ru'},
        {param($p) $p.routingData.files[1].path=$p.routingData.files[0].path},
        {param($p) $p.routingData.files=@($p.routingData.files|Select-Object -Skip 1)}
    )) {
        $bad=$pins|ConvertTo-Json -Depth 5|ConvertFrom-Json
        & $change $bad
        $script:received.Clear();$script:resolved.Clear()
        Expect-ResourceFailure { Save-WayrillInstallerResources $bad 15 (Join-Path $fixture 'invalid') } 'Malformed resource metadata was accepted.'
        Assert-Resource ($script:received.Count -eq 0 -and $script:resolved.Count -eq 0) 'Invalid metadata reached the network.'
    }
    Expect-ResourceFailure { Get-WayrillInstallerResourcePlan $pins 16 } 'Invalid selection was accepted.'
    foreach($line in @(($script:hashes.one+'  geoip.dat'),($script:hashes.one+' *geoip.dat'),($script:hashes.one+'  release/geoip.dat'))){
        Assert-Resource ((Read-WayrillResourceChecksum $line 'geoip.dat') -eq $script:hashes.one) 'A supported upstream checksum format was rejected.'
    }
    foreach($line in @('invalid',($script:hashes.one+'  geosite.dat'),($script:hashes.one+"  geoip.dat`n"+$script:hashes.two+'  geoip.dat'))){
        Expect-ResourceFailure { Read-WayrillResourceChecksum $line 'geoip.dat' } 'An invalid checksum was accepted.'
    }
    # Exercise the actual HTTP redirect/stream handling without relying on an
    # Internet connection or replacing it with a second implementation.
    Set-Item -Path Function:Get-WayrillLatestResourceRelease -Value $latestResolver
    Set-Item -Path Function:Receive-WayrillResourceFile -Value $receiver
    $script:response=[pscustomobject]@{StatusCode=302;Headers=@{Location='/fixture/ru/releases/tag/two'};ResponseUri=[Uri]'https://example.invalid/data';ContentLength=3}
    $script:response|Add-Member ScriptMethod Dispose {}
    $script:response|Add-Member ScriptMethod GetResponseStream { [IO.MemoryStream]::new($script:networkBytes) }
    function New-WayrillResourceRequest([string]$Url) {
        $request=[pscustomobject]@{AllowAutoRedirect=$true}
        $request|Add-Member ScriptMethod GetResponse { $script:response }
        $request|Add-Member ScriptMethod Abort {}
        return $request
    }
    Assert-Resource ((Get-WayrillLatestResourceRelease 'https://github.com/fixture/ru') -eq 'https://github.com/fixture/ru/releases/download/two') 'Latest redirect did not select its actual release.'
    foreach($location in @('http://github.com/fixture/ru/releases/tag/two','https://github.com/another/repo/releases/tag/two','/fixture/ru/releases/tag/two?query','/fixture/ru/releases/tag/')){
        $script:response.Headers.Location=$location
        Expect-ResourceFailure { Get-WayrillLatestResourceRelease 'https://github.com/fixture/ru' } 'An invalid latest-release redirect was accepted.'
    }
    $script:response.StatusCode=200;$script:response.Headers.Location='/fixture/ru/releases/tag/two'
    Expect-ResourceFailure { Get-WayrillLatestResourceRelease 'https://github.com/fixture/ru' } 'A non-redirect was accepted as a latest release.'
    $script:networkBytes=[byte[]]@(1,2,3);$script:response.ContentLength=3
    Receive-WayrillResourceFile 'https://example.invalid/data' (Join-Path $fixture 'stream.dat') -MaxBytes 4
    Assert-Resource ((Get-Item -LiteralPath (Join-Path $fixture 'stream.dat')).Length -eq 3) 'A valid bounded response was lost.'
    $script:response.ContentLength=5
    Expect-ResourceFailure { Receive-WayrillResourceFile 'https://example.invalid/data' (Join-Path $fixture 'header-limit.dat') -MaxBytes 4 } 'An oversized response header was ignored.'
    Assert-Resource (-not(Test-Path -LiteralPath (Join-Path $fixture 'header-limit.dat'))) 'An oversized response opened its output file.'
    $script:response.ContentLength=-1;$script:networkBytes=[byte[]]@(1,2,3,4,5)
    Expect-ResourceFailure { Receive-WayrillResourceFile 'https://example.invalid/data' (Join-Path $fixture 'stream-limit.dat') -MaxBytes 4 } 'An oversized unknown-length stream was accepted.'
    $script:networkBytes=[byte[]]@()
    Expect-ResourceFailure { Receive-WayrillResourceFile 'https://example.invalid/data' (Join-Path $fixture 'empty.dat') } 'An empty response was accepted.'
    [ordered]@{passed=$true;assertions=$script:checks;cases=@('offline-base','latest-release','selected-only','interruption','retry','release-rollover','cache-refresh','integrity','upstream-checksums','invalid-metadata')}|ConvertTo-Json -Compress
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if ((Split-Path $resolved -Parent) -ne [IO.Path]::GetFullPath($FixtureParent).TrimEnd('\') -or (Split-Path $resolved -Leaf) -notmatch '^wayrill-resources-[a-f0-9]{32}$') { throw 'Unsafe resource fixture cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
