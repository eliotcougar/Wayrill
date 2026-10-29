param([switch]$SkipTests,[string]$OutputDirectory,[string]$CurlPath)
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Use PowerShell 7 for the build scripts.' }
$taskProject=Split-Path $PSScriptRoot -Parent
$taskCacheRoot=Join-Path $taskProject '.tools'
$CurlPath=& (Join-Path $PSScriptRoot 'Get-Curl.ps1') -Path $CurlPath
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
& node (Join-Path $PSScriptRoot 'Check-CoreDefaults.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Embedded Xray defaults audit is stale.' }
if (-not $SkipTests) { & (Join-Path $PSScriptRoot 'Test-PackageCleanup.ps1') }
$taskService=Join-Path $taskProject 'service'
$taskDependencies=Get-Content -LiteralPath (Join-Path $taskService 'dependencies.json') -Raw | ConvertFrom-Json
$taskVersion=(Get-Content -LiteralPath (Join-Path $taskProject 'package.json') -Raw | ConvertFrom-Json).version
$taskServiceVersion=[regex]::Match([IO.File]::ReadAllText((Join-Path $taskService 'Cargo.toml')), '(?ms)^\[workspace\.package\]\s*.*?^version\s*=\s*"([^"\r\n]+)"').Groups[1].Value
if (-not $taskServiceVersion) { throw 'Service workspace version missing.' }
if (-not $OutputDirectory) { $OutputDirectory=Join-Path $taskCacheRoot 'installer-service' }
$taskFinalOutput=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$taskOutputParent=Split-Path $taskFinalOutput -Parent
if (-not $taskOutputParent -or $taskFinalOutput -eq [IO.Path]::GetFullPath($taskProject).TrimEnd('\') -or $taskFinalOutput -eq [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')) { throw 'Choose a dedicated service package directory.' }
# Replace only an empty directory or a package produced by this build. Unknown
# files and reparse points must never be removed as part of a rebuild.
if (Test-Path -LiteralPath $taskFinalOutput) {
    if ((Get-Item -LiteralPath $taskFinalOutput -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package output is a reparse point.' }
    $taskExistingFiles=@(Get-ChildItem -LiteralPath $taskFinalOutput -Recurse -Force)
    if (@($taskExistingFiles | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Package output contains a reparse point.' }
    $taskPreviousManifest=Join-Path $taskFinalOutput 'manifest.json'
    $taskOwnedFiles=@('manifest.json')
    if (Test-Path -LiteralPath $taskPreviousManifest) {
        $taskPreviousPackage=Get-Content -LiteralPath $taskPreviousManifest -Raw | ConvertFrom-Json
        if ($taskPreviousPackage.apiVersion -ne 1 -or -not $taskPreviousPackage.serviceVersion) { throw 'Output is not a Wayrill service package.' }
        $taskOwnedFiles+=@($taskPreviousPackage.files | ForEach-Object { $_.path.Replace('/','\') })
    }
    foreach ($taskFile in $taskExistingFiles | Where-Object { -not $_.PSIsContainer }) {
        if ($taskFile.FullName.Substring($taskFinalOutput.Length+1) -notin $taskOwnedFiles) { throw "Output contains an unowned file: $($taskFile.Name). Preserve it before rebuilding." }
    }
}
New-Item -ItemType Directory -Path $taskOutputParent -Force | Out-Null
$taskStageId=[Guid]::NewGuid().ToString('N')
$taskStage=Join-Path $taskOutputParent ('.wayrill-package-'+$taskStageId)
$taskOldPackage=Join-Path $taskOutputParent ('.wayrill-package-old-'+$taskStageId)
function Remove-PackageStage([string]$Path) {
    $taskResolvedStage=[IO.Path]::GetFullPath($Path)
    if ((Split-Path $taskResolvedStage -Parent) -ne $taskOutputParent -or (Split-Path $taskResolvedStage -Leaf) -notin @(('.wayrill-package-'+$taskStageId),('.wayrill-package-old-'+$taskStageId))) { throw 'Unsafe package staging cleanup path.' }
    if (Test-Path -LiteralPath $taskResolvedStage) {
        if ((Get-Item -LiteralPath $taskResolvedStage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or @(Get-ChildItem -LiteralPath $taskResolvedStage -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Staging cleanup found a reparse point.' }
        Remove-Item -LiteralPath $taskResolvedStage -Recurse -Force
    }
}
$OutputDirectory=$taskStage
$taskDownload=Join-Path $taskCacheRoot 'downloads\service'
$taskAssets=Join-Path $taskCacheRoot 'service-deps'
New-Item -ItemType Directory -Path $taskDownload,$taskAssets,$OutputDirectory -Force | Out-Null
$taskDependencyCache=@{}
try {
foreach ($taskName in @('xray','winDivert')) {
    $taskDependency=$taskDependencies.$taskName
    $taskZip=Join-Path $taskDownload ($taskName+'-'+$taskDependency.version+'.zip')
    $taskCache=Join-Path (Join-Path $taskAssets $taskName) $taskDependency.archiveSha256.ToLowerInvariant()
    if (-not (Test-Path -LiteralPath $taskCache) -and -not (Test-Path -LiteralPath $taskZip)) {
        if (-not (Test-Path -LiteralPath $CurlPath)) { throw 'Provide an OpenSSL curl-mingw executable with -CurlPath.' }
        & $CurlPath --fail --location --silent --show-error $taskDependency.url --output $taskZip
        if ($LASTEXITCODE -ne 0) { throw "$taskName download failed" }
    }
    $taskDependencyCache[$taskName]=& (Join-Path $PSScriptRoot 'Get-PinnedDependency.ps1') -Archive $taskZip -ArchiveHash $taskDependency.archiveSha256 -CacheRoot (Join-Path $taskAssets $taskName)
}
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'xray'),(Join-Path $OutputDirectory 'windivert') -Force | Out-Null
foreach ($taskFile in $taskDependencyCache.xray.Files) {
    $taskDestination=Join-Path (Join-Path $OutputDirectory 'xray') $taskFile.path
    New-Item -ItemType Directory -Path (Split-Path $taskDestination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskDependencyCache.xray.Root $taskFile.path) -Destination $taskDestination
}
if ((Get-FileHash -LiteralPath (Join-Path $OutputDirectory 'xray\xray.exe')).Hash -ne $taskDependencies.xray.officialExecutableSha256) { throw 'Official Xray base executable SHA-256 mismatch.' }
& (Join-Path $PSScriptRoot 'Build-Capture.ps1') -SkipTests:$SkipTests -OutputDirectory (Join-Path $OutputDirectory 'capture')
& (Join-Path $PSScriptRoot "Build-XrayCores.ps1") -SkipTests:$SkipTests -CurlPath $CurlPath -TunOutputDirectory (Join-Path $OutputDirectory "tun-core") -MainOutputDirectory (Join-Path $OutputDirectory "xray")
& (Join-Path $PSScriptRoot 'Check-Native.ps1') -Component service -SkipTests:$SkipTests -CurlPath $CurlPath
$taskPreviousRustFlags=$env:RUSTFLAGS
try {
    $env:RUSTFLAGS=($env:RUSTFLAGS+' -C target-feature=+crt-static').Trim()
    & cargo build --manifest-path (Join-Path $taskService 'Cargo.toml') --workspace --release --locked --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'Service release build failed' }
} finally { $env:RUSTFLAGS=$taskPreviousRustFlags }
Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc\release\wayrill-service.exe'),(Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc\release\wayrillctl.exe') -Destination $OutputDirectory -Force
if ((Get-FileHash -LiteralPath (Join-Path $OutputDirectory 'xray\xray.exe')).Hash -ne $taskDependencies.xray.executableSha256) { throw 'Patched Xray executable SHA-256 mismatch.' }
if ((Get-FileHash -LiteralPath (Join-Path $OutputDirectory 'xray\wintun.dll')).Hash -ne $taskDependencies.xray.wintunDllSha256) { throw 'Wintun DLL SHA-256 mismatch.' }
$taskRoutingAssets=Join-Path $taskService 'routing-assets'
foreach($taskResource in $taskDependencies.resourceData.files) {
    $taskResourceFile=Join-Path (Join-Path $taskService 'resource-assets') $taskResource.path
    if((Get-FileHash -LiteralPath $taskResourceFile -Algorithm SHA256).Hash -ne $taskResource.sha256 -or (Get-Item -LiteralPath $taskResourceFile).Length -ne $taskResource.bytes) { throw 'Full resource data integrity check failed.' }
    Copy-Item -LiteralPath $taskResourceFile -Destination (Join-Path $OutputDirectory 'xray') -Force
}
$taskRoutingNotices=Join-Path $OutputDirectory 'routing-assets'
New-Item -ItemType Directory -Path $taskRoutingNotices -Force | Out-Null
# DAT files are already beside Xray. Retain one payload copy plus reproducibility metadata.
foreach($taskAsset in $taskDependencies.routingData.files) {
    $taskOldCopy=Join-Path $taskRoutingNotices $taskAsset.path
    if((Split-Path ([IO.Path]::GetFullPath($taskOldCopy)) -Parent) -ne [IO.Path]::GetFullPath($taskRoutingNotices)) { throw 'Invalid regional asset path.' }
    if(Test-Path -LiteralPath $taskOldCopy) { Remove-Item -LiteralPath $taskOldCopy -Force }
}
Get-ChildItem -LiteralPath $taskRoutingAssets -File | Where-Object Extension -ne '.dat' | Copy-Item -Destination $taskRoutingNotices -Force
$taskDivert=Join-Path $taskDependencyCache.winDivert.Root 'WinDivert-2.2.2-A'
Copy-Item -LiteralPath (Join-Path $taskDivert 'x64\WinDivert.dll'),(Join-Path $taskDivert 'x64\WinDivert64.sys'),(Join-Path $taskDivert 'LICENSE'),(Join-Path $taskDivert 'include\windivert.h') -Destination (Join-Path $OutputDirectory 'windivert') -Force
Copy-Item -LiteralPath (Join-Path $taskService 'scripts'),(Join-Path $taskService 'THIRD-PARTY-NOTICES.md'),(Join-Path $taskService 'dependencies.json') -Destination $OutputDirectory -Recurse -Force
$taskNoticePath=Join-Path $OutputDirectory 'THIRD-PARTY-NOTICES.md'
$taskNotice=[IO.File]::ReadAllText($taskNoticePath).Replace('](../docs/','](docs/')
[IO.File]::WriteAllText($taskNoticePath,$taskNotice,[Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $taskService 'limits.json'),(Join-Path $taskService 'api.schema.json') -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $taskProject 'LICENSE') -Destination $OutputDirectory -Force
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'docs') -Force | Out-Null
foreach($taskDoc in Get-ChildItem -LiteralPath (Join-Path $taskProject 'docs') -File -Recurse | Where-Object Extension -in '.md','.json') {
    $taskDocRelative=[IO.Path]::GetRelativePath((Join-Path $taskProject 'docs'),$taskDoc.FullName)
    $taskDocDestination=Join-Path (Join-Path $OutputDirectory 'docs') $taskDocRelative
    New-Item -ItemType Directory -Path (Split-Path $taskDocDestination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $taskDoc.FullName -Destination $taskDocDestination -Force
}
$taskFiles=@(Get-ChildItem -LiteralPath $OutputDirectory -Recurse -File | Where-Object FullName -ne ([IO.Path]::GetFullPath((Join-Path $OutputDirectory 'manifest.json'))) | ForEach-Object { [ordered]@{path=$_.FullName.Substring([IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\').Length+1);bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash} })
[ordered]@{serviceVersion=$taskServiceVersion;frontendVersion=$taskVersion;apiVersion=1;dependencies=$taskDependencies;files=$taskFiles} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json') -Encoding utf8
if (Test-Path -LiteralPath $taskFinalOutput) { Move-Item -LiteralPath $taskFinalOutput -Destination $taskOldPackage }
try { Move-Item -LiteralPath $taskStage -Destination $taskFinalOutput }
catch {
    if (Test-Path -LiteralPath $taskOldPackage) { Move-Item -LiteralPath $taskOldPackage -Destination $taskFinalOutput }
    throw
}
Remove-PackageStage $taskOldPackage
Write-Host "Service package: $taskFinalOutput"
} finally { Remove-PackageStage $taskStage }
