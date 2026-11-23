param([ValidateSet('Prepare','Install','Uninstall')][string]$Action,[string]$PreviousManifest,[string]$LogPath,[int]$InstallerPid)
$ErrorActionPreference='Stop'
if ($LogPath) {
 # NSIS reads this fixed UTF-16LE boundary. Do not send localized PowerShell
 # warnings/errors through nsExec's ANSI/OEM stdout decoder.
 $taskLog=[IO.StreamWriter]::new($LogPath,$false,[Text.Encoding]::Unicode)
 $taskExit=0
 try {
 & $PSCommandPath -Action $Action -PreviousManifest $PreviousManifest -InstallerPid $InstallerPid *>&1 |
   Out-String -Stream | ForEach-Object { $taskLog.WriteLine($_) }
 } catch {
  $taskLog.WriteLine($_.Exception.Message)
  $taskExit=1
 } finally { $taskLog.Dispose() }
 exit $taskExit
}
. (Join-Path $PSScriptRoot 'Installer-Lifecycle.ps1')
. (Join-Path $PSScriptRoot 'Installer-Recovery.ps1')
. (Join-Path $PSScriptRoot 'Package-Files.ps1')
$taskRoot=Join-Path $env:ProgramFiles 'Wayrill'
$taskTarget=Join-Path $taskRoot 'Service'
$taskSession=[Diagnostics.Process]::GetCurrentProcess().SessionId
$taskShells=@(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { $_.SessionId -eq $taskSession -and $_.ExecutablePath -eq (Join-Path $env:WINDIR 'explorer.exe') })
$taskOwners=@($taskShells | ForEach-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid } | Sort-Object -Unique)
if ($taskOwners.Count -ne 1 -or $taskSession -eq 0) { throw 'Install from the intended user desktop.' }
$taskOwner=$taskOwners[0]
if ($taskOwner -notmatch '^S-1-(5-21|12-1)-[0-9-]+$') { throw 'Cannot identify the interactive owner.' }
foreach($taskDir in @($taskRoot,(Join-Path $env:ProgramData 'Wayrill'))) {
 if (Test-Path -LiteralPath $taskDir) {
  if ((Get-Item -LiteralPath $taskDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or @(Get-ChildItem -LiteralPath $taskDir -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Installation directories contain a reparse point.' }
 }
}
$taskService=Get-CimInstance Win32_Service -Filter "Name='WayrillService'"
if($taskService -and $taskService.PathName -ne ('"'+$taskTarget+'\wayrill-service.exe" --owner-sid '+$taskOwner)) { throw 'An existing service belongs to a different installation or user.' }
$taskInstallerLock=Lock-WayrillInstallerRecovery
try {
if ($Action -ne 'Install' -and (Read-WayrillInstallerRecovery)) { throw 'An interrupted Wayrill installation is awaiting recovery. Retry after recovery completes.' }
switch($Action) {
 'Prepare' {
  $taskManifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installer-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $taskDriver=$taskManifest.files | Where-Object path -eq 'windivert\WinDivert64.sys'
  $taskSys=Join-Path $taskTarget 'windivert\WinDivert64.sys'
  if((Test-Path -LiteralPath $taskSys) -and (Get-FileHash -LiteralPath $taskSys -Algorithm SHA256).Hash -ne $taskDriver.sha256) { throw 'A different shared WinDivert driver needs explicit maintenance before this upgrade.' }
  if ($taskService -and $InstallerPid) { Start-WayrillInstallerRecovery $InstallerPid $taskOwner $taskService }
  Invoke-WayrillWithoutCompanion -Path (Join-Path $taskTarget 'wayrill-companion.exe') -OwnerSid $taskOwner -Action {
  Close-WayrillDesktop $taskOwner
  $taskResume=Join-Path $env:ProgramData 'Wayrill\upgrade-resume.json'
  $taskIntent=$null
  if (Test-Path -LiteralPath $taskResume) {
   # Retry a failed file-copy/install step without discarding the protected
   # handoff. The new service still validates every field and settings version.
   $taskPending=Get-Content -LiteralPath $taskResume -Raw -Encoding UTF8 | ConvertFrom-Json
   if ($taskPending.phase -eq 'retrying') { $taskPending=$taskPending.intent }
   if ($taskPending.phase -ne 'completed') {
    $taskProfile=Join-Path $env:ProgramData 'Wayrill\profile.json'
    $taskProfileHash=if(Test-Path -LiteralPath $taskProfile){(Get-FileHash -LiteralPath $taskProfile -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null}
    if (-not $taskService -or $taskPending.version -ne 1 -or $taskPending.ownerSid -ne $taskOwner -or $taskPending.transactionId -notmatch '^[a-f0-9]{32}$' -or $taskPending.profileSha256 -cne $taskProfileHash) { throw 'The pending upgrade handoff does not match this installation. Its profile and installed files were preserved.' }
    $taskIntent=$taskPending
   }
  }
  if($taskService) {
   if ((Get-Service WayrillService).Status -eq 'Running') {
    $taskBefore=Invoke-WayrillInstallerApi -Method service.status -OwnerSid $taskOwner
    $taskCapture=Invoke-WayrillInstallerApi -Method system.capture.get -OwnerSid $taskOwner
    if ($taskBefore.core.state -notin @('running','stopped','failed') -or $taskBefore.config.revision -ne $taskCapture.revision) { throw 'The runtime is not ready for an upgrade. Wait for its current operation to finish.' }
    $taskBindings=@($taskCapture.rows | Where-Object { $_.managed -and $_.request } | ForEach-Object {
     $taskBinding=$_.request
     if ($_.restoreVersion) { $taskBinding.expectedVersion=$_.restoreVersion }
     $taskBinding
    })
    if ($taskIntent -and -not $taskBindings.Count) { $taskBindings=@($taskIntent.settings) }
    $taskProfile=Join-Path $env:ProgramData 'Wayrill\profile.json'
    $taskProfileHash=if(Test-Path -LiteralPath $taskProfile){(Get-FileHash -LiteralPath $taskProfile -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null}
    $taskId=if($taskIntent){$taskIntent.transactionId}else{[Guid]::NewGuid().ToString('N')}
    $taskResumeRouting=($taskBefore.core.state -eq 'running' -or $taskBefore.recovery.desiredState -eq 'running' -or ($taskIntent -and $taskIntent.resumeRouting))
    $taskIntent=[ordered]@{version=1;transactionId=$taskId;ownerSid=$taskOwner;revision=$taskBefore.config.revision;profileSha256=$taskProfileHash;resumeRouting=$taskResumeRouting;settings=@($taskBindings)}
    # Write intent before retirement. A canceled installer must not lose the
    # information needed to resume routing and its protected applications.
    if ($InstallerPid) { Set-WayrillInstallerRecoveryPhase $InstallerPid $taskOwner 'replacing' }
    Save-WayrillUpgradeHandoff $taskIntent $taskResume
    Stop-WayrillRouting -OwnerSid $taskOwner -ForUpgrade
    $taskAfter=Invoke-WayrillInstallerApi -Method system.capture.get -OwnerSid $taskOwner
    if ($taskAfter.revision -ne $taskBefore.config.revision) { throw 'The applied configuration changed during preparation. Retry the installer.' }
    foreach($taskBinding in $taskBindings) {
     $taskRow=@($taskAfter.rows | Where-Object channel -EQ $taskBinding.channel)
     if ($taskRow.Count -ne 1 -or -not $taskRow[0].supported -or $taskRow[0].managed -or $taskRow[0].conflict) { throw 'The previous proxy assignment cannot be safely resumed.' }
     $taskBinding.expectedVersion=$taskRow[0].version
     # Older services exposed classic WinHTTP as the machine scope on Windows 10.
     if ($taskBinding.channel -eq 'winhttpMachine' -and -not $taskRow[0].advancedSupported) { $taskBinding.channel='winhttpLegacy' }
    }
    $taskProfile=Join-Path $env:ProgramData 'Wayrill\profile.json'
    $taskProfileHash=if(Test-Path -LiteralPath $taskProfile){(Get-FileHash -LiteralPath $taskProfile -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null}
    $taskIntent.settings=@($taskBindings)
    Save-WayrillUpgradeHandoff $taskIntent $taskResume
   }
   else {
    if ($InstallerPid) { Set-WayrillInstallerRecoveryPhase $InstallerPid $taskOwner 'replacing' }
   }
   Stop-WayrillInstalledService
  }
  Assert-WayrillRecoveryComplete
  if ($taskIntent) {
   Save-WayrillUpgradeHandoff $taskIntent $taskResume
   Set-Content -LiteralPath (Join-Path $PSScriptRoot 'upgrade-transaction.txt') -Value $taskIntent.transactionId -Encoding ASCII
  }
  $taskPriorManifest=Join-Path $taskTarget 'manifest.json'
  if (Test-Path -LiteralPath $taskPriorManifest) { Copy-Item -LiteralPath $taskPriorManifest -Destination (Join-Path $PSScriptRoot 'previous-manifest.json') }
  }
 }
 'Install' {
  $taskRecovery=Read-WayrillInstallerRecovery
  if ($taskRecovery -and ($taskRecovery.installerPid -ne $InstallerPid -or $taskRecovery.ownerSid -ne $taskOwner -or
       -not (Test-WayrillInstallerAlive $taskRecovery) -or $taskRecovery.phase -ne 'replacing')) {
   throw 'Installer recovery does not belong to this setup process.'
  }
  $taskRecoveryPid=if($taskRecovery){$InstallerPid}else{0}
  foreach($taskKind in @('geoip','geosite')) {
   $taskOld=Join-Path $taskTarget ('xray\russian-'+$taskKind+'.dat')
   $taskNew=Join-Path $taskTarget ('xray\ru-'+$taskKind+'.dat')
   if(Test-Path -LiteralPath $taskOld) {
    if(-not(Test-Path -LiteralPath $taskNew) -or (Get-Item -LiteralPath $taskOld).LastWriteTimeUtc -gt (Get-Item -LiteralPath $taskNew).LastWriteTimeUtc) {
     Copy-Item -LiteralPath $taskOld -Destination $taskNew -Force
     if((Get-FileHash -LiteralPath $taskOld).Hash -ne (Get-FileHash -LiteralPath $taskNew).Hash) { throw 'Resource rename verification failed.' }
    }
   }
  }
  $taskTransaction=if($PreviousManifest){Join-Path (Split-Path $PreviousManifest -Parent) 'upgrade-transaction.txt'}else{''}
  $taskTransactionId=if($taskTransaction -and (Test-Path -LiteralPath $taskTransaction)){(Get-Content -LiteralPath $taskTransaction -Raw).Trim()}else{''}
  & (Join-Path $taskTarget 'scripts\Install-Service.ps1') -OwnerSid $taskOwner -UpgradeTransaction $taskTransactionId -RecoveryInstallerPid $taskRecoveryPid
  if ($taskRecovery) { Remove-WayrillInstallerRecovery }
  foreach ($taskKind in @('geoip','geosite')) {
   $taskOld=Join-Path $taskTarget ('xray\russian-'+$taskKind+'.dat')
   if (Test-Path -LiteralPath $taskOld) { Remove-Item -LiteralPath $taskOld -Force -ErrorAction SilentlyContinue }
  }
  if ($PreviousManifest -and (Test-Path -LiteralPath $PreviousManifest)) {
   try {
    $taskCleanup=Remove-WayrillObsoletePackageFiles -Target $taskTarget -PreviousManifest $PreviousManifest -CurrentManifest (Join-Path $taskTarget 'manifest.json')
    Write-Output ("Obsolete package files removed: "+$taskCleanup.removed+"; modified or locked files preserved: "+$taskCleanup.preserved)
   } catch { Write-Warning 'Previous package cleanup was skipped. The installed service remains available.' }
  }
 }
 'Uninstall' { & (Join-Path $taskTarget 'scripts\Uninstall-Service.ps1') }
}
} finally {
 if ($taskInstallerLock) { $taskInstallerLock.Dispose() }
}
