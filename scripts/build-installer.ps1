<#
.SYNOPSIS
    Build the S-Dashboard Windows installer locally (same steps as CI).

.DESCRIPTION
    Runs the same steps, in the same order, as .github/workflows/build-windows.yml:

        deps -> .NET sidecar helpers -> Vite web build -> electron-builder (NSIS)

    Run it from the repo root in PowerShell:

        .\scripts\build-installer.ps1

    The finished installer is written to "release\S-Dashboard Setup <version>.exe"
    (spaces, not dots - GitHub's release page rewrites them to dots in download
    links, but the file on disk has spaces).

.PARAMETER SkipHelpers
    Build WITHOUT the .NET sidecars. electron-builder does not fail when the
    helper folders are missing - it only logs "file source doesn't exist" - so
    the installer still builds, but the packaged app CANNOT talk to ETABS or run
    S-Concrete batches. Only use this for testing UI changes.

.PARAMETER SkipGate
    Skip typecheck + unit tests. Faster, but you lose the safety net.

.PARAMETER Reinstall
    Force a clean 'npm ci' even when node_modules already exists.

.EXAMPLE
    .\scripts\build-installer.ps1
    Full installer, identical in content to the CI build.

.EXAMPLE
    .\scripts\build-installer.ps1 -SkipHelpers -SkipGate
    Quick UI-only installer (no ETABS / S-Concrete support).
#>
[CmdletBinding()]
param(
    [switch]$SkipHelpers,
    [switch]$SkipGate,
    [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'

function Write-Step  ($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2 ($msg) { Write-Host "    !   $msg" -ForegroundColor Yellow }

# Run every command from the repo root regardless of where the script is invoked.
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    Write-Host "S-Dashboard - local Windows installer build" -ForegroundColor White
    Write-Host "repo: $repoRoot"

    # ---- Prerequisites -----------------------------------------------------
    Write-Step 'Checking prerequisites'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js is not installed or not on PATH. Install Node 22 LTS from https://nodejs.org and reopen the terminal.'
    }
    $nodeVersion = (node -v).TrimStart('v')
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -lt 20) {
        throw "Node $nodeVersion is too old. Electron requires Node 22.12+ and Vite requires 20.19+. Install Node 22 LTS from https://nodejs.org."
    }
    Write-Ok "Node v$nodeVersion"
    if ($nodeMajor -lt 22) {
        Write-Warn2 "Node 22 LTS is what CI uses and what Electron declares (>=22.12). Node $nodeVersion may work but is not what the installer is tested on."
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm not found on PATH.' }
    Write-Ok "npm v$(npm -v)"

    # 'dotnet' on PATH only proves a RUNTIME is installed; publishing needs the SDK.
    # 'dotnet --list-sdks' is the reliable discriminator (empty on a runtime-only box).
    $hasDotnet = $false
    $sdkList = $null
    if (Get-Command dotnet -ErrorAction SilentlyContinue) {
        try { $sdkList = & dotnet --list-sdks 2>$null } catch { $sdkList = $null }
        $hasDotnet = [bool]($sdkList | Where-Object { $_ -match '\S' })
    }
    if ($hasDotnet) {
        $sdkCount = @($sdkList | Where-Object { $_ -match '\S' }).Count
        Write-Ok "dotnet SDK present ($sdkCount installed)"
    } elseif (-not $SkipHelpers) {
        # Fail EARLY and loudly. electron-builder happily produces an installer
        # without the sidecars, so without this check you would only discover the
        # ETABS / S-Concrete features are dead after installing.
        throw @'
The .NET SDK is required to build the ETABS / S-Concrete sidecar helpers.
(A .NET *runtime* is not enough - 'dotnet --list-sdks' came back empty.)

  Install .NET SDK 6.0 or newer:  https://dotnet.microsoft.com/download
  (then reopen the terminal so 'dotnet' is on PATH)

Or, to build a UI-only installer WITHOUT ETABS / S-Concrete support, re-run:

  .\scripts\build-installer.ps1 -SkipHelpers
'@
    }

    # ---- Dependencies ------------------------------------------------------
    Write-Step 'Installing dependencies'
    # Reinstall when asked, when node_modules is absent, or when package-lock.json is
    # newer than the installed tree - the last case is the common one right after a
    # 'git pull', and skipping it silently builds against the wrong dependencies.
    $lockNewer = $false
    if ((Test-Path 'node_modules') -and (Test-Path 'package-lock.json')) {
        $lockTime = (Get-Item 'package-lock.json').LastWriteTimeUtc
        $modsTime = (Get-Item 'node_modules').LastWriteTimeUtc
        $lockNewer = $lockTime -gt $modsTime
    }
    if ($Reinstall -or -not (Test-Path 'node_modules') -or $lockNewer) {
        if ($lockNewer -and -not $Reinstall) {
            Write-Warn2 'package-lock.json is newer than node_modules - reinstalling so this matches CI.'
        }
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
        Write-Ok 'npm ci complete'
    } else {
        Write-Ok 'node_modules up to date (use -Reinstall to force a clean npm ci)'
    }

    # ---- Typecheck + tests -------------------------------------------------
    if ($SkipGate) {
        Write-Warn2 'Skipping typecheck + tests (-SkipGate)'
    } else {
        Write-Step 'Typecheck + unit tests'
        npx tsc -b
        if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed (exit $LASTEXITCODE)" }
        Write-Ok 'tsc clean'
        npx vitest run
        if ($LASTEXITCODE -ne 0) { throw "Unit tests failed (exit $LASTEXITCODE)" }
        Write-Ok 'tests pass'
    }

    # ---- .NET sidecars -----------------------------------------------------
    if ($SkipHelpers) {
        Write-Step 'Sidecar helpers'
        # extraResources copies whatever is on disk. If an earlier run left helpers
        # behind, -SkipHelpers does not ship a helper-FREE installer - it ships those
        # stale binaries. Say which of the two actually happened.
        $staleHelpers = @('build-helper', 'build-helper-sconcrete') | Where-Object { Test-Path $_ }
        if ($staleHelpers) {
            Write-Warn2 "NOT REBUILT - but $($staleHelpers -join ' and ') still exist, so those PREVIOUSLY BUILT (possibly stale) helpers will be packaged."
            Write-Warn2 'Delete those folders for a truly helper-free build, or drop -SkipHelpers to rebuild them.'
        } else {
            Write-Warn2 'SKIPPED - the installer will NOT be able to connect to ETABS or run S-Concrete.'
        }
    } else {
        Write-Step 'Building .NET sidecar helpers'
        npm run build:helper
        if ($LASTEXITCODE -ne 0) { throw "build:helper failed (exit $LASTEXITCODE)" }
        foreach ($h in @(
            @{ Path = 'build-helper\EtabsHelper.exe';               Name = 'ETABS helper' },
            @{ Path = 'build-helper-sconcrete\SConcreteHelper.exe'; Name = 'S-Concrete helper' }
        )) {
            if (-not (Test-Path $h.Path)) { throw "$($h.Name) was not produced at $($h.Path)" }
            Write-Ok "$($h.Name): $($h.Path)"
        }
    }

    # ---- Web assets --------------------------------------------------------
    Write-Step 'Building web assets (Vite)'
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Vite build failed (exit $LASTEXITCODE)" }
    Write-Ok 'dist/ built'

    # ---- Package -----------------------------------------------------------
    Write-Step 'Packaging installer (electron-builder / NSIS)'
    # No code-signing certificate is configured; stop electron-builder from
    # hunting for one (same as CI).
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    # Pin x64: the .NET sidecars are published '-r win-x64', and CI runs on x64.
    # Without this, electron-builder targets the host arch, so an ARM64 machine
    # would produce an arm64 app carrying x64 helpers that cannot load.
    npx electron-builder --win --x64 --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }

    # ---- Verify + report ---------------------------------------------------
    Write-Step 'Verifying output'
    if (-not $SkipHelpers) {
        foreach ($p in @(
            'release\win-unpacked\resources\etabs-helper\EtabsHelper.exe',
            'release\win-unpacked\resources\sconcrete-helper\SConcreteHelper.exe'
        )) {
            if (-not (Test-Path $p)) { throw "Helper missing from the packaged app: $p" }
            Write-Ok "packaged: $p"
        }
    }

    $installer = Get-ChildItem -Path 'release' -Filter '*.exe' -File |
                 Sort-Object LastWriteTime -Descending |
                 Select-Object -First 1
    if (-not $installer) { throw 'No .exe found in release\ - the packaging step produced nothing.' }

    $sizeMb = [math]::Round($installer.Length / 1MB, 1)
    Write-Host ''
    Write-Host 'Installer ready' -ForegroundColor Green
    Write-Host "  $($installer.FullName)"
    Write-Host "  $sizeMb MB"
    if ($SkipHelpers) {
        Write-Warn2 'Built WITHOUT sidecars - ETABS import and S-Concrete verification will not work.'
    }
    Write-Host ''
    Write-Host 'Run it to install, or double-click it in Explorer.' -ForegroundColor White
}
catch {
    Write-Host ''
    Write-Host "BUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
}
