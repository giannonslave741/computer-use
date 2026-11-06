<#
.SYNOPSIS
  Cài/gỡ driver Interception cho computer-use.

.DESCRIPTION
  - Tải Interception.zip từ GitHub release nếu chưa có vendor/interception.dll
  - Giải nén interception.dll (x64) + install-interception.exe vào vendor/
  - Chạy install-interception.exe /install  (cần quyền Administrator)

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

# --- tự elevate nếu chưa phải Admin ---
if (-not (Test-Admin)) {
    Write-Host 'Cần quyền Administrator - đang mở cửa sổ PowerShell Admin...' -ForegroundColor Yellow
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Uninstall) { $argList += '-Uninstall' } else { $argList += '-Install' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
    exit 0
}

if (-not (Test-Path $vendor)) { New-Item -ItemType Directory -Path $vendor | Out-Null }

# --- tải file nếu thiếu ---
if (-not (Test-Path $dll) -or -not (Test-Path $setup)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $zip = Join-Path $env:TEMP 'Interception.zip'
    Write-Host "Đang tải $release ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $release -OutFile $zip

    $tmp = Join-Path $env:TEMP ("interception-" + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force

    $foundSetup = Get-ChildItem -Path $tmp -Recurse -Filter 'install-interception.exe' | Select-Object -First 1
    $foundDll64 = Get-ChildItem -Path $tmp -Recurse -Filter 'interception.dll' |
                  Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
    $foundDll   = if ($foundDll64) { $foundDll64 } else { Get-ChildItem -Path $tmp -Recurse -Filter 'interception.dll' | Select-Object -First 1 }

    if (-not $foundSetup -or -not $foundDll) { throw 'Không tìm thấy install-interception.exe / interception.dll trong zip' }

    Copy-Item $foundSetup.FullName $setup -Force
    Copy-Item $foundDll.FullName   $dll   -Force
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
    Write-Host "Đã chuẩn bị:`n  $dll`n  $setup" -ForegroundColor Green
}

# --- cài / gỡ driver ---
if ($Uninstall) {
    Write-Host 'Đang gỡ driver Interception...' -ForegroundColor Cyan
    & $setup /uninstall
} else {
    Write-Host 'Đang cài driver Interception...' -ForegroundColor Cyan
    & $setup /install
}

Write-Host ''
Write-Host 'Trạng thái service "interception":' -ForegroundColor Cyan
sc.exe query interception 2>&1 | Out-String | Write-Host

if ($Install) {
    Write-Host 'Kiểm tra nhanh bằng:  npm run test-input' -ForegroundColor Green
}
