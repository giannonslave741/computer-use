// cu/key.mjs — node key.mjs <key...> ; example: enter | control a
import { resolveBackend } from '../backends.js';
import { sleep } from '@nut-tree-fork/nut-js';

const parts = process.argv.slice(2);
const b = await resolveBackend();
if (parts.length > 1) {
  await b.hotkey(parts);
  console.log(`hotkey ${parts.join('+')}`);
} else {
  await b.pressKey(parts[0]);
  console.log(`key ${parts[0]}`);
}
await sleep(120);
