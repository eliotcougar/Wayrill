param([switch]$SkipTests,[switch]$BuildOnly,[string]$CurlPath,[Parameter(Mandatory)][string]$TunOutputDirectory,[Parameter(Mandatory)][string]$MainOutputDirectory)
$ErrorActionPreference='Stop'
$taskProject=Split-Path $PSScriptRoot -Parent
$taskCacheRoot=Join-Path $taskProject '.tools'
$TunOutputDirectory=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($TunOutputDirectory)
$MainOutputDirectory=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($MainOutputDirectory)
function Invoke-MaintainedCoreTests([string]$Source, [string[]]$Files, [hashtable]$Controls = @{}) {
    # Discover cases from the extension's maintained test files. Do not make an
    # app build depend on unrelated vendor timing/throughput assertions.
    $taskNames=@($Controls.Keys)+@(foreach($taskFile in $Files) {
        foreach($taskMatch in [regex]::Matches([IO.File]::ReadAllText($taskFile), '(?m)^func ((?:Test|Fuzz)[A-Za-z0-9_]+)\(')) {
            $taskMatch.Groups[1].Value
        }
    }) | Sort-Object -Unique
    if(-not $taskNames){throw 'No maintained Xray regression tests were discovered.'}
    $taskPackages=@(@($Controls.Values)+@($Files | ForEach-Object {
        './'+[IO.Path]::GetRelativePath($Source,(Split-Path $_ -Parent)).Replace('\','/')
    }) | Sort-Object -Unique)
    $taskPattern='^('+($taskNames -join '|')+')$'
    Write-Host "Checking $(@($taskNames).Count) maintained Xray regressions in $($taskPackages.Count) packages."
    # Compile test packages explicitly so build tracing sees them without the
    # test-runner flags used below. Keep binaries outside corresponding source.
    $taskTestOutput=Join-Path $taskCacheRoot 'core-test-binaries'
    New-Item -ItemType Directory -Path $taskTestOutput -Force | Out-Null
    & $taskGo test -c -mod=readonly -o ($taskTestOutput+[IO.Path]::DirectorySeparatorChar) @taskPackages
    if($LASTEXITCODE -ne 0){throw 'Maintained Xray test compilation failed.'}
    & $taskGo test -mod=readonly @taskPackages -run $taskPattern -count=1
    if($LASTEXITCODE -ne 0){throw 'Maintained Xray regression tests failed.'}
}
function Reset-CoreSource([string]$Parent, [string]$Commit) {
    $taskParent=[IO.Path]::GetFullPath($Parent)
    $taskDirectory=[IO.Path]::GetFullPath((Join-Path $taskParent "Xray-core-$Commit"))
    if ((Split-Path $taskParent -Parent) -ne [IO.Path]::GetFullPath($taskCacheRoot) -or
        (Split-Path $taskParent -Leaf) -notin @('main-source','tun-source') -or
        (Split-Path $taskDirectory -Parent) -ne $taskParent) { throw 'Invalid generated core source path.' }
    if (Test-Path -LiteralPath $taskParent) {
        if ((Get-Item -LiteralPath $taskParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Core source cache must not be a reparse point.' }
    }
    if (Test-Path -LiteralPath $taskDirectory) {
        if ((Resolve-Path -LiteralPath $taskDirectory).Path -ne $taskDirectory -or
            (Get-Item -LiteralPath $taskDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
            @(Get-ChildItem -LiteralPath $taskDirectory -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Core source cache contains an unexpected path or reparse point.' }
        Remove-Item -LiteralPath $taskDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $taskParent -Force | Out-Null
    return $taskDirectory
}
New-Item -ItemType Directory -Path $taskCacheRoot -Force | Out-Null
# Serialize the shared source cache and generated worker-integrity manifest.
$taskBuildLease=[IO.File]::Open((Join-Path $taskCacheRoot 'tun-core-build.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$taskOldGoCache=$env:GOCACHE;$taskOldGoMod=$env:GOMODCACHE;$taskOldCGO=$env:CGO_ENABLED;$taskOldGoProcs=$env:GOMAXPROCS
try {
    $taskPin=(Get-Content (Join-Path $taskProject "service\dependencies.json") -Raw | ConvertFrom-Json).xray
    $taskGoRoot=Join-Path $taskCacheRoot ('go-sdk\go'+$taskPin.build.goVersion)
    $taskGo=Join-Path $taskGoRoot 'go\bin\go.exe'
    $taskDownloads=Join-Path $taskCacheRoot 'downloads\tun'
    $taskGoZip=Join-Path $taskDownloads ('go'+$taskPin.build.goVersion+'.zip')
    $taskCurl=& (Join-Path $PSScriptRoot 'Get-Curl.ps1') -Path $CurlPath
    $taskCommit=$taskPin.sourceCommit
    if ($taskCommit -ne '0afec66085a85191e9dd2a4a6646c7c9a94688d1') { throw 'Review the TUN extension when updating Xray.' }
    $taskSourceZip=Join-Path $taskDownloads ('xray-source-'+$taskCommit+'.zip')
    New-Item -ItemType Directory -Path $taskDownloads,$TunOutputDirectory -Force | Out-Null
    if(-not (Test-Path $taskGoZip)) {
        & $taskCurl --fail --location --silent --show-error ('https://go.dev/dl/go'+$taskPin.build.goVersion+'.windows-amd64.zip') --output $taskGoZip
        if($LASTEXITCODE -ne 0){throw 'Go download failed.'}
    }
    if((Get-FileHash $taskGoZip).Hash -ne $taskPin.build.goArchiveSha256){throw 'Go archive integrity failure.'}
    if(-not (Test-Path $taskGo)){Expand-Archive $taskGoZip -DestinationPath $taskGoRoot -Force}
    if(-not(Test-Path $taskSourceZip)) {
        & $taskCurl --fail --location --silent --show-error "https://codeload.github.com/XTLS/Xray-core/zip/$taskCommit" --output $taskSourceZip
        if($LASTEXITCODE -ne 0){throw 'Xray source download failed.'}
    }
    if((Get-FileHash $taskSourceZip).Hash -ne $taskPin.sourceArchiveSha256){throw 'Pinned Xray source integrity failure.'}
    $taskSourceParent=Join-Path $taskCacheRoot 'tun-source'
    $taskSource=Reset-CoreSource $taskSourceParent $taskCommit
    # This is a generated cache, not a checkout. Overlaying an archive would retain
    # deleted worker extensions and could compile or ship them in the next build.
    Expand-Archive $taskSourceZip -DestinationPath $taskSourceParent -Force
    # Both upstream UDP repairs are included in this base; apply only app integrations.
    $taskGit=(Get-Command git -ErrorAction Stop).Source
    $taskFakePatch=Join-Path $taskProject $taskPin.build.fakeDnsPatch
    if((Get-FileHash -LiteralPath $taskFakePatch).Hash -ne $taskPin.build.fakeDnsPatchSha256){throw 'Shared FakeDNS source integrity failure.'}
    # This extracted source is not part of the enclosing Wayrill Git worktree.
    # Otherwise git apply can silently skip every path when invoked below .tools/.
    $taskOldGitCeiling=$env:GIT_CEILING_DIRECTORIES
    try {
        $env:GIT_CEILING_DIRECTORIES=$taskSourceParent
        & $taskGit -C $taskSource apply --check --whitespace=error-all $taskFakePatch
        if($LASTEXITCODE -ne 0){throw 'Shared FakeDNS extension no longer applies to the pinned source.'}
        & $taskGit -C $taskSource apply --whitespace=error-all $taskFakePatch
        if($LASTEXITCODE -ne 0){throw 'Cannot apply the shared FakeDNS extension.'}
    } finally {
        $env:GIT_CEILING_DIRECTORIES=$taskOldGitCeiling
    }
    # App-owned executable initialization uses Xray's public listener hook.
    # Copy before both builds; never change the upstream SOCKS package for buffers.
    $taskInitializers=@(Get-ChildItem (Join-Path $taskProject 'service\core-init') -Filter '*.go' -File)
    if($taskInitializers.Count -ne @($taskPin.build.initializerFiles.PSObject.Properties).Count){throw 'Unreviewed Xray initializer file set.'}
    foreach($taskInitializer in $taskInitializers) {
        if((Get-FileHash -LiteralPath $taskInitializer.FullName).Hash -ne $taskPin.build.initializerFiles.($taskInitializer.Name)){throw 'Xray initializer source integrity failure.'}
        Copy-Item -LiteralPath $taskInitializer.FullName -Destination (Join-Path $taskSource ('main\wayrill_init_'+$taskInitializer.Name))
    }
    # Keep each compiled variant intact, including while a build tracer reads it.
    $taskMainSource=Reset-CoreSource (Join-Path $taskCacheRoot 'main-source') $taskCommit
    Copy-Item -LiteralPath $taskSource -Destination $taskMainSource -Recurse
    $taskInitializerTests=@($taskInitializers | Where-Object Name -like '*_test.go' | ForEach-Object {Join-Path $taskMainSource ('main/wayrill_init_'+$_.Name)})
    $taskMainTests=@(foreach($taskMatch in [regex]::Matches([IO.File]::ReadAllText($taskFakePatch), '(?m)^\+\+\+ b/([^\r\n]+_test\.go)\r?$')) {
        Join-Path $taskMainSource $taskMatch.Groups[1].Value
    })+$taskInitializerTests
    $env:GOCACHE=Join-Path $taskCacheRoot 'go-cache';$env:GOMODCACHE=Join-Path $taskCacheRoot 'go-modules';$env:CGO_ENABLED='0';$env:GOMAXPROCS='8'
    if((& $taskGo version) -notmatch ('^go version go'+[regex]::Escape($taskPin.build.goVersion)+' windows/amd64$')){throw 'Pinned Xray Go toolchain mismatch.'}
    New-Item -ItemType Directory -Path $MainOutputDirectory -Force | Out-Null
    Push-Location $taskMainSource
    try {
        # Preserve the upstream Lua DNS query contract for our context changes.
        if(-not $SkipTests){Invoke-MaintainedCoreTests -Source $taskMainSource -Files $taskMainTests -Controls @{TestDNSScriptQuery='./app/dns';TestDialUDPBindFallback='./transport/internet'}}
        & $taskGo build -mod=readonly -trimpath -buildvcs=false -ldflags ('-s -w -X github.com/xtls/xray-core/core.build='+$taskPin.build.tag) -o (Join-Path $MainOutputDirectory 'xray.exe') ./main
        if($LASTEXITCODE -ne 0){throw 'Patched Xray main core build failed.'}
    }finally{Pop-Location}
    if((Get-FileHash (Join-Path $MainOutputDirectory 'xray.exe')).Hash -ne $taskPin.executableSha256){throw 'Patched Xray executable differs from its audited pin.'}
    # Package the exact main source before private attribution/adapter changes.
    if(-not $BuildOnly) {
        Compress-Archive -LiteralPath $taskMainSource -DestinationPath (Join-Path $MainOutputDirectory 'source.zip') -Force
        Copy-Item -LiteralPath $taskFakePatch -Destination $MainOutputDirectory -Force
    }
    $taskHandler=Join-Path $taskSource 'proxy\tun\handler.go'
    $taskText=[IO.File]::ReadAllText($taskHandler)
    $taskAnchor="`tctx = session.ContextWithInbound(ctx, &inbound)"
    if([regex]::Matches($taskText,[regex]::Escape($taskAnchor)).Count -ne 1){throw 'Pinned TUN attribution hook has moved.'}
    $taskHook=@'
	email, err := wayrillProcessIdentity(ctx, source, destination, &inbound)
	if err != nil {
		errors.LogError(ctx, "TUN application attribution rejected connection: ", err)
		return
	}
	inbound.User.Email = email

'@
    # Literal tabs in the source hook, never shell command interpolation.
    $taskHook=$taskHook.Replace('\t',"`t")
    [IO.File]::WriteAllText($taskHandler,$taskText.Replace($taskAnchor,$taskHook+"`n"+$taskAnchor))
    Get-ChildItem (Join-Path $taskProject 'service\tun-core') -Filter '*.go' | Copy-Item -Destination (Join-Path $taskSource 'proxy\tun') -Force
    # ICMP passthrough shares the new lightweight stack's owned lifetime.
    $taskStack=Join-Path $taskSource 'proxy\tun\stack.go'
    $taskStackText=[IO.File]::ReadAllText($taskStack)
    foreach($taskReplacement in @(
        @("`tctx context.Context", "`tctx context.Context`n`ticmp *wayrillICMP"),
        @("`treturn s, nil`n}`n`n// Start is called", "`tif owner, ok := handler.(*Handler); ok {`n`t`ts.icmp = newWayrillICMP(ctx, owner)`n`t}`n`treturn s, nil`n}`n`n// Start is called"),
        @("func (s *stack) Close() error {", "func (s *stack) Close() error {`n`tif s.icmp != nil {`n`t`ts.icmp.close()`n`t}"),
        @("`t// what was put together may be of two packets", "`tif s.icmp != nil && s.wayrillEcho(b, p) {`n`t`treturn`n`t}`n`t// what was put together may be of two packets")
    )) {
        if([regex]::Matches($taskStackText,[regex]::Escape($taskReplacement[0])).Count -ne 1){throw 'Pinned lightweight TUN ICMP hook has moved.'}
        $taskStackText=$taskStackText.Replace($taskReplacement[0],$taskReplacement[1])
    }
    [IO.File]::WriteAllText($taskStack,$taskStackText)
    # Retain all native tables and resolver settings. Packet-stack gateways and
    # process-local DNS exclusions/controllers still initialize on every worker.
    $taskWindowsTun=Join-Path $taskSource 'proxy\tun\tun_windows.go'
    $taskWindowsText=[IO.File]::ReadAllText($taskWindowsTun)
    foreach($taskReplacement in @(
        @("retryTimes++`n`tfor _, family := range []winipcfg.AddressFamily{windows.AF_INET, windows.AF_INET6} {", "retryTimes++`n`tfor _, family := range []winipcfg.AddressFamily{windows.AF_INET, windows.AF_INET6} {`n`t`tif wayrillReuseAdapterSettings() {`n`t`t`tcontinue`n`t`t}"),
        @("if address4 || address6 {`n`t`tif err := disableDNSRegistration", "if !wayrillReuseAdapterSettings() && (address4 || address6) {`n`t`tif err := disableDNSRegistration"),
        @("if len(dns) > 0 || route4 || route6 {`n`t`tif err := flushDNSCache", "if !wayrillReuseAdapterSettings() && (len(dns) > 0 || route4 || route6) {`n`t`tif err := flushDNSCache")
    )) {
        if([regex]::Matches($taskWindowsText,[regex]::Escape($taskReplacement[0])).Count -ne 1){throw 'Pinned TUN native-settings hook has moved.'}
        $taskWindowsText=$taskWindowsText.Replace($taskReplacement[0],$taskReplacement[1])
    }
    [IO.File]::WriteAllText($taskWindowsTun,$taskWindowsText)
    Get-ChildItem (Join-Path $taskProject 'service\core-control') -Filter '*.go' | ForEach-Object { Copy-Item $_.FullName -Destination (Join-Path $taskSource ('main\wayrill_control_'+$_.Name)) -Force }
    $taskResources=Join-Path $taskSource 'resources'
    New-Item -ItemType Directory -Path $taskResources -Force | Out-Null
    if(-not $SkipTests) {
        & (Join-Path $PSScriptRoot 'Get-ResourceAssets.ps1') -CurlPath $taskCurl
        foreach($taskAssetName in @('geosite.dat','geoip.dat')) {
            Copy-Item -LiteralPath (Join-Path $taskProject ('service/resource-assets/'+$taskAssetName)) -Destination $taskResources -Force
        }
    }
    Push-Location $taskSource
    try {
        $taskRuntimePackages=@(& $taskGo list -mod=readonly -deps ./main)
        if($LASTEXITCODE -ne 0){throw 'Cannot verify TUN runtime dependencies.'}
        if(@($taskRuntimePackages | Where-Object { $_ -match '^gvisor\.dev/gvisor(?:/|$)' }).Count){throw 'Obsolete gVisor code is linked into the TUN runtime.'}
        if(-not $SkipTests){
            $taskTunTests=@(Get-ChildItem (Join-Path $taskProject 'service/tun-core') -Filter '*_test.go' | ForEach-Object {Join-Path $taskSource ('proxy/tun/'+$_.Name)})
            $taskTunTests+=@(Get-ChildItem (Join-Path $taskProject 'service/core-control') -Filter '*_test.go' | ForEach-Object {Join-Path $taskSource ('main/wayrill_control_'+$_.Name)})
            $taskTunInitializers=@($taskInitializers | Where-Object Name -like '*_test.go' | ForEach-Object {Join-Path $taskSource ('main/wayrill_init_'+$_.Name)})
            Invoke-MaintainedCoreTests -Source $taskSource -Files ($taskTunTests+$taskTunInitializers)
        }
        & $taskGo build -mod=readonly -trimpath -buildvcs=false -ldflags '-s -w' -o (Join-Path $TunOutputDirectory 'wayrill-tun.exe') ./main
        if($LASTEXITCODE -ne 0){throw 'TUN worker build failed.'}
    }finally{Pop-Location}
    $taskHash=(Get-FileHash (Join-Path $TunOutputDirectory 'wayrill-tun.exe')).Hash.ToLowerInvariant()
    if($BuildOnly) {
        $taskManifest=Get-Content (Join-Path $taskProject 'service/daemon/src/tun-core-manifest.json') -Raw | ConvertFrom-Json
        if($taskManifest.sha256 -ne $taskHash -or $taskManifest.sourceCommit -ne $taskCommit -or $taskManifest.goVersion -ne $taskPin.build.goVersion) { throw 'TUN worker differs from its audited pin.' }
        Write-Host "Both pinned Xray cores built; packaging and manifest updates were not requested."
        return
    }
    [ordered]@{sha256=$taskHash;sourceCommit=$taskCommit;goVersion=$taskPin.build.goVersion} | ConvertTo-Json | Set-Content (Join-Path $taskProject 'service\daemon\src\tun-core-manifest.json') -Encoding utf8NoBOM
    Copy-Item (Join-Path $taskSource 'LICENSE'),(Join-Path $taskProject 'service\tun-core\wayrill_windows.go') -Destination $TunOutputDirectory -Force
    $taskWintun=Get-ChildItem (Join-Path $taskCacheRoot 'service-deps\xray') -Filter 'wintun.dll' -Recurse -File | Select-Object -First 1
    if (-not $taskWintun -or (Get-FileHash $taskWintun.FullName).Hash -ne 'E5DA8447DC2C320EDC0FC52FA01885C103DE8C118481F683643CACC3220DAFCE') { throw 'Missing pinned Wintun DLL.' }
    Copy-Item $taskWintun.FullName -Destination $TunOutputDirectory -Force
    # Corresponding patched source is shipped for MPL changes and reproducibility.
    foreach($taskAssetName in @('geosite.dat','geoip.dat')) {
        $taskCopiedAsset=[IO.Path]::GetFullPath((Join-Path $taskResources $taskAssetName))
        if ((Split-Path $taskCopiedAsset -Parent) -ne [IO.Path]::GetFullPath($taskResources)) {throw 'Invalid test asset cleanup path.'}
        if(Test-Path -LiteralPath $taskCopiedAsset){Remove-Item -LiteralPath $taskCopiedAsset -Force}
    }
    Compress-Archive -LiteralPath $taskSource -DestinationPath (Join-Path $TunOutputDirectory 'source.zip') -Force
    Write-Host "Pinned TUN attribution worker: $taskHash"
} finally {
    $env:GOCACHE=$taskOldGoCache;$env:GOMODCACHE=$taskOldGoMod;$env:CGO_ENABLED=$taskOldCGO;$env:GOMAXPROCS=$taskOldGoProcs
    $taskBuildLease.Dispose()
}
