// Wander mode: keep moving around in the game, with no screenshots and no AI calls.
// Run:    npm run wander
// Stop:   npm run wander:stop   (creates stop-wander.flag)
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
const MAX_SECONDS = argNum('--seconds', 0); // 0 = run until stop
const TARGET = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : 'Roblox';

const now = () => new Date().toISOString().slice(11, 19);
function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* ignore */
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

  log(`Foreground is not ${TARGET} (fg=${fg}) -> activating...`);
  const res = await wm.activateWindow({ hwnd: state.hwnd }, { retries: 2 });
  if (res.success) {
    log(`Activate OK hwnd=${res.hwnd}`);
    await sleep(300);
    return true;
  }
  log(`Activate failed: ${res.reason}`);
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
    /* ignore */
  }

  const found = wm.findWindow({ target: TARGET });
  if (!found.window) {
    const list = wm.formatWindowList({ max: 10 });
    log(`Window "${TARGET}" was not found -> stop. List:\n${list}`);
    process.exit(1);
  }

  const state = { hwnd: found.window.hwnd };
  log(`Target: "${found.window.title}" hwnd=${state.hwnd} (${found.window.processName})`);

  const backend = await resolveBackend();
  const { mouse } = await import('@nut-tree-fork/nut-js');
  log(`Backend: ${backend.name}`);

  if (!(await ensureForeground(backend, state))) {
    log('Could not bring the window to the front -> stop (will not press keys blindly).');
    process.exit(1);
  }

  const started = Date.now();
  let moves = 0;
  let turns = 0;
  let rechecks = 0;

  log(`Starting wander${MAX_SECONDS ? ` (max ${MAX_SECONDS}s)` : ' (runs until npm run wander:stop)'}...`);

  while (!stopRequested()) {
    if (MAX_SECONDS && (Date.now() - started) / 1000 >= MAX_SECONDS) {
      log('Time limit reached -> stop.');
      break;
    }

    if (!(await ensureForeground(backend, state))) {
      rechecks++;
      if (rechecks > 5) {
        log('Too many failures -> stop so keys are not sent to another window.');
        break;
      }
      await sleep(800);
      continue;
    }
    rechecks = 0;

    const roll = Math.random();

    if (roll < 0.55) {
      // one direction
      const key = pick(DIRS);
      const ms = rnd(400, 1700);
      await backend.keyDown(resolveKeyName(key));
      await sleep(ms);
      await backend.keyUp(resolveKeyName(key));
      moves++;
      log(`hold ${key} ${ms}ms`);
    } else if (roll < 0.78) {
      // two directions together
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
      // jump
      await backend.keyDown(resolveKeyName('SPACE'));
      await sleep(rnd(120, 320));
      await backend.keyUp(resolveKeyName('SPACE'));
      moves++;
      log('jump');
    } else {
      // turn the camera
      try {
        const cur = await mouse.getPosition();
        await turnCamera(backend, cur);
        turns++;
        log('turn camera');
      } catch (err) {
        log(`turn error: ${err.message}`);
      }
    }

    if (Math.random() < 0.25) await sleep(rnd(250, 1100));
    if (moves > 0 && moves % 25 === 0) {
      log(`--- ${moves} moves, ${turns} camera turns, ${(Date.now() - started) / 1000 | 0}s ---`);
    }
  }

  // make sure no key stays held
  for (const k of ['W', 'A', 'S', 'D', 'SPACE']) {
    try {
      await backend.keyUp(resolveKeyName(k));
    } catch {
      /* ignore */
    }
  }
  log(`STOP. ${moves} moves, ${turns} camera turns after ${((Date.now() - started) / 1000) | 0}s`);
  try {
    fs.rmSync(STOP_FILE, { force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((err) => {
  log(`LOI nghiem trong: ${err.stack || err.message}`);
  process.exit(1);
});
