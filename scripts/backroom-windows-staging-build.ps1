[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [switch]$SkipNpmInstall
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stagingProjectId = 'tzcuuynmviiuactafpld'
$stagingUrl = 'https://tzcuuynmviiuactafpld.supabase.co'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nativeRoot = Join-Path $repoRoot 'desktop-companion\src-tauri'
$releaseRoot = Join-Path $nativeRoot 'target\release'
$bundleRoot = Join-Path $releaseRoot 'bundle'
$runner = Join-Path $PSScriptRoot 'backroom-windows-acceptance.ps1'
$target = 'x86_64-pc-windows-msvc'
$previousViteUrl = [Environment]::GetEnvironmentVariable('VITE_SUPABASE_URL', 'Process')
$previousViteKey = [Environment]::GetEnvironmentVariable('VITE_SUPABASE_ANON_KEY', 'Process')
$apiKey = $null

function ConvertFrom-Base64UrlJson([string]$Segment) {
    if ([string]::IsNullOrWhiteSpace($Segment) -or $Segment -notmatch '^[A-Za-z0-9_-]+$') {
        throw 'The legacy anonymous API key has an invalid JWT segment.'
    }
    $normalized = $Segment.Replace('-', '+').Replace('_', '/')
    switch ($normalized.Length % 4) {
        2 { $normalized += '==' }
        3 { $normalized += '=' }
        1 { throw 'The legacy anonymous API key has invalid base64url encoding.' }
    }
    $bytes = [Convert]::FromBase64String($normalized)
    $json = [Text.Encoding]::UTF8.GetString($bytes)
    return ($json | ConvertFrom-Json -ErrorAction Stop)
}

function Get-StagingApiKeyType([string]$Value, [string]$ExpectedProjectId) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '\s') {
        throw 'A non-empty Staging public API key is required. Do not paste a service-role or secret key.'
    }
    if ($Value.StartsWith('sb_secret_', [System.StringComparison]::Ordinal) -or
        $Value.StartsWith('service_role', [System.StringComparison]::Ordinal)) {
        throw 'Secret and service-role keys are forbidden for this desktop build.'
    }
    if ($Value -match '^sb_publishable_[A-Za-z0-9_-]{20,180}$') {
        return 'sb_publishable'
    }
    $segments = $Value.Split('.')
    if ($segments.Count -ne 3 -or $segments[2] -notmatch '^[A-Za-z0-9_-]+$') {
        throw 'Use the Staging project sb_publishable key or its legacy anon JWT. Unknown key formats are refused.'
    }
    $header = ConvertFrom-Base64UrlJson $segments[0]
    $claims = ConvertFrom-Base64UrlJson $segments[1]
    if ($header.typ -ne 'JWT' -or $header.alg -ne 'HS256') {
        throw 'The legacy key is not a recognised Supabase anonymous JWT.'
    }
    if ($claims.iss -ne 'supabase' -or $claims.ref -ne $ExpectedProjectId -or $claims.role -ne 'anon') {
        throw 'The legacy JWT must be an anonymous key issued for the Rub Minds Staging project. Production, authenticated-user and service-role JWTs are refused.'
    }
    $expiry = 0L
    if (-not [long]::TryParse([string]$claims.exp, [ref]$expiry) -or
        $expiry -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) {
        throw 'The legacy anonymous JWT is missing a valid future expiry.'
    }
    return 'legacy_anon_jwt'
}

function Restore-ProcessEnvironment([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) {
        Remove-Item ("Env:{0}" -f $Name) -ErrorAction SilentlyContinue
    }
    else {
        [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This connected build must run on a physical Windows 10/11 workstation, not WSL or Linux.'
    }
    foreach ($name in @(
        'SUPABASE_SERVICE_ROLE_KEY',
        'SUPABASE_SERVICE_KEY',
        'VITE_SUPABASE_SERVICE_ROLE_KEY',
        'VITE_SUPABASE_SECRET_KEY'
    )) {
        if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
            throw "Refusing to build while the forbidden environment variable $name is present."
        }
    }
    if (-not (Test-Path $runner -PathType Leaf)) {
        throw "The Windows acceptance runner is missing: $runner"
    }

    $commit = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
        throw 'Could not identify the exact source commit. Run this inside a Git checkout.'
    }
    $branch = (& git -C $repoRoot branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not identify the current Git branch.'
    }

    $apiKey = [Environment]::GetEnvironmentVariable('RUB_MINDS_STAGING_PUBLIC_API_KEY', 'Process')
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        $apiKey = Read-Host 'Paste the Staging project public sb_publishable key or legacy anon JWT'
    }
    $keyType = Get-StagingApiKeyType $apiKey $stagingProjectId

    $env:VITE_SUPABASE_URL = $stagingUrl
    $env:VITE_SUPABASE_ANON_KEY = $apiKey

    if (-not (Get-Command 'cargo-tauri' -ErrorAction SilentlyContinue)) {
        throw 'Tauri CLI is required. Install it with: cargo install tauri-cli --version "^2" --locked'
    }

    Write-Host ''
    Write-Host 'Staging target locked:' -ForegroundColor Cyan
    Write-Host "  Project: $stagingProjectId"
    Write-Host "  URL:     $stagingUrl"
    Write-Host "  Key:     $keyType (value not printed or written to the manifest)"
    Write-Host "  Commit:  $commit"
    Write-Host ''
    Write-Host 'The Staging public key is supplied to Vite through this process only. No .env file, repository file, Supabase setting, or deployment is changed.'

    $powershell = Get-Command 'powershell.exe' -ErrorAction Stop
    $runnerArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-BuildInstallers')
    if ($SkipNpmInstall) {
        $runnerArguments += '-SkipNpmInstall'
    }
    & $powershell.Source @runnerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "The Windows acceptance/build runner failed with exit code $LASTEXITCODE."
    }

    $exe = Join-Path $releaseRoot 'rub-minds-backroom-companion.exe'
    if (-not (Test-Path $exe -PathType Leaf)) {
        throw "The expected native companion executable was not produced: $exe"
    }
    $installers = @()
    if (Test-Path $bundleRoot -PathType Container) {
        $installers = @(Get-ChildItem -Path $bundleRoot -Recurse -File |
            Where-Object { $_.Extension -in @('.msi', '.exe') })
    }
    if ($installers.Count -eq 0) {
        throw 'Tauri completed without producing an MSI or NSIS installer; no connected artifact will be packaged.'
    }

    if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
        $desktop = [Environment]::GetFolderPath('Desktop')
        if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path $desktop -PathType Container)) {
            $desktop = $env:USERPROFILE
        }
        $shortCommit = $commit.Substring(0, 12)
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $OutputDirectory = Join-Path $desktop "RubMinds-Backroom-Staging-$shortCommit-$stamp"
    }
    if (-not [IO.Path]::IsPathRooted($OutputDirectory)) {
        $OutputDirectory = Join-Path $repoRoot $OutputDirectory
    }
    if (Test-Path $OutputDirectory) {
        if ((Get-ChildItem -LiteralPath $OutputDirectory -Force | Measure-Object).Count -gt 0) {
            throw "Output directory is not empty; refusing to overwrite it: $OutputDirectory"
        }
    }
    else {
        New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    }

    $companionDirectory = Join-Path $OutputDirectory 'companion'
    $installerDirectory = Join-Path $OutputDirectory 'installers'
    New-Item -ItemType Directory -Path $companionDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $installerDirectory -Force | Out-Null

    $copiedExe = Join-Path $companionDirectory 'rub-minds-backroom-companion.exe'
    Copy-Item -LiteralPath $exe -Destination $copiedExe -Force
    $exeHash = (Get-FileHash -LiteralPath $copiedExe -Algorithm SHA256).Hash.ToLowerInvariant()
    $exeSize = (Get-Item -LiteralPath $copiedExe).Length

    $manifest = [Collections.Generic.List[string]]::new()
    $manifest.Add('repository=abdulrazaqafolarin-droid/Rub-minds')
    $manifest.Add("branch=$branch")
    $manifest.Add("commit=$commit")
    $manifest.Add("target=$target")
    $manifest.Add('build_configuration=staging-connected')
    $manifest.Add("staging_project_id=$stagingProjectId")
    $manifest.Add("supabase_url=$stagingUrl")
    $manifest.Add("api_key_type=$keyType")
    $manifest.Add('api_key_value=omitted')
    $manifest.Add('native_executable=rub-minds-backroom-companion.exe')
    $manifest.Add("native_executable_size_bytes=$exeSize")
    $manifest.Add("native_executable_sha256=$exeHash")

    $index = 0
    foreach ($installer in $installers) {
        $index++
        $destination = Join-Path $installerDirectory $installer.Name
        Copy-Item -LiteralPath $installer.FullName -Destination $destination -Force
        $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        $size = (Get-Item -LiteralPath $destination).Length
        $manifest.Add(("installer_{0}_size_bytes={1}" -f $index, $size))
        $manifest.Add(("installer_{0}={1}" -f $index, $installer.Name))
        $manifest.Add(("installer_{0}_sha256={1}" -f $index, $hash))
    }

    $manifestPath = Join-Path $OutputDirectory 'acceptance-manifest.txt'
    Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding Ascii
    $archivePath = $OutputDirectory + '.zip'
    if (Test-Path $archivePath) {
        throw "Refusing to overwrite an existing archive: $archivePath"
    }
    Compress-Archive -Path (Join-Path $OutputDirectory '*') -DestinationPath $archivePath
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()

    Write-Host ''
    Write-Host 'PASS: Staging-connected Windows build and installer packaging completed.' -ForegroundColor Green
    Write-Host "Output directory: $OutputDirectory"
    Write-Host "Artifact ZIP:     $archivePath"
    Write-Host "Artifact SHA-256: $archiveHash"
    Write-Host 'The manifest contains the Staging project ID and key type only; it never contains the API key value.'
}
catch {
    Write-Error $_
    exit 1
}
finally {
    Restore-ProcessEnvironment 'VITE_SUPABASE_URL' $previousViteUrl
    Restore-ProcessEnvironment 'VITE_SUPABASE_ANON_KEY' $previousViteKey
    $apiKey = $null
}
