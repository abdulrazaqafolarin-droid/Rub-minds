[CmdletBinding()]
param(
    [switch]$SkipNpmInstall,
    [switch]$BuildInstallers
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nativeDir = Join-Path $repoRoot 'desktop-companion\src-tauri'
$nativeManifest = Join-Path $nativeDir 'Cargo.toml'
$target = 'x86_64-pc-windows-msvc'
$logPath = Join-Path $env:TEMP ("rub-minds-backroom-windows-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
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
        throw 'This acceptance script must run in native Windows PowerShell, not WSL or Linux.'
    }

    $os = Get-CimInstance Win32_OperatingSystem
    Write-Host "OS: $($os.Caption) $($os.Version) ($($os.OSArchitecture))"
    if ($os.Caption -notmatch 'Windows 10|Windows 11') {
        throw "Unsupported Windows host: $($os.Caption)"
    }

    Require-Command 'node' 'Install Node.js 22 LTS.'
    Require-Command 'npm' 'Install Node.js 22 LTS (includes npm).'
    Require-Command 'rustup' 'Install Rust using rustup and the stable MSVC toolchain.'
    Require-Command 'cargo' 'Install the Rust stable MSVC toolchain.'
    Require-Command 'cl.exe' 'Open this script from Visual Studio 2022 Developer PowerShell or install the Desktop development with C++ workload.'
    Require-Command 'link.exe' 'Open this script from Visual Studio 2022 Developer PowerShell or install the Desktop development with C++ workload.'

    $nodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
    if ($LASTEXITCODE -ne 0 -or $nodeMajor -ne 22) {
        throw "Node.js 22 is required; detected major version $nodeMajor."
    }

    $installedTargets = @(& rustup target list --installed)
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not read installed Rust targets.'
    }
    if ($installedTargets -notcontains $target) {
        throw "Rust target $target is missing. Install it with: rustup target add $target"
    }

    if (-not (Test-Path $nativeManifest -PathType Leaf)) {
        throw "Tauri Cargo manifest not found: $nativeManifest"
    }
    if (-not (Test-Path (Join-Path $repoRoot 'package-lock.json') -PathType Leaf)) {
        throw 'package-lock.json is missing; refusing an unlocked npm install.'
    }

    Write-Host ''
    Write-Host "Preflight passed. Build logs: $logPath" -ForegroundColor Green

    if (-not $SkipNpmInstall) {
        Invoke-CheckedStep 'Install locked JavaScript dependencies' 'npm' @('ci')
    }

    Invoke-CheckedStep 'Full regression pipeline and frontend production build' 'npm' @('run', 'build')
    Invoke-CheckedStep 'Desktop companion WebView production build' 'npm' @('run', 'build:desktop-companion')
    Invoke-CheckedStep 'Rust formatting check' 'cargo' @('fmt', '--manifest-path', $nativeManifest, '--', '--check')
    Invoke-CheckedStep 'Native Windows Rust tests' 'cargo' @('test', '--manifest-path', $nativeManifest, '--target', $target)
    Invoke-CheckedStep 'Windows MSVC native compile check' 'cargo' @('check', '--manifest-path', $nativeManifest, '--target', $target)
    Invoke-CheckedStep 'Windows release binary build' 'cargo' @('build', '--release', '--manifest-path', $nativeManifest, '--target', $target)

    if ($BuildInstallers) {
        Push-Location $nativeDir
        try {
            Invoke-CheckedStep 'Build Tauri MSI and NSIS installers' 'cargo' @('tauri', 'build')
        }
        finally {
            Pop-Location
        }
    }

    Write-Host ''
    Write-Host 'PASS: all requested Windows build/test steps completed.' -ForegroundColor Green
    Write-Host "Log: $logPath"
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
