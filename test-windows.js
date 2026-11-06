// Test Windows Window Management Layer
// Run: npm run test-windows   (or: node test-windows.js)
import { config } from './config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as wm from './windows.js';
import { encodePng, decodePng, drawGrid, renderGrid, prepareShot } from './grid.js';
import { diffFrames, formatDiff, checkPoints, checkCursor } from './analyze.js';
import {
  executeActions,
  executeAction,
  resetWindowGuard,
  acknowledgeReobserve,
  getWindowGuard
} from './executor.js';
import { createStagnationDetector, normalizeChain } from './stagnation.js';
import { validateActionsForTest, INPUT_ACTIONS, WINDOW_STATE_ACTIONS } from './brain.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}${extra ? ' -> ' + extra : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Setup: real window list ----------------------------------------------
const all = wm.findWindows();
const withTitle = all.filter((w) => w.title);
const winA = withTitle.find((w) => !wm.isWindowMinimized(w.hwnd)) || withTitle[0];
const winB = withTitle.find((w) => w.hwnd !== winA?.hwnd);
const minimized = withTitle.find((w) => w.minimized);
const originalFg = wm.getForegroundWindow();

console.log('Windows that were found:');
console.log(wm.formatWindowList({ max: 8 }));

// ---------------------------------------------------------------------------
section('TEST 1 - findWindow by process / title / hwnd / unknown target');
{
  const byProc = wm.findWindow({ process: 'explorer.exe' });
  ok(!!byProc.window && byProc.window.processName === 'explorer.exe', 'findWindow({process:"explorer.exe"})');

  const byHwnd = wm.findWindow({ hwnd: winA.hwnd });
  ok(!!byHwnd.window && byHwnd.window.hwnd === winA.hwnd, 'findWindow({hwnd}) returns the right HWND');

  const byTitle = wm.findWindow({ title: winA.title });
  ok(!!byTitle.window && byTitle.window.title === winA.title, 'findWindow({title}) matches the title exactly');

  const byString = wm.findWindow(winA.title);
  ok(!!byString.window, 'findWindow(title string)');

  const alias = wm.findWindow({ target: 'File Explorer' });
  ok(!alias.window || alias.window.processName === 'explorer.exe', 'alias "File Explorer" -> explorer.exe');

  const missing = wm.findWindow({ target: 'Window that does not exist zzz-999' });
  ok(missing.window === null, 'missing target -> null');
}

// ---------------------------------------------------------------------------
section('TEST 2 - window_activate brings the right window to the foreground (with verify)');
{
  resetWindowGuard();
  const res = await wm.activateWindow({ hwnd: winA.hwnd });
  ok(res.success === true, 'activateWindow returns success=true', res.reason);
  ok(res.foreground === true, 'foreground verification = true');
  ok(wm.getForegroundWindow() === winA.hwnd, 'GetForegroundWindow() === target hwnd',
    `fg=${wm.getForegroundWindow()} target=${winA.hwnd}`);
  ok(!!res.rect && typeof res.rect.left === 'number', 'returns the window rect');
}

// ---------------------------------------------------------------------------
section('TEST 3 - minimized window -> restore + activate');
{
  if (!minimized) {
    console.log('  SKIP  no minimized window to test');
  } else {
    resetWindowGuard();
    const res = await wm.activateWindow({ hwnd: minimized.hwnd });
    ok(res.success === true, `activate minimized window "${minimized.title}"`, res.reason);
    ok(wm.isWindowMinimized(minimized.hwnd) === false, 'after activate the window is no longer minimized');
    ok(wm.getForegroundWindow() === minimized.hwnd, 'foreground = the window that was just restored');
  }
}

// ---------------------------------------------------------------------------
section('TEST 4 - failed activate -> WINDOW_ACTIVATE_FAILED blocks input in the same chain');
{
  resetWindowGuard();
  const fgBefore = wm.getForegroundWindow();
  const r = await executeActions([
    { action: 'window_activate', target: 'Window that does not exist zzz-999' },
    { action: 'move', x: 0, y: 0 }
  ]);
  ok(r.blocked === 'WINDOW_ACTIVATE_FAILED', 'result blocked = WINDOW_ACTIVATE_FAILED', `got=${r.blocked}`);
  ok(r.executed === 1, 'only 1 action ran (the move was skipped)', `executed=${r.executed}`);
  ok(getWindowGuard().blocked?.blocked === 'WINDOW_ACTIVATE_FAILED', 'the guard keeps the block after the chain');
  ok(wm.getForegroundWindow() === fgBefore, 'foreground did not change (no input was sent)');

  const r2 = await executeActions([{ action: 'move', x: 0, y: 0 }]);
  ok(r2.blocked === 'WINDOW_ACTIVATE_FAILED', 'a new chain stays blocked until an activate succeeds');
  ok(r2.executed === 0, 'no action ran', `executed=${r2.executed}`);

  // a valid activate clears the block
  const okRes = await executeActions([{ action: 'window_activate', target: { hwnd: winA.hwnd } }]);
  ok(!okRes.blocked, 'a successful window_activate clears the block');
}

// ---------------------------------------------------------------------------
section('TEST 5 - window action plus input in one chain -> REOBSERVE_REQUIRED');
{
  resetWindowGuard();
  const r = await executeActions([
    { action: 'window_activate', target: { hwnd: winA.hwnd } },
    { action: 'move', x: 10, y: 10 }
  ]);
  ok(r.reobserve === true, 'result reobserve=true');
  ok(r.blocked === 'REOBSERVE_REQUIRED', 'blocked = REOBSERVE_REQUIRED', `got=${r.blocked}`);
  ok(r.executed === 1, 'only window_activate ran', `executed=${r.executed}`);

  // after index.js takes a screenshot -> acknowledge -> input is allowed
  acknowledgeReobserve();
  const pos = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
  const r2 = await executeActions([{ action: 'move', x: pos.x, y: pos.y }]);
  ok(!r2.blocked, 'after acknowledgeReobserve input is not blocked', JSON.stringify(r2));
  ok(r2.executed === 1, 'the input ran', `executed=${r2.executed}`);
}

// ---------------------------------------------------------------------------
section('TEST 6 - foreground changes between activation and click -> FOREGROUND_CHANGED');
{
  resetWindowGuard();
  const act = await executeActions([{ action: 'window_activate', target: { hwnd: winA.hwnd } }]);
  ok(!act.blocked, 'activate winA succeeded');
  acknowledgeReobserve();

  if (!winB) {
    console.log('  SKIP  no second window to change the foreground');
  } else {
    // pretend the user clicked another window
    await wm.activateWindow({ hwnd: winB.hwnd });
    ok(wm.getForegroundWindow() === winB.hwnd, 'foreground moved to the other window');

    const pos = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
    const r = await executeActions([{ action: 'move', x: pos.x, y: pos.y }]);
    ok(r.blocked === 'FOREGROUND_CHANGED', 'blocked = FOREGROUND_CHANGED', `got=${r.blocked}`);
    ok(r.executed === 0, 'no input was sent', `executed=${r.executed}`);

    // activate the right window again -> input is allowed
    await executeActions([{ action: 'window_activate', target: { hwnd: winA.hwnd } }]);
    acknowledgeReobserve();
    const r2 = await executeActions([{ action: 'move', x: pos.x, y: pos.y }]);
    ok(!r2.blocked, 'activating the right window again lets input through', JSON.stringify(r2));
  }
}

// ---------------------------------------------------------------------------
section('TEST 7 - window_list / show_desktop / taskbar / window_restore');
{
  resetWindowGuard();
  const r1 = await executeActions([{ action: 'window_list' }]);
  ok(r1.executed === 1 && !r1.blocked, 'window_list ran', JSON.stringify(r1));

  const fgBefore = wm.getForegroundWindow();
  const rd = await executeActions([{ action: 'show_desktop' }]);
  ok(rd.reobserve === true, 'show_desktop -> reobserve');
  const visibleNow = wm.findWindows().filter((w) => !w.minimized);
  ok(visibleNow.length === 0 || wm.isDesktopAt(5, 5) === true,
    'after show_desktop the screen is empty or the desktop is on top',
    `${visibleNow.length} window(s) still visible`);

  acknowledgeReobserve();

  // taskbar_activate with a target that does not exist
  const rt = await executeActions([{ action: 'taskbar_activate', target: 'Window zzz-999' }]);
  ok(rt.blocked === 'TASKBAR_ACTIVATE_FAILED', 'taskbar_activate finds no HWND -> TASKBAR_ACTIVATE_FAILED',
    `got=${rt.blocked}`);

  // restore the previous window
  if (fgBefore) {
    await executeActions([{ action: 'window_activate', target: { hwnd: fgBefore } }]);
    await sleep(200);
    ok(wm.getForegroundWindow() === fgBefore, 'the original foreground window is restored');
  }
  acknowledgeReobserve();

  if (minimized) {
    const rr = await executeActions([{ action: 'window_restore', target: { hwnd: minimized.hwnd } }]);
    ok(rr.reobserve === true, 'window_restore -> reobserve');
    ok(wm.isWindowMinimized(minimized.hwnd) === false, 'the window was restored');
    acknowledgeReobserve();
  } else {
    console.log('  SKIP  no minimized window to test window_restore');
  }
}

// ---------------------------------------------------------------------------
section('TEST 8 - each action has its own try/catch, one error does not kill the chain');
{
  resetWindowGuard();
  const before = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
  const r = await executeActions([
    { action: 'click', x: 'abc', y: 0 }, // deliberately invalid -> throws in toScreen
    { action: 'hotkey', keys: [] }, // missing keys -> throws
    { action: 'wait', ms: 30 }
  ]);
  ok(r.executed === 3, 'all 3 actions were handled (an error does not stop the chain)', `executed=${r.executed}`);
  const after = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
  ok(before.x === after.x && before.y === after.y, 'the mouse did not jump because of the bad action');
}

// ---------------------------------------------------------------------------
section('TEST 9 - stagnation detector');
{
  const d = createStagnationDetector({ limit: 3 });
  const chain = [{ action: 'click', x: 100, y: 200 }];
  d.push(chain);
  d.push(chain);
  ok(d.get().stagnating === false, '2 repeats are not stagnation yet');
  d.push(chain);
  ok(d.get().stagnating === true, '3 repeats -> stagnation');
  ok(d.message().includes('repeated'), 'warning message');
  d.push([{ action: 'wait', ms: 100 }]);
  ok(d.get().stagnating === false, 'a different chain resets the count');
  ok(normalizeChain([{ action: 'click', y: 2, x: 1 }]) === normalizeChain([{ action: 'click', x: 1, y: 2 }]),
    'normalizeChain does not depend on key order');
}

// ---------------------------------------------------------------------------
section('TEST 10 - old action format still works / KNOWN_ACTIONS');
{
  const oldActions = [
    { action: 'click', x: 1, y: 2 },
    { action: 'type', text: 'a' },
    { action: 'press', key: 'ENTER' },
    { action: 'hotkey', keys: ['CTRL', 'L'] },
    { action: 'scroll', direction: 'down', amount: 2 },
    { action: 'drag', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
    { action: 'wait', ms: 10 },
    { action: 'hold', key: 'W', ms: 500 },
    { action: 'done', reason: 'x' }
  ];
  const half = Math.ceil(oldActions.length / 2);
  const v1 = validateActionsForTest(oldActions.slice(0, half));
  const v2 = validateActionsForTest(oldActions.slice(half));
  ok(v1.length === half && v2.length === oldActions.length - half,
    'every old action is still valid (MAX_CHAIN=5)',
    `got=${v1.length}/${v2.length}`);

  const windowActions = [
    { action: 'window_list' },
    { action: 'window_activate', target: 'Notepad' },
    { action: 'window_restore', target: 'Notepad' },
    { action: 'window_minimize', target: 'Notepad' },
    { action: 'show_desktop' },
    { action: 'taskbar_activate', target: 'Notepad' }
  ];
  const w1 = validateActionsForTest(windowActions.slice(0, 5));
  const w2 = validateActionsForTest(windowActions.slice(5));
  ok(w1.length === 5 && w2.length === 1,
    'all 6 new window actions are accepted (in batches of at most 5)',
    `got=${w1.length}/${w2.length}`);

  const mixed = validateActionsForTest([
    { action: 'bogus_action' },
    { action: 'window_list' },
    { action: 'window_activate', target: 'Notepad' }
  ]);
  ok(mixed.length === 2 && !mixed.some((a) => a.action === 'bogus_action'),
    'an unknown action is still dropped', `got=${mixed.length}`);

  ok(INPUT_ACTIONS.has('click') && INPUT_ACTIONS.has('type') && INPUT_ACTIONS.has('drag'),
    'INPUT_ACTIONS is complete');
  ok(WINDOW_STATE_ACTIONS.has('window_activate') && WINDOW_STATE_ACTIONS.has('show_desktop'),
    'WINDOW_STATE_ACTIONS is complete');

  const w = await executeAction({ action: 'wait', ms: 10 });
  ok(w.done === false, 'the old executeAction("wait") is unchanged');

  resetWindowGuard();
  const wd = await executeActions([{ action: 'done', reason: 'test' }]);
  ok(wd.done === true, 'the old executeActions([done]) is unchanged');
}

// ---------------------------------------------------------------------------
section('TEST 11 - REAL CASE: Chrome covers Explorer -> activate before the click');
{
  const explorer = wm.findWindow({ target: 'File Explorer' }).window;
  const chrome = wm.findWindow({ process: 'chrome.exe' }).window;

  if (!explorer || !chrome) {
    console.log('  SKIP  both Chrome and File Explorer need to be open');
  } else {
    // Chrome is on top
    await executeActions([{ action: 'window_activate', target: { hwnd: chrome.hwnd } }]);
    acknowledgeReobserve();
    ok(wm.getForegroundWindow() === chrome.hwnd, 'Chrome is on top (covering Explorer)');

    // The agent must activate Explorer first
    const r = await executeActions([{ action: 'window_activate', target: 'File Explorer' }]);
    ok(!r.blocked, 'window_activate Explorer succeeded', JSON.stringify(r.blocked));
    ok(wm.getForegroundWindow() === explorer.hwnd,
      'foreground = Explorer sau activation',
      `fg=${wm.getForegroundWindow()} explorer=${explorer.hwnd}`);
    ok(wm.isWindowMinimized(explorer.hwnd) === false, 'Explorer is no longer minimized');

    acknowledgeReobserve();
    const pos = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
    const r2 = await executeActions([{ action: 'move', x: pos.x, y: pos.y }]);
    ok(!r2.blocked, 'after activation input is allowed into Explorer', JSON.stringify(r2));

    const at = wm.windowAtPoint(pos.x, pos.y);
    ok(!!at, 'windowAtPoint reads the window under the cursor', JSON.stringify(at));

    // put Chrome back on top
    await executeActions([{ action: 'window_activate', target: { hwnd: chrome.hwnd } }]);
    acknowledgeReobserve();
    ok(wm.getForegroundWindow() === chrome.hwnd, 'Chrome is back on top as it was');
  }
}

// ---------------------------------------------------------------------------
section('TEST 12 - pixel analysis: screen diff / click point / cursor position');
{
  const w = 40;
  const h = 30;
  const mk = (fill) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = fill;
      rgba[i * 4 + 1] = fill;
      rgba[i * 4 + 2] = fill;
      rgba[i * 4 + 3] = 255;
    }
    return { w, h, rgba };
  };

  const a = mk(10);
  const same = diffFrames(a, mk(10));
  ok(same && same.ratio === 0, 'two identical frames -> ratio = 0', JSON.stringify(same));
  ok(formatDiff(same).includes('almost unchanged'), 'formatDiff reports an unchanged screen');

  const c = mk(10);
  for (let y = 4; y < 12; y++) {
    for (let x = 4; x < 12; x++) {
      const i = (y * w + x) * 4;
      c.rgba[i] = 200;
      c.rgba[i + 1] = 0;
      c.rgba[i + 2] = 0;
    }
  }
  const d = diffFrames(a, c);
  ok(!!d && d.ratio > 0, 'a frame with a changed region -> ratio > 0', JSON.stringify(d));
  ok(!!d && !!d.bbox && d.bbox.x0 <= 4 && d.bbox.x1 >= 12 && d.bbox.y0 <= 4 && d.bbox.y1 >= 12,
    'bbox covers the changed region', JSON.stringify(d && d.bbox));
  ok(formatDiff(d).includes('changed region'), 'formatDiff names the changed region');
  ok(diffFrames(a, { w: 1, h: 1, rgba: new Uint8Array(4) }) === null, 'different size -> null');

  const ctx = { rect: { left: 0, top: 0, right: 100, bottom: 100 }, width: 1920, height: 1080 };
  ok(checkPoints([{ x: 10, y: 10 }], ctx).length === 0, 'a point inside the window -> no warning');
  ok(checkPoints([{ x: 5000, y: 10 }], { rect: null, width: 1920, height: 1080 }).length === 1,
    'a point OUTSIDE the screen -> warning');
  ok(checkPoints([{ x: 1919, y: 1079 }], ctx).length === 1,
    'a point OUTSIDE the foreground window -> warning');
  ok(checkPoints([], ctx).length === 0, 'no points -> no warning');
  ok(checkCursor({ x: 100, y: 100 }, { x: 100, y: 100 }) === '', 'cursor is in the right place -> no warning');
  ok(checkCursor({ x: 100, y: 100 }, { x: 400, y: 100 }).includes('ACTUAL CURSOR'),
    'cursor 300px away -> the mapping error is caught');
}

// ---------------------------------------------------------------------------
section('TEST 13 - coordinate grid: PNG encode/decode, draw grid, clean pixel frame');
{
  const w = 64;
  const h = 48;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 3) % 256;
    rgba[i * 4 + 1] = (i * 7) % 256;
    rgba[i * 4 + 2] = 90;
    rgba[i * 4 + 3] = 255;
  }

  const png = encodePng(w, h, rgba);
  ok(png.readUInt32BE(0) === 0x89504e47, 'encodePng writes a valid PNG magic number');

  const dec = decodePng(png);
  ok(!!dec && dec.width === w && dec.height === h, 'decodePng reads the right size',
    JSON.stringify(dec && { w: dec.width, h: dec.height }));
  ok(!!dec && dec.rgba[0] === rgba[0] && dec.rgba[1] === rgba[1] && dec.rgba[2] === rgba[2],
    'encode -> decode keeps the color');
  ok(drawGrid(Buffer.from('not a png')) === null, 'drawGrid on a non-PNG buffer -> null');

  const img = decodePng(png);
  const g = renderGrid(img, { step: 16, quant: 4 });
  ok(!!g && g.width === w && g.height === h, 'renderGrid returns the right size');
  const gd = decodePng(g.png);
  ok(!!gd, 'the PNG can be decoded again after the grid is drawn');
  const idx = (25 * w + 16) * 4; // a pixel on the vertical line x=16
  ok(!!gd && gd.rgba[idx] !== dec.rgba[idx], 'the grid line was drawn on the image',
    `${gd && gd.rgba[idx]} vs ${dec.rgba[idx]}`);

  // prepareShot: the returned pixel frame must be the ORIGINAL image, with no grid
  const src = path.join('temp', 'test-grid-src.png');
  const out = path.join('temp', 'test-grid-out.png');
  await fs.mkdir('temp', { recursive: true });
  await fs.writeFile(src, png);
  const p1 = await prepareShot(src, { grid: false });
  ok(p1.path === src && !!p1.frame && p1.frame.w === w, 'grid off -> same path and a pixel frame');
  const p2 = await prepareShot(src, { grid: true, step: 16, quant: 4, gridPath: out });
  ok(p2.path === out, 'grid on -> a separate grid file is returned', p2.path);
  ok(!!p2.frame && p2.frame.rgba[idx] === dec.rgba[idx],
    'the pixel frame does NOT include the grid (so two frames can be compared)');
  const gdec = decodePng(await fs.readFile(out));
  ok(!!gdec && gdec.rgba[idx] !== p2.frame.rgba[idx], 'the file sent to the model HAS the grid');
  await fs.unlink(src).catch(() => {});
  await fs.unlink(out).catch(() => {});
}

// --- Summary ---------------------------------------------------------------
console.log('\n========================================');
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail) {
  console.log('Failed tests:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('========================================');
process.exit(fail ? 1 : 0);
