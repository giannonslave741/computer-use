// cu/act.mjs — nâng cửa sổ theo HWND rồi bắn input TRONG CÙNG tiến trình
// (tránh việc console của lệnh chen lên giữa raise và click).
//
//   node act.mjs <hwnd> raise
//   node act.mjs <hwnd> click <x> <y> [dbl|right]
//   node act.mjs <hwnd> type "<text>"
//   node act.mjs <hwnd> key <KEY> [KEY2 ...]
import { createRequire } from 'module';
import { resolveBackend } from '../backends.js';
import { sleep } from '@nut-tree-fork/nut-js';

const require = createRequire('D:/computer use/package.json');
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const ShowWindow = user32.func('bool __stdcall ShowWindow(void *h, int n)');
const BringWindowToTop =
  user32.func('bool __stdcall BringWindowToTop(void *h)');
const SetForegroundWindow =
  user32.func('bool __stdcall SetForegroundWindow(void *h)');
const GetForegroundWindow =
  user32.func('void *__stdcall GetForegroundWindow(void)');
const IsWindow = user32.func('bool __stdcall IsWindow(void *h)');
const IsIconic = user32.func('bool __stdcall IsIconic(void *h)');
const GetWindowTextW = user32.func(
  'int __stdcall GetWindowTextW(void *h, _Out_ uint16_t *buf, int n)');

function titleOf(h) {
  const buf = new Uint16Array(512);
  const n = GetWindowTextW(h, buf, 512);
  return n > 0 ? Buffer.from(buf.buffer, 0, n * 2).toString('utf16le') : '';
}

const [hwndArg, action, ...rest] = process.argv.slice(2);
const hwnd = BigInt(hwndArg);
if (!IsWindow(hwnd)) throw new Error(`HWND không hợp lệ: ${hwndArg}`);

if (IsIconic(hwnd)) ShowWindow(hwnd, 9);   // chỉ restore khi minimize
BringWindowToTop(hwnd);
SetForegroundWindow(hwnd);
await sleep(200);

const fg = GetForegroundWindow();
console.log(`title=${titleOf(hwnd)}`);
console.log(`foreground_ok=${fg === hwnd}`);

const b = await resolveBackend();

if (action === 'raise') {
  // chỉ nâng cửa sổ
} else if (action === 'click') {
  const [x, y, mode] = rest;
  await b.moveTo(parseFloat(x), parseFloat(y));
  await sleep(140);
  await b.click(mode === 'right' ? 'right' : 'left', mode === 'dbl');
  console.log(`clicked (${x},${y}) ${mode || ''}`);
} else if (action === 'type') {
  const text = rest.join(' ');
  await b.typeText(text);
  console.log(`typed: ${text}`);
} else if (action === 'key') {
  if (rest.length > 1) {
    await b.hotkey(rest);
    console.log(`hotkey ${rest.join('+')}`);
  } else {
    await b.pressKey(rest[0]);
    console.log(`key ${rest[0]}`);
  }
} else {
  throw new Error(`action lạ: ${action}`);
}
await sleep(150);
