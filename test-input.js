import { mouse, screen, sleep } from '@nut-tree-fork/nut-js';
import { config } from './config.js';
import { resolveBackend } from './backends.js';

const args = process.argv.slice(2);
for (const a of args) {
  if (a.startsWith('--backend=')) config.inputBackend = a.split('=')[1];
}
const noType = args.includes('--no-type');

if (args.includes('--devices')) {
  const { init, listDevices } = await import('./interception.js');
  try {
    init();
    console.table(listDevices());
  } catch (err) {
    console.error('Could not list devices:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

const backend = await resolveBackend();
console.log(`Backend in use: ${backend.name}`);
if (backend.name === 'nutjs') {
  console.log('  -> The Interception driver is not running, so input goes through SendInput.');
  console.log('     Install the driver:  npm run setup-driver   (requires Administrator)');
}
console.log('');

const cur = async () => {
  const p = await mouse.getPosition();
  return `(${p.x}, ${p.y})`;
};

const step = async (label, fn) => {
  process.stdout.write(`  ${label} ... `);
  try {
    await fn();
    console.log('OK');
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
};

console.log('In the next 6 seconds:');
console.log('  1. Open Notepad and drag the window to the CENTER of the screen.');
console.log('  2. Click the Notepad editing area.');
console.log('  3. Do not touch the mouse or keyboard until the script finishes.');
console.log('');
for (let i = 6; i > 0; i--) {
  process.stdout.write(`  ... ${i}\r`);
  await sleep(1000);
}
console.log('');

const width = await screen.width();
const height = await screen.height();
const cx = Math.round(width / 2);
const cy = Math.round(height / 2);

await step(`move the mouse to the center (${cx}, ${cy})`, async () => {
  await backend.moveTo(cx, cy);
  await sleep(150);
  console.log(`\n      actual cursor: ${await cur()}`);
});

await step('left click', async () => {
  await backend.click('left', false);
  await sleep(150);
  console.log(`\n      actual cursor: ${await cur()}`);
});

if (!noType) {
  await step('type "cua-test 123"', async () => {
    await backend.typeText('cua-test 123');
    await sleep(200);
  });
  await step('press Enter', async () => {
    await backend.pressKey('enter');
    await sleep(150);
  });
  await step('press x', async () => {
    await backend.pressKey('x');
    await sleep(150);
  });
  await step('hotkey Ctrl+A', async () => {
    await backend.hotkey(['control', 'a']);
    await sleep(200);
  });
  await step('press End (clear the selection)', async () => {
    await backend.pressKey('end');
    await sleep(150);
  });
} else {
  console.log('  (typing skipped because of --no-type)');
}

await step('scroll down 3 notches, then up 3', async () => {
  await backend.scroll('down', 3);
  await sleep(200);
  await backend.scroll('up', 3);
  await sleep(200);
});

await step('move the mouse to the corner (60, 60)', async () => {
  await backend.moveTo(60, 60);
  await sleep(150);
  console.log(`\n      actual cursor: ${await cur()}`);
});

console.log('');
if (backend.name === 'interception') {
  console.log('If "cua-test 123" appears in Notepad and the mouse moved correctly, Interception is working.');
  console.log('If the mouse is in the wrong place or typing does not appear, change the devices in config.interception (keyboard/mouse).');
} else {
  console.log('Using nut-js (SendInput). Install the driver and run again: npm run setup-driver && npm run test-input');
}
process.exit(0);
