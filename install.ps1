$ErrorActionPreference = "Stop"

$Repo   = "HashShin/coded"
$Binary = "coded"

function Write-Info    { param($Msg) Write-Host "=> $Msg" -ForegroundColor Cyan }
function Write-Success { param($Msg) Write-Host "✓  $Msg" -ForegroundColor Green }
function Write-Warn    { param($Msg) Write-Host "!  $Msg" -ForegroundColor Yellow }
function Write-Fail    { param($Msg) Write-Host "✗  $Msg" -ForegroundColor Red; exit 1 }

# ── Detect arch ───────────────────────────────────────────────────────────────
$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "amd64" }
    "ARM64" { "arm64" }
    default { Write-Fail "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

# ── Fetch latest release tag ──────────────────────────────────────────────────
Write-Info "Fetching latest release info…"
try {
    $Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
} catch {
    Write-Fail "Failed to fetch release info: $_"
}
$Tag = $Release.tag_name
if (-not $Tag) { Write-Fail "Could not read release tag." }
$Version = $Tag.TrimStart("v")

# ── coded update fast-path: silent skip when already on latest ────────────────
if ($env:CODED_CURRENT_VERSION -and $env:CODED_CURRENT_VERSION -eq $Version) {
    Write-Success "coded is already up to date ($Version)"
    exit 0
}

# ── Already-installed detection (direct runs only) ────────────────────────────
$Existing = Get-Command coded -ErrorAction SilentlyContinue
$InstalledVer = $null
if ($Existing) {
    try {
        $verOut = & coded --version 2>&1 | Select-Object -First 1
        if ($verOut -match '(\d+\.\d+\.\d+)') { $InstalledVer = $Matches[1] }
    } catch {}
}

if (-not $env:CODED_CURRENT_VERSION -and $InstalledVer -and $InstalledVer -eq $Version) {
    Write-Warn "coded $InstalledVer is already the latest version."
    $Ans = Read-Host "Reinstall anyway? [y/N]"
    if ($Ans -notmatch '^[Yy]') {
        Write-Success "Nothing to do."
        exit 0
    }
    Write-Info "Reinstalling…"
} elseif ($InstalledVer -and $InstalledVer -ne $Version) {
    Write-Info "Upgrading $InstalledVer → $Version for windows/$Arch…"
} else {
    Write-Info "Installing coded $Tag for windows/$Arch…"
}

# ── Download with progress bar ────────────────────────────────────────────────
$Filename = "${Binary}_${Version}_windows_${Arch}.exe"
$Url      = "https://github.com/$Repo/releases/download/$Tag/$Filename"

Write-Info "Downloading from: $Url"

$TmpFile = Join-Path $env:TEMP "coded.exe"
$ProgressPreference = 'Continue'
try {
    Invoke-WebRequest -Uri $Url -OutFile $TmpFile -UseBasicParsing
} catch {
    Write-Fail "Download failed: $_"
}
Write-Success "Downloaded coded $Tag"

# ── Install to a directory in PATH ────────────────────────────────────────────
$InstallDir = "$env:LOCALAPPDATA\coded"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Move-Item -Force $TmpFile "$InstallDir\coded.exe"
Write-Success "Installed to $InstallDir\coded.exe"

# Add to user PATH if not already there.
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$UserPath;$InstallDir", "User")
    Write-Warn "Added $InstallDir to your PATH — restart your terminal for it to take effect."
}

Write-Host ""
Write-Host "Done!  Run: " -NoNewline
Write-Host "coded" -ForegroundColor Cyan
