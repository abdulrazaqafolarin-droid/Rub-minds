[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('chatgpt', 'claude')]
    [string]$Provider,

    [Parameter(Mandatory = $false)]
    [string]$Serial
)

$ErrorActionPreference = 'Stop'
$packageName = if ($Provider -eq 'chatgpt') { 'com.openai.chatgpt' } else { 'com.anthropic.claude' }
$probePath = Join-Path $PSScriptRoot 'provider_conversation_probe.py'
$runId = [Guid]::NewGuid().ToString('N')
$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('rubminds-provider-probe-' + $runId)
$remotePaths = @()
$adbCommand = Get-Command 'adb' -ErrorAction SilentlyContinue

if (-not $adbCommand) {
    throw 'Android Platform Tools (adb) were not found on PATH. Install Platform Tools and reopen PowerShell.'
}
if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) {
    throw 'provider_conversation_probe.py is missing beside this script.'
}

$pythonLauncher = Get-Command 'py' -ErrorAction SilentlyContinue
$pythonCommand = Get-Command 'python' -ErrorAction SilentlyContinue
if (-not $pythonLauncher -and -not $pythonCommand) {
    throw 'Python 3 was not found. Install Python 3 and reopen PowerShell.'
}

function Invoke-AdbChecked {
    param([string[]]$Arguments, [string]$FailureMessage)
    $output = & adb @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
    return $output
}

$deviceOutput = Invoke-AdbChecked -Arguments @('devices') -FailureMessage 'Could not enumerate ADB devices.'
$connectedSerials = @()
foreach ($line in ($deviceOutput | Select-Object -Skip 1)) {
    if ([string]$line -match '^\s*([^\s]+)\s+device\s*$') {
        $connectedSerials += $Matches[1]
    }
}
if ([string]::IsNullOrWhiteSpace($Serial)) {
    if ($connectedSerials.Count -ne 1) {
        throw ("Exactly one authorized ADB device is required when -Serial is omitted. Found {0}. Run 'adb devices' and authorize/select the handset, then pass -Serial <device-id> when multiple devices are connected." -f $connectedSerials.Count)
    }
    $Serial = $connectedSerials[0]
} elseif ($connectedSerials -notcontains $Serial) {
    throw 'The requested ADB serial is not present in the authorized device list.'
}

$packagePaths = Invoke-AdbChecked -Arguments @('-s', $Serial, 'shell', 'pm', 'path', $packageName) -FailureMessage ("Could not inspect installed package " + $packageName + ".")
if (-not (($packagePaths -join [Environment]::NewLine) -match '^package:')) {
    throw ("The selected provider package is not installed for this Android user: " + $packageName)
}

function Assert-ProviderForeground {
    $windowOutput = Invoke-AdbChecked -Arguments @('-s', $Serial, 'shell', 'dumpsys', 'window') -FailureMessage 'Could not read Android window focus metadata.'
    $activityOutput = Invoke-AdbChecked -Arguments @('-s', $Serial, 'shell', 'dumpsys', 'activity', 'activities') -FailureMessage 'Could not read Android resumed-activity metadata.'
    $focusLines = @($windowOutput | Where-Object { [string]$_ -match 'mCurrentFocus=|mFocusedApp=' })
    $focusLines += @($activityOutput | Where-Object { [string]$_ -match 'mResumedActivity|ResumedActivity' })
    if (($focusLines -join [Environment]::NewLine) -notmatch [regex]::Escape($packageName)) {
        throw ("The intended provider app is not positively identified as the foreground/resumed app. Bring " + $packageName + " to the foreground and retry.")
    }
}

function Capture-ProviderSnapshot {
    param([ValidateSet('A1', 'B', 'A2')][string]$Label)

    Assert-ProviderForeground
    $remotePath = "/sdcard/rubminds-provider-probe-$runId-$Label.xml"
    $localPath = Join-Path $tempDirectory ($Label + '.xml')
    $script:remotePaths += $remotePath

    $null = Invoke-AdbChecked -Arguments @('-s', $Serial, 'shell', 'uiautomator', 'dump', '--compressed', $remotePath) -FailureMessage ("Android UIAutomator could not capture snapshot " + $Label + ".")
    $null = Invoke-AdbChecked -Arguments @('-s', $Serial, 'pull', $remotePath, $localPath) -FailureMessage ("Could not retrieve local snapshot " + $Label + ".")
    if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
        throw ("Android did not produce snapshot " + $Label + ".")
    }
    $item = Get-Item -LiteralPath $localPath
    if ($item.Length -gt 8000000) {
        throw ("Snapshot " + $Label + " exceeds the 8 MB local safety limit.")
    }
    $null = Invoke-AdbChecked -Arguments @('-s', $Serial, 'shell', 'rm', '-f', $remotePath) -FailureMessage ("Could not remove temporary handset snapshot " + $Label + ".")
    return $localPath
}

New-Item -ItemType Directory -Path $tempDirectory -Force | Out-Null
try {
    Write-Host ''
    Write-Host 'Rub Minds provider-conversation probe (read-only)' -ForegroundColor Cyan
    Write-Host ("Provider: " + $Provider + "  Package: " + $packageName)
    Write-Host ("Handset: " + $Serial)
    Write-Host 'Use a harmless test account and test conversations. Accessibility XML can temporarily contain visible UI text; raw snapshots stay on this computer, are not uploaded, and are deleted after analysis.'
    Write-Host 'This probe does not send messages, tap Send, or enable native Send. A candidate signal is not proof of a stable provider conversation ID.'
    Write-Host ''

    [void](Read-Host 'Open conversation A in the selected provider app. When A is visible and settled, press Enter')
    $a1 = Capture-ProviderSnapshot -Label 'A1'

    [void](Read-Host 'Navigate to a different conversation B in the same provider app. When B is visible and settled, press Enter')
    $b = Capture-ProviderSnapshot -Label 'B'

    [void](Read-Host 'Return to the exact original conversation A. When A is visible and settled, press Enter')
    $a2 = Capture-ProviderSnapshot -Label 'A2'

    Write-Host ''
    Write-Host 'Analyzing only local keyed accessibility digests. Raw XML is not printed or transmitted.'
    if ($pythonLauncher) {
        & py -3 $probePath --package $packageName --delete-inputs $a1 $b $a2
    } else {
        & python $probePath --package $packageName --delete-inputs $a1 $b $a2
    }
    $probeExitCode = $LASTEXITCODE
    if ($probeExitCode -ne 0) {
        throw ("Provider probe failed with exit code " + $probeExitCode + ". No provider adapter has been enabled.")
    }
    Write-Host ''
    Write-Host 'The report is only an accessibility candidate. Manual provider-adapter review and a physical A-to-B-to-A regression are still required.'
} finally {
    foreach ($remotePath in $remotePaths) {
        try { & adb -s $Serial shell rm -f $remotePath | Out-Null } catch {}
    }
    if (Test-Path -LiteralPath $tempDirectory) {
        Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
