param([string]$OutputDirectory, [switch]$PrepareOnly, [switch]$CheckX86, [switch]$SkipTests, [string]$CurlPath)
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
if (-not $PrepareOnly) {
    if (-not $OutputDirectory) { throw 'Choose a timezone package output directory.' }
    $OutputDirectory = (New-Item -ItemType Directory -Path $OutputDirectory -Force).FullName
}
$taskPreviousFlags = $env:RUSTFLAGS
$taskPreviousEncodedFlags = $env:CARGO_ENCODED_RUSTFLAGS
$taskPreviousPath = $env:PATH
Push-Location $taskProject
try {
    if (-not $PrepareOnly) {
        $env:RUSTFLAGS = ($env:RUSTFLAGS + ' -C target-feature=+crt-static').Trim()
    }
    foreach ($taskArch in 'X64', 'X86') {
        $taskTarget = 'x86_64-pc-windows-msvc'
        $taskOutput = $OutputDirectory
        if ($taskArch -eq 'X86') {
            $taskTarget = 'i686-pc-windows-msvc'
            $taskCross = Join-Path $env:VCToolsInstallDir 'bin/Hostx64/x86'
            if (-not (Test-Path -LiteralPath (Join-Path $taskCross 'cl.exe')) -or
                -not (Test-Path -LiteralPath (Join-Path $env:VCToolsInstallDir 'lib/x86/libcmt.lib'))) {
                throw 'The MSVC x86 compiler and CRT are required for 32-bit application timezone support.'
            }
            $env:PATH = "$taskCross;$taskPreviousPath"
            if (-not $PrepareOnly) {
                $taskOutput = (New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'x86') -Force).FullName
            }
        }
        Push-Location (Join-Path $taskDetours 'src')
        try {
            & nmake /nologo "DETOURS_TARGET_PROCESSOR=$taskArch"
            if ($LASTEXITCODE) { throw "Microsoft Detours $taskArch build failed." }
            $taskAllocator = Get-Item -LiteralPath (Join-Path $taskProject 'service/timezone/detours-allocator.cpp')
            $taskLibrary = Join-Path $taskDetours "lib.$taskArch/wayrill-detours-allocator.lib"
            if (-not (Test-Path -LiteralPath $taskLibrary) -or
                (Get-Item -LiteralPath $taskLibrary).LastWriteTimeUtc -lt $taskAllocator.LastWriteTimeUtc) {
                $taskObject = Join-Path $taskDetours "src/obj.$taskArch/wayrill-detours-allocator.obj"
                & cl.exe /nologo /c /Zl /MT "/Fo$taskObject" $taskAllocator.FullName
                if ($LASTEXITCODE) { throw "Timezone allocator $taskArch build failed." }
                & link.exe /lib /nologo "/out:$taskLibrary" $taskObject
                if ($LASTEXITCODE) { throw "Timezone allocator $taskArch archive failed." }
            }
        } finally {
            $env:PATH = $taskPreviousPath
            Pop-Location
        }
        if ($taskArch -eq 'X86' -and (-not $PrepareOnly -or $CheckX86)) {
            # Cargo still links x64 build scripts. Keep the host LIB and pass
            # the x86 library paths only to the requested target.
            $taskSdkLib = Join-Path $env:WindowsSdkDir "Lib/$($env:WindowsSDKVersion)"
            $taskFlags = if ($env:CARGO_ENCODED_RUSTFLAGS) {
                $env:CARGO_ENCODED_RUSTFLAGS -split [char]31
            } else {
                $env:RUSTFLAGS -split '\s+' | Where-Object { $_ }
            }
            $env:CARGO_ENCODED_RUSTFLAGS = (@($taskFlags) + @(
                '-Lnative=' + (Join-Path $env:VCToolsInstallDir 'lib/x86')
                '-Lnative=' + (Join-Path $taskSdkLib 'ucrt/x86')
                '-Lnative=' + (Join-Path $taskSdkLib 'um/x86')
            )) -join [char]31
        }
        $taskArgs = @('--manifest-path', 'service/Cargo.toml', '--locked', '-p', 'wayrill-timezone', '--target', $taskTarget)
        if ($CheckX86 -and $taskArch -eq 'X86') {
            & cargo clippy @taskArgs --all-targets -- -D warnings
            if ($LASTEXITCODE) { throw 'Native timezone x86 lint failed.' }
            if (-not $SkipTests) {
                & cargo test @taskArgs
                if ($LASTEXITCODE) { throw 'Native timezone x86 tests failed.' }
            }
        }
        if ($PrepareOnly) { continue }
        & cargo build @taskArgs --release
        if ($LASTEXITCODE) { throw "Native timezone $taskArch Rust build failed." }
        $taskRelease = Join-Path $env:CARGO_TARGET_DIR "$taskTarget/release"
        $taskDll = Join-Path $taskRelease 'wayrill_timezone_hook.dll'
        $taskAsset = 'wayrill-timezone-' + (Get-FileHash -LiteralPath $taskDll -Algorithm SHA256).Hash.Substring(0,16).ToLowerInvariant() + '.dll'
        Copy-Item -LiteralPath $taskDll -Destination (Join-Path $taskOutput $taskAsset) -Force
        Copy-Item -LiteralPath (Join-Path $taskRelease 'wayrill-timezone.exe') -Destination $taskOutput -Force
        [IO.File]::WriteAllText((Join-Path $taskOutput 'asset.txt'), $taskAsset, [Text.UTF8Encoding]::new($false))
    }
    if (-not $PrepareOnly) {
        Copy-Item -LiteralPath (Join-Path $taskDetours 'LICENSE.md') -Destination (Join-Path $OutputDirectory 'Detours-LICENSE.md') -Force
    }
} finally {
    $env:RUSTFLAGS = $taskPreviousFlags
    $env:CARGO_ENCODED_RUSTFLAGS = $taskPreviousEncodedFlags
    $env:PATH = $taskPreviousPath
    Pop-Location
}
