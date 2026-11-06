// cu/shot.mjs — capture the screen to PNG and print the mouse coordinate
import { createRequire } from 'module';
import { mouse } from '@nut-tree-fork/nut-js';
const require = createRequire('D:/computer use/package.json');
const screenshot = require('screenshot-desktop');
const out = process.argv[2] || 'D:/computer use/temp/latest.png';
await screenshot({ filename: out });
const p = await mouse.getPosition();
console.log(`saved ${out} (mouse ${p.x},${p.y})`);
