# Optional installer data uses immutable, size/hash-pinned release assets.
function Get-WayrillInstallerResourcePlan($Dependencies,[int]$Mask) {
    if ($Mask -lt 0 -or $Mask -gt 15) { throw 'Invalid resource selection.' }
    $seen=@{}
    $plan=@()
    foreach ($entry in $Dependencies.routingData.files) {
        if ($entry.path -notmatch '^(ru|ir|cn)-(geoip|geosite)\.dat$' -or $seen.ContainsKey($entry.path)) { throw 'Invalid optional resource filename.' }
        $seen[$entry.path]=$true
        $flag=switch ($entry.path.Substring(0,2)) { ru {2} ir {4} cn {8} }
        $url=$null
        if (-not [Uri]::TryCreate($entry.sourceUrl,[UriKind]::Absolute,[ref]$url) -or $url.Scheme -ne 'https' -or $url.UserInfo -or $entry.bytes -isnot [ValueType] -or $entry.bytes -le 0 -or $entry.bytes -gt 256MB -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $entry.sourceSha256 -ine $entry.sha256) { throw 'Invalid optional resource pin.' }
        if (($Mask -band $flag) -ne 0) { $plan += $entry }
    }
    foreach ($prefix in @('ru','ir','cn')) {
        foreach ($kind in @('geoip','geosite')) {
            if (-not $seen.ContainsKey($prefix+'-'+$kind+'.dat')) { throw 'Incomplete optional resource manifest.' }
        }
    }
    return $plan
}

function Receive-WayrillResourceFile([string]$Url,[string]$Destination,[long]$Bytes) {
    [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $request=[Net.HttpWebRequest]::Create($Url)
    $request.Proxy=[Net.WebRequest]::GetSystemWebProxy()
    $request.Proxy.Credentials=[Net.CredentialCache]::DefaultNetworkCredentials
    $request.AutomaticDecompression=[Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
    $request.UserAgent='Wayrill-Setup'
    $request.Timeout=30000
    $request.ReadWriteTimeout=30000
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $response=$null;$inputStream=$null;$outputStream=$null
    try {
        $response=$request.GetResponse()
        if ($response.ResponseUri.Scheme -ne 'https') { throw 'Resource redirected away from HTTPS.' }
        if ($response.ContentLength -ge 0 -and $response.ContentLength -ne $Bytes) { throw 'Resource download size differs from its pin.' }
        $inputStream=$response.GetResponseStream()
        $outputStream=[IO.File]::Open($Destination,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $buffer=New-Object byte[] 65536
        $total=0L
        while (($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
            $total+=$count
            if ($clock.Elapsed.TotalMinutes -gt 10) { throw 'Resource download timed out.' }
            if ($total -gt $Bytes) { throw 'Resource download exceeds its pinned size.' }
            $outputStream.Write($buffer,0,$count)
        }
        if ($total -ne $Bytes) { throw 'Resource download ended before its pinned size.' }
    } finally {
        foreach ($item in @($outputStream,$inputStream,$response)) { if ($null -ne $item) { $item.Dispose() } }
        $request.Abort()
    }
}

function Save-WayrillInstallerResources($Dependencies,[int]$Mask,[string]$Destination) {
    $plan=@(Get-WayrillInstallerResourcePlan $Dependencies $Mask)
    if (-not $plan.Count) { return }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    if ((Get-Item -LiteralPath $Destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Resource staging directory is a reparse point.' }
    foreach ($entry in $plan) {
        $target=Join-Path $Destination $entry.path
        if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Get-Item -LiteralPath $target).Length -eq $entry.bytes -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ieq $entry.sha256) {
            Write-Output ('Already downloaded: '+$entry.path)
            continue
        }
        $temporary=$target+'.partial'
        try {
            Write-Output ('Downloading '+$entry.path+' ('+[Math]::Round($entry.bytes/1MB,1)+' MiB)')
            Receive-WayrillResourceFile -Url $entry.sourceUrl -Destination $temporary -Bytes $entry.bytes
            if ((Get-Item -LiteralPath $temporary).Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ine $entry.sha256) { throw ('Resource integrity check failed: '+$entry.path) }
            Move-Item -LiteralPath $temporary -Destination $target -Force
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        }
    }
}
