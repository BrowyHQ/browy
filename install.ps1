# Browy installer for Windows (PowerShell).
#
# Usage:
#   irm https://browy.dev/install.ps1 | iex
#   irm https://raw.githubusercontent.com/browyhq/browy/main/install.ps1 | iex
#
# What it does:
#   1. Downloads the latest Browy-<version>-win-x64.zip from GitHub Releases
#   2. Extracts to %LOCALAPPDATA%\Browy\app\
#   3. Registers the native messaging manifest for Chrome, Edge, Brave
#
# Override version:    $env:BROWY_VERSION = "0.2.1"; irm ... | iex
# Override repo:       $env:BROWY_REPO = "youruser/yourfork"; irm ... | iex
# Test local zip:      $env:BROWY_LOCAL_ZIP = "C:\path\Browy-x.zip"; irm ... | iex

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$repo        = if ($env:BROWY_REPO)        { $env:BROWY_REPO }        else { 'browyhq/browy' }
$installDir  = if ($env:BROWY_INSTALL_DIR) { $env:BROWY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Browy\app' }
$target      = 'win-x64'  # Only Windows x64 is shipped today.

# Force TLS 1.2 — older PS defaults to SSLv3 and the GitHub API rejects it.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 1. Resolve version (skip lookup when a local zip was supplied)
$version = $env:BROWY_VERSION
if (-not $version -and -not $env:BROWY_LOCAL_ZIP) {
    Write-Host "Browy: looking up latest release..."
    try {
        $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -UseBasicParsing
        $version = ($rel.tag_name -replace '^v', '')
    } catch {
        throw "Browy: failed to resolve latest version. Pass `$env:BROWY_VERSION explicitly. ($_)"
    }
}
if (-not $version) { $version = 'local' }
Write-Host "Browy: installing version $version ($target)"

# 2. Download zip
$tmp = Join-Path $env:TEMP ("browy-install-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zip = Join-Path $tmp 'browy.zip'

try {
    if ($env:BROWY_LOCAL_ZIP) {
        Write-Host "Browy: using local zip $($env:BROWY_LOCAL_ZIP)"
        Copy-Item $env:BROWY_LOCAL_ZIP $zip -Force
    } else {
        $url = "https://github.com/$repo/releases/download/v$version/Browy-$version-$target.zip"
        Write-Host "Browy: downloading $url"
        # Invoke-WebRequest with default progress is slow on PS5; suppress it.
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        $ProgressPreference = 'Continue'
    }

    # 3. Stop any running native host (we're about to overwrite node.exe).
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($installDir, 'OrdinalIgnoreCase') } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }

    # 4. Wipe known subdirs and extract
    if (Test-Path $installDir) {
        foreach ($sub in 'dist','node_modules','node.exe','package.json','package-lock.json','install.bat','uninstall.bat','README.txt') {
            $p = Join-Path $installDir $sub
            if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null

    Write-Host "Browy: extracting to $installDir"
    # Expand-Archive into tmp first because the zip top-level is "Browy/"; we
    # want to flatten that directory into $installDir.
    $extractTmp = Join-Path $tmp 'extract'
    Expand-Archive -Path $zip -DestinationPath $extractTmp -Force
    $browyRoot = Join-Path $extractTmp 'Browy'
    if (-not (Test-Path $browyRoot)) {
        throw "Browy: archive layout unexpected — missing Browy/ root"
    }
    Copy-Item -Path (Join-Path $browyRoot '*') -Destination $installDir -Recurse -Force

    # 5. Register native messaging host
    Write-Host "Browy: registering native messaging host..."
    & (Join-Path $installDir 'node.exe') (Join-Path $installDir 'dist\cli-bin.js') install-host
    if ($LASTEXITCODE -ne 0) {
        throw "install-host failed (exit $LASTEXITCODE)"
    }

    Write-Host ""
    Write-Host "✓ Browy $version installed to $installDir" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Install the Browy extension from the Chrome Web Store"
    Write-Host "  2. Pin the extension and click it to open the side panel"
    Write-Host ""
    Write-Host "To uninstall: & '$installDir\uninstall.bat'; Remove-Item '$installDir' -Recurse"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
