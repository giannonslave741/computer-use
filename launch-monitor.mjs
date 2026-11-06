import { spawn } from 'node:child_process';
import { readFileSync, openSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const goal = readFileSync(join(dir, 'goal.txt'), 'utf8').replace(/\s+/g, ' ').trim();

const logPath = join(dir, 'monitor.log');
const errPath = join(dir, 'monitor.err.log');
rmSync(logPath, { force: true });
rmSync(errPath, { force: true });
const out = openSync(logPath, 'a');
const err = openSync(errPath, 'a');

const child = spawn(
  process.execPath,
  ['index.js', goal, '--interval', '600000', '--observe'],
  { cwd: dir, detached: true, stdio: ['ignore', out, err] }
);
child.unref();
console.log('monitor launched, pid=' + child.pid);
