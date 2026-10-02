/**
 * One temp root per suite run, so a fixture cannot leak into the shared `/tmp`.
 *
 * ⛔ WHY THIS SHAPE, and not a helper every test file calls. Measured 2026-10-02 on the
 * workstation: `/tmp` held **36814** entries, from at least 14 different fixtures across both
 * repos — `ds-test-` 18271, `mgeg-` 6367, `ds-tool-test-` 4800, and so on. The form was the same
 * everywhere: `mkdtempSync` hands back a path INSIDE the directory it created, the teardown
 * removes that path, and the directory stays. Every one of those files is individually correct
 * about what it created and wrong about what it left.
 *
 * A shared `makeTmpDir()` helper fixes the 14 that adopt it and answers the only question that
 * matters — *would a future test file whose author does not know the solution fall in anyway?* —
 * with **yes**. Redirecting `TMPDIR` for the run answers it with **no**: `os.tmpdir()` reads the
 * variable on every call, so a file written next year with the same `mkdtempSync(join(tmpdir(),
 * …))` lands under the run root and is removed with it, having never heard of this file.
 *
 * Verified before building it, because it is an assumption about the test runner rather than
 * about our code: with `pool: 'forks'`, a `TMPDIR` set in `globalSetup` DOES reach the worker
 * processes — a probe inside a fork reported `tmpdir()` as the run root and its `mkdtempSync`
 * landing there.
 *
 * ⚠ What this does NOT do: make the fixtures correct. They still leave their directories behind,
 * now inside the run root instead of in `/tmp`, and `summariseRunRoot` counts them so the number
 * is visible rather than silently swept. Cleaning them up at the source stays worth doing; this
 * removes the consequence, not the cause.
 *
 * ⚠ And it is not a sandbox. A test that builds an ABSOLUTE path into `/tmp` bypasses it
 * completely — the redirect only covers code that asks `os.tmpdir()` where to go.
 */
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The prefix a run root carries, so an orphan is recognisable as ours. */
export const RUN_ROOT_PREFIX = 'lynox-test-run-';

/**
 * Create the run root and point `TMPDIR` at it. Returns the path.
 *
 * `mkdtempSync` rather than a fixed name: two suites can run at once (two worktrees, a watch
 * mode beside a full run), and a fixed name would have them deleting each other's root in
 * teardown — the exact failure a shared cache taught us to avoid.
 */
export function redirectTmpdirForRun(): string {
  const root = mkdtempSync(join(tmpdir(), RUN_ROOT_PREFIX));
  process.env.TMPDIR = root;
  return root;
}

/**
 * What the run left in its root, and then remove it.
 *
 * Pure except for the removal, and separated from the teardown hook on purpose: a teardown runs
 * after the last test, so no test can observe it. This function can be tested directly, which is
 * the difference between a cleanup that is claimed and one that is witnessed.
 */
export function summariseRunRoot(root: string): { entries: number; removed: boolean } {
  let entries = 0;
  try {
    entries = readdirSync(root).length;
  } catch {
    return { entries: 0, removed: false };
  }
  try {
    rmSync(root, { recursive: true, force: true });
    return { entries, removed: true };
  } catch {
    return { entries, removed: false };
  }
}

/** Belt for the case where something removed the root mid-run. */
export function ensureRunRoot(root: string): void {
  mkdirSync(root, { recursive: true });
}
