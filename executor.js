import { Point, sleep } from '@nut-tree-fork/nut-js';
import { config } from './config.js';
import { resolveKeyName, resolveNutKey } from './keys.js';
import { resolveBackend } from './backends.js';
import { INPUT_ACTIONS, WINDOW_STATE_ACTIONS } from './brain.js';
import * as wm from './windows.js';

let mapping = { scaleX: 1, scaleY: 1, maxX: Infinity, maxY: Infinity };

export function setCoordinateMap(scaleX, scaleY = scaleX, maxX = Infinity, maxY = Infinity) {
  mapping = { scaleX, scaleY, maxX, maxY };
  console.log(
    `    Tọa độ: scale = ${scaleX.toFixed(4)} x ${scaleY.toFixed(4)} | clamp khung = ${maxX}x${maxY}`
  );
}

function toScreen(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number' || Number.isNaN(x) || Number.isNaN(y)) {
    throw new Error(`Tọa độ không hợp lệ: (${x}, ${y})`);
  }
  const cx = Math.min(Math.max(0, Math.round(x)), mapping.maxX - 1);
  const cy = Math.min(Math.max(0, Math.round(y)), mapping.maxY - 1);
  if (cx !== Math.round(x) || cy !== Math.round(y)) {
    console.log(`    Tọa độ (${x}, ${y}) bị clamp về (${cx}, ${cy})`);
  }
  return new Point(Math.round(cx * mapping.scaleX), Math.round(cy * mapping.scaleY));
}

export function resolveKey(name) {
  return resolveNutKey(name);
}

async function drag(backend, from, to) {
  const a = toScreen(from.x, from.y);
  const b = toScreen(to.x, to.y);
  await backend.moveTo(a.x, a.y);
  await sleep(80);
  await backend.setButton('left', true);
  await sleep(80);
  await backend.moveTo(b.x, b.y);
  await sleep(80);
  await backend.setButton('left', false);
}

// ---------------------------------------------------------------------------
// WINDOW GUARD - trạng thái cửa sổ do executor theo dõi
//   expectedHwnd : HWND mà input action phải gửi vào (0 = chưa biết)
//   reobserve    : vừa có window action -> PHẢI chụp ảnh mới trước khi input
//   blocked      : activation thất bại -> cấm input action
// ---------------------------------------------------------------------------
const guard = {
  expectedHwnd: 0,
  expectedTitle: '',
  reobserve: false,
  blocked: null
};

export function resetWindowGuard() {
  guard.expectedHwnd = 0;
  guard.expectedTitle = '';
  guard.reobserve = false;
  guard.blocked = null;
  console.log('    [WINDOW] guard reset');
}

/** Gọi sau khi index.js đã chụp screenshot mới (đã quan sát lại). */
export function acknowledgeReobserve() {
  guard.reobserve = false;
}

/** Mở block khi không còn cách nào khác (dùng rất hạn chế). */
export function clearWindowBlock() {
  guard.blocked = null;
}

export function getWindowGuard() {
  return {
    expectedHwnd: guard.expectedHwnd,
    expectedTitle: guard.expectedTitle,
    reobserve: guard.reobserve,
    blocked: guard.blocked ? { ...guard.blocked } : null,
    foreground: wm.getForegroundWindow()
  };
}

function setExpected(win) {
  guard.expectedHwnd = win && win.hwnd ? win.hwnd : 0;
  guard.expectedTitle = win && win.title ? win.title : '';
}

function describeHwnd(hwnd) {
  const w = hwnd ? wm.describeWindow(hwnd) : null;
  if (!w) return `hwnd=${hwnd}`;
  return `hwnd=${hwnd} "${w.title || w.className || '(không có title)'}" (${w.processName})`;
}

// ---------------------------------------------------------------------------
// Window actions
// ---------------------------------------------------------------------------
async function runWindowActivate(action) {
  const res = await wm.activateWindow(action.target);
  if (res.success) {
    setExpected(res);
    guard.blocked = null;
    guard.reobserve = true;
    console.log(
      `    [WINDOW] window_activate -> OK hwnd=${res.hwnd} "${res.title}" foreground=${res.foreground}`
    );
    return { done: false, window: { ...res, reason: undefined }, reobserve: true };
  }
  setExpected(null);
  guard.blocked = {
    blocked: 'WINDOW_ACTIVATE_FAILED',
    reason: res.reason || 'không activate được cửa sổ',
    target: action.target
  };
  console.log(`    [WINDOW] window_activate -> FAILED: ${guard.blocked.reason}`);
  console.log('    [WINDOW] BLOCKED: WINDOW_ACTIVATE_FAILED (không gửi input cho tới khi activate lại được)');
  return { done: false, window: { ...res }, blocked: { ...guard.blocked } };
}

async function runWindowRestore(action) {
  const res = await wm.restoreWindow(action.target);
  if (res.success) {
    guard.reobserve = true;
    setExpected(res.window);
    guard.blocked = null;
    console.log(
      `    [WINDOW] window_restore -> OK hwnd=${res.window.hwnd} "${res.window.title}" wasMinimized=${res.wasMinimized}`
    );
    return { done: false, window: { ...res, reason: undefined }, reobserve: true };
  }
  setExpected(null);
  guard.blocked = {
    blocked: 'WINDOW_ACTIVATE_FAILED',
    reason: res.reason || 'không restore được cửa sổ',
    target: action.target
  };
  console.log(`    [WINDOW] window_restore -> FAILED: ${guard.blocked.reason}`);
  return { done: false, window: { ...res }, blocked: { ...guard.blocked } };
}

async function runWindowMinimize(action) {
  const res = await wm.minimizeWindow(action.target);
  if (res.success) {
    guard.reobserve = true;
    setExpected(null);
    guard.blocked = null;
    console.log(`    [WINDOW] window_minimize -> OK hwnd=${res.window.hwnd}`);
    return { done: false, window: { ...res, reason: undefined }, reobserve: true };
  }
  guard.blocked = {
    blocked: 'WINDOW_ACTIVATE_FAILED',
    reason: res.reason || 'không minimize được cửa sổ',
    target: action.target
  };
  console.log(`    [WINDOW] window_minimize -> FAILED: ${guard.blocked.reason}`);
  return { done: false, window: { ...res }, blocked: { ...guard.blocked } };
}

async function runShowDesktop() {
  const res = await wm.showDesktop();
  guard.reobserve = true;
  setExpected(null);
  if (res.success) {
    guard.blocked = null;
    console.log(`    [WINDOW] show_desktop -> OK (minimize ${res.minimized} cửa sổ)`);
    return { done: false, desktop: { ...res, reason: undefined }, reobserve: true };
  }
  console.log(`    [WINDOW] show_desktop -> PARTIAL: ${res.reason || ''}`);
  return { done: false, desktop: { ...res }, reobserve: true };
}

/**
 * FALLBACK CHỈ DÙNG KHI window_activate KHÔNG TÌM ĐƯỢC CỬA SỔ.
 * Chiến lược: tìm HWND qua Window Manager; nếu có -> đưa target lên trên cùng
 * bằng cách minimize các cửa sổ khác rồi activate (không click mù taskbar).
 */
async function runTaskbarActivate(action) {
  const { window: found } = wm.findWindow(action.target);
  if (!found) {
    const taskbar = wm.getTaskbarRect();
    setExpected(null);
    guard.blocked = {
      blocked: 'TASKBAR_ACTIVATE_FAILED',
      reason: `không tìm thấy cửa sổ "${JSON.stringify(action.target)}" qua Window Manager; taskbar button không xác định được bằng API`,
      taskbarRect: taskbar
    };
    console.log(`    [WINDOW] taskbar_activate -> FAILED: ${guard.blocked.reason}`);
    return { done: false, blocked: { ...guard.blocked } };
  }
  console.log(`    [WINDOW] taskbar_activate (fallback) -> "${found.title}" hwnd=${found.hwnd}`);
  const others = wm.findWindows().filter((w) => w.hwnd !== found.hwnd && !w.minimized);
  for (const w of others) {
    try {
      await wm.minimizeWindow({ hwnd: w.hwnd });
    } catch {
      /* bỏ qua */
    }
  }
  const res = await wm.activateWindow({ hwnd: found.hwnd });
  guard.reobserve = true;
  if (res.success) {
    setExpected(res);
    guard.blocked = null;
    console.log(`    [WINDOW] taskbar_activate -> OK hwnd=${res.hwnd} "${res.title}"`);
    return { done: false, window: { ...res, reason: undefined }, reobserve: true };
  }
  guard.blocked = {
    blocked: 'TASKBAR_ACTIVATE_FAILED',
    reason: res.reason || 'taskbar fallback không activate được',
    target: action.target
  };
  console.log(`    [WINDOW] taskbar_activate -> FAILED: ${guard.blocked.reason}`);
  return { done: false, window: { ...res }, blocked: { ...guard.blocked } };
}

async function runWindowList() {
  const text = wm.formatWindowList({ max: 15 });
  console.log(`    [WINDOW] window_list\n${text.split('\n').map((l) => '      ' + l).join('\n')}`);
  return { done: false, windowList: text };
}

// ---------------------------------------------------------------------------
// Execute 1 action
// ---------------------------------------------------------------------------
export async function executeAction(action) {
  if (!action || typeof action !== 'object') {
    throw new Error('Hành động rỗng hoặc không phải object');
  }

  if (config.dryRun) {
    console.log('    [DRY-RUN] bỏ qua thực thi:', JSON.stringify(action));
    return {
      done: action.action === 'done' || action.action === 'finish',
      reason: action.reason
    };
  }

  // chỉ resolve input backend khi action thực sự cần gửi input
  const backend = INPUT_ACTIONS.has(action.action) ? await resolveBackend() : null;

  switch (action.action) {
    case 'click': {
      const p = toScreen(action.x, action.y);
      await backend.moveTo(p.x, p.y);
      await sleep(50);
      await backend.click(action.button || 'left', Boolean(action.double));
      return { done: false };
    }
    case 'move': {
      const p = toScreen(action.x, action.y);
      await backend.moveTo(p.x, p.y);
      return { done: false };
    }
    case 'type':
      await backend.typeText(action.text ?? '');
      return { done: false };
    case 'press':
      await backend.pressKey(resolveKeyName(action.key));
      return { done: false };
    case 'hold': {
      const name = resolveKeyName(action.key);
      const ms = Math.max(0, Math.round(Number(action.ms ?? 1000)));
      await backend.keyDown(name);
      try {
        await sleep(ms);
      } finally {
        await backend.keyUp(name);
      }
      return { done: false };
    }
    case 'hotkey': {
      const names = (action.keys || []).map(resolveKeyName);
      if (names.length === 0) throw new Error('hotkey cần mảng keys');
      await backend.hotkey(names);
      return { done: false };
    }
    case 'scroll': {
      const amount = Number(action.amount ?? 3);
      await backend.scroll((action.direction || 'down') === 'up' ? 'up' : 'down', amount);
      return { done: false };
    }
    case 'drag':
      await drag(backend, action.from, action.to);
      return { done: false };
    case 'wait':
      await sleep(Number(action.ms ?? 1000));
      return { done: false };
    case 'done':
    case 'finish':
      console.log('    HOÀN TẤT:', action.reason || '(không có lý do)');
      resetWindowGuard();
      return { done: true, reason: action.reason };
    case 'window_list':
      return await runWindowList();
    case 'window_activate':
      return await runWindowActivate(action);
    case 'window_restore':
      return await runWindowRestore(action);
    case 'window_minimize':
      return await runWindowMinimize(action);
    case 'show_desktop':
      return await runShowDesktop();
    case 'taskbar_activate':
      return await runTaskbarActivate(action);
    default:
      throw new Error(`Hành động không hỗ trợ: ${action.action}`);
  }
}

// ---------------------------------------------------------------------------
// Execute 1 chuỗi (array) action
//   - chặn input khi reobserve / activation failed / foreground sai
//   - mỗi action có try/catch riêng (1 lỗi không giết cả chuỗi)
// ---------------------------------------------------------------------------
export async function executeActions(actions) {
  const queue = (Array.isArray(actions) ? actions : [actions]).filter(
    (a) => a && typeof a === 'object'
  );

  if (queue.length === 0) {
    await sleep(1000);
    return { done: false, executed: 0 };
  }

  // block do window_activate thất bại được GIỮ tới khi activate lại thành công
  let executed = 0;
  let stopped = null;

  for (let i = 0; i < queue.length; i++) {
    const action = queue[i];
    const name = action.action;
    const isInput = INPUT_ACTIONS.has(name);
    const isWindow = WINDOW_STATE_ACTIONS.has(name);

    if (isInput) {
      if (guard.blocked) {
        stopped = { ...guard.blocked };
        console.log(
          `    [WINDOW] BLOCKED: ${guard.blocked.blocked} -> bỏ qua "${name}" (${guard.blocked.reason})`
        );
        break;
      }
      if (guard.reobserve) {
        stopped = {
          blocked: 'REOBSERVE_REQUIRED',
          reason: `vừa có window action ở chuỗi trước -> phải xem screenshot mới trước khi "${name}"`
        };
        console.log(`    [WINDOW] REOBSERVE_REQUIRED -> bỏ qua "${name}"`);
        break;
      }
      if (guard.expectedHwnd) {
        const fg = wm.getForegroundWindow();
        if (fg !== guard.expectedHwnd) {
          stopped = {
            blocked: 'FOREGROUND_CHANGED',
            reason: `foreground=${describeHwnd(fg)} nhưng cửa sổ đích=${describeHwnd(guard.expectedHwnd)}`
          };
          console.log(`    [WINDOW] FOREGROUND_CHANGED -> bỏ qua "${name}"`);
          console.log(`    [WINDOW] ${stopped.reason}`);
          break;
        }
      }
    }

    try {
      const result = await executeAction(action);
      executed++;
      if (result && result.blocked && !stopped) {
        stopped = { blocked: result.blocked.blocked, reason: result.blocked.reason };
      }
      if (isWindow && result && result.reobserve) guard.reobserve = true;
      if (result && result.done) {
        return { done: true, reason: result.reason, executed, ...(stopped ? { blocked: stopped.blocked } : {}) };
      }
      if (i < queue.length - 1) await sleep(80);
    } catch (err) {
      executed++;
      console.log(`    LỖI hành động "${name}": ${err.message} -> bỏ qua, tiếp tục chuỗi`);
    }
  }

  const out = { done: false, executed };
  if (stopped) out.blocked = stopped.blocked;
  if (stopped) out.blockReason = stopped.reason;
  if (guard.reobserve) out.reobserve = true;
  if (guard.expectedHwnd) out.expectedHwnd = guard.expectedHwnd;
  return out;
}
