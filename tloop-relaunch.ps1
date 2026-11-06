# tloop-relaunch.ps1 - read the last played placeId from the log, close the old Roblox, reopen it through the Froststrap protocol.
# Exit code: 0 = reopened with a placeId, 2 = no placeId (vision fallback - look for Continue).
# ASCII only in this file (PowerShell 5.1 reads ANSI when there is no BOM).

$logDir = Join-Path $env:LOCALAPPDATA 'Roblox\logs'
$placeId = $null

$files = Get-ChildItem -LiteralPath $logDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*_Player_*' } |
    Sort-Object LastWriteTime -Descending

foreach ($f in $files) {
    $hit = Select-String -LiteralPath $f.FullName -Pattern 'placeid:(\d+)' -ErrorAction SilentlyContinue |
        Select-Object -Last 1
    if ($hit) {
        $placeId = $hit.Matches[0].Groups[1].Value
        break
    }
}
Write-Output "[RELAUNCH] placeId=$placeId"

Get-Process -Name 'RobloxPlayerBeta' -Force -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Write-Output '[RELAUNCH] stopped old RobloxPlayerBeta'
Start-Sleep -Seconds 2

if ($placeId) {
    $uri = "roblox-player:1+launchmode:play+gameInstanceId:$placeId"
    Write-Output "[RELAUNCH] opening $uri"
    Start-Process $uri
} else {
    Write-Output '[RELAUNCH] no placeId -> vision fallback (Continue list), just open app'
    Start-Process 'C:\Users\dongt\AppData\Local\Froststrap\Froststrap.exe'
}

Start-Sleep -Seconds 40
$p = Get-Process -Name 'RobloxPlayerBeta' -ErrorAction SilentlyContinue
if ($p) {
    Write-Output "[RELAUNCH] Roblox up pid=$($p.Id)"
} else {
    Write-Output '[RELAUNCH] still no process after 40s -> Froststrap.exe fallback'
    Start-Process 'C:\Users\dongt\AppData\Local\Froststrap\Froststrap.exe'
}
Write-Output '[RELAUNCH] done'
if ($placeId) { exit 0 } else { exit 2 }
