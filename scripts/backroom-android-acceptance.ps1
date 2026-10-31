[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$androidDir = Join-Path $repoRoot 'android-companion'
$logPath = Join-Path $env:TEMP ("rub-minds-backroom-android-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$transcriptStarted = $false

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' is missing. $InstallHint"
    }
}

function Invoke-CheckedStep([string]$Name, [string]$Executable, [string[]]$Arguments) {
    Write-Host ''
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    Write-Host ("> {0} {1}" -f $Executable, ($Arguments -join ' '))
    & $Executable @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "$Name failed with exit code $code."
    }
}

try {
    Start-Transcript -Path $logPath -Force | Out-Null
    $transcriptStarted = $true
    Push-Location $repoRoot

    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Run this acceptance script from native Windows PowerShell.'
    }

    Require-Command 'node' 'Install Node.js 22 LTS.'
    Require-Command 'gradle' 'Install Gradle 8.10.2 or configure it on PATH.'
    Require-Command 'java' 'Install JDK 17 and configure JAVA_HOME.'

    $javaOutput = (& java -version 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not $javaOutput.Contains('version "17')) {
        throw "JDK 17 is required. Detected: $javaOutput"
    }

    $gradleOutput = (& gradle --version 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not $gradleOutput.Contains('Gradle 8.10.2')) {
        throw "Gradle 8.10.2 is required. Detected output: $gradleOutput"
    }

    $sdkRoot = $env:ANDROID_SDK_ROOT
    if ([string]::IsNullOrWhiteSpace($sdkRoot)) {
        $sdkRoot = $env:ANDROID_HOME
    }
    if ([string]::IsNullOrWhiteSpace($sdkRoot) -or -not (Test-Path $sdkRoot -PathType Container)) {
        throw 'Set ANDROID_SDK_ROOT (or ANDROID_HOME) to an installed Android SDK containing platform 35 and build-tools 35.0.0.'
    }

    Write-Host "Android SDK: $sdkRoot"
    Write-Host "Log: $logPath"

    Invoke-CheckedStep 'Android companion source/manifest policy tests' 'node' @('--test', 'android-companion/scripts/manifest-policy.node-test.mjs')
    Invoke-CheckedStep 'Android unit tests, actual merged-manifest audit and debug APK build' 'gradle' @('--no-daemon', '--stacktrace', '-p', $androidDir, ':app:testDebugUnitTest', ':app:auditDebugGuestHostManifest', ':app:assembleDebug')

    $apkRoot = Join-Path $androidDir 'app\build\outputs\apk\debug'
    $apk = Get-ChildItem -Path $apkRoot -Filter '*.apk' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $apk) {
        throw "Gradle succeeded but no debug APK was found under $apkRoot."
    }

    $report = Join-Path $androidDir 'app\build\reports\guest-host-manifest\debug.txt'
    if (-not (Test-Path $report -PathType Leaf)) {
        throw "Gradle succeeded but the merged-manifest audit report is missing: $report"
    }

    $hash = (Get-FileHash -Path $apk.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ''
    Write-Host 'PASS: Android companion unit tests, merged-manifest gate and APK build completed.' -ForegroundColor Green
    Write-Host "APK: $($apk.FullName)"
    Write-Host "APK SHA-256: $hash"
    Write-Host "Manifest audit: $report"
    Write-Host 'IMPORTANT: this is the existing companion APK, not a guest-virtualization build. No provider currently implements guest app launch or rendering.'
}
catch {
    Write-Error $_
    Write-Host "FAIL: see transcript $logPath" -ForegroundColor Red
    exit 1
}
finally {
    if ($transcriptStarted) {
        Pop-Location -ErrorAction SilentlyContinue
        Stop-Transcript | Out-Null
    }
}
