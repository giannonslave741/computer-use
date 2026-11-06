// cu/click.mjs — click tại tọa độ: node click.mjs X Y [dbl|right]
import { resolveBackend } from '../backends.js';
import { sleep } from '@nut-tree-fork/nut-js';

const [x, y, mode] = process.argv.slice(2);
const b = await resolveBackend();
await b.moveTo(parseFloat(x), parseFloat(y));
await sleep(150);
await b.click(mode === 'right' ? 'right' : 'left', mode === 'dbl');
await sleep(120);
console.log(`clicked (${x},${y}) ${mode || ''}`);
