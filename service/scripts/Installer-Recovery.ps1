param([switch]$Recover)

$wayrillRecoveryName = 'WayrillInstallerRecovery'
$wayrillRecoveryData = Join-Path $env:ProgramData 'Wayrill'
$wayrillRecoveryRoot = Join-Path $wayrillRecoveryData 'installer-recovery'
$wayrillRecoveryState = Join-Path $wayrillRecoveryRoot 'state.json'
$wayrillRecoveryTarget = Join-Path $env:ProgramFiles 'Wayrill\Service'

function Lock-WayrillInstallerRecovery {
    if (-not (Test-Path -LiteralPath $wayrillRecoveryData)) { return }
    [IO.File]::Open((Join-Path $wayrillRecoveryData 'installer-recovery.lock'),'OpenOrCreate','ReadWrite','None')
}

function Read-WayrillInstallerRecovery {
    if (-not [IO.File]::Exists($wayrillRecoveryState)) { return }
    $state = Get-Content -LiteralPath $wayrillRecoveryState -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.version -ne 1 -or $state.phase -notin @('armed','replacing','restored','ready') -or
        $state.ownerSid -notmatch '^S-1-(5-21|12-1)-[0-9-]+$' -or $state.installerPid -le 0 -or
        $state.installerStarted -le 0 -or $state.startMode -notin @('auto','delayed-auto','demand','disabled')) {
        throw 'Invalid installer recovery record.'
    }
    $state
}

function Get-WayrillProcessStart([int]$ProcessId) {
    if ($ProcessId -le 0) { return }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return }
    try { $process.StartTime.ToUniversalTime().Ticks }
    finally { $process.Dispose() }
}

function Test-WayrillInstallerAlive($State) {
    $started = Get-WayrillProcessStart $State.installerPid
    $null -ne $started -and $started -eq $State.installerStarted
}

function Remove-WayrillInstallerRecovery {
    # Remove the receipt first. If cleanup is interrupted, the scheduled task
    # can finish deleting the retired copy without replaying the transition.
    if ([IO.File]::Exists($wayrillRecoveryState)) { [IO.File]::Delete($wayrillRecoveryState) }
    if (Get-ScheduledTask -TaskName $wayrillRecoveryName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $wayrillRecoveryName -Confirm:$false
    }
    if (Test-Path -LiteralPath $wayrillRecoveryRoot) {
        Remove-Item -LiteralPath $wayrillRecoveryRoot -Recurse -Force
    }
}

function Copy-WayrillRecoveryFile([string]$Source,[string]$Destination) {
    $inputStream = [IO.File]::OpenRead($Source)
    try {
        $outputStream = [IO.File]::Open($Destination,'Create','Write','None')
        try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) }
        finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
}

function Start-WayrillInstallerRecovery([int]$InstallerPid, [string]$OwnerSid, $Service) {
    if (Read-WayrillInstallerRecovery) { throw 'An interrupted Wayrill installation is awaiting recovery. Retry setup after recovery completes.' }
    if (Test-Path -LiteralPath $wayrillRecoveryRoot) { Remove-WayrillInstallerRecovery }
    $started = Get-WayrillProcessStart $InstallerPid
    if (-not $started) { throw 'The installer process ended before preparation.' }
    $serviceStarted = Get-WayrillProcessStart $Service.ProcessId
    $startMode = switch ($Service.StartMode) {
        'Auto' {
            if ((Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\WayrillService' -Name DelayedAutoStart -ErrorAction SilentlyContinue).DelayedAutoStart) { 'delayed-auto' }
            else { 'auto' }
        }
        'Manual' { 'demand' }
        'Disabled' { 'disabled' }
        default { throw 'Cannot determine the previous Wayrill service startup mode.' }
    }
    $backup = Join-Path $wayrillRecoveryRoot 'package'
    try {
        # The installed service data directory already restricts writes to
        # SYSTEM and Administrators. All recovery inputs inherit that ACL.
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        $manifest = Join-Path $wayrillRecoveryTarget 'manifest.json'
        $priorManifestExists = [IO.File]::Exists($manifest)
        $entries = if ($priorManifestExists) { Read-WayrillPackageManifest $manifest }
                   else { Read-WayrillPackageManifest (Join-Path $PSScriptRoot 'installer-manifest.json') }
        $files = [Collections.Generic.List[object]]::new()
        foreach ($entry in $entries.GetEnumerator()) {
            if ($entry.Key -match '^xray\\.*\.dat$') { continue }
            $source = Join-Path $wayrillRecoveryTarget $entry.Key
            # A repair can start with missing files. Preserve the prior bytes
            # that still exist without requiring an intact installation to fix.
            if (-not [IO.File]::Exists($source)) { continue }
            $destination = Join-Path $backup $entry.Key
            New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
            Copy-WayrillRecoveryFile $source $destination
            # Older maintenance can leave immutable files at hashes different
            # from the shipping manifest. Record and verify the actual prior bytes.
            $entry.Value.sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
            if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $entry.Value.sha256) { throw "Installed service file changed during backup: $($entry.Key)" }
            $files.Add($entry.Value)
        }
        if ($priorManifestExists) {
            Copy-WayrillRecoveryFile $manifest (Join-Path $backup 'manifest.json')
            $files.Add(@{path='manifest.json';sha256=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash})
        }
        $hashes = [ordered]@{apiVersion=1;serviceVersion='recovery';files=$files}
        Save-WayrillUpgradeHandoff $hashes (Join-Path $backup 'snapshot.json')
        foreach ($name in @('Installer-Recovery.ps1','Installer-Lifecycle.ps1','Package-Files.ps1')) {
            Copy-WayrillRecoveryFile (Join-Path $PSScriptRoot $name) (Join-Path $wayrillRecoveryRoot $name)
        }
        $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $script = Join-Path $wayrillRecoveryRoot 'Installer-Recovery.ps1'
        $action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script+'" -Recover')
        $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $wayrillRecoveryName -Action $action -Trigger $triggers -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
        # Do not publish an armed record until the watchdog exists. The lock
        # excludes the watchdog while we publish the record and retire routing.
        Save-WayrillUpgradeHandoff ([ordered]@{
            version=1; phase='armed'; ownerSid=$OwnerSid; installerPid=$InstallerPid;
            installerStarted=$started; startMode=$startMode; wasRunning=$Service.State -eq 'Running';
            serviceStarted=$serviceStarted
        }) $wayrillRecoveryState
    } catch {
        Remove-WayrillInstallerRecovery
        throw
    }
}

function Set-WayrillInstallerRecoveryPhase([int]$InstallerPid,[string]$OwnerSid,[string]$Phase) {
    $state = Read-WayrillInstallerRecovery
    if (-not $state -or $state.installerPid -ne $InstallerPid -or $state.ownerSid -ne $OwnerSid -or -not (Test-WayrillInstallerAlive $state)) {
        throw 'Installer recovery does not belong to this setup process.'
    }
    $expected = if ($Phase -eq 'ready') { 'replacing' } else { 'armed' }
    if ($state.phase -ne $expected) { throw 'Unexpected installer recovery phase.' }
    $state.phase = $Phase
    Save-WayrillUpgradeHandoff $state $wayrillRecoveryState
}

function Restore-WayrillInstallerPackage([bool]$OnlyCompanion) {
    $backup = Join-Path $wayrillRecoveryRoot 'package'
    $entries = Read-WayrillPackageManifest (Join-Path $backup 'snapshot.json')
    # Verify every selected file before writing any of them.
    $files = if ($OnlyCompanion) {
        if ($entries.ContainsKey('wayrill-companion.exe')) { 'wayrill-companion.exe' }
    } else { @($entries.Keys) }
    foreach ($name in $files) {
        $source = Join-Path $backup $name
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $entries[$name].sha256) { throw "Invalid installer recovery copy: $name" }
    }
    foreach ($name in $files) {
        $destination = Join-Path $wayrillRecoveryTarget $name
        if ([IO.File]::Exists($destination) -and (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $entries[$name].sha256) { continue }
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-WayrillRecoveryFile (Join-Path $backup $name) $destination
    }
}

function Set-WayrillServiceStartup([string]$Mode) {
    & sc.exe config WayrillService start= $Mode | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot restore Wayrill service startup.' }
}

function Assert-WayrillReplacementPackage {
    $entries = Read-WayrillPackageManifest (Join-Path $wayrillRecoveryTarget 'manifest.json')
    foreach ($entry in $entries.GetEnumerator()) {
        if ($entry.Key -match '^xray\\.*\.dat$') { continue }
        $path = Join-Path $wayrillRecoveryTarget $entry.Key
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.Value.sha256) {
            throw "Incomplete replacement service package: $($entry.Key)"
        }
    }
}

if ($Recover) {
    $ErrorActionPreference = 'Stop'
    . (Join-Path $PSScriptRoot 'Installer-Lifecycle.ps1')
    . (Join-Path $PSScriptRoot 'Package-Files.ps1')
    try { $lock = Lock-WayrillInstallerRecovery } catch [IO.IOException] { return }
    try {
        $state = Read-WayrillInstallerRecovery
        if (-not $state) { Remove-WayrillInstallerRecovery; return }
        if (Test-WayrillInstallerAlive $state) { return }
        $service = Get-CimInstance Win32_Service -Filter "Name='WayrillService'"
        if ($service.PathName -ne ('"'+(Join-Path $wayrillRecoveryTarget 'wayrill-service.exe')+'" --owner-sid '+$state.ownerSid)) { throw 'Installer recovery found a different service or owner.' }
        $serviceState = $service.State
        if ($state.phase -eq 'ready') {
            try {
                if ($serviceState -eq 'Stopped') { Assert-WayrillReplacementPackage }
                Set-WayrillServiceStartup 'auto'
                Start-WayrillInstalledService
            }
            catch {
                # Let a start in progress settle. A rejected candidate can be
                # replaced by the previous service while its handoff survives.
                if ((Get-Service -Name WayrillService).Status -ne 'Stopped') { throw }
                $serviceState = 'Stopped'
                $state.phase = 'replacing'
                Save-WayrillUpgradeHandoff $state $wayrillRecoveryState
            }
        }
        if ($state.phase -eq 'armed') {
            Restore-WayrillInstallerPackage $true
        } elseif ($state.phase -eq 'replacing') {
            if ($serviceState -eq 'Running') {
                # Setup cannot have copied service files while SCM is running.
                # An unconsumed handoff still needs a restart to resume routing.
                $handoffPath = Join-Path $wayrillRecoveryData 'upgrade-resume.json'
                $handoff = if ([IO.File]::Exists($handoffPath)) {
                    Get-Content -LiteralPath $handoffPath -Raw -Encoding UTF8 | ConvertFrom-Json
                }
                if ($handoff -and -not $handoff.phase -and $state.serviceStarted -and
                    (Get-WayrillProcessStart $service.ProcessId) -eq $state.serviceStarted) {
                    Stop-WayrillInstalledService -RecoveringInstallation
                    $serviceState = 'Stopped'
                } else {
                    Restore-WayrillInstallerPackage $true
                }
            }
            if ($serviceState -eq 'Stopped') {
                Restore-WayrillInstallerPackage $false
                $state.phase = 'restored'
                Save-WayrillUpgradeHandoff $state $wayrillRecoveryState
            } elseif ($serviceState -ne 'Running') {
                throw 'Waiting for the interrupted service transition to settle.'
            }
        }
        if ($state.phase -eq 'restored') {
            Set-WayrillServiceStartup $state.startMode
            if ($state.wasRunning) { Start-WayrillInstalledService }
        }
        Remove-WayrillInstallerRecovery
    } catch {
        if (Test-Path -LiteralPath $wayrillRecoveryRoot) {
            Set-Content -LiteralPath (Join-Path $wayrillRecoveryRoot 'last-error.txt') -Value $_.Exception.Message -Encoding UTF8
        }
        throw
    } finally {
        if ($lock) { $lock.Dispose() }
    }
}
