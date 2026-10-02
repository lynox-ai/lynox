/**
 * The commit scan of the public-repo guard: the lines each commit in a range adds.
 *
 * Every marker here is assembled at runtime, so this file adds no line the scan
 * would refuse — it is itself scanned when it is pushed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLines, findingsIn } from '../scripts/added-lines-guard.mjs';

const GUARD = fileURLToPath(new URL('../scripts/added-lines-guard.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('../scripts/public-repo-guard.sh', import.meta.url));
const HOOK = fileURLToPath(new URL('../.lefthook/pre-push/public-repo-guard-commits.sh', import.meta.url));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** An invented id, assembled so this file carries none. */
const ID = ['DE', 'F-', 'example-invented-row'].join('');
const OPEN_WORDING = ['open', 'security', 'finding'].join(' ');

let dir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir, env: GIT_ENV, encoding: 'utf8',
  }).trim();
}

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content);
  git('add', '--', file);
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}

function run(cmd: string, args: string[], input?: string): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: dir, env: GIT_ENV, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const guard = (...args: string[]) => run('node', [GUARD, ...args]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alg-'));
  git('init', '-q');
  commit('README.md', 'base\n', 'base');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the commit scan reads what each commit adds, not what survives at HEAD', () => {
  it('finds an id that one commit adds and a later commit removes', () => {
    const base = git('rev-parse', 'HEAD');
    const adding = commit('note.md', `see ${ID}\n`, 'add');
    commit('note.md', 'see the reason\n', 'remove');

    // HEAD is clean: a scan of the tree would pass this range.
    expect(execFileSync('git', ['show', 'HEAD:note.md'], { cwd: dir, encoding: 'utf8' })).not.toContain(ID);

    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`commit ${adding.slice(0, 9)} note.md:1: internal register id`);
  });

  it('names the location and the kind, never the matched text', () => {
    const base = git('rev-parse', 'HEAD');
    commit('note.md', `see ${ID}\n`, 'add');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(ID);
    expect(r.out).not.toContain('example-invented-row');
  });

  it('passes a range whose added lines carry nothing, and says how much it read', () => {
    const base = git('rev-parse', 'HEAD');
    commit('note.md', 'one\ntwo\n', 'add');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(0);
    expect(r.out).toContain('clean ✓ (1 commit(s), 2 added line(s) read)');
  });

  it('does not check removed lines: a commit taking an id out is not refused', () => {
    commit('note.md', `see ${ID}\n`, 'legacy');
    const base = git('rev-parse', 'HEAD');
    commit('note.md', 'see the reason\n', 'remove');
    expect(guard(base, 'HEAD').code).toBe(0);
  });

  it('finds wording that marks a security finding as open, and not a scanner all-clear', () => {
    const base = git('rev-parse', 'HEAD');
    commit('a.md', `this is an ${OPEN_WORDING}\n`, 'a');
    expect(guard(base, 'HEAD').out).toContain('a.md:1: wording that marks a security finding as open or known');

    const base2 = git('rev-parse', 'HEAD');
    commit('b.md', `scan result: no ${['known', 'vulnerabilities'].join(' ')}\n`, 'b');
    expect(guard(base2, 'HEAD').code).toBe(0);
  });

  it('finds an id that a merge commit adds while resolving it, and removes again later', () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'side');
    commit('side.md', 'side\n', 'side');
    git('checkout', '-q', '-');
    commit('main.md', 'main\n', 'main');
    git('merge', '--no-commit', '-q', 'side');
    writeFileSync(join(dir, 'typed.md'), `see ${ID}\n`);
    git('add', '--', 'typed.md');
    git('commit', '-qm', 'merge');
    const merge = git('rev-parse', 'HEAD');
    git('rm', '-q', 'typed.md');
    git('commit', '-qm', 'remove');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`commit ${merge.slice(0, 9)} typed.md:1: internal register id`);
  });

  it('does not count a line a conflict resolution keeps from main as added by the merge', () => {
    const lowercase = ID.toLowerCase();
    commit('c.ts', 'shared\n', 'shared');
    git('checkout', '-qb', 'side');
    commit('c.ts', 'side one\nside two\n', 'side');
    git('checkout', '-q', '-');
    commit('c.ts', `main ${lowercase}\n`, 'main');
    const mainTip = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'side');
    // Conflicts: git stops with the merge in progress (exit 1), and the commit below
    // concludes it as a merge with two parents.
    const merging = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', mainTip],
      { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
    expect(merging.stdout + merging.stderr).toContain('CONFLICT');
    writeFileSync(join(dir, 'c.ts'), `main ${lowercase}\nside one\nside two\n`);
    git('add', '--', 'c.ts');
    git('commit', '-qm', 'resolve');
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    // The range a pull request has after merging main: its own commit and the merge.
    const r = guard(mainTip, 'HEAD');
    expect(r.out).toContain('clean ✓');
    expect(r.code).toBe(0);
  });

  it('refuses an octopus merge, which git cannot show as typed', () => {
    const base = git('rev-parse', 'HEAD');
    for (const b of ['one', 'two']) {
      git('checkout', '-qb', b, base);
      commit(`${b}.md`, `${b}\n`, b);
    }
    git('checkout', '-qb', 'three', base);
    git('merge', '-q', '--no-ff', '-m', 'octopus', 'one', 'two');
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(4);
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(2);
    expect(r.out).toContain('octopus merge');
  });

  it('reads nothing into a clean merge of the other side', () => {
    git('checkout', '-qb', 'side');
    commit('side.md', 'side\n', 'side');
    git('checkout', '-q', '-');
    const base = git('rev-parse', 'HEAD');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    // The side commit is in the range and adds one line; the merge adds none.
    expect(guard(base, 'HEAD').out).toContain('clean ✓ (2 commit(s), 1 added line(s) read)');
  });

  it('finds an id in a UTF-16 file', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'wide.txt'), Buffer.from(`\uFEFFsee ${ID}\n`, 'utf16le'));
    git('add', '--', 'wide.txt');
    git('commit', '-qm', 'wide');
    expect(guard(base, 'HEAD').code).toBe(1);
  });

  it('honours the inline pragma the tree scan honours', () => {
    const base = git('rev-parse', 'HEAD');
    commit('t.ts', `const x = '${ID}'; // public-repo-guard:allow: parser input, invented\n`, 'pragma');
    expect(guard(base, 'HEAD').code).toBe(0);
  });

  it('does not read an assembled id as an id', () => {
    const base = git('rev-parse', 'HEAD');
    commit('t.ts', "const x = 'DE' + 'F-' + 'example';\nconst y = 'DEF-' + 'example';\n", 'assembled');
    expect(guard(base, 'HEAD').code).toBe(0);
  });

  it('reads an id in lower case as the id', () => {
    expect(findingsIn(ID.toLowerCase())).toEqual(['internal register id']);
  });

  it('names the line of a finding past the first added line', () => {
    const base = git('rev-parse', 'HEAD');
    const adding = commit('note.md', `one\ntwo\nsee ${ID}\n`, 'add');
    expect(guard(base, 'HEAD').out).toContain(`commit ${adding.slice(0, 9)} note.md:3: internal register id`);
  });

  it('reads an id with a look-alike letter or an invisible format character as the id', () => {
    expect(findingsIn(ID.replace('E', '\u0415'))).toEqual(['internal register id']);
    expect(findingsIn(ID.replace('E', '\u0395'))).toEqual(['internal register id']);
    expect(findingsIn(ID.replace('F-', 'F\u202E-'))).toEqual(['internal register id']);
    expect(findingsIn(ID.replace('F-', 'F\u034F-'))).toEqual(['internal register id']);
  });

  it('lets the pragma pass the wording too, for fictional demo content', () => {
    expect(findingsIn(`${OPEN_WORDING} // public-repo-guard:allow: fictional`)).toEqual([]);
  });

  it('reads an id typed with a fullwidth letter or a zero-width character as the id', () => {
    const fullwidth = ID.replace('E', '\uFF25');
    const zeroWidth = ID.replace('F-', 'F\u200B-');
    expect(findingsIn(fullwidth)).toEqual(['internal register id']);
    expect(findingsIn(zeroWidth)).toEqual(['internal register id']);
  });
});

describe('a range it cannot read is not a clean range', () => {
  it('exits 2 for a ref that does not resolve', () => {
    expect(guard('no-such-ref', 'HEAD').code).toBe(2);
  });

  it('exits 2 for a range with no commit, unless the caller allows it (the hook)', () => {
    expect(guard('HEAD', 'HEAD').code).toBe(2);
    const r = guard('HEAD', 'HEAD', '--allow-empty');
    expect(r.code).toBe(0);
    expect(r.out).toContain('adds no commit');
  });

  it('exits 2 on a usage error', () => {
    expect(guard('HEAD').code).toBe(2);
    expect(guard('--x', 'HEAD').code).toBe(2);
  });
});

describe('one entry point for the hook and the CI job', () => {
  it('public-repo-guard.sh check-commits runs the same check', () => {
    const base = git('rev-parse', 'HEAD');
    const adding = commit('note.md', `see ${ID}\n`, 'add');
    commit('note.md', 'gone\n', 'remove');
    const r = run('bash', [ENTRY, 'check-commits', base, 'HEAD']);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`commit ${adding.slice(0, 9)} note.md:1:`);
  });
});

describe('the patch parser', () => {
  it('takes an added line whose content starts with ++ as content, by the hunk counts', () => {
    const diff = [
      'commit abc', '--- a/x', '+++ b/x', '@@ -0,0 +1,2 @@', '+++ not a header', '+second', '',
    ].join('\n');
    expect(addedLines(diff).map((a) => a.text)).toEqual(['++ not a header', 'second']);
  });

  it('refuses a line inside a hunk it cannot classify, instead of dropping it', () => {
    const diff = ['commit abc', '+++ b/x', '@@ -0,0 +1,1 @@', 'garbage', ''].join('\n');
    expect(() => addedLines(diff)).toThrow('unexpected line inside a hunk');
  });
});

describe('the pre-push hook checks what is pushed, not what is checked out', () => {
  function withScripts(): void {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(ENTRY, join(dir, 'scripts', 'public-repo-guard.sh'));
    copyFileSync(GUARD, join(dir, 'scripts', 'added-lines-guard.mjs'));
  }

  it('checks a pushed branch the caller is not standing on', () => {
    withScripts();
    const main = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', main);
    git('checkout', '-qb', 'feat');
    const tip = commit('note.md', `see ${ID}\n`, 'add');
    git('checkout', '-q', '-');
    const zero = '0'.repeat(40);
    const r = run('bash', [HOOK], `refs/heads/feat ${tip} refs/heads/feat ${zero}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('note.md:1: internal register id');
  });

  it('checks a branch the remote already has from the remote sha, so only the new commits', () => {
    withScripts();
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    const published = commit('note.md', `see ${ID}\n`, 'already on the remote');
    const tip = commit('note.md', 'see the reason\n', 'new');
    const r = run('bash', [HOOK], `refs/heads/x ${tip} refs/heads/x ${published}\n`);
    expect(r.code).toBe(0);
    expect(r.out).toContain('clean ✓ (1 commit(s)');
  });

  it('refuses a new branch when there is no origin/main, and names the fetch that fixes it', () => {
    withScripts();
    const r = run('bash', [HOOK], `refs/heads/x ${git('rev-parse', 'HEAD')} refs/heads/x ${'0'.repeat(40)}\n`);
    expect(r.code).toBe(2);
    expect(r.out).toContain('git fetch origin main:refs/remotes/origin/main');
  });

  it('refuses a new branch that shares no history with origin/main, and says so', () => {
    withScripts();
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '-q', '--orphan', 'alone');
    const tip = commit('alone.md', 'alone\n', 'alone');
    const r = run('bash', [HOOK], `refs/heads/alone ${tip} refs/heads/alone ${'0'.repeat(40)}\n`);
    expect(r.code).toBe(2);
    expect(r.out).toContain('shares no history with origin/main');
  });
});

describe('the pragma is an exception surface whose size is visible', () => {
  /**
   * Lines that carry `public-repo-guard:allow` outside the guards themselves. The
   * pragma exempts a line from both scans, so every new use is an exception the
   * reviewer has to read. The number is pinned so that growth is a visible change
   * to this file, made together with the reason, not a drift nobody notices.
   */
  const PINNED_PRAGMA_LINES = 10;
  const SELF = new Set([
    'scripts/public-repo-guard.sh', 'scripts/added-lines-guard.mjs',
    'tests/public-repo-guard.test.ts', 'tests/added-lines-guard.test.ts',
    '.github/workflows/public-repo-guard.yml', 'lefthook.yml', 'CLAUDE.md',
  ]);

  it(`stays at ${PINNED_PRAGMA_LINES} lines; raise it only with the reason on the new line`, () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const out = execFileSync('git', ['grep', '-I', '-c', 'public-repo-guard:allow', '--', '.'], {
      cwd: root, encoding: 'utf8',
    });
    const counts = out.split('\n').filter(Boolean).map((l) => {
      const at = l.lastIndexOf(':');
      return { path: l.slice(0, at), n: Number(l.slice(at + 1)) };
    });
    // Positive control: the guard's own file names the pragma, so the query reached the tree.
    expect(counts.some((c) => c.path === 'scripts/public-repo-guard.sh')).toBe(true);
    const used = counts.filter((c) => !SELF.has(c.path)).reduce((sum, c) => sum + c.n, 0);
    expect(used).toBe(PINNED_PRAGMA_LINES);
  });
});
