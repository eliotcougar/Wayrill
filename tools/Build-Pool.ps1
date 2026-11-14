param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-BuildEnvironment.ps1')
Push-Location $taskProject
try {
    & (Join-Path $PSScriptRoot 'Check-Native.ps1') -Component pool -SkipTests:$SkipTests
    & npm.cmd run build
    if ($LASTEXITCODE) { throw 'Wayrill Pool frontend build failed.' }
    $target = 'x86_64-pc-windows-msvc'
    & cargo build --manifest-path 'src-tauri/pool/Cargo.toml' --release --locked --features custom-protocol --target $target
    if ($LASTEXITCODE) { throw 'Wayrill Pool desktop build failed.' }
    $binary = Join-Path $env:CARGO_TARGET_DIR "$target/release/wayrill-pool.exe"
    $product = (Get-Item -LiteralPath $binary).VersionInfo
    $config = Get-Content -LiteralPath 'src-tauri/pool/tauri.conf.json' -Raw | ConvertFrom-Json
    if ($product.ProductName -ne $config.productName -or $product.ProductVersion -ne $config.version) {
        throw 'Wayrill Pool executable identity does not match its configuration.'
    }
    $output = Join-Path $taskProject '.tools/installer-pool'
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    Copy-Item -LiteralPath $binary -Destination $output -Force
    Write-Host "Wayrill Pool package: $output"
} finally {
    Pop-Location
}
