/**
 * The run-group starter guard: an added line that starts something long-lived in the
 * engine's source must say how it stands to the run group, and a moved line is not added.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, STARTER_FORMS, countsMatch, inScope, main, parseDiff, parseNumstat, selfCheck, starterIn } from '../scripts/run-group-starter-guard.mjs';

const GUARD = fileURLToPath(new URL('../scripts/run-group-starter-guard.mjs', import.meta.url));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

let dir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir, env: GIT_ENV, encoding: 'utf8',
  }).trim();
}

function write(file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

function commit(message: string): string {
  git('add', '-A');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}

function guard(base: string, head: string): { code: number; out: string } {
  const r = spawnSync('node', [GUARD, base, head], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

// Each case builds real commits and spawns the guard; one took 11 s on a loaded box.
vi.setConfig({ testTimeout: 30_000 });

const INTERVAL ='  const timer = setInterval(() => { void poll(); }, 60_000);';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rgs-'));
  git('init', '-q');
  write('README.md', 'base\n');
  commit('base');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('an added starter must say how it stands to the run group', () => {
  it('refuses an unmarked setInterval added in the engine source, naming file, line and form', () => {
    const base = git('rev-parse', 'HEAD');
    write('src/core/poller.ts', `export function start(): void {\n${INTERVAL}\n}\n`);
    commit('add poller');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/core/poller.ts:2: setInterval');
  });

  it('passes the same line when runOutsideGroup is named, or with a marker on it or up to three lines above', () => {
    for (const [name, body] of [
      ['outside', `  runOutsideGroup(() => {\n${INTERVAL}\n  });`],
      ['same-line', `${INTERVAL} // ${MARKER} stopped in stop(), reports nothing`],
      ['three-above', `  // ${MARKER} the poll only enqueues; each job runs outside any group\n  const a = 1;\n  const b = 2;\n${INTERVAL}`],
    ]) {
      const base = git('rev-parse', 'HEAD');
      write(`src/core/${name}.ts`, `export function start(): void {\n${body}\n}\n`);
      commit(name);
      const r = guard(base, 'HEAD');
      expect(r.code, `${name}: ${r.out}`).toBe(0);
    }
  });

  it('a marker four lines above, or one without a reason, does not count', () => {
    for (const [name, body] of [
      ['four-above', `  // ${MARKER} too far away\n  const a = 1;\n  const b = 2;\n  const c = 3;\n${INTERVAL}`],
      ['no-reason', `${INTERVAL} // ${MARKER}`],
    ]) {
      const base = git('rev-parse', 'HEAD');
      write(`src/core/${name}.ts`, `export function start(): void {\n${body}\n}\n`);
      commit(name);
      const r = guard(base, 'HEAD');
      expect(r.code, `${name}: ${r.out}`).toBe(1);
    }
  });

  it('checks only the four engine directories and never tests', () => {
    const base = git('rev-parse', 'HEAD');
    write('src/server/poller.ts', `${INTERVAL}\n`);
    write('src/core/poller.test.ts', `${INTERVAL}\n`);
    write('scripts/poller.mjs', `${INTERVAL}\n`);
    commit('out of scope');
    expect(guard(base, 'HEAD').code).toBe(0);
    for (const d of ['src/core/', 'src/tools/', 'src/orchestrator/', 'src/integrations/']) {
      expect(inScope(`${d}a/b.ts`), d).toBe(true);
    }
    expect(inScope('src/core/a.spec.ts')).toBe(false);
    expect(inScope('src/core/__tests__/a.ts')).toBe(false);
    expect(inScope('src/core/__mocks__/a.ts')).toBe(false);
    expect(inScope('src/tools/fixtures/a.ts')).toBe(false);
  });
});

describe('a move is not new code', () => {
  it('stays quiet when a file with an unmarked starter is moved', () => {
    write('src/core/old/poller.ts', `export function start(): void {\n${INTERVAL}\n}\n`);
    const base = commit('existing poller');
    mkdirSync(join(dir, 'src/integrations'), { recursive: true });
    git('mv', 'src/core/old/poller.ts', 'src/integrations/poller.ts');
    commit('move');
    const r = guard(base, 'HEAD');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('clean — 3 added line(s) in scope');
  });

  it('stays quiet when the line is only re-indented, and when it moves in from outside the four directories', () => {
    write('src/core/poller.ts', `export function start(): void {\n${INTERVAL}\n}\n`);
    write('src/server/legacy.ts', `export const x = 1;\n  const t2 = setInterval(() => {}, 5);\n`);
    const base = commit('existing');
    write('src/core/poller.ts', `export function start(): void {\n  if (on) {\n    ${INTERVAL.trim()}\n  }\n}\n`);
    write('src/server/legacy.ts', 'export const x = 1;\n');
    write('src/tools/moved-in.ts', `  const t2 = setInterval(() => {}, 5);\n`);
    commit('re-indent and move in');
    const r = guard(base, 'HEAD');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/clean — [1-9]\d* added line\(s\) in scope/);
  });

  it('a move carries only as many lines as it removes: a second copy of the moved line is new', () => {
    write('src/core/old.ts', `${INTERVAL}\n`);
    const base = commit('existing');
    rmSync(join(dir, 'src/core/old.ts'));
    write('src/core/new.ts', `${INTERVAL}\n${INTERVAL}\n`);
    commit('move and duplicate');
    const r = guard(base, 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('1 added starter(s)');
  });
});

describe('what the matcher sees', () => {
  it('flags every listed form and skips comment lines', () => {
    const samples: Record<string, string> = {
      setInterval: 'setInterval(f, 1)',
      setTimeout: 'const t = setTimeout(f, 1);',
      setImmediate: 'setImmediate(f);',
      'process.nextTick': 'process.nextTick(f);',
      queueMicrotask: 'queueMicrotask(() => run());',
      'for (;;)': 'for (;;) {',
      'while (true)': 'while (true) {',
      'for await': 'for await (const m of stream) {',
      listener: 'emitter.on(\'data\', onData);',
      '.finally(': 'void job().finally(() => this.next());',
    };
    expect(Object.keys(samples).sort()).toEqual(STARTER_FORMS.map((f) => f.name).sort());
    for (const [name, text] of Object.entries(samples)) expect(starterIn(text), name).toBe(name);
    expect(starterIn('globalThis.setInterval(f, 1)')).toBe('setInterval');
    for (const c of ['// setInterval(f, 1)', ' * setInterval(f, 1)', '/* while (true) */']) expect(starterIn(c), c).toBeNull();
    expect(starterIn('const interval = settings.interval;')).toBeNull();
    // The queue that started its next job from the last one's .finally, as it was written.
    expect(starterIn('      void this._runJob(job).finally(() => {')).toBe('.finally(');
    expect(starterIn('/* boot */ setInterval(f, 1)')).toBe('setInterval');
  });

  it('reads a removed line that starts with dashes as content, not as a file header', () => {
    const diff = [
      'diff --git a/src/core/a.ts b/src/core/a.ts',
      '--- a/src/core/a.ts',
      '+++ b/src/core/a.ts',
      '@@ -1,2 +1,2 @@',
      '--- not a header',
      `+${INTERVAL}`,
    ].join('\n');
    const { added, removed } = parseDiff(diff);
    expect(added).toEqual([{ file: 'src/core/a.ts', line: 1, text: INTERVAL }]);
    expect(removed.get('-- not a header')).toBe(1);
  });

  it('the self-check that runs before every scan passes', () => {
    expect(selfCheck()).toBe(true);
  });
});

describe('paths and attributes do not hide a file', () => {
  it('reads a path with a space and a non-ASCII path', () => {
    const base = git('rev-parse', 'HEAD');
    write('src/core/sp ace.ts', `${INTERVAL}\n`);
    write('src/core/\u00fc.ts', `${INTERVAL}\n`);
    commit('odd paths');
    const r = guard(base, 'HEAD');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('src/core/sp ace.ts:1: setInterval');
    expect(r.out).toContain('src/core/\u00fc.ts:1: setInterval');
  });

  it('a path git has to quote is not passed as clean', () => {
    const base = git('rev-parse', 'HEAD');
    write('src/core/q"uote.ts', `${INTERVAL}\n`);
    commit('quoted path');
    const r = guard(base, 'HEAD');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain('did not read as git counts it');
  });

  it('a .gitattributes the change adds does not hide the lines', () => {
    const base = git('rev-parse', 'HEAD');
    write('.gitattributes', 'src/core/** -diff\n');
    write('src/core/attr.ts', `${INTERVAL}\n`);
    commit('attributes');
    const r = guard(base, 'HEAD');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('src/core/attr.ts:1: setInterval');
  });

  it('counts at the context size it reads at (a pair git aligns differently at -U0 and -U3)', () => {
    // Cut down from a real main commit: git counts 8 added at -U0 and 7 at the default.
    const fixture = (name: string): string =>
      readFileSync(fileURLToPath(new URL(`./fixtures/run-group-starter-guard/${name}`, import.meta.url)), 'utf8');
    write('src/core/context.ts', fixture('context-old.txt'));
    const base = commit('old');
    write('src/core/context.ts', fixture('context-new.txt'));
    commit('new');
    const r = guard(base, 'HEAD');
    expect(r.code, r.out).toBe(0);
  });

  it('the count comparison names a file it did not read, and nothing when it did', () => {
    const counts = new Map([['src/core/a.ts', 2], ['src/server/b.ts', 5]]);
    expect(countsMatch([], counts)).toEqual(['src/core/a.ts: git counts 2 added, read 0']);
    const two = [{ file: 'src/core/a.ts', line: 1, text: 'x' }, { file: 'src/core/a.ts', line: 2, text: 'y' }];
    expect(countsMatch(two, counts)).toEqual([]);
    expect(parseNumstat('2\t0\tsrc/core/sp ace.ts\0-\t-\tsrc/core/bin.ts\0')).toEqual(new Map([['src/core/sp ace.ts', 2], ['src/core/bin.ts', null]]));
    // A file git counts as binary must still have shown some line.
    expect(countsMatch([], new Map([['src/core/bin.ts', null]]))).toEqual(['src/core/bin.ts: git counts binary added, read 0']);
    expect(countsMatch(two.slice(0, 1).map((x) => ({ ...x, file: 'src/core/bin.ts' })), new Map([['src/core/bin.ts', null]]))).toEqual([]);
  });
});

describe('what it cannot check is not a pass', () => {
  it('a ref that does not resolve exits 2', () => {
    const r = guard('no-such-ref', 'HEAD');
    expect(r.code).toBe(2);
    expect(r.out).toContain('COULD NOT CHECK');
  });

  it('a range that changes nothing exits 2', () => {
    const r = guard('HEAD', 'HEAD');
    expect(r.code).toBe(2);
    expect(r.out).toContain('COULD NOT CHECK');
  });

  it('a failing self-check stops the scan with 2, even on a change it would pass', () => {
    const base = git('rev-parse', 'HEAD');
    write('README.md', 'changed\n');
    commit('change');
    const cwd = process.cwd();
    const errors: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      process.chdir(dir);
      expect(main([base, 'HEAD'])).toBe(0);
      expect(main([base, 'HEAD'], () => false)).toBe(2);
    } finally {
      process.chdir(cwd);
      console.error = error;
    }
    expect(errors.join('\n')).toContain('the self-check failed');
  });
});
