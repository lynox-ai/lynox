/**
 * One home directory per suite run, so no test opens the machine's real `~/.lynox`.
 *
 * ⛔ WHY. On a developer machine `~/.lynox` is a real instance directory: tokens, the vault, API
 * profiles, `agent-memory.db`, `engine.db`. Suites that boot an engine without `LYNOX_DATA_DIR`
 * opened that `engine.db` and migrated it. Measured 2026-10-14: a branch with its own migration
 * stamped the shared file, and another branch's suite then failed with a schema error its diff did
 * not explain — 208 tests in 4 files, all gone with `LYNOX_DATA_DIR` set to an empty temp dir.
 *
 * ⛔ WHY `HOME` AND NOT ONLY `LYNOX_DATA_DIR`. `getLynoxDir()` follows `LYNOX_DATA_DIR`, but engine
 * code also builds `~/.lynox` paths from `homedir()` directly. Setting the variable alone would
 * leave those pointing at the real directory. `os.homedir()` reads `HOME` on every call, so the
 * redirect reaches them, and any test file written later, without either knowing about this file.
 *
 * ⛔ WHY THE TWO VARIABLES ARE REMOVED rather than pointed at the run's home. Tests set the legacy
 * `LYNOX_DIR` or assume the default `~/.lynox` path; an inherited `LYNOX_DATA_DIR` overrides both
 * and turns those tests red for a cause outside their file. With both removed, the default applies,
 * and the default is now under the run's home.
 *
 * ⚠ What this does NOT cover: a test that builds an absolute path to a real home, or code that asks
 * `os.userInfo().homedir`, which reads the passwd entry and ignores `HOME`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { RUN_MARKER_ENV, RUN_MARKER_FILE } from './test-run-tmpdir.js';

/** The run's home, inside the run root. */
export const RUN_HOME_DIR = 'home';

/**
 * Point `HOME` at a directory inside the run root and remove the data-dir variables. Returns the
 * home. Called from `globalSetup`, after the run root exists: the variables reach the worker
 * processes the same way `TMPDIR` does.
 */
export function redirectHomeForRun(runRoot: string): string {
  const home = join(runRoot, RUN_HOME_DIR);
  mkdirSync(home, { mode: 0o700 });
  process.env.HOME = home;
  delete process.env.LYNOX_DATA_DIR;
  delete process.env.LYNOX_DIR;
  return home;
}

export interface RunHomeFacts {
  /** `os.homedir()` in the worker. */
  home: string;
  /** `getLynoxDir()` in the worker: where the engine would put its data. */
  lynoxDir: string;
  /** `TMPDIR` in the worker: the run root, when globalSetup ran. */
  tmp: string | undefined;
  /** The run token from the environment. */
  token: string | undefined;
  /** Reads the token the run root carries; throws when there is none. */
  readMarker: (root: string) => string;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Why this worker may NOT run tests, or null when it may. Pure, so it can be tested directly.
 *
 * The home must be exactly the run root's home, and the run root must carry this run's token: a
 * `HOME` that only LOOKS like a run home (set by hand, or left over) cannot satisfy both.
 */
export function runHomeViolation(f: RunHomeFacts): string | null {
  if (f.tmp === undefined || f.token === undefined) {
    return 'no run root: the suite did not start through globalSetup, so HOME was not redirected';
  }
  let marker: string;
  try {
    marker = f.readMarker(f.tmp).trim();
  } catch {
    return `TMPDIR ${f.tmp} carries no run marker, so it is not this run's root`;
  }
  if (marker !== f.token) return `TMPDIR ${f.tmp} belongs to another run`;
  if (f.home !== join(f.tmp, RUN_HOME_DIR)) {
    return `HOME is ${f.home}, not this run's home ${join(f.tmp, RUN_HOME_DIR)}`;
  }
  if (!inside(f.lynoxDir, f.tmp)) {
    return `the engine's data dir is ${f.lynoxDir}, outside this run's root ${f.tmp}`;
  }
  return null;
}

/** The facts from this process. */
export function readRunHomeFacts(home: string, lynoxDir: string): RunHomeFacts {
  return {
    home,
    lynoxDir,
    tmp: process.env.TMPDIR,
    token: process.env[RUN_MARKER_ENV],
    readMarker: (root) => readFileSync(join(root, RUN_MARKER_FILE), 'utf8'),
  };
}
