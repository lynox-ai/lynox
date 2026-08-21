/**
 * The pre-commit typecheck guard, driven as a script rather than described.
 *
 * WHY IT NEEDS A TEST AT ALL. The guard's whole product is OUTPUT — a sentence an
 * operator reads at the moment a commit is refused. Nothing else here asserts on
 * output, so every plausible edit to it survived: measured 2026-08-21 in a fresh
 * worktree, deleting `exit 1` and deleting the entire block BOTH still ended in a
 * failed commit, because the package manager already exits non-zero when
 * `node_modules` is absent. That is the finding, and it changes what the guard is:
 * the FAILURE was never the new part. The failure already happened, four times in
 * two days, and was illegible. The guard supplies the cause. A guard whose value is
 * a sentence has to be tested on the sentence, or it silently decays into a comment.
 *
 * WHAT IT DRIVES: the real `lefthook.yml`, parsed, not a copy of the snippet. An
 * `npm` stub on PATH records whether control ever reached the typecheck — which is
 * the half that separates "printed a warning" from "stopped", and the half that the
 * deleted `exit 1` would otherwise get away with.
 *
 * THE TWIN: `packages/managed/src/ci/lefthook-node-modules-guard.test.ts` in the pro
 * repo pins the same property for that repo's hook (which runs `pnpm typecheck`).
 * Neither file can see the other — an unnamed twin is the one that gets orphaned,
 * hence the path, spelled out. The repos are decoupled by design; this duplication
 * is the intended shape, not drift.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let script: string;

beforeAll(() => {
  const cfg = parseYaml(readFileSync(join(repoRoot, 'lefthook.yml'), 'utf8')) as {
    'pre-commit'?: { commands?: Record<string, { run?: string }> };
  };
  const run = cfg['pre-commit']?.commands?.['typecheck']?.run;
  // A missing step is not a passing test. If the key is ever renamed, this file must
  // go red rather than quietly assert on `undefined`.
  expect(typeof run, 'pre-commit.commands.typecheck.run must exist in lefthook.yml').toBe('string');
  script = run as string;
});

/** Run the real hook script in a throwaway cwd, with `npm` replaced by a recorder. */
function runGuard(opts: { withNodeModules: boolean }): { status: number; out: string; typecheckRan: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'lefthook-guard-'));
  const bin = join(dir, 'stub-bin');
  mkdirSync(bin);
  const sentinel = join(dir, 'typecheck-was-called');
  for (const name of ['npm', 'pnpm']) {
    writeFileSync(join(bin, name), `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 0\n`);
    chmodSync(join(bin, name), 0o755);
  }
  if (opts.withNodeModules) mkdirSync(join(dir, 'node_modules'));

  const r = spawnSync('sh', ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  });
  const result = {
    status: r.status ?? -1,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    typecheckRan: existsSync(sentinel),
  };
  // Read every observation out of the directory BEFORE removing it — a cleanup that
  // ran first would make `typecheckRan` false for both cases and pass the wrong test.
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe('pre-commit typecheck guard', () => {
  it('refuses, names the cause, and never reaches the typecheck when node_modules is absent', () => {
    const r = runGuard({ withNodeModules: false });
    // The stop. Kills "drop the `exit 1`" — the typecheck would otherwise run and the
    // guard would be a warning printed above someone else's error.
    expect(r.typecheckRan, 'control reached the typecheck despite the missing node_modules').toBe(false);
    expect(r.status).not.toBe(0);
    // The sentence. Kills "drop the block" and any rewrite that loses the diagnosis or
    // the command that fixes it; both are what the operator actually needs.
    expect(r.out).toMatch(/node_modules is missing/i);
    expect(r.out).toMatch(/pnpm install --force/);
  });

  it('hands control to the typecheck when node_modules is present', () => {
    const r = runGuard({ withNodeModules: true });
    // The other direction. A guard that fires on a healthy worktree gets deleted, and
    // then it guards nothing — so the false-positive case is pinned too.
    expect(r.typecheckRan, 'the typecheck never ran on a worktree that has node_modules').toBe(true);
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/node_modules is missing/i);
  });
});
