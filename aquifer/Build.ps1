param([switch]$SkipTests, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/Build-Aquifer.ps1') -SkipTests:$SkipTests -OutputDirectory $OutputDirectory
