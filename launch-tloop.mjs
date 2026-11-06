// Launcher for tloop: run detached, log to tloop.log / tloop.err.log.
// Run: node launch-tloop.mjs [--interval 120000] [--spam-ms 500] [--dry-run] ...
import { spawn } from 'node:child_process';
import { openSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(dir, 'tloop.log');
const errPath = path.join(dir, 'tloop.err.log');

rmSync(errPath, { force: true });
const out = openSync(logPath, 'a');
const err = openSync(errPath, 'a');

const child = spawn(process.execPath, ['tloop.mjs', ...process.argv.slice(2)], {
  cwd: dir,
  detached: true,
  stdio: ['ignore', out, err]
});
child.unref();

console.log(`tloop started, pid=${child.pid}`);
console.log(`Log: ${logPath} | Error log: ${errPath}`);
console.log('Stop: npm run tloop:stop  (creates stop-tloop.flag)');
