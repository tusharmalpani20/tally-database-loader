Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $root "release"
$releaseDir = Join-Path $releaseRoot "tally-db-connector-win-x64"

Push-Location $root
try {
    npm run build

    bun build --compile --target=bun --windows-title "Tally DB Connector" --windows-description "Tally DB Connector CLI" --outfile=dist\tallydb.exe src\cli.mts
    bun build --compile --target=bun --windows-title "Tally DB Connector GUI" --windows-description "Tally DB Connector GUI" --outfile=dist\tallydb-gui.exe src\server.mts

    if (Test-Path $releaseDir) {
        $runningReleaseProcess = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path.StartsWith($releaseDir, [System.StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1
        if ($runningReleaseProcess) {
            throw "Cannot package because $($runningReleaseProcess.ProcessName).exe is still running from the release folder (PID $($runningReleaseProcess.Id)). Close it or run: Stop-Process -Id $($runningReleaseProcess.Id)"
        }
        Remove-Item -LiteralPath $releaseDir -Recurse -Force
    }

    New-Item -ItemType Directory -Path $releaseDir | Out-Null

    Copy-Item dist\tallydb.exe $releaseDir
    Copy-Item dist\tallydb-gui.exe $releaseDir
    Copy-Item config.json $releaseDir
    Copy-Item gui.html $releaseDir
    Copy-Item database-structure.sql $releaseDir
    Copy-Item database-structure-incremental.sql $releaseDir
    Copy-Item tally-export-config.yaml $releaseDir
    Copy-Item tally-export-config-incremental.yaml $releaseDir
    Copy-Item tally-export-config-focused-incremental.yaml $releaseDir
    Copy-Item tally-export-config.json $releaseDir
    Copy-Item docs $releaseDir -Recurse
    Copy-Item reports $releaseDir -Recurse
    Copy-Item platform $releaseDir -Recurse
    Copy-Item tdl $releaseDir -Recurse
    Copy-Item migrations $releaseDir -Recurse

    Set-Content -Path (Join-Path $releaseDir "run.bat") -Value "@echo off`r`ntallydb.exe %*`r`n" -Encoding ASCII
    Set-Content -Path (Join-Path $releaseDir "run-gui.bat") -Value "@echo off`r`ntallydb-gui.exe`r`n" -Encoding ASCII
    Set-Content -Path (Join-Path $releaseDir "tallydb-service.bat") -Value "@echo off`r`ncd /d `"%~dp0`"`r`ntallydb.exe service-run`r`n" -Encoding ASCII

    Write-Host "Packaged Windows release at $releaseDir"
}
finally {
    Pop-Location
}
