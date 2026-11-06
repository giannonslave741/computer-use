// tloop: every 2 minutes take one screenshot -> the vision model decides "still in game?" ->
// if YES -> spam a click in the middle of the Roblox window + press T every 0.5s until the next cycle;
// if Roblox is gone or crashed -> relaunch through the Froststrap protocol; if placeId cannot be joined -> the model looks for Continue.
// Run:    node launch-tloop.mjs  (or npm run tloop)
// Stop:   npm run tloop:stop     (creates stop-tloop.flag)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { takeScreenShot } from './capture.js';
import {
  ask,
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
import { config, takeProviderFlag } from './config.js';

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
    /* ignore */
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
    const providerFlag = takeProviderFlag(argv, i);
    if (providerFlag) {
      i += providerFlag - 1;
      continue;
    }
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
      log('!! Pointer is in the screen corner - hold still to STOP...');
    } else if (Date.now() - state.cornerSince >= config.failSafeCornerMs) {
      return true;
    }
  } else {
    if (state.cornerSince) log('Left the screen corner, continuing.');
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
    if (!f) return '(could not read the foreground)';
    return [
      `title=${f.title || '(no title)'}`,
      `hwnd=${f.hwnd} pid=${f.pid} proc=${f.processName || '?'} visible=${f.visible} minimized=${f.minimized}`,
      f.rect ? `rect=(${f.rect.left},${f.rect.top})-(${f.rect.right},${f.rect.bottom})` : ''
    ]
      .filter(Boolean)
      .join(' | ');
  } catch (err) {
    return `(failed to read the foreground: ${err.message})`;
  }
}

function windowListText() {
  try {
    return wm.formatWindowList({ max: 12 });
  } catch (err) {
    return `(failed to list windows: ${err.message})`;
  }
}

// Run the relaunch script and capture stdout for the placeId. Returns a placeId string or null.
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
        /* ignore */
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
      log(`[RELAUNCH] spawn failed: ${err.message}`);
      finish(null);
    });
  });
}

function relaunchHint(placeId) {
  if (placeId) {
    return (
      `\nIMAGE: the system just relaunched Roblox with placeId ${placeId}. ` +
      `If it is loading -> wait. If it is still on the MENU -> use STATE 3 (find Continue, click Play/Continue). ` +
      `Do NOT run tloop-relaunch.ps1 again this cycle.`
    );
  }
  return (
    '\nIMAGE: the system just reopened Roblox (no placeId) -> use Continue to rejoin. ' +
    'If it is loading -> wait. If it is on the MENU -> STATE 3 (click Continue/Play for the game just played). ' +
    'Do NOT run tloop-relaunch.ps1 again this cycle.'
  );
}

async function spamLoop(deadline, opts, state) {
  if (config.dryRun) {
    log('[SPAM] dry-run -> skipped click+T spam');
    return 'dry';
  }
  const backend = await resolveBackend();
  let ticks = 0;
  let fails = 0;
  log(`[SPAM] start, every ${opts.spamMs}ms (click the window center + T), until the deadline...`);
  while (Date.now() < deadline) {
    if (stopRequested()) return 'stop';
    if (await checkFailSafe(state)) return 'corner';

    const win = findRoblox();
    if (!win) {
      log('[SPAM] Roblox window is gone -> stop spam, the next cycle will relaunch');
      return 'no-window';
    }

    const fg = wm.getForegroundWindow();
    if (fg !== win.hwnd) {
      const res = await wm.activateWindow({ hwnd: win.hwnd }, { retries: 2 });
      if (!res.success) {
        fails++;
        log(`[SPAM] activate failed (${fails}/5): ${res.reason}`);
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

    // do not click when the window center is covered by another window
    const at = wm.windowAtPoint(cx, cy);
    if (at && at.pid !== win.pid) {
      const res = await wm.activateWindow({ hwnd: win.hwnd }, { retries: 1 });
      if (res.success) await sleepMs(250);
      const at2 = wm.windowAtPoint(cx, cy);
      if (at2 && at2.pid !== win.pid) {
        await sleepMs(400);
        continue; // still covered -> skip this tick, do NOT click the other window
      }
    }

    try {
      await backend.moveTo(cx, cy);
      await sleepMs(25);
      await backend.click('left');
      await backend.pressKey(resolveKeyName('T'));
      ticks++;
      if (ticks % 60 === 0) log(`[SPAM] ${ticks} ticks...`);
    } catch (err) {
      log(`[SPAM] input error: ${err.message || err}`);
    }
    await sleepMs(opts.spamMs);
  }
  log(`[SPAM] finished after ${ticks} ticks`);
  return 'deadline';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    fs.rmSync(STOP_FILE, { force: true });
  } catch {
    /* ignore */
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

  let session = { sessionId: null, calls: 0 };
  if (config.provider === 'opencode') {
    session = loadSessionState();
    log(`session: ${session.sessionId || '(moi)'} | luot: ${session.calls}`);
    if (config.continueSession) await cleanupCuaSessions(session.sessionId);
  } else {
    log(`provider: openai | ${config.openai.baseUrl} | model: ${config.model}`);
  }

  let stop = false;
  const onSignal = (sig) => {
    log(`[${sig}] stopping as requested...`);
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
      // keep at least 2 minutes between screenshots
      if (state.lastShotAt) {
        const gap = state.lastShotAt + opts.interval - Date.now();
        if (gap > 0) await sleepMs(gap);
      }
      if (stop || stopRequested()) break;
      if (await checkFailSafe(state)) {
        log('*** EMERGENCY STOP: pointer is in the screen corner ***');
        break;
      }

      // crash check, plus a safety net when the menu stays stuck
      let win = findRoblox();
      if (!win) {
        state.lastRelaunchAt = Date.now();
        const pid = await runRelaunch('Roblox window is missing (crash?)');
        state.relaunchHint = relaunchHint(pid);
        state.staleMenu = 0;
      } else {
        if (state.robloxPid && win.pid !== state.robloxPid) {
          log(`Roblox pid changed ${state.robloxPid} -> ${win.pid} (relaunched recently)`);
          state.lastRelaunchAt = Date.now();
          state.staleMenu = 0;
          state.relaunchHint = '';
        }
        state.robloxPid = win.pid;
        const oldEnough = Date.now() - state.lastRelaunchAt > 150000;
        if (state.staleMenu >= 3 && oldEnough) {
          const pid = await runRelaunch(`menu stuck for ${state.staleMenu} cycles in a row`);
          state.relaunchHint = relaunchHint(pid);
          state.lastRelaunchAt = Date.now();
        }
      }

      // screenshot (every 2 minutes)
      state.step++;
      const img = await takeScreenShot();
      state.lastShotAt = Date.now();
      const deadline = state.lastShotAt + opts.interval;
      log(`[CYCLE ${state.step}] screenshot ${img.width}x${img.height} -> deadline ${now()}`);
      if (state.step === 1) await calibrate(img);
      acknowledgeReobserve();

      // vision call
      let inGame = false;
      try {
        const { actions, raw, durationMs, sessionId } = await ask({
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
        if (config.provider === 'opencode' && sessionId) {
          if (session.sessionId !== sessionId) {
            session.sessionId = sessionId;
            log(`session: ${sessionId}`);
          }
          session.calls++;
          if (session.calls >= config.rotateAfterCalls) {
            log(`reached ${config.rotateAfterCalls} calls -> rotate session`);
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
          log(`running ${rest.length} action(s): ${JSON.stringify(rest)}`);
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
        log(`LLM error: ${err.message || err}`);
      }

      // count how many cycles the menu has stayed up
      if (inGame) {
        state.staleMenu = 0;
        state.relaunchHint = '';
        log('[CYCLE] IN GAME -> start click+T spam');
        const r = await spamLoop(deadline, opts, state);
        if (r === 'corner') {
          log('*** EMERGENCY STOP: pointer is in the screen corner ***');
          break;
        }
        if (r === 'no-window' || r === 'activate-fail') state.lastRelaunchAt = Date.now();
      } else {
        state.staleMenu++;
        log(
          `[CYCLE] not in game (attempt ${state.staleMenu}) -> wait for the next cycle, no spam` +
            (state.relaunchHint ? ' (screenshot is ready for the model to look for Continue)' : '')
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
          log('*** EMERGENCY STOP: pointer is in the screen corner ***');
          break;
        }
      }
    } catch (error) {
      log(`loop error: ${error.message || error}`);
      await sleepMs(2000);
    }
  }

  try {
    fs.rmSync(STOP_FILE, { force: true });
  } catch {
    /* ignore */
  }
  log(`=== tloop ket thuc sau ${state.step} chu ky ===`);
}

main().catch((err) => {
  log(`LOI nghiem trong: ${err.stack || err.message}`);
  process.exit(1);
});
