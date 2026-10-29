# Build fixtures remain pinned; installation resolves current upstream releases.
function Get-WayrillInstallerResourcePlan($Dependencies,[int]$Mask) {
    if ($Mask -lt 0 -or $Mask -gt 15) { throw 'Invalid resource selection.' }
    $seen=@{}
    $plan=@()
    foreach ($entry in $Dependencies.routingData.files) {
        if ($entry.path -notmatch '^(ru|ir|cn)-(geoip|geosite)\.dat$' -or $seen.ContainsKey($entry.path)) { throw 'Invalid optional resource filename.' }
        $prefix=$Matches[1];$asset=$Matches[2]+'.dat'
        $seen[$entry.path]=$true
        if ($entry.sourceRepository -notmatch '^https://github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$') { throw 'Invalid resource repository.' }
        $flag=switch ($prefix) { ru {2} ir {4} cn {8} }
        if (($Mask -band $flag) -ne 0) { $plan += [pscustomobject]@{path=$entry.path;asset=$asset;repository=$entry.sourceRepository} }
    }
    foreach ($prefix in @('ru','ir','cn')) {
        foreach ($kind in @('geoip','geosite')) {
            if (-not $seen.ContainsKey($prefix+'-'+$kind+'.dat')) { throw 'Incomplete optional resource manifest.' }
        }
    }
    return $plan
}

function New-WayrillResourceRequest([string]$Url) {
    $uri=$null
    if (-not [Uri]::TryCreate($Url,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Fragment) { throw 'Resource downloads require HTTPS.' }
    [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $request=[Net.HttpWebRequest]::Create($uri)
    $request.Proxy=[Net.WebRequest]::GetSystemWebProxy()
    $request.Proxy.Credentials=[Net.CredentialCache]::DefaultNetworkCredentials
    $request.AutomaticDecompression=[Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
    $request.CachePolicy=[Net.Cache.RequestCachePolicy]::new([Net.Cache.RequestCacheLevel]::Reload)
    $request.UserAgent='Wayrill-Setup'
    $request.Timeout=30000
    $request.ReadWriteTimeout=30000
    return $request
}

function Get-WayrillLatestResourceRelease([string]$Repository) {
    $request=New-WayrillResourceRequest ($Repository+'/releases/latest')
    $request.AllowAutoRedirect=$false
    $response=$null
    try {
        $response=$request.GetResponse()
        $location=[Uri]::new([Uri]$Repository,$response.Headers['Location'])
        $prefix=$Repository+'/releases/tag/'
        if ([int]$response.StatusCode -notin @(301,302,303,307,308) -or $location.Scheme -ne 'https' -or $location.UserInfo -or $location.Query -or $location.Fragment -or -not $location.AbsoluteUri.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or $location.AbsoluteUri.Length -eq $prefix.Length) { throw ('Cannot resolve the latest resource release: '+$Repository) }
        return $Repository+'/releases/download/'+$location.AbsoluteUri.Substring($prefix.Length)
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Abort()
    }
}

function Receive-WayrillResourceFile([string]$Url,[string]$Destination,[long]$MaxBytes=128MB) {
    $request=New-WayrillResourceRequest $Url
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $response=$null;$inputStream=$null;$outputStream=$null
    try {
        $response=$request.GetResponse()
        if ($response.ResponseUri.Scheme -ne 'https') { throw 'Resource redirected away from HTTPS.' }
        if ($response.ContentLength -gt $MaxBytes) { throw 'Resource download exceeds the size limit.' }
        $inputStream=$response.GetResponseStream()
        $outputStream=[IO.File]::Open($Destination,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $buffer=New-Object byte[] 65536
        $total=0L
        while (($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
            $total+=$count
            if ($clock.Elapsed.TotalMinutes -gt 10) { throw 'Resource download timed out.' }
            if ($total -gt $MaxBytes) { throw 'Resource download exceeds the size limit.' }
            $outputStream.Write($buffer,0,$count)
        }
        if ($total -eq 0) { throw 'Resource download is empty.' }
    } finally {
        foreach ($item in @($outputStream,$inputStream,$response)) { if ($null -ne $item) { $item.Dispose() } }
        $request.Abort()
    }
}

function Read-WayrillResourceChecksum([string]$Text,[string]$Asset) {
    if ($Text.Trim() -notmatch '\A(?<hash>[a-fA-F0-9]{64})[ \t]+\*?(?<file>[^\r\n]+)\z' -or [IO.Path]::GetFileName($Matches.file.Trim()) -cne $Asset) { throw ('Invalid upstream checksum: '+$Asset) }
    return $Matches.hash
}

function Save-WayrillInstallerResources($Dependencies,[int]$Mask,[string]$Destination) {
    $plan=@(Get-WayrillInstallerResourcePlan $Dependencies $Mask)
    if (-not $plan.Count) { return }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    if ((Get-Item -LiteralPath $Destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Resource staging directory is a reparse point.' }
    $releases=@{}
    foreach ($entry in $plan) {
        # Resolve once per provider so GeoIP, GeoSite and their checksums belong
        # to one current release, even if upstream publishes during the download.
        if (-not $releases.ContainsKey($entry.repository)) { $releases[$entry.repository]=Get-WayrillLatestResourceRelease $entry.repository }
        $url=$releases[$entry.repository]+'/'+$entry.asset
        $target=Join-Path $Destination $entry.path
        $temporary=$target+'.partial'
        $checksum=$target+'.sha256sum.partial'
        try {
            Receive-WayrillResourceFile -Url ($url+'.sha256sum') -Destination $checksum -MaxBytes 4096
            $hash=Read-WayrillResourceChecksum ([IO.File]::ReadAllText($checksum)) $entry.asset
            if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ieq $hash) {
                Write-Output ('Already downloaded: '+$entry.path)
                continue
            }
            Write-Output ('Downloading latest '+$entry.path)
            Receive-WayrillResourceFile -Url $url -Destination $temporary
            if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ine $hash) { throw ('Resource integrity check failed: '+$entry.path) }
            Move-Item -LiteralPath $temporary -Destination $target -Force
        } finally {
            foreach ($partial in @($temporary,$checksum)) { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force } }
        }
    }
}
