$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinRect {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $r = New-Object WinRect+RECT
  if ([WinRect]::GetWindowRect($_.MainWindowHandle, [ref]$r)) {
    "{0} hwnd={1} rect={2},{3} -> {4},{5} | {6}" -f $_.ProcessName, $_.MainWindowHandle, $r.Left, $r.Top, $r.Right, $r.Bottom, $_.MainWindowTitle
  }
}
