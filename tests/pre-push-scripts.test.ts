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
const RANGE_HOOKS = ['public-repo-guard-meta.sh', 'public-repo-guard-files.sh', 'public-repo-guard-commits.sh', 'corpus-structure-guard-commits.sh'] as const;
const RANGES = 'pushed-ranges.sh';
const FETCH = 'git fetch origin main:refs/remotes/origin/main';
/** These tests start git, lefthook and bash, and each builds its own clone; the default 5 s is too
 *  tight under load, and 30 s was too tight in a full parallel suite on a loaded machine (one case
 *  timed out there and passed alone). */
const T = 60_000;

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
  cpSync(join(REPO, 'scripts/corpus-structure-guard.mjs'), join(seed, 'scripts/corpus-structure-guard.mjs'));
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
    'corpus-structure-guard-commits.sh': {
      make: (c) => {
        // The shape is built here, at run time: no corpus-shaped literal lives in this file.
        writeFileSync(join(c.work, 'data.json'), JSON.stringify({ threads: [{ [['tu', 'rns'].join('')]: [] }] }));
        c.git('add', 'data.json');
        c.git('commit', '-q', '-m', 'Add data');
      },
      says: /data\.json \(commit [0-9a-f]{10}\) carries an array named/,
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

  /** Stop a rebase of feat/x at its last commit, as `git rebase -i` does on an `edit` line. */
  const pauseRebase = (c: ReturnType<typeof setup>) => {
    writeFileSync(join(c.work, 'other.md'), 'other\n');
    c.git('add', 'other.md');
    c.git('commit', '-q', '-m', 'Add other');
    // `-i.bak`: the form both GNU and BSD sed accept.
    c.git('-c', 'sequence.editor=sed -i.bak "1s/^pick/edit/"', 'rebase', '-q', '-i', 'HEAD~1');
    expect(existsSync(join(c.work, '.git', 'rebase-merge')), 'the rebase is paused').toBe(true);
  };

  // A push made while a rebase is paused publishes like any other. lefthook's `skip: rebase` would
  // stand every one of these hooks down for it — and two of them have no CI twin at all.
  for (const hook of RANGE_HOOKS) {
    it(`${hook}: pushing feat/x while a rebase is paused → blocked`, () => {
      const c = setup();
      hits[hook].make(c);
      pauseRebase(c);
      const r = c.push();
      expect(r.landed, r.out).toBe(false);
      expect(r.out).toMatch(hits[hook].says);
    }, T);
  }

  it('POSITIVE CONTROL: a neutral feat/x pushed while a rebase is paused lands', () => {
    const c = setup();
    writeFileSync(join(c.work, 'notes.md'), 'call back\n');
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', 'Add notes');
    pauseRebase(c);
    const r = c.push();
    expect(r.landed, r.out).toBe(true);
  }, T);
});

/**
 * The class, not the instances: a pre-push script that takes its ranges from pushed-ranges.sh takes
 * them from the pushed refs, not the checkout, so a merge or rebase in progress does not change what
 * it checks, and a `skip` or `only` for such a state only switches it off. Derived from lefthook.yml
 * and the scripts themselves, so a hook added later is held to it too.
 */
describe('no pre-push script that reads the pushed ranges is skipped during a merge or rebase', () => {
  it('none of them carries a skip or an only, and the pre-push hook itself carries neither', () => {
    const doc = parse(readFileSync(join(REPO, 'lefthook.yml'), 'utf8')) as {
      'pre-push': { skip?: unknown; only?: unknown; scripts: Record<string, { skip?: unknown; only?: unknown }> };
    };
    expect(doc['pre-push'].skip, 'pre-push: skip').toBeUndefined();
    expect(doc['pre-push'].only, 'pre-push: only').toBeUndefined();
    const readers = Object.keys(doc['pre-push'].scripts).filter((name) => {
      const body = readFileSync(join(REPO, '.lefthook/pre-push', name), 'utf8');
      return body.split('\n').some((l) => !l.trimStart().startsWith('#') && l.includes('pushed-ranges.sh'));
    });
    // The positive control: the three hooks this file drives are among them.
    for (const hook of RANGE_HOOKS) expect(readers, hook).toContain(hook);
    const skipped = readers.filter((name) => doc['pre-push'].scripts[name]?.skip !== undefined
      || doc['pre-push'].scripts[name]?.only !== undefined);
    expect(skipped).toEqual([]);
  });
});

/**
 * Each hook run ON ITS OWN, with the stdin git would hand it. One assertion per hook, because "the
 * push is refused" holds as long as any one of them refuses (see the block above).
 */
describe('every range hook passes each refusal of pushed-ranges.sh on, by itself', () => {
  const ZERO = '0'.repeat(40);
  /** `unreadable`: stdin opens but cannot be READ (a directory: EISDIR). `closed`: no fd 0 at all —
   *  the case that used to HANG, because the first command substitution took the free fd 0; the
   *  timeout turns a hang into a failure (status null) instead of a stuck suite. An empty input
   *  reads /dev/null — spawnSync leaves a pipe open for `input: ''`, and the hook would wait on it. */
  const runHook = (c: ReturnType<typeof setup>, hook: string, input: string | 'unreadable' | 'closed') => {
    const path = join('.lefthook/pre-push', hook);
    const r = input === 'unreadable' || input === 'closed'
      ? spawnSync('bash', ['-c', input === 'closed' ? 'exec bash "$0" <&-' : 'exec bash "$0" < /', path],
        { cwd: c.work, encoding: 'utf8', env: c.env, timeout: 10_000 })
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
      const r = runHook(c, hook, 'unreadable');
      expect(r.status, r.err).toBe(2);
      expect(r.err).toContain(`${label(hook)}: could not read the refs`);
    }, T);

    it(`${hook}: stdin that is closed → exit 2, not a hang`, () => {
      const c = setup();
      const r = runHook(c, hook, 'closed');
      expect(r.status, r.err).toBe(2);
      expect(r.err).toContain(`${label(hook)}: stdin is closed`);
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

/**
 * The first field of a pre-push line is the push's source: a resolved ref (`main:w3` →
 * `refs/heads/main`) or, when the source is not a ref, the expression verbatim — here a reflog
 * expression with spaces. It can be a ref name and is not guaranteed to be one; only the back three
 * fields have a guaranteed form, which is why pushed-ranges.sh anchors its match from the right.
 */
describe('a push whose source is a reflog expression with spaces', () => {
  const SPEC = 'HEAD@{0 seconds ago}:refs/heads/w';
  const pushSpec = (c: ReturnType<typeof setup>) => {
    const r = spawnSync('git', ['push', 'origin', SPEC], { cwd: c.work, encoding: 'utf8', env: c.env });
    const landed = c.git('ls-remote', 'origin', 'refs/heads/w').stdout.trim() !== '';
    return { status: r.status, out: `${r.stdout}${r.stderr}`, landed };
  };

  it('lands when neutral', () => {
    const c = setup();
    writeFileSync(join(c.work, 'notes.md'), 'call back\n');
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', 'Add notes');
    const r = pushSpec(c);
    expect(r.status, r.out).toBe(0);
    expect(r.landed, r.out).toBe(true);
    expect(r.out).not.toContain('not a pre-push ref line');
  }, T);

  it('is still scanned: a name in the message is refused', () => {
    const c = setup();
    c.git('commit', '-q', '--allow-empty', '-m', `Note for ${NAME}`);
    const r = pushSpec(c);
    expect(r.landed, r.out).toBe(false);
    expect(r.out).toMatch(/private name in the message of commit/);
  }, T);
});

describe('pushed-ranges.sh knows both object-name lengths and never prints field 1 raw', () => {
  const ranges = (c: ReturnType<typeof setup>, input: string) => {
    const r = spawnSync('bash', [join('.lefthook/pre-push', RANGES), 't'], { cwd: c.work, encoding: 'utf8', env: c.env, input });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const Z64 = '0'.repeat(64);

  it('a delete line with a 64-digit zero sha yields no range', () => {
    const c = setup();
    const tip = c.git('rev-parse', 'HEAD').stdout.trim();
    const r = ranges(c, `(delete) ${Z64} refs/heads/z ${tip}\n`);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain('no ref is pushed');
  }, T);

  it('a new ref with a 64-digit zero remote sha and no origin/main gets the NEW-branch message', () => {
    const c = setup();
    c.git('update-ref', '-d', 'refs/remotes/origin/main');
    const tip = c.git('rev-parse', 'HEAD').stdout.trim();
    const r = ranges(c, `refs/heads/n ${tip} refs/heads/n ${Z64}\n`);
    expect(r.status, r.err).toBe(2);
    expect(r.err).toContain('no origin/main here to measure a new branch');
    expect(r.err).not.toContain('the remote has');
  }, T);

  it('run directly with stdin closed → exit 2, not a hang (its own check, not the hook\'s)', () => {
    const c = setup();
    const r = spawnSync('bash', ['-c', 'exec bash "$0" t <&-', join('.lefthook/pre-push', RANGES)],
      { cwd: c.work, encoding: 'utf8', env: c.env, timeout: 10_000 });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain('t: could not read the refs');
  }, T);

  it('a malformed line is quoted when printed', () => {
    const c = setup();
    const r = ranges(c, 'bad $(x) line\n');
    expect(r.status).toBe(2);
    expect(r.err).toContain('bad\\ \\$\\(x\\)\\ line');
  }, T);
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
    // The source is a reflog expression, so field 1 differs from the remote ref: the printed fetch
    // must name the remote ref (field 3), the only field with a guaranteed form. Keep them DIFFERENT:
    // with `feat/x:feat/x` both fields were equal, and a fetch naming field 1 passed this test.
    const force = () => spawnSync('git', ['push', '--force', 'origin', 'HEAD@{0 seconds ago}:refs/heads/feat/x'], { cwd: c.work, encoding: 'utf8', env: c.env });
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

/**
 * A push that merges main must not answer for main's commits. pushed-ranges.sh used to measure an
 * already-pushed branch from its remote sha, so a first main merge put every main commit since then
 * into the scan, and the commit guard refused the push over lines main itself carries (core#2437,
 * 27.11.2026: ~340 main commits, three refused). Now a push that brings main in is measured from
 * where it leaves origin/main. Each case pairs a push that must land with one that must not, so
 * neither a guard that blocks everything nor one that scans nothing passes.
 *
 * "Dirty" is a line with an invented register id: the commit guard refuses it in any added line.
 * Main's commits are made in a second clone that never ran `lefthook install`, so they reach main
 * the way a merged PR does, without this clone's hooks.
 */
describe('a push that merges main scans what main does not carry, and all of it', () => {
  const DIRTY = `see ${ID}\n`;
  const remote = (c: ReturnType<typeof setup>) => join(c.work, '..', 'remote.git');
  /** A commit on main, made elsewhere; then this clone fetches it into origin/main. */
  const onMain = (c: ReturnType<typeof setup>, file: string, text: string) => {
    const other = mkdtempSync(join(tmp, 'main-'));
    const g = (...a: string[]) => {
      const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: other, encoding: 'utf8', env: c.env });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    };
    g('clone', '-q', remote(c), '.');
    expect(existsSync(join(other, '.git/hooks/pre-push'))).toBe(false);
    writeFileSync(join(other, file), text);
    g('add', file);
    g('commit', '-q', '-m', `Add ${file} on main`);
    g('push', '-q', 'origin', 'HEAD:refs/heads/main');
    c.git('fetch', '-q', 'origin');
    return c.git('rev-parse', 'origin/main').stdout.trim();
  };
  const own = (c: ReturnType<typeof setup>, file: string, text: string) => {
    writeFileSync(join(c.work, file), text);
    c.git('add', file);
    c.git('commit', '-q', '-m', `Add ${file}`);
  };
  const merge = (c: ReturnType<typeof setup>) => c.git('merge', '-q', '--no-edit', 'origin/main');
  /** Whether the remote's feat/x is now this clone's HEAD: `landed` alone stays true after the first push. */
  const pushHead = (c: ReturnType<typeof setup>) => {
    const r = c.push();
    const at = spawnSync('git', ['ls-remote', remote(c), 'refs/heads/feat/x'], { encoding: 'utf8', env: c.env }).stdout.slice(0, 40);
    return { ...r, head: at === c.git('rev-parse', 'HEAD').stdout.trim() };
  };
  const pushedOnce = () => {
    const c = setup();
    own(c, 'a.md', 'neutral\n');
    expect(c.push().landed).toBe(true);
    return c;
  };

  it('a main merge whose main commit is dirty lands', () => {
    const c = pushedOnce();
    onMain(c, 'm.md', DIRTY);
    merge(c);
    const r = pushHead(c);
    expect(r.head, r.out).toBe(true);
    expect(r.out).toContain('merges main; commits already on origin/main are not scanned');
  }, T);

  it('a NEW branch that merges main says main was left out, and lands', () => {
    const c = setup();
    own(c, 'a.md', 'neutral\n');
    onMain(c, 'm.md', DIRTY);
    merge(c);
    const r = pushHead(c);
    expect(r.head, r.out).toBe(true);
    expect(r.out).toContain('merges main; commits already on origin/main are not scanned');
    expect(r.out).not.toContain('whatever it brings in is scanned');
  }, T);

  /** The same bare repo under a second name: the pushed sha is the same, only the name differs. */
  const toMirror = (c: ReturnType<typeof setup>) => {
    c.git('remote', 'add', 'mirror', remote(c));
    const r = spawnSync('git', ['push', 'mirror', 'feat/x'], { cwd: c.work, encoding: 'utf8', env: c.env });
    const at = spawnSync('git', ['ls-remote', remote(c), 'refs/heads/feat/x'], { encoding: 'utf8', env: c.env }).stdout.slice(0, 40);
    return { out: `${r.stdout}${r.stderr}`, head: at === c.git('rev-parse', 'HEAD').stdout.trim() };
  };

  it('pushed to another remote name, a main merge is measured from the remote sha: main\'s dirty commit is refused there, lands via origin', () => {
    const c = pushedOnce();
    onMain(c, 'm.md', DIRTY);
    merge(c);
    const r = toMirror(c);
    expect(r.head, r.out).toBe(false);
    expect(r.out).not.toContain('merges main');
    expect(pushHead(c).head).toBe(true);
  }, T);

  it('pushed to another remote name, an own dirty commit behind a main merge is refused, its clean twin lands', () => {
    const c = pushedOnce();
    onMain(c, 'm.md', 'neutral\n');
    merge(c);
    own(c, 'b.md', DIRTY);
    expect(toMirror(c).head).toBe(false);
    const t = pushedOnce();
    onMain(t, 'm.md', 'neutral\n');
    merge(t);
    own(t, 'b.md', 'neutral\n');
    const r = toMirror(t);
    expect(r.head, r.out).toBe(true);
  }, 2 * T);

  it('run by hand without a remote name, the range starts at the remote sha; named origin, at the merge base', () => {
    const c = pushedOnce();
    const pushed = c.git('rev-parse', 'HEAD').stdout.trim();
    const mainTip = onMain(c, 'm.md', DIRTY);
    merge(c);
    const tip = c.git('rev-parse', 'HEAD').stdout.trim();
    const line = `refs/heads/feat/x ${tip} refs/heads/feat/x ${pushed}\n`;
    const run = (...a: string[]) => spawnSync('bash', ['.lefthook/pre-push/pushed-ranges.sh', ...a], { cwd: c.work, encoding: 'utf8', env: c.env, input: line });
    expect(run('t').stdout.trim()).toBe(`${pushed} ${tip}`);
    expect(run('t', 'mirror').stdout.trim()).toBe(`${pushed} ${tip}`);
    expect(run('t', 'origin').stdout.trim()).toBe(`${mainTip} ${tip}`);
  }, T);

  it('a main merge whose main commit carries a raw invisible format character lands; the same in an own commit is refused', () => {
    // core#2470, 27.11.2026: three main commits that put raw format characters into tests blocked a
    // branch that merged main. Written as an escape here, so this file carries none itself.
    const CF = 'zero\u200Bwidth\n';
    const c = pushedOnce();
    onMain(c, 'm.md', CF);
    merge(c);
    const r = pushHead(c);
    expect(r.head, r.out).toBe(true);
    own(c, 'b.md', CF);
    const own2 = pushHead(c);
    expect(own2.head, own2.out).toBe(false);
  }, T);

  it('an own dirty commit behind a main merge is refused', () => {
    const c = pushedOnce();
    onMain(c, 'm.md', DIRTY);
    merge(c);
    own(c, 'b.md', DIRTY);
    const r = pushHead(c);
    expect(r.head, r.out).toBe(false);
  }, T);

  it('CONTROL: the own dirty commit without a merge is refused, and its clean twin lands', () => {
    const dirty = pushedOnce();
    own(dirty, 'b.md', DIRTY);
    expect(pushHead(dirty).head).toBe(false);
    const clean = pushedOnce();
    own(clean, 'b.md', 'neutral\n');
    const r = pushHead(clean);
    expect(r.head, r.out).toBe(true);
    expect(r.out).not.toContain('contains a merge');  // no merge, no hint
    expect(r.out).not.toContain('merges main');
  }, 2 * T);

  it('an own dirty commit BETWEEN two main merges is refused (the new base swallows none of the branch)', () => {
    const c = pushedOnce();
    onMain(c, 'm1.md', DIRTY);
    merge(c);
    own(c, 'b.md', DIRTY);
    onMain(c, 'm2.md', 'neutral\n');
    merge(c);
    const r = pushHead(c);
    expect(r.head, r.out).toBe(false);
    // Twin: the same shape with a clean own commit lands, so the refusal above is the own commit's.
    const t = pushedOnce();
    onMain(t, 'm1.md', DIRTY);
    merge(t);
    own(t, 'b.md', 'neutral\n');
    onMain(t, 'm2.md', 'neutral\n');
    merge(t);
    expect(pushHead(t).head).toBe(true);
  }, 2 * T);

  it('an origin/main between the branch and the merged main: the base moves, main\'s newer dirty commit is still scanned', () => {
    // Reaches the moved base: origin/main is newer than where feat/x was pushed, older than the merge.
    const c = pushedOnce();
    const between = onMain(c, 'm1.md', 'neutral\n');
    onMain(c, 'm2.md', DIRTY);
    merge(c);
    c.git('update-ref', 'refs/remotes/origin/main', between);
    const r = pushHead(c);
    expect(r.head, r.out).toBe(false);
    expect(r.out).toContain('merges main; commits already on origin/main are not scanned');
    expect(r.out).toContain(FETCH);
    c.git('fetch', '-q', 'origin', 'main:refs/remotes/origin/main');
    expect(pushHead(c).head).toBe(true);
  }, T);

  it('an origin/main older than the merged main fails closed and names the fetch', () => {
    const c = pushedOnce();
    const old = c.git('rev-parse', 'origin/main').stdout.trim();
    onMain(c, 'm.md', DIRTY);
    merge(c);
    c.git('update-ref', 'refs/remotes/origin/main', old);
    const r = pushHead(c);
    expect(r.head, r.out).toBe(false);
    expect(r.out).toContain(FETCH);
    // Run what it names, push again: main is current, and the same push lands.
    c.git('fetch', '-q', 'origin', 'main:refs/remotes/origin/main');
    expect(pushHead(c).head).toBe(true);
  }, T);

  it('without origin/main the range starts at the remote sha as before: main\'s dirty commit is scanned', () => {
    const c = pushedOnce();
    onMain(c, 'm.md', DIRTY);
    merge(c);
    c.git('remote', 'set-head', 'origin', '--delete');
    c.git('update-ref', '-d', 'refs/remotes/origin/main');
    const r = pushHead(c);
    expect(r.head, r.out).toBe(false);
    expect(r.out).toContain('without origin/main the commits it');
    // Control: the same with a clean main commit lands, so the refusal is the scan, not the setup.
    const t = pushedOnce();
    onMain(t, 'm.md', 'neutral\n');
    merge(t);
    t.git('remote', 'set-head', 'origin', '--delete');
    t.git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(pushHead(t).head).toBe(true);
  }, 2 * T);
});
