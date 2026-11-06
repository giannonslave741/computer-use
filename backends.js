import { mouse, keyboard, Point, Button, sleep } from '@nut-tree-fork/nut-js';
import { config } from './config.js';
import { resolveNutKey } from './keys.js';
import * as interception from './interception.js';

const BUTTON_MAP = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE
};

function toButton(name) {
  const btn = BUTTON_MAP[String(name || 'left').toLowerCase()];
  if (btn === undefined) throw new Error(`Invalid mouse button: ${name}`);
  return btn;
}

const CLICK_GAP_MS = 25;
const DOUBLE_GAP_MS = 40;

const nutjsBackend = {
  name: 'nutjs',
  async moveTo(x, y) {
    await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
  },
  async click(button, double) {
    const btn = toButton(button);
    if (double) await mouse.doubleClick(btn);
    else await mouse.click(btn);
  },
  async setButton(button, down) {
    const btn = toButton(button);
    if (down) await mouse.pressButton(btn);
    else await mouse.releaseButton(btn);
  },
  async scroll(direction, amount) {
    if (direction === 'up') await mouse.scrollUp(amount);
    else await mouse.scrollDown(amount);
  },
  async typeText(text) {
    await keyboard.type(String(text ?? ''));
  },
  async pressKey(canonical) {
    const key = resolveNutKey(canonical);
    await keyboard.pressKey(key);
    await keyboard.releaseKey(key);
  },
  async keyDown(canonical) {
    await keyboard.pressKey(resolveNutKey(canonical));
  },
  async keyUp(canonical) {
    await keyboard.releaseKey(resolveNutKey(canonical));
  },
  async hotkey(canonicals) {
    await keyboard.hotkey(...canonicals.map(resolveNutKey));
  }
};

const interceptionBackend = {
  name: 'interception',
  async moveTo(x, y) {
    interception.moveTo(x, y);
  },
  async click(button, double) {
    interception.setButton(button, true);
    await sleep(CLICK_GAP_MS);
    interception.setButton(button, false);
    if (double) {
      await sleep(DOUBLE_GAP_MS);
      interception.setButton(button, true);
      await sleep(CLICK_GAP_MS);
      interception.setButton(button, false);
    }
  },
  async setButton(button, down) {
    interception.setButton(button, down);
  },
  async scroll(direction, amount) {
    interception.scroll(direction, amount);
  },
  async typeText(text) {
    const value = String(text ?? '');
    const ok = await interception.typeText(value);
    if (ok !== false) return;
    console.log('    [interception] could not map a character to a scan code -> falling back to nut-js for this text');
    await nutjsBackend.typeText(value);
  },
  async pressKey(canonical) {
    await interception.keyDown(canonical);
    await sleep(interception.keyHoldMs());
    await interception.keyUp(canonical);
  },
  async keyDown(canonical) {
    await interception.keyDown(canonical);
  },
  async keyUp(canonical) {
    await interception.keyUp(canonical);
  },
  async hotkey(canonicals) {
    for (const name of canonicals) await interception.keyDown(name);
    for (const name of [...canonicals].reverse()) await interception.keyUp(name);
  }
};

let cached = null;

export async function resolveBackend() {
  if (cached) return cached;

  const mode = config.inputBackend || 'auto';

  if (mode === 'nutjs') {
    cached = nutjsBackend;
    console.log('    Input backend: nut-js (SendInput)');
    return cached;
  }

  try {
    interception.init();
    const devices = await interception.pickDevices();
    cached = interceptionBackend;
    console.log(
      `    Input backend: INTERCEPTION (keyboard #${devices.keyboard}, mouse #${devices.mouse})`
    );
    for (const line of interception.messages()) console.log(`      - ${line}`);
  } catch (err) {
    if (mode === 'interception') {
      throw new Error(`inputBackend=interception but it failed to start: ${err.message}`);
    }
    console.log(`    Input backend: nut-js (SendInput) - Interception is not ready: ${err.message}`);
    cached = nutjsBackend;
  }

  return cached;
}

export function activeBackendName() {
  return cached ? cached.name : null;
}

process.on('exit', () => {
  try {
    interception.shutdown();
  } catch {
    /* ignore */
  }
});
