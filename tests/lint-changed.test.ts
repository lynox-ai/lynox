/**
 * `scripts/lint-changed.mjs` — the pre-push eslint over the files a branch changes.
 *
 * The positive control runs the REAL eslint config of this repository on a real source file with
 * a `!= null` added: the shape that turned #1305 and #1746 red in the merge queue. The failure
 * paths are driven with a stub eslint, because each of them is a way to check nothing and exit 0.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error — plain .mjs script, no type declarations
import { selectFiles, changedPaths, lintSelected, CannotCheck } from '../scripts/lint-changed.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts/lint-changed.mjs');
const SLOW = 120_000;

const GIT_ENV = {
  ...process.env,
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
} as NodeJS.ProcessEnv;

describe('selectFiles', () => {
  it('takes .ts under src/ and .ts/.svelte under packages/web-ui/src/, never a test', () => {
    expect(selectFiles([
      'src/a.ts', 'src/a.test.ts', 'src/b.js', 'tests/c.ts', 'scripts/d.ts',
      'packages/web-ui/src/e.ts', 'packages/web-ui/src/F.svelte', 'packages/web-ui/src/g.test.ts',
      'packages/web-ui/h.ts', 'src/x.svelte', 'docs/src/y.ts',
    ])).toEqual(['src/a.ts', 'packages/web-ui/src/e.ts', 'packages/web-ui/src/F.svelte']);
  });
});

describe('changedPaths — from the fork, not from main\'s tip', () => {
  it('reads what the branch changed, not what main changed since, and counts a rename by its new name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-changed-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/kept.ts'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'src/old.ts'), 'export const b = 1;\n');
      writeFileSync(join(dir, 'src/gone.ts'), 'export const c = 1;\n');
      writeFileSync(join(dir, 'src/shared.ts'), 'export const s = 1;\n');
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'A');
      git('branch', 'lane');
      writeFileSync(join(dir, 'src/main-only.ts'), 'export const m = 1;\n');
      // Main edits a file the lane never touches: diffed against main's tip it reads as the lane's.
      writeFileSync(join(dir, 'src/shared.ts'), 'export const s = 2;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'main moves on');
      git('checkout', '-q', 'lane');
      writeFileSync(join(dir, 'src/kept.ts'), 'export const a = 2;\n');
      git('mv', 'src/old.ts', 'src/new.ts');
      git('rm', '-q', 'src/gone.ts');
      git('add', '-A');
      git('commit', '-q', '-m', 'lane');
      expect(changedPaths(dir, 'main').sort()).toEqual(['src/kept.ts', 'src/new.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a base that does not resolve is CannotCheck, not an empty list', () => {
    expect(() => changedPaths(REPO, 'no-such-ref/main')).toThrow(CannotCheck);
  });
});

/** A stub with eslint's two methods; `opts` bends one of them. */
function stub(opts: { ignored?: boolean; throws?: boolean; results?: number; errors?: number } = {}) {
  return {
    isPathIgnored: async () => opts.ignored ?? false,
    lintText: async () => {
      if (opts.throws) throw new Error('Parsing error: boom');
      return Array.from({ length: opts.results ?? 1 }, () => ({ errorCount: opts.errors ?? 0, messages: [] }));
    },
  };
}
const lint = (eslint: unknown, files = ['src/a.ts', 'src/b.ts']) => lintSelected(files, { root: REPO, eslint, read: () => 'x' });

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

describe('positive control — the real config on a real file', () => {
  it('a `!= null` in src/tools/builtin/bulk.ts fails on eqeqeq; the file as it is does not', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: REPO });
    const file = 'src/tools/builtin/bulk.ts';
    const real = readFileSync(join(REPO, file), 'utf8');
    const planted = `${real}\nexport const lintChangedProbe = (x: unknown): boolean => x != null;\n`;
    const bad = await lintSelected([file], { root: REPO, eslint, read: () => planted });
    const line = planted.split('\n').length - 1;
    expect(bad.results[0].messages.filter((m: { ruleId: string | null }) => m.ruleId === 'eqeqeq').map((m: { line: number }) => m.line)).toEqual([line]);
    expect(bad.errorCount).toBeGreaterThan(0);
    const good = await lintSelected([file], { root: REPO, eslint, read: () => real });
    expect(good.results[0].messages.filter((m: { ruleId: string | null }) => m.ruleId === 'eqeqeq')).toEqual([]);
  }, SLOW);
});

describe('the CLI and its registration', () => {
  it('a base that does not resolve is exit 2 with the fetch that fixes it', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...GIT_ENV, LINT_CHANGED_BASE: 'no-such-ref/main' } });
    expect(r.stderr).toContain('git fetch origin main');
    expect(r.status).toBe(2);
  }, SLOW);

  it('nothing changed is exit 0 and says so', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...GIT_ENV, LINT_CHANGED_BASE: 'HEAD' } });
    expect(r.stdout).toContain('nothing to lint');
    expect(r.status).toBe(0);
  }, SLOW);

  it('lefthook runs it at pre-push', () => {
    const cfg = parseYaml(readFileSync(join(REPO, 'lefthook.yml'), 'utf8')) as {
      'pre-push'?: { commands?: Record<string, { run?: string }> };
    };
    expect(cfg['pre-push']?.commands?.['lint-changed']?.run).toBe('node scripts/lint-changed.mjs');
  });
});
