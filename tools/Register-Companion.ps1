param(
 [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
 [ValidateSet('Chrome','Edge','Opera','Chromium','Brave','Vivaldi')][string]$Browser='Chrome',
 [string]$HostPath,
 [switch]$Unregister
)
$ErrorActionPreference='Stop'
# All Chromium browsers use shared bridge management. Removal needs no older ID or files.
$helper=Join-Path $PSScriptRoot 'Companion-Setup.ps1'
$package=$PSScriptRoot
if(-not(Test-Path -LiteralPath $helper)){
 $helper=Join-Path $PSScriptRoot '../service/scripts/Companion-Setup.ps1'
 $package=Join-Path $PSScriptRoot '../.tools/companion'
}
$parameters=@{Action=if($Unregister){'Unregister'}else{'Register'};PackageRoot=$package}
if($ExtensionId){$parameters.ExtensionId=$ExtensionId}
if($HostPath){$parameters.HostPath=$HostPath}
& $helper @parameters
if($LASTEXITCODE){exit $LASTEXITCODE}