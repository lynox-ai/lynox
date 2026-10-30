/**
 * A real process that starts a local `bash` call, waits until the command's background job
 * runs, checks it is alive, and exits while the call still runs. Used by bash-exit.test.ts.
 * argv: <pid file>
 */
import { existsSync, readFileSync } from 'node:fs';
import { bashTool } from '../../src/tools/builtin/bash.js';

const pidFile = process.argv[2]!;
// A process in local mode (`shell-isolation.ts`): the command runs here.
const LOCAL = { toolContext: { shellIsolation: { kind: 'local' } } } as never;
void bashTool.handler({ command: `sleep 30 & echo $! > ${pidFile}; wait` }, LOCAL).catch(() => {});
const poll = setInterval(() => {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf-8').trim());
  if (!(pid > 0)) return;
  clearInterval(poll);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  process.stdout.write(`${String(pid)} ${alive ? 'alive' : 'gone'}\n`);
  process.exit(0);
}, 20);
