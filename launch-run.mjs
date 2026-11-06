import { spawn } from 'node:child_process';
import { readFileSync, openSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const goalFile = process.argv[2] || 'goal.txt';
const steps = process.argv[3] || '16';
const interval = process.argv[4] || '4000';

const goal = readFileSync(join(dir, goalFile), 'utf8').replace(/\s+/g, ' ').trim();

const logPath = join(dir, 'run.log');
const errPath = join(dir, 'run.err.log');
rmSync(logPath, { force: true });
rmSync(errPath, { force: true });
const out = openSync(logPath, 'a');
const err = openSync(errPath, 'a');

const child = spawn(
  process.execPath,
  ['index.js', goal, '--steps', steps, '--interval', interval],
  { cwd: dir, detached: true, stdio: ['ignore', out, err] }
);
child.unref();
console.log('launched pid=' + child.pid + ' goal=' + goalFile + ' steps=' + steps);
