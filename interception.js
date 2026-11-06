import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const MAPVK_VK_TO_VSC = 2;
const MAPVK_VK_TO_VSC_EX = 4;

const KEY_DOWN = 0x00;
const KEY_UP = 0x01;
const KEY_E0 = 0x02;
const KEY_E1 = 0x04;

const MOUSE_MOVE_ABSOLUTE = 0x001;
const MOUSE_VIRTUAL_DESKTOP = 0x002;

const BUTTON_STATE = {
  left: { down: 0x001, up: 0x002 },
  right: { down: 0x004, up: 0x008 },
  middle: { down: 0x010, up: 0x020 }
};
const MOUSE_WHEEL = 0x400;
const WHEEL_DELTA = 120;

const MAX_KEYBOARD = 10;
const MAX_DEVICE = 20;

const EXTENDED_VK = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d,
  0xa3, 0xa5, 0x6f
]);

const SCAN_OVERRIDE = {
  0x2c: { code: 0x37, flags: KEY_E0 }
};

const VK_BY_NAME = (() => {
  const t = {
    escape: 0x1b,
    tab: 0x09,
    backspace: 0x08,
    enter: 0x0d,
    return: 0x0d,
    space: 0x20,
    print: 0x2c,
    printscreen: 0x2c,
    scrolllock: 0x91,
    pause: 0x13,
    capslock: 0x14,
    numlock: 0x90,
    grave: 0xc0,
    minus: 0xbd,
    equal: 0xbb,
    insert: 0x2d,
    home: 0x24,
    pageup: 0x21,
    delete: 0x2e,
    end: 0x23,
    pagedown: 0x22,
    leftbracket: 0xdb,
    rightbracket: 0xdd,
    backslash: 0xdc,
    semicolon: 0xba,
    quote: 0xde,
    comma: 0xbc,
    period: 0xbe,
    slash: 0xbf,
    divide: 0x6f,
    multiply: 0x6a,
    subtract: 0x6d,
    add: 0x6b,
    decimal: 0x6e,
    numpadequal: 0xbb,
    leftshift: 0xa0,
    rightshift: 0xa1,
    shift: 0xa0,
    leftcontrol: 0xa2,
    rightcontrol: 0xa3,
    control: 0xa2,
    leftalt: 0xa4,
    rightalt: 0xa5,
    alt: 0xa4,
    leftwin: 0x5b,
    leftcmd: 0x5b,
    leftmeta: 0x5b,
    leftsuper: 0x5b,
    rightwin: 0x5c,
    rightcmd: 0x5c,
    rightmeta: 0x5c,
    rightsuper: 0x5c,
    win: 0x5b,
    cmd: 0x5b,
    meta: 0x5b,
    super: 0x5b,
    menu: 0x5d,
    left: 0x25,
    up: 0x26,
    right: 0x27,
    down: 0x28,
    clear: 0x0c,
    audiomute: 0xad,
    audiovoldown: 0xaf,
    audiovolup: 0xae,
    audioplay: 0xb3,
    audiopause: 0xb3,
    audiostop: 0xb2,
    audioprev: 0xb1,
    audionext: 0xb0
  };
  for (let i = 0; i <= 9; i++) t[`num${i}`] = 0x30 + i;
  for (let i = 1; i <= 24; i++) t[`f${i}`] = 0x70 + i - 1;
  for (let i = 0; i <= 9; i++) t[`numpad${i}`] = 0x60 + i;
  for (const c of 'abcdefghijklmnopqrstuvwxyz') t[c] = c.toUpperCase().charCodeAt(0);
  return t;
})();

let win32 = null;

function ensureWin32() {
  if (win32) return win32;
  const user32 = koffi.load('user32.dll');
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
  win32 = {
    getCursorPos: user32.func('int __stdcall GetCursorPos(_Out_ POINT *pos)'),
    getSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
    mapVirtualKeyW: user32.func('uint __stdcall MapVirtualKeyW(uint uCode, uint uMapType)'),
    vkKeyScanW: user32.func('short __stdcall VkKeyScanW(wchar_t ch)'),
    getAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vKey)')
  };
  return win32;
}

const state = {
  ready: false,
  context: null,
  sendKey: null,
  sendMouse: null,
  isKeyboard: null,
  isMouse: null,
  getHardwareId: null,
  dll: null,
  keyboard: 0,
  mouse: 0,
  messages: []
};

function resolveDllPath() {
  const cands = [];
  const configured = config.interception?.dllPath;
  if (configured) cands.push(path.resolve(configured));
  cands.push(path.join(HERE, 'vendor', 'interception.dll'));
  if (process.arch === 'ia32') cands.push(path.join(HERE, 'vendor', 'interception-x86.dll'));
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'interception.dll';
}

function log(msg) {
  state.messages.push(msg);
}

export function init() {
  if (state.ready) return true;

  ensureWin32();

  const dllPath = resolveDllPath();
  let dll;
  try {
    dll = koffi.load(dllPath);
  } catch (err) {
    throw new Error(`không tải được ${dllPath}: ${err.message}`);
  }

  const MouseStroke = koffi.struct('InterceptionMouseStroke', {
    state: 'uint16',
    flags: 'uint16',
    rolling: 'int16',
    x: 'int32',
    y: 'int32',
    information: 'uint32'
  });
  const KeyStroke = koffi.struct('InterceptionKeyStroke', {
    code: 'uint16',
    state: 'uint16',
    information: 'uint32'
  });

  if (koffi.sizeof(MouseStroke) !== 20 || koffi.sizeof(KeyStroke) !== 8) {
    throw new Error(
      `kích thước struct sai (mouse=${koffi.sizeof(MouseStroke)}, key=${koffi.sizeof(KeyStroke)})`
    );
  }

  state.dll = dll;
  state.sendMouse = dll.func(
    'int interception_send(void *context, int device, const InterceptionMouseStroke *stroke, uint nstroke)'
  );
  state.sendKey = dll.func(
    'int interception_send(void *context, int device, const InterceptionKeyStroke *stroke, uint nstroke)'
  );
  state.isKeyboard = dll.func('int interception_is_keyboard(int device)');
  state.isMouse = dll.func('int interception_is_mouse(int device)');
  state.getHardwareId = dll.func(
    'uint interception_get_hardware_id(void *context, int device, _Out_ uint16_t *buffer, uint size)'
  );

  const createContext = dll.func('void *interception_create_context(void)');
  const destroyContext = dll.func('void interception_destroy_context(void *context)');

  const context = createContext();
  if (!context) {
    throw new Error(
      'interception_create_context() trả về NULL - driver Interception chưa được cài (chạy scripts/setup-interception.ps1 với quyền Admin)'
    );
  }

  state.context = context;
  state.destroy = () => destroyContext(context);
  state.ready = true;
  return true;
}

export function shutdown() {
  if (state.destroy) {
    try {
      state.destroy();
    } catch {
      /* bỏ qua */
    }
    state.destroy = null;
  }
  state.ready = false;
  state.context = null;
}

export function messages() {
  return [...state.messages];
}

function assertReady() {
  if (!state.ready) init();
}

function hardwareId(device) {
  try {
    const buf = new Uint16Array(256);
    const n = state.getHardwareId(state.context, device, buf, buf.length);
    if (!n) return null;
    let out = '';
    for (let i = 0; i < buf.length && buf[i] !== 0; i++) out += String.fromCharCode(buf[i]);
    return out || null;
  } catch {
    return null;
  }
}

export function listDevices() {
  assertReady();
  const out = [];
  for (let d = 1; d <= MAX_DEVICE; d++) {
    const type = state.isKeyboard(d) ? 'keyboard' : state.isMouse(d) ? 'mouse' : null;
    if (!type) continue;
    out.push({ device: d, type, hardwareId: hardwareId(d) });
  }
  return out;
}

function cursor() {
  const pos = {};
  if (!win32.getCursorPos(pos)) throw new Error('GetCursorPos thất bại');
  return { x: pos.x, y: pos.y };
}

function screenSize() {
  return {
    width: Math.max(1, win32.getSystemMetrics(SM_CXSCREEN)),
    height: Math.max(1, win32.getSystemMetrics(SM_CYSCREEN))
  };
}

function normalize(value, size) {
  const max = size - 1;
  if (max <= 0) return 0;
  return Math.min(65535, Math.max(0, Math.round((value * 65535) / max)));
}

function sendMouseStroke(device, stroke) {
  if (!state.ready) throw new Error('Interception chưa khởi tạo');
  if (!device) throw new Error('Chưa chọn được thiết bị chuột Interception');
  return state.sendMouse(state.context, device, stroke, 1);
}

function sendKeyStroke(device, code, flags) {
  if (!state.ready) throw new Error('Interception chưa khởi tạo');
  if (!device) throw new Error('Chưa chọn được thiết bị bàn phím Interception');
  return state.sendKey(state.context, device, { code, state: flags, information: 0 }, 1);
}

function trySendMouse(device, stroke) {
  try {
    sendMouseStroke(device, stroke);
    return true;
  } catch {
    return false;
  }
}

function trySendKey(device, code, flags) {
  try {
    sendKeyStroke(device, code, flags);
    return true;
  } catch {
    return false;
  }
}

function absoluteStroke(x, y, width, height) {
  return {
    state: 0,
    flags: MOUSE_MOVE_ABSOLUTE,
    rolling: 0,
    x: normalize(x, width),
    y: normalize(y, height),
    information: 0
  };
}

async function probeMouse(device) {
  const { width, height } = screenSize();
  const before = cursor();
  let tx = before.x + 61;
  let ty = before.y + 37;
  if (tx > width - 3) tx = before.x - 61;
  if (ty > height - 3) ty = before.y - 37;
  tx = Math.min(Math.max(1, tx), width - 2);
  ty = Math.min(Math.max(1, ty), height - 2);

  if (!trySendMouse(device, absoluteStroke(tx, ty, width, height))) return false;
  await sleepMs(35);
  const after = cursor();
  const ok = Math.abs(after.x - tx) <= 3 && Math.abs(after.y - ty) <= 3;
  trySendMouse(device, absoluteStroke(before.x, before.y, width, height));
  return ok;
}

const VK_LSHIFT = 0xa0;

async function probeKeyboard(device) {
  const pressed = () => (win32.getAsyncKeyState(VK_LSHIFT) & 0x8000) !== 0;

  if (!trySendKey(device, 0x2a, KEY_DOWN)) return false;
  await sleepMs(25);
  const sawDown = pressed();
  trySendKey(device, 0x2a, KEY_UP);
  await sleepMs(25);
  if (pressed()) {
    for (let i = 0; i < 3 && pressed(); i++) {
      trySendKey(device, 0x2a, KEY_UP);
      await sleepMs(20);
    }
  }
  return sawDown && !pressed();
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pickDevices() {
  assertReady();

  const cfg = config.interception || {};
  const wantedKb = Number(cfg.keyboard || 0);
  const wantedMouse = Number(cfg.mouse || 0);

  if (cfg.autoDetect === false) {
    state.keyboard = wantedKb || 1;
    state.mouse = wantedMouse || MAX_KEYBOARD + 1;
    log(`autoDetect tắt: keyboard #${state.keyboard}, mouse #${state.mouse}`);
    return { keyboard: state.keyboard, mouse: state.mouse };
  }

  const keyboards = [];
  const mice = [];
  for (let d = 1; d <= MAX_DEVICE; d++) {
    if (state.isKeyboard(d)) keyboards.push(d);
    else if (state.isMouse(d)) mice.push(d);
  }

  const kbOrder = wantedKb ? [wantedKb, ...keyboards.filter((d) => d !== wantedKb)] : keyboards;
  const mouseOrder = wantedMouse ? [wantedMouse, ...mice.filter((d) => d !== wantedMouse)] : mice;

  for (const d of mouseOrder) {
    if (await probeMouse(d)) {
      state.mouse = d;
      log(`mouse hoạt động: #${d}${hardwareId(d) ? ` (${hardwareId(d)})` : ''}`);
      break;
    }
  }
  if (!state.mouse) {
    state.mouse = mouseOrder[0] || 0;
    log(`không dò được mouse, dùng #${state.mouse}`);
  }

  for (const d of kbOrder) {
    if (await probeKeyboard(d)) {
      state.keyboard = d;
      log(`keyboard hoạt động: #${d}${hardwareId(d) ? ` (${hardwareId(d)})` : ''}`);
      break;
    }
  }
  if (!state.keyboard) {
    state.keyboard = kbOrder[0] || 0;
    log(`không dò được keyboard, dùng #${state.keyboard}`);
  }

  return { keyboard: state.keyboard, mouse: state.mouse };
}

export function devices() {
  return { keyboard: state.keyboard, mouse: state.mouse };
}

export function moveTo(x, y) {
  assertReady();
  const { width, height } = screenSize();
  const cx = Math.min(Math.max(0, Math.round(x)), width - 1);
  const cy = Math.min(Math.max(0, Math.round(y)), height - 1);
  sendMouseStroke(state.mouse, absoluteStroke(cx, cy, width, height));
}

export function setButton(button, down) {
  assertReady();
  const btn = BUTTON_STATE[String(button || 'left').toLowerCase()];
  if (!btn) throw new Error(`Nút chuột không hợp lệ: ${button}`);
  sendMouseStroke(state.mouse, {
    state: down ? btn.down : btn.up,
    flags: 0,
    rolling: 0,
    x: 0,
    y: 0,
    information: 0
  });
}

export function scroll(direction, amount) {
  assertReady();
  const steps = Math.round(Number(amount) || 1);
  const delta = (direction === 'up' ? 1 : -1) * steps * WHEEL_DELTA;
  const wrapped = delta < -32768 ? -32768 : delta > 32767 ? 32767 : delta;
  sendMouseStroke(state.mouse, {
    state: MOUSE_WHEEL,
    flags: 0,
    rolling: wrapped,
    x: 0,
    y: 0,
    information: 0
  });
}

export function toScan(vk) {
  ensureWin32();
  const override = SCAN_OVERRIDE[vk];
  if (override) return { code: override.code, flags: override.flags };

  let sc = win32.mapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
  if (!sc) sc = win32.mapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
  if (!sc) return null;

  let flags = 0;
  if ((sc & 0xe100) === 0xe100) flags |= KEY_E1;
  else if ((sc & 0xe000) === 0xe000) flags |= KEY_E0;
  else if (EXTENDED_VK.has(vk)) flags |= KEY_E0;

  const code = sc & 0xff;
  if (!code) return null;
  return { code, flags };
}

export function vkForName(name) {
  const key = String(name || '').toLowerCase();
  return key in VK_BY_NAME ? VK_BY_NAME[key] : null;
}

export async function keyDown(name) {
  assertReady();
  const scan = scanForName(name);
  sendKeyStroke(state.keyboard, scan.code, scan.flags | KEY_DOWN);
  await sleepMs(config.interception?.keyDelayMs ?? 12);
}

export async function keyUp(name) {
  assertReady();
  const scan = scanForName(name);
  sendKeyStroke(state.keyboard, scan.code, scan.flags | KEY_UP);
  await sleepMs(config.interception?.keyDelayMs ?? 12);
}

function scanForName(name) {
  const vk = vkForName(name);
  if (vk == null) throw new Error(`Phím không hỗ trợ qua Interception: ${name}`);
  const scan = toScan(vk);
  if (!scan) throw new Error(`Không tra được scan code cho phím: ${name}`);
  return scan;
}

function charToKeys(ch) {
  if (ch === '\n') return { mods: [], vk: 0x0d };
  if (ch === '\t') return { mods: [], vk: 0x09 };
  if (ch === ' ') return { mods: [], vk: 0x20 };

  ensureWin32();
  const codePoint = ch.codePointAt(0);
  if (codePoint > 0xffff) return null;
  const v = win32.vkKeyScanW(codePoint);
  if (v === -1 || v === 0xffff) return null;

  const vk = v & 0xff;
  if (vk === 0xff) return null;
  const mods = (v >> 8) & 0xff;
  const list = [];
  if (mods & 1) list.push(0xa0);
  if (mods & 4) list.push(0xa4);
  if (mods & 2) list.push(0xa2);
  return { mods: list, vk };
}

export async function typeText(text) {
  assertReady();
  const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '');
  const items = [];
  for (const ch of raw) {
    const item = charToKeys(ch);
    if (!item) return false;
    items.push(item);
  }

  const delay = () => sleepMs(config.interception?.keyDelayMs ?? 12);
  const tap = async (vk, flagsBase) => {
    const scan = toScan(vk);
    if (!scan) throw new Error(`Không tra được scan code (vk=0x${vk.toString(16)})`);
    sendKeyStroke(state.keyboard, scan.code, scan.flags | flagsBase);
  };

  for (const item of items) {
    for (const mod of item.mods) await tap(mod, KEY_DOWN);
    await tap(item.vk, KEY_DOWN);
    await delay();
    await tap(item.vk, KEY_UP);
    for (const mod of [...item.mods].reverse()) await tap(mod, KEY_UP);
    await delay();
  }
  return true;
}

export function keyHoldMs() {
  return config.interception?.holdMs ?? 60;
}

export const constants = { KEY_DOWN, KEY_UP, MOUSE_MOVE_ABSOLUTE, MOUSE_VIRTUAL_DESKTOP, WHEEL_DELTA };
