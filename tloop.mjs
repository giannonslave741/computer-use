// tloop: moi 2 phut chup man hinh 1 lan -> vision chot "con trong game?" ->
// neu CO -> spam click giua cua so Roblox + bam T moi 0.5s den chu ky sau;
// neu Roblox mat/crash -> tu relaunch qua protocol Froststrap; khong join duoc placeId -> vision xem Continue.
// Chay:   node launch-tloop.mjs  (hoac npm run tloop)
// Dung:   npm run tloop:stop     (tao file stop-tloop.flag)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { takeScreenShot } from './capture.js';
import {
  askModel,
  loadSessionState,
  saveSessionState,
  deleteSession,
  cleanupCuaSessions
} from './brain.js';
import {
  executeActions,
  setCoordinateMap,
  acknowledgeReobserve,
  resetWindowGuard
} from './executor.js';
import { resolveBackend } from './backends.js';
import { resolveKeyName } from './keys.js';
import * as wm from './windows.js';
import { screen, mouse, sleep } from '@nut-tree-fork/nut-js';
import { config } from './config.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const STOP_FILE = path.join(dir, 'stop-tloop.flag');
const LOG_FILE = path.join(dir, 'tloop.log');
const GOAL = fs.readFileSync(path.join(dir, 'tloop-goal.txt'), 'utf8');
const RELAUNCH_PS1 = path.join(dir, 'tloop-relaunch.ps1');

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
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function stopRequested() {
  return fs.existsSync(STOP_FILE);
}

function parseArgs(argv) {
  const opts = { interval: 120000, spamMs: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--interval') opts.interval = Number(argv[++i]) || 120000;
    else if (a === '--spam-ms') opts.spamMs = Number(argv[++i]) || 500;
    else if (a === '--model') config.model = argv[++i];
    else if (a === '--agent') config.agent = argv[++i];
    else if (a === '--backend') config.inputBackend = argv[++i];
    else if (a === '--dry-run') config.dryRun = true;
    else if (a === '--no-continue') config.continueSession = false;
    else if (a === '--no-failsafe') config.failSafeCorner = false;
  }
  return opts;
}

function findRoblox() {
  let r = wm.findWindow({ process: 'RobloxPlayerBeta.exe' });
  if (!r.window) r = wm.findWindow({ titleContains: 'Roblox' });
  return r.window || null;
}

async function checkFailSafe(state) {
  if (!config.failSafeCorner) return false;
  const pos = await mouse.getPosition();
  const inCorner =
    pos.x <= config.failSafeCornerTolerancePx && pos.y <= config.failSafeCornerTolerancePx;
  if (inCorner) {
    if (!state.cornerSince) {
      state.cornerSince = Date.now();
      log('!! Chuot o goc man hinh - giu yen de DUNG khẩn cap...');
    } else if (Date.now() - state.cornerSince >= config.failSafeCornerMs) {
      return true;
    }
  } else {
    if (state.cornerSince) log('Da roi goc man hinh, tiep tuc.');
    state.cornerSince = null;
  }
  return false;
}

async function calibrate(img) {
  const screenW = await screen.width();
  const screenH = await screen.height();
  setCoordinateMap(screenW / img.width, screenH / img.height, img.width, img.height);
}

function foregroundText() {
  try {
    const f = wm.describeForeground();
    if (!f) return '(khong lay duoc foreground)';
    return [
      `title=${f.title || '(khong co title)'}`,
      `hwnd=${f.hwnd} pid=${f.pid} proc=${f.processName || '?'} visible=${f.visible} minimized=${f.minimized}`,
      f.rect ? `rect=(${f.rect.left},${f.rect.top})-(${f.rect.right},${f.rect.bottom})` : ''
    ]
      .filter(Boolean)
      .join(' | ');
  } catch (err) {
    return `(loi doc foreground: ${err.message})`;
  }
}

function windowListText() {
  try {
    return wm.formatWindowList({ max: 12 });
  } catch (err) {
    return `(loi liet ke cua so: ${err.message})`;
  }
}

// Chay ps1 relaunch, bat stdout de biet placeId. Tra ve placeId string hoac null.
function runRelaunch(reason) {
  log(`[RELAUNCH] ${reason}`);
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RELAUNCH_PS1],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    p.stdout.on('data', (d) => {
      out += d.toString();
      d.toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => log(`[REL] ${l}`));
    });
    p.stderr.on('data', (d) => {
      out += d.toString();
      d.toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => log(`[REL-ERR] ${l}`));
    });
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* bo qua */
      }
      log('[RELAUNCH] qua 100s, kill ps1');
    }, 100000);
    const finish = (placeId) => {
      clearTimeout(timer);
      resolve(placeId);
    };
    p.on('exit', (code) => {
      const m = out.match(/placeId=(\d+)/);
      log(`[RELAUNCH] exit=${code} placeId=${m ? m[1] : 'None'}`);
      finish(m ? m[1] : null);
    });
    p.on('error', (err) => {
      log(`[RELAUNCH] loi spawn: ${err.message}`);
      finish(null);
    });
  });
}

function relaunchHint(placeId) {
  if (placeId) {
    return (
      `\nHINH: he thong vua tu dong relaunch Roblox bang placeId ${placeId}. ` +
      `Neu dang loading -> wait. Neu van o MENU -> dung TRANG THAI 3 (xem Continue, click Play/Continue). ` +
      `KHONG chay tloop-relaunch.ps1 nua trong chu ky nay.`
    );
  }
  return (
    '\nHINH: he thong vua tu dong mo lai Roblox (khong co placeId) -> xem Continue de vao lai game. ' +
    'Neu dang loading -> wait. Neu o MENU -> TRANG THAI 3 (click Continue/Play cua game vua choi). ' +
    'KHONG chay tloop-relaunch.ps1 nua trong chu ky nay.'
  );
}

async function spamLoop(deadline, opts, state) {
  if (config.dryRun) {
    log('[SPAM] dry-run -> bo qua spam click+T');
    return 'dry';
  }
  const backend = await resolveBackend();
  let ticks = 0;
  let fails = 0;
  log(`[SPAM] bat dau, moi ${opts.spamMs}ms (click giua cua so + T), den deadline...`);
  while (Date.now() < deadline) {
    if (stopRequested()) return 'stop';
    if (await checkFailSafe(state)) return 'corner';

    const win = findRoblox();
    if (!win) {
      log('[SPAM] mat cua so Roblox -> dung spam, chu ky sau tu relaunch');
      return 'no-window';
    }

    const fg = wm.getForegroundWindow();
    if (fg !== win.hwnd) {
      const res = await wm.activateWindow({ hwnd: win.hwnd }, { retries: 2 });
      if (!res.success) {
        fails++;
        log(`[SPAM] activate that bai (${fails}/5): ${res.reason}`);
        if (fails >= 5) return 'activate-fail';
        await sleepMs(400);
        continue;
      }
      await sleepMs(250);
    }
    fails = 0;

    const rect = win.rect;
    if (!rect) {
      await sleepMs(300);
      continue;
    }
    const cx = Math.round((rect.left + rect.right) / 2);
    const cy = Math.round((rect.top + rect.bottom) / 2);

    // khong click khi tam cua so bi cua so khac che
    const at = wm.windowAtPoint(cx, cy);
    if (at && at.pid !== win.pid) {
      const res = await wm.activateWindow({ hwnd: win.hwnd }, { retries: 1 });
      if (res.success) await sleepMs(250);
      const at2 = wm.windowAtPoint(cx, cy);
      if (at2 && at2.pid !== win.pid) {
        await sleepMs(400);
        continue; // van bi che -> bo nhip, KHONG click vua cua so khac
      }
    }

    try {
      await backend.moveTo(cx, cy);
      await sleepMs(25);
      await backend.click('left');
      await backend.pressKey(resolveKeyName('T'));
      ticks++;
      if (ticks % 60 === 0) log(`[SPAM] ${ticks} nhip...`);
    } catch (err) {
      log(`[SPAM] loi input: ${err.message || err}`);
    }
    await sleepMs(opts.spamMs);
  }
  log(`[SPAM] ket thuc sau ${ticks} nhip`);
  return 'deadline';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    fs.rmSync(STOP_FILE, { force: true });
  } catch {
    /* bo qua */
  }

  log('=== tloop bat dau ===');
  log(
    `interval=${opts.interval}ms spamMs=${opts.spamMs}ms dryRun=${config.dryRun} failsafe=${config.failSafeCorner}`
  );

  resetWindowGuard();
  if (!config.dryRun) {
    const backend = await resolveBackend();
    log(`backend: ${backend?.name || 'ok'}`);
  }

  const session = loadSessionState();
  log(`session: ${session.sessionId || '(moi)'} | luot: ${session.calls}`);
  if (config.continueSession) await cleanupCuaSessions(session.sessionId);

  let stop = false;
  const onSignal = (sig) => {
    log(`[${sig}] dung theo yeu cau...`);
    stop = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const state = {
    cornerSince: null,
    lastAction: null,
    step: 0,
    relaunchHint: '',
    robloxPid: 0,
    lastRelaunchAt: 0,
    staleMenu: 0,
    lastShotAt: 0
  };

  while (!stop && !stopRequested()) {
    try {
      // dam bao >= 2 phut giua 2 lan chup anh
      if (state.lastShotAt) {
        const gap = state.lastShotAt + opts.interval - Date.now();
        if (gap > 0) await sleepMs(gap);
      }
      if (stop || stopRequested()) break;
      if (await checkFailSafe(state)) {
        log('*** DUNG KHAN CAP: chuot o goc man hinh ***');
        break;
      }

      // crash check + safety net cho menu bi mac
      let win = findRoblox();
      if (!win) {
        state.lastRelaunchAt = Date.now();
        const pid = await runRelaunch('mat cua so Roblox (crash?)');
        state.relaunchHint = relaunchHint(pid);
        state.staleMenu = 0;
      } else {
        if (state.robloxPid && win.pid !== state.robloxPid) {
          log(`Roblox pid doi ${state.robloxPid} -> ${win.pid} (da khoi lai gan day)`);
          state.lastRelaunchAt = Date.now();
          state.staleMenu = 0;
          state.relaunchHint = '';
        }
        state.robloxPid = win.pid;
        const oldEnough = Date.now() - state.lastRelaunchAt > 150000;
        if (state.staleMenu >= 3 && oldEnough) {
          const pid = await runRelaunch(`menu bi mac ${state.staleMenu} chu ky lien tiep`);
          state.relaunchHint = relaunchHint(pid);
          state.lastRelaunchAt = Date.now();
        }
      }

      // chup anh (dinh ky 2 phut)
      state.step++;
      const img = await takeScreenShot();
      state.lastShotAt = Date.now();
      const deadline = state.lastShotAt + opts.interval;
      log(`[CYCLE ${state.step}] screenshot ${img.width}x${img.height} -> deadline ${now()}`);
      if (state.step === 1) await calibrate(img);
      acknowledgeReobserve();

      // vision
      let inGame = false;
      try {
        const { actions, raw, durationMs, sessionId } = await askModel({
          goal: GOAL + state.relaunchHint,
          step: state.step,
          img,
          history: {
            lastAction: state.lastAction,
            foreground: foregroundText(),
            windows: windowListText(),
            stagnation: '',
            blocked: ''
          },
          sessionId: session.sessionId,
          title: session.sessionId ? null : 'TLoop'
        });
        if (sessionId) {
          if (session.sessionId !== sessionId) {
            session.sessionId = sessionId;
            log(`session: ${sessionId}`);
          }
          session.calls++;
          if (session.calls >= config.rotateAfterCalls) {
            log(`dat ${config.rotateAfterCalls} luot -> xoay session`);
            await deleteSession(session.sessionId);
            session.sessionId = null;
            session.calls = 0;
          }
          saveSessionState(session);
        }
        log(`LLM (${(durationMs / 1000).toFixed(1)}s): ${raw.replace(/\s+/g, ' ').slice(0, 300)}`);

        inGame = actions.some((a) => a.action === 'done' || a.action === 'finish');
        const rest = actions.filter((a) => a.action !== 'done' && a.action !== 'finish');
        if (rest.length) {
          log(`thuc thi ${rest.length} hanh dong: ${JSON.stringify(rest)}`);
          const result = await executeActions(rest);
          state.lastAction = JSON.stringify(rest);
          if (result.blocked) {
            log(`[WINDOW] blocked: ${result.blocked} - ${result.blockReason || ''}`);
          }
          if (result.reobserve) log('[WINDOW] reobserve required');
        } else if (inGame) {
          state.lastAction = '[done: in game]';
        }
      } catch (err) {
        log(`LLM loi: ${err.message || err}`);
      }

      // so do menu cu
      if (inGame) {
        state.staleMenu = 0;
        state.relaunchHint = '';
        log('[CYCLE] TRONG GAME -> bat spam click+T');
        const r = await spamLoop(deadline, opts, state);
        if (r === 'corner') {
          log('*** DUNG KHAN CAP: chuot o goc man hinh ***');
          break;
        }
        if (r === 'no-window' || r === 'activate-fail') state.lastRelaunchAt = Date.now();
      } else {
        state.staleMenu++;
        log(
          `[CYCLE] khong trong game (lan ${state.staleMenu}) -> cho den chu ky sau, khong spam` +
            (state.relaunchHint ? ' (co HINH cho LLM xem Continue)' : '')
        );
        let corner = false;
        while (Date.now() < deadline && !stop && !stopRequested()) {
          if (await checkFailSafe(state)) {
            corner = true;
            break;
          }
          await sleepMs(500);
        }
        if (corner) {
          log('*** DUNG KHAN CAP: chuot o goc man hinh ***');
          break;
        }
      }
    } catch (error) {
      log(`loi vong lap: ${error.message || error}`);
      await sleepMs(2000);
    }
  }

  try {
    fs.rmSync(STOP_FILE, { force: true });
  } catch {
    /* bo qua */
  }
  log(`=== tloop ket thuc sau ${state.step} chu ky ===`);
}

main().catch((err) => {
  log(`LOI nghiem trong: ${err.stack || err.message}`);
  process.exit(1);
});
