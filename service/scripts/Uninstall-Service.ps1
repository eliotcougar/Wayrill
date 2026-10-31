param([switch]$RemoveData)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Installer-Lifecycle.ps1')
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($taskIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this uninstaller in an Administrator PowerShell window.' }
$taskTarget=[IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'Wayrill\Service'))
$taskExpected=[IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\')+'\Wayrill\Service'
$taskData=[IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Wayrill'))
if ($taskTarget -ne $taskExpected -or $taskData -ne ([IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\')+'\Wayrill')) { throw 'Unexpected uninstall paths.' }
foreach ($taskDirectory in @($taskTarget,$taskData)) { if (Test-Path -LiteralPath $taskDirectory) { if ((Get-Item -LiteralPath $taskDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A target is a reparse point.' }; if (@(Get-ChildItem -LiteralPath $taskDirectory -Force -Recurse | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count) { throw 'A target contains a reparse point.' } } }
$taskService=Get-CimInstance Win32_Service -Filter "Name='WayrillService'"
if ($taskService) {
    if ($taskService.PathName -notlike ('"'+$taskTarget+'\wayrill-service.exe" --owner-sid S-1-*')) { throw 'The service path is not this installation.' }
    $taskOwner=[regex]::Match($taskService.PathName,' --owner-sid (S-1-[0-9-]+)$').Groups[1].Value
    if (-not $taskOwner) { throw 'The service owner could not be identified.' }
    Close-WayrillDesktop $taskOwner
    if ($taskService.State -eq 'Running') { Stop-WayrillRouting $taskOwner }
    Stop-WayrillInstalledService
    # Check before removing its registration and recovery-capable binary.
    Assert-WayrillRecoveryComplete
}
Assert-WayrillRecoveryComplete
if (Test-Path -LiteralPath (Join-Path $taskTarget 'wayrill-service.exe')) {
    & (Join-Path $taskTarget 'wayrill-service.exe') --stop-sharing
    if ($LASTEXITCODE -ne 0) { throw 'Sharing restoration remains pending. Its protection, installed files and ownership records were preserved.' }
    # Fixed provider ownership is sufficient even if the settings file was lost.
    & (Join-Path $taskTarget 'wayrill-service.exe') --clear-app-protection
    if ($LASTEXITCODE -ne 0) { throw 'App protection could not be released. Service registration, installed files and ownership records were preserved.' }
} elseif (Test-Path -LiteralPath (Join-Path $taskData 'app-protection.json')) {
    throw 'Repair the missing service binary before removing app protection.'
}
if (@('tun-adapter-host.json','tun-adapter-ics.json') | Where-Object { Test-Path -LiteralPath (Join-Path $taskData $_) }) {
    & (Join-Path $taskTarget 'wayrill-service.exe') --remove-tun-adapters
    if ($LASTEXITCODE -ne 0) { throw 'Owned TUN adapter cleanup remains pending. Installed files and user data were preserved.' }
}
if ($taskService) {
    & sc.exe delete WayrillService | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SCM service deletion failed.' }
}
$taskSharedDriver=@(Get-CimInstance Win32_SystemDriver | Where-Object Name -Like 'WinDivert*').Count -gt 0
if (Test-Path -LiteralPath $taskTarget) {
    if ($taskSharedDriver) {
        # WinDivert registers a shared kernel service with an image path that can point
        # here. Retain its dependency files and registration for other applications.
        foreach($taskItem in @(Get-ChildItem -LiteralPath $taskTarget -Force | Where-Object Name -ne 'windivert')) { Remove-Item -LiteralPath $taskItem.FullName -Recurse -Force }
    } else { Remove-Item -LiteralPath $taskTarget -Recurse -Force }
}
if ($RemoveData -and (Test-Path -LiteralPath $taskData)) { Remove-Item -LiteralPath $taskData -Recurse -Force }
'Wayrill service removed. Any shared WinDivert driver registration and dependency files were preserved.'
