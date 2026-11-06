// Wander mode: di chuyen lung tung trong game lien tuc, KHONG chup anh, KHONG goi AI.
// Chay:   npm run wander
// Dung:   npm run wander:stop   (tao file stop-wander.flag)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBackend } from './backends.js';
import { resolveKeyName } from './keys.js';
import * as wm from './windows.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const STOP_FILE = path.join(dir, 'stop-wander.flag');
const LOG_FILE = path.join(dir, 'wander.log');

const argv = process.argv.slice(2);
function argNum(name, def) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return Number(argv[i + 1]);
  return def;
}
const MAX_SECONDS = argNum('--seconds', 0); // 0 = chay den khi stop
const TARGET = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : 'Roblox';

const now = () => new Date().toISOString().slice(11, 19);
function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* bo qua */
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stopRequested() {
  return fs.existsSync(STOP_FILE);
}

const DIRS = ['W', 'A', 'S', 'D', 'W', 'A', 'S', 'D', 'W', 'D', 'W', 'S'];
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rnd(0, arr.length - 1)];

async function ensureForeground(backend, state) {
  const fg = wm.getForegroundWindow();
  if (fg === state.hwnd && wm.isWindow(state.hwnd)) return true;

  log(`Foreground khong phai ${TARGET} (fg=${fg}) -> dang activate...`);
  const res = await wm.activateWindow({ hwnd: state.hwnd }, { retries: 2 });
  if (res.success) {
    log(`Activate OK hwnd=${res.hwnd}`);
    await sleep(300);
    return true;
  }
  log(`Activate that bai: ${res.reason}`);
  return false;
}

function turnCamera(backend, cur) {
  const delta = rnd(-160, 160);
  const x = Math.min(1900, Math.max(60, cur.x + delta));
  const y = Math.min(1000, Math.max(60, cur.y + rnd(-30, 30)));
  return backend.moveTo(x, y).then(() => ({ x, y }));
}

async function main() {
  try {
    fs.rmSync(STOP_FILE, { force: true });
  } catch {
    /* bo qua */
  }

  const found = wm.findWindow({ target: TARGET });
  if (!found.window) {
    const list = wm.formatWindowList({ max: 10 });
    log(`KHONG TIM THAY cua so "${TARGET}" -> dung. Danh sach:\n${list}`);
    process.exit(1);
  }

  const state = { hwnd: found.window.hwnd };
  log(`Target: "${found.window.title}" hwnd=${state.hwnd} (${found.window.processName})`);

  const backend = await resolveBackend();
  const { mouse } = await import('@nut-tree-fork/nut-js');
  log(`Backend: ${backend.name}`);

  if (!(await ensureForeground(backend, state))) {
    log('Khong dua duoc cua so len truoc -> dung (khong bam phim mu).');
    process.exit(1);
  }

  const started = Date.now();
  let moves = 0;
  let turns = 0;
  let rechecks = 0;

  log(`Bat dau wander${MAX_SECONDS ? ` (toi da ${MAX_SECONDS}s)` : ' (lien tuc, dung bang npm run wander:stop)'}...`);

  while (!stopRequested()) {
    if (MAX_SECONDS && (Date.now() - started) / 1000 >= MAX_SECONDS) {
      log('Dat gioi han thoi gian -> dung.');
      break;
    }

    if (!(await ensureForeground(backend, state))) {
      rechecks++;
      if (rechecks > 5) {
        log('That bai qua nhieu lan -> dung de tranh bam phim vao cua so khac.');
        break;
      }
      await sleep(800);
      continue;
    }
    rechecks = 0;

    const roll = Math.random();

    if (roll < 0.55) {
      // 1 huong
      const key = pick(DIRS);
      const ms = rnd(400, 1700);
      await backend.keyDown(resolveKeyName(key));
      await sleep(ms);
      await backend.keyUp(resolveKeyName(key));
      moves++;
      log(`hold ${key} ${ms}ms`);
    } else if (roll < 0.78) {
      // 2 huong ket hop
      const k1 = pick(DIRS);
      let k2 = pick(DIRS);
      if (k2 === k1) k2 = k1 === 'W' ? 'A' : 'W';
      const ms = rnd(500, 1400);
      await backend.keyDown(resolveKeyName(k1));
      await backend.keyDown(resolveKeyName(k2));
      await sleep(ms);
      await backend.keyUp(resolveKeyName(k2));
      await backend.keyUp(resolveKeyName(k1));
      moves++;
      log(`hold ${k1}+${k2} ${ms}ms`);
    } else if (roll < 0.9) {
      // nhay
      await backend.keyDown(resolveKeyName('SPACE'));
      await sleep(rnd(120, 320));
      await backend.keyUp(resolveKeyName('SPACE'));
      moves++;
      log('jump');
    } else {
      // quay camera
      try {
        const cur = await mouse.getPosition();
        await turnCamera(backend, cur);
        turns++;
        log('turn camera');
      } catch (err) {
        log(`turn loi: ${err.message}`);
      }
    }

    if (Math.random() < 0.25) await sleep(rnd(250, 1100));
    if (moves > 0 && moves % 25 === 0) {
      log(`--- da di ${moves} nhip, quay ${turns} lan, ${(Date.now() - started) / 1000 | 0}s ---`);
    }
  }

  // dam bao khong giu phim
  for (const k of ['W', 'A', 'S', 'D', 'SPACE']) {
    try {
      await backend.keyUp(resolveKeyName(k));
    } catch {
      /* bo qua */
    }
  }
  log(`DUNG. ${moves} nhip di chuyen, ${turns} lan quay camera sau ${((Date.now() - started) / 1000) | 0}s`);
  try {
    fs.rmSync(STOP_FILE, { force: true });
  } catch {
    /* bo qua */
  }
  process.exit(0);
}

main().catch((err) => {
  log(`LOI nghiem trong: ${err.stack || err.message}`);
  process.exit(1);
});
