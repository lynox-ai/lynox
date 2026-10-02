/**
 * One temp root per suite run, so a fixture cannot leak into the shared `/tmp`.
 *
 * ⛔ WHY THIS SHAPE, and not a helper every test file calls. Measured **2026-10-02 early**, before
 * a one-off cleanup: `/tmp` held ~36800 entries from at least 14 fixtures across both repos.
 * ⚠ Those absolute figures are already stale — a later count the same day found ~21900, because
 * ~15000 of the directories were removed by hand in between. The number that does NOT go stale is
 * the SHAPE: every one of those fixtures hands back a path inside a directory it created, and
 * removes only the path. The form was the same
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
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The prefix a run root carries, so an orphan is recognisable as ours. */
export const RUN_ROOT_PREFIX = 'lynox-test-run-';

/**
 * A token this process writes into the root AND into the environment, so a test can tell
 * "globalSetup redirected me here" from "something named this directory like a run root".
 *
 * ⛔ Added because the wiring test that shipped with this file was satisfiable from OUTSIDE.
 * Measured: remove the redirect and run with `TMPDIR` pointing at any directory whose name carries
 * the prefix, and the test passes — six green, exit 0. The reference it compared against was
 * something its own subject could supply. **Never let the subject produce the test's precondition.**
 *
 * The token closes it because it is random per run and must match in two places at once: an
 * accidental environment cannot satisfy that, and a deliberate one is a lie rather than a mistake.
 */
export const RUN_MARKER_FILE = '.lynox-test-run';
export const RUN_MARKER_ENV = 'LYNOX_TEST_RUN';

/**
 * Create the run root and point `TMPDIR` at it. Returns the path.
 *
 * `mkdtempSync` rather than a fixed name: two suites can run at once (two worktrees, a watch
 * mode beside a full run), and a fixed name would have them deleting each other's root in
 * teardown — the exact failure a shared cache taught us to avoid.
 */
export function redirectTmpdirForRun(): string {
  const root = mkdtempSync(join(tmpdir(), RUN_ROOT_PREFIX));
  const token = randomBytes(16).toString('hex');
  writeFileSync(join(root, RUN_MARKER_FILE), token);
  process.env.TMPDIR = root;
  process.env[RUN_MARKER_ENV] = token;
  return root;
}

/**
 * What the run left in its root, and then remove it.
 *
 * ⛔ THREE outcomes, not two. The first version returned `{ entries: 0, removed: false }` both when
 * the root was already gone and when `rmSync` FAILED. Those are opposite facts — one leaks nothing,
 * the other leaks everything under it — and a caller cannot act differently on them if they arrive
 * as the same value. Same failure as a probe reporting "nothing found" for "could not look".
 *
 * Separated from the teardown hook on purpose: a teardown runs after the last test, so no test can
 * observe it. As a function it can be witnessed, which is the difference between a cleanup that is
 * claimed and one that is tested.
 *
 * ⚠ An `ensureRunRoot` sat here as a "belt for the case where something removed the root mid-run".
 * It was reachable from nothing but its own test, and had it ever fired it would have recreated the
 * root at 0775 instead of the 0700 `mkdtempSync` gives — widening a directory every test writes
 * into. A guard with no caller is not defence in depth.
 */
export type RunRootOutcome =
  /** We removed it. `entries` is what the fixtures left inside. */
  | { state: 'removed'; entries: number }
  /** It was already gone — somebody else's cleanup, or a `TMPDIR` nobody redirected. No leak. */
  | { state: 'absent'; entries: 0 }
  /** It is STILL THERE and we could not remove it. This is the leak the redirect exists to stop. */
  | { state: 'failed'; entries: number; reason: string };

export function summariseRunRoot(root: string): RunRootOutcome {
  let entries = 0;
  try {
    // Everything in the root except our own marker. ⚠ NOT the same as "what the fixtures left":
    // Node writes `node-compile-cache` here too, because that follows `TMPDIR` like everything
    // else — so the count is normally one higher than the number of leaked fixture directories.
    // Filtering a growing list of known-innocent names would be worse: it would hide a real leak
    // the day something new appears. The honest reading is "entries in the run root", and the
    // marker is excluded only because THIS file creates it.
    entries = readdirSync(root).filter((n) => n !== RUN_MARKER_FILE).length;
  } catch {
    return { state: 'absent', entries: 0 };
  }
  try {
    rmSync(root, { recursive: true, force: true });
    return { state: 'removed', entries };
  } catch (e) {
    return { state: 'failed', entries, reason: e instanceof Error ? e.message : String(e) };
  }
}
