/**
 * The run-group starter guard: an added line that starts something long-lived in the
 * engine's source must say how it stands to the run group, and a moved line is not added.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, STARTER_FORMS, inScope, parseDiff, selfCheck, starterIn } from '../scripts/run-group-starter-guard.mjs';

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

const INTERVAL = '  const timer = setInterval(() => { void poll(); }, 60_000);';

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

  it('passes the same line under runOutsideGroup, or with a marker on it or up to three lines above', () => {
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
      '.finally(() => this.': 'void job().finally(() => this.next());',
    };
    expect(Object.keys(samples).sort()).toEqual(STARTER_FORMS.map((f) => f.name).sort());
    for (const [name, text] of Object.entries(samples)) expect(starterIn(text), name).toBe(name);
    expect(starterIn('globalThis.setInterval(f, 1)')).toBe('setInterval');
    for (const c of ['// setInterval(f, 1)', ' * setInterval(f, 1)', '/* while (true) */']) expect(starterIn(c), c).toBeNull();
    expect(starterIn('const interval = settings.interval;')).toBeNull();
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
});
