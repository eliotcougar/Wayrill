# Installer-only maintenance. Remove only unchanged files recorded by the prior package.
function Read-WayrillPackageManifest([string]$Path) {
    $taskManifestFile=Get-Item -LiteralPath $Path -Force
    if ($taskManifestFile.PSIsContainer -or ($taskManifestFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $taskManifestFile.Length -gt 2MB) { throw 'Unsafe package manifest.' }
    $taskManifest=Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($taskManifest.apiVersion -ne 1 -or -not $taskManifest.serviceVersion -or @($taskManifest.files).Count -gt 2000) { throw 'Invalid Wayrill package manifest.' }
    $taskEntries=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($taskEntry in $taskManifest.files) {
        if ($taskEntry.path -isnot [string] -or $taskEntry.sha256 -isnot [string] -or $taskEntry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid package file entry.' }
        $taskRelative=$taskEntry.path.Replace('/','\')
        $taskParts=$taskRelative.Split('\')
        if ([IO.Path]::IsPathRooted($taskRelative) -or -not $taskRelative -or @($taskParts | Where-Object {
            -not $_ -or $_ -in @('.','..') -or $_.TrimEnd(' ','.') -ne $_ -or $_.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $_ -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'
        }).Count) { throw 'Invalid package file path.' }
        if ($taskEntries.ContainsKey($taskRelative)) { throw 'Duplicate package file path.' }
        $taskEntries.Add($taskRelative,$taskEntry)
    }
    return $taskEntries
}

function Remove-WayrillObsoletePackageFiles {
    [CmdletBinding()]
    param([string]$Target,[string]$PreviousManifest,[string]$CurrentManifest)
    # Validate both manifests completely before making any changes.
    $taskOld=Read-WayrillPackageManifest $PreviousManifest
    $taskNew=Read-WayrillPackageManifest $CurrentManifest
    $taskRoot=[IO.Path]::GetFullPath($Target).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $taskRoot -PathType Container)) { throw 'Package directory is missing.' }
    foreach ($taskItem in @((Get-Item -LiteralPath $taskRoot -Force)) + @(Get-ChildItem -LiteralPath $taskRoot -Recurse -Force)) {
        if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package cleanup found a reparse point.' }
    }
    $taskRemoved=0;$taskPreserved=0
    foreach ($taskPair in $taskOld.GetEnumerator()) {
        $taskRelative=$taskPair.Key
        # Resource data can be updated by the app; driver files may be shared.
        if ($taskNew.ContainsKey($taskRelative) -or $taskRelative -ieq 'manifest.json' -or $taskRelative -match '(^|\\)WinDivert[^\\]*\.sys$' -or $taskRelative -match '^xray\\.*\.dat$') { continue }
        $taskPath=[IO.Path]::GetFullPath((Join-Path $taskRoot $taskRelative))
        if (-not $taskPath.StartsWith($taskRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Package cleanup escaped its directory.' }
        if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { continue }
        try {
            if ((Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash -ine $taskPair.Value.sha256) { $taskPreserved++;continue }
            Remove-Item -LiteralPath $taskPath -Force
            $taskRemoved++
        } catch {
            $taskPreserved++
            Write-Warning ("Preserved an obsolete package file: "+$taskRelative)
        }
    }
    [pscustomobject]@{removed=$taskRemoved;preserved=$taskPreserved}
}
