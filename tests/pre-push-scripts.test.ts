/**
 * The customer-name checks run at pre-push even where lefthook skips pre-push COMMANDS: whenever the
 * checked-out HEAD has no file diff against its upstream (no upstream: against `origin/HEAD`),
 * lefthook reports "(skip) no matching push files" and exits 0, whatever is being pushed (measured
 * with lefthook 2.1.5 and 2.1.8, with a probe that lets the push through).
 *
 * Both halves of the class look at something other than the file diff, and have no CI twin:
 *   · `check-meta` reads commit MESSAGES — an empty commit carries a message and no file;
 *   · `check-files` walks EVERY commit in the range, so that a file added and deleted again is
 *     still found — and such a range has no file diff at its end.
 * So they are lefthook SCRIPTS. This drives real pushes through lefthook, from a real `git clone`,
 * and requires each to block — and the neutral twin of each case to land, so a block cannot be
 * mistaken for a hook that blocks everything.
 *
 * The name is invented and assembled, never a real one; HOME is redirected so the operator's own
 * list cannot decide the result (same reason as tests/public-repo-guard.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, chmodSync, existsSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEFTHOOK = join(REPO, 'node_modules/.bin/lefthook');
const NAME = ['zzqx', 'fictional', 'corp'].join('-');
/** An invented register id, assembled so this file carries none (the commit scan reads it). */
const ID = ['DE', 'F-', 'example-invented-row'].join('');
/** The three hooks that scan a range, and the file that tells each of them what the range is. */
const RANGE_HOOKS = ['public-repo-guard-meta.sh', 'public-repo-guard-files.sh', 'public-repo-guard-commits.sh'] as const;
const RANGES = 'pushed-ranges.sh';
const FETCH = 'git fetch origin main:refs/remotes/origin/main';
/** These tests start git, lefthook and bash; the default 5 s is too tight under load. */
const T = 30_000;

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'pre-push-scripts-')); });
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function setup() {
  expect(existsSync(LEFTHOOK)).toBe(true);
  const dir = mkdtempSync(join(tmp, 'case-'));
  const seed = join(dir, 'seed');
  const work = join(dir, 'work');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.lynox'), { recursive: true });
  writeFileSync(join(home, '.lynox', 'private-names.re'), `${NAME}\n`);
  const env = {
    ...process.env, HOME: home, LYNOX_PRIVATE_NAMES_RE_FILE: undefined,
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  } as NodeJS.ProcessEnv;
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r;
  };
  mkdirSync(join(seed, '.lefthook/pre-push'), { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  // The REAL wrappers, the REAL guard (with its lib), and the REAL registration of these two.
  cpSync(join(REPO, 'scripts/public-repo-guard.sh'), join(seed, 'scripts/public-repo-guard.sh'));
  cpSync(join(REPO, 'scripts/lib'), join(seed, 'scripts/lib'), { recursive: true });
  cpSync(join(REPO, 'scripts/added-lines-guard.mjs'), join(seed, 'scripts/added-lines-guard.mjs'));
  copyFileSync(join(REPO, '.lefthook/pre-push', RANGES), join(seed, '.lefthook/pre-push', RANGES));
  const real = parse(readFileSync(join(REPO, 'lefthook.yml'), 'utf8')) as { 'pre-push': { scripts: Record<string, unknown> } };
  const mine: Record<string, unknown> = {};
  for (const name of RANGE_HOOKS) {
    expect(real['pre-push'].scripts[name], `${name} is registered as a pre-push SCRIPT`).toBeDefined();
    mine[name] = real['pre-push'].scripts[name];
    copyFileSync(join(REPO, '.lefthook/pre-push', name), join(seed, '.lefthook/pre-push', name));
    chmodSync(join(seed, '.lefthook/pre-push', name), 0o755);
  }
  writeFileSync(join(seed, 'lefthook.yml'), `pre-push:\n  scripts: ${JSON.stringify(mine)}\n`);
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  spawnSync('git', ['clone', '-q', '--bare', seed, join(dir, 'remote.git')], { env });
  git(dir, 'clone', '-q', join(dir, 'remote.git'), work);
  expect(git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD').stdout.trim()).toBe('refs/remotes/origin/main');
  expect(spawnSync(LEFTHOOK, ['install'], { cwd: work, encoding: 'utf8', env }).status).toBe(0);
  git(work, 'switch', '-q', '-c', 'feat/x');
  const push = () => {
    const r = spawnSync('git', ['push', 'origin', 'feat/x'], { cwd: work, encoding: 'utf8', env });
    const landed = spawnSync('git', ['ls-remote', join(dir, 'remote.git'), 'refs/heads/feat/x'], { encoding: 'utf8', env }).stdout.trim() !== '';
    return { status: r.status, out: `${r.stdout}${r.stderr}`, landed };
  };
  /** No file diff between HEAD and `base` — the condition under which lefthook skips commands. If
   *  this did not hold, a block would prove nothing about scripts vs commands. */
  const noFileDiff = (base: string) => git(work, 'diff', '--name-only', base, 'HEAD').stdout.trim() === '';
  return { git: (...a: string[]) => git(work, ...a), push, noFileDiff, work, env };
}

describe('the customer-name class runs where lefthook skips commands', () => {
  it('check-meta: fresh branch, one empty commit whose MESSAGE carries the name → blocked', () => {
    const c = setup();
    c.git('commit', '-q', '--allow-empty', '-m', `Note for ${NAME}`);
    expect(c.noFileDiff('origin/main')).toBe(true);
    const r = c.push();
    expect(r.landed, r.out).toBe(false);
  }, T);

  it('check-meta: an empty commit with the name on an ALREADY-PUSHED branch → blocked', () => {
    const c = setup();
    writeFileSync(join(c.work, 'a.md'), 'neutral\n');
    c.git('add', 'a.md');
    c.git('commit', '-q', '-m', 'Add a');
    expect(c.push().landed).toBe(true);
    c.git('branch', '-q', '--set-upstream-to', 'origin/feat/x');
    c.git('commit', '-q', '--allow-empty', '-m', `Follow-up for ${NAME}`);
    expect(c.noFileDiff('@{upstream}')).toBe(true);
    const r = c.push();
    expect(r.out).not.toMatch(/Everything up-to-date/);
    expect(c.git('ls-remote', 'origin', 'refs/heads/feat/x').stdout.slice(0, 40))
      .not.toBe(c.git('rev-parse', 'HEAD').stdout.trim());
  }, T);

  it('check-files: a file carrying the name, added and deleted again → blocked', () => {
    const c = setup();
    writeFileSync(join(c.work, 'notes.md'), `call ${NAME} back\n`);
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', 'Add notes');
    c.git('rm', '-q', 'notes.md');
    c.git('commit', '-q', '-m', 'Remove notes');
    expect(c.noFileDiff('origin/main')).toBe(true);
    const r = c.push();
    expect(r.landed, r.out).toBe(false);
  }, T);

  it('POSITIVE CONTROL: the same two shapes with neutral content land', () => {
    const meta = setup();
    meta.git('commit', '-q', '--allow-empty', '-m', 'Note, neutral');
    expect(meta.push().landed).toBe(true);
    const files = setup();
    writeFileSync(join(files.work, 'notes.md'), 'call back\n');
    files.git('add', 'notes.md');
    files.git('commit', '-q', '-m', 'Add notes');
    files.git('rm', '-q', 'notes.md');
    files.git('commit', '-q', '-m', 'Remove notes');
    expect(files.push().landed).toBe(true);
  }, T);
});

/**
 * WHAT a push transfers comes from one file, pushed-ranges.sh, for all three range hooks. The -meta
 * and -files hooks used to take `merge-base origin/main HEAD`..HEAD, so a push of a branch you are
 * not standing on scanned nothing of it — and that form let a clone without origin/main through on
 * an empty range. Each case below is reachable by exactly ONE hook (a name in a message, a name in a
 * file, an id in an added line), so replacing the shared range in any one hook fails its own case.
 *
 * That shows each hook SCANS the pushed ref. It cannot show that each hook passes a REFUSAL on: a
 * push is refused when ANY hook refuses, so a push-level test is met by the other two hooks too. A
 * claim about every hook needs one assertion per hook — the per-hook block further down runs each
 * hook on its own.
 */
describe('every range hook scans the pushed ref, not the checked-out HEAD', () => {
  const hits: Record<(typeof RANGE_HOOKS)[number], { make: (c: ReturnType<typeof setup>) => void; says: RegExp }> = {
    'public-repo-guard-meta.sh': {
      make: (c) => c.git('commit', '-q', '--allow-empty', '-m', `Note for ${NAME}`),
      says: /private name in the message of commit/,
    },
    'public-repo-guard-files.sh': {
      make: (c) => {
        writeFileSync(join(c.work, 'notes.md'), `call ${NAME} back\n`);
        c.git('add', 'notes.md');
        c.git('commit', '-q', '-m', 'Add notes');
      },
      says: /private name in the CONTENT of: notes\.md/,
    },
    'public-repo-guard-commits.sh': {
      make: (c) => {
        writeFileSync(join(c.work, 'note.md'), `see ${ID}\n`);
        c.git('add', 'note.md');
        c.git('commit', '-q', '-m', 'Add note');
      },
      says: /note\.md:1: internal register id/,
    },
  };

  for (const hook of RANGE_HOOKS) {
    it(`${hook}: pushing feat/x while standing on main → blocked`, () => {
      const c = setup();
      hits[hook].make(c);
      c.git('switch', '-q', 'main');
      const r = c.push();
      expect(r.landed, r.out).toBe(false);
      expect(r.out).toMatch(hits[hook].says);
    }, T);
  }

  it('POSITIVE CONTROL: a neutral feat/x pushed while standing on main lands', () => {
    const c = setup();
    writeFileSync(join(c.work, 'notes.md'), 'call back\n');
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', 'Add notes');
    c.git('switch', '-q', 'main');
    const r = c.push();
    expect(r.landed, r.out).toBe(true);
  }, T);

  it('every range hook reads its range from pushed-ranges.sh and from nowhere else', () => {
    for (const hook of RANGE_HOOKS) {
      const body = readFileSync(join(REPO, '.lefthook/pre-push', hook), 'utf8');
      const code = body.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
      expect(code, hook).toMatch(/bash \.lefthook\/pre-push\/pushed-ranges\.sh /);
      expect(code, hook).not.toMatch(/merge-base/);
    }
  });
});

/**
 * Each hook run ON ITS OWN, with the stdin git would hand it. One assertion per hook, because "the
 * push is refused" holds as long as any one of them refuses (see the block above).
 */
describe('every range hook passes each refusal of pushed-ranges.sh on, by itself', () => {
  const ZERO = '0'.repeat(40);
  const runHook = (c: ReturnType<typeof setup>, hook: string, input: string | null) => {
    const path = join('.lefthook/pre-push', hook);
    // input null = stdin that opens but cannot be READ (a directory: EISDIR), the read error the
    // refusal exists for. Not a closed fd 0: the hook's own command-substitution pipe would take
    // fd 0 and `cat` would wait on it forever. An empty input reads /dev/null — spawnSync leaves a
    // pipe open for `input: ''`, and the hook would wait on that too.
    const r = input === null
      ? spawnSync('bash', ['-c', 'exec bash "$0" < /', path], { cwd: c.work, encoding: 'utf8', env: c.env, timeout: T })
      : input === ''
        ? spawnSync('bash', [path], { cwd: c.work, encoding: 'utf8', env: c.env, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawnSync('bash', [path], { cwd: c.work, encoding: 'utf8', env: c.env, input });
    return { status: r.status, err: r.stderr };
  };
  const label = (hook: string) => hook.replace(/\.sh$/, '');

  for (const hook of RANGE_HOOKS) {
    it(`${hook}: a new ref with no origin/main → exit 2, naming the fetch`, () => {
      const c = setup();
      c.git('update-ref', '-d', 'refs/remotes/origin/main');
      const tip = c.git('rev-parse', 'HEAD').stdout.trim();
      const r = runHook(c, hook, `refs/heads/feat/x ${tip} refs/heads/feat/x ${ZERO}\n`);
      expect(r.status, r.err).toBe(2);
      expect(r.err).toContain(`${label(hook)}: there is no origin/main`);
      expect(r.err).toContain(FETCH);
    }, T);

    it(`${hook}: stdin that cannot be read → exit 2`, () => {
      const c = setup();
      const r = runHook(c, hook, null);
      expect(r.status, r.err).toBe(2);
      expect(r.err).toContain(`${label(hook)}: could not read the refs`);
    }, T);

    it(`${hook}: a line that is not a ref line → exit 2`, () => {
      const c = setup();
      const r = runHook(c, hook, 'refs/heads/feat/x not-a-sha\n');
      expect(r.status, r.err).toBe(2);
      expect(r.err).toContain(`${label(hook)}: not a pre-push ref line`);
    }, T);

    it(`${hook}: POSITIVE CONTROL: stdin read and empty (nothing to push) → exit 0, says nothing scanned`, () => {
      const c = setup();
      c.git('update-ref', '-d', 'refs/remotes/origin/main');
      const r = runHook(c, hook, '');
      expect(r.status, r.err).toBe(0);
      expect(r.err).toContain(`${label(hook)}: no ref is pushed`);
    }, T);
  }
});

describe('a push with nothing to do scans nothing, even without origin/main', () => {
  it('an up-to-date push of main lands while the checked-out branch carries an unpushed hit', () => {
    const c = setup();
    writeFileSync(join(c.work, 'notes.md'), `call ${NAME} back, see ${ID}\n`);
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', `Note for ${NAME}`);
    c.git('remote', 'set-head', 'origin', '--delete');
    c.git('update-ref', '-d', 'refs/remotes/origin/main');
    const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: c.work, encoding: 'utf8', env: c.env });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/Everything up-to-date/);
  }, T);
});

describe('a ref the remote has at a sha this clone lacks, with no origin/main', () => {
  it('is refused naming the fetch of THAT ref → run exactly that command → the same force-push lands', () => {
    const c = setup();
    // Someone else pushes feat/x; this clone never fetches it.
    const other = join(c.work, '..', 'other');
    spawnSync('git', ['clone', '-q', join(c.work, '..', 'remote.git'), other], { encoding: 'utf8', env: c.env });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'theirs'], { cwd: other, env: c.env });
    // `other` never ran `lefthook install`, so it has no hooks to run.
    expect(existsSync(join(other, '.git/hooks/pre-push'))).toBe(false);
    const theirs = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feat/x'], { cwd: other, encoding: 'utf8', env: c.env });
    expect(theirs.status, theirs.stderr).toBe(0);
    writeFileSync(join(c.work, 'notes.md'), 'call back\n');
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', 'Add notes');
    c.git('remote', 'set-head', 'origin', '--delete');
    c.git('update-ref', '-d', 'refs/remotes/origin/main');
    const force = () => spawnSync('git', ['push', '--force', 'origin', 'feat/x'], { cwd: c.work, encoding: 'utf8', env: c.env });
    const first = force();
    expect(first.status, first.stderr).not.toBe(0);
    expect(first.stderr).toContain('the remote has refs/heads/feat/x at');
    expect(first.stderr).not.toContain('measure a new branch');
    const named = /Fetch it, then push again:\s+(git fetch [^\n]+)/.exec(first.stderr)?.[1]?.trim();
    expect(named).toBe('git fetch origin refs/heads/feat/x');
    const fetched = spawnSync(named!.split(' ')[0]!, named!.split(' ').slice(1), { cwd: c.work, encoding: 'utf8', env: c.env });
    expect(fetched.status, fetched.stderr).toBe(0);
    const second = force();
    expect(second.status, second.stderr).toBe(0);
  }, T);
});

describe('a push that only deletes a ref transfers nothing, so it scans nothing', () => {
  it('deleting feat/x lands even while the checked-out HEAD carries a hit in all three classes', () => {
    const c = setup();
    writeFileSync(join(c.work, 'a.md'), 'neutral\n');
    c.git('add', 'a.md');
    c.git('commit', '-q', '-m', 'Add a');
    expect(c.push().landed).toBe(true);
    // Unpushed work on HEAD that each hook would refuse, were it measured.
    writeFileSync(join(c.work, 'notes.md'), `call ${NAME} back, see ${ID}\n`);
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', `Note for ${NAME}`);
    const r = spawnSync('git', ['push', 'origin', '--delete', 'feat/x'], { cwd: c.work, encoding: 'utf8', env: c.env });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(c.git('ls-remote', 'origin', 'refs/heads/feat/x').stdout.trim()).toBe('');
  }, T);

  it('POSITIVE CONTROL: the same HEAD, pushed instead of deleted, is refused', () => {
    const c = setup();
    writeFileSync(join(c.work, 'notes.md'), `call ${NAME} back, see ${ID}\n`);
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', `Note for ${NAME}`);
    expect(c.push().landed).toBe(false);
  }, T);
});

describe('a new branch with no origin/main is refused, and the remedy the refusal names works', () => {
  it('push refused with exit≠0 and the fetch command → run exactly that command → the same push lands', () => {
    const c = setup();
    writeFileSync(join(c.work, 'notes.md'), 'call back\n');
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', 'Add notes');
    // The state of a --single-branch clone of another branch, or one whose main was never fetched.
    c.git('remote', 'set-head', 'origin', '--delete');
    c.git('update-ref', '-d', 'refs/remotes/origin/main');
    const first = c.push();
    expect(first.landed, first.out).toBe(false);
    expect(first.status).not.toBe(0);
    for (const hook of RANGE_HOOKS) expect(first.out).toContain(`${hook.replace(/\.sh$/, '')}: there is no origin/main`);
    expect(first.out).toContain(FETCH);
    // Run the command as the message prints it, not a copy of it written into this test.
    const named = /Fetch it, then push again:\s+(git fetch [^\n]+)/.exec(first.out)?.[1]?.trim();
    expect(named).toBe(FETCH);
    const fetched = spawnSync(named!.split(' ')[0]!, named!.split(' ').slice(1), { cwd: c.work, encoding: 'utf8', env: c.env });
    expect(fetched.status, fetched.stderr).toBe(0);
    const second = c.push();
    expect(second.landed, second.out).toBe(true);
  }, T);
});
