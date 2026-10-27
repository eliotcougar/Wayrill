param([string]$Path)
$ErrorActionPreference = 'Stop'
$candidates = @($Path, $env:WAYRILL_CURL)
$named = Get-Command curl-mingw.exe -ErrorAction SilentlyContinue
if ($named) { $candidates += $named.Source }
if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\curl.exe' }
$ordinary = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($ordinary) { $candidates += $ordinary.Source }
foreach ($candidate in $candidates | Where-Object { $_ } | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $version = & $candidate --version 2>$null
    if ($LASTEXITCODE -eq 0 -and ($version -join ' ') -match '(?:OpenSSL|LibreSSL)/') { return (Resolve-Path -LiteralPath $candidate).Path }
}
throw 'curl-mingw with OpenSSL or LibreSSL is required. Set WAYRILL_CURL or pass -CurlPath. Windows bundled curl is not used.'
