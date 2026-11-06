import { takeScreenShot } from './capture.js';
import { prepareShot } from './grid.js';
import { diffFrames, formatDiff, checkPoints, checkCursor } from './analyze.js';
import { ask, loadSessionState, saveSessionState, deleteSession, cleanupCuaSessions } from './brain.js';
import {
  executeActions,
  setCoordinateMap,
  acknowledgeReobserve,
  resetWindowGuard
} from './executor.js';
import { resolveBackend } from './backends.js';
import { createStagnationDetector } from './stagnation.js';
import * as wm from './windows.js';
import { screen, mouse, sleep } from '@nut-tree-fork/nut-js';
import { config, takeProviderFlag } from './config.js';

function parseArgs(argv) {
  const opts = { goal: [], steps: null, interval: null, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const providerFlag = takeProviderFlag(argv, i);
    if (providerFlag) {
      i += providerFlag - 1;
      continue;
    }
    if (a === '--steps') opts.steps = Number(argv[++i]);
    else if (a === '--interval') opts.interval = Number(argv[++i]);
    else if (a === '--model') config.model = argv[++i];
    else if (a === '--agent') config.agent = argv[++i];
    else if (a === '--backend') config.inputBackend = argv[++i];
    else if (a === '--dry-run') config.dryRun = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--no-continue') config.continueSession = false;
    else if (a === '--no-failsafe') config.failSafeCorner = false;
    else if (a === '--observe') opts.observe = true;
    else opts.goal.push(a);
  }
  opts.goal = opts.goal.join(' ').trim();
  return opts;
}

async function checkFailSafe(state) {
  if (!config.failSafeCorner) return false;
  const pos = await mouse.getPosition();
  const inCorner =
    pos.x <= config.failSafeCornerTolerancePx && pos.y <= config.failSafeCornerTolerancePx;

  if (inCorner) {
    if (!state.cornerSince) {
      state.cornerSince = Date.now();
      console.log('    !! Pointer is in the screen corner — hold still to STOP...');
    } else if (Date.now() - state.cornerSince >= config.failSafeCornerMs) {
      return true;
    }
  } else {
    if (state.cornerSince) console.log('    Pointer left the corner. Continuing.');
    state.cornerSince = null;
  }
  return false;
}

async function calibrate(img) {
  const screenW = await screen.width();
  const screenH = await screen.height();
  const scaleX = screenW / img.width;
  const scaleY = screenH / img.height;
  setCoordinateMap(scaleX, scaleY, img.width, img.height);
  return { screenW, screenH };
}

function foregroundText() {
  try {
    const f = wm.describeForeground();
    if (!f) return '(could not read the foreground window)';
    const fs = wm.isFullscreen(f.hwnd);
    const sc = wm.getScreenSize();
    return [
      `title=${f.title || '(no title)'}`,
      `hwnd=${f.hwnd} pid=${f.pid} proc=${f.processName || '?'} visible=${f.visible} minimized=${f.minimized}`,
      f.rect ? `rect=(${f.rect.left},${f.rect.top})-(${f.rect.right},${f.rect.bottom})` : '',
      `fullscreen=${fs ? 'YES (covering the screen, normal UI is NOT on screen)' : 'no'}`,
      `screen=${sc.width}x${sc.height} - image and click coordinates are absolute SCREEN pixels`
    ]
      .filter(Boolean)
      .join(' | ');
  } catch (err) {
    return `(foreground read failed: ${err.message})`;
  }
}

function windowListText() {
  try {
    return wm.formatWindowList({ max: 12 });
  } catch (err) {
    return `(window list failed: ${err.message})`;
  }
}

/** Foreground window rect. Used to warn the model when a click misses the target app. */
function foregroundRect() {
  try {
    const f = wm.describeForeground();
    return f && f.rect ? f.rect : null;
  } catch {
    return null;
  }
}

async function runLoop(opts) {
  const state = {
    cornerSince: null,
    lastAction: null,
    history: [],
    step: 0,
    session: null,
    frame: null, // previous PNG frame, used to compare the screen
    pendingMsgs: [], // pixel warnings from the previous step, sent to the model next
    lastPoint: null, // click or move point to check against the real cursor
    fgRect: null
  };
  const stagnation = createStagnationDetector({ limit: 3 });
  let lastBlocked = null;
  let lastBlockedReason = '';

  console.log('=== Computer Use Agent ===');
  console.log(`Goal: ${opts.goal || '(none)'}
Max steps: ${opts.steps || 'unlimited'} | Interval: ${opts.interval ?? config.intervalMs}ms
Dry-run: ${config.dryRun} | Provider: ${config.provider} | Corner failsafe: ${config.failSafeCorner}
`);
  if (config.provider === 'openai' && String(config.model).startsWith('opencode/')) {
    console.log('The model is still a CLI id. With --provider openai, set --model to the endpoint model.\n');
  }
  if (config.dryRun) console.log('*** DRY-RUN: print actions, do not click or type ***\n');

  resetWindowGuard();

  if (!config.dryRun) {
    console.log('[0] Starting the input backend...');
    await resolveBackend();
    console.log('');
  }

  state.session = { sessionId: null, calls: 0 };
  if (config.provider === 'opencode') {
    state.session = loadSessionState();
    console.log(
      `Shared session: ${state.session.sessionId || '(none yet, one will be created)'} | calls: ${state.session.calls}\n`
    );
    if (config.continueSession) await cleanupCuaSessions(state.session.sessionId);
  } else {
    console.log(`Endpoint: ${config.openai.baseUrl} | model: ${config.model}\n`);
  }

  let stop = false;
  const onSignal = (sig) => {
    console.log(`\n[${sig}] Stopping because the user asked...`);
    stop = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  while (!stop) {
    state.step++;
    try {
      if (await checkFailSafe(state)) {
        console.log('\n*** EMERGENCY STOP: pointer is in the screen corner ***');
        break;
      }

      console.log(`\n[1] Screenshot (step ${state.step})...`);

      // Raw PNG is for pixel analysis and an optional grid. A small JPG goes to the model.
      // Keep them separate: a 2.8MB PNG added about 19s per step; a 212KB JPG does not.
      const needPixels = config.pixelAnalysis || config.gridOverlay;
      const rawShot = needPixels ? await takeScreenShot({ format: 'png' }) : null;
      const prep = rawShot
        ? await prepareShot(rawShot.path, {
            grid: config.gridOverlay,
            step: config.gridStep,
            quant: config.gridQuant
          })
        : { path: null, frame: null, width: 0, height: 0 };

      let img;
      if (config.gridOverlay && prep.frame) {
        img = { path: prep.path, width: prep.width, height: prep.height, grid: true };
      } else {
        img = { ...(await takeScreenShot()), grid: false };
      }
      console.log(`    -> ${img.path} (${img.width}x${img.height})${img.grid ? ' [coordinate grid]' : ''}`);

      if (state.step === 1) await calibrate(img);

      // a new shot counts as the required look after a window action
      acknowledgeReobserve();

      // Pixel analysis of what the previous chain actually did.
      const analysisMsgs = [];
      if (config.pixelAnalysis && state.frame && prep.frame) {
        const t = formatDiff(diffFrames(state.frame, prep.frame));
        if (t) analysisMsgs.push(t);
      }
      if (state.pendingMsgs.length) {
        analysisMsgs.push(...state.pendingMsgs);
        state.pendingMsgs = [];
      }
      const analysisText = analysisMsgs.join('\n');
      state.frame = prep.frame;
      state.fgRect = foregroundRect();

      const fgText = foregroundText();
      const winText = windowListText();
      const stagMsg = stagnation.message();
      console.log(`    Foreground: ${fgText}`);
      if (stagMsg) console.log(`    [WINDOW] STAGNATION DETECTED: ${stagMsg}`);
      if (analysisText) {
        console.log('    [PIXEL] Analysis sent to the model:');
        for (const line of analysisText.split('\n')) console.log(`      - ${line}`);
      }

      console.log('[2] Sending the image to the agent...');
      const { actions, raw, durationMs, sessionId } = await ask({
        goal: opts.goal,
        step: state.step,
        img,
        history: {
          lastAction: state.lastAction,
          foreground: fgText,
          windows: winText,
          stagnation: stagMsg,
          analysis: analysisText,
          blocked: lastBlocked ? `${lastBlocked} - ${lastBlockedReason}` : ''
        },
        sessionId: state.session.sessionId,
        title: state.session.sessionId ? null : 'CUA Agent'
      });
      if (config.provider === 'opencode' && sessionId) {
        if (state.session.sessionId !== sessionId) {
          state.session.sessionId = sessionId;
          console.log(`    Shared session: ${sessionId}`);
        }
        state.session.calls++;
        if (state.session.calls >= config.rotateAfterCalls) {
          console.log(
            `    Reached ${config.rotateAfterCalls} calls. Rotating: delete the old session and start a new one.`
          );
          await deleteSession(state.session.sessionId);
          state.session = { sessionId: null, calls: 0 };
        }
        saveSessionState(state.session);
      }
      // Print the actions only, not the model's screen commentary.
      const parseFailed = actions.length === 1 && actions[0]._parseFailed;
      const shown = parseFailed ? `(could not parse) ${raw.replace(/\s+/g, ' ').slice(0, 200)}` : JSON.stringify(actions);
      console.log(`    Reply (${(durationMs / 1000).toFixed(1)}s): ${shown}`);

      let queue = actions;
      if (opts.observe) {
        const before = queue.length;
        queue = queue.filter((a) => a.action !== 'done' && a.action !== 'finish');
        if (queue.length < before) console.log('    (observe mode) ignored done and kept watching.');
      }
      // Check whether click points are inside the screen and the target window.
      if (config.pixelAnalysis && prep.frame) {
        const pts = [];
        let last = null;
        for (const a of queue) {
          if ((a.action === 'click' || a.action === 'move') && typeof a.x === 'number') {
            pts.push({ x: a.x, y: a.y });
            last = { x: a.x, y: a.y };
          } else if (a.action === 'drag' && a.from && a.to) {
            pts.push(a.from, a.to);
            last = { x: a.to.x, y: a.to.y };
          }
        }
        const warns = checkPoints(pts, {
          rect: state.fgRect,
          width: prep.width || img.width,
          height: prep.height || img.height
        });
        for (const w of warns) console.log(`    [PIXEL] ${w}`);
        state.pendingMsgs.push(...warns);
        state.lastPoint = last;
      }

      console.log(`[3] Chain of ${queue.length} action(s):`, JSON.stringify(queue));

      if (queue.some((a) => a._parseFailed)) {
        console.log('    Warning: could not parse JSON, falling back to wait.');
      }

      console.log('[4] Running the chain...');
      const result = await executeActions(queue);

      // Did the pointer actually land on the clicked point? Catches a bad coordinate map.
      if (config.pixelAnalysis && !config.dryRun && state.lastPoint) {
        try {
          const pos = await mouse.getPosition();
          const msg = checkCursor({ x: pos.x, y: pos.y }, state.lastPoint);
          if (msg) {
            console.log(`    [PIXEL] ${msg}`);
            state.pendingMsgs.push(msg);
          }
        } catch {
          /* could not read the pointer position */
        }
      }
      state.lastPoint = null;

      state.lastAction = JSON.stringify(queue);
      state.history.push({ step: state.step, action: state.lastAction, result });
      if (state.history.length > 5) state.history.shift();

      const repeats = stagnation.push(queue);
      if (repeats >= 3) {
        console.log(
          `    [WINDOW] STAGNATION DETECTED: the chain just ran has repeated ${repeats} times in a row.`
        );
      }
      if (result.blocked) {
        lastBlocked = result.blocked;
        lastBlockedReason = result.blockReason || '';
        console.log(`    [WINDOW] STATUS: ${result.blocked} - ${lastBlockedReason}`);
      } else if (!result.reobserve) {
        lastBlocked = null;
        lastBlockedReason = '';
      }
      if (result.reobserve) {
        console.log('    [WINDOW] REOBSERVE_REQUIRED: the next step captures a new image before input.');
      }

      if (result.done) {
        console.log('\n*** AGENT REPORTS THE GOAL IS DONE ***');
        break;
      }
    } catch (error) {
      console.error('    Loop error:', error.message || error);
    }

    if (stop) break;
    if (opts.once) {
      console.log('\n--once: stopped after 1 step.');
      break;
    }
    if (opts.steps && state.step >= opts.steps) {
      console.log(`\nReached the limit of ${opts.steps} steps.`);
      break;
    }

    const waitMs = opts.interval ?? config.intervalMs;
    console.log(`Waiting ${waitMs / 1000}s for the next cycle...`);
    await sleep(waitMs);
  }

  console.log(`\nFinished after ${state.step} steps.`);
}

const opts = parseArgs(process.argv.slice(2));
runLoop(opts).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
