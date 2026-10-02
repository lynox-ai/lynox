/**
 * The guard that finds a deleted assertion, tested against real git history.
 *
 * ⭐ WHY A THROWAWAY REPO AND NOT A FIXTURE STRING. Every input this guard reads comes from git:
 * `--diff-filter=MD`, rename detection, the base version of a file. A fixture of diff text would
 * test my idea of what git prints, which is the mistake the guard itself is built to catch — so each
 * case commits real files and lets git produce the diff.
 *
 * ⚠ THE RUNNER IS INJECTED, and that is what makes the two directions testable at all. The shipped
 * path runs vitest; here a fake runner decides green or red per case, because the property under
 * test is *what the guard concludes from a green or a red run*, not whether vitest works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateFiles, isPureMove, movedLineSets, check } from '../scripts/deleted-assertion-guard.mjs';

let repo: string;
let cwd: string;

function sh(args: string[], where = repo): string {
  return execFileSync('git', args, { cwd: where, encoding: 'utf-8' });
}

function commit(files: Record<string, string | null>, message: string): string {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(repo, rel);
    if (body === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', message]);
  return sh(['rev-parse', 'HEAD']).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'delguard-'));
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.email', 't@example.test']);
  sh(['config', 'user.name', 'T']);
  cwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
});

const greenRunner = () => ({ ok: true, out: 'Tests  3 passed (3)' });
const redRunner = () => ({ ok: false, out: "error TS2345: Argument of type 'string' is not assignable" });

describe('deleted-assertion-guard', () => {
  it('finds the unnecessary deletion: the base test still passes against the new source', () => {
    const base = commit(
      { 'src/a.ts': 'export const f = (n: number) => n + 1;\n', 'src/a.test.ts': 'it("adds", () => {});\nit("rejects a negative", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'it("adds", () => {});\n' }, 'drop one assertion');

    const r = check({ base, head, runner: greenRunner, log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual(['src/a.test.ts']);
  });

  it('does NOT block a forced deletion — a red run is reported, not blamed', () => {
    const base = commit(
      { 'src/a.ts': 'export const f = (n: number) => n + 1;\n', 'src/a.test.ts': 'it("adds", () => {});\nit("rejects a negative", () => {});\n' },
      'base',
    );
    const head = commit(
      { 'src/a.ts': 'export const f = (s: string) => s.length;\n', 'src/a.test.ts': 'it("measures", () => {});\n' },
      'change the signature, drop the old assertion',
    );

    const r = check({ base, head, runner: redRunner, log: () => {} });
    // ⚠ THE POLARITY IS THE WHOLE POINT. Status 0 means the pull request is not blocked; the file
    // still appears under `forced` so a human reads it. Built the other way round, this exact case —
    // an honest signature change — would be the thing the guard stops.
    expect(r.status).toBe(0);
    expect(r.forced.map(([f]) => f)).toEqual(['src/a.test.ts']);
    expect(r.findings).toEqual([]);
  });

  it('counts a WHOLE deleted test file as a candidate — the case --diff-filter=ACMR would hide', () => {
    const base = commit(
      { 'src/a.ts': 'export const f = () => 1;\n', 'src/gone.test.ts': 'it("holds", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/gone.test.ts': null }, 'delete the test file');

    expect(candidateFiles(base, head)).toEqual(['src/gone.test.ts']);
    const r = check({ base, head, runner: greenRunner, log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual(['src/gone.test.ts']);
  });

  it('treats a RENAME as a move, not a deletion — git resolves it, so it is never a candidate', () => {
    const body = 'it("holds", () => {});\nit("also holds", () => {});\n';
    const base = commit({ 'src/a.ts': 'export const f = () => 1;\n', 'src/old.test.ts': body }, 'base');
    const head = commit({ 'src/old.test.ts': null, 'src/new.test.ts': body }, 'move the test file');

    expect(candidateFiles(base, head)).toEqual([]);
    const r = check({ base, head, runner: greenRunner, log: () => {} });
    expect(r.status).toBe(0);
    expect(r.reason).toBe('no-candidates');
  });

  it('resolves a rename even when the repo DISABLES rename detection — `-M` is load-bearing', () => {
    // ⚠ This case exists because a mutant survived without it. Dropping the explicit `-M` changed
    // nothing, since git's own `diff.renames` defaults to true — so the previous rename case could
    // not tell whether the protection came from this script or from a default anybody can switch
    // off. Here the repo switches it off, which makes `-M` the only thing left doing the work.
    sh(['config', 'diff.renames', 'false']);
    const body = 'it("holds", () => {});\nit("also holds", () => {});\n';
    const base = commit({ 'src/a.ts': 'export const f = () => 1;\n', 'src/old.test.ts': body }, 'base');
    const head = commit({ 'src/old.test.ts': null, 'src/new.test.ts': body }, 'move the test file');

    expect(candidateFiles(base, head)).toEqual([]);
  });

  it('treats lines MOVED to another file as a move — the shape that cost 101 false findings', () => {
    const moved = 'it("rejects a negative", () => {});\n';
    const base = commit(
      { 'src/a.ts': 'export const f = () => 1;\n', 'src/a.test.ts': `it("adds", () => {});\n${moved}` },
      'base',
    );
    // The line leaves a.test.ts and reappears byte-identically in b.test.ts.
    const head = commit({ 'src/a.test.ts': 'it("adds", () => {});\n', 'src/b.test.ts': moved }, 'split the file');

    expect(candidateFiles(base, head)).toContain('src/a.test.ts');
    const r = check({ base, head, runner: greenRunner, log: () => {} });
    expect(r.moves).toEqual(['src/a.test.ts']);
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('a partial move is NOT a move: one line comes back, another is gone for good', () => {
    const base = commit(
      {
        'src/a.ts': 'export const f = () => 1;\n',
        'src/a.test.ts': 'it("adds", () => {});\nit("comes back", () => {});\nit("gone for good", () => {});\n',
      },
      'base',
    );
    const head = commit(
      { 'src/a.test.ts': 'it("adds", () => {});\n', 'src/b.test.ts': 'it("comes back", () => {});\n' },
      'move one, delete one',
    );

    const { added } = movedLineSets(base, head);
    expect(isPureMove(base, head, 'src/a.test.ts', added)).toBe(false);
    const r = check({ base, head, runner: greenRunner, log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual(['src/a.test.ts']);
  });

  it('refuses on a TRACKED modification rather than touching uncommitted work, and does not block', () => {
    const base = commit(
      { 'src/a.ts': 'export const f = () => 1;\n', 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    // ⚠ A TRACKED file, deliberately. An untracked one is ignored by design (see the case below),
    // so probing with an untracked file would assert the rule this guard no longer has — which is
    // exactly what the first version of this test did.
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 99;\n', 'utf-8');

    const r = check({ base, head, runner: greenRunner, log: () => {} });
    expect(r.status).toBe(2);
    expect(r.reason).toBe('tree-dirty');
    expect(r.trackedDirty?.join('\n')).toContain('src/a.ts');
  });

  it('an UNTRACKED file does not stop it — refusing on one made the guard never run', () => {
    // ⚠ Found by running the real path, not by reading the code: the first version refused on any
    // porcelain output, so an untracked leftover produced exit 2. Exit 2 does not block, so the
    // guard would have been permanently silent while still counting as coverage.
    const base = commit(
      { 'src/a.ts': 'export const f = () => 1;\n', 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    writeFileSync(join(repo, 'untracked-leftover.log'), 'noise\n', 'utf-8');

    const r = check({ base, head, runner: greenRunner, log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual(['src/a.test.ts']);
  });

  it('restores the tree afterwards — the file it wrote to run is put back byte-identically', () => {
    const headBody = 'it("adds", () => {});\n';
    const base = commit(
      { 'src/a.ts': 'export const f = () => 1;\n', 'src/a.test.ts': 'it("adds", () => {});\nit("more", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': headBody }, 'drop one');

    check({ base, head, runner: greenRunner, log: () => {} });
    // ⚠ Measured against the tree, not against `git status`: a probe that reads status would pass
    // even if the content were restored from the index rather than from what was there.
    expect(execFileSync('cat', ['src/a.test.ts'], { cwd: repo, encoding: 'utf-8' })).toBe(headBody);
    expect(sh(['status', '--porcelain']).trim()).toBe('');
  });

  it('a non-test file losing lines is not a candidate — the floor is test files only', () => {
    const base = commit({ 'src/a.ts': 'export const f = () => 1;\nexport const g = () => 2;\n' }, 'base');
    const head = commit({ 'src/a.ts': 'export const f = () => 1;\n' }, 'drop g');
    expect(candidateFiles(base, head)).toEqual([]);
  });
});
