/**
 * The reporter that notices vanished test cases, tested against real git history.
 *
 * ⭐ WHY A THROWAWAY REPO AND NOT FIXTURE STRINGS. Every input comes from git: the merge base,
 * `--diff-filter=MD`, rename detection, the base version of a file. A fixture of diff text would
 * test my idea of what git prints — which is the mistake this guard exists to catch — so each case
 * commits real files and lets git produce the diff.
 *
 * ⚠ THE RUNNER IS INJECTED, and the fake is deliberately a COUNTER: it reads the file and reports
 * how many `it(` it sees, in the runner's own summary format. The property under test is what the
 * guard concludes from two counts, not how vitest arrives at one.
 *
 * ⛔ THE FIRST TEST IS THE REGRESSION TEST FOR A WRONG PREMISE. An earlier version asked "did this
 * diff remove test lines?", which every retitle answers yes to, and reported a finding for a pure
 * rename. If that test ever goes green again, the guard has gone back to blocking renames.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removedFrom, isPureMove, addedMultiset, caseCount, reasonLine, mergeBase, check } from '../scripts/deleted-assertion-guard.mjs';

let repo: string;
let cwd: string;

function sh(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

function put(rel: string, body: string | null): void {
  const abs = join(repo, rel);
  if (body === null) {
    rmSync(abs, { force: true });
    return;
  }
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
}

function commit(files: Record<string, string | null>, message: string): string {
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', message]);
  return sh(['rev-parse', 'HEAD']).trim();
}

/** Counts `it(` in whatever is on disk and answers in the runner's summary format. */
const counting = (file: string): { ok: boolean; out: string } => {
  if (!existsSync(file)) return { ok: false, out: 'No test files found' };
  const n = (readFileSync(file, 'utf-8').match(/\bit\(/g) ?? []).length;
  return { ok: true, out: ` Test Files  1 passed (1)\n      Tests  ${String(n)} passed (${String(n)})\n` };
};
/**
 * A runner that fails only for a GIVEN body — the base version — and counts normally otherwise.
 *
 * ⚠ The first version of this fake failed for every call, so the HEAD run collected nothing and the
 * file was skipped before the base run happened: the test asserted a message the code never reached.
 * A fake that answers the same way for every input cannot test a comparison between two inputs.
 */
const failingFor = (baseBody: string) => (file: string): { ok: boolean; out: string } => {
  if (!existsSync(file)) return { ok: false, out: 'No test files found' };
  if (readFileSync(file, 'utf-8') === baseBody) {
    return { ok: false, out: ' FAIL  src/a.test.ts\nError: No "f" export is defined on the module\n' };
  }
  return counting(file);
};
const listsEverything = (): string[] => {
  const out = sh(['ls-files']).split('\n').map((s) => s.trim());
  return out.filter((s) => /\.(test|spec)\.tsx?$/.test(s));
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'delrep-'));
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

const SRC = 'export const f = (n: number) => n + 1;\n';

describe('deleted-assertion-guard', () => {
  it('a pure RETITLE is not a finding — the premise the first version got wrong', () => {
    const base = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'it("adds one", () => {});\nit("rejects a negative", () => {});\n' },
      'base',
    );
    // Same two cases, both rewritten. Lines are removed; coverage is not.
    const head = commit(
      { 'src/a.test.ts': 'it("adds 1 to its argument", () => {});\nit("refuses a negative input", () => {});\n' },
      'retitle both',
    );

    const r = check({ base, head, runFile: counting, listFiles: listsEverything, log: () => {} });
    // ⛔ If this ever reads 1 again, the guard is back to blocking every rename.
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.candidates).toContain('src/a.test.ts');
  });

  it('reports a genuine deletion, with both counts', () => {
    const base = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'drop one case');

    const r = check({ base, head, runFile: counting, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', baseCount: 3, headCount: 2 }]);
  });

  it('a WHOLLY deleted test file reports with headCount 0 — the case --diff-filter=ACMR hides', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/gone.test.ts': 'it("x", () => {});\nit("y", () => {});\n' }, 'base');
    const head = commit({ 'src/gone.test.ts': null }, 'delete the file');

    expect(removedFrom(mergeBase(base, head), head)).toEqual(['src/gone.test.ts']);
    const r = check({ base, head, runFile: counting, listFiles: () => ['src/gone.test.ts'], log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings[0]).toMatchObject({ file: 'src/gone.test.ts', baseCount: 2, headCount: 0 });
  });

  it('a base version that FAILS against the new source is skipped, never reported', () => {
    const baseBody = 'it("a", () => {});\nit("b", () => {});\n';
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': baseBody }, 'base');
    const head = commit(
      { 'src/a.ts': 'export const g = (s: string) => s.length;\n', 'src/a.test.ts': 'it("a", () => {});\n' },
      'change the signature',
    );

    const r = check({ base, head, runFile: failingFor(baseBody), listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.skipped[0]?.[0]).toBe('src/a.test.ts');
    expect(r.skipped[0]?.[1]).toContain('the removal was forced');
  });

  it('a file the RUNNER does not run is skipped — the eight Playwright specs', () => {
    const base = commit(
      { 'src/a.ts': SRC, 'tests/smoke/ui.spec.ts': 'it("a", () => {});\nit("b", () => {});\n' },
      'base',
    );
    const head = commit({ 'tests/smoke/ui.spec.ts': 'it("a", () => {});\n' }, 'drop one');

    // ⚠ The runner must FAIL on it, the way vitest really does on a Playwright spec. A fake that
    // succeeds let a mutant survive: with the first list check removed, the second one still caught
    // the file, so the verdict was identical and only the MESSAGE differed. Asserting the exact
    // reason is what pins the first check — the one that stops a pointless run from happening.
    const playwrightUnderVitest = (): { ok: boolean; out: string } => ({
      ok: false,
      out: " FAIL  tests/smoke/ui.spec.ts\nError: Playwright Test did not expect test() to be called here\n",
    });
    const r = check({ base, head, runFile: playwrightUnderVitest, listFiles: () => [], log: () => {} });
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.skipped[0]?.[1]).toContain("runner's own file list");
    expect(r.skipped[0]?.[1]).not.toContain('collected no cases');
  });

  it('uses the MERGE BASE: a file only the base branch changed is not a candidate', () => {
    const base0 = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\n', 'src/other.test.ts': 'it("x", () => {});\nit("y", () => {});\n' },
      'fork point',
    );
    // The PR branch touches only a.test.ts.
    sh(['checkout', '-q', '-b', 'pr']);
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\nit("a2", () => {});\n' }, 'add a case on the branch');
    // main meanwhile REMOVES a case from other.test.ts — nothing to do with this PR.
    sh(['checkout', '-q', 'main']);
    const mainTip = commit({ 'src/other.test.ts': 'it("x", () => {});\n' }, 'main drops a case elsewhere');
    sh(['checkout', '-q', 'pr']);

    expect(mergeBase(mainTip, head)).toBe(base0);
    // Against the merge base the PR removed nothing; a two-dot diff would have shown other.test.ts.
    expect(removedFrom(mergeBase(mainTip, head), head)).toEqual([]);
    // ⚠ The contrast needs a RAW two-dot diff. An earlier version of this line called
    // `removedFrom(mainTip, head)` to show what the old form would have caught — but that function
    // is three-dot by construction now, so the assertion tested the new code against the old
    // expectation and failed for the right reason.
    const twoDot = execFileSync('git', ['diff', '-M', '--diff-filter=MD', '--numstat', `${mainTip}..${head}`], { cwd: repo, encoding: 'utf-8' });
    expect(twoDot).toContain('src/other.test.ts');
    const r = check({ base: mainTip, head, runFile: counting, listFiles: listsEverything, log: () => {} });
    expect(r.reason).toBe('no-candidates');
  });

  it('a RENAME is resolved by git, even when the repo disables rename detection', () => {
    sh(['config', 'diff.renames', 'false']);
    const body = 'it("holds", () => {});\nit("also holds", () => {});\n';
    const base = commit({ 'src/a.ts': SRC, 'src/old.test.ts': body }, 'base');
    const head = commit({ 'src/old.test.ts': null, 'src/new.test.ts': body }, 'move the file');

    // ⚠ `diff.renames=false` is the point: without it the git DEFAULT does the work, and the test
    // would pass with `-M` removed from the script.
    expect(removedFrom(mergeBase(base, head), head)).toEqual([]);
  });

  it('lines moved to ANOTHER file are a move', () => {
    const moved = 'it("rejects a negative", () => {});\n';
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': `it("adds", () => {});\n${moved}` }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("adds", () => {});\n', 'src/b.test.ts': moved }, 'split');

    const r = check({ base, head, runFile: counting, listFiles: listsEverything, log: () => {} });
    expect(r.moves).toEqual(['src/a.test.ts']);
    expect(r.findings).toEqual([]);
  });

  it('MULTIPLICITY: one added copy does not absolve five lost ones', () => {
    const dup = 'expect(x).toBe(1);\n';
    const base = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': `it("a", () => {});\n${dup.repeat(5)}` },
      'base',
    );
    // One copy reappears in another file; four are gone for good.
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n', 'src/b.test.ts': dup }, 'keep one copy');

    const mb = mergeBase(base, head);
    expect(isPureMove(mb, head, 'src/a.test.ts', addedMultiset(mb, head))).toBe(false);
  });

  it('refuses on a TRACKED modification and reports which file', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    put('src/a.ts', 'export const f = (n: number) => n + 99;\n');

    const r = check({ base, head, runFile: counting, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(2);
    expect(r.reason).toBe('tree-dirty');
    expect(r.trackedDirty?.join('\n')).toContain('src/a.ts');
  });

  it('an UNTRACKED file does not stop it — refusing on one made the guard permanently silent', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    put('leftover.log', 'noise\n');

    const r = check({ base, head, runFile: counting, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(1);
  });

  it('puts the file back byte-identically, measured against the TREE not against git status', () => {
    const headBody = 'it("a", () => {});\n';
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': headBody }, 'drop one');

    check({ base, head, runFile: counting, listFiles: listsEverything, log: () => {} });
    expect(readFileSync(join(repo, 'src/a.test.ts'), 'utf-8')).toBe(headBody);
    expect(sh(['status', '--porcelain']).trim()).toBe('');
  });

  it('leaves no file behind when the candidate was deleted at head', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/gone.test.ts': 'it("x", () => {});\n' }, 'base');
    const head = commit({ 'src/gone.test.ts': null }, 'delete it');

    check({ base, head, runFile: counting, listFiles: () => ['src/gone.test.ts'], log: () => {} });
    expect(existsSync(join(repo, 'src/gone.test.ts'))).toBe(false);
    expect(sh(['status', '--porcelain']).trim()).toBe('');
  });

  it('reads the count from the runner summary, and null when nothing was collected', () => {
    expect(caseCount('      Tests  12 passed (12)\n')).toBe(12);
    expect(caseCount('      Tests  1 failed | 10 passed (11)\n')).toBe(11);
    expect(caseCount('No test files found, exiting with code 1')).toBe(0);
    expect(caseCount('some unrelated output')).toBe(null);
  });

  it('the reported reason is the ERROR, never a progress separator', () => {
    const real = [
      'RUN  v4.1.7',
      '',
      'src/core/a.test.ts > does a thing  Error: No "getAudioDurationSec" export is defined',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯',
      ' Test Files  1 failed (1)',
      '   Duration  812ms',
    ].join('\n');
    expect(reasonLine(real)).toContain('No "getAudioDurationSec" export is defined');
  });

  it('a bad ref THROWS rather than returning a verdict — main turns that into exit 2', () => {
    commit({ 'src/a.ts': SRC }, 'base');
    // ⛔ The point is that it throws here. An earlier version let the throw reach node's default
    // exit of 1, which the workflow announced as a finding nobody had measured.
    expect(() => mergeBase('deadbeefdeadbeef', 'cafebabecafebabe')).toThrow();
  });
});
