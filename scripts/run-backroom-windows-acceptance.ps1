$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logRoot = Join-Path $env:TEMP "rub-minds-backroom-acceptance-$stamp"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$script:results = [System.Collections.Generic.List[object]]::new()

Start-Transcript -Path (Join-Path $logRoot "transcript.txt") -Force | Out-Null

function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $logFile = Join-Path $logRoot (($Name -replace '[^a-zA-Z0-9]+', '-').Trim('-') + ".log")
    $started = Get-Date
    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    $exitCode = 1

    try {
        & $Command @Arguments 2>&1 | Tee-Object -FilePath $logFile | Out-Host
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
    }
    catch {
        $_ | Out-String | Tee-Object -FilePath $logFile -Append | Out-Host
        $exitCode = 1
    }

    $result = [pscustomobject]@{
        Name = $Name
        ExitCode = [int]$exitCode
        StartedAt = $started.ToString("o")
        FinishedAt = (Get-Date).ToString("o")
        Log = $logFile
    }
    $script:results.Add($result)
    if ($result.ExitCode -eq 0) {
        Write-Host "PASS: $Name" -ForegroundColor Green
    }
    else {
        Write-Host "FAIL ($($result.ExitCode)): $Name" -ForegroundColor Red
    }
    return $result
}

try {
    $nodeVersion = (& node --version).Trim()
    if ($nodeVersion -notmatch '^v22\.') {
        throw "Node.js 22 is required by the repository workflow. Found: $nodeVersion"
    }

    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
    $rustc = (Get-Command rustc.exe -ErrorAction Stop).Source
    $null = Get-Command cl.exe -ErrorAction Stop

    $rustHost = (& $rustc -vV | Select-String '^host:').ToString()
    if ($rustHost -notmatch 'x86_64-pc-windows-msvc') {
        throw "The active Rust toolchain must target x86_64-pc-windows-msvc. Found: $rustHost"
    }

    Write-Host "Repository: $repoRoot"
    Write-Host "Node: $nodeVersion"
    Write-Host "Rust: $rustHost"
    Write-Host "Logs: $logRoot"

    $install = Invoke-LoggedCommand "Install locked JavaScript dependencies" $npm @("ci")
    if ($install.ExitCode -eq 0) {
        $checks = @(
            @{ Name = "Full web tests and production build"; Command = $npm; Arguments = @("run", "build") },
            @{ Name = "Bundled Tauri companion WebView build"; Command = $npm; Arguments = @("run", "build:desktop-companion") },
            @{ Name = "Native companion Rust unit tests"; Command = $cargo; Arguments = @("test", "--manifest-path", "desktop-companion/src-tauri/Cargo.toml") },
            @{ Name = "Companion protocol and authorization regression tests"; Command = $npm; Arguments = @("run", "test:companion") },
            @{ Name = "Windows x64 MSVC native compile"; Command = $cargo; Arguments = @("check", "--manifest-path", "desktop-companion/src-tauri/Cargo.toml", "--target", "x86_64-pc-windows-msvc") }
        )

        foreach ($check in $checks) {
            Invoke-LoggedCommand $check.Name $check.Command $check.Arguments | Out-Null
        }
    }

    $summaryPath = Join-Path $logRoot "summary.json"
    $script:results | ConvertTo-Json -Depth 5 | Set-Content -Path $summaryPath -Encoding UTF8

    Write-Host ""
    Write-Host "=== Acceptance summary ===" -ForegroundColor Cyan
    $script:results | Format-Table Name, ExitCode -AutoSize
    Write-Host "Full logs: $logRoot"
    Write-Host "Summary: $summaryPath"

    if ($script:results.Count -eq 0 -or @($script:results | Where-Object { $_.ExitCode -ne 0 }).Count -gt 0) {
        exit 1
    }
}
catch {
    Write-Host "PRECHECK FAILED: $_" -ForegroundColor Red
    Write-Host "Install Node.js 22, Rust MSVC stable, and Visual Studio C++ Build Tools with the Windows SDK, then run this script again."
    exit 1
}
finally {
    try { Stop-Transcript | Out-Null } catch {}
}
