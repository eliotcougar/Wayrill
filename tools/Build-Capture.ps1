param([switch]$SkipTests,[Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -lt 7){throw 'Use PowerShell 7 for the build scripts.'}
$taskProject=Split-Path $PSScriptRoot -Parent
$taskCapture=Join-Path $taskProject 'service\capture'
$taskManifest=Join-Path $taskCapture 'Cargo.toml'
$taskOutput=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if($taskOutput -eq [IO.Path]::GetPathRoot($taskOutput) -or $taskOutput -eq [IO.Path]::GetFullPath($taskCapture)){throw 'Choose a dedicated capture package directory.'}
if(Test-Path -LiteralPath $taskOutput){
 if((Get-Item -LiteralPath $taskOutput -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or @(Get-ChildItem -LiteralPath $taskOutput -Force).Count){throw 'Capture output must be an empty directory without reparse points.'}
}
& (Join-Path $PSScriptRoot 'Check-Native.ps1') -Component capture -SkipTests:$SkipTests
New-Item -ItemType Directory -Path $taskOutput -Force|Out-Null
$taskParent=Split-Path $taskOutput -Parent
$taskSourceId='.capture-source-'+[Guid]::NewGuid().ToString('N')
$taskSource=Join-Path $taskParent $taskSourceId
$taskFlags=$env:RUSTFLAGS
try {
 $env:RUSTFLAGS=($env:RUSTFLAGS+' -C target-feature=+crt-static').Trim()
 & cargo build --manifest-path $taskManifest --release --locked --target x86_64-pc-windows-msvc --bin wayrill-capture
 if($LASTEXITCODE -ne 0){throw 'Capture release build failed.'}
 # Build the observation companion without the WinDivert native API or engine.
 & cargo build --manifest-path $taskManifest --release --locked --target x86_64-pc-windows-msvc --no-default-features --bin wayrill-attribution
 if($LASTEXITCODE -ne 0){throw 'Attribution release build failed.'}

 $taskMetadataText=& cargo metadata --manifest-path $taskManifest --locked --format-version 1
 if($LASTEXITCODE -ne 0){throw 'Capture dependency metadata failed.'}
 $taskMetadata=$taskMetadataText|ConvertFrom-Json
 $taskExecutable=Join-Path $taskMetadata.target_directory 'x86_64-pc-windows-msvc\release\wayrill-capture.exe'
 Copy-Item -LiteralPath $taskExecutable,(Join-Path $taskCapture 'LICENSE'),(Join-Path $taskCapture 'provenance.json') -Destination $taskOutput -Force

 # Ship exact corresponding source and dependency sources so this leaf worker
 # can be rebuilt offline without the coordinator, .NET SDK or mutable registry.
 New-Item -ItemType Directory -Path $taskSource|Out-Null
 foreach($taskName in @('Cargo.toml','Cargo.lock','LICENSE','provenance.json','README.md','src','tests')){
  Copy-Item -LiteralPath (Join-Path $taskCapture $taskName) -Destination $taskSource -Recurse -Force
 }
 New-Item -ItemType Directory -Path (Join-Path $taskSource 'build')|Out-Null
 Copy-Item -LiteralPath $PSCommandPath,(Join-Path $PSScriptRoot 'Check-Native.ps1'),(Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1') -Destination (Join-Path $taskSource 'build')
 Copy-Item -LiteralPath (Join-Path $taskProject 'rust-toolchain.toml') -Destination $taskSource
 $taskVendor=Join-Path $taskSource 'vendor'
 $null=& cargo vendor --manifest-path $taskManifest --locked $taskVendor
 if($LASTEXITCODE -ne 0){throw 'Capture dependency source collection failed.'}
 New-Item -ItemType Directory -Path (Join-Path $taskSource '.cargo')|Out-Null
 [IO.File]::WriteAllText((Join-Path $taskSource '.cargo\config.toml'),"[source.crates-io]`nreplace-with = 'vendored-sources'`n[source.vendored-sources]`ndirectory = 'vendor'`n",[Text.UTF8Encoding]::new($false))
 $taskNotice=[Collections.Generic.List[string]]::new()
 $taskNotice.Add('# Rust capture dependencies')
 $taskNotice.Add('')
 $taskNotice.Add('Exact sources and original license/notice files are included in capture-source.zip under vendor/. The worker remains GPL-3.0-only; no .NET runtime or TraceEvent library is included.')
 $taskNotice.Add('')
 foreach($taskPackage in $taskMetadata.packages|Where-Object name -ne 'wayrill-capture'|Sort-Object name,version){
  $taskNotice.Add(('- '+$taskPackage.name+' '+$taskPackage.version+': '+$taskPackage.license))
 }
 [IO.File]::WriteAllText((Join-Path $taskOutput 'THIRD-PARTY-NOTICES.md'),(($taskNotice -join "`n")+"`n"),[Text.UTF8Encoding]::new($false))
 Copy-Item -LiteralPath (Join-Path $taskOutput 'THIRD-PARTY-NOTICES.md') -Destination $taskSource
 $taskArchive=Join-Path $taskParent 'capture-source.zip'
 # Cargo's registry archive epoch predates ZIP's 1980 minimum. Normalize only
 # this owned source copy rather than changing the shared registry cache.
 $taskEpoch=[DateTime]::new(2000,1,1,0,0,0,[DateTimeKind]::Utc)
 Get-ChildItem -LiteralPath $taskSource -Recurse -Force -File|ForEach-Object {$_.LastWriteTimeUtc=$taskEpoch}
 Compress-Archive -LiteralPath @(Get-ChildItem -LiteralPath $taskSource -Force|Select-Object -ExpandProperty FullName) -DestinationPath $taskArchive -Force

 $taskFiles=@(Get-ChildItem -LiteralPath $taskOutput -File|Sort-Object Name|ForEach-Object{[ordered]@{path=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
 ConvertTo-Json -InputObject $taskFiles -Depth 4|Set-Content -LiteralPath (Join-Path $taskProject 'service\daemon\src\capture-manifest.json') -Encoding utf8NoBOM
 $taskAttribution=Join-Path $taskParent 'attribution'
 if(Test-Path -LiteralPath $taskAttribution){throw 'Attribution output must be a new package directory.'}
 New-Item -ItemType Directory -Path $taskAttribution|Out-Null
 Copy-Item -LiteralPath (Join-Path $taskMetadata.target_directory 'x86_64-pc-windows-msvc\release\wayrill-attribution.exe'),(Join-Path $taskOutput 'LICENSE'),(Join-Path $taskOutput 'provenance.json'),(Join-Path $taskOutput 'THIRD-PARTY-NOTICES.md') -Destination $taskAttribution
 $taskAttributionFiles=@(Get-ChildItem -LiteralPath $taskAttribution -File|Sort-Object Name|ForEach-Object{[ordered]@{path=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
 ConvertTo-Json -InputObject $taskAttributionFiles -Depth 4|Set-Content -LiteralPath (Join-Path $taskProject 'service\daemon\src\attribution-manifest.json') -Encoding utf8NoBOM

 [ordered]@{capture='Rust';files=$taskFiles.Count;bytes=(Get-ChildItem -LiteralPath $taskOutput -File|Measure-Object Length -Sum).Sum;sourceArchive=$taskArchive}|ConvertTo-Json -Compress
} finally {
 $env:RUSTFLAGS=$taskFlags
 if(Test-Path -LiteralPath $taskSource){
  $taskAbsolute=[IO.Path]::GetFullPath($taskSource)
  if((Split-Path $taskAbsolute -Parent) -ne $taskParent -or (Split-Path $taskAbsolute -Leaf) -ne $taskSourceId){throw 'Unsafe capture source staging cleanup path.'}
  if((Get-Item -LiteralPath $taskAbsolute -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or @(Get-ChildItem -LiteralPath $taskAbsolute -Recurse -Force|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Capture source staging contains a reparse point.'}
  Remove-Item -LiteralPath $taskAbsolute -Recurse -Force
 }
}
