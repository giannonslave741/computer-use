// cu/wheel.mjs — cuộn chuột tại toạ độ (test zoom canvas).
//   node wheel.mjs <x> <y> <up|down> [notches]
import { createRequire } from 'module';
const require = createRequire('D:/computer use/package.json');
const { mouse, Point } = require('@nut-tree-fork/nut-js');

const [x, y] = process.argv.slice(2, 4).map(Number);
const dir = (process.argv[4] || 'up').toLowerCase();
const n = Number(process.argv[5] || 3);
await mouse.setPosition(new Point(x, y));
for (let i = 0; i < n; i++) {
  if (dir === 'down') await mouse.scrollDown(1);
  else await mouse.scrollUp(1);
  await new Promise((r) => setTimeout(r, 60));
}
console.log(`wheel ${dir} x${n} at (${x},${y})`);
