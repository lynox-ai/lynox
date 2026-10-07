/**
 * vitest started from `packages/web-ui` runs rune-module tests the way the repo root does, and a
 * run that compiles Svelte for the server says why it failed.
 *
 * Both halves spawn the real CLI on `svelte-compile-mode.svelte.test.ts`, the test that pins the
 * compile mode: once with the package's own `vitest.config.ts` (must pass, in the browser-compile
 * project), once with the package's `vite.config.ts` forced (must fail, naming the cause).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const pkg = join(root, 'packages', 'web-ui');
const vitestBin = join(root, 'node_modules', '.bin', 'vitest');
const TEST = 'src/lib/stores/svelte-compile-mode.svelte.test.ts';

// The child run gets a temp directory of its own, removed afterwards: inheriting this run's
// would leave the child's caches behind in it and count against this run's clean-up.
let childTmp = '';
beforeAll(() => { childTmp = mkdtempSync(join(tmpdir(), 'web-ui-pkg-vitest-')); });
afterAll(() => { if (childTmp) rmSync(childTmp, { recursive: true, force: true }); });

function runFromPackage(extra: string[]): { status: number | null; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', TMPDIR: childTmp };
  for (const k of Object.keys(env)) if (k.startsWith('VITEST') || k.startsWith('LYNOX_TEST')) delete env[k];
  const r = spawnSync(vitestBin, ['run', TEST, ...extra], { cwd: pkg, env, encoding: 'utf8', timeout: 110_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('vitest from packages/web-ui', { timeout: 120_000 }, () => {
  // `--project browser-compile`: vitest stops if no such project exists, and reports no test
  // file if the test is not in it, so a pass here means it ran in that project.
  it('runs the compile-mode test in the browser-compile project, and it passes', () => {
    const r = runFromPackage(['--project', 'browser-compile']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Tests\s+1 passed \(1\)/);
  });

  it('fails with the cause named when Svelte is compiled for the server', () => {
    const r = runFromPackage(['--config', 'vite.config.ts']);
    expect(r.status, 'the run finished rather than timing out').not.toBeNull();
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('Svelte was compiled for the server, not the browser');
  });
});
