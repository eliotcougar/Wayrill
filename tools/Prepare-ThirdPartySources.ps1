param([string]$OutputDirectory,[string]$CurlPath)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
if(-not $OutputDirectory){$OutputDirectory=Join-Path $root '.tools\third-party-source'}
$pins=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'third-party-sources.json') -Raw | ConvertFrom-Json
$lock=Get-Content -LiteralPath (Join-Path $root 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
$cache=Join-Path $root '.tools\downloads\third-party-source'
New-Item -ItemType Directory -Path $cache,$OutputDirectory -Force | Out-Null
$curl=$null
foreach($file in $pins.files){
    if($file.name -notmatch '^[a-zA-Z0-9._-]+$' -or $file.url -notmatch '^https://'){throw 'Unsafe source input.'}
    $cached=Join-Path $cache $file.name
    if(-not(Test-Path -LiteralPath $cached)){
        if(-not $curl){$curl=& (Join-Path $PSScriptRoot 'Get-Curl.ps1') -Path $CurlPath}
        $temporary=Join-Path $cache ([Guid]::NewGuid().ToString('N')+'.partial')
        try{
            & $curl --fail --location --silent --show-error $file.url --output $temporary
            if($LASTEXITCODE -ne 0){throw "Source download failed: $($file.name)"}
            if((Get-FileHash -LiteralPath $temporary).Hash -ne $file.sha256){throw 'Source archive integrity failure.'}
            Move-Item -LiteralPath $temporary -Destination $cached
        }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary}}
    }
    if((Get-FileHash -LiteralPath $cached).Hash -ne $file.sha256){throw "Cached source differs: $($file.name)"}
    if($file.npmPackage){
        $integrity='sha512-'+[Convert]::ToBase64String([Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes($cached)))
        if($integrity -ne $lock.packages[('node_modules/'+$file.npmPackage)].integrity){throw 'Source npm package differs from the locked runtime.'}
    }
    Copy-Item -LiteralPath $cached -Destination (Join-Path $OutputDirectory $file.name)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'third-party-sources.json') -Destination (Join-Path $OutputDirectory 'SHA256.json')
Copy-Item -LiteralPath (Join-Path $root 'public\licenses\libavoid-LGPL-2.1.txt'),(Join-Path $root 'public\licenses\libavoid-NOTICE.txt'),(Join-Path $root 'THIRD_PARTY_NOTICES.md') -Destination $OutputDirectory
Write-Host "Verified supplemental source assets: $OutputDirectory"
