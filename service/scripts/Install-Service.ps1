param([Parameter(Mandatory=$true)][ValidatePattern('^S-1-(5-21|12-1)-[0-9-]+$')][string]$OwnerSid,[ValidatePattern('^([a-f0-9]{32})?$')][string]$UpgradeTransaction='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Installer-Lifecycle.ps1')
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($taskIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer in an Administrator PowerShell window.' }
$taskBundle=Split-Path $PSScriptRoot -Parent
$taskTarget=Join-Path $env:ProgramFiles 'Wayrill\Service'
$taskData=Join-Path $env:ProgramData 'Wayrill'
$taskExe=Join-Path $taskTarget 'wayrill-service.exe'
$taskCommand='"'+$taskExe+'" --owner-sid '+$OwnerSid
$taskInPlace=[IO.Path]::GetFullPath($taskBundle).TrimEnd('\') -ieq [IO.Path]::GetFullPath($taskTarget).TrimEnd('\')
$taskManifest=Get-Content -LiteralPath (Join-Path $taskBundle 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($taskEntry in $taskManifest.files) {
    if ($taskEntry.path -match '(^[\\/]|\.\.|:)' ) { throw 'Invalid bundle manifest path.' }
    $taskFile=Join-Path $taskBundle $taskEntry.path
    # Installed routing data is intentionally mutable through resources.update. Only
    # this fixed in-place location may differ; external packages retain exact hashes.
    $taskMutable=$taskInPlace -and $taskEntry.path -match '^xray\\[^\\/]+\.dat$'
    if ($taskMutable -and -not (Test-Path -LiteralPath $taskFile)) { continue }
    $taskInfo=Get-Item -LiteralPath $taskFile -Force
    if ($taskMutable -and -not $taskInfo.PSIsContainer -and -not ($taskInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $taskInfo.Length -gt 0 -and $taskInfo.Length -le 128MB) { continue }
    if ((Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash -ne $taskEntry.sha256) { throw "Bundle integrity failure: $($taskEntry.path)" }
}
foreach ($taskDirectory in @((Join-Path $env:ProgramFiles 'Wayrill'),$taskTarget,$taskData)) {
    if (Test-Path -LiteralPath $taskDirectory) {
        if ((Get-Item -LiteralPath $taskDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A service directory is a reparse point; installation stopped.' }
        if (@(Get-ChildItem -LiteralPath $taskDirectory -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'A service directory contains a reparse point; installation stopped.' }
    }
}
$taskExisting=Get-CimInstance Win32_Service -Filter "Name='WayrillService'"
if ($taskExisting) {
    if ($taskExisting.PathName -ne $taskCommand) { throw 'An existing service has a different path or owner. Uninstall it explicitly before changing ownership.' }
    if ((Get-Service WayrillService).Status -ne 'Stopped') { throw 'Stop routing and prepare the existing installation before replacing its service files.' }
    Assert-WayrillRecoveryComplete
}
New-Item -ItemType Directory -Path $taskTarget,$taskData -Force | Out-Null
function Protect-WayrillDirectory([string]$Path,[bool]$AllowRead,[bool]$OwnerRead=$false) {
    # Replace the entire ACL, including any explicit permissions left by a pre-existing
    # directory. Changing only inherited/granted entries can retain an unsafe owner ACE.
    foreach($taskItem in @((Get-Item -LiteralPath $Path)) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force)) {
        $taskAcl=if($taskItem.PSIsContainer){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
        $taskAcl.SetAccessRuleProtection($true,$false)
        $taskAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
        foreach($taskPrincipal in @('S-1-5-18','S-1-5-32-544') + $(if($AllowRead){@('S-1-5-32-545','S-1-5-19')}elseif($OwnerRead){@($OwnerSid)}else{@()})) {
            $taskRights=if($taskPrincipal -in @('S-1-5-32-545','S-1-5-19',$OwnerSid)){[Security.AccessControl.FileSystemRights]::ReadAndExecute}else{[Security.AccessControl.FileSystemRights]::FullControl}
            $taskSid=[Security.Principal.SecurityIdentifier]::new($taskPrincipal)
            $taskRule=if($taskItem.PSIsContainer){[Security.AccessControl.FileSystemAccessRule]::new($taskSid,$taskRights,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)}else{[Security.AccessControl.FileSystemAccessRule]::new($taskSid,$taskRights,[Security.AccessControl.AccessControlType]::Allow)}
            $taskAcl.AddAccessRule($taskRule)
        }
        Set-Acl -LiteralPath $taskItem.FullName -AclObject $taskAcl
    }
}
Protect-WayrillDirectory (Join-Path $env:ProgramFiles 'Wayrill') $true
Protect-WayrillDirectory $taskData $false
$taskLogs=Join-Path $taskData 'Logs'
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
Protect-WayrillDirectory $taskLogs $false $true
foreach ($taskEntry in $taskManifest.files) {
    # NSIS has already installed this payload (including preserved newer DATs).
    if ($taskInPlace) { continue }
    $taskSource=Join-Path $taskBundle $taskEntry.path
    $taskDestination=Join-Path $taskTarget $taskEntry.path
    New-Item -ItemType Directory -Path (Split-Path $taskDestination -Parent) -Force | Out-Null
    if (-not $taskInPlace -and $taskEntry.path -match '^xray\\[^\\/]+\.dat$' -and (Test-Path -LiteralPath $taskDestination) -and (Get-Item -LiteralPath $taskDestination).LastWriteTimeUtc -gt (Get-Item -LiteralPath $taskSource).LastWriteTimeUtc) { continue }
    if ((Test-Path -LiteralPath $taskDestination) -and (Get-FileHash -LiteralPath $taskDestination -Algorithm SHA256).Hash -eq $taskEntry.sha256) { continue }
    if ($taskEntry.path -eq 'windivert\WinDivert64.sys' -and (Test-Path -LiteralPath $taskDestination) -and @(Get-CimInstance Win32_SystemDriver | Where-Object { $_.Name -like 'WinDivert*' -and $_.State -eq 'Running' }).Count) { throw 'A shared WinDivert driver is active; an in-place driver binary upgrade requires explicit maintenance.' }
    Copy-Item -LiteralPath $taskSource -Destination $taskDestination -Force
}
if ([IO.Path]::GetFullPath($taskBundle) -ne [IO.Path]::GetFullPath($taskTarget)) { Copy-Item -LiteralPath (Join-Path $taskBundle 'manifest.json') -Destination $taskTarget -Force }
if (-not $taskExisting) { New-Service -Name WayrillService -DisplayName 'Wayrill Networking Service' -BinaryPathName $taskCommand -StartupType Automatic -Description 'Wayrill networking coordinator. Routing starts on request or when explicitly enabled for Windows startup.' | Out-Null }
foreach ($taskArguments in @(
    @('config','WayrillService','start=','auto'),
    @('sidtype','WayrillService','unrestricted'),
    @('privs','WayrillService','SeChangeNotifyPrivilege/SeImpersonatePrivilege/SeTcbPrivilege/SeAssignPrimaryTokenPrivilege/SeIncreaseQuotaPrivilege/SeLoadDriverPrivilege/SeDebugPrivilege'),
    @('failure','WayrillService','reset=','86400','actions=','restart/3000/restart/10000/restart/30000'),
    @('failureflag','WayrillService','1'),
    @('sdset','WayrillService',('D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCLORC;;;'+$OwnerSid+')'))
)) { & sc.exe @taskArguments | Out-Null; if ($LASTEXITCODE -ne 0) { throw "SCM configuration failed: $($taskArguments[0])" } }
& $taskExe --configure-service
if ($LASTEXITCODE -ne 0) { throw 'SCM pre-shutdown configuration failed.' }
$taskResumeFailure=$null
Start-WayrillInstalledService
if ($UpgradeTransaction) {
    $taskReceipt=Join-Path $taskData 'upgrade-result.json'
    $taskDeadline=[DateTime]::UtcNow.AddSeconds(360)
    $taskResult=$null
    do {
        if (Test-Path -LiteralPath $taskReceipt) {
            $taskCandidate=Get-Content -LiteralPath $taskReceipt -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($taskCandidate.transactionId -eq $UpgradeTransaction) { $taskResult=$taskCandidate; break }
        }
        if ((Get-Service WayrillService).Status -eq 'Stopped') { throw (Get-WayrillStartupError) }
        # This query does not wait behind the routing lifecycle lock. A fresh
        # phase observation extends inactivity, not an arbitrary startup budget.
        $taskProgress=Invoke-WayrillInstallerApi -Method service.activity -OwnerSid $OwnerSid
        if ($taskProgress.lifecycle -and $taskProgress.idleMs -lt 45000) { $taskDeadline=[DateTime]::UtcNow.AddSeconds(360) }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    if (-not $taskResult) { throw 'The new service did not complete routing resumption. The applied profile was preserved; inspect it in Wayrill before starting routing.' }
    if (-not $taskResult.ok) {
        # A completed routing failure is recoverable through the installed app.
        # SCM/IPC/version failures and an unfinished transition still fail setup.
        $taskResumeFailure=$taskResult.error
    }
}
$taskHealth=$null
$taskDeadline=[DateTime]::UtcNow.AddSeconds(360)
do {
    try { $taskHealth=Invoke-WayrillInstallerApi -Method service.status -OwnerSid $OwnerSid; break }
    catch {
        if ((Get-Service WayrillService).Status -eq 'Stopped') { throw (Get-WayrillStartupError) }
        if ([DateTime]::UtcNow -ge $taskDeadline) { throw }
        Start-Sleep -Seconds 1
    }
} while ($true)
if ($taskHealth.serviceVersion -ne $taskManifest.serviceVersion) { throw 'The installed service version does not match the package.' }
$taskRecoveryWarning=Join-Path $taskTarget 'Installation-Recovery.txt'
$taskWarning=if ($taskHealth.config.recoveryError) {
    "Saved configuration could not be verified: $($taskHealth.config.recoveryError.message)"
} elseif ($taskResumeFailure) {
    "Previous routing could not resume ($($taskResumeFailure.code)): $($taskResumeFailure.message)"
} else { $null }
if ($taskWarning) {
    [IO.File]::WriteAllText($taskRecoveryWarning,$taskWarning,[Text.UTF8Encoding]::new($false))
    Write-Warning $taskWarning
} elseif (Test-Path -LiteralPath $taskRecoveryWarning) { Remove-Item -LiteralPath $taskRecoveryWarning }
$taskOldWarning=Join-Path $taskTarget 'Profile-Recovery.txt'
if (Test-Path -LiteralPath $taskOldWarning) { Remove-Item -LiteralPath $taskOldWarning }
'Wayrill service installed. The previous runtime was resumed when available; Windows startup routing remains controlled by Startup settings.'
