param(
 [ValidateSet('Status','Register','Unregister','Open')][string]$Action='Status',
 [string]$ExtensionId,
 [ValidateSet('folder','browser')][string]$Target='folder',
 [ValidateSet('edge','chrome','opera','brave','vivaldi','chromium','firefox')][string]$Browser='edge',
 [string]$PackageRoot,
 [string]$HostPath
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$script:CompanionId='hkhklldpeeeofokflocodjhfifcbpicc'
$script:CompanionFirefoxId='wayrill-companion@eliotcougar.github.io'
$script:CompanionName='com.wayrill.companion'
$script:CompanionFamilies=[ordered]@{chrome='Software\Google\Chrome';edge='Software\Microsoft\Edge';chromium='Software\Chromium';brave='Software\BraveSoftware\Brave-Browser';firefox='Software\Mozilla'}
if(-not $PackageRoot){$PackageRoot=Split-Path $PSScriptRoot -Parent}
$script:CompanionPackage=[IO.Path]::GetFullPath($PackageRoot)
$script:CompanionHost=if($HostPath){[IO.Path]::GetFullPath($HostPath)}else{Join-Path $script:CompanionPackage 'wayrill-companion.exe'}
$script:CompanionExtension=Join-Path $script:CompanionPackage 'companion-extension'
$script:CompanionFirefox=Join-Path $script:CompanionPackage 'companion-firefox.xpi'
if(-not(Test-Path -LiteralPath $script:CompanionExtension)){$script:CompanionExtension=Join-Path $script:CompanionPackage 'extension'}
$script:CompanionRoot=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Wayrill\Companion'
function Test-CompanionId([string]$Id){return $Id -cmatch '^[a-p]{32}$'}
function Test-CompanionLocalPath([string]$Path){return $Path -match '^[a-zA-Z]:[\\/]' -and $Path -notmatch '\x00'}
function Assert-CompanionDirectory {
 foreach($path in @((Split-Path $script:CompanionRoot -Parent),$script:CompanionRoot)){
  if((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Companion setup directory is a reparse point. Existing files were preserved.'}
 }
}
function Read-CompanionSlot($Key) {
 $value=if($Key){$Key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null}
 $extra=$Key -and ($Key.SubKeyCount -gt 0 -or @($Key.GetValueNames()|Where-Object {$_ -ne ''}).Count -gt 0 -or
  ($null -ne $value -and $Key.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String))
 return [pscustomobject]@{value=$value;extra=[bool]$extra}
}

function Get-CompanionSlots {
 foreach($family in $script:CompanionFamilies.Keys){foreach($view in @('Registry32','Registry64')){
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::$view)
  try{
   $keyName=$script:CompanionFamilies[$family]+'\NativeMessagingHosts\'+$script:CompanionName
   $key=$base.OpenSubKey($keyName)
   try{
    $state=Read-CompanionSlot $key
    [pscustomobject]@{family=$family;view=$view;key=$keyName;value=$state.value;extra=$state.extra}
   }finally{if($key){$key.Dispose()}}
  }finally{$base.Dispose()}
 }}
}

function Set-CompanionSlot($Slot,$Expected,$Value){
 $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::$($Slot.view))
 try{
  $key=$base.OpenSubKey($Slot.key,$true)
  if(-not $key -and $null -ne $Value -and $null -eq $Expected){$key=$base.CreateSubKey($Slot.key)}
  try{
   $current=Read-CompanionSlot $key
   if($current.extra){return $false}
   if($current.value -ceq $Value){return $true}
   if(-not $key -or $current.value -cne $Expected){return $false}
   # Keep the key itself. Removing it could also discard unrelated values.
   if($null -eq $Value){$key.DeleteValue('',$false)}
   else{$key.SetValue('',[string]$Value,[Microsoft.Win32.RegistryValueKind]::String)}
   return $true
  }finally{if($key){$key.Dispose()}}
 }finally{$base.Dispose()}
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
 return (Split-Path $full -Parent) -ieq $script:CompanionRoot -and (Split-Path $full -Leaf) -match '^com\.wayrill\.companion\.(chrome|edge|chromium|brave|opera|firefox)\.json$'
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
 if(-not $manifest -and (Test-CompanionLocalPath ([string]$Slot.value)) -and (Split-Path ([string]$Slot.value) -Leaf) -match '^com\.wayrill\.companion(\.(chrome|edge|chromium|brave|opera|firefox))?\.json$'){return $true}
 return $manifest -and $manifest.name -eq $script:CompanionName -and $manifest.type -eq 'stdio' -and
  $manifest.description -eq 'Wayrill Companion read-only route observations' -and
  (Split-Path ([string]$manifest.path) -Leaf) -ieq 'wayrill-companion.exe' -and
  ((-not $manifest.allowed_extensions -and @($manifest.allowed_origins).Count -ge 1 -and @($manifest.allowed_origins|Where-Object {$_ -cnotmatch '^chrome-extension://[a-p]{32}/$'}).Count -eq 0) -or
   (-not $manifest.allowed_origins -and @($manifest.allowed_extensions).Count -eq 1 -and $manifest.allowed_extensions[0] -ceq $script:CompanionFirefoxId))
}
function Find-CompanionBrowser([string]$Id){
 $exe=switch($Id){edge{'msedge.exe'}chrome{'chrome.exe'}opera{'opera.exe'}brave{'brave.exe'}vivaldi{'vivaldi.exe'}chromium{'chrome.exe'}firefox{'firefox.exe'}}
 $paths=@()
 foreach($hive in @('CurrentUser','LocalMachine')){foreach($view in @('Registry64','Registry32')){
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
  try{$key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths\'+$exe);try{if($key){$candidate=([string]$key.GetValue('')).Trim('"');if($Id -ne 'chromium' -or $candidate -match '[\\/]Chromium[\\/]'){$paths+=$candidate}}}finally{if($key){$key.Dispose()}}}finally{$base.Dispose()}
 }}
 $relative=switch($Id){edge{'Microsoft\Edge\Application\msedge.exe'}chrome{'Google\Chrome\Application\chrome.exe'}opera{'Programs\Opera\launcher.exe';'Opera\launcher.exe'}brave{'BraveSoftware\Brave-Browser\Application\brave.exe'}vivaldi{'Vivaldi\Application\vivaldi.exe'}chromium{'Chromium\Application\chrome.exe'}firefox{'Mozilla Firefox\firefox.exe'}}
 foreach($root in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:LOCALAPPDATA)){if($root){foreach($rel in $relative){$paths+=Join-Path $root $rel}}}
 foreach($path in $paths|Select-Object -Unique){if((Test-CompanionLocalPath $path) -and (Test-Path -LiteralPath $path -PathType Leaf)){return $path}}
 return $null
}
function Get-CompanionMachineSlots {
 foreach($family in $script:CompanionFamilies.Keys){foreach($view in @('Registry32','Registry64')){
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::$view)
  try{
   $key=$base.OpenSubKey($script:CompanionFamilies[$family]+'\NativeMessagingHosts\'+$script:CompanionName)
   try{
    if($key){
     $value=$key.GetValue('')
     if($value){[pscustomobject]@{family=$family;value=$value}}
    }
   }finally{if($key){$key.Dispose()}}
  }finally{$base.Dispose()}
 }}
}
function Get-CompanionMachineIssues {
 foreach($slot in Get-CompanionMachineSlots){
  'An administrator-installed '+$slot.family+' connection also exists. Disconnect manages this Windows user only.'
 }
}
function Get-CompanionState([string[]]$RecoveryIssues=@()) {
 $slots=@(Get-CompanionSlots);$origins=@();$issues=@(Get-CompanionMachineIssues|Sort-Object -Unique)+$RecoveryIssues
 $registered=$true;$owned=0
 foreach($slot in $slots){
  if(-not(Test-CompanionOwned $slot)){$issues+='An unrelated registration was preserved: '+$slot.family+' ('+$slot.view+').';$registered=$false;continue}
  if($null -ne $slot.value){$owned++}
  $manifest=Read-CompanionManifest ([string]$slot.value)
  if($manifest){$origins+=@($manifest.allowed_origins|Where-Object {$_ -cmatch '^chrome-extension://[a-p]{32}/$'}|ForEach-Object {$_.Substring(19,32)})}
  $authorized=if($slot.family -eq 'firefox'){@($manifest.allowed_extensions) -ccontains $script:CompanionFirefoxId}else{@($manifest.allowed_origins) -ccontains ('chrome-extension://'+$script:CompanionId+'/')}
  if(-not $manifest -or $manifest.path -ine $script:CompanionHost -or $manifest.name -ne $script:CompanionName -or $manifest.type -ne 'stdio' -or -not $authorized){$registered=$false}
 }
 $manifest=Read-CompanionManifest (Join-Path $script:CompanionExtension 'manifest.json')
 $available=(Test-Path -LiteralPath $script:CompanionHost -PathType Leaf) -and $manifest.name -eq 'Wayrill Companion' -and [bool]$manifest.key
 return [ordered]@{extensionId=$script:CompanionId;version=if($manifest){$manifest.version}else{''};extensionPath=$script:CompanionExtension;firefoxPath=if(Test-Path -LiteralPath $script:CompanionFirefox -PathType Leaf){$script:CompanionFirefox}else{''};hostPath=$script:CompanionHost;available=[bool]$available;registered=[bool]$registered;partial=(-not $registered -and $owned -gt 0);origins=@($origins|Sort-Object -Unique);issues=$issues;browsers=@(foreach($id in @('edge','chrome','opera','brave','vivaldi','chromium','firefox')){[ordered]@{id=$id;name=@{edge='Microsoft Edge';chrome='Google Chrome';opera='Opera';brave='Brave';vivaldi='Vivaldi';chromium='Chromium';firefox='Mozilla Firefox'}[$id];installed=[bool](Find-CompanionBrowser $id)}})}
}
function Write-CompanionFile([string]$Path,[byte[]]$Bytes){
 $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 $backup=$temporary+'.backup'
 try{
  $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temporary,$Path,$backup)}else{[IO.File]::Move($temporary,$Path)}
 }finally{foreach($file in @($temporary,$backup)){if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}}}
}
function Read-CompanionBytes([string]$Path,[int]$Limit=65536){
 if(-not(Test-Path -LiteralPath $Path)){return $null}
 $file=Get-Item -LiteralPath $Path -Force
 if($file.PSIsContainer -or $file.Length -gt $Limit -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw [IO.InvalidDataException]::new('A Companion file is oversized or a reparse point. Existing files were preserved.')}
 return ,([IO.File]::ReadAllBytes($Path))
}
function Get-CompanionSetupJournalPath {
 return Join-Path $script:CompanionRoot 'setup-journal.json'
}

function Write-CompanionSetupJournal($Journal) {
 $path=Get-CompanionSetupJournalPath
 $null=Read-CompanionBytes $path 1MB
 $json=$Journal|ConvertTo-Json -Depth 6 -Compress
 Write-CompanionFile $path ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Read-CompanionSetupJournal {
 $bytes=Read-CompanionBytes (Get-CompanionSetupJournalPath) 1MB
 if($null -eq $bytes){return $null}
 $journal=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
 if($journal.version -is [array] -or $journal.version -ne 1 -or $journal.phase -isnot [string] -or
   $journal.phase -cnotin @('apply','rollback') -or @($journal.files).Count -gt 6 -or @($journal.slots).Count -gt 10){
  throw 'The Companion setup journal needs attention. Existing registrations were preserved.'
 }
 foreach($file in $journal.files){
  if($file.name -isnot [string] -or $file.name -notmatch '^com\.wayrill\.companion\.(chrome|edge|chromium|brave|opera|firefox)\.json$'){
   throw 'The Companion setup journal contains an invalid manifest name.'
  }
  foreach($value in @($file.before,$file.after)){
   if($null -ne $value -and ($value -isnot [string] -or [Convert]::FromBase64String($value).Length -gt 65536)){
    throw 'The Companion setup journal contains invalid manifest data.'
   }
  }
 }
 foreach($slot in $journal.slots){
  if($slot.family -isnot [string] -or $slot.view -isnot [string] -or
    $slot.family -cnotin @($script:CompanionFamilies.Keys) -or $slot.view -cnotin @('Registry32','Registry64') -or
    ($null -ne $slot.before -and ($slot.before -isnot [string] -or -not(Test-CompanionLocalPath $slot.before))) -or
    ($null -ne $slot.after -and ($slot.after -isnot [string] -or
      $slot.after -cne (Join-Path $script:CompanionRoot ($script:CompanionName+'.'+$slot.family+'.json'))))){
   throw 'The Companion setup journal contains an invalid browser registration.'
  }
 }
 return $journal
}

function Get-CompanionFileVersion([string]$Path) {
 $bytes=Read-CompanionBytes $Path
 if($null -eq $bytes){return $null}
 return [Convert]::ToBase64String($bytes)
}

function Test-CompanionFileVersion([string]$Path,$Expected,$Other) {
 try{
  $actual=Get-CompanionFileVersion $Path
  return $actual -ceq $Expected -or $actual -ceq $Other
 }catch [IO.InvalidDataException]{return $false}
}

function Get-CompanionPlannedManifest([string]$Path,$Files) {
 if(Test-CompanionOwnedPath $Path){return $Files[[IO.Path]::GetFullPath($Path)]}
}

function Invoke-CompanionSetupPlan($Journal) {
 Assert-CompanionDirectory
 $files=@{}
 foreach($entry in $Journal.files){$files[(Join-Path $script:CompanionRoot $entry.name)]=$entry}
 $from, $to=if($Journal.phase -eq 'rollback'){@('after','before')}else{@('before','after')}
 $issues=[Collections.Generic.List[string]]::new()

 # Put files in place before attaching browser slots. Remove files only
 # after all slots have been processed, including externally changed ones.
 foreach($path in $files.Keys){
  $entry=$files[$path]
  if($null -eq $entry.$to){continue}
  try{$current=Get-CompanionFileVersion $path}
  catch [IO.InvalidDataException]{$issues.Add('An unsafe Companion file was preserved: '+$entry.name);continue}
  if($current -ceq $entry.$to){continue}
  if($current -cne $entry.$from){
   $issues.Add('A changed Companion manifest was preserved: '+$entry.name)
   continue
  }
  Write-CompanionFile $path ([Convert]::FromBase64String($entry.$to))
 }

 foreach($entry in $Journal.slots){
  $slot=Get-CompanionSlots|Where-Object {$_.family -ceq $entry.family -and $_.view -ceq $entry.view}
  $value=$entry.$to
  if(-not $slot.extra -and $slot.value -ceq $value){continue}
  $safe=-not $slot.extra -and $slot.value -ceq $entry.$from -and (Test-CompanionOwned $slot)
  if($safe -and $null -ne $slot.value){
   $previous=Get-CompanionPlannedManifest $slot.value $files
   if($previous){
    $safe=Test-CompanionFileVersion $slot.value $previous.$from $previous.$to
   }
  }
  if($safe -and $null -ne $value){
   $target=Get-CompanionPlannedManifest $value $files
   $safe=if($target){
    Test-CompanionFileVersion $value $target.$to $target.$to
   }else{
    Test-CompanionOwned ([pscustomobject]@{value=$value;extra=$false})
   }
  }
  if(-not $safe -or -not(Set-CompanionSlot $slot $entry.$from $value)){
   $issues.Add('A changed Companion registration was preserved: '+$entry.family+' ('+$entry.view+').')
  }
 }

 $referenced=@((@(Get-CompanionSlots)+@(Get-CompanionMachineSlots))|ForEach-Object {
  if(Test-CompanionOwnedPath ([string]$_.value)){[IO.Path]::GetFullPath($_.value)}
 })
 foreach($path in $files.Keys){
  $entry=$files[$path]
  if($null -ne $entry.$to){continue}
  try{$current=Get-CompanionFileVersion $path}
  catch [IO.InvalidDataException]{$issues.Add('An unsafe Companion file was preserved: '+$entry.name);continue}
  if($null -eq $current){continue}
  if($current -cne $entry.$from -or $referenced -icontains $path){
   $issues.Add('A changed or referenced Companion manifest was preserved: '+$entry.name)
   continue
  }
  Remove-Item -LiteralPath $path
 }
 return $issues.ToArray()
}

function Complete-CompanionSetup {
 Assert-CompanionDirectory
 $journal=Read-CompanionSetupJournal
 if($null -eq $journal){return}
 $issues=@(Invoke-CompanionSetupPlan $journal)
 Remove-Item -LiteralPath (Get-CompanionSetupJournalPath)
 return $issues
}

function Get-CompanionStatus {
 $issues=@()
 try{$issues=@(Complete-CompanionSetup)}
 catch{$issues=@('Companion setup recovery is pending. '+$_.Exception.Message)}
 Get-CompanionState $issues
}

function New-CompanionSetupPlan([switch]$Remove,[string]$Id) {
 $slots=@(Get-CompanionSlots)
 foreach($slot in $slots){
  if(-not(Test-CompanionOwned $slot)){throw ('An unrelated '+$slot.family+' registration was preserved. Its manifest was not changed.')}
 }
 $status=Get-CompanionState
 if(-not $Remove -and -not $status.available){throw 'The bundled Companion files are unavailable. Repair the Wayrill installation.'}
 $ids=@($script:CompanionId)
 if(-not $Remove -and $Id){$ids+=@($status.origins|Where-Object {Test-CompanionId $_});$ids+=$Id}
 $ids=@($ids|Sort-Object -Unique)
 if($ids.Count -gt 16){throw 'At most 16 copies can be authorized. Use bundled copy to reset old authorizations first.'}

 $paths=@{}
 foreach($family in $script:CompanionFamilies.Keys){
  $path=Join-Path $script:CompanionRoot ($script:CompanionName+'.'+$family+'.json')
  $paths[$path]=$family
 }
 if($Remove){
  foreach($slot in $slots){
   if(Test-CompanionOwnedPath ([string]$slot.value)){$paths[[IO.Path]::GetFullPath($slot.value)]=$slot.family}
  }
 }
 $files=@(foreach($path in $paths.Keys|Sort-Object){
  $before=Get-CompanionFileVersion $path
  if($null -ne $before -and -not(Test-CompanionOwned ([pscustomobject]@{value=$path;extra=$false}))){
   if($Remove){continue}
   throw 'An unrelated manifest in the Companion directory was preserved.'
  }
  $after=$null
  if(-not $Remove){
   $manifest=[ordered]@{name=$script:CompanionName;description='Wayrill Companion read-only route observations';path=$script:CompanionHost;type='stdio'}
   if($paths[$path] -eq 'firefox'){$manifest.allowed_extensions=@($script:CompanionFirefoxId)}
   else{$manifest.allowed_origins=@($ids|ForEach-Object {'chrome-extension://'+$_+'/'})}
   $after=[Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Depth 4)))
  }
  [ordered]@{name=(Split-Path $path -Leaf);before=$before;after=$after}
 })
 $registrations=@(foreach($slot in $slots){
  $after=if($Remove){$null}else{Join-Path $script:CompanionRoot ($script:CompanionName+'.'+$slot.family+'.json')}
  [ordered]@{family=$slot.family;view=$slot.view;before=$slot.value;after=$after}
 })
 return [ordered]@{version=1;phase='apply';files=$files;slots=$registrations}
}

function Set-CompanionRegistration([switch]$Remove,[string]$Id){
 Assert-CompanionDirectory
 if($Id -and -not(Test-CompanionId $Id)){throw 'Extension IDs must contain exactly 32 lowercase letters from a to p.'}
 $recovery=@(Complete-CompanionSetup)
 # The user's next explicit action can make a new plan after they have seen
 # conflicts from recovery. This call must not overwrite a preserved edit.
 if($recovery.Count){return Get-CompanionState $recovery}
 $journal=New-CompanionSetupPlan -Remove:$Remove -Id $Id
 New-Item -ItemType Directory -Path $script:CompanionRoot -Force|Out-Null
 Write-CompanionSetupJournal $journal
 try{
  $issues=@(Complete-CompanionSetup)
 }catch{
  $failure=$_
  $journal.phase='rollback'
  Write-CompanionSetupJournal $journal
  $recovery=@(Complete-CompanionSetup)
  if($recovery.Count){throw ($failure.Exception.Message+' '+($recovery -join ' '))}
  throw $failure
 }
 Get-CompanionState $issues
}

function Open-Companion([string]$Kind,[string]$Id){
 if($Kind -eq 'folder'){
  $arguments=if($Id -eq 'firefox'){if(-not(Test-Path -LiteralPath $script:CompanionFirefox -PathType Leaf)){throw 'Bundled signed Firefox extension is unavailable.'};'/select,"'+$script:CompanionFirefox+'"'}else{if(-not(Test-Path -LiteralPath $script:CompanionExtension -PathType Container)){throw 'Bundled extension folder is unavailable.'};'"'+$script:CompanionExtension+'"'}
  Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList $arguments|Out-Null;return
 }
 $exe=Find-CompanionBrowser $Id
 if(-not $exe){throw 'Browser was not found. Open its Extensions page and load the displayed Companion folder.'}
 $url=switch($Id){edge{'edge://extensions/'}opera{'opera://extensions/'}brave{'brave://extensions/'}vivaldi{'vivaldi://extensions/'}firefox{'about:addons'}default{'chrome://extensions/'}}
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
