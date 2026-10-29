param([string]$FixtureParent=[IO.Path]::GetTempPath())
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'service\scripts\Resource-Downloads.ps1')
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
    $content=[Text.Encoding]::UTF8.GetBytes('pinned fixture')
    $sample=Join-Path $fixture 'fixture.dat'
    [IO.File]::WriteAllBytes($sample,$content)
    $hash=(Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash
    $entries=@(foreach ($prefix in @('ru','ir','cn')) { foreach ($kind in @('geoip','geosite')) {
        [pscustomobject]@{path=$prefix+'-'+$kind+'.dat';bytes=$content.Length;sha256=$hash;sourceSha256=$hash;sourceUrl='https://example.invalid/'+$prefix+'-'+$kind+'.dat'}
    } })
    $pins=[pscustomobject]@{routingData=[pscustomobject]@{files=$entries}}
    $script:received=[Collections.Generic.List[string]]::new()
    $script:mode='ok'
    function Receive-WayrillResourceFile([string]$Url,[string]$Destination,[long]$Bytes) {
        $name=([Uri]$Url).Segments[-1]
        $script:received.Add($name)
        if ($script:mode -eq 'fail-second' -and $name -eq 'ru-geosite.dat') {
            [IO.File]::WriteAllText($Destination,'partial')
            throw 'Synthetic interrupted transfer'
        }
        if ($script:mode -eq 'corrupt') { [IO.File]::WriteAllText($Destination,'wrong');return }
        [IO.File]::WriteAllBytes($Destination,$content)
    }
    $stage=Join-Path $fixture 'download'
    Save-WayrillInstallerResources $pins 1 $stage | Out-Null
    Assert-Resource ($script:received.Count -eq 0 -and -not (Test-Path -LiteralPath $stage)) 'XTLS-only setup attempted a download.'
    $script:mode='fail-second'
    Expect-ResourceFailure { Save-WayrillInstallerResources $pins 3 $stage } 'An interrupted transfer succeeded.' '*Synthetic interrupted transfer*'
    Assert-Resource (Test-Path -LiteralPath (Join-Path $stage 'ru-geoip.dat')) 'A verified completed download was lost.'
    Assert-Resource (-not (Test-Path -LiteralPath (Join-Path $stage 'ru-geosite.dat'))) 'A partial download was published.'
    Assert-Resource (-not (Get-ChildItem -LiteralPath $stage -Filter '*.partial')) 'An interrupted temporary file was retained.'
    $script:received.Clear();$script:mode='ok'
    Save-WayrillInstallerResources $pins 3 $stage | Out-Null
    Assert-Resource ($script:received.Count -eq 1 -and $script:received[0] -eq 'ru-geosite.dat') 'Retry downloaded already verified files or unselected datasets.'
    $script:received.Clear()
    Save-WayrillInstallerResources $pins 3 $stage | Out-Null
    Assert-Resource ($script:received.Count -eq 0) 'Completed files were downloaded again.'
    $script:mode='corrupt'
    Expect-ResourceFailure { Save-WayrillInstallerResources $pins 9 (Join-Path $fixture 'corrupt') } 'Corrupt content was accepted.' '*Resource integrity check failed*'
    Assert-Resource (-not (Test-Path -LiteralPath (Join-Path $fixture 'corrupt\cn-geoip.dat'))) 'Corrupt data was published.'
    $script:mode='ok';$script:received.Clear()
    Save-WayrillInstallerResources $pins 9 (Join-Path $fixture 'chinese') | Out-Null
    Assert-Resource (($script:received -join ',') -eq 'cn-geoip.dat,cn-geosite.dat') 'Selection downloaded the wrong datasets.'
    foreach ($change in @(
        {param($p) $p.routingData.files[0].path='../escape.dat'},
        {param($p) $p.routingData.files[0].sourceUrl='http://example.invalid/data'},
        {param($p) $p.routingData.files[0].bytes=0},
        {param($p) $p.routingData.files[0].sha256='invalid'},
        {param($p) $p.routingData.files[0].sourceSha256=('0'*64)},
        {param($p) $p.routingData.files[1].path=$p.routingData.files[0].path},
        {param($p) $p.routingData.files=@($p.routingData.files|Select-Object -Skip 1)}
    )) {
        $bad=$pins|ConvertTo-Json -Depth 5|ConvertFrom-Json
        & $change $bad
        $script:received.Clear()
        Expect-ResourceFailure { Save-WayrillInstallerResources $bad 15 (Join-Path $fixture 'invalid') } 'Malformed resource pins were accepted.'
        Assert-Resource ($script:received.Count -eq 0) 'Invalid pins reached the downloader.'
    }
    Expect-ResourceFailure { Get-WayrillInstallerResourcePlan $pins 16 } 'Invalid selection was accepted.'
    [ordered]@{passed=$true;assertions=$script:checks;cases=@('offline-base','selected-only','interruption','retry','cache','integrity','invalid-pins')}|ConvertTo-Json -Compress
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if ((Split-Path $resolved -Parent) -ne [IO.Path]::GetFullPath($FixtureParent).TrimEnd('\') -or (Split-Path $resolved -Leaf) -notmatch '^wayrill-resources-[a-f0-9]{32}$') { throw 'Unsafe resource fixture cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
