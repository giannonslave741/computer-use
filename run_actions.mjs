// CLI: node run_actions.mjs actions.json  (or a JSON string)
// Takes a screenshot and calls acknowledgeReobserve when the result is REOBSERVE_REQUIRED.
import fs from 'node:fs';
import { executeActions } from './executor.js';
import { takeScreenShot } from './capture.js';
import { acknowledgeReobserve } from './executor.js';

const arg = process.argv[2];
if (!arg) {
  console.error('missing action JSON (file path or JSON string)');
  process.exit(1);
}
let json = arg;
if (fs.existsSync(arg)) json = fs.readFileSync(arg, 'utf8');
let actions;
try {
  actions = JSON.parse(json);
} catch (e) {
  console.error('invalid JSON: ' + e.message);
  process.exit(1);
}

let done = false;
let reason = '';
for (let attempt = 0; attempt < 4 && !done; attempt++) {
  try {
    const res = await executeActions(actions);
    if (res && res.blocked === 'REOBSERVE_REQUIRED') {
      const executed = Number(res.executed || 0);
      actions = actions.slice(executed);
      const shot = await takeScreenShot();
      console.log(`    [REOBSERVE] captured ${shot.path} -> continuing ${actions.length} action(s)`);
      acknowledgeReobserve();
      continue;
    }
    done = !!(res && res.done);
    reason = (res && res.reason) || '';
    console.log('DONE ' + JSON.stringify(res));
    break;
  } catch (e) {
    console.error('ACTION ERROR: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }
}
process.exit(0);
