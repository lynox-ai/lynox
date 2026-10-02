/**
 * The run's temp root: that it is WIRED, and that the cleanup it promises works.
 *
 * ⭐ The first test is the one that matters, and it exists because of a mutation that survived a
 * whole suite elsewhere: delete the call that redirects `TMPDIR` and every other test here still
 * passes, because they all ask `os.tmpdir()` and get an answer either way. A redirect nobody
 * observes is not a redirect. So this asserts the PROPERTY — that `tmpdir()` sits under a root
 * carrying the run prefix — rather than that the function exists.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { RUN_ROOT_PREFIX, summariseRunRoot, redirectTmpdirForRun, ensureRunRoot } from '../../scripts/test-run-tmpdir.js';

describe('the suite runs inside its own temp root', () => {
  it('tmpdir() IS the run root — the redirect in globalSetup is wired', () => {
    // The whole point: a file that knows nothing about any of this lands inside the root.
    expect(basename(tmpdir()).startsWith(RUN_ROOT_PREFIX)).toBe(true);
    const mine = mkdtempSync(join(tmpdir(), 'wiring-probe-'));
    expect(dirname(mine)).toBe(tmpdir());
    // Positive control: a path built the naive way really does land under the root, which is
    // what makes a future test file safe without its author doing anything.
    expect(mine.startsWith(tmpdir())).toBe(true);
    rmSync(mine, { recursive: true, force: true });
  });

  it('TMPDIR and tmpdir() agree, so a child process inherits the same root', () => {
    // A fixture that spawns `git` hands the environment down; if these two diverged, the child
    // would write somewhere the teardown does not clean.
    expect(process.env.TMPDIR).toBe(tmpdir());
  });
});

describe('summariseRunRoot', () => {
  it('counts what was left behind and removes the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarise-'));
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    writeFileSync(join(root, 'c.txt'), 'x');
    expect(readdirSync(root)).toHaveLength(3);
    const { entries, removed } = summariseRunRoot(root);
    expect(entries).toBe(3);
    expect(removed).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('reports zero and no removal for a root that is already gone', () => {
    const root = join(tmpdir(), 'summarise-absent-does-not-exist');
    expect(existsSync(root)).toBe(false);
    // The distinction the teardown's message rests on: "nothing left" and "could not look" must
    // not print the same line.
    expect(summariseRunRoot(root)).toEqual({ entries: 0, removed: false });
  });

  it('an empty root reports zero and is still removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarise-empty-'));
    expect(summariseRunRoot(root)).toEqual({ entries: 0, removed: true });
    expect(existsSync(root)).toBe(false);
  });
});

describe('redirectTmpdirForRun', () => {
  it('gives each call its OWN root, so two concurrent suites cannot delete each other', () => {
    // A fixed name would have one run's teardown remove the other run's root mid-test. Two
    // worktrees running at once is the normal case here, not an exotic one.
    const before = process.env.TMPDIR;
    try {
      // ⚠ Both calls must start from the SAME base, or this proves nothing: the first call
      // already redirects `TMPDIR`, so a second call nests under it and the two paths differ
      // even with a fixed name. Measured — a mutant replacing `mkdtempSync` with a fixed name
      // survived this test until the reset below was added. Two concurrent suites each start
      // from the real temp dir, which is what the reset models.
      const base = before ?? tmpdir();
      const a = redirectTmpdirForRun();
      process.env.TMPDIR = base;
      const b = redirectTmpdirForRun();
      expect(a).not.toBe(b);
      expect(basename(a).startsWith(RUN_ROOT_PREFIX)).toBe(true);
      expect(basename(b).startsWith(RUN_ROOT_PREFIX)).toBe(true);
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    } finally {
      // Restore, or every later test in this file writes into a root the teardown will not clean.
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
      ensureRunRoot(tmpdir());
    }
  });
});
