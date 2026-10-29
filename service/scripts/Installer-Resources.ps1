param([Parameter(Mandatory)][string]$Manifest,[Parameter(Mandatory)][int]$Mask,[Parameter(Mandatory)][string]$Destination,[Parameter(Mandatory)][string]$LogPath)
$ErrorActionPreference='Stop'
# NSIS consumes UTF-16LE instead of decoding localized PowerShell output as ANSI.
$log=[IO.StreamWriter]::new($LogPath,$false,[Text.Encoding]::Unicode)
$result=0
try {
    . (Join-Path $PSScriptRoot 'Resource-Downloads.ps1')
    $dependencies=Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    Save-WayrillInstallerResources -Dependencies $dependencies -Mask $Mask -Destination $Destination |
        ForEach-Object { $log.WriteLine($_); $log.Flush() }
} catch {
    $log.WriteLine($_.Exception.Message)
    $result=1
} finally { $log.Dispose() }
exit $result
