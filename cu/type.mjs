// cu/type.mjs — gõ text: node type.mjs <text...>
import { resolveBackend } from '../backends.js';
import { sleep } from '@nut-tree-fork/nut-js';

const text = process.argv.slice(2).join(' ');
const b = await resolveBackend();
await b.typeText(text);
await sleep(120);
console.log(`typed: ${text}`);
