/**
 * A local command runs in its own process group, so a Ctrl+C on the engine no longer reaches
 * it. When the engine exits, what is still running is killed — tested in a real child process
 * that exits while its `bash` call runs. The control is the child's own check that the job was
 * alive just before the exit.
 */
import { it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHILD = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'bash-exit-child.ts');

it('a command still running when the engine exits is killed with it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-exit-'));
  let pid = 0;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
    const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, join(dir, 'pid')], { env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    const [p, state] = r.stdout.trim().split(' ');
    pid = Number(p);
    expect(pid).toBeGreaterThan(0);
    expect(state, 'the job ran until the exit').toBe('alive');
    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      // A zombie (killed, not yet reaped) is not alive.
      if (alive) { try { alive = readFileSync(`/proc/${String(pid)}/stat`, 'utf-8').split(') ')[1]?.[0] !== 'Z'; } catch { /* keep */ } }
      expect(alive, 'the background sleep outlived the engine').toBe(false);
    }, { timeout: 2000 });
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
}, 25_000);
