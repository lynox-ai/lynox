/**
 * The commit scan of the public-repo guard: the lines each commit in a range adds.
 *
 * Every marker here is assembled at runtime, so this file adds no line the scan
 * would refuse — it is itself scanned when it is pushed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLines, findingsIn, formatCharsIn, wayFor } from '../scripts/added-lines-guard.mjs';

const GUARD = fileURLToPath(new URL('../scripts/added-lines-guard.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('../scripts/public-repo-guard.sh', import.meta.url));
const HOOK = fileURLToPath(new URL('../.lefthook/pre-push/public-repo-guard-commits.sh', import.meta.url));
const RANGES = fileURLToPath(new URL('../.lefthook/pre-push/pushed-ranges.sh', import.meta.url));
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
    mkdirSync(join(dir, '.lefthook', 'pre-push'), { recursive: true });
    copyFileSync(RANGES, join(dir, '.lefthook', 'pre-push', 'pushed-ranges.sh'));
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

describe('a raw invisible character in an added line', () => {
  // Every such character here is written as its escape, so this file carries none raw.
  const RLO = '\u202E';
  const NUL = '\0';

  function commitBytes(file: string, bytes: Buffer, message: string): string {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), bytes);
    git('add', '--', file);
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  }

  it('refuses one, naming the file, the line, the code point and the escape, never the character', () => {
    const base = git('rev-parse', 'HEAD');
    const adding = commit('t.ts', `ok\nconst s = 'a${RLO}b';\n`, 'add');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`commit ${adding.slice(0, 9)} t.ts:2: raw invisible character U+202E, write \\u202E`);
    expect(r.out).toContain('write its escape instead');
    expect(r.out).not.toContain(RLO);
  });

  it('passes the escape, which is the same string at runtime', () => {
    const base = git('rev-parse', 'HEAD');
    commit('t.ts', "const s = 'a\\u202Eb';\n", 'escaped');
    expect(guard(base, 'HEAD').code).toBe(0);
  });

  it('is not let through by the pragma, which a direction control could rearrange', () => {
    const base = git('rev-parse', 'HEAD');
    commit('t.ts', `const s = 'a${RLO}b'; // public-repo-guard:allow: test\n`, 'pragma');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('U+202E');
  });

  it('refuses a NUL byte and the control in a source file, and in a file without an extension', () => {
    const base = git('rev-parse', 'HEAD');
    commitBytes('src/a.ts', Buffer.from(`const s = 'x${NUL}y${RLO}z';\n`, 'utf8'), 'ts with a NUL');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('U+0000');
    expect(r.out).toContain('U+202E');
    const base2 = git('rev-parse', 'HEAD');
    commitBytes('Makefile', Buffer.from(`x${NUL}y\n`, 'utf8'), 'no extension');
    const r2 = guard(base2, 'HEAD');
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('U+0000');
  });

  it('reads a file named as an image like any other', () => {
    const base = git('rev-parse', 'HEAD');
    commitBytes('img/b.png', Buffer.from(`x${RLO}y\n`, 'utf8'), 'png without a NUL');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('img/b.png:1: raw invisible character U+202E');
  });

  it('refuses a binary file whose bytes hold one, by chance or not, and says how to go on', () => {
    // Bytes as an image or a font holds them, among them a NUL and, by chance, the UTF-8 of U+061C.
    const base = git('rev-parse', 'HEAD');
    commitBytes('img/a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0xd8, 0x9c, 0xff, 0x0a]), 'image bytes');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('img/a.png:1: raw invisible character U+0000');
    expect(r.out).toContain('U+061C');
    expect(r.out).toContain('a binary file cannot be added or changed past this check today');
    expect(r.out).not.toContain('approval by hash');
  });

  it('refuses code hidden behind a NUL in a file named as an image, which a symlink can load as source', () => {
    const base = git('rev-parse', 'HEAD');
    commitBytes('x.png', Buffer.from(`//${NUL}\nmodule.exports = 'a${RLO}b';\n`, 'utf8'), 'image name, code inside');
    symlinkSync('x.png', join(dir, 'x.ts'));
    git('add', '-A');
    git('commit', '-qm', 'link a source name to it');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('x.png:2: raw invisible character U+202E');
  });

  it('refuses the same file when it is meant for require, which loads an unknown extension as JavaScript', () => {
    const base = git('rev-parse', 'HEAD');
    commitBytes('lib/x.png', Buffer.from(`//${NUL}\nmodule.exports = 'a${RLO}b';\n`, 'utf8'), 'image name, a NUL in its first line');
    commit('lib/use.js', "module.exports = require('./x.png');\n", 'load it');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('lib/x.png:2: raw invisible character U+202E');
  });

  it('refuses it in the commit that added it, so dropping the NUL in place later does not help', () => {
    const base = git('rev-parse', 'HEAD');
    const adding = commitBytes('y.png', Buffer.from(`${NUL}\nconst s = 'a${RLO}b';\n`, 'utf8'), 'with a NUL');
    commitBytes('y.png', Buffer.from(`const s = 'a${RLO}b';\n`, 'utf8'), 'NUL dropped in place');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`commit ${adding.slice(0, 9)} y.png:2: raw invisible character U+202E`);
  });

  it('reads a verbatim copy of a file from before the range as added, line for line', () => {
    commit('c.md', `x${RLO}y\nsecond\n`, 'legacy, before the range');
    const base = git('rev-parse', 'HEAD');
    copyFileSync(join(dir, 'c.md'), join(dir, 'c.ts'));
    git('add', '-A');
    git('commit', '-qm', 'verbatim copy');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('c.ts:1: raw invisible character U+202E');
    expect(r.out).not.toContain('c.md');
  });

  it('refuses a line break anywhere in a file name, also at its end', () => {
    for (const name of ['x.ts\r', 'a\nb.ts']) {
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, name), 'ok\n');
      git('add', '-A');
      git('commit', '-qm', 'odd name');
      const r = guard(base, 'HEAD');
      expect(r.code, JSON.stringify(name)).toBe(1);
      expect(r.out).toContain('in the file name');
    }
  });

  it('does not check removed lines: a commit taking one out is not refused', () => {
    commit('t.ts', `const s = 'a${RLO}b';\n`, 'legacy');
    const base = git('rev-parse', 'HEAD');
    commit('t.ts', "const s = 'a\\u202Eb';\n", 'escape it');
    expect(guard(base, 'HEAD').code).toBe(0);
  });

  it('reads a file name, also of a file that adds no line, and prints it escaped', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, `x${RLO}gpj.ts`), '');
    git('add', '-A');
    git('commit', '-qm', 'empty file, odd name');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('x\\u202Egpj.ts: raw invisible character U+202E in the file name');
    expect(r.out).not.toContain(RLO);
  });

  it('reads the new name of a renamed file, which adds no line', () => {
    commit('plain.ts', 'one\ntwo\nthree\n', 'plain name');
    const base = git('rev-parse', 'HEAD');
    git('mv', 'plain.ts', `p${RLO}.ts`);
    git('commit', '-qm', 'rename only');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('p\\u202E.ts: raw invisible character U+202E in the file name');
    expect(r.out).not.toContain(RLO);
  });

  it('prints the name of a file with another finding escaped too', () => {
    const base = git('rev-parse', 'HEAD');
    commit(`n${RLO}.md`, `see ${ID}\n`, 'id in an odd name');
    const r = guard(base, 'HEAD');
    expect(r.out).toContain(`n\\u202E.md:1: internal register id`);
    expect(r.out).not.toContain(RLO);
  });

  it('gives the escape hint only when an invisible character was found', () => {
    const base = git('rev-parse', 'HEAD');
    commit('note.md', `see ${ID}\n`, 'id only');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('write its escape instead');
  });

  it('knows one code point of every range, so older Unicode data in the runtime cannot shrink the set unnoticed', () => {
    const pinned = [
      0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f, 0x200b, 0x200c, 0x200e, 0x200f,
      0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0x206a, 0x206f, 0x3164, 0xfe00, 0xfe0e, 0xfeff,
      0xffa0, 0xfff9, 0xfffb, 0x1bca0, 0x1d173, 0xe0001, 0xe0020, 0xe007f, 0xe0100, 0xe01ef, 0x0000,
      // Format characters of scripts and of later Unicode versions, and unassigned default-ignorables.
      0x0600, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd, 0x110cd, 0x13430, 0x1343f,
      0xfff0, 0xfff8, 0xe0000, 0xe0002, 0xe0080, 0xe00ff, 0xe01f0, 0xe0fff,
    ];
    for (const cp of pinned) {
      const name = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      expect(formatCharsIn(`a${String.fromCodePoint(cp)}b`), name).toEqual([name]);
    }
    // Visible neighbours are not invisible characters.
    for (const cp of [0x0020, 0x00a0, 0x061b, 0x200a, 0x2010, 0x202f, 0x3000, 0xfefe, 0xac00]) {
      expect(formatCharsIn(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toEqual([]);
    }
    expect(formatCharsIn('\uFEFFfirst line')).toEqual(['U+FEFF']);
    expect(formatCharsIn(`a${RLO}b${RLO}c\u2066d`)).toEqual(['U+202E', 'U+2066']);
  });

  it('names the escaped way for a soft hyphen and the line terminators', () => {
    expect(wayFor('U+00AD')).toBe('write \\u00AD in a string, &shy; in markup');
    expect(wayFor('U+2028')).toBe('write \\u2028');
    expect(wayFor('U+E0041')).toBe('write \\u{E0041}');
  });

  it('allows a carriage return only at the end of a line', () => {
    expect(formatCharsIn('a line from a CRLF file\r')).toEqual([]);
    expect(formatCharsIn('a\rb')).toEqual(['U+000D']);
  });

  it('lets a zero-width joiner pass only between emoji, checked per joiner', () => {
    // The sequences two test files at main carry raw: a family of three, and a kiss with skin tones.
    expect(formatCharsIn('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toEqual([]);
    expect(formatCharsIn('\u{1F469}\u{1F3FD}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}\u{1F3FB}')).toEqual([]);
    // The presentation selector before the joiner, and the next emoji after it.
    expect(formatCharsIn('\u2764\uFE0F\u200D\u{1F525}')).toEqual([]);
  });

  it('refuses a zero-width joiner between letters, at a line edge, two in a row, and between pictographs that are letters of a name', () => {
    expect(formatCharsIn('a\u200Db')).toEqual(['U+200D']);
    expect(formatCharsIn('\u{1F469}\u200D')).toEqual(['U+200D']);
    expect(formatCharsIn('\u200D\u{1F469}')).toEqual(['U+200D']);
    expect(formatCharsIn('\u{1F468}\u200D\u200D\u{1F469}')).toEqual(['U+200D']);
    expect(formatCharsIn('a\u200D\u{1F469}')).toEqual(['U+200D']);
    expect(formatCharsIn('\u{1F469}\u200Db')).toEqual(['U+200D']);
    // U+2139 is pictographic and an identifier character: two of them joined read as one name.
    expect(formatCharsIn('\u2139\u200D\u2139')).toEqual(['U+200D']);
  });

  it('lets the emoji presentation selector pass only after a pictograph or in a keycap', () => {
    expect(formatCharsIn('\u2764\uFE0F')).toEqual([]);
    expect(formatCharsIn('1\uFE0F\u20E3')).toEqual([]);
    expect(formatCharsIn('a\uFE0F')).toEqual(['U+FE0F']);
    expect(formatCharsIn('1\uFE0F')).toEqual(['U+FE0F']);
    expect(formatCharsIn('\u2139\uFE0F')).toEqual(['U+FE0F']);
  });

  it('lets tag characters pass only in the three recommended subdivision flags', () => {
    const flag = (code: string) => `\u{1F3F4}${[...code].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join('')}\u{E007F}`;
    expect(formatCharsIn(`flags ${flag('gbsct')} ${flag('gbeng')} ${flag('gbwls')} end`)).toEqual([]);
    // Hidden text spelled in tags is refused, also in lower case inside a flag-shaped sequence.
    expect(formatCharsIn(flag('ignorepreviousinstructions'))).toContain('U+E0069');
    expect(formatCharsIn(flag('gbabc'))).toContain('U+E0061');
    expect(formatCharsIn(flag('gb'))).toEqual(['U+E0067', 'U+E0062', 'U+E007F']);
    expect(formatCharsIn('\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}')).toEqual(['U+E0067', 'U+E0062', 'U+E0073', 'U+E0063', 'U+E0074']);
    expect(formatCharsIn('x\u{E0067}\u{E007F}')).toEqual(['U+E0067', 'U+E007F']);
    expect(formatCharsIn('\u{1F3F4}\u{E0041}\u{E007F}')).toEqual(['U+E0041', 'U+E007F']);
  });

  it('keeps the id check apart: an id with a direction control inside is still read as the id', () => {
    expect(findingsIn(ID.replace('F-', `F${RLO}-`))).toEqual(['internal register id']);
  });
});
