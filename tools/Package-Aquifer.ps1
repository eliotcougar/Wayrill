param([Parameter(Mandatory)][string]$BinaryPath, [string]$OutputDirectory, [string]$CurlPath)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
$taskAquifer = Join-Path $taskProject 'aquifer'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskProject '.tools/installer-aquifer' }
$taskDestination = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($OutputDirectory))
$taskParent = [IO.Directory]::GetParent($taskDestination)
if (-not $taskParent) { throw 'Choose a package directory, not a volume root.' }
if (Test-Path -LiteralPath $taskDestination) {
    if ((Get-Item -LiteralPath $taskDestination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The package output cannot be a symbolic link or junction.' }
    if (@(Get-ChildItem -LiteralPath $taskDestination -Force).Count) {
        $taskPrevious = Get-Content -LiteralPath (Join-Path $taskDestination 'manifest.json') -Raw | ConvertFrom-Json
        # Accept an older owned package, but never absorb unrelated/modified files.
        & (Join-Path $PSScriptRoot 'Check-AquiferPayload.ps1') -Package $taskDestination -ExpectedVersion $taskPrevious.version
    }
}
$taskInstalledBinary = Join-Path $taskDestination 'wayrill-aquifer.exe'
if (Test-Path -LiteralPath $taskInstalledBinary) {
    try {
        $taskProbe = [IO.File]::Open($taskInstalledBinary, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        $taskProbe.Dispose()
    } catch { throw 'The Aquifer payload executable cannot be replaced. Close any instance running from this output directory and check write permissions.' }
}
$taskToken = [Guid]::NewGuid().ToString('N')
$taskOutput = $taskDestination + '.stage-' + $taskToken
$taskBackup = $taskDestination + '.previous-' + $taskToken
# Staging and backup are distinct siblings of the explicitly selected output.
foreach ($taskPath in @($taskOutput, $taskBackup)) {
    if ([IO.Path]::GetFullPath($taskPath) -ne $taskPath -or [IO.Directory]::GetParent($taskPath).FullName -ne $taskParent.FullName -or (Test-Path -LiteralPath $taskPath)) { throw 'Invalid Aquifer staging directory.' }
}
$taskPublished = $false
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
try {
    Copy-Item -LiteralPath $BinaryPath -Destination (Join-Path $taskOutput 'wayrill-aquifer.exe') -Force
    Copy-Item -LiteralPath (Join-Path $taskAquifer 'README.md'),(Join-Path $taskAquifer 'LICENSE'),(Join-Path $taskAquifer 'THIRD_PARTY_NOTICES.md') -Destination $taskOutput -Force
    $taskDocs = Join-Path $taskOutput 'docs'
    New-Item -ItemType Directory -Path $taskDocs -Force | Out-Null
    Copy-Item -Path (Join-Path $taskAquifer 'docs/*.md') -Destination $taskDocs -Force
    Copy-Item -LiteralPath (Join-Path $taskProject 'packages/README.md') -Destination (Join-Path $taskDocs 'SHARED-CODE.md') -Force
    $taskReadme = [IO.File]::ReadAllText((Join-Path $taskOutput 'README.md')).Replace('../packages/README.md','docs/SHARED-CODE.md')
    [IO.File]::WriteAllText((Join-Path $taskOutput 'README.md'),$taskReadme,[Text.UTF8Encoding]::new($false))
    $taskLicenses = Join-Path $taskOutput 'licenses'
    New-Item -ItemType Directory -Path $taskLicenses -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskAquifer 'src-tauri/resources/winscp/LICENSE.txt') -Destination (Join-Path $taskLicenses 'WinSCP-GPL-3.txt') -Force
    Copy-Item -LiteralPath (Join-Path $taskAquifer 'src-tauri/resources/winscp/NOTICE.txt') -Destination (Join-Path $taskLicenses 'WinSCP-NOTICE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $taskProject 'public/licenses/libavoid-LGPL-2.1.txt'),(Join-Path $taskProject 'public/licenses/libavoid-NOTICE.txt') -Destination $taskLicenses -Force
    & (Join-Path $PSScriptRoot 'Prepare-ThirdPartySources.ps1') -OutputDirectory (Join-Path $taskOutput 'third-party') -CurlPath $CurlPath
    $taskSourceNotice = "These unmodified corresponding source archives are verified by SHA256.json. WinSCP is GPLv3; its full license and provenance are in ../licenses. libavoid-js/libavoid is LGPL-2.1-or-later; its notice and license are adjacent. Wayrill Aquifer source, shared packages and rebuild instructions are in the Wayrill repository."
    [IO.File]::WriteAllText((Join-Path $taskOutput 'third-party/THIRD_PARTY_NOTICES.md'),$taskSourceNotice,[Text.UTF8Encoding]::new($false))
    $taskEntries = @(Get-ChildItem -LiteralPath $taskOutput -File -Recurse -Force | Where-Object FullName -ne (Join-Path $taskOutput 'manifest.json') | ForEach-Object {
        @{path=[IO.Path]::GetRelativePath($taskOutput,$_.FullName).Replace('\','/'); sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}
    })
    $taskVersion = (Get-Content -LiteralPath (Join-Path $taskAquifer 'package.json') -Raw | ConvertFrom-Json).version
    @{product='Wayrill Aquifer';version=$taskVersion;files=$taskEntries} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskOutput 'manifest.json') -Encoding utf8
    & (Join-Path $PSScriptRoot 'Check-AquiferPayload.ps1') -Package $taskOutput

    if (Test-Path -LiteralPath $taskDestination) {
        [IO.Directory]::Move($taskDestination, $taskBackup)
    }
    try {
        [IO.Directory]::Move($taskOutput, $taskDestination)
        $taskPublished = $true
    } catch {
        if (Test-Path -LiteralPath $taskBackup) {
            # If this restoration also fails, retain the backup for recovery.
            [IO.Directory]::Move($taskBackup, $taskDestination)
        }
        throw
    }
} finally {
    foreach ($taskTemporary in @($taskOutput) + $(if ($taskPublished) { @($taskBackup) } else { @() })) {
        if (Test-Path -LiteralPath $taskTemporary) {
            if ([IO.Directory]::GetParent([IO.Path]::GetFullPath($taskTemporary)).FullName -ne $taskParent.FullName -or $taskTemporary -notin @($taskOutput, $taskBackup)) { throw 'Refusing cleanup outside Aquifer staging.' }
            Remove-Item -LiteralPath $taskTemporary -Recurse -Force
        }
    }
}
