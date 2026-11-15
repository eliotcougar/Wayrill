param([string]$SourceDirectory, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path $PSScriptRoot -Parent
$taskSigned = Join-Path $taskProject 'extensions/signed/firefox.xpi'
$taskPin = Get-Content -LiteralPath (Join-Path $taskProject 'extensions/signed/firefox.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $taskSigned -Algorithm SHA256).Hash -ine $taskPin.sha256) { throw 'Signed Firefox Companion hash mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip = [IO.Compression.ZipFile]::OpenRead($taskSigned)
try {
    $taskEntry = $taskZip.GetEntry('manifest.json')
    if (-not $taskEntry) { throw 'Signed Firefox Companion manifest is missing.' }
    $taskReader = [IO.StreamReader]::new($taskEntry.Open())
    try { $taskManifest = $taskReader.ReadToEnd() | ConvertFrom-Json }
    finally { $taskReader.Dispose() }
    if ($taskManifest.version -cne $taskPin.version -or $taskManifest.browser_specific_settings.gecko.id -cne $taskPin.id -or -not $taskZip.GetEntry('META-INF/mozilla.rsa')) { throw 'Signed Firefox Companion identity or signature is missing.' }

    # Compare to the submitted source when verifying a newly signed release.
    if ($SourceDirectory) {
        $taskFiles = @(Get-ChildItem -LiteralPath $SourceDirectory -File)
        $taskEntries = @($taskZip.Entries | Where-Object { -not $_.FullName.StartsWith('META-INF/') })
        if ($taskFiles.Count -ne $taskEntries.Count) { throw 'Signed Firefox Companion source set differs. See docs/development/firefox-signing.md.' }
        foreach ($taskFile in $taskFiles) {
            $taskEntry = $taskZip.GetEntry($taskFile.Name)
            if (-not $taskEntry) { throw ('Signed Firefox Companion is missing '+$taskFile.Name) }
            # web-ext rewrites manifest formatting when creating the upload ZIP.
            if ($taskFile.Name -eq 'manifest.json') {
                $taskActual = $taskManifest | ConvertTo-Json -Depth 32 -Compress
                $taskExpected = Get-Content -LiteralPath $taskFile.FullName -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 32 -Compress
                if ($taskActual -cne $taskExpected) { throw 'Signed Firefox Companion manifest differs. Re-sign before packaging.' }
                continue
            }
            $taskStream = $taskEntry.Open()
            $taskHash = [Security.Cryptography.SHA256]::Create()
            try { $taskDigest = ([BitConverter]::ToString($taskHash.ComputeHash($taskStream))).Replace('-','') }
            finally { $taskStream.Dispose(); $taskHash.Dispose() }
            if ($taskDigest -ine (Get-FileHash -LiteralPath $taskFile.FullName -Algorithm SHA256).Hash) { throw ('Signed Firefox Companion differs from '+$taskFile.Name+'. Re-sign before packaging; see docs/development/firefox-signing.md.') }
        }
    }
} finally { $taskZip.Dispose() }
Copy-Item -LiteralPath $taskSigned -Destination $Destination -Force
