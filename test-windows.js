// Test Windows Window Management Layer
// Chạy: npm run test-windows   (hoặc: node test-windows.js)
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

// --- Chuẩn bị: danh sách cửa sổ thật -------------------------------------
const all = wm.findWindows();
const withTitle = all.filter((w) => w.title);
const winA = withTitle.find((w) => !wm.isWindowMinimized(w.hwnd)) || withTitle[0];
const winB = withTitle.find((w) => w.hwnd !== winA?.hwnd);
const minimized = withTitle.find((w) => w.minimized);
const originalFg = wm.getForegroundWindow();

console.log('Danh sách cửa sổ phát hiện được:');
console.log(wm.formatWindowList({ max: 8 }));

// ---------------------------------------------------------------------------
section('TEST 1 - findWindow theo process / title / hwnd / target lạ');
{
  const byProc = wm.findWindow({ process: 'explorer.exe' });
  ok(!!byProc.window && byProc.window.processName === 'explorer.exe', 'findWindow({process:"explorer.exe"})');

  const byHwnd = wm.findWindow({ hwnd: winA.hwnd });
  ok(!!byHwnd.window && byHwnd.window.hwnd === winA.hwnd, 'findWindow({hwnd}) trả về đúng HWND');

  const byTitle = wm.findWindow({ title: winA.title });
  ok(!!byTitle.window && byTitle.window.title === winA.title, 'findWindow({title}) khớp chính xác title');

  const byString = wm.findWindow(winA.title);
  ok(!!byString.window, 'findWindow(chuỗi title)');

  const alias = wm.findWindow({ target: 'File Explorer' });
  ok(!alias.window || alias.window.processName === 'explorer.exe', 'alias "File Explorer" -> explorer.exe');

  const missing = wm.findWindow({ target: 'Cửa sổ không tồn tại zzz-999' });
  ok(missing.window === null, 'target không tồn tại -> null');
}

// ---------------------------------------------------------------------------
section('TEST 2 - window_activate đưa đúng cửa sổ lên foreground (kèm verify)');
{
  resetWindowGuard();
  const res = await wm.activateWindow({ hwnd: winA.hwnd });
  ok(res.success === true, 'activateWindow trả success=true', res.reason);
  ok(res.foreground === true, 'foreground verification = true');
  ok(wm.getForegroundWindow() === winA.hwnd, 'GetForegroundWindow() === target hwnd',
    `fg=${wm.getForegroundWindow()} target=${winA.hwnd}`);
  ok(!!res.rect && typeof res.rect.left === 'number', 'trả về rect của cửa sổ');
}

// ---------------------------------------------------------------------------
section('TEST 3 - cửa sổ minimized -> restore + activate');
{
  if (!minimized) {
    console.log('  SKIP  không có cửa sổ minimized nào để test');
  } else {
    resetWindowGuard();
    const res = await wm.activateWindow({ hwnd: minimized.hwnd });
    ok(res.success === true, `activate cửa sổ minimized "${minimized.title}"`, res.reason);
    ok(wm.isWindowMinimized(minimized.hwnd) === false, 'sau activate cửa sổ không còn minimized');
    ok(wm.getForegroundWindow() === minimized.hwnd, 'foreground = cửa sổ vừa restore');
  }
}

// ---------------------------------------------------------------------------
section('TEST 4 - activate thất bại -> WINDOW_ACTIVATE_FAILED chặn input cùng chuỗi');
{
  resetWindowGuard();
  const fgBefore = wm.getForegroundWindow();
  const r = await executeActions([
    { action: 'window_activate', target: 'Cửa sổ không tồn tại zzz-999' },
    { action: 'move', x: 0, y: 0 }
  ]);
  ok(r.blocked === 'WINDOW_ACTIVATE_FAILED', 'kết quả blocked = WINDOW_ACTIVATE_FAILED', `got=${r.blocked}`);
  ok(r.executed === 1, 'chỉ 1 action chạy (click bị bỏ qua)', `executed=${r.executed}`);
  ok(getWindowGuard().blocked?.blocked === 'WINDOW_ACTIVATE_FAILED', 'guard giữ block sau chuỗi');
  ok(wm.getForegroundWindow() === fgBefore, 'foreground không thay đổi (không có input nào được gửi)');

  const r2 = await executeActions([{ action: 'move', x: 0, y: 0 }]);
  ok(r2.blocked === 'WINDOW_ACTIVATE_FAILED', 'chuỗi mới vẫn bị chặn cho tới khi activate lại được');
  ok(r2.executed === 0, 'không action nào được thực thi', `executed=${r2.executed}`);

  // activate hợp lệ để mở block
  const okRes = await executeActions([{ action: 'window_activate', target: { hwnd: winA.hwnd } }]);
  ok(!okRes.blocked, 'window_activate thành công -> bỏ block');
}

// ---------------------------------------------------------------------------
section('TEST 5 - window action + input cùng chuỗi -> REOBSERVE_REQUIRED');
{
  resetWindowGuard();
  const r = await executeActions([
    { action: 'window_activate', target: { hwnd: winA.hwnd } },
    { action: 'move', x: 10, y: 10 }
  ]);
  ok(r.reobserve === true, 'kết quả reobserve=true');
  ok(r.blocked === 'REOBSERVE_REQUIRED', 'blocked = REOBSERVE_REQUIRED', `got=${r.blocked}`);
  ok(r.executed === 1, 'chỉ window_activate chạy', `executed=${r.executed}`);

  // sau khi index.js chụp ảnh -> acknowledge -> input được phép
  acknowledgeReobserve();
  const pos = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
  const r2 = await executeActions([{ action: 'move', x: pos.x, y: pos.y }]);
  ok(!r2.blocked, 'sau acknowledgeReobserve -> input không bị chặn', JSON.stringify(r2));
  ok(r2.executed === 1, 'input được thực thi', `executed=${r2.executed}`);
}

// ---------------------------------------------------------------------------
section('TEST 6 - foreground bị đổi giữa activation và click -> FOREGROUND_CHANGED');
{
  resetWindowGuard();
  const act = await executeActions([{ action: 'window_activate', target: { hwnd: winA.hwnd } }]);
  ok(!act.blocked, 'activate winA thành công');
  acknowledgeReobserve();

  if (!winB) {
    console.log('  SKIP  không có cửa sổ thứ 2 để đổi foreground');
  } else {
    // giả lập người dùng click sang cửa sổ khác
    await wm.activateWindow({ hwnd: winB.hwnd });
    ok(wm.getForegroundWindow() === winB.hwnd, 'foreground đã đổi sang cửa sổ khác');

    const pos = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
    const r = await executeActions([{ action: 'move', x: pos.x, y: pos.y }]);
    ok(r.blocked === 'FOREGROUND_CHANGED', 'blocked = FOREGROUND_CHANGED', `got=${r.blocked}`);
    ok(r.executed === 0, 'không gửi input đi', `executed=${r.executed}`);

    // activate lại đúng -> input đi được
    await executeActions([{ action: 'window_activate', target: { hwnd: winA.hwnd } }]);
    acknowledgeReobserve();
    const r2 = await executeActions([{ action: 'move', x: pos.x, y: pos.y }]);
    ok(!r2.blocked, 'activate lại đúng cửa sổ -> input đi được', JSON.stringify(r2));
  }
}

// ---------------------------------------------------------------------------
section('TEST 7 - window_list / show_desktop / taskbar / window_restore');
{
  resetWindowGuard();
  const r1 = await executeActions([{ action: 'window_list' }]);
  ok(r1.executed === 1 && !r1.blocked, 'window_list chạy được', JSON.stringify(r1));

  const fgBefore = wm.getForegroundWindow();
  const rd = await executeActions([{ action: 'show_desktop' }]);
  ok(rd.reobserve === true, 'show_desktop -> reobserve');
  const visibleNow = wm.findWindows().filter((w) => !w.minimized);
  ok(visibleNow.length === 0 || wm.isDesktopAt(5, 5) === true,
    'sau show_desktop màn hình trống / desktop ở trên',
    `còn ${visibleNow.length} cửa sổ`);

  acknowledgeReobserve();

  // taskbar_activate với target không tồn tại
  const rt = await executeActions([{ action: 'taskbar_activate', target: 'Cửa sổ zzz-999' }]);
  ok(rt.blocked === 'TASKBAR_ACTIVATE_FAILED', 'taskbar_activate không thấy HWND -> TASKBAR_ACTIVATE_FAILED',
    `got=${rt.blocked}`);

  // khôi phục cửa sổ trước đó
  if (fgBefore) {
    await executeActions([{ action: 'window_activate', target: { hwnd: fgBefore } }]);
    await sleep(200);
    ok(wm.getForegroundWindow() === fgBefore, 'khôi phục lại cửa sổ foreground ban đầu');
  }
  acknowledgeReobserve();

  if (minimized) {
    const rr = await executeActions([{ action: 'window_restore', target: { hwnd: minimized.hwnd } }]);
    ok(rr.reobserve === true, 'window_restore -> reobserve');
    ok(wm.isWindowMinimized(minimized.hwnd) === false, 'cửa sổ được restore');
    acknowledgeReobserve();
  } else {
    console.log('  SKIP  không có cửa sổ minimized để test window_restore');
  }
}

// ---------------------------------------------------------------------------
section('TEST 8 - mỗi action có try/catch riêng, 1 lỗi không giết cả chuỗi');
{
  resetWindowGuard();
  const before = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
  const r = await executeActions([
    { action: 'click', x: 'abc', y: 0 }, // cố tình sai -> throw trong toScreen
    { action: 'hotkey', keys: [] }, // thiếu keys -> throw
    { action: 'wait', ms: 30 }
  ]);
  ok(r.executed === 3, 'cả 3 action được xử lý (lỗi không dừng chuỗi)', `executed=${r.executed}`);
  const after = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
  ok(before.x === after.x && before.y === after.y, 'chuột không bị nhảy vì action lỗi');
}

// ---------------------------------------------------------------------------
section('TEST 9 - stagnation detector');
{
  const d = createStagnationDetector({ limit: 3 });
  const chain = [{ action: 'click', x: 100, y: 200 }];
  d.push(chain);
  d.push(chain);
  ok(d.get().stagnating === false, '2 lần chưa stagnation');
  d.push(chain);
  ok(d.get().stagnating === true, '3 lần -> stagnation');
  ok(d.message().includes('lặp'), 'message cảnh báo');
  d.push([{ action: 'wait', ms: 100 }]);
  ok(d.get().stagnating === false, 'đổi chuỗi -> reset count');
  ok(normalizeChain([{ action: 'click', y: 2, x: 1 }]) === normalizeChain([{ action: 'click', x: 1, y: 2 }]),
    'normalizeChain không phụ thuộc thứ tự key');
}

// ---------------------------------------------------------------------------
section('TEST 10 - không phá vỡ format cũ / KNOWN_ACTIONS');
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
    'mọi action cũ vẫn hợp lệ (MAX_CHAIN=5)',
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
    '6 action cửa sổ mới đều được nhận (theo lô <=5)',
    `got=${w1.length}/${w2.length}`);

  const mixed = validateActionsForTest([
    { action: 'bogus_action' },
    { action: 'window_list' },
    { action: 'window_activate', target: 'Notepad' }
  ]);
  ok(mixed.length === 2 && !mixed.some((a) => a.action === 'bogus_action'),
    'action lạ vẫn bị loại', `got=${mixed.length}`);

  ok(INPUT_ACTIONS.has('click') && INPUT_ACTIONS.has('type') && INPUT_ACTIONS.has('drag'),
    'INPUT_ACTIONS đầy đủ');
  ok(WINDOW_STATE_ACTIONS.has('window_activate') && WINDOW_STATE_ACTIONS.has('show_desktop'),
    'WINDOW_STATE_ACTIONS đầy đủ');

  const w = await executeAction({ action: 'wait', ms: 10 });
  ok(w.done === false, 'executeAction("wait") cũ không đổi');

  resetWindowGuard();
  const wd = await executeActions([{ action: 'done', reason: 'test' }]);
  ok(wd.done === true, 'executeActions([done]) cũ không đổi');
}

// ---------------------------------------------------------------------------
section('TEST 11 - KỊCH BẢN THỰC: Chrome che Explorer -> activate trước khi click');
{
  const explorer = wm.findWindow({ target: 'File Explorer' }).window;
  const chrome = wm.findWindow({ process: 'chrome.exe' }).window;

  if (!explorer || !chrome) {
    console.log('  SKIP  cần có cả Chrome lẫn File Explorer đang mở');
  } else {
    // Chrome đè lên trên
    await executeActions([{ action: 'window_activate', target: { hwnd: chrome.hwnd } }]);
    acknowledgeReobserve();
    ok(wm.getForegroundWindow() === chrome.hwnd, 'Chrome đang ở trên cùng (che Explorer)');

    // Agent phải activate Explorer trước
    const r = await executeActions([{ action: 'window_activate', target: 'File Explorer' }]);
    ok(!r.blocked, 'window_activate Explorer thành công', JSON.stringify(r.blocked));
    ok(wm.getForegroundWindow() === explorer.hwnd,
      'foreground = Explorer sau activation',
      `fg=${wm.getForegroundWindow()} explorer=${explorer.hwnd}`);
    ok(wm.isWindowMinimized(explorer.hwnd) === false, 'Explorer không còn minimized');

    acknowledgeReobserve();
    const pos = await import('@nut-tree-fork/nut-js').then((m) => m.mouse.getPosition());
    const r2 = await executeActions([{ action: 'move', x: pos.x, y: pos.y }]);
    ok(!r2.blocked, 'sau activation input được phép vào Explorer', JSON.stringify(r2));

    const at = wm.windowAtPoint(pos.x, pos.y);
    ok(!!at, 'windowAtPoint đọc được cửa sổ tại con trỏ', JSON.stringify(at));

    // khôi phục Chrome như cũ
    await executeActions([{ action: 'window_activate', target: { hwnd: chrome.hwnd } }]);
    acknowledgeReobserve();
    ok(wm.getForegroundWindow() === chrome.hwnd, 'khôi phục Chrome lên trên như ban đầu');
  }
}

// ---------------------------------------------------------------------------
section('TEST 12 - phân tích pixel: diff màn hình / điểm click / vị trí con trỏ');
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
  ok(same && same.ratio === 0, '2 khung giống hệt nhau -> ratio = 0', JSON.stringify(same));
  ok(formatDiff(same).includes('KHÔNG thay đổi'), 'formatDiff báo màn hình KHÔNG thay đổi');

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
  ok(!!d && d.ratio > 0, 'khung có vùng đổi -> ratio > 0', JSON.stringify(d));
  ok(!!d && !!d.bbox && d.bbox.x0 <= 4 && d.bbox.x1 >= 12 && d.bbox.y0 <= 4 && d.bbox.y1 >= 12,
    'bbox bao trùm vùng đổi', JSON.stringify(d && d.bbox));
  ok(formatDiff(d).includes('vùng đổi'), 'formatDiff nêu được tọa độ vùng đổi');
  ok(diffFrames(a, { w: 1, h: 1, rgba: new Uint8Array(4) }) === null, 'khác kích thước -> null');

  const ctx = { rect: { left: 0, top: 0, right: 100, bottom: 100 }, width: 1920, height: 1080 };
  ok(checkPoints([{ x: 10, y: 10 }], ctx).length === 0, 'điểm nằm trong cửa sổ -> không cảnh báo');
  ok(checkPoints([{ x: 5000, y: 10 }], { rect: null, width: 1920, height: 1080 }).length === 1,
    'điểm nằm NGOÀI màn hình -> cảnh báo');
  ok(checkPoints([{ x: 1919, y: 1079 }], ctx).length === 1,
    'điểm nằm NGOÀI cửa sổ foreground -> cảnh báo');
  ok(checkPoints([], ctx).length === 0, 'không có điểm -> không cảnh báo');
  ok(checkCursor({ x: 100, y: 100 }, { x: 100, y: 100 }) === '', 'chuột đúng chỗ -> không cảnh báo');
  ok(checkCursor({ x: 100, y: 100 }, { x: 400, y: 100 }).includes('CHUỘT THẬT'),
    'chuột lệch 300px -> bắt được lỗi mapping');
}

// ---------------------------------------------------------------------------
section('TEST 13 - lưới tọa độ: PNG encode/decode, vẽ lưới, khung pixel sạch');
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
  ok(png.readUInt32BE(0) === 0x89504e47, 'encodePng tạo đúng magic number PNG');

  const dec = decodePng(png);
  ok(!!dec && dec.width === w && dec.height === h, 'decodePng đọc đúng kích thước',
    JSON.stringify(dec && { w: dec.width, h: dec.height }));
  ok(!!dec && dec.rgba[0] === rgba[0] && dec.rgba[1] === rgba[1] && dec.rgba[2] === rgba[2],
    'vòng lặp encode -> decode giữ nguyên màu');
  ok(drawGrid(Buffer.from('khong phai png')) === null, 'drawGrid với buffer không phải PNG -> null');

  const img = decodePng(png);
  const g = renderGrid(img, { step: 16, quant: 4 });
  ok(!!g && g.width === w && g.height === h, 'renderGrid trả đúng kích thước');
  const gd = decodePng(g.png);
  ok(!!gd, 'giải lại được PNG sau khi vẽ lưới');
  const idx = (25 * w + 16) * 4; // điểm nằm trên đường kẻ dọc x=16
  ok(!!gd && gd.rgba[idx] !== dec.rgba[idx], 'đường lưới đã được vẽ lên ảnh',
    `${gd && gd.rgba[idx]} vs ${dec.rgba[idx]}`);

  // prepareShot: khung pixel trả về phải là ẢNH GỐC, không dính lưới
  const src = path.join('temp', 'test-grid-src.png');
  const out = path.join('temp', 'test-grid-out.png');
  await fs.mkdir('temp', { recursive: true });
  await fs.writeFile(src, png);
  const p1 = await prepareShot(src, { grid: false });
  ok(p1.path === src && !!p1.frame && p1.frame.w === w, 'không bật lưới -> giữ nguyên đường dẫn + có khung pixel');
  const p2 = await prepareShot(src, { grid: true, step: 16, quant: 4, gridPath: out });
  ok(p2.path === out, 'bật lưới -> trả file lưới riêng', p2.path);
  ok(!!p2.frame && p2.frame.rgba[idx] === dec.rgba[idx],
    'khung pixel KHÔNG dính lưới (phục vụ so sánh 2 khung hình)');
  const gdec = decodePng(await fs.readFile(out));
  ok(!!gdec && gdec.rgba[idx] !== p2.frame.rgba[idx], 'file gửi model CÓ lưới');
  await fs.unlink(src).catch(() => {});
  await fs.unlink(out).catch(() => {});
}

// --- Tổng kết --------------------------------------------------------------
console.log('\n========================================');
console.log(`KẾT QUẢ: ${pass} PASS / ${fail} FAIL`);
if (fail) {
  console.log('Các test lỗi:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('========================================');
process.exit(fail ? 1 : 0);
