param([string]$FixtureParent=(Join-Path $env:TEMP 'Wayrill-package-tests'))
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'service\scripts\Package-Files.ps1')
New-Item -ItemType Directory -Path $FixtureParent -Force | Out-Null
$taskFixtureId='package-'+[Guid]::NewGuid().ToString('N')
$taskFixture=Join-Path $FixtureParent $taskFixtureId
$taskRoot=Join-Path $taskFixture 'Service';$taskOutside=Join-Path $taskFixture 'outside'
New-Item -ItemType Directory -Path $taskRoot,$taskOutside -Force | Out-Null
$taskAssertions=0
function Assert-Package([bool]$Condition,[string]$Reason) {
    if (-not $Condition) { throw $Reason }
    $script:taskAssertions++
}
function Write-TestFile([string]$Relative,[string]$Content) {
    $taskPath=Join-Path $taskRoot $Relative
    New-Item -ItemType Directory -Path (Split-Path $taskPath -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($taskPath,$Content,[Text.UTF8Encoding]::new($false))
    [pscustomobject]@{path=$Relative;sha256=(Get-FileHash -LiteralPath $taskPath).Hash}
}
function Write-TestManifest([string]$Path,[object[]]$Files) {
    [ordered]@{apiVersion=1;serviceVersion='0.23.0';files=$Files}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $Path -Encoding UTF8
}
$taskPrior=Join-Path $taskFixture 'prior.json';$taskCurrent=Join-Path $taskRoot 'manifest.json'
try {
    $taskDeleted=Write-TestFile 'docs\obsolete.md' 'unchanged'
    $taskModified=Write-TestFile 'docs\modified.md' 'original'
    $taskCurrentFile=Write-TestFile 'current.dll' 'old binary'
    $taskDriver=Write-TestFile 'windivert\WinDivert64.sys' 'shared driver'
    $taskResource=Write-TestFile 'xray\custom.dat' 'downloaded data'
    $taskLocked=Write-TestFile 'locked.dll' 'old locked binary'
    $null=Write-TestFile 'unknown.txt' 'user file'
    $null=Write-TestFile 'docs\modified.md' 'user changed'
    $taskCurrentFileNew=Write-TestFile 'current.dll' 'new binary'
    $taskOld=@($taskDeleted,$taskModified,$taskCurrentFile,$taskDriver,$taskResource,$taskLocked)
    Write-TestManifest $taskPrior $taskOld
    Write-TestManifest $taskCurrent @($taskCurrentFileNew)
    $taskLock=[IO.File]::Open((Join-Path $taskRoot 'locked.dll'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    try {
        $taskResult=Remove-WayrillObsoletePackageFiles $taskRoot $taskPrior $taskCurrent -WarningAction SilentlyContinue
        Assert-Package ($taskResult.removed -eq 1 -and $taskResult.preserved -eq 2) 'Unexpected cleanup counts.'
        Assert-Package (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'docs\obsolete.md'))) 'Unchanged obsolete report survived.'
        foreach ($taskRelative in @('docs\modified.md','current.dll','windivert\WinDivert64.sys','xray\custom.dat','unknown.txt','locked.dll')) {
            Assert-Package (Test-Path -LiteralPath (Join-Path $taskRoot $taskRelative)) ('Removed protected file '+$taskRelative)
        }
    } finally {$taskLock.Dispose()}
    $taskDeleted=Write-TestFile 'docs\obsolete.md' 'unchanged'
    foreach ($taskInvalid in @('..\outside.txt','C:\outside.txt','docs\..\outside.txt','docs\bad.','docs\bad:stream','docs\\empty.md')) {
        Write-TestManifest $taskPrior @($taskDeleted,[pscustomobject]@{path=$taskInvalid;sha256=('A'*64)})
        $taskRejected=$false
        try {$null=Remove-WayrillObsoletePackageFiles $taskRoot $taskPrior $taskCurrent} catch {$taskRejected=$true}
        Assert-Package $taskRejected ('Accepted unsafe path '+$taskInvalid)
        Assert-Package (Test-Path -LiteralPath (Join-Path $taskRoot $taskDeleted.path)) 'Partially cleaned an invalid manifest.'
    }
    Write-TestManifest $taskPrior @($taskDeleted,[pscustomobject]@{path='DOCS/obsolete.md';sha256=$taskDeleted.sha256})
    $taskRejected=$false
    try {$null=Remove-WayrillObsoletePackageFiles $taskRoot $taskPrior $taskCurrent} catch {$taskRejected=$true}
    Assert-Package $taskRejected 'Accepted duplicate case-folded manifest paths.'
    Write-TestManifest $taskPrior @($taskDeleted)
    New-Item -ItemType Junction -Path (Join-Path $taskRoot 'linked') -Target $taskOutside | Out-Null
    $taskRejected=$false
    try {$null=Remove-WayrillObsoletePackageFiles $taskRoot $taskPrior $taskCurrent} catch {$taskRejected=$true}
    Assert-Package $taskRejected 'Accepted a reparse point.'
    Assert-Package (Test-Path -LiteralPath (Join-Path $taskRoot $taskDeleted.path)) 'Removed a file before reparse validation.'
    [IO.Directory]::Delete((Join-Path $taskRoot 'linked'))
    [ordered]@{passed=$true;assertions=$taskAssertions;preserves=@('modified','locked','untracked','current','resources','shared-driver');rejects=@('unsafe-paths','duplicate-paths','reparse-points')}|ConvertTo-Json -Compress
} finally {
    $taskAbsolute=[IO.Path]::GetFullPath($taskFixture)
    if ((Split-Path $taskAbsolute -Parent) -ne [IO.Path]::GetFullPath($FixtureParent).TrimEnd('\') -or (Split-Path $taskAbsolute -Leaf) -ne $taskFixtureId) { throw 'Unsafe fixture cleanup path.' }
    if (Test-Path -LiteralPath (Join-Path $taskRoot 'linked')) { [IO.Directory]::Delete((Join-Path $taskRoot 'linked')) }
    if (@(Get-ChildItem -LiteralPath $taskAbsolute -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Fixture cleanup contains a reparse point.' }
    Remove-Item -LiteralPath $taskAbsolute -Recurse -Force
}
