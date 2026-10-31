# Exercises real mapped images and process ownership without an installed app,
# browser, service, administrator access or network configuration.
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'service\scripts\Installer-Lifecycle.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('wayrill-companion-retirement-'+[Guid]::NewGuid().ToString('N'))
$owned=Join-Path $root 'owned\wayrill-companion.exe'
$other=Join-Path $root 'unrelated\wayrill-companion.exe'
function Start-Fixture([string]$Path) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\cmd.exe') -Destination $Path
    $info=[Diagnostics.ProcessStartInfo]::new($Path,'/D /Q')
    $info.UseShellExecute=$false
    $info.RedirectStandardInput=$true
    $info.RedirectStandardOutput=$true
    $info.CreateNoWindow=$true
    return [Diagnostics.Process]::Start($info)
}
function Assert($condition,$message) { if (-not $condition) { throw $message } }
$first=$null;$second=$null
try {
    $first=Start-Fixture $owned
    $second=Start-Fixture $other
    $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $caught=$false
    try { Invoke-WayrillWithoutCompanion $owned 'S-1-0-0' { throw 'Must not enter setup with another owner' } }
    catch { $caught=$_.Exception.Message -like '*another desktop session*' }
    Assert $caught 'Wrong-owner retirement was not refused'
    Assert ((Test-Path -LiteralPath $owned) -and -not $first.HasExited) 'Refusal must restore the launch path and preserve the helper'
    $caught=$false
    try {
        Invoke-WayrillWithoutCompanion $owned $owner {
            Assert (-not (Test-Path -LiteralPath $owned)) 'Popup reconnect must not be able to launch the retired image'
            Assert $first.HasExited 'The owned mapped image must have exited before preparation'
            Assert (-not $second.HasExited) 'Unrelated bridges must remain running'
            throw 'Simulated preparation failure'
        }
    } catch { $caught=$_.Exception.Message -eq 'Simulated preparation failure' }
    Assert $caught 'Preparation failure must propagate'
    Assert (Test-Path -LiteralPath $owned) 'Failed preparation must restore the old bridge'
    $file=[IO.File]::Open($owned,'Open','ReadWrite','None');$file.Dispose()
    $first.Dispose();$first=Start-Fixture $owned
    Invoke-WayrillWithoutCompanion $owned $owner { Assert $first.HasExited 'Successful preparation must release the image' }
    Assert (-not (Test-Path -LiteralPath $owned)) 'Successful preparation must leave the path ready for new files'
    Assert (@(Get-ChildItem -LiteralPath (Split-Path -Parent $owned)).Count -eq 0) 'Retirement must not leave temporary executables'
    Assert (-not $second.HasExited) 'Another installation must remain untouched'
    @{passed=$true;scenario='mapped image, ownership, rollback and replacement'} | ConvertTo-Json
} finally {
    foreach($process in @($first,$second)) {
        if ($process) {
            if (-not $process.HasExited) { $process.StandardInput.Close(); if (-not $process.WaitForExit(5000)) { $process.Kill();$process.WaitForExit() } }
            $process.Dispose()
        }
    }
    # The path is an explicitly created, unique fixture directory.
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
