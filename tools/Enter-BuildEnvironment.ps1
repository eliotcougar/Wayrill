$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
$taskCache = Join-Path $taskProject '.tools'
$taskRustPin = [regex]::Match([IO.File]::ReadAllText((Join-Path $taskProject 'rust-toolchain.toml')), '(?m)^channel\s*=\s*"([^"\r\n]+)"\s*$').Groups[1].Value
if (-not $taskRustPin) { throw 'Rust toolchain pin is missing.' }
$env:RUSTUP_TOOLCHAIN = "$taskRustPin-x86_64-pc-windows-msvc"
$taskLocalManifest = Join-Path $taskCache 'toolchain-msvc.json'
# Optional portable toolchain; otherwise use an installed Developer PowerShell.
if (Test-Path -LiteralPath $taskLocalManifest) {
    $taskMsvc = Get-Content -LiteralPath $taskLocalManifest -Raw | ConvertFrom-Json
    $taskCompiler = Join-Path $taskCache "msvc\VC\Tools\MSVC\$($taskMsvc.compilerVersion)"
    $taskSdk = Join-Path $taskCache 'msvc\Windows Kits\10'
    if (-not (Test-Path -LiteralPath (Join-Path $taskCompiler 'bin\Hostx64\x64\cl.exe'))) { throw 'Optional local MSVC cache is incomplete.' }
    $env:CARGO_HOME = Join-Path $taskCache 'cargo'
    $env:RUSTUP_HOME = Join-Path $taskCache 'rustup'
    $env:VCToolsInstallDir = "$taskCompiler\"
    $env:VCToolsVersion = $taskMsvc.compilerVersion
    $env:WindowsSdkDir = "$taskSdk\"
    $env:WindowsSDKVersion = "$($taskMsvc.sdkVersion)\"
    $env:VSCMD_ARG_HOST_ARCH = 'x64'
    $env:VSCMD_ARG_TGT_ARCH = 'x64'
    $env:INCLUDE = "$taskCompiler\include;$taskSdk\Include\$($taskMsvc.sdkVersion)\ucrt;$taskSdk\Include\$($taskMsvc.sdkVersion)\shared;$taskSdk\Include\$($taskMsvc.sdkVersion)\um;$taskSdk\Include\$($taskMsvc.sdkVersion)\winrt;$taskSdk\Include\$($taskMsvc.sdkVersion)\cppwinrt"
    $env:LIB = "$taskCompiler\lib\x64;$taskSdk\Lib\$($taskMsvc.sdkVersion)\ucrt\x64;$taskSdk\Lib\$($taskMsvc.sdkVersion)\um\x64"
    $env:PATH = "$env:CARGO_HOME\bin;$taskCompiler\bin\Hostx64\x64;$taskSdk\bin\$($taskMsvc.sdkVersion)\x64;$env:PATH"
} elseif (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $taskVswhere)) { throw 'Visual C++ build tools are required.' }
    $taskVisualStudio = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $taskVisualStudio) { throw 'Visual C++ build tools are required.' }
    & (Join-Path $taskVisualStudio 'Common7\Tools\Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
}
foreach ($taskCommand in @('cargo', 'rustc', 'cl.exe', 'link.exe', 'rc.exe')) {
    if (-not (Get-Command $taskCommand -ErrorAction SilentlyContinue)) { throw "Missing $taskCommand. Install Rust/MSVC/Windows SDK and use x64 Developer PowerShell." }
}
$env:CARGO_TARGET_DIR = Join-Path $taskCache 'target'
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = [string][Math]::Min(8, [Environment]::ProcessorCount) }
