$ErrorActionPreference = "Stop"

$Repo = "HashShin/coded"
$Binary = "coded"

# Detect arch
$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "amd64" }
    "ARM64" { "arm64" }
    default {
        Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
        exit 1
    }
}

# Get latest release tag
$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Tag = $Release.tag_name

if (-not $Tag) {
    Write-Error "Failed to fetch latest release tag"
    exit 1
}

$Filename = "${Binary}_windows_${Arch}.exe"
$Url = "https://github.com/$Repo/releases/download/$Tag/$Filename"

Write-Host "Installing coded $Tag for windows/$Arch..."
Write-Host "Downloading from: $Url"

# Download
$TmpFile = Join-Path $env:TEMP "coded.exe"
Invoke-WebRequest -Uri $Url -OutFile $TmpFile

# Install to a directory in PATH
$InstallDir = "$env:LOCALAPPDATA\coded"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Move-Item -Force $TmpFile "$InstallDir\coded.exe"

# Add to user PATH if not already there
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to your PATH"
    Write-Host "Restart your terminal for PATH changes to take effect"
}

Write-Host "Done! Run: coded"
