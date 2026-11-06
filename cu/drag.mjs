// cu/drag.mjs — drag with intermediate steps so Qt receives mouseMove.
//   node drag.mjs <x1> <y1> <x2> <y2> [left|middle] [steps]
import { createRequire } from 'module';
const require = createRequire('D:/computer use/package.json');
const { mouse, Button, Point } = require('@nut-tree-fork/nut-js');
import { sleep } from '@nut-tree-fork/nut-js';

const [x1, y1, x2, y2] = process.argv.slice(2, 6).map(Number);
const btn = (process.argv[6] || 'left').toLowerCase();
const steps = Number(process.argv[7] || 14);
const button = btn === 'middle' ? Button.MIDDLE : Button.LEFT;

await mouse.setPosition(new Point(x1, y1));
await sleep(80);
await mouse.pressButton(button);
await sleep(80);
for (let i = 1; i <= steps; i++) {
  const x = Math.round(x1 + ((x2 - x1) * i) / steps);
  const y = Math.round(y1 + ((y2 - y1) * i) / steps);
  await mouse.setPosition(new Point(x, y));
  await sleep(18);
}
await sleep(80);
await mouse.releaseButton(button);
console.log(`dragged ${btn} (${x1},${y1}) -> (${x2},${y2}) in ${steps} steps`);
