param([string]$OutputDirectory, [switch]$PrepareOnly, [string]$CurlPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
$taskCommit = 'e4bfd6b03e50de46b47abfbd1e46b384f0c5f833'
$taskHash = 'fef0b17c5c3c9356fb8ba7366a3b196149daadd131fb6a92abeda1cb4d3b9b85'
$taskArchive = Join-Path $taskProject ".tools/downloads/Detours-$taskCommit.zip"
if (-not (Test-Path -LiteralPath $taskArchive)) {
    New-Item -ItemType Directory -Path (Split-Path $taskArchive -Parent) -Force | Out-Null
    $CurlPath = & (Join-Path $PSScriptRoot 'Get-Curl.ps1') -Path $CurlPath
    & $CurlPath --fail --location --silent --show-error "https://codeload.github.com/microsoft/Detours/zip/$taskCommit" --output $taskArchive
    if ($LASTEXITCODE) { throw 'Microsoft Detours download failed.' }
}
$taskDependency = & (Join-Path $PSScriptRoot 'Get-PinnedDependency.ps1') -Archive $taskArchive -ArchiveHash $taskHash -CacheRoot (Join-Path $taskProject '.tools/dependencies/detours')
$taskBuild = Join-Path $taskProject '.tools/timezone-build'
$taskDetours = Join-Path $taskBuild "Detours-$taskCommit"
New-Item -ItemType Directory -Path $taskBuild -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskDependency.Root "Detours-$taskCommit") -Destination $taskBuild -Recurse -Force
Push-Location (Join-Path $taskDetours 'src')
try {
    & nmake /nologo
    if ($LASTEXITCODE) { throw 'Microsoft Detours build failed.' }
} finally { Pop-Location }
if ($PrepareOnly) { return }
if (-not $OutputDirectory) { throw 'Choose a timezone package output directory.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Push-Location $taskProject
try {
    $taskPreviousFlags = $env:RUSTFLAGS
    $env:RUSTFLAGS = ($env:RUSTFLAGS + ' -C target-feature=+crt-static').Trim()
    & cargo build --manifest-path service/Cargo.toml --locked -p wayrill-timezone --release --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE) { throw 'Native timezone Rust build failed.' }
    $taskRelease = Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release'
    $taskDll = Join-Path $taskRelease 'wayrill_timezone_hook.dll'
    $taskAsset = 'wayrill-timezone-' + (Get-FileHash $taskDll -Algorithm SHA256).Hash.Substring(0,16).ToLowerInvariant() + '.dll'
    Copy-Item -LiteralPath $taskDll -Destination (Join-Path $OutputDirectory $taskAsset) -Force
    Copy-Item -LiteralPath (Join-Path $taskRelease 'wayrill-timezone.exe') -Destination $OutputDirectory -Force
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'asset.txt'), $taskAsset, [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $taskDetours 'LICENSE.md') -Destination (Join-Path $OutputDirectory 'Detours-LICENSE.md') -Force
} finally { $env:RUSTFLAGS = $taskPreviousFlags; Pop-Location }
