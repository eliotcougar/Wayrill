# Shared by installation and removal. Only graceful, owner-scoped operations.
function Protect-WayrillInstallerFile([string]$Path) {
    $taskAcl=[Security.AccessControl.FileSecurity]::new()
    $taskAcl.SetAccessRuleProtection($true,$false)
    $taskAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
    foreach($taskSid in @('S-1-5-18','S-1-5-32-544')) {
        $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($taskSid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $taskAcl
}
function Get-WayrillStartupError {
    $taskErrorFile=Join-Path $env:ProgramData 'Wayrill\last-service-error.json'
    if (Test-Path -LiteralPath $taskErrorFile) {
        try {
            $taskFailure=Get-Content -LiteralPath $taskErrorFile -Raw -Encoding UTF8 | ConvertFrom-Json
            return "Service startup failed ($($taskFailure.code)): $($taskFailure.message)"
        } catch { }
    }
    return 'The networking service failed to start. Check Windows Event Viewer and ProgramData\Wayrill\last-service-error.json from an Administrator PowerShell window.'
}
function Start-WayrillInstalledService {
    try {
        Start-Service -Name WayrillService
        (Get-Service WayrillService).WaitForStatus('Running',[TimeSpan]::FromSeconds(120))
    } catch { throw (Get-WayrillStartupError) }
}
function Invoke-WayrillInstallerApi {
    param([ValidateSet('service.status','service.activity','system.capture.get','core.stop','core.stopForUpgrade')][string]$Method,[string]$OwnerSid)
    $taskCli=Join-Path $env:ProgramFiles 'Wayrill\Service\wayrillctl.exe'
    $taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($taskSid -eq $OwnerSid -or $taskSid -eq 'S-1-5-18') {
        $taskText=(& $taskCli call $Method | Out-String)
        $taskExit=$LASTEXITCODE
    } else {
        # Alternate UAC credentials remain unauthorized in the public API. Run
        # just these three fixed installer operations as SYSTEM, in a private
        # work directory; no parameters, credentials or arbitrary command path.
        $taskId=[Guid]::NewGuid().ToString('N')
        $taskName='Wayrill-Installer-'+$taskId
        $taskWork=Join-Path $env:ProgramData ('Wayrill\installer-'+$taskId)
        New-Item -ItemType Directory -Path $taskWork | Out-Null
        $taskAcl=[Security.AccessControl.DirectorySecurity]::new()
        $taskAcl.SetAccessRuleProtection($true,$false)
        $taskAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
        foreach($taskPrincipal in @('S-1-5-18','S-1-5-32-544')) {
            $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($taskPrincipal),[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
        }
        Set-Acl -LiteralPath $taskWork -AclObject $taskAcl
        $taskScript=Join-Path $taskWork 'call.ps1'
        $taskOutput=Join-Path $taskWork 'result.json'
        $taskSource=@'
param([ValidateSet('service.status','service.activity','system.capture.get','core.stop','core.stopForUpgrade')][string]$Method)
$ErrorActionPreference='Stop'
$taskText=(& (Join-Path $env:ProgramFiles 'Wayrill\Service\wayrillctl.exe') call $Method | Out-String)
$taskExit=$LASTEXITCODE
[ordered]@{exitCode=$taskExit;text=$taskText} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.tmp') -Encoding UTF8
Move-Item -LiteralPath (Join-Path $PSScriptRoot 'result.tmp') -Destination (Join-Path $PSScriptRoot 'result.json')
'@
        Set-Content -LiteralPath $taskScript -Value $taskSource -Encoding UTF8
        $taskRegistered=$false
        try {
            $taskAction=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$taskScript+'" -Method '+$Method)
            $taskPrincipal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
            $taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            Register-ScheduledTask -TaskName $taskName -Action $taskAction -Principal $taskPrincipal -Settings $taskSettings | Out-Null
            $taskRegistered=$true
            Start-ScheduledTask -TaskName $taskName
            $taskStarted=$false
            $taskStartDeadline=[DateTime]::UtcNow.AddSeconds(30)
            do {
                $taskState=(Get-ScheduledTask -TaskName $taskName).State
                if ($taskState -eq 'Running') { $taskStarted=$true }
                if ((Test-Path -LiteralPath $taskOutput) -and $taskState -ne 'Running') { break }
                if ($taskStarted -and $taskState -ne 'Running') { throw 'The installer service command ended without a result.' }
                if (-not $taskStarted -and [DateTime]::UtcNow -ge $taskStartDeadline) { throw 'The installer service task did not start.' }
                # The CLI bounds transport inactivity and follows correlated
                # native progress. Do not kill it at an arbitrary total duration.
                Start-Sleep -Milliseconds 200
            } while ($true)
            if (-not (Test-Path -LiteralPath $taskOutput) -or (Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { throw 'The installer could not complete its service handoff. Existing files were preserved.' }
            $taskReply=Get-Content -LiteralPath $taskOutput -Raw -Encoding UTF8 | ConvertFrom-Json
            $taskText=$taskReply.text
            $taskExit=$taskReply.exitCode
        } finally {
            # Never terminate an in-flight restore, or remove its work files.
            if (-not $taskRegistered -or (Get-ScheduledTask -TaskName $taskName).State -ne 'Running') {
                if ($taskRegistered) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
                Remove-Item -LiteralPath $taskWork -Recurse -Force
            }
        }
    }
    try { $taskReply=$taskText | ConvertFrom-Json } catch { throw 'The service returned an unreadable installer response.' }
    if ($taskExit -ne 0 -or -not $taskReply.ok) { throw ("Service handoff failed ($($taskReply.error.code)): $($taskReply.error.message)") }
    return $taskReply.result
}
function Close-WayrillDesktop([string]$OwnerSid) {
    $taskPath=Join-Path $env:ProgramFiles 'Wayrill\Wayrill.exe'
    $taskSession=[Diagnostics.Process]::GetCurrentProcess().SessionId
    foreach($taskInstance in @(Get-CimInstance Win32_Process -Filter "Name='Wayrill.exe'" | Where-Object ExecutablePath -EQ $taskPath)) {
        $taskOwner=(Invoke-CimMethod -InputObject $taskInstance -MethodName GetOwnerSid).Sid
        if ($taskOwner -ne $OwnerSid -or $taskInstance.SessionId -ne $taskSession) { throw 'Wayrill is open in another desktop session. Close it there before installing or removing it.' }
        $taskProcess=Get-Process -Id $taskInstance.ProcessId -ErrorAction SilentlyContinue
        if (-not $taskProcess) { continue }
        try {
            # Hidden tray windows have no MainWindowHandle. The single-instance
            # activation requests a saved exit in the existing owner's session.
            # Older installations still use their original WM_CLOSE workflow.
            $taskVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($taskPath)
            if ([Version]::new($taskVersion.FileMajorPart,$taskVersion.FileMinorPart,$taskVersion.FileBuildPart) -ge [Version]'0.29.38') {
                $taskActivation=Start-Process -FilePath $taskPath -ArgumentList '--exit' -PassThru -WindowStyle Hidden
                $taskActivation.Dispose()
            } elseif (-not $taskProcess.CloseMainWindow()) {
                $taskProcess.Refresh()
                if (-not $taskProcess.HasExited) { throw "Wayrill (PID $($taskInstance.ProcessId)) could not receive a close request. Close its open dialog or window before retrying setup." }
            }
            if (-not $taskProcess.WaitForExit(90000)) {
                throw "Wayrill (PID $($taskInstance.ProcessId)) did not finish saving and closing. Check its window for a save error or close-recovery prompt, then retry setup. No files were replaced."
            }
        } finally { $taskProcess.Dispose() }
    }
}
function Assert-WayrillRecoveryComplete {
    foreach($taskJournal in @('proxy-lease.json','traffic-settings-leases.json','tun-sharing-lease.json')) {
        if (Test-Path -LiteralPath (Join-Path $env:ProgramData ('Wayrill\'+$taskJournal))) {
            throw "Windows settings recovery remains pending ($taskJournal). Resolve it in Wayrill before changing the installed files."
        }
    }
}
function Stop-WayrillInstalledService {
    $taskOriginalMode=(Get-CimInstance Win32_Service -Filter "Name='WayrillService'").StartMode
    # Prevent failure-action restarts of the old executable during replacement,
    # including an older service repeatedly failing profile initialization.
    & sc.exe config WayrillService start= disabled | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not suspend service restarts during installation.' }
    try {
        $taskController=Get-Service -Name WayrillService
        if ($taskController.Status -ne 'Stopped') {
            try { $taskController.Stop() }
            catch {
                $taskController.Refresh()
                if ($taskController.Status -notin @('StartPending','StopPending','Stopped')) { throw }
            }
            $taskController.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(180))
        }
        Assert-WayrillRecoveryComplete
    } catch {
        $taskFailure=$_
        $taskMode=switch($taskOriginalMode){'Auto'{'auto'};'Manual'{'demand'};default{'disabled'}}
        & sc.exe config WayrillService start= $taskMode | Out-Null
        throw $taskFailure
    }
}
function Test-WayrillRetiredRuntime($Snapshot) {
    # A failed, fully retired runtime must remain upgradeable. Live capture,
    # adapter handles, FakeDNS and Windows setting leases still require Stop.
    return $null -ne $Snapshot -and
        $Snapshot.core.state -in @('stopped','failed') -and
        -not $Snapshot.core.pid -and
        $Snapshot.tun.state -eq 'stopped' -and
        -not $Snapshot.tun.pid -and -not $Snapshot.tun.keeperPid -and
        -not $Snapshot.tun.sharedPid -and -not $Snapshot.tun.interfaceIndex -and
        $Snapshot.capture.state -eq 'stopped' -and -not $Snapshot.fakeDns -and
        $Snapshot.tun.sharing.managed -eq $false -and
        $Snapshot.tun.sharing.recoveryPending -eq $false -and
        $Snapshot.systemProxy.managed -eq $false -and
        $Snapshot.systemCapture.managed -eq $false
}
function Invoke-WayrillUpgradeHelper([string]$Argument) {
    $taskRepair=Join-Path $PSScriptRoot 'upgrade-protection.exe'
    $taskManifestPath=Join-Path $PSScriptRoot 'installer-manifest.json'
    if (-not (Test-Path -LiteralPath $taskRepair) -or -not (Test-Path -LiteralPath $taskManifestPath)) { return $false }
    $taskManifest=Get-Content -LiteralPath $taskManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $taskExpected=@($taskManifest.files | Where-Object path -EQ 'wayrill-service.exe')
    if ($taskExpected.Count -ne 1 -or (Get-FileHash -LiteralPath $taskRepair).Hash -ne $taskExpected[0].sha256) { throw 'Upgrade protection helper integrity check failed. Routing was preserved.' }
    & $taskRepair $Argument
    if ($LASTEXITCODE -ne 0) { throw 'Upgrade protection could not be armed. Routing and installed files were preserved.' }
    return $true
}
function Initialize-WayrillUpgradeProtection { Invoke-WayrillUpgradeHelper '--prepare-upgrade-protection' }
function Initialize-WayrillSharingProtection {
    if (-not (Invoke-WayrillUpgradeHelper '--prepare-sharing-upgrade')) { throw 'The sharing protection helper is missing. Routing and installed files were preserved.' }
}
function Stop-WayrillRouting([string]$OwnerSid,[switch]$ForUpgrade) {
    $taskMethod='core.stop'
    if ($ForUpgrade) {
        Initialize-WayrillSharingProtection
        $taskCurrent=Invoke-WayrillInstallerApi -Method service.status -OwnerSid $OwnerSid
        if ($null -ne $taskCurrent.appProtection) { $taskMethod='core.stopForUpgrade' }
    }
    try { $taskState=Invoke-WayrillInstallerApi -Method $taskMethod -OwnerSid $OwnerSid }
    catch {
        $taskFailure=$_
        # A failure in unused retained-adapter bookkeeping must not prevent
        # installing its repair. Observe once; never retry or force-kill Stop.
        $taskState=Invoke-WayrillInstallerApi -Method service.status -OwnerSid $OwnerSid
        if ($ForUpgrade -and $taskMethod -eq 'core.stopForUpgrade' -and
            $taskState.appProtection.phase -eq 'upgrade' -and
            $taskState.appProtection.error.code -eq 'APP_PROTECTION' -and
            [Version]$taskState.serviceVersion -le [Version]'0.31.18') {
            # Older services cannot arm protection for a removed executable and
            # leave Upgrade recorded after failure. The new installer can arm
            # that same saved list, then ask the old service to retire while its
            # Upgrade phase retains the persistent barrier. No target is skipped.
            if (Initialize-WayrillUpgradeProtection) {
                $taskState=Invoke-WayrillInstallerApi -Method core.stop -OwnerSid $OwnerSid
            }
        }
        if (-not (Test-WayrillRetiredRuntime $taskState)) { throw $taskFailure }
    }
    if (-not (Test-WayrillRetiredRuntime $taskState)) { throw 'Routing has not fully stopped. Installed files were preserved.' }
    Assert-WayrillRecoveryComplete
}
function Save-WayrillUpgradeHandoff($Intent,[string]$Path) {
    $taskTemporary=$Path+'.tmp'
    [IO.File]::WriteAllText($taskTemporary,($Intent | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
    Protect-WayrillInstallerFile $taskTemporary
    Move-Item -LiteralPath $taskTemporary -Destination $Path -Force
}
