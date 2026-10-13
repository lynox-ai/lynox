/**
 * `scripts/lint-changed.mjs` and `.lefthook/pre-push/lint-changed.sh` — the pre-push eslint over the
 * files a push changes.
 *
 * END TO END against the real eslint config: a `--shared` clone of this repository (its own refs
 * and index; new objects go to the clone), with a committed `!= null` — the shape that turned #1305
 * and #1746 red in the merge queue. The failure paths of the lint itself are driven with a stub
 * eslint, because each of them is a way to check nothing and exit 0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error — plain .mjs script, no type declarations
import { selectFiles, changedPaths, lintSelected } from '../scripts/lint-changed.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts/lint-changed.mjs');
const HOOK = join(REPO, '.lefthook/pre-push/lint-changed.sh');
const SLOW = 240_000;

const GIT_ENV = {
  ...process.env,
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
} as NodeJS.ProcessEnv;

function gitIn(cwd: string) {
  return (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
}

describe('selectFiles', () => {
  it('takes .ts under src/ and .ts/.svelte under packages/web-ui/src/, never a test', () => {
    expect(selectFiles([
      'src/a.ts', 'src/a.test.ts', 'src/b.js', 'tests/c.ts', 'scripts/d.ts',
      'packages/web-ui/src/e.ts', 'packages/web-ui/src/F.svelte', 'packages/web-ui/src/g.test.ts',
      'packages/web-ui/h.ts', 'src/x.svelte', 'docs/src/y.ts',
    ])).toEqual(['src/a.ts', 'packages/web-ui/src/e.ts', 'packages/web-ui/src/F.svelte']);
  });
});

describe('changedPaths', () => {
  it('lists added, modified and renamed files (under the new name), not deleted ones, and a non-ASCII name as it is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-changed-paths-'));
    const git = gitIn(dir);
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/kept.ts'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'src/old.ts'), 'export const b = 1;\n');
      writeFileSync(join(dir, 'src/gone.ts'), 'export const c = 1;\n');
      git('init', '-q', '-b', 'main');
      // git's default, set here so a developer's config cannot hide the quoting.
      git('config', 'core.quotePath', 'true');
      git('add', '-A');
      git('commit', '-q', '-m', 'A');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'src/kept.ts'), 'export const a = 2;\n');
      writeFileSync(join(dir, 'src/zz-ü.ts'), 'export const u = 1;\n');
      git('mv', 'src/old.ts', 'src/new.ts');
      git('rm', '-q', 'src/gone.ts');
      git('add', '-A');
      git('commit', '-q', '-m', 'B');
      expect(changedPaths(dir, base, 'HEAD').sort()).toEqual(['src/kept.ts', 'src/new.ts', 'src/zz-ü.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** A stub with eslint's two methods; `opts` bends one of them. */
function stub(opts: { ignored?: boolean; throws?: boolean; results?: number; errors?: number } = {}) {
  return {
    isPathIgnored: async () => opts.ignored ?? false,
    lintFiles: async () => {
      if (opts.throws) throw new Error('Parsing error: boom');
      return Array.from({ length: opts.results ?? 1 }, () => ({ errorCount: opts.errors ?? 0, messages: [] }));
    },
  };
}
const lint = (eslint: unknown) => lintSelected(['src/a.ts', 'src/b.ts'], { root: REPO, eslint });

describe('lintSelected — every way to check nothing is a refusal', () => {
  it('sums the errors of every file', async () => {
    expect((await lint(stub({ errors: 2 }))).errorCount).toBe(4);
    expect((await lint(stub())).errorCount).toBe(0);
  });

  it('a selected file the config ignores is CannotCheck', async () => {
    await expect(lint(stub({ ignored: true }))).rejects.toThrow('drifted apart');
  });

  it('eslint throwing is CannotCheck', async () => {
    await expect(lint(stub({ throws: true }))).rejects.toThrow('eslint failed on src/a.ts');
  });

  it('a result count other than one per file is CannotCheck', async () => {
    await expect(lint(stub({ results: 0 }))).rejects.toThrow('returned 0 results');
  });
});

describe('end to end — a clone of this repository, the real eslint config', () => {
  let tmp: string;
  let clone: string;
  let git: (...args: string[]) => string;
  let base: string;
  let bad: string;
  let good: string;
  // A non-ASCII name on purpose: git prints it quoted unless the hook reads NUL-separated paths.
  const BAD_FILE = 'src/lint-changed-probé.ts';

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lint-changed-e2e-'));
    clone = join(tmp, 'clone');
    base = gitIn(REPO)('rev-parse', 'HEAD');
    gitIn(tmp)('clone', '-q', '--shared', '--no-checkout', REPO, clone);
    git = gitIn(clone);
    git('checkout', '-q', '--detach', base);
    for (const m of ['node_modules', 'packages/web-ui/node_modules']) {
      if (existsSync(join(REPO, m))) symlinkSync(join(REPO, m), join(clone, m));
    }
    writeFileSync(join(clone, BAD_FILE), 'export const lintChangedProbe = (x: unknown): boolean => x != null;\n');
    git('add', BAD_FILE);
    git('commit', '-q', '-m', 'planted');
    bad = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', base);
    writeFileSync(join(clone, 'src/lint-changed-clean.ts'), 'export const lintChangedClean = (x: unknown): boolean => x !== null;\n');
    git('add', 'src/lint-changed-clean.ts');
    git('commit', '-q', '-m', 'clean');
    good = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', bad);
  }, SLOW);
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  const lintRange = (from: string, to: string) => {
    const r = spawnSync(process.execPath, [SCRIPT, from, to], { cwd: clone, encoding: 'utf8', env: GIT_ENV });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('PLANTED: a committed `!= null` fails with eqeqeq — even with the fix sitting uncommitted in the working tree', () => {
    // The verdict is the commit's. An uncommitted fix must not make the pushed commit look clean.
    writeFileSync(join(clone, BAD_FILE), 'export const lintChangedProbe = (x: unknown): boolean => x !== null;\n');
    try {
      const r = lintRange(base, bad);
      expect(r.out).toContain('eqeqeq');
      expect(r.out).toContain(BAD_FILE);
      expect(r.code).toBe(1);
    } finally { git('checkout', '-q', '--', BAD_FILE); }
  }, SLOW);

  it('CLEAN: a commit without a finding passes, and says it linted', () => {
    const r = lintRange(base, good);
    expect(r.out).toContain('clean ✓ (1 changed file(s)');
    expect(r.code).toBe(0);
  }, SLOW);

  it('the hook lints the PUSHED ref, not the one you stand on, and leaves no worktree behind', () => {
    // Standing on `good`, pushing `bad`: the ref line names `bad`, measured from `base`, which the
    // remote already has.
    git('checkout', '-q', '--detach', good);
    try {
      const r = spawnSync('bash', [HOOK, 'origin', 'x'], {
        cwd: clone, encoding: 'utf8', env: GIT_ENV, input: `refs/heads/probe ${bad} refs/heads/probe ${base}\n`,
      });
      expect(`${r.stdout}${r.stderr}`).toContain('eqeqeq');
      expect(r.status).toBe(1);
      expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    } finally { git('checkout', '-q', '--detach', bad); }
  }, SLOW);

  it('Ctrl-C mid-lint leaves no temporary worktree registered', async () => {
    const child = spawn(process.execPath, [SCRIPT, base, bad], { cwd: clone, env: GIT_ENV, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((res) => child.on('exit', (_c, sig) => res(sig)));
    // Wait until the checkout exists, so the signal lands while it does.
    const deadline = Date.now() + 60_000;
    while (git('worktree', 'list').split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('the temporary checkout never appeared');
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill('SIGINT');
    expect(await exited).toBe('SIGINT');
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
  }, SLOW);

  it('a checkout that cannot be made is exit 2, and leaves nothing registered', () => {
    const r = spawnSync(process.execPath, [SCRIPT, base, bad], {
      cwd: clone, encoding: 'utf8', env: { ...GIT_ENV, TMPDIR: join(tmp, 'no-such-dir') },
    });
    expect(r.stderr).toContain('the temporary checkout could not be created');
    expect(r.status).toBe(2);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
  }, SLOW);

  it('a push that only deletes a ref lints nothing and passes', () => {
    const r = spawnSync('bash', [HOOK, 'origin', 'x'], {
      cwd: clone, encoding: 'utf8', env: GIT_ENV, input: `(delete) ${'0'.repeat(40)} refs/heads/probe ${base}\n`,
    });
    expect(r.status).toBe(0);
  }, SLOW);
});

describe('the CLI and its registration', () => {
  it('by hand, a base that does not resolve is exit 2 with the fetch that fixes it', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8', env: { ...GIT_ENV, LINT_CHANGED_BASE: 'no-such-ref/main' } });
    expect(r.stderr).toContain('git fetch origin main');
    expect(r.status).toBe(2);
  }, SLOW);

  it('a range that changes no source file is exit 0 and says so', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'HEAD', 'HEAD'], { cwd: REPO, encoding: 'utf8', env: GIT_ENV });
    expect(r.stdout).toContain('nothing to lint');
    expect(r.status).toBe(0);
  }, SLOW);

  it('lefthook runs it at pre-push as a SCRIPT with the pushed refs on stdin', () => {
    const cfg = parseYaml(readFileSync(join(REPO, 'lefthook.yml'), 'utf8')) as {
      'pre-push'?: { scripts?: Record<string, { use_stdin?: boolean }>; commands?: Record<string, unknown> };
    };
    expect(cfg['pre-push']?.scripts?.['lint-changed.sh']?.use_stdin).toBe(true);
    expect(cfg['pre-push']?.commands?.['lint-changed']).toBeUndefined();
  });
});
