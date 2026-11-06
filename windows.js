import koffi from 'koffi';

// ---------------------------------------------------------------------------
// Window Management Layer cho opencode-computer-use
// Goi truc tiep Windows User32 / Kernel32 / Dwmapi qua koffi (khong qua PowerShell)
// ---------------------------------------------------------------------------

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const RECT = koffi.struct('RECT', {
  left: 'int',
  top: 'int',
  right: 'int',
  bottom: 'int'
});

const api = {
  getForegroundWindow: user32.func('void *__stdcall GetForegroundWindow(void)'),
  getWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)'),
  getWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int nMaxCount)'),
  getClassNameW: user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint16_t *buf, int nMaxCount)'),
  getWindowThreadProcessId: user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *lpdwProcessId)'
  ),
  isWindow: user32.func('int __stdcall IsWindow(void *hwnd)'),
  isWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hwnd)'),
  isIconic: user32.func('int __stdcall IsIconic(void *hwnd)'),
  getWindowRect: user32.func('int __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)'),
  showWindow: user32.func('int __stdcall ShowWindow(void *hwnd, int nCmdShow)'),
  setForegroundWindow: user32.func('int __stdcall SetForegroundWindow(void *hwnd)'),
  bringWindowToTop: user32.func('int __stdcall BringWindowToTop(void *hwnd)'),
  getTopWindow: user32.func('void *__stdcall GetTopWindow(void *hwnd)'),
  getWindow: user32.func('void *__stdcall GetWindow(void *hwnd, uint32_t uCmd)'),
  attachThreadInput: user32.func(
    'int __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, int fAttach)'
  ),
  keybdEvent: user32.func(
    'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'
  ),
  findWindowW: user32.func(
    'void *__stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'
  ),
  getAncestor: user32.func('void *__stdcall GetAncestor(void *hwnd, uint32_t flags)'),
  getSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
  getCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId(void)'),
  openProcess: kernel32.func('void *__stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)'),
  queryFullProcessImageNameW: kernel32.func(
    'int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32_t *lpdwSize)'
  ),
  closeHandle: kernel32.func('int __stdcall CloseHandle(void *hObject)')
};

// DwmGetWindowAttribute de loai bo cua so bi "cloak" (UWP/Shell an) - tuy chon
let dwmGetWindowAttribute = null;
try {
  const dwmapi = koffi.load('dwmapi.dll');
  dwmGetWindowAttribute = dwmapi.func(
    'int __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ int *pvAttribute, uint32_t cbAttribute)'
  );
} catch {
  dwmGetWindowAttribute = null;
}

// WindowFromPoint can thiep POINT by value - khong dat ten struct rieng de khong
// xung dot voi koffi.struct('POINT') dang co trong interception.js
let windowAtPointFn = null;
try {
  const POINT_BY_VALUE = koffi.pack({ x: 'int32', y: 'int32' });
  windowAtPointFn = user32.func('WindowFromPoint', 'void *', [POINT_BY_VALUE]);
} catch {
  windowAtPointFn = null;
}

const GA_ROOT = 2;
const GW_HWNDNEXT = 2;
const SW_HIDE = 0;
const SW_SHOWNORMAL = 1;
const SW_MINIMIZE = 6;
const SW_RESTORE = 9;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;
const MAX_ENUM = 4096;

// Cua so khong phai "ung dung" - khong dua vao danh sach window_list
const SHELL_CLASSES = new Set([
  'progman',
  'workerw',
  'shell_traywnd',
  'shell_secondarytraywnd',
  'button',
  'dv2controlhost',
  'notifyiconoverflowwindow',
  'windows.internal.shell.tabproxywindow',
  'xaml_explorerhostislandwnd'
]);

const TASKBAR_CLASSES = new Set(['shell_traywnd', 'shell_secondarytraywnd']);
const DESKTOP_CLASSES = new Set(['progman', 'workerw']);

// Ten thuong gap -> ten file .exe (ho tro AI nhap "File Explorer", "Chrome"...)
const PROCESS_ALIASES = {
  'file explorer': 'explorer.exe',
  'explorer': 'explorer.exe',
  'explorer.exe': 'explorer.exe',
  'chrome': 'chrome.exe',
  'google chrome': 'chrome.exe',
  'chrome.exe': 'chrome.exe',
  'edge': 'msedge.exe',
  'microsoft edge': 'msedge.exe',
  'msedge.exe': 'msedge.exe',
  'firefox': 'firefox.exe',
  'notepad': 'notepad.exe',
  'notepad.exe': 'notepad.exe',
  'cmd': 'cmd.exe',
  'command prompt': 'cmd.exe',
  'powershell': 'powershell.exe',
  'terminal': 'windowsterminal.exe',
  'windowsterminal.exe': 'windowsterminal.exe',
  'opencode': 'opencode.exe',
  'code': 'code.exe',
  'visual studio code': 'code.exe',
  'explorer window': 'explorer.exe'
};

function log(msg) {
  console.log(`[WINDOW] ${msg}`);
}

function toNum(hwnd) {
  if (hwnd === null || hwnd === undefined) return 0;
  return typeof hwnd === 'bigint' ? Number(hwnd) : Number(hwnd) || 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readWide(fn, hwnd) {
  try {
    const n = api.getWindowTextLengthW(hwnd);
    if (n <= 0) return '';
    const buf = new Uint16Array(n + 1);
    const got = fn(hwnd, buf, buf.length);
    if (got <= 0) return '';
    let out = '';
    for (let i = 0; i < got; i++) out += String.fromCharCode(buf[i]);
    return out;
  } catch {
    return '';
  }
}

const pidNameCache = new Map();

function processNameOf(pid) {
  if (!pid) return '';
  if (pidNameCache.has(pid)) return pidNameCache.get(pid);
  let name = '';
  try {
    const h = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (h) {
      const size = [512];
      const buf = new Uint16Array(512);
      if (api.queryFullProcessImageNameW(h, 0, buf, size)) {
        let s = '';
        for (let i = 0; i < size[0]; i++) s += String.fromCharCode(buf[i]);
        name = s.split('\\').pop() || '';
      }
      api.closeHandle(h);
    }
  } catch {
    name = '';
  }
  if (pidNameCache.size > 1000) pidNameCache.clear();
  pidNameCache.set(pid, name);
  return name;
}

function isCloaked(hwnd) {
  if (!dwmGetWindowAttribute) return false;
  try {
    const out = [0];
    dwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out, 4);
    return out[0] !== 0;
  } catch {
    return false;
  }
}

export function getForegroundWindow() {
  return toNum(api.getForegroundWindow());
}

/** Kich thuoc man hinh chinh (GetSystemMetrics SM_CXSCREEN/SM_CYSCREEN). */
export function getScreenSize() {
  try {
    const width = api.getSystemMetrics(0);
    const height = api.getSystemMetrics(1);
    return { width: width > 0 ? width : 0, height: height > 0 ? height : 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Cua so co dang che toan man hinh khong (fullscreen video/game/borderless).
 * Luc do UI binh thuong (thanh dia chi, tab, thanh tim kiem) KHONG ton tai tren man hinh.
 */
export function isFullscreen(hwnd) {
  try {
    const h = typeof hwnd === 'bigint' ? hwnd : BigInt(toNum(hwnd));
    if (!h || !api.isWindow(h)) return false;
    const r = getWindowRect(h);
    if (!r) return false;
    const s = getScreenSize();
    if (!s.width || !s.height) return false;
    return r.left <= 2 && r.top <= 2 && r.right >= s.width - 2 && r.bottom >= s.height - 2;
  } catch {
    return false;
  }
}

export function isWindow(hwnd) {
  return !!api.isWindow(typeof hwnd === 'bigint' ? hwnd : BigInt(toNum(hwnd)));
}

export function isWindowVisible(hwnd) {
  const h = typeof hwnd === 'bigint' ? hwnd : BigInt(toNum(hwnd));
  return !!api.isWindowVisible(h);
}

export function isWindowMinimized(hwnd) {
  const h = typeof hwnd === 'bigint' ? hwnd : BigInt(toNum(hwnd));
  if (!h || !api.isWindow(h)) return false;
  if (api.isIconic(h)) return true;
  const r = getWindowRect(h);
  // Window bi minimize/ra man hinh ao co rect -32000,-32000
  return !!r && r.left <= -30000 && r.top <= -30000;
}

export function getWindowTitle(hwnd) {
  const h = typeof hwnd === 'bigint' ? hwnd : BigInt(toNum(hwnd));
  if (!h || !api.isWindow(h)) return '';
  return readWide(api.getWindowTextW, h).trim();
}

export function getWindowClass(hwnd) {
  const h = typeof hwnd === 'bigint' ? hwnd : BigInt(toNum(hwnd));
  if (!h) return '';
  try {
    const buf = new Uint16Array(256);
    const got = api.getClassNameW(h, buf, buf.length);
    if (got <= 0) return '';
    let out = '';
    for (let i = 0; i < got; i++) out += String.fromCharCode(buf[i]);
    return out;
  } catch {
    return '';
  }
}

export function getWindowProcessId(hwnd) {
  const h = typeof hwnd === 'bigint' ? hwnd : BigInt(toNum(hwnd));
  if (!h) return 0;
  const pid = [0];
  api.getWindowThreadProcessId(h, pid);
  return pid[0];
}

export function getProcessName(pid) {
  return processNameOf(pid);
}

export function getWindowRect(hwnd) {
  const h = typeof hwnd === 'bigint' ? hwnd : BigInt(toNum(hwnd));
  if (!h || !api.isWindow(h)) return null;
  const rect = {};
  if (!api.getWindowRect(h, rect)) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: Math.max(0, rect.right - rect.left),
    height: Math.max(0, rect.bottom - rect.top)
  };
}

export function describeWindow(hwnd) {
  const h = toNum(hwnd);
  if (!h) return null;
  const pid = getWindowProcessId(h);
  const rect = getWindowRect(h);
  return {
    hwnd: h,
    title: getWindowTitle(h),
    className: getWindowClass(h),
    pid,
    processName: processNameOf(pid),
    visible: isWindowVisible(h),
    minimized: isWindowMinimized(h),
    rect
  };
}

export function describeForeground() {
  return describeWindow(getForegroundWindow());
}

// ---------------------------------------------------------------------------
// Enumerate top-level windows (Z-order: top -> bottom)
// ---------------------------------------------------------------------------
export function findWindows(opts = {}) {
  const includeUntitled = opts.untitled !== false;
  const out = [];
  const seen = new Set();

  let h = api.getTopWindow(0);
  let guard = 0;
  while (h && guard++ < MAX_ENUM) {
    const num = toNum(h);
    if (!num || seen.has(num)) break;
    seen.add(num);

    if (api.isWindowVisible(h) && !isCloaked(h)) {
      const cls = getWindowClass(h).toLowerCase();
      const isShell = SHELL_CLASSES.has(cls);
      const title = getWindowTitle(h);
      const rect = getWindowRect(h);
      const okRect = rect && rect.width > 0 && rect.height > 0;
      if (!isShell && okRect && (includeUntitled || title)) {
        const pid = getWindowProcessId(h);
        out.push({
          hwnd: num,
          title,
          className: getWindowClass(h),
          pid,
          processName: processNameOf(pid),
          visible: true,
          minimized: isWindowMinimized(h),
          rect
        });
      }
    }
    h = api.getWindow(h, GW_HWNDNEXT);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tim cua so
// ---------------------------------------------------------------------------
function normalizeTarget(target) {
  if (target === null || target === undefined) return {};
  if (typeof target === 'number') return { hwnd: target };
  if (typeof target === 'bigint') return { hwnd: Number(target) };
  if (typeof target === 'string') {
    const s = target.trim();
    if (!s) return {};
    if (/^\d+$/.test(s)) return { hwnd: Number(s) };
    if (/\.exe$/i.test(s)) return { process: s };
    return { raw: s };
  }
  if (typeof target === 'object') {
    const q = {};
    if (target.hwnd) q.hwnd = toNum(target.hwnd);
    if (target.pid) q.pid = Number(target.pid);
    if (target.process) q.process = String(target.process);
    if (target.title) q.title = String(target.title);
    if (target.titleContains) q.titleContains = String(target.titleContains);
    const raw = target.target ?? target.name ?? target.title ?? target.titleContains;
    if (!q.hwnd && !q.pid && !q.process && !q.title && !q.titleContains && raw) {
      const s = String(raw).trim();
      if (/\.exe$/i.test(s)) q.process = s;
      else q.raw = s;
    }
    return q;
  }
  return {};
}

function queryMatches(w, q, zOrder) {
  const bonus = [];
  let base = -1;

  if (q.hwnd) {
    if (w.hwnd !== q.hwnd) return -1;
    base = 10000;
    bonus.push(100);
  } else if (q.pid) {
    if (w.pid !== q.pid) return -1;
    base = 9000;
  } else if (q.process) {
    const want = q.process.toLowerCase().replace(/\.exe$/, '');
    const have = (w.processName || '').toLowerCase().replace(/\.exe$/, '');
    if (!have || have !== want) return -1;
    base = 8000;
  } else if (q.title) {
    if ((w.title || '').toLowerCase() !== q.title.toLowerCase()) return -1;
    base = 7000;
  } else if (q.titleContains) {
    if (!(w.title || '').toLowerCase().includes(q.titleContains.toLowerCase())) return -1;
    base = 6000;
  } else if (q.raw) {
    const raw = q.raw.toLowerCase();
    const alias = PROCESS_ALIASES[raw];
    const haveProc = (w.processName || '').toLowerCase();
    const title = (w.title || '').toLowerCase();

    if (alias && haveProc === alias) {
      base = 5000;
      bonus.push(title ? 200 : 0);
    } else if (title === raw) {
      base = 4500;
    } else if (title.includes(raw)) {
      base = 4000;
      bonus.push(Math.min(300, title.length - raw.length));
    } else if (haveProc && haveProc.includes(raw.replace(/\s+/g, ''))) {
      base = 3500;
    } else if (raw.includes('explorer') && haveProc === 'explorer.exe') {
      base = 3000;
    } else {
      return -1;
    }
  } else {
    return -1;
  }

  if (w.title) bonus.push(500);
  if (!w.minimized) bonus.push(300);
  if (w.rect && w.rect.width * w.rect.height >= 100 * 80) bonus.push(100);
  bonus.push(Math.max(0, 200 - zOrder));
  if (w.hwnd === getForegroundWindow()) bonus.push(1000);

  return base + bonus.reduce((a, b) => a + b, 0);
}

/**
 * Tim cua so.
 * target co the la: so hwnd, chuoi, hoac object
 *   { hwnd } | { pid } | { process:'explorer.exe' } | { title:'...' }
 *   | { titleContains:'...' } | { target:'File Explorer' }
 * Tra ve: { window, candidates } - khong tim thay thi window = null
 */
export function findWindow(target) {
  const q = normalizeTarget(target);
  if (q.hwnd) {
    if (!api.isWindow(BigInt(q.hwnd))) return { window: null, candidates: [] };
    const w = describeWindow(q.hwnd);
    return { window: w, candidates: w ? [w] : [] };
  }
  if (Object.keys(q).length === 0) return { window: null, candidates: [] };

  const all = findWindows({ untitled: !!q.process || !!q.pid });
  const scored = [];
  all.forEach((w, i) => {
    const score = queryMatches(w, q, i);
    if (score >= 0) scored.push({ w, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return {
    window: scored.length ? scored[0].w : null,
    candidates: scored.slice(0, 5).map((s) => s.w)
  };
}

// ---------------------------------------------------------------------------
// Restore / minimize
// ---------------------------------------------------------------------------
export function restoreWindow(target) {
  const { window: w, candidates } = findWindow(target);
  if (!w) {
    return { success: false, reason: 'không tìm thấy cửa sổ để restore', candidates };
  }
  const h = BigInt(w.hwnd);
  const wasMinimized = w.minimized;
  if (wasMinimized) {
    log(`Restoring window: ${w.title || '(không có title)'} hwnd=${w.hwnd}`);
    api.showWindow(h, SW_RESTORE);
  }
  return { success: true, wasMinimized, window: w, candidates };
}

export function minimizeWindow(target) {
  const { window: w, candidates } = findWindow(target);
  if (!w) {
    return { success: false, reason: 'không tìm thấy cửa sổ để minimize', candidates };
  }
  log(`Minimizing: ${w.title || '(không có title)'} hwnd=${w.hwnd}`);
  api.showWindow(BigInt(w.hwnd), SW_MINIMIZE);
  return { success: true, window: w, candidates };
}

// ---------------------------------------------------------------------------
// Activate window + verify foreground (co gioi han retry, khong lap vo han)
// ---------------------------------------------------------------------------
function verifyForeground(hwnd, waitedMs) {
  const fg = getForegroundWindow();
  return fg === toNum(hwnd) ? fg : null;
}

async function forceForeground(hwnd) {
  const h = BigInt(toNum(hwnd));
  const fg = getForegroundWindow();
  const fgHwnd = fg ? BigInt(fg) : 0n;
  const myTid = api.getCurrentThreadId();
  const fgTid = fgHwnd ? api.getWindowThreadProcessId(fgHwnd, [0]) : 0;
  let attached = false;

  try {
    if (fgTid && fgTid !== myTid) {
      attached = !!api.attachThreadInput(myTid, fgTid, 1);
    }
    api.bringWindowToTop(h);
    api.setForegroundWindow(h);
    await sleep(120);
    if (verifyForeground(h)) return true;
    // Thu nua bang cach nhan ALT de thao foreground lock (Windows tra quyen focus)
    api.keybdEvent(VK_MENU, 0, 0, 0);
    api.keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
    await sleep(40);
    api.bringWindowToTop(h);
    api.setForegroundWindow(h);
    await sleep(150);
    return !!verifyForeground(h);
  } catch {
    return false;
  } finally {
    if (attached) {
      try {
        api.attachThreadInput(myTid, fgTid, 0);
      } catch {
        /* detach that bai - bo qua */
      }
    }
  }
}

export async function activateWindow(target, opts = {}) {
  const retries = Math.max(1, Math.min(3, Number(opts.retries ?? 2)));
  const { window: w, candidates } = findWindow(target);

  if (!w) {
    const reason = `không tìm thấy cửa sổ phù hợp với target=${JSON.stringify(target)}`;
    log(`Activation FAILED - ${reason}`);
    return { success: false, reason, hwnd: 0, foreground: false, candidates: [] };
  }

  log(`Activating: "${w.title || '(không có title)'}" hwnd=${w.hwnd} pid=${w.pid} (${w.processName})`);

  const h = BigInt(w.hwnd);
  if (!api.isWindow(h)) {
    log('Activation FAILED - hwnd không hợp lệ');
    return { success: false, reason: 'hwnd không hợp lệ', hwnd: w.hwnd, foreground: false };
  }

  const fgBefore = getForegroundWindow();
  log(`Foreground: ${fgBefore} | Target: ${w.hwnd}`);

  if (w.minimized || api.isIconic(h)) {
    log('Restoring window...');
    api.showWindow(h, SW_RESTORE);
    await sleep(180);
  }
  if (!api.isWindowVisible(h)) {
    api.showWindow(h, SW_SHOWNORMAL);
    await sleep(150);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    api.bringWindowToTop(h);
    api.setForegroundWindow(h);
    await sleep(150);

    const fg = verifyForeground(h);
    if (fg) {
      const info = describeWindow(fg);
      log('SetForegroundWindow -> OK');
      log('Foreground verification -> OK');
      log(`Window rect: ${info.rect.left},${info.rect.top} -> ${info.rect.right},${info.rect.bottom}`);
      return {
        success: true,
        hwnd: w.hwnd,
        title: info.title,
        pid: info.pid,
        processName: info.processName,
        rect: info.rect,
        minimized: false,
        foreground: true,
        attempt
      };
    }

    log(`SetForegroundWindow -> chưa về foreground (lần ${attempt}/${retries})`);
    const forced = await forceForeground(w.hwnd);
    if (forced) {
      const info = describeWindow(w.hwnd);
      log('Foreground verification -> OK (sau force)');
      log(`Window rect: ${info.rect.left},${info.rect.top} -> ${info.rect.right},${info.rect.bottom}`);
      return {
        success: true,
        hwnd: w.hwnd,
        title: info.title,
        pid: info.pid,
        processName: info.processName,
        rect: info.rect,
        minimized: false,
        foreground: true,
        attempt,
        forced: true
      };
    }
  }

  const fgNow = describeWindow(getForegroundWindow());
  const reason = `foreground verification failed (foreground hiện tại: ${fgNow ? `${fgNow.title || fgNow.processName}` : 'không rõ'})`;
  log('Activation FAILED');
  log(`reason=${reason}`);
  return {
    success: false,
    reason,
    hwnd: w.hwnd,
    title: w.title,
    pid: w.pid,
    foreground: false,
    candidates
  };
}

// ---------------------------------------------------------------------------
// Show desktop
// ---------------------------------------------------------------------------
export async function showDesktop() {
  const fgBefore = getForegroundWindow();
  const windows = findWindows().filter((w) => !w.minimized);
  log(`Show desktop: minimize ${windows.length} cửa sổ đang mở`);

  for (const w of windows) {
    try {
      api.showWindow(BigInt(w.hwnd), SW_MINIMIZE);
    } catch {
      /* bo qua cua so khong minimize duoc */
    }
  }
  await sleep(400);

  const remain = findWindows().filter((w) => !w.minimized);
  const fgClass = getWindowClass(getForegroundWindow()).toLowerCase();
  const desktopUp =
    remain.length === 0 ||
    DESKTOP_CLASSES.has(fgClass) ||
    (fgBefore ? isWindowMinimized(fgBefore) : false);

  log(desktopUp ? 'Show desktop -> OK' : `Show desktop -> chỉ còn ${remain.length} cửa sổ chưa minimize`);
  return {
    success: desktopUp,
    minimized: windows.length,
    remaining: remain.length,
    foregroundClass: fgClass,
    reason: desktopUp ? undefined : `${remain.length} cửa sổ vẫn đang hiển thị`
  };
}

// ---------------------------------------------------------------------------
// Taskbar (chi la FALLBACK - khong phai phuong phap chinh)
// ---------------------------------------------------------------------------
export function getTaskbarRect() {
  const h = api.findWindowW('Shell_TrayWnd', null);
  if (!h) return null;
  return getWindowRect(h);
}

function rootWindowAt(x, y) {
  if (!windowAtPointFn) return null;
  try {
    const h = windowAtPointFn({ x: Math.round(x), y: Math.round(y) });
    if (!h) return null;
    const root = api.getAncestor(h, GA_ROOT);
    return root || h;
  } catch {
    return null;
  }
}

export function windowAtPoint(x, y) {
  const h = rootWindowAt(x, y);
  if (!h) return null;
  return describeWindow(toNum(h));
}

export function isDesktopAt(x, y) {
  const h = rootWindowAt(x, y);
  if (!h) return null;
  const cls = getWindowClass(h).toLowerCase();
  return DESKTOP_CLASSES.has(cls);
}

// ---------------------------------------------------------------------------
// Format danh sach cho log / prompt
// ---------------------------------------------------------------------------
export function formatWindowList(opts = {}) {
  const max = Number(opts.max ?? 15);
  const list = findWindows().filter((w) => w.title);
  const fg = getForegroundWindow();

  const lines = ['WINDOWS:'];
  list.slice(0, max).forEach((w, i) => {
    lines.push(`${i + 1}. ${w.title}`);
    lines.push(
      `   hwnd=${w.hwnd} pid=${w.pid} proc=${w.processName} visible=${w.visible} minimized=${w.minimized}` +
        (w.rect ? ` rect=(${w.rect.left},${w.rect.top})-(${w.rect.right},${w.rect.bottom})` : '')
    );
  });
  if (list.length > max) lines.push(`   ... (con ${list.length - max} cua so khac)`);

  const fgw = describeWindow(fg);
  lines.push('FOREGROUND:');
  lines.push(`   ${fgw ? fgw.title || fgw.className || '(không có title)' : '(không rõ)'}`);
  lines.push(`   hwnd=${fgw ? fgw.hwnd : 0} pid=${fgw ? fgw.pid : 0} proc=${fgw ? fgw.processName : ''}`);
  return lines.join('\n');
}

export const constants = {
  SW_MINIMIZE,
  SW_RESTORE,
  SW_HIDE,
  SW_SHOWNORMAL,
  GA_ROOT,
  SHELL_CLASSES: [...SHELL_CLASSES]
};
