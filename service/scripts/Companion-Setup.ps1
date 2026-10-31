param(
 [ValidateSet('Status','Register','Unregister','Open')][string]$Action='Status',
 [string]$ExtensionId,
 [ValidateSet('folder','browser')][string]$Target='folder',
 [ValidateSet('edge','chrome','opera','brave','vivaldi','chromium')][string]$Browser='edge',
 [string]$PackageRoot,
 [string]$HostPath
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$script:CompanionId='hkhklldpeeeofokflocodjhfifcbpicc'
$script:CompanionName='com.wayrill.companion'
$script:CompanionFamilies=[ordered]@{chrome='Software\Google\Chrome';edge='Software\Microsoft\Edge';chromium='Software\Chromium';brave='Software\BraveSoftware\Brave-Browser'}
if(-not $PackageRoot){$PackageRoot=Split-Path $PSScriptRoot -Parent}
$script:CompanionPackage=[IO.Path]::GetFullPath($PackageRoot)
$script:CompanionHost=if($HostPath){[IO.Path]::GetFullPath($HostPath)}else{Join-Path $script:CompanionPackage 'wayrill-companion.exe'}
$script:CompanionExtension=Join-Path $script:CompanionPackage 'companion-extension'
if(-not(Test-Path -LiteralPath $script:CompanionExtension)){$script:CompanionExtension=Join-Path $script:CompanionPackage 'extension'}
$script:CompanionRoot=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Wayrill\Companion'
function Test-CompanionId([string]$Id){return $Id -cmatch '^[a-p]{32}$'}
function Test-CompanionLocalPath([string]$Path){return $Path -match '^[a-zA-Z]:[\\/]' -and $Path -notmatch '\x00'}
function Assert-CompanionDirectory {
 foreach($path in @((Split-Path $script:CompanionRoot -Parent),$script:CompanionRoot)){
  if((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Companion setup directory is a reparse point. Existing files were preserved.'}
 }
}
function Get-CompanionSlots {
 $result=@()
 foreach($family in $script:CompanionFamilies.Keys){foreach($view in @('Registry32','Registry64')){
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::$view)
  try{
   $keyName=$script:CompanionFamilies[$family]+'\NativeMessagingHosts\'+$script:CompanionName
   $key=$base.OpenSubKey($keyName)
   try{$value=if($key){$key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null};$extra=$key -and ($key.SubKeyCount -gt 0 -or @($key.GetValueNames()|Where-Object {$_ -ne ''}).Count -gt 0)
    $result+=,[pscustomobject]@{family=$family;view=$view;key=$keyName;value=$value;extra=[bool]$extra}
   }finally{if($key){$key.Dispose()}}
  }finally{$base.Dispose()}
 }}
 return $result
}
function Set-CompanionSlot($Slot,$Value){
 $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::$($Slot.view))
 try{if($null -eq $Value){$base.DeleteSubKey($Slot.key,$false)}else{$key=$base.CreateSubKey($Slot.key);try{$key.SetValue('',[string]$Value,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}}}finally{$base.Dispose()}
}
function Read-CompanionManifest([string]$Path){
 if(-not(Test-CompanionLocalPath $Path)){return $null}
 try{
  $file=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if($file.PSIsContainer -or $file.Length -gt 65536 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){return $null}
  return ([IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json)
 }catch{return $null}
}
function Test-CompanionOwnedPath([string]$Path){
 if(-not(Test-CompanionLocalPath $Path)){return $false}
 $full=[IO.Path]::GetFullPath($Path)
 return (Split-Path $full -Parent) -ieq $script:CompanionRoot -and (Split-Path $full -Leaf) -match '^com\.wayrill\.companion\.(chrome|edge|chromium|brave|opera)\.json$'
}
function Test-CompanionOwned($Slot){
 if($Slot.extra){return $false}
 if($null -eq $Slot.value){return $true}
 # Even a missing/malformed legacy manifest in the app-owned directory can be
 # disconnected. Do not require the former executable, ID, or setup script.
 $manifest=Read-CompanionManifest ([string]$Slot.value)
 if(Test-CompanionOwnedPath ([string]$Slot.value)){
  return -not $manifest -or (-not $manifest.name -or $manifest.name -eq $script:CompanionName)
 }
 if(-not $manifest -and (Test-CompanionLocalPath ([string]$Slot.value)) -and (Split-Path ([string]$Slot.value) -Leaf) -match '^com\.wayrill\.companion(\.(chrome|edge|chromium|brave|opera))?\.json$'){return $true}
 return $manifest -and $manifest.name -eq $script:CompanionName -and $manifest.type -eq 'stdio' -and
  $manifest.description -eq 'Wayrill Companion read-only route observations' -and
  (Split-Path ([string]$manifest.path) -Leaf) -ieq 'wayrill-companion.exe' -and
  @($manifest.allowed_origins).Count -ge 1 -and @($manifest.allowed_origins|Where-Object {$_ -cnotmatch '^chrome-extension://[a-p]{32}/$'}).Count -eq 0
}
function Find-CompanionBrowser([string]$Id){
 $exe=switch($Id){edge{'msedge.exe'}chrome{'chrome.exe'}opera{'opera.exe'}brave{'brave.exe'}vivaldi{'vivaldi.exe'}chromium{'chrome.exe'}}
 $paths=@()
 foreach($hive in @('CurrentUser','LocalMachine')){foreach($view in @('Registry64','Registry32')){
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
  try{$key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths\'+$exe);try{if($key){$candidate=([string]$key.GetValue('')).Trim('"');if($Id -ne 'chromium' -or $candidate -match '[\\/]Chromium[\\/]'){$paths+=$candidate}}}finally{if($key){$key.Dispose()}}}finally{$base.Dispose()}
 }}
 $relative=switch($Id){edge{'Microsoft\Edge\Application\msedge.exe'}chrome{'Google\Chrome\Application\chrome.exe'}opera{'Programs\Opera\launcher.exe';'Opera\launcher.exe'}brave{'BraveSoftware\Brave-Browser\Application\brave.exe'}vivaldi{'Vivaldi\Application\vivaldi.exe'}chromium{'Chromium\Application\chrome.exe'}}
 foreach($root in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:LOCALAPPDATA)){if($root){foreach($rel in $relative){$paths+=Join-Path $root $rel}}}
 foreach($path in $paths|Select-Object -Unique){if((Test-CompanionLocalPath $path) -and (Test-Path -LiteralPath $path -PathType Leaf)){return $path}}
 return $null
}
function Get-CompanionMachineIssues {
 foreach($family in $script:CompanionFamilies.Keys){foreach($view in @('Registry32','Registry64')){
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::$view)
  try{$key=$base.OpenSubKey($script:CompanionFamilies[$family]+'\NativeMessagingHosts\'+$script:CompanionName);try{if($key -and $key.GetValue('')){'An administrator-installed '+$family+' connection also exists. Disconnect manages this Windows user only.'}}finally{if($key){$key.Dispose()}}}finally{$base.Dispose()}
 }}
}
function Get-CompanionStatus {
 $slots=@(Get-CompanionSlots);$origins=@();$issues=@(Get-CompanionMachineIssues|Sort-Object -Unique);$registered=$true
 foreach($slot in $slots){
  if(-not(Test-CompanionOwned $slot)){$issues+='An unrelated registration was preserved: '+$slot.family+' ('+$slot.view+').';$registered=$false;continue}
  $manifest=Read-CompanionManifest ([string]$slot.value)
  if($manifest){$origins+=@($manifest.allowed_origins|Where-Object {$_ -cmatch '^chrome-extension://[a-p]{32}/$'}|ForEach-Object {$_.Substring(19,32)})}
  if(-not $manifest -or $manifest.path -ine $script:CompanionHost -or $manifest.name -ne $script:CompanionName -or $manifest.type -ne 'stdio' -or @($manifest.allowed_origins) -cnotcontains ('chrome-extension://'+$script:CompanionId+'/')){$registered=$false}
 }
 $manifest=Read-CompanionManifest (Join-Path $script:CompanionExtension 'manifest.json')
 $available=(Test-Path -LiteralPath $script:CompanionHost -PathType Leaf) -and $manifest.name -eq 'Wayrill Companion' -and [bool]$manifest.key
 return [ordered]@{extensionId=$script:CompanionId;version=if($manifest){$manifest.version}else{''};extensionPath=$script:CompanionExtension;hostPath=$script:CompanionHost;available=[bool]$available;registered=[bool]$registered;origins=@($origins|Sort-Object -Unique);issues=$issues;browsers=@(foreach($id in @('edge','chrome','opera','brave','vivaldi','chromium')){[ordered]@{id=$id;name=@{edge='Microsoft Edge';chrome='Google Chrome';opera='Opera';brave='Brave';vivaldi='Vivaldi';chromium='Chromium'}[$id];installed=[bool](Find-CompanionBrowser $id)}})}
}
function Write-CompanionFile([string]$Path,[byte[]]$Bytes){
 $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 $backup=$temporary+'.backup'
 try{[IO.File]::WriteAllBytes($temporary,$Bytes);if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temporary,$Path,$backup)}else{[IO.File]::Move($temporary,$Path)}}finally{foreach($file in @($temporary,$backup)){if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}}}
}
function Read-CompanionBytes([string]$Path){
 if(-not(Test-Path -LiteralPath $Path)){return $null}
 $file=Get-Item -LiteralPath $Path -Force
 if($file.PSIsContainer -or $file.Length -gt 65536 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'A Companion manifest is oversized or a reparse point. Existing files were preserved.'}
 return ,([IO.File]::ReadAllBytes($Path))
}
function Test-CompanionBytes($First,$Second){
 if($null -eq $First -or $null -eq $Second){return $null -eq $First -and $null -eq $Second}
 return [Convert]::ToBase64String($First) -ceq [Convert]::ToBase64String($Second)
}
function Set-CompanionRegistration([switch]$Remove,[string]$Id){
 Assert-CompanionDirectory
 if($Id -and -not(Test-CompanionId $Id)){throw 'Extension IDs must contain exactly 32 lowercase letters from a to p.'}
 $slots=@(Get-CompanionSlots)
 foreach($slot in $slots){if(-not(Test-CompanionOwned $slot)){throw ('An unrelated '+$slot.family+' registration was preserved. Its manifest was not changed.')}}
 if(-not $Remove -and -not(Get-CompanionStatus).available){throw 'The bundled Companion files are unavailable. Repair the Wayrill installation.'}
 $files=@{};$applied=@();$changedFiles=@();$written=@{}
 foreach($family in $script:CompanionFamilies.Keys){$path=Join-Path $script:CompanionRoot ($script:CompanionName+'.'+$family+'.json');$files[$path]=Read-CompanionBytes $path}
 foreach($slot in $slots){if($slot.value -and (Test-CompanionOwnedPath ([string]$slot.value)) -and -not $files.ContainsKey([string]$slot.value)){$files[[string]$slot.value]=Read-CompanionBytes ([string]$slot.value)}}
 if(-not $Remove){foreach($path in $files.Keys){if($null -ne $files[$path] -and -not(Test-CompanionOwned ([pscustomobject]@{value=$path;extra=$false}))){throw 'An unrelated manifest in the Companion directory was preserved.'}}}
 try{
  if(-not $Remove){
   New-Item -ItemType Directory -Path $script:CompanionRoot -Force|Out-Null
   $ids=@($script:CompanionId)
   if($Id){$ids+=@((Get-CompanionStatus).origins|Where-Object {Test-CompanionId $_});$ids+=$Id}
   $ids=@($ids|Sort-Object -Unique)
   if($ids.Count -gt 16){throw 'At most 16 copies can be authorized. Use bundled copy to reset old authorizations first.'}
   foreach($family in $script:CompanionFamilies.Keys){
    $path=Join-Path $script:CompanionRoot ($script:CompanionName+'.'+$family+'.json')
    if(-not(Test-CompanionBytes (Read-CompanionBytes $path) $files[$path])){throw 'A manifest changed during setup. Refresh and retry.'}
    $text=[ordered]@{name=$script:CompanionName;description='Wayrill Companion read-only route observations';path=$script:CompanionHost;type='stdio';allowed_origins=@($ids|ForEach-Object {'chrome-extension://'+$_+'/'})}|ConvertTo-Json -Depth 4
    $written[$path]=[Text.UTF8Encoding]::new($false).GetBytes($text)
    $changedFiles+=$path;Write-CompanionFile $path $written[$path]
   }
  }
  foreach($slot in $slots){
   $current=@(Get-CompanionSlots|Where-Object {$_.key -eq $slot.key -and $_.view -eq $slot.view})[0]
   # HKCU can share views. Accept our own preceding write to the same key.
   $path=Join-Path $script:CompanionRoot ($script:CompanionName+'.'+$slot.family+'.json')
   if($current.extra -or ($current.value -cne $slot.value -and -not(@($applied|Where-Object key -eq $slot.key).Count -and (($Remove -and $null -eq $current.value) -or (-not $Remove -and $current.value -ceq $path))))){throw 'Registration changed during setup. Refresh and retry.'}
   Set-CompanionSlot $slot $(if($Remove){$null}else{$path});$applied+=$slot
  }
  if($Remove){foreach($path in $files.Keys){if($null -ne $files[$path]){if(-not(Test-CompanionOwnedPath $path) -or -not(Test-CompanionOwned ([pscustomobject]@{value=$path;extra=$false}))){continue};if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'A manifest changed during removal.'};if([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne [Convert]::ToBase64String($files[$path])){throw 'A manifest changed during removal.'};$changedFiles+=$path;Remove-Item -LiteralPath $path}}}
 }catch{
  $failure=$_
  [array]::Reverse($applied)
  foreach($slot in $applied){
   $current=@(Get-CompanionSlots|Where-Object {$_.key -eq $slot.key -and $_.view -eq $slot.view})[0]
   $expected=if($Remove){$null}else{Join-Path $script:CompanionRoot ($script:CompanionName+'.'+$slot.family+'.json')}
   if(-not $current.extra -and $current.value -ceq $expected){Set-CompanionSlot $slot $slot.value}
  }
  foreach($path in $changedFiles){
   $exists=Test-Path -LiteralPath $path
   $ours=if($Remove){-not $exists}else{$exists -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ceq [Convert]::ToBase64String($written[$path])}
   if(-not $ours){continue}
   if($null -eq $files[$path]){if($exists){Remove-Item -LiteralPath $path}}else{Write-CompanionFile $path $files[$path]}
  }
  throw $failure
 }
 return Get-CompanionStatus
}
function Open-Companion([string]$Kind,[string]$Id){
 if($Kind -eq 'folder'){if(-not(Test-Path -LiteralPath $script:CompanionExtension -PathType Container)){throw 'Bundled extension folder is unavailable.'};Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"'+$script:CompanionExtension+'"')|Out-Null;return}
 $exe=Find-CompanionBrowser $Id
 if(-not $exe){throw 'Browser was not found. Open its Extensions page and load the displayed Companion folder.'}
 $url=switch($Id){edge{'edge://extensions/'}opera{'opera://extensions/'}brave{'brave://extensions/'}vivaldi{'vivaldi://extensions/'}default{'chrome://extensions/'}}
 Start-Process -FilePath $exe -ArgumentList $url|Out-Null
}
if($MyInvocation.InvocationName -ne '.'){
 $mutex=$null;$held=$false
 try{
  $mutex=[Threading.Mutex]::new($false,('Global\Wayrill-Companion-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
  try{$held=$mutex.WaitOne(15000)}catch [Threading.AbandonedMutexException]{$held=$true}
  if(-not $held){throw 'Another Companion setup is running. Try again shortly.'}
  $result=switch($Action){Status{Get-CompanionStatus}Register{Set-CompanionRegistration -Id $ExtensionId}Unregister{Set-CompanionRegistration -Remove}Open{Open-Companion $Target $Browser;$null}}
  [Console]::Out.WriteLine((@{ok=$true;result=$result}|ConvertTo-Json -Depth 10 -Compress))
 }catch{[Console]::Out.WriteLine((@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress));exit 1}finally{if($held){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}}
}
