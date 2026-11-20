/**
 * Tests for scripts/symlink-guard.mjs, the check that no commit in a pull request adds a link whose
 * target is absolute or leads out of the tree (a worktree's `node_modules` link, committed with the
 * machine's paths in it). Each case builds a real repository with real link commits and runs the
 * script as CI does, so the positive control is a commit the guard must turn red.
 *
 * The same file lives in the other repository; the two copies differ only in the script path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/symlink-guard.mjs', import.meta.url));
// Imported as well as run: the rule itself is tested on its own, and a script that does not load
// fails this whole file rather than one case.
const { linkProblem } = await import(pathToFileURL(SCRIPT).href) as { linkProblem: (target: string) => string | null };

/** Git exports `GIT_DIR` and friends inside hooks; left in place they point the fixture at this repository. */
const CLEAN_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } as NodeJS.ProcessEnv;

let dir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd: dir, env: CLEAN_ENV, encoding: 'utf8' }).trim();
}

function commitAll(message: string): string {
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
}

function guard(base: string, head: string): { status: number | null; out: string; err: string } {
  const r = spawnSync('node', [SCRIPT, 'check', base, head], { cwd: dir, env: CLEAN_ENV, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symlink-guard-'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'x\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('linkProblem', () => {
  it('refuses an absolute target', () => {
    expect(linkProblem('/home/x/node_modules')).toBe('absolute');
  });

  it('refuses a backslash, a colon or a control character: Windows paths, and text behind a NUL', () => {
    expect(linkProblem('C:\\Users\\x\\node_modules')).toBe('unusual');
    expect(linkProblem('C:/Users/x')).toBe('unusual');
    expect(linkProblem('C:foo')).toBe('unusual');
    expect(linkProblem('\\\\server\\share')).toBe('unusual');
    expect(linkProblem('..\\..\\home\\u')).toBe('unusual');
    expect(linkProblem('ok\u0000/home/u/secret')).toBe('unusual');
  });

  it('refuses any target that climbs with "..", wherever the ".." stands', () => {
    expect(linkProblem('../other/node_modules')).toBe('climbs');
    expect(linkProblem('d/d/../outside')).toBe('climbs');
    expect(linkProblem('./..')).toBe('climbs');
    expect(linkProblem('a/..')).toBe('climbs');
  });

  it('CONTROL: lets a relative target without ".." pass, names that only start with dots included', () => {
    expect(linkProblem('docs/guide.md')).toBeNull();
    expect(linkProblem('./docs')).toBeNull();
    expect(linkProblem('a//b')).toBeNull();
    expect(linkProblem('...')).toBeNull();
    expect(linkProblem('..hidden/x')).toBeNull();
  });
});

describe('symlink-guard', () => {
  it('turns red on a commit that adds a node_modules link with an absolute target, and does not print the target', () => {
    const base = commitAll('base');
    symlinkSync('/home/someone/projects/checkout-of-another-worktree/node_modules', join(dir, 'node_modules'));
    const head = commitAll('add a link');
    // The fixture really holds a link blob: mode 120000.
    expect(git('ls-tree', head, 'node_modules')).toMatch(/^120000 blob /);
    const r = guard(base, head);
    expect(r.status).toBe(1);
    expect(r.err).toContain('"node_modules"');
    expect(r.err).toContain('an absolute target');
    expect(r.err + r.out).not.toContain('/home/someone');
    expect(r.err + r.out).not.toContain('checkout-of-another-worktree');
  });

  it('turns red on a link whose relative target climbs out of the tree', () => {
    const base = commitAll('base');
    mkdirSync(join(dir, 'pkg'));
    symlinkSync('../../elsewhere/node_modules', join(dir, 'pkg', 'node_modules'));
    const head = commitAll('add a link out of the tree');
    const r = guard(base, head);
    expect(r.status).toBe(1);
    expect(r.err).toContain('"pkg/node_modules"');
    expect(r.err).toContain('a target that climbs with ".."');
  });

  it('turns red on a link added and removed again on the branch: the history still holds it', () => {
    const base = commitAll('base');
    symlinkSync('/abs/node_modules', join(dir, 'node_modules'));
    commitAll('add');
    rmSync(join(dir, 'node_modules'));
    const head = commitAll('remove');
    expect(guard(base, head).status).toBe(1);
  });

  it('turns red on a file changed into a link', () => {
    writeFileSync(join(dir, 'conf'), 'x\n');
    const base = commitAll('base');
    rmSync(join(dir, 'conf'));
    symlinkSync('/etc/passwd', join(dir, 'conf'));
    const head = commitAll('file to link');
    expect(guard(base, head).status).toBe(1);
  });

  it('turns red on a link a merged side brings in, once, in the side\'s commit', () => {
    const base = commitAll('base');
    git('checkout', '-q', '-b', 'side');
    symlinkSync('/abs/node_modules', join(dir, 'node_modules'));
    commitAll('side adds a link');
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'other.md'), 'y\n');
    commitAll('main moves');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    const head = git('rev-parse', 'HEAD');
    const r = guard(base, head);
    expect(r.status).toBe(1);
    // Read once, in the side's commit: the merge itself adds nothing against both parents.
    expect(r.err.match(/adds the link/g)).toHaveLength(1);
  });

  it('turns red on a link only the merge commit itself introduces', () => {
    const base = commitAll('base');
    git('checkout', '-q', '-b', 'side');
    writeFileSync(join(dir, 'side.md'), 's\n');
    commitAll('side moves');
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'other.md'), 'y\n');
    commitAll('main moves');
    git('merge', '-q', '--no-ff', '--no-commit', 'side');
    symlinkSync('/abs/node_modules', join(dir, 'node_modules'));
    git('add', '-A');
    git('commit', '-q', '-m', 'merge with a link');
    const head = git('rev-parse', 'HEAD');
    const r = guard(base, head);
    expect(r.status).toBe(1);
    expect(r.err).toContain('"node_modules"');
  });

  it('turns red on a link whose target changes to an absolute one', () => {
    symlinkSync('docs', join(dir, 'link'));
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.md'), 'a\n');
    const base = commitAll('base with an inside link');
    rmSync(join(dir, 'link'));
    symlinkSync('/abs/elsewhere', join(dir, 'link'));
    const head = commitAll('retarget');
    expect(git('diff-tree', '-r', '--no-commit-id', '--name-status', head)).toMatch(/^M\tlink$/m);
    expect(guard(base, head).status).toBe(1);
  });

  it('turns red on a link that would lead out through another link, in a later commit than that link', () => {
    // `e` alone stays inside while `d` is a directory; once `d` is a link to `.`, it leads out.
    // The rule needs neither commit to see the other: `e` climbs with "..".
    mkdirSync(join(dir, 'd', 'd'), { recursive: true });
    writeFileSync(join(dir, 'd', 'd', 'x'), 'x\n');
    const base = commitAll('base');
    symlinkSync('d/d/../../outside', join(dir, 'e'));
    commitAll('e');
    rmSync(join(dir, 'd'), { recursive: true });
    symlinkSync('.', join(dir, 'd'));
    const head = commitAll('d becomes a link');
    const r = guard(base, head);
    expect(r.status).toBe(1);
    expect(r.err).toContain('"e" with a target that climbs with ".."');
    // `d -> .` itself climbs nowhere and is not reported.
    expect(r.err).not.toContain('"d"');
  });

  it('CONTROL: stays green on links with relative targets without ".."', () => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'guide.md'), 'g\n');
    const base = commitAll('base');
    mkdirSync(join(dir, 'a'), { recursive: true });
    symlinkSync('docs/guide.md', join(dir, 'guide.md'));
    symlinkSync('./b', join(dir, 'a', 'link'));
    const head = commitAll('a link inside');
    const r = guard(base, head);
    expect(r.status).toBe(0);
    expect(r.out).toContain('symlink-guard: clean — 1 commit(s) read');
  });

  it('CONTROL: stays green on commits without links, and reads only base..head', () => {
    symlinkSync('/abs/old', join(dir, 'old-link'));
    // A link already on the base is not this branch's doing.
    const base = commitAll('base with an old link');
    writeFileSync(join(dir, 'b.md'), 'b\n');
    const head = commitAll('plain change');
    const r = guard(base, head);
    expect(r.status).toBe(0);
    expect(r.out).toContain('1 commit(s) read');
  });

  it('fails with exit 2 on a range git cannot read', () => {
    commitAll('base');
    expect(guard('no-such-ref', 'HEAD').status).toBe(2);
  });

  it('still checks when run through a symlinked directory, instead of exiting 0 without a word', () => {
    const base = commitAll('base');
    symlinkSync('/abs/node_modules', join(dir, 'node_modules'));
    const head = commitAll('add a link');
    const linked = mkdtempSync(join(tmpdir(), 'symlink-guard-via-'));
    try {
      symlinkSync(dirname(SCRIPT), join(linked, 'scripts'));
      const r = spawnSync('node', [join(linked, 'scripts', 'symlink-guard.mjs'), 'check', base, head], { cwd: dir, env: CLEAN_ENV, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('"node_modules"');
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });
});
