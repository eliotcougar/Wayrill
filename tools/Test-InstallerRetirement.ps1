$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'service\scripts\Installer-Lifecycle.ps1')
$script:checks=0
function Assert($condition,$message){if(-not $condition){throw $message};$script:checks++}
function Retired{
 @{core=@{state='failed';pid=$null};tun=@{state='stopped';pid=$null;keeperPid=$null;sharedPid=$null;interfaceIndex=$null;sharing=@{managed=$false;recoveryPending=$false}};capture=@{state='stopped'};fakeDns=$null;systemProxy=@{managed=$false};systemCapture=@{managed=$false}}
}
$s=Retired;Assert (Test-WayrillRetiredRuntime $s) 'Retired failed runtime must allow repair'
$s.core.state='stopped';Assert (Test-WayrillRetiredRuntime $s) 'Stopped runtime must allow upgrade'
foreach($state in @('running','starting','stopping')){$s=Retired;$s.core.state=$state;Assert (-not (Test-WayrillRetiredRuntime $s)) "Must refuse $state"}
foreach($field in @('pid','keeperPid','sharedPid','interfaceIndex')){$s=Retired;$s.tun[$field]=12;Assert (-not (Test-WayrillRetiredRuntime $s)) "Must refuse retained $field"}
$s=Retired;$s.core.pid=11;Assert (-not (Test-WayrillRetiredRuntime $s)) 'Live core must block upgrade'
$s=Retired;$s.capture.state='running';Assert (-not (Test-WayrillRetiredRuntime $s)) 'Live WinDivert must block upgrade'
$s=Retired;$s.tun.state='running';Assert (-not (Test-WayrillRetiredRuntime $s)) 'Live TUN must block upgrade'
$s=Retired;$s.fakeDns=@{state='ready'};Assert (-not (Test-WayrillRetiredRuntime $s)) 'Retained FakeDNS must block upgrade'
foreach($field in @('managed','recoveryPending')){$s=Retired;$s.tun.sharing[$field]=$true;Assert (-not (Test-WayrillRetiredRuntime $s)) "Must refuse sharing $field"}
foreach($field in @('systemProxy','systemCapture')){$s=Retired;$s[$field].managed=$true;Assert (-not (Test-WayrillRetiredRuntime $s)) "Must refuse $field lease"}
Assert (-not (Test-WayrillRetiredRuntime @{})) 'Incomplete snapshots must not prove retirement'
$script:state=Retired;$script:calls=@();$script:journalChecks=0
function Invoke-WayrillInstallerApi($Method,$OwnerSid){$script:calls+=$Method;if($Method -eq 'core.stop'){throw 'Old retained-adapter error'};$script:state}
function Assert-WayrillRecoveryComplete{$script:journalChecks++}
Stop-WayrillRouting 'owner'
Assert (($script:calls -join ',') -eq 'core.stop,service.status') 'Stop may be observed once but never replayed'
Assert ($script:journalChecks -eq 1) 'Durable journal check must still run'
$script:state.tun.sharing.recoveryPending=$true;$script:calls=@();$caught=$false
try{Stop-WayrillRouting 'owner'}catch{$caught=$_.Exception.Message -eq 'Old retained-adapter error'}
Assert $caught 'Preserve initial error while recovery remains pending'
Assert ($script:journalChecks -eq 1) 'Unsafe snapshot must not pass cleanup'
$script:old=@{serviceVersion='0.31.18';core=@{state='running'};appProtection=@{phase='upgrade';error=@{code='APP_PROTECTION'}}}
$script:armed=$false;$script:repairWorks=$true
function Initialize-WayrillUpgradeProtection { $script:armed=$script:repairWorks; return $script:armed }
function Invoke-WayrillInstallerApi($Method,$OwnerSid){
 $script:calls+=$Method
 switch($Method){
  'service.status' {return $script:old}
  'core.stopForUpgrade' {throw 'Missing protected application'}
  'core.stop' {Assert $script:armed 'Must arm the replacement barrier before retirement';return (Retired)}
 }
}
$script:calls=@();Stop-WayrillRouting 'owner' -ForUpgrade
Assert (($script:calls -join ',') -eq 'service.status,core.stopForUpgrade,service.status,core.stop') 'Old-service recovery must arm before explicit retirement'
$script:repairWorks=$false;$script:calls=@();$caught=$false
try{Stop-WayrillRouting 'owner' -ForUpgrade}catch{$caught=$_.Exception.Message -eq 'Missing protected application'}
Assert $caught 'Failed barrier repair must preserve the original failure'
Assert ('core.stop' -notin $script:calls) 'Failed barrier repair must never retire routing'
$script:old.serviceVersion='0.31.19';$script:repairWorks=$true;$script:calls=@();$caught=$false
try{Stop-WayrillRouting 'owner' -ForUpgrade}catch{$caught=$_.Exception.Message -eq 'Missing protected application'}
Assert $caught 'Current coordinators must use their own lifecycle'
Assert ('core.stop' -notin $script:calls) 'Do not bypass the current coordinator protection contract'
@{passed=$true;checks=$script:checks}|ConvertTo-Json
