import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { execa } from 'execa';
import { config } from './config.js';

let cachedCmd;

function findRealExeFromShim(shimPath) {
  try {
    const content = fs.readFileSync(shimPath, 'utf8');
    const match = content.match(/"([^"]+\.exe)"/i);
    if (match && fs.existsSync(match[1])) return match[1];
  } catch {
    /* ignore */
  }
  return null;
}

function resolveVisionCmd() {
  if (cachedCmd) return cachedCmd;
  const explicit = config.visionCmd;
  if (explicit && explicit !== 'opencode') {
    cachedCmd = explicit;
    return cachedCmd;
  }

  try {
    const out = execSync('where opencode', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    const exe = lines.find((s) => s.toLowerCase().endsWith('.exe') && fs.existsSync(s));
    if (exe) {
      cachedCmd = exe;
      return cachedCmd;
    }
    for (const line of lines) {
      if (line.toLowerCase().endsWith('.cmd') || line.toLowerCase().endsWith('.bat')) {
        const real = findRealExeFromShim(line);
        if (real) {
          cachedCmd = real;
          return cachedCmd;
        }
      }
    }
  } catch {
    /* where failed -> try the default candidates */
  }

  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'opencode', 'opencode.exe'),
    'C:\\Program Files\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe'
  ];
  cachedCmd = candidates.find((c) => c && fs.existsSync(c)) || 'opencode';
  return cachedCmd;
}

const SESSION_FILE = path.join(process.cwd(), config.sessionFile);

export function loadSessionState() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return { sessionId: data.sessionId || null, calls: Number(data.calls) || 0 };
  } catch {
    return { sessionId: null, calls: 0 };
  }
}

export function saveSessionState(state) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}

async function cli(args) {
  return execa(resolveVisionCmd(), args, {
    reject: false,
    timeout: 60000,
    windowsHide: true,
    cwd: process.cwd()
  });
}

export async function deleteSession(sessionId) {
  if (!sessionId) return false;
  const r = await cli(['session', 'delete', sessionId]);
  if (r.exitCode === 0) console.log(`    Deleted old session: ${sessionId}`);
  return r.exitCode === 0;
}

export async function listSessions() {
  const r = await cli(['session', 'list']);
  if (r.exitCode !== 0) return [];
  const sessions = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(ses_\S+)\s+(.*?)\s{2,}\S/);
    if (m) sessions.push({ id: m[1], title: m[2].trim() });
  }
  return sessions;
}

export async function cleanupCuaSessions(keepId) {
  const sessions = await listSessions();
  let removed = 0;
  for (const s of sessions) {
    if (s.title.startsWith('CUA') && s.id !== keepId) {
      const r = await cli(['session', 'delete', s.id]);
      if (r.exitCode === 0) {
        removed++;
        console.log(`    Removed extra CUA session: ${s.id} (${s.title.slice(0, 40)})`);
      }
    }
  }
  if (removed) console.log(`    Cleaned ${removed} extra CUA session(s).`);
  return removed;
}

export function buildPrompt({ goal, step, img, history }) {
  const gridNote = img.grid
    ? `\n\nTHIS IMAGE HAS A COORDINATE GRID: numbers on the TOP edge are x, numbers on the LEFT edge are y, each cell is ${config.gridStep}px.\nDo NOT guess by eye (that misses by hundreds of px). Read the two grid numbers next to the target and interpolate inside that ${config.gridStep}px cell.`
    : '';
  return `You are a computer-use agent controlling a machine from a screenshot (${img.width}x${img.height} pixels, top-left is 0,0).${gridNote}

GOAL: ${goal || 'No goal yet. Observe and wait.'}
Step: ${step}
Previous action chain: ${history.lastAction || 'none'}

CURRENT FOREGROUND WINDOW (from the Windows API, not a guess):
${history.foreground || '(unavailable)'}

OPEN WINDOWS:
${history.windows || '(unavailable)'}

${history.analysis ? `AUTOMATIC PIXEL ANALYSIS (measured from pixels, not a guess — trust it and follow it):\n${history.analysis}\n` : ''}
${history.stagnation ? `STAGNATION WARNING:\n${history.stagnation}\n` : ''}
${history.blocked ? `PREVIOUS WINDOW ERROR:\n${history.blocked}\n(The window was not activated, so the executor is blocking input. Find the right window with window_list, then window_activate again. Do NOT click coordinates.)\n` : ''}
=========================================================
WINDOW RULES — READ THESE BEFORE ANY COORDINATE RULE
=========================================================

RULE 0 — WINDOW FIRST
Before click/type/press/hotkey into a specific application:
  - Identify which window is the target.
  - If that window is not in the foreground, or you are not sure it is on top:
    do NOT click coordinates. Use window_activate first.
  - After window_activate / window_restore / show_desktop / window_minimize:
    look at a NEW screenshot, then compute coordinates.

RULE 1 — DO NOT CLICK THROUGH A WINDOW
"A screen click always hits the window that is ON TOP at that coordinate,
not the window you can see behind it."
The screenshot shows the foreground window most clearly.
If Chrome is in front and the goal belongs to Explorer behind it:
  WRONG: [{"action":"click","x":500,"y":350}]
  RIGHT: [{"action":"window_activate","target":"File Explorer"}]
        -> new screenshot -> [{"action":"click","x":...,"y":...}]

RULE 2 — ACTIVATE BEFORE INPUT
If the target application is not in the foreground, window_activate first.
Order of preference:
  1. window_activate (Windows API, exact HWND)
  2. window_restore (the window is minimized)
  3. taskbar_activate (ONLY when window_activate cannot find the window)
  4. click the taskbar icon (ONLY when there is no valid HWND — last resort)

RULE 3 — LOOK AGAIN AFTER ACTIVATION
Do NOT put window_activate and click in the SAME array.
Valid sequence:
  step A: [{"action":"window_activate","target":"File Explorer"}]
  -> new screenshot ->
  step B: [{"action":"click","x":...,"y":...}]
(The executor DROPS click/type/press actions that follow a window_* action in the same array
 and returns REOBSERVE_REQUIRED.)

RULE 4 — DESKTOP
If the goal is the desktop background, a desktop icon, or the desktop right-click menu:
  - If windows cover the desktop: [{"action":"show_desktop"}] first.
  - Screenshot again, then compute desktop coordinates, then click.
  - Never take desktop coordinates from a shot that is still covered by a window.

RULE 5 — DO NOT HUNT THE TASKBAR
Do not search the taskbar if the target window exists and window_activate can raise it.
The taskbar is only a FALLBACK when the window manager cannot find the window.

RULE 6 — VERIFY
Do not treat activation as success when foreground verification fails.
If the result contains "blocked": "WINDOW_ACTIVATE_FAILED" or "FOREGROUND_CHANGED":
  look at the screen again, recheck the target window, and do NOT click the old coordinates.

RULE 7 — DO NOT REPEAT A BLIND CLICK
If a click did not change the screen, do not spam the same coordinate.
Instead: window_list -> identify the window -> window_activate -> new screenshot.

RULE 8 — CLICK THE FIELD BEFORE TYPING
Any chain that types into a field (search box, chat box, address bar):
  - MUST click THAT field in the SAME chain, and the click must come BEFORE type.
  - WRONG: [{"action":"type","text":"lofi"}]
  - RIGHT: [{"action":"click","x":740,"y":355},{"action":"type","text":"lofi"},{"action":"press","key":"ENTER"}]
  - If the field already has text:
    [{"action":"click","x":...},{"action":"hotkey","keys":["CTRL","A"]},{"action":"type","text":"..."},{"action":"press","key":"ENTER"}]
    so the new text does not append to the old text.
  - If the screen does not change after typing, click the field again at a NEW coordinate from the screenshot, then type. Do not type into empty space and do not repeat the same chain.

RULE 8b — USE THE SEARCH BOX
On pages that have a search box (YouTube, Google, and similar):
  - Type into the search box to find content.
  - Do NOT keep scrolling the page to hunt for content. Scroll only to see what is already on screen.
  - "Find a song / video / product" means: click the search box -> type -> ENTER.

RULE 9 — FULLSCREEN VIDEO OR A GAME COVERING THE SCREEN
When the foreground line says "fullscreen=YES", or the image has no address bar, tab strip, title bar, or app taskbar:
  - The app is covering the screen. Normal UI (search box, new-tab button, menus) is not on screen, so clicking will not find it.
  - Leave fullscreen first: [{"action":"press","key":"ESC"}]
    (a browser may also use [{"action":"press","key":"F11"}]).
  - Screenshot again. Continue only when the address bar or search box is visible.
  - Do NOT double-click video or content: that turns fullscreen on (or pauses). Double-click only a window title bar to maximize or restore.
  - If the UI is still missing, window_activate again and screenshot. Do not click at random.

RULE 10 — TRUST THE PIXEL ANALYSIS
The system measures pixels. If that section says:
  - "Screen AFTER the chain: almost unchanged" -> the chain did nothing.
    Do not repeat it. Aim at a different point, or window_activate -> screenshot -> try again.
  - "changed region: (a,b)-(c,d)" -> look at THAT region.
  - "POINT (x,y) IS OUTSIDE THE FOREGROUND WINDOW / OUTSIDE THE SCREEN" -> the coordinate is wrong.
  - "ACTUAL CURSOR IS AT (a,b), NOT (x,y)" -> the click did not land where you thought.

COORDINATES ARE ABSOLUTE SCREEN PIXELS
The shot is the full screen (WxH). 0,0 is the top-left of the SCREEN, not of a window.
Do not add or subtract the window rect. Read the pixel coordinate on the image.

EXECUTOR STATUSES (do not repeat the same mistake):
  WINDOW_ACTIVATE_FAILED  : the window was not found or not activated -> search differently
  REOBSERVE_REQUIRED      : a window action ran -> look at a new screenshot
  FOREGROUND_CHANGED      : the target window changed before input -> activate again
  STAGNATION              : the same action chain repeated -> change strategy
  TASKBAR_ACTIVATE_FAILED : the taskbar fallback also failed -> use window_list

THREE REQUIRED RULES:

1) ACCURATE COORDINATES
- Click the center of the target (center of a button, field, or tab).
- Center = top-left edge plus half the width and half the height of the object.
- The point MUST be inside the object and inside 0..${img.width - 1} x 0..${img.height - 1}. Do not click the border, empty space, or dead area.

2) BATCH ACTIONS THAT DO NOT NEED A NEW LOOK
- If the later steps do not need a new screenshot (click a search box -> type -> Enter, or click the address bar -> type -> Enter), return ONE array and run it immediately.
- If you need to see the result (a menu opened, a page changed, a load), return an array with a single action.

3) STRICT JSON ONLY
- Return ONLY one JSON array that starts with [ and ends with ].
- No conversation, no explanation, no markdown, no coordinate essay, no text outside the array.
- Do NOT summarize the screen or describe what you see. The caller only needs the actions.
- The "reason" on done/finish is at most 15 words.

VALID SHAPES:
[{"action":"click","x":500,"y":300,"button":"left"}]
[{"action":"click","x":410,"y":60},{"action":"type","text":"youtube"},{"action":"press","key":"ENTER"}]
[{"action":"type","text":"text to type"}]
[{"action":"press","key":"ENTER"}]
[{"action":"hold","key":"W","ms":2000}]
[{"action":"hotkey","keys":["CTRL","L"]}]
[{"action":"scroll","direction":"down","amount":3}]
[{"action":"drag","from":{"x":100,"y":100},"to":{"x":400,"y":300}}]
[{"action":"wait","ms":1500}]
[{"action":"done","reason":"goal finished"}]

WINDOW ACTION EXAMPLES:
[{"action":"window_list"}]
[{"action":"window_activate","target":"File Explorer"}]
[{"action":"window_activate","target":"Notepad"}]
[{"action":"window_activate","target":{"process":"chrome.exe"}}]
[{"action":"window_activate","target":{"hwnd":655890}}]
[{"action":"window_restore","target":"Roblox"}]
[{"action":"window_minimize","target":"Google Chrome"}]
[{"action":"show_desktop"}]
[{"action":"taskbar_activate","target":"Notepad"}]

"target" may be a free string ("File Explorer", "Notepad", "Chrome"),
a file name ("explorer.exe", "notepad.exe"), or an object {hwnd} / {pid} / {process} / {title} / {titleContains}.
Do not mix window actions with click/type/press in the same array.

"button" is only needed when it is not left (left/right/middle). "double":true for a double-click.
"hold" keeps a key down for "ms" and then releases it (move a game character with W/A/S/D).
Nothing to do yet: [{"action":"wait","ms":1500}]
Goal complete: [{"action":"done","reason":"..."}]`;
}

function parseEvents(stdout) {
  const texts = [];
  let sessionId = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type === 'text' && evt.part?.text) texts.push(evt.part.text);
      if (evt.sessionID) sessionId = evt.sessionID;
    } catch {
      /* skip lines that are not JSON */
    }
  }
  return { texts, sessionId };
}

function repairJson(candidate) {
  const quotedKeys = candidate.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  const singleToDouble = quotedKeys.replace(/'/g, '"');
  return JSON.parse(singleToDouble);
}

const KNOWN_ACTIONS = new Set([
  'click',
  'move',
  'type',
  'press',
  'hold',
  'hotkey',
  'scroll',
  'drag',
  'wait',
  'done',
  'finish',
  'window_list',
  'window_activate',
  'window_restore',
  'window_minimize',
  'show_desktop',
  'taskbar_activate'
]);

// Window-state actions. The next step must look at a fresh screenshot.
export const WINDOW_STATE_ACTIONS = new Set([
  'window_activate',
  'window_restore',
  'window_minimize',
  'show_desktop',
  'taskbar_activate'
]);

// Input actions. They run only when the target window is in the foreground.
export const INPUT_ACTIONS = new Set(['click', 'move', 'type', 'press', 'hold', 'hotkey', 'scroll', 'drag']);

const MAX_CHAIN = 5;

function scanBalanced(text, open, close) {
  const candidates = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== open) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function parseLoose(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return repairJson(raw);
  }
}

function validateActions(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (!KNOWN_ACTIONS.has(item.action)) continue;
    out.push(item);
    if (out.length >= MAX_CHAIN) break;
  }
  return out;
}

export { validateActions as validateActionsForTest };

export function findActions(text) {
  for (const raw of scanBalanced(text, '[', ']')) {
    try {
      const actions = validateActions(parseLoose(raw));
      if (actions.length) return actions;
    } catch {
      /* this candidate is invalid, try the next one */
    }
  }
  for (const raw of scanBalanced(text, '{', '}')) {
    try {
      const actions = validateActions(parseLoose(raw));
      if (actions.length) return actions;
    } catch {
      /* this candidate is invalid, try the next one */
    }
  }
  return null;
}

export async function askModel({ goal, step, img, history, sessionId = null, title = null }) {
  const cmd = resolveVisionCmd();
  const prompt = buildPrompt({ goal, step, img, history });

  const makeArgs = (sid) => {
    const args = ['run', '--format', 'json'];
    if (config.model) args.push('-m', config.model);
    if (config.agent) args.push('--agent', config.agent);
    if (sid && config.continueSession) args.push('-s', sid);
    else if (title && config.continueSession) args.push('--title', title);
    if (img.path) args.push('-f', img.path);
    return args;
  };

  const run = (args) =>
    execa(cmd, args, {
      reject: false,
      timeout: config.requestTimeoutMs,
      windowsHide: true,
      cwd: process.cwd(),
      input: prompt,
      env: { ...process.env, FORCE_COLOR: '0' }
    });

  const started = Date.now();
  let result = await run(makeArgs(config.continueSession ? sessionId : null));

  if (
    result.exitCode !== 0 &&
    sessionId &&
    config.continueSession &&
    /session|not found|invalid/i.test(result.stderr || '')
  ) {
    console.log(`    Session ${sessionId} cannot be continued, starting a new one...`);
    result = await run(makeArgs(null));
  }

  const durationMs = Date.now() - started;
  const { texts, sessionId: sid } = parseEvents(result.stdout || '');
  const text = texts.join('\n');

  if (result.exitCode !== 0 && !text) {
    const err = (result.stderr || result.stdout || '').trim().slice(-500);
    throw new Error(`Vision command failed (exit ${result.exitCode}): ${err || 'no output'}`);
  }

  const action = findActions(text) || [{ action: 'wait', ms: 2000, _parseFailed: true }];
  return { actions: action, raw: text, durationMs, sessionId: sid || sessionId };
}

export async function ask(opts) {
  if (config.provider === 'openai') {
    const { askOpenai } = await import('./providers/openai.js');
    return askOpenai(opts);
  }
  if (config.provider === 'opencode') return askModel(opts);
  throw new Error(`Unsupported provider: ${config.provider}`);
}
