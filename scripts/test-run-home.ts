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
 * ⚠ What this does NOT cover: a test that builds an absolute path to a real home, code that asks
 * `os.userInfo().homedir` (it reads the passwd entry and ignores `HOME`), and runs outside
 * `vitest.config.ts`: the benches (`vitest.bench.config.ts`) and a `--config` pointing elsewhere get
 * neither the redirect nor the guard. The opt-in harnesses read their API key from the developer's
 * own config through `operatorHome()`, on purpose and read-only.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { RUN_HOME_DIR, RUN_MARKER_ENV, RUN_MARKER_FILE } from './test-run-tmpdir.js';

export { RUN_HOME_DIR };

/**
 * Set on `globalThis` by the guard once it has let a worker through, so a test can tell that the
 * guard ran at all: without it, removing the guard from a project's `setupFiles` leaves every test
 * green, because the redirect alone already makes the home right. A registered symbol, so a test
 * can read it without importing this file.
 */
export const HOME_GUARD_RAN = Symbol.for('lynox.test.homeGuardRan');

/** The home the run started with, kept by `redirectHomeForRun` before it points `HOME` away. */
export const REAL_HOME_ENV = 'LYNOX_TEST_REAL_HOME';

/**
 * The developer's own home, for the opt-in harnesses ONLY (online tests, `LYNOX_EVAL`), which read
 * an API key from the developer's `~/.lynox/config.json`. With `HOME` redirected they would find
 * none and skip without a word. Nothing in the normal suite may use this: the point of the
 * redirect is that the normal suite cannot reach that directory. A harness whose file the normal
 * suite also loads (tests/eval is not excluded, only skipped) reads through `evalOperatorConfig`,
 * which reads nothing without `LYNOX_EVAL=1`.
 */
export function operatorHome(): string {
  return process.env[REAL_HOME_ENV] ?? homedir();
}

/** The developer's own `~/.lynox/config.json`, read only. `problem` says why there is no config. */
export function readOperatorConfig(): { path: string; config: Record<string, unknown> | null; problem: string | null } {
  const path = join(operatorHome(), '.lynox', 'config.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { path, config: null, problem: code === 'ENOENT' ? 'no such file' : `unreadable (${code ?? String(e)})` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { path, config: null, problem: 'not a JSON object' };
    }
    return { path, config: parsed as Record<string, unknown>, problem: null };
  } catch {
    return { path, config: null, problem: 'not valid JSON' };
  }
}

/**
 * Said out loud when an opt-in harness finds no key, naming every place it looked. A silent skip
 * here reads like "nothing to test" while it is "could not look", and that is the reading that
 * gets a run believed.
 */
export function reportMissingKey(harness: string, envNames: readonly string[], configFields: readonly string[]): void {
  const cfg = readOperatorConfig();
  const where = cfg.problem === null ? `${cfg.path} has none of ${configFields.join(', ')}` : `${cfg.path}: ${cfg.problem}`;
  process.stderr.write(
    `\n⚠ ${harness}: SKIPPED, no API key. Looked in the environment (${envNames.join(', ')}: unset or empty) ` +
      `and in the developer config (${where}).\n\n`,
  );
}

/**
 * The developer config for the knowledge eval: read only with `LYNOX_EVAL=1`, else `{}`. The eval's
 * file is loaded by every normal run (it resolves its provider at module load and only then skips),
 * so an unconditional read would reach the developer's real `~/.lynox` from the normal suite.
 */
export function evalOperatorConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (env['LYNOX_EVAL'] !== '1') return {};
  return readOperatorConfig().config ?? {};
}

/**
 * Where the knowledge eval keeps its results: the developer's own `~/.lynox/knowledge-gold/results`,
 * where its gold corpora and earlier results live. Only with `LYNOX_EVAL=1`: it is the one place a
 * test writes into a real `~/.lynox`, so it is not reachable from the normal suite (orchestrator
 * 2026-10-14: an operator tool that only adds files to its own folder, never removes any).
 */
export function evalResultsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['LYNOX_EVAL'] !== '1') {
    throw new Error('evalResultsDir is for the knowledge eval only, which runs with LYNOX_EVAL=1');
  }
  return join(operatorHome(), '.lynox', 'knowledge-gold', 'results');
}

/**
 * Point `HOME` at a directory inside the run root and remove the data-dir variables. Returns the
 * home. Called from `globalSetup`, after the run root exists: the variables reach the worker
 * processes the same way `TMPDIR` does.
 */
export function redirectHomeForRun(runRoot: string): string {
  const home = join(runRoot, RUN_HOME_DIR);
  mkdirSync(home, { mode: 0o700 });
  // Kept first, and only if not kept already: a test that calls globalSetup again runs with the
  // run's home, and must not record THAT as the real one.
  process.env[REAL_HOME_ENV] ??= homedir();
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
