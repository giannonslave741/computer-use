<#
.SYNOPSIS
  Install or remove the Interception driver for computer-use.

.DESCRIPTION
  - Download Interception.zip from the GitHub release when vendor/interception.dll is missing
  - Extract interception.dll (x64) and install-interception.exe into vendor/
  - Run install-interception.exe /install  (requires Administrator)

.USAGE
  npm run setup-driver
  npm run remove-driver
  powershell -ExecutionPolicy Bypass -File scripts\setup-interception.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if (-not $Install -and -not $Uninstall) { $Install = $true }

$root    = Split-Path -Parent $PSScriptRoot
$vendor  = Join-Path $root 'vendor'
$dll     = Join-Path $vendor 'interception.dll'
$setup   = Join-Path $vendor 'install-interception.exe'
$release = 'https://github.com/oblitum/Interception/releases/download/v1.0.1/Interception.zip'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- elevate when this process is not Admin ---
if (-not (Test-Admin)) {
    Write-Host 'Administrator is required - opening an elevated PowerShell window...' -ForegroundColor Yellow
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Uninstall) { $argList += '-Uninstall' } else { $argList += '-Install' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
    exit 0
}

if (-not (Test-Path $vendor)) { New-Item -ItemType Directory -Path $vendor | Out-Null }

# --- download the files when they are missing ---
if (-not (Test-Path $dll) -or -not (Test-Path $setup)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $zip = Join-Path $env:TEMP 'Interception.zip'
    Write-Host "Downloading $release ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $release -OutFile $zip

    $tmp = Join-Path $env:TEMP ("interception-" + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force

    $foundSetup = Get-ChildItem -Path $tmp -Recurse -Filter 'install-interception.exe' | Select-Object -First 1
    $foundDll64 = Get-ChildItem -Path $tmp -Recurse -Filter 'interception.dll' |
                  Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
    $foundDll   = if ($foundDll64) { $foundDll64 } else { Get-ChildItem -Path $tmp -Recurse -Filter 'interception.dll' | Select-Object -First 1 }

    if (-not $foundSetup -or -not $foundDll) { throw 'install-interception.exe / interception.dll was not found in the zip' }

    Copy-Item $foundSetup.FullName $setup -Force
    Copy-Item $foundDll.FullName   $dll   -Force
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
    Write-Host "Prepared:`n  $dll`n  $setup" -ForegroundColor Green
}

# --- install or remove the driver ---
if ($Uninstall) {
    Write-Host 'Removing the Interception driver...' -ForegroundColor Cyan
    & $setup /uninstall
} else {
    Write-Host 'Installing the Interception driver...' -ForegroundColor Cyan
    & $setup /install
}

Write-Host ''
Write-Host 'Service "interception" status:' -ForegroundColor Cyan
sc.exe query interception 2>&1 | Out-String | Write-Host

if ($Install) {
    Write-Host 'Quick check:  npm run test-input' -ForegroundColor Green
}
