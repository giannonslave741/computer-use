// CLI: node run_actions.mjs actions.json  (hoac JSON string)
// Tu dong chup anh + acknowledgeReobserve khi bi REOBSERVE_REQUIRED.
import fs from 'node:fs';
import { executeActions } from './executor.js';
import { takeScreenShot } from './capture.js';
import { acknowledgeReobserve } from './executor.js';

const arg = process.argv[2];
if (!arg) {
  console.error('thieu JSON action (file path hoac JSON string)');
  process.exit(1);
}
let json = arg;
if (fs.existsSync(arg)) json = fs.readFileSync(arg, 'utf8');
let actions;
try {
  actions = JSON.parse(json);
} catch (e) {
  console.error('JSON loi: ' + e.message);
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
      console.log(`    [REOBSERVE] da chup ${shot.path} -> chay tiep ${actions.length} hanh dong`);
      acknowledgeReobserve();
      continue;
    }
    done = !!(res && res.done);
    reason = (res && res.reason) || '';
    console.log('DONE ' + JSON.stringify(res));
    break;
  } catch (e) {
    console.error('ACTION LOI: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }
}
process.exit(0);
