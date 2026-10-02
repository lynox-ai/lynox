/**
 * The reporter that notices vanished test cases, tested against real git history.
 *
 * ⭐ WHY A THROWAWAY REPO AND NOT FIXTURE STRINGS. Every input comes from git: the merge base,
 * `--diff-filter=MD`, rename detection, `-z` path quoting, the base version of a file. A fixture of
 * diff text would test my idea of what git prints — which is the mistake this guard exists to catch —
 * so each case commits real files and lets git produce the diff.
 *
 * ⚠ THE RUNNER IS INJECTED, and the fake mirrors the three states that matter: a plain `it(` is a
 * case that RAN and passed, `it.skip(` is skipped, `it.todo(` is todo. An earlier fake counted `it(`
 * only and answered in the runner's PROSE format, and that fake diverged from vitest in exactly the
 * three ways that hid real defects: it emitted no ANSI (so a text parse always worked, while in CI it
 * never did), it could not see `it.skip(` (so a skip-out looked like a drop under the fake and was
 * invisible in reality), and it returned success for every existing file. A fake must be wrong in
 * harmless ways, not in the ways the subject is wrong.
 *
 * ⛔ THE FIRST TEST IS THE REGRESSION TEST FOR A WRONG PREMISE. An earlier version asked "did this
 * diff remove test lines?", which every retitle answers yes to, and reported a finding for a pure
 * rename. If that test ever goes green again, the guard has gone back to blocking renames.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  removedFrom,
  addedTo,
  addedMultiset,
  diffContentLines,
  isPureMove,
  casesFor,
  render,
  reasonLine,
  mergeBase,
  check,
} from '../scripts/deleted-assertion-guard.mjs';

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

type Measurement = { ok: boolean; out: string; json: unknown };

/** One `assertionResults` entry per `it(` / `it.skip(` / `it.todo(` on disk, with its real state. */
function statesOf(src: string): string[] {
  const states: string[] = [];
  for (const m of src.matchAll(/\bit(\.skip|\.todo)?\(/g)) {
    states.push(m[1] === '.skip' ? 'skipped' : m[1] === '.todo' ? 'todo' : 'passed');
  }
  return states;
}

const measuring = (file: string): Measurement => {
  if (!existsSync(file)) return { ok: false, out: 'No test files found', json: null };
  const states = statesOf(readFileSync(file, 'utf-8'));
  return {
    ok: true,
    out: '',
    json: { testResults: [{ name: resolve(file), assertionResults: states.map((status) => ({ status })) }] },
  };
};

/**
 * A runner that cannot build ONE given body — the base version — and measures normally otherwise.
 *
 * ⚠ An earlier version of this fake failed for every call, so the HEAD run produced nothing and the
 * file was skipped before the base run happened: the test asserted a message the code never reached.
 * A fake that answers the same way for every input cannot test a comparison between two inputs.
 */
const unbuildableFor = (baseBody: string) => (file: string): Measurement => {
  if (!existsSync(file)) return { ok: false, out: 'No test files found', json: null };
  if (readFileSync(file, 'utf-8') === baseBody) {
    return { ok: false, out: 'FAIL  src/a.test.ts\nError: No "f" export is defined on the module\n', json: { testResults: [] } };
  }
  return measuring(file);
};

const listsEverything = (): string[] =>
  sh(['ls-files'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /\.(test|spec)\.tsx?$/.test(s));

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
const HEAD_AT = (): string => sh(['rev-parse', 'HEAD']).trim();

describe('deleted-assertion-guard', () => {
  it('a pure RETITLE is not a finding — the premise the first version got wrong', () => {
    const base = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'it("adds one", () => {});\nit("handles zero", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'it("adds 1", () => {});\nit("handles 0", () => {});\n' }, 'retitle only');

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    // ⛔ If this ever reads 1 again, the guard is back to blocking every rename.
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('reports a genuine deletion, with both numbers', () => {
    const base = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'drop one case');

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', basePassing: 3, headRunning: 2 }]);
  });

  it('a WHOLLY deleted test file reports with headRunning 0 — the case --diff-filter=ACMR hides', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/gone.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/gone.test.ts': null }, 'delete the file');

    const r = check({ base, head, measure: measuring, listFiles: () => ['src/gone.test.ts'], log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual([{ file: 'src/gone.test.ts', basePassing: 2, headRunning: 0 }]);
  });

  it('converting cases to it.skip IS a loss — a case that does not run is not coverage', () => {
    // ⛔ The runner's own total counts `skipped` and `todo`, so a version of this that read the total
    // saw 4 before and 4 after and logged "nothing was lost" while three cases stopped running.
    const base = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\nit("d", () => {});\n' },
      'base',
    );
    const head = commit(
      { 'src/a.test.ts': 'it("a", () => {});\nit.skip("b", () => {});\nit.skip("c", () => {});\nit.todo("d");\n' },
      'skip three of four',
    );

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', basePassing: 4, headRunning: 1 }]);
  });

  it('a file emptied of ALL its cases is reported, not skipped — the loudest form of the thing', () => {
    // An earlier version read "no count" from the runner's `Tests  no tests` and skipped this.
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'export const nothing = 1;\n' }, 'remove every case, keep the file');

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(1);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', basePassing: 2, headRunning: 0 }]);
  });

  it("a test's own stdout cannot forge the count — the number comes from the runner's JSON", () => {
    // ⛔ The head side is the pull-request author's side and `headRunning` is what suppresses a
    // finding. While the count was parsed out of the summary on stdout, one `console.log` inside a
    // test set it to 99 and silenced the whole file. The forged line is in `out` here on purpose.
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop two');
    const forging = (file: string): Measurement => ({ ...measuring(file), out: '      Tests  99 passed (99)\n' });

    const r = check({ base, head, measure: forging, listFiles: listsEverything, log: () => {} });
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', basePassing: 3, headRunning: 1 }]);
  });

  it('a base version the runner cannot build passes nothing, so it is skipped and never reported', () => {
    const baseBody = 'it("a", () => { f(1); });\nit("b", () => { f(2); });\n';
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': baseBody }, 'base');
    const head = commit({ 'src/a.ts': 'export const g = 1;\n', 'src/a.test.ts': 'it("a", () => { g; });\n' }, 'rename the export');

    const r = check({ base, head, measure: unbuildableFor(baseBody), listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.skipped[0][1]).toContain('no result for the base version');
  });

  it('casesFor picks the file BY PATH, so a filter that matched two files is not summed', () => {
    // The runner's path argument is a substring filter: `vitest run src/a.test.ts` also runs
    // `pkg/src/a.test.ts`. A run TOTAL would be the sum; the named entry is the answer.
    const json = {
      testResults: [
        { name: resolve('src/a.test.ts'), assertionResults: [{ status: 'passed' }, { status: 'failed' }] },
        { name: resolve('pkg/src/a.test.ts'), assertionResults: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }] },
      ],
    };
    expect(casesFor(json, 'src/a.test.ts')).toEqual({ ran: 2, passed: 1 });
    expect(casesFor(json, 'pkg/src/a.test.ts')).toEqual({ ran: 3, passed: 3 });
  });

  it('casesFor is null when the run produced no entry for the file, and skipped/todo never count as run', () => {
    expect(casesFor({ testResults: [] }, 'src/a.test.ts')).toBe(null);
    expect(casesFor(null, 'src/a.test.ts')).toBe(null);
    const mixed = {
      testResults: [
        {
          name: resolve('src/a.test.ts'),
          assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'todo' }, { status: 'failed' }],
        },
      ],
    };
    expect(casesFor(mixed, 'src/a.test.ts')).toEqual({ ran: 2, passed: 1 });
  });

  it('uses the MERGE BASE: a file only the base branch changed is not a candidate', () => {
    const forkPoint = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n', 'src/other.test.ts': 'it("x", () => {});\nit("y", () => {});\n' },
      'fork point',
    );
    sh(['checkout', '-q', '-b', 'pr']);
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\nit("b2", () => {});\n' }, 'retitle on the branch');
    sh(['checkout', '-q', 'main']);
    const mainTip = commit({ 'src/other.test.ts': 'it("x", () => {});\n' }, 'main deletes a case elsewhere');
    sh(['checkout', '-q', 'pr']);

    expect(mergeBase(mainTip, head)).toBe(forkPoint);
    const r = check({ base: mainTip, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    // ⛔ With a two-dot diff, main's deletion in other.test.ts would be reported against this branch.
    expect(r.candidates).not.toContain('src/other.test.ts');
  });

  it('a RENAME is resolved by git, even when the repo disables rename detection', () => {
    sh(['config', 'diff.renames', 'false']);
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    sh(['mv', 'src/a.test.ts', 'src/renamed.test.ts']);
    const head = commit({}, 'rename only');
    // Without `-M` this is D+A and the old path becomes a candidate reporting 2 → 0.
    expect(removedFrom(mergeBase(base, head), head)).toEqual([]);
  });

  it('lines moved to another file THE RUNNER RUNS are a move', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("holds", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("b", () => {});\n', 'src/b.test.ts': 'it("holds", () => {});\n' }, 'move one case');

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(r.moves).toEqual(['src/a.test.ts']);
    expect(r.findings).toEqual([]);
  });

  it('lines pasted into a file the runner does NOT run are a DELETION, not a move', () => {
    // ⛔ Measured: a test file whose whole text was pasted into an added markdown file was logged as
    // "every lost line is matched by an added one" while its cases were gone.
    const body = 'it("holds", () => {});\nit("also holds", () => {});\n';
    // ⚠ The destination is an EXISTING doc that keeps its own content. With the text pasted into a
    // NEW file, git called the pair `R072` — a rename of a test file into markdown — and
    // `--diff-filter=MD` then selected nothing at all, so the fixture was quietly testing the
    // registered rename gap instead of the move budget. Appending to a tracked file is both the
    // realistic shape and the one that reaches the code under test.
    const prose = ['# guide', '', 'Some prose that keeps this file recognisably itself.', ''].join('\n');
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': body, 'docs/guide.md': `${prose}\n` }, 'base');
    const head = commit({ 'src/a.test.ts': null, 'docs/guide.md': `${prose}\n\`\`\`ts\n${body}\`\`\`\n` }, 'paste it into docs');

    const r = check({ base, head, measure: measuring, listFiles: () => ['src/a.test.ts'], log: () => {} });
    expect(r.moves).toEqual([]);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', basePassing: 2, headRunning: 0 }]);
  });

  it('ONE budget for the whole run: a single added copy absolves ONE file, not five', () => {
    // ⛔ With a copy of the multiset per candidate, five files each losing the same line were all
    // absolved by the one copy the diff added — four cases gone, nothing reported, while the comment
    // above the function claimed a multiset prevented exactly that.
    const files: Record<string, string | null> = { 'src/a.ts': SRC };
    for (let i = 0; i < 5; i += 1) files[`src/t${String(i)}.test.ts`] = 'it("holds", () => {});\nit("keeps", () => {});\n';
    const base = commit(files, 'base');
    const head = commit(
      {
        ...Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`src/t${String(i)}.test.ts`, 'it("keeps", () => {});\n'])),
        'src/z.test.ts': 'it("holds", () => {});\n',
      },
      'one copy added, five lost',
    );

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(r.moves.length).toBe(1);
    expect(r.findings.length).toBe(4);
  });

  it('MULTIPLICITY inside one file: one added copy does not absolve five lost ones', () => {
    const five = 'it("x", () => {});\n'.repeat(5);
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': `${five}it("keep", () => {});\n` }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("x", () => {});\nit("keep", () => {});\n' }, 'keep one of five');

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(r.moves).toEqual([]);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', basePassing: 6, headRunning: 2 }]);
  });

  it('refuses on a TRACKED modification and reports which file', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    writeFileSync(join(repo, 'src/a.ts'), 'export const f = 2;\n', 'utf-8');

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(2);
    expect(r.reason).toBe('tree-dirty');
    expect(r.trackedDirty?.join(' ')).toContain('src/a.ts');
  });

  it('an UNTRACKED file does not stop it — refusing on one made the guard permanently silent', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    writeFileSync(join(repo, 'editor-leftover.txt'), 'x\n', 'utf-8');

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(1);
  });

  it('refuses when the CHECKED-OUT commit is not the head it was asked about', () => {
    // ⛔ The head side reads the working tree, the diff side reads the ref. Measured with the tree on
    // main and `head` at a branch tip: it compared head against head and reported nothing.
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n' }, 'base');
    sh(['checkout', '-q', '-b', 'pr']);
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop two');
    sh(['checkout', '-q', 'main']);

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, headCommit: HEAD_AT, log: () => {} });
    expect(r.status).toBe(2);
    expect(r.reason).toBe('head-mismatch');
    // and with the tree where it belongs, the same call reaches a verdict
    sh(['checkout', '-q', 'pr']);
    expect(check({ base, head, measure: measuring, listFiles: listsEverything, headCommit: HEAD_AT, log: () => {} }).status).toBe(1);
  });

  it('an EMPTY runner file list is ill health, not a clean repository', () => {
    // ⛔ `listFiles()` used to return `[]` whenever `vitest list` failed. Every candidate was then
    // skipped as "the runner does not run this file" and the run printed "nothing to report", green.
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');

    const r = check({ base, head, measure: measuring, listFiles: () => [], log: () => {} });
    expect(r.status).toBe(2);
    expect(r.reason).toBe('runner-list-empty');
  });

  it('a runner that cannot count an UNTOUCHED file is ill health — the positive control', () => {
    const base = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n', 'src/untouched.test.ts': 'it("u", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    const brokenRunner = (): Measurement => ({ ok: false, out: 'Error: Failed to load vite config', json: null });

    const r = check({ base, head, measure: brokenRunner, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(2);
    expect(r.reason).toBe('runner-unhealthy');
    expect(r.canary).toBe('src/untouched.test.ts');
  });

  it('a candidate that is not a test file by NAME costs no runner start', () => {
    const base = commit(
      { 'src/a.ts': 'const a = 1;\nconst b = 2;\n', 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n', 'src/u.test.ts': 'it("u", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.ts': 'const a = 1;\n' }, 'drop a source line only');
    const seen: string[] = [];
    const recording = (f: string): Measurement => { seen.push(f); return measuring(f); };

    const r = check({ base, head, measure: recording, listFiles: listsEverything, log: () => {} });
    expect(r.skipped).toEqual([['src/a.ts', 'not a test file by name']]);
    // ⛔ Only the positive control may have run. A runner start is ~20 s; twenty source files in a
    // diff put the job's 20-minute budget within reach of an ordinary refactor.
    expect(seen).toEqual(['src/a.test.ts']);
  });

  it('puts the file back byte-identically, measured against the TREE not against git status', () => {
    const body = 'it("a", () => {});\nit("b", () => {});\n';
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': body }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    const headBody = readFileSync(join(repo, 'src/a.test.ts'), 'utf-8');

    check({ base, head, measure: measuring, listFiles: listsEverything, log: () => {} });
    expect(readFileSync(join(repo, 'src/a.test.ts'), 'utf-8')).toBe(headBody);
  });

  it('leaves no file and no recreated DIRECTORY behind when the candidate was deleted at head', () => {
    // ⚠ git cannot represent an empty directory, so `git status --porcelain` is structurally unable
    // to see a directory this guard recreated to write a file into. Checked on the tree itself.
    const base = commit({ 'src/a.ts': SRC, 'nested/deep/gone.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'nested/deep/gone.test.ts': null }, 'delete the only file in the directory');
    // `git add -A` records the deletion but leaves the now-empty directory on disk; a fresh checkout
    // of this head would not have it, so the precondition is established rather than assumed.
    rmSync(join(repo, 'nested/deep'), { recursive: true, force: true });
    expect(existsSync(join(repo, 'nested/deep'))).toBe(false);

    const r = check({ base, head, measure: measuring, listFiles: () => ['nested/deep/gone.test.ts'], log: () => {} });
    expect(r.findings.length).toBe(1);
    expect(existsSync(join(repo, 'nested/deep/gone.test.ts'))).toBe(false);
    expect(existsSync(join(repo, 'nested/deep'))).toBe(false);
  });

  it('a diff reader must see content lines that BEGIN with -- or ++', () => {
    // ⛔ Judging the header by `startsWith('---')`/`'+++'` also swallows content. Measured: 2 of 3
    // removed lines and the only added line vanished, which both hides deletions and invents moves.
    const base = commit(
      { 'src/a.ts': SRC, 'src/a.test.ts': 'const css = `\n--color: red;\n--size: 2px;\n`;\nit("a", () => {});\nit("b", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'const css = `\n++plus: 1;\n`;\nit("a", () => {});\n' }, 'rewrite the literal');
    const mb = mergeBase(base, head);

    const lost = diffContentLines(['diff', '-M', `${mb}...${head}`, '--', 'src/a.test.ts'], '-');
    expect(lost).toContain('--color: red;');
    expect(lost).toContain('--size: 2px;');
    expect(diffContentLines(['diff', '-M', `${mb}...${head}`], '+')).toContain('++plus: 1;');
  });

  it('a NON-ASCII path survives the numstat, and a rename names its DESTINATION', () => {
    // ⛔ Without `-z`, git C-quotes the path and `git show <base>:<it>` throws — the file was then
    // skipped as "the merge base has no such file", a diagnosis that is false.
    const base = commit({ 'src/a.ts': SRC, 'src/grüß.test.ts': 'it("x", () => {});\nit("y", () => {});\n', 'src/r.test.ts': 'it("r", () => {});\n' }, 'base');
    sh(['mv', 'src/r.test.ts', 'src/renamed.test.ts']);
    const head = commit({ 'src/grüß.test.ts': 'it("x", () => {});\n', 'src/renamed.test.ts': 'it("r", () => {});\nit("r2", () => {});\n' }, 'head');
    const mb = mergeBase(base, head);

    expect(removedFrom(mb, head)).toContain('src/grüß.test.ts');
    expect(addedTo(mb, head)).toContain('src/renamed.test.ts');
    expect(addedTo(mb, head)).not.toContain('src/r.test.ts');
  });

  it('addedMultiset counts only where the runner looks', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\n' }, 'base');
    const head = commit({ 'src/b.test.ts': 'it("moved", () => {});\n', 'docs/x.md': 'it("moved", () => {});\n' }, 'two destinations');
    const mb = mergeBase(base, head);

    expect(addedMultiset(mb, head, (f) => f === 'src/b.test.ts').get('it("moved", () => {});')).toBe(1);
    expect(addedMultiset(mb, head, () => false).size).toBe(0);
  });

  it('isPureMove PUTS BACK what it took when the file turns out not to be a move', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("one", () => {});\nit("two", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': null }, 'delete it');
    const mb = mergeBase(base, head);
    const budget = new Map([['it("one", () => {});', 1]]); // enough for the first lost line only

    expect(isPureMove(mb, head, 'src/a.test.ts', budget)).toBe(false);
    // ⛔ Without the put-back, a failed match would starve the next candidate of a line it could use.
    expect(budget.get('it("one", () => {});')).toBe(1);
  });

  it("the runner's own verdict outranks a console line that merely SOUNDS like a failure", () => {
    const out = [
      'stderr | src/server/http-api.test.ts',
      '[http-api] push notifications unavailable: this.engine.getPushNotifier is not a function',
      'FAIL  src/server/http-api.test.ts > boots',
    ].join('\n');
    expect(reasonLine(out)).toBe('FAIL  src/server/http-api.test.ts > boots');
  });

  it('a GLYPH verdict is a verdict, and a progress separator is never the answer', () => {
    expect(reasonLine('× src/a.test.ts > boots 3ms\nsomething undefined here')).toBe('× src/a.test.ts > boots 3ms');
    // ⚠ The separator survives stripping its own glyphs as `[4/4]`, which has digits — so a filter
    // that only asked for letters-or-digits let it through. Measured on a real run.
    expect(reasonLine('collected the suite\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯')).toBe('collected the suite');
    expect(reasonLine('')).toBe('(the run produced no readable output)');
  });

  it('the EXIT CONTRACT: a verdict line on 0 and on 1, never on 2', () => {
    // \u26d4 Nothing exercised this before, which is exactly why the workflow shipped with its
    // polarity inverted. The workflow treats an exit code arriving WITHOUT its verdict line as ill
    // health, so dropping the line from the report path turns every finding red \u2014 the one outcome
    // the design forbids \u2014 and dropping it from the clean path turns every clean run red.
    const report = render({ status: 1, reason: 'checked', findings: [{ file: 'src/a.test.ts', basePassing: 3, headRunning: 1 }], skipped: [], moves: [], candidates: ['src/a.test.ts'] });
    expect(report.code).toBe(1);
    expect(report.lines.join('\n')).toContain('VERDICT report');
    expect(report.lines.join('\n')).toContain('3 case(s) passed before, 1 run now');

    const clean = render({ status: 0, reason: 'checked', findings: [], skipped: [], moves: [], candidates: ['src/a.test.ts'] });
    expect(clean.code).toBe(0);
    expect(clean.lines.join('\n')).toContain('VERDICT clean');

    const none = render({ status: 0, reason: 'no-candidates', findings: [], skipped: [], moves: [], candidates: [] });
    expect(none.code).toBe(0);
    expect(none.lines.join('\n')).toContain('VERDICT clean');

    for (const reason of ['tree-dirty', 'head-mismatch', 'runner-list-empty', 'runner-unhealthy', 'tree-unreadable']) {
      const ill = render({ status: 2, reason, trackedDirty: ['M src/a.ts'] });
      expect(ill.code).toBe(2);
      // \u26d4 A crash must not be able to wear a verdict. If it could, the workflow would believe it.
      expect(ill.lines.join('\n')).not.toContain('VERDICT');
      expect(ill.lines[0]).not.toBe(reason); // every reason has a sentence, not just its key
    }
  });

  it('only cases that PASSED count on the base side — a partly broken base must not invent a loss', () => {
    // ⛔ A mutation round found this with no witness at all: comparing what the base RAN instead of
    // what it PASSED survived every test, because in every other fixture the base passes completely.
    // It is not academic — it is the ordinary shape of a refactor, and it was measured on real
    // history: a renamed export left 4 of 8 base cases passing while the head ran 6, so `ran` would
    // have reported "8 before, 6 now" for a pull request that lost nothing.
    const baseBody = 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\nit("d", () => {});\n';
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': baseBody }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n' }, 'drop one');
    const partlyBroken = (file: string): Measurement => {
      if (!existsSync(file)) return { ok: false, out: 'No test files found', json: null };
      if (readFileSync(file, 'utf-8') === baseBody) {
        const states = ['passed', 'passed', 'failed', 'failed'];
        return { ok: false, out: 'FAIL  src/a.test.ts', json: { testResults: [{ name: resolve(file), assertionResults: states.map((status) => ({ status })) }] } };
      }
      return measuring(file);
    };

    const r = check({ base, head, measure: partlyBroken, listFiles: listsEverything, log: () => {} });
    // 2 of the base's 4 cases still hold; 3 run at head. Nothing held that stopped running.
    expect(r.findings).toEqual([]);
    expect(r.status).toBe(0);
  });

  it('a diff reader must RESET between files, or the next file\'s header reads as content', () => {
    // ⛔ Also a survivor with no witness: the `@@`/`diff --git` state machine stays "inside a hunk"
    // across a file boundary unless it is reset, and the following file's `+++ b/<path>` line then
    // enters the result as an added line `++ b/<path>`.
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\nit("x", () => {});\n', 'src/b.test.ts': 'it("y", () => {});\n' }, 'two files gain lines');
    const mb = mergeBase(base, head);

    const added = diffContentLines(['diff', '-M', `${mb}...${head}`], '+');
    expect(added).toContain('it("x", () => {});');
    expect(added).toContain('it("y", () => {});');
    expect(added.filter((l) => l.includes('b/src/'))).toEqual([]);
  });

  it('a true RENAME record names the destination, not the source', () => {
    // ⛔ The third survivor. An earlier fixture meant to pin this used a two-line file, which git
    // classified as add+delete rather than a rename — so the branch that resolves a rename pair was
    // never executed and the test asserted nothing about it. git needs real similarity: ten lines
    // kept and one added is `R091`, and only then does `--numstat -z` emit the pair form.
    const ten = Array.from({ length: 10 }, (_, i) => `it("case ${String(i)}", () => {});`).join('\n');
    const base = commit({ 'src/a.ts': SRC, 'src/long.test.ts': `${ten}\n` }, 'base');
    sh(['mv', 'src/long.test.ts', 'src/moved.test.ts']);
    const head = commit({ 'src/moved.test.ts': `${ten}\nit("extra", () => {});\n` }, 'rename and add one');
    expect(sh(['diff', '-M', '--name-status', `${base}`, `${head}`])).toContain('R0');

    const mb = mergeBase(base, head);
    expect(addedTo(mb, head)).toContain('src/moved.test.ts');
    expect(addedTo(mb, head)).not.toContain('src/long.test.ts');
  });

  it('a bad ref THROWS rather than returning a verdict — main turns that into exit 2', () => {
    commit({ 'src/a.ts': SRC }, 'base');
    expect(() => mergeBase('deadbeefdeadbeef', 'cafebabecafebabe')).toThrow();
  });

  it("the WORKFLOW's exit mapping is executed, and a code without a VERDICT line is ill health", () => {
    // ⛔ Two measured defects live here. GitHub invokes a `run:` block as `bash -e {0}`, so `-e` is on
    // before the block's own `set` runs: with a bare call followed by `CODE=$?` the step aborted the
    // instant the guard exited non-zero — the `case` never ran, nothing was printed, and the job went
    // RED on a finding. And an exit code alone cannot tell a verdict from a crash: node exits 1 for a
    // module-load failure too, so a pull request deleting this script made the job announce a finding
    // nobody had measured. Nothing short of RUNNING the block sees either.
    const ymlPath = fileURLToPath(new URL('../.github/workflows/deleted-assertion-guard.yml', import.meta.url));
    const yml = readFileSync(ymlPath, 'utf-8').split('\n');
    const starts = yml.flatMap((l, i) => (l.trim() === 'run: |' ? [i] : []));
    const body: string[] = [];
    let indent: number | null = null;
    for (const l of yml.slice(starts[starts.length - 1] + 1)) {
      if (l.trim() === '') { body.push(''); continue; }
      const ind = l.length - l.trimStart().length;
      if (indent === null) indent = ind;
      if (ind < indent) break;
      body.push(l.slice(indent));
    }
    const block = body.join('\n');
    // Positive control on the EXTRACTION. Without it a silently empty block passes every assertion
    // below: `bash -e` on nothing exits 0, which reads exactly like "nothing to report".
    expect(block).toContain('case "$CODE" in');
    expect(body.some((l) => l.startsWith('env:') || l.startsWith('- name:'))).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'ghstep-'));
    const cases: Array<[number, string | null, number, string]> = [
      [0, 'VERDICT clean', 0, 'nothing to report'],
      [1, 'VERDICT report', 0, '::warning::'],
      [2, null, 1, '::error::'],
      [127, null, 1, '::error::'],
      [1, null, 1, '::error::'], // a crash wearing a finding's exit code
      [0, null, 1, '::error::'], // exit 0 without reaching a conclusion
    ];
    for (const [code, sentinel, wantStatus, wantMarker] of cases) {
      // ⚠ No space in the name: the substitution lands in an unquoted command position, so
      // `stub-0-VERDICT clean.sh` ran as two words and the step failed for a reason the test invented.
      const tag = `${String(code)}-${(sentinel ?? 'none').replace(/\W+/g, '_')}`;
      const stub = join(dir, `stub-${tag}.sh`);
      writeFileSync(stub, `${sentinel === null ? '' : `printf '%s\\n' 'deleted-assertion-guard: ${sentinel}'\n`}exit ${String(code)}\n`, 'utf-8');
      // ⚠ Only the COMMAND is substituted. Replacing to end of line swallowed the trailing
      // `|| CODE=$?` once, so the probe rebuilt the broken form and reported its own doing.
      const replaced = block.replace(/node scripts\/deleted-assertion-guard\.mjs/m, `bash ${stub}`);
      expect(replaced).not.toBe(block);
      expect(replaced).toContain('|| CODE=$?');
      const sh2 = join(dir, `step-${tag}.sh`);
      writeFileSync(sh2, replaced, 'utf-8');
      const r = spawnSync('bash', ['-e', sh2], { encoding: 'utf-8', env: { ...process.env, BASE_SHA: 'b', HEAD_SHA: 'h' } });
      const out = `${r.stdout}${r.stderr}`;
      expect({ code, sentinel, status: r.status, out: out.slice(0, 160) }).toMatchObject({ status: wantStatus });
      expect(out).toContain(wantMarker);
    }
    rmSync(dir, { recursive: true, force: true });
    expect(readdirSync(tmpdir()).length).toBeGreaterThan(0);
  });
});
