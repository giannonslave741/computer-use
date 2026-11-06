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
    `    Coordinates: scale = ${scaleX.toFixed(4)} x ${scaleY.toFixed(4)} | clamp frame = ${maxX}x${maxY}`
  );
}

function toScreen(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number' || Number.isNaN(x) || Number.isNaN(y)) {
    throw new Error(`Invalid coordinate: (${x}, ${y})`);
  }
  const cx = Math.min(Math.max(0, Math.round(x)), mapping.maxX - 1);
  const cy = Math.min(Math.max(0, Math.round(y)), mapping.maxY - 1);
  if (cx !== Math.round(x) || cy !== Math.round(y)) {
    console.log(`    Coordinate (${x}, ${y}) clamped to (${cx}, ${cy})`);
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
// WINDOW GUARD - window state tracked by the executor
//   expectedHwnd : HWND that input must go to (0 = unknown)
//   reobserve    : a window action just ran -> a new screenshot is required before input
//   blocked      : activation failed -> input actions are forbidden
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

/** Call after index.js has taken a new screenshot (the required new look). */
export function acknowledgeReobserve() {
  guard.reobserve = false;
}

/** Clear the block only when there is no other way. Use rarely. */
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
  return `hwnd=${hwnd} "${w.title || w.className || '(no title)'}" (${w.processName})`;
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
    reason: res.reason || 'could not activate the window',
    target: action.target
  };
  console.log(`    [WINDOW] window_activate -> FAILED: ${guard.blocked.reason}`);
  console.log('    [WINDOW] BLOCKED: WINDOW_ACTIVATE_FAILED (no input until activation succeeds)');
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
    reason: res.reason || 'could not restore the window',
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
    reason: res.reason || 'could not minimize the window',
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
    console.log(`    [WINDOW] show_desktop -> OK (minimized ${res.minimized} window(s))`);
    return { done: false, desktop: { ...res, reason: undefined }, reobserve: true };
  }
  console.log(`    [WINDOW] show_desktop -> PARTIAL: ${res.reason || ''}`);
  return { done: false, desktop: { ...res }, reobserve: true };
}

/**
 * FALLBACK USED ONLY WHEN window_activate CANNOT FIND THE WINDOW.
 * Strategy: find the HWND through the window manager. If it exists, raise the target
 * by minimizing the other windows and then activating it. Do not click the taskbar blindly.
 */
async function runTaskbarActivate(action) {
  const { window: found } = wm.findWindow(action.target);
  if (!found) {
    const taskbar = wm.getTaskbarRect();
    setExpected(null);
    guard.blocked = {
      blocked: 'TASKBAR_ACTIVATE_FAILED',
      reason: `window "${JSON.stringify(action.target)}" was not found by the window manager; the taskbar button cannot be identified by the API`,
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
      /* ignore */
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
    reason: res.reason || 'taskbar fallback could not activate the window',
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
    throw new Error('Action is empty or not an object');
  }

  if (config.dryRun) {
    console.log('    [DRY-RUN] not executing:', JSON.stringify(action));
    return {
      done: action.action === 'done' || action.action === 'finish',
      reason: action.reason
    };
  }

  // resolve the input backend only when the action really sends input
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
      if (names.length === 0) throw new Error('hotkey needs a keys array');
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
      console.log('    DONE:', action.reason || '(no reason)');
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
      throw new Error(`Unsupported action: ${action.action}`);
  }
}

// ---------------------------------------------------------------------------
// Run one action chain (an array).
//   - block input on reobserve, failed activation, or the wrong foreground
//   - each action has its own try/catch (one failure does not kill the chain)
// ---------------------------------------------------------------------------
export async function executeActions(actions) {
  const queue = (Array.isArray(actions) ? actions : [actions]).filter(
    (a) => a && typeof a === 'object'
  );

  if (queue.length === 0) {
    await sleep(1000);
    return { done: false, executed: 0 };
  }

  // a failed window_activate stays blocked until a later activate succeeds
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
          `    [WINDOW] BLOCKED: ${guard.blocked.blocked} -> skipped "${name}" (${guard.blocked.reason})`
        );
        break;
      }
      if (guard.reobserve) {
        stopped = {
          blocked: 'REOBSERVE_REQUIRED',
          reason: `a window action ran in the previous chain -> look at a new screenshot before "${name}"`
        };
        console.log(`    [WINDOW] REOBSERVE_REQUIRED -> skipped "${name}"`);
        break;
      }
      if (guard.expectedHwnd) {
        const fg = wm.getForegroundWindow();
        if (fg !== guard.expectedHwnd) {
          stopped = {
            blocked: 'FOREGROUND_CHANGED',
            reason: `foreground=${describeHwnd(fg)} but the target window=${describeHwnd(guard.expectedHwnd)}`
          };
          console.log(`    [WINDOW] FOREGROUND_CHANGED -> skipped "${name}"`);
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
      console.log(`    Action "${name}" failed: ${err.message} -> skipped, chain continues`);
    }
  }

  const out = { done: false, executed };
  if (stopped) out.blocked = stopped.blocked;
  if (stopped) out.blockReason = stopped.reason;
  if (guard.reobserve) out.reobserve = true;
  if (guard.expectedHwnd) out.expectedHwnd = guard.expectedHwnd;
  return out;
}
