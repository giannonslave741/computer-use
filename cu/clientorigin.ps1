# Gốc client-area của cửa sổ trên màn hình (không đoán pixel).
# Dùng: powershell -File clientorigin.ps1 "<phần tiêu đề>"
param([string]$TitlePart)

$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinGeo {
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public struct POINT { public int X, Y; }
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue

$p = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitlePart*"
} | Select-Object -First 1

if (-not $p) { "NOT_FOUND"; exit 1 }

$h = $p.MainWindowHandle
$pt = New-Object WinGeo+POINT
$ok = [WinGeo]::ClientToScreen($h, [ref]$pt)
$r = New-Object WinGeo+RECT
[void][WinGeo]::GetClientRect($h, [ref]$r)

"pid=$($p.Id)"
"hwnd=$h"
"title=$($p.MainWindowTitle)"
"origin=$($pt.X),$($pt.Y)"
"client=$($r.Right)x$($r.Bottom)"
"visible=$([WinGeo]::IsWindowVisible($h))"
