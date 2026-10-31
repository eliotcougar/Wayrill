$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'service/scripts/Companion-Setup.ps1')
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('wayrill-companion-'+[Guid]::NewGuid().ToString('N'))
$script:checks=0
function Assert-Companion($Condition,[string]$Message){$script:checks++;if(-not $Condition){throw $Message}}
function Expect-CompanionFailure([scriptblock]$Action){$failed=$false;try{& $Action|Out-Null}catch{$failed=$true};Assert-Companion $failed 'Expected a guarded setup failure.'}
function Find-CompanionBrowser([string]$Id){return $null}
function Get-CompanionMachineIssues {return @()}
$script:registry=@{};$script:shared=$false;$script:writes=0;$script:failAt=0
function SlotId($Slot){if($script:shared){return $Slot.key};return $Slot.key+'/'+$Slot.view}
function Get-CompanionSlots {
 foreach($family in $script:CompanionFamilies.Keys){foreach($view in @('Registry32','Registry64')){
  $slot=[pscustomobject]@{family=$family;view=$view;key=$script:CompanionFamilies[$family]+'\NativeMessagingHosts\'+$script:CompanionName;value=$null;extra=$false}
  $slot.value=$script:registry[(SlotId $slot)];$slot
 }}
}
function Set-CompanionSlot($Slot,$Value){$script:writes++;if($script:failAt -and $script:writes -eq $script:failAt){throw 'Synthetic registry write failure.'};$script:registry[(SlotId $Slot)]=$Value}
try{
 New-Item -ItemType Directory -Path $fixture|Out-Null
 $script:CompanionRoot=Join-Path $fixture 'user/Wayrill/Companion'
 $script:CompanionPackage=Join-Path $fixture ('package space-'+[char]0x754c)
 $script:CompanionExtension=Join-Path $script:CompanionPackage 'extension'
 $script:CompanionHost=Join-Path $script:CompanionPackage 'wayrill-companion.exe'
 New-Item -ItemType Directory -Path $script:CompanionExtension -Force|Out-Null
 [IO.File]::WriteAllBytes($script:CompanionHost,[byte[]]@(1))
 Copy-Item -LiteralPath (Join-Path $project 'extensions/companion/manifest.json') -Destination $script:CompanionExtension
 $manifest=Get-Content -Raw -Encoding UTF8 (Join-Path $script:CompanionExtension 'manifest.json')|ConvertFrom-Json
 $hash=[Security.Cryptography.SHA256]::Create();try{$hex=([BitConverter]::ToString($hash.ComputeHash([Convert]::FromBase64String($manifest.key)))).Replace('-','').Substring(0,32)}finally{$hash.Dispose()}
 $computed=-join @($hex.ToCharArray()|ForEach-Object {[char](97+[Convert]::ToInt32([string]$_,16))})
 Assert-Companion ($computed -ceq $script:CompanionId) 'Bundled manifest must retain the registered stable ID.'
 foreach($share in @($false,$true)){
  $script:shared=$share;$script:registry=@{};$script:writes=0
  $state=Set-CompanionRegistration
  Assert-Companion $state.registered 'All shared browser families must be registered.'
  Assert-Companion ($state.origins.Count -eq 1 -and $state.origins[0] -ceq $script:CompanionId) 'Only stable origin is enabled by default.'
  $state=Set-CompanionRegistration -Id ('b'*32)
  Assert-Companion ($state.origins.Count -eq 2) 'An explicitly supplied legacy ID is allowed.'
  $state=Set-CompanionRegistration -Id ('c'*32)
  Assert-Companion ($state.origins.Count -eq 3 -and $state.origins -contains ('b'*32)) 'Connecting an Opera copy preserves the already authorized Chrome copy.'
  $state=Set-CompanionRegistration
  Assert-Companion ($state.origins.Count -eq 1) 'Use bundled copy revokes older IDs.'
  $state=Set-CompanionRegistration -Remove
  Assert-Companion (-not $state.registered -and @($script:registry.Values|Where-Object {$_}).Count -eq 0) 'Global disconnect removes every physical view without leaving Edge fallback.'
  $state=Set-CompanionRegistration -Remove
  Assert-Companion (-not $state.registered) 'Repeated disconnect is harmless.'
 }
 $script:shared=$false;$script:registry=@{}
 $old=Join-Path $script:CompanionRoot 'com.wayrill.companion.chrome.json'
 [IO.File]::WriteAllText($old,'malformed old manifest')
 $slot=@(Get-CompanionSlots)[0];$script:registry[(SlotId $slot)]=$old
 $state=Set-CompanionRegistration -Remove
 Assert-Companion (-not(Test-Path $old)) 'Malformed app-owned legacy manifest can be disconnected without ID or old executable.'
 $script:registry[(SlotId $slot)]=$old
 $state=Set-CompanionRegistration
 Assert-Companion $state.registered 'A missing legacy manifest can be repaired.'
 $before=[IO.File]::ReadAllBytes($old)
 $script:writes=0;$script:failAt=3
 Expect-CompanionFailure {Set-CompanionRegistration -Id ('c'*32)}
 $script:failAt=0
 Assert-Companion ([Convert]::ToBase64String([IO.File]::ReadAllBytes($old)) -ceq [Convert]::ToBase64String($before)) 'Failed update restores prior manifest bytes.'
 Assert-Companion ((Get-CompanionStatus).registered) 'Failed update preserves previously valid registrations.'
 $foreign=Join-Path $fixture 'foreign.json';[IO.File]::WriteAllText($foreign,'{"name":"unrelated.product","type":"stdio"}')
 $script:registry[(SlotId $slot)]=$foreign
 $writes=$script:writes
 Expect-CompanionFailure {Set-CompanionRegistration}
 Expect-CompanionFailure {Set-CompanionRegistration -Remove}
 Assert-Companion ($script:writes -eq $writes -and (Test-Path $foreign)) 'Foreign registrations and files remain unchanged.'
 $external=Join-Path $fixture 'old-package-manifest.json'
 [IO.File]::WriteAllText($external,(@{name=$script:CompanionName;description='Wayrill Companion read-only route observations';type='stdio';path='C:\missing-package\wayrill-companion.exe';allowed_origins=@('chrome-extension://'+('d'*32)+'/')}|ConvertTo-Json))
 $script:registry[(SlotId $slot)]=$external
 Remove-Item -LiteralPath $script:CompanionHost
 $state=Set-CompanionRegistration -Remove
 Assert-Companion (-not $state.available -and -not $state.registered) 'Removal works when current and former binaries are missing.'
 Assert-Companion (Test-Path $external) 'Disconnect never deletes an external package manifest or its parent.'
 $script:registry[(SlotId $slot)]=Join-Path $fixture 'deleted-old-package/com.wayrill.companion.json'
 $state=Set-CompanionRegistration -Remove
 Assert-Companion (-not $state.registered -and -not $script:registry[(SlotId $slot)]) 'A dangling product-named registration outside the current directory needs no old files.'
 Expect-CompanionFailure {Set-CompanionRegistration -Id ('x'*32)}
 Write-Output ('Companion setup contracts passed: '+$script:checks)
}finally{
 # Only this uniquely created fixture may be removed.
 if((Split-Path $fixture -Parent) -ne [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path $fixture -Leaf) -notlike 'wayrill-companion-*'){throw 'Unexpected fixture cleanup path.'}
 if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
