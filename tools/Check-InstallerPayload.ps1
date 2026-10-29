param([string]$Package)
$ErrorActionPreference='Stop'
$taskProject=Split-Path $PSScriptRoot -Parent
if(-not $Package){$Package=Join-Path $taskProject '.tools\installer-service'}
$taskConfig=Get-Content (Join-Path $taskProject 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8|ConvertFrom-Json
$taskManifest=Get-Content (Join-Path $Package 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
$taskDatFiles=@($taskManifest.files | Where-Object path -match '^xray[\\/].*\.dat$' | ForEach-Object { Split-Path $_.path -Leaf } | Sort-Object)
if (($taskDatFiles -join ',') -ne 'geoip.dat,geosite.dat') { throw 'Only the two XTLS DAT files may be bundled. Regional files must be downloaded on request.' }
$taskMappings=@($taskConfig.bundle.resources.PSObject.Properties)
foreach($taskEntry in $taskManifest.files){
 $taskRelative=$taskEntry.path.Replace('\','/')
 # The signed shared driver is intentionally bundled by the NSIS hook with
 # SetOverwrite off, rather than Tauri's ordinary resource replacement.
 if($taskRelative -eq 'windivert/WinDivert64.sys'){continue}
 $taskInstalled='Service/'+$taskRelative
 $taskCovered=@($taskMappings|Where-Object {
  $taskDestination=[string]$_.Value
  $taskSource=[string]$_.Name
  $taskDestination=$taskDestination.Replace('\','/')
  $taskExpected='../.tools/installer-service/'+$taskRelative
  if($taskDestination.EndsWith('/')){
   $taskInstalled.StartsWith($taskDestination,[StringComparison]::OrdinalIgnoreCase) -and
    $taskExpected.StartsWith($taskSource,[StringComparison]::OrdinalIgnoreCase)
  }else{$taskInstalled -ieq $taskDestination -and $taskExpected -ieq $taskSource}
 })
 if($taskCovered.Count -ne 1){throw ('Installer resource mapping is missing or ambiguous: '+$taskRelative)}
}
Write-Host ('Installer payload mappings verified: '+$taskManifest.files.Count+' files.')
