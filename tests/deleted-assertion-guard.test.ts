/**
 * The reporter that notices vanished test cases, tested against real git history.
 *
 * ⭐ WHY A THROWAWAY REPO AND NOT FIXTURE STRINGS. Every input comes from git: the merge base,
 * `--diff-filter=MD`, rename detection, `-z` path quoting, the base version of a file. A fixture of
 * diff text would test my idea of what git prints — which is the mistake this guard exists to catch —
 * so each case commits real files and lets git produce the diff.
 *
 * ⚠ THE RUNNER IS INJECTED, and the fake models the shapes that decide verdicts: a case name per
 * `it(`/`test(`, `skipped` for `.skip`, `todo` for `.todo`, every case `skipped` when the file gates
 * its whole suite (`describe.skip`/`skipIf`), and — for a file the runner cannot collect — an entry
 * with NO cases, which is what real vitest produces and what one gate round proved the guard was
 * mis-reading. What it does NOT model: `it.each` expansion, and a commented-out `it(`. Both inflate
 * the base side, which is the conservative direction; `vitestMeasure` is measured against the real
 * runner in its own test below, because that is where the guard's one fatal defect lived.
 *
 * ⛔ THE FIRST TWO TESTS ARE THE REGRESSION TESTS FOR THE SAME WRONG PREMISE, TWICE. Version one
 * asked "did this diff remove test LINES?", which every retitle answers yes to. Version three asked
 * "does every case NAME still run?", which every retitle also answers no to. The count is what is
 * retitle-immune, so the count triggers and the names attribute.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import {
  removedFrom,
  addedTo,
  fileResults,
  mergeBase,
  check,
  render,
  reasonLine,
  restoreInFlight,
  vitestMeasure,
  vitestRoster,
} from '../scripts/deleted-assertion-guard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
type Case = { fullName: string; status: string };

function casesOf(src: string): Case[] {
  const gated = /describe\.skip\(|describe\.skipIf\(\s*true\s*\)/.test(src);
  const out: Case[] = [];
  for (const m of src.matchAll(/\b(?:it|test)(\.\w+)?\(\s*['"]([^'"]+)['"]/g)) {
    const mod = m[1] ?? '';
    const status = gated || mod === '.skip' ? 'skipped' : mod === '.todo' ? 'todo' : 'passed';
    out.push({ fullName: m[2], status });
  }
  return out;
}

function entryFor(file: string): { name: string; assertionResults: Case[] } {
  return { name: resolve(file), assertionResults: casesOf(readFileSync(file, 'utf-8')) };
}

const measuring = (files: string[]): Measurement => ({
  ok: true,
  out: '',
  json: { testResults: files.filter((f) => existsSync(f)).map(entryFor) },
});

/**
 * A runner that cannot COLLECT one given body — the shape real vitest produces for a broken import or
 * a syntax error: an entry for the file with an empty `assertionResults`.
 *
 * ⚠ An earlier fake returned `testResults: []` for this, i.e. no entry at all. That is a shape real
 * vitest never produces, and modelling it that way is exactly why the positive control's "an entry
 * exists" predicate looked sufficient for two rounds.
 */
const collectFailureFor = (body: string) => (files: string[]): Measurement => ({
  ok: false,
  out: 'FAIL  src/a.test.ts\nError: Failed to resolve import "./f.js"\n',
  json: {
    testResults: files.filter((f) => existsSync(f)).map((f) => (readFileSync(f, 'utf-8') === body ? { name: resolve(f), assertionResults: [] } : entryFor(f))),
  },
});

const listsEverything = (): string[] =>
  sh(['ls-files'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /\.(test|spec)\.tsx?$/.test(s));

function freshRepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'delrep-'));
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.email', 't@example.test']);
  sh(['config', 'user.name', 'T']);
  process.chdir(repo);
}

beforeEach(() => {
  cwd = process.cwd();
  freshRepo();
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
});

const SRC = 'export const f = (n: number) => n + 1;\n';
const CONTROL = { 'src/control.test.ts': 'it("control holds", () => {});\n' };
const HEAD_AT = (): string => sh(['rev-parse', 'HEAD']).trim();
const run = (base: string, head: string, measure = measuring, listFiles = listsEverything): ReturnType<typeof check> =>
  check({ base, head, measure, listFiles, log: () => {} });

describe('deleted-assertion-guard', () => {
  it('a pure RETITLE is not a finding — the premise two versions in a row got wrong', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("adds one", () => {});\nit("handles zero", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("adds 1", () => {});\nit("handles 0", () => {});\n' }, 'retitle only');

    const r = run(base, head);
    // ⛔ Version one reported this because the LINES changed. Version three reported it because the
    // NAMES changed. The count is unchanged, and the count is what decides to speak.
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('a genuine deletion reports the NAMES of the cases that are gone', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop two cases');

    const r = run(base, head);
    expect(r.status).toBe(1);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', lost: ['b', 'c'], basePassing: 3, headRunning: 1 }]);
  });

  it('a case MOVED to another file is absolved by measurement, not by matching lines', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("holds", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("b", () => {});\n', 'src/b.test.ts': 'it("holds", () => {});\n' }, 'move one case');

    const r = run(base, head);
    // The count DID drop in src/a.test.ts; the name runs in the destination, so there is nothing to say.
    expect(r.findings).toEqual([]);
    expect(r.status).toBe(0);
  });

  it('ATTRIBUTION: a deletion in one file and a move out of another name the right file, in either order', () => {
    // ⛔ This is the test the previous design could not have. With one line-budget shared across
    // candidates, the same two changes attributed the move and the finding by git's FILE ORDER:
    // swapping the two filenames swapped which file was accused, and the accused one had lost
    // nothing. The name decides now, so the order cannot.
    const shared = 'it("shared case", () => {});\n';
    for (const [delName, mvName] of [['a-del', 'b-mv'], ['b-del', 'a-mv']] as Array<[string, string]>) {
      // ⚠ A FRESH repo per ordering. The first draft committed the second scenario on top of the
      // first one's head, so the move destination was already present and UNTOUCHED — which is a
      // different situation (see the test below) and made the fixture answer its own question wrong.
      freshRepo();
      const base = commit(
        { 'src/a.ts': SRC, ...CONTROL, [`src/${delName}.test.ts`]: `${shared}it("keeps", () => {});\n`, [`src/${mvName}.test.ts`]: `${shared}it("stays", () => {});\n` },
        `base ${delName}`,
      );
      const head = commit(
        {
          [`src/${delName}.test.ts`]: 'it("keeps", () => {});\n',
          [`src/${mvName}.test.ts`]: 'it("stays", () => {});\n',
          'src/dest.test.ts': shared,
        },
        `head ${delName}`,
      );

      const r = run(base, head);
      // Both files lost the identical line; the destination carries ONE copy of that name. Neither is
      // reported, because the name runs at head — and crucially neither is named as the other's loss.
      expect(r.findings.map((f) => f.file).sort()).toEqual([]);
      expect(r.status).toBe(0);
    }
  });

  it('a same-named case in an UNTOUCHED file does not absolve — that is a different test', () => {
    // ⚠ Absolution requires the destination to be part of the diff. A case called `handles zero` in
    // some other file the pull request never touches is not this file's case, and deleting this one
    // IS a loss of this file's coverage. Stated as a test because the alternative reading — "the name
    // still runs somewhere, so nothing is lost" — is tempting and would silence real deletions.
    const base = commit(
      { 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("shared name", () => {});\nit("own", () => {});\n', 'src/elsewhere.test.ts': 'it("shared name", () => {});\n' },
      'base',
    );
    const head = commit({ 'src/a.test.ts': 'it("own", () => {});\n' }, 'delete the shared-named case from a only');

    const r = run(base, head);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', lost: ['shared name'], basePassing: 2, headRunning: 1 }]);
  });

  it('a deletion ALONGSIDE a move names only the case that is really gone', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("moved", () => {});\nit("deleted", () => {});\nit("stays", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("stays", () => {});\n', 'src/b.test.ts': 'it("moved", () => {});\n' }, 'move one, delete one');

    const r = run(base, head);
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', lost: ['deleted'], basePassing: 3, headRunning: 1 }]);
  });

  it('converting cases to it.skip IS a loss — a case that does not run is not coverage', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\nit("d", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\nit.skip("b", () => {});\nit.skip("c", () => {});\nit.todo("d");\n' }, 'skip three');

    const r = run(base, head);
    expect(r.status).toBe(1);
    expect(r.findings[0].lost.sort()).toEqual(['b', 'c', 'd']);
    expect(r.findings[0].headRunning).toBe(1);
  });

  it('a file emptied of ALL its cases is reported — 0 declared is a statement about the diff', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'export const nothing = 1;\n' }, 'remove every case, keep the file');

    const r = run(base, head);
    expect(r.status).toBe(1);
    expect(r.findings[0].lost.sort()).toEqual(['a', 'b']);
  });

  it('a GATED head version is not a judgement about the diff — it is skipped', () => {
    // ⛔ 24 files in this repo gate their whole suite; 21 are `tests/online/*` behind
    // `describe.skipIf(!hasApiKey())` and CI has no key. A `beforeAll` that throws does the same.
    // Read as a count, that is zero — and a pull request that merely ADDED a precondition then
    // reported every case in the file as lost, in a sentence that contradicted itself.
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'describe.skip("suite", () => {\nit("a", () => {});\nit("b", () => {});\n});\n' }, 'gate the suite');

    const r = run(base, head);
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.skipped.find(([f]) => f === 'src/a.test.ts')?.[1]).toContain('ran none of them');
  });

  it('a GATED base version is skipped too, and says which of the two causes it was', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'describe.skip("suite", () => {\nit("a", () => {});\nit("b", () => {});\nit("c", () => {});\n});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'describe.skip("suite", () => {\nit("a", () => {});\n});\n' }, 'drop one from a gated suite');

    const r = run(base, head);
    expect(r.status).toBe(0);
    expect(r.skipped.find(([f]) => f === 'src/a.test.ts')?.[1]).toContain('ran none of its 3 case(s)');
  });

  it('a base version the runner cannot COLLECT declares nothing, and is skipped as such', () => {
    const baseBody = 'it("a", () => { f(1); });\nit("b", () => { f(2); });\n';
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': baseBody }, 'base');
    const head = commit({ 'src/a.ts': 'export const g = 1;\n', 'src/a.test.ts': 'it("a", () => { g; });\n' }, 'rename the export');

    const r = run(base, head, collectFailureFor(baseBody));
    expect(r.status).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.skipped.find(([f]) => f === 'src/a.test.ts')?.[1]).toContain('declares no cases');
  });

  it('the POSITIVE CONTROL requires a case to have RUN, not merely an entry to exist', () => {
    // ⛔ This is a gate finding, and the nastiest shape there is: a control that does not cover the
    // hole it was built for. A file the runner cannot collect still gets an entry — with no cases —
    // so a predicate asking "is there an entry?" called a wedged toolchain healthy and printed a
    // control line claiming it had counted, while it had counted nothing.
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');
    const wedged = (files: string[]): Measurement => ({
      ok: false,
      out: 'Error: Failed to load PostCSS config',
      json: { testResults: files.filter((f) => existsSync(f)).map((f) => ({ name: resolve(f), assertionResults: [] })) },
    });

    const r = run(base, head, wedged);
    expect(r.status).toBe(2);
    expect(r.reason).toBe('runner-unhealthy');
    expect(r.canary).toBe('src/control.test.ts');
  });

  it('an EMPTY runner file list is ill health, not a clean repository', () => {
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');

    const r = run(base, head, measuring, () => []);
    expect(r.status).toBe(2);
    expect(r.reason).toBe('runner-list-empty');
  });

  it('refuses when the CHECKED-OUT commit is not the head it was asked about', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n' }, 'base');
    sh(['checkout', '-q', '-b', 'pr']);
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop two');
    sh(['checkout', '-q', 'main']);

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, headCommit: HEAD_AT, log: () => {} });
    expect(r.status).toBe(2);
    expect(r.reason).toBe('head-mismatch');
    sh(['checkout', '-q', 'pr']);
    expect(check({ base, head, measure: measuring, listFiles: listsEverything, headCommit: HEAD_AT, log: () => {} }).status).toBe(1);
  });

  it('refuses on a TRACKED modification, and an UNTRACKED file does not stop it', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n' }, 'drop one');

    writeFileSync(join(repo, 'editor-leftover.txt'), 'x\n', 'utf-8');
    expect(run(base, head).status).toBe(1); // untracked: named and ignored

    writeFileSync(join(repo, 'src/a.ts'), 'export const f = 2;\n', 'utf-8');
    const r = run(base, head);
    expect(r.status).toBe(2);
    expect(r.reason).toBe('tree-dirty');
    expect(r.trackedDirty?.join(' ')).toContain('src/a.ts');
  });

  it('uses the MERGE BASE: a deletion the base branch made is not attributed to this one', () => {
    const forkPoint = commit(
      { 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n', 'src/other.test.ts': 'it("x", () => {});\nit("y", () => {});\n' },
      'fork point',
    );
    sh(['checkout', '-q', '-b', 'pr']);
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\nit("b2", () => {});\n' }, 'retitle on the branch');
    sh(['checkout', '-q', 'main']);
    const mainTip = commit({ 'src/other.test.ts': 'it("x", () => {});\n' }, 'main deletes a case elsewhere');
    sh(['checkout', '-q', 'pr']);

    expect(mergeBase(mainTip, head)).toBe(forkPoint);
    expect(run(mainTip, head).candidates).not.toContain('src/other.test.ts');
  });

  it('a candidate that is not a test file by NAME never reaches the runner', () => {
    const base = commit({ 'src/a.ts': 'const a = 1;\nconst b = 2;\n', ...CONTROL, 'src/u.test.ts': 'it("u", () => {});\n' }, 'base');
    const head = commit({ 'src/a.ts': 'const a = 1;\n' }, 'drop a source line only');
    const seen: string[][] = [];
    const recording = (files: string[]): Measurement => { seen.push(files); return measuring(files); };

    const r = check({ base, head, measure: recording, listFiles: listsEverything, log: () => {} });
    expect(r.skipped).toEqual([['src/a.ts', 'not a test file by name']]);
    expect(r.reason).toBe('no-candidates');
    // ⛔ No candidate means no runner start at all — not even the control.
    expect(seen).toEqual([]);
  });

  it('TWO runner invocations, whatever the number of candidates', () => {
    // ⛔ A per-candidate pair of runs put 30 candidates at 61 invocations and ~13 minutes against a
    // 20-minute timeout — and a timeout is a red job outside the documented exit contract.
    const files: Record<string, string | null> = { 'src/a.ts': SRC, ...CONTROL };
    for (let i = 0; i < 6; i += 1) files[`src/t${String(i)}.test.ts`] = 'it("x", () => {});\nit("y", () => {});\n';
    const base = commit(files, 'base');
    const head = commit(Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`src/t${String(i)}.test.ts`, 'it("x", () => {});\n'])), 'drop one from each');
    const seen: string[][] = [];
    const recording = (f: string[]): Measurement => { seen.push(f); return measuring(f); };

    const r = check({ base, head, measure: recording, listFiles: listsEverything, log: () => {} });
    expect(r.findings.length).toBe(6);
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain('src/control.test.ts'); // the head run carries the control
  });

  it('puts every file back byte-identically and leaves no recreated DIRECTORY behind', () => {
    // ⚠ git cannot represent an empty directory, so `git status --porcelain` is structurally unable to
    // see a directory this guard recreated. Checked on the tree itself.
    const body = 'it("a", () => {});\nit("b", () => {});\n';
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': body, 'nested/deep/gone.test.ts': body }, 'base');
    const head = commit({ 'src/a.test.ts': 'it("a", () => {});\n', 'nested/deep/gone.test.ts': null }, 'drop one, delete one');
    rmSync(join(repo, 'nested/deep'), { recursive: true, force: true });
    const headBody = readFileSync(join(repo, 'src/a.test.ts'), 'utf-8');

    const r = run(base, head);
    expect(r.findings.length).toBe(2);
    expect(readFileSync(join(repo, 'src/a.test.ts'), 'utf-8')).toBe(headBody);
    expect(existsSync(join(repo, 'nested/deep/gone.test.ts'))).toBe(false);
    expect(existsSync(join(repo, 'nested/deep'))).toBe(false);
  });

  it('restoreInFlight is what a SIGNAL calls, and it is directly exercised', () => {
    // ⚠ `finally` does not run on a default SIGINT/SIGTERM, so this is the only thing standing between
    // Ctrl-C and a merge-base test file left in a developer's tree — after which the guard's own dirty
    // check refuses to run until it is cleaned by hand.
    const body = 'it("a", () => {});\n';
    commit({ 'src/a.ts': SRC, 'src/a.test.ts': body }, 'base');
    writeFileSync(join(repo, 'src/a.test.ts'), 'it("replaced", () => {});\n', 'utf-8');
    // Nothing is in flight here, so it must be a no-op rather than a throw.
    expect(restoreInFlight()).toEqual([]);
    expect(readFileSync(join(repo, 'src/a.test.ts'), 'utf-8')).toBe('it("replaced", () => {});\n');
  });

  it('fileResults separates DECLARED from RAN from PASSED, and keys by path', () => {
    const json = {
      testResults: [
        { name: resolve('src/a.test.ts'), assertionResults: [{ fullName: 'one', status: 'passed' }, { fullName: 'two', status: 'failed' }, { fullName: 'three', status: 'skipped' }] },
        { name: resolve('pkg/src/a.test.ts'), assertionResults: [{ fullName: 'other', status: 'passed' }] },
        { name: resolve('src/empty.test.ts'), assertionResults: [] },
      ],
    };
    const r = fileResults(json);
    const a = r.get(resolve('src/a.test.ts'));
    expect([a?.declared, a?.ran.size, a?.passed.size]).toEqual([3, 2, 1]);
    // ⛔ By PATH, not by position: the runner's file argument is a substring filter, so a run can
    // carry files nobody asked about. An earlier version took the first entry.
    expect(r.get(resolve('pkg/src/a.test.ts'))?.passed.has('other')).toBe(true);
    // declared 0 with ran 0 is the shape of a file the runner could not collect, or one with no cases
    expect(r.get(resolve('src/empty.test.ts'))).toEqual({ ran: new Set(), passed: new Set(), declared: 0 });
    expect(r.get(resolve('src/never.test.ts'))).toBe(undefined);
  });

  it('a NON-ASCII path survives the numstat, and a true RENAME names its DESTINATION', () => {
    // ⛔ Without `-z`, git C-quotes the path, `git show <base>:<it>` throws, and the file is skipped as
    // "the merge base has no such file" — a diagnosis that is false.
    const ten = Array.from({ length: 10 }, (_, i) => `it("case ${String(i)}", () => {});`).join('\n');
    const base = commit({ 'src/a.ts': SRC, 'src/grüß.test.ts': 'it("x", () => {});\nit("y", () => {});\n', 'src/long.test.ts': `${ten}\n` }, 'base');
    sh(['mv', 'src/long.test.ts', 'src/moved.test.ts']);
    const head = commit({ 'src/grüß.test.ts': 'it("x", () => {});\n', 'src/moved.test.ts': `${ten}\nit("extra", () => {});\n` }, 'head');
    // ⚠ git needs REAL similarity for a rename record: an earlier fixture used a two-line file, which
    // git classified as add+delete, so the pair-resolving branch was never executed.
    expect(sh(['diff', '-M', '--name-status', base, head])).toContain('R0');
    const mb = mergeBase(base, head);

    expect(removedFrom(mb, head)).toContain('src/grüß.test.ts');
    expect(addedTo(mb, head)).toContain('src/moved.test.ts');
    expect(addedTo(mb, head)).not.toContain('src/long.test.ts');
  });

  it('a RENAME is resolved by git, even when the repo disables rename detection', () => {
    sh(['config', 'diff.renames', 'false']);
    const base = commit({ 'src/a.ts': SRC, 'src/a.test.ts': 'it("a", () => {});\nit("b", () => {});\n' }, 'base');
    sh(['mv', 'src/a.test.ts', 'src/renamed.test.ts']);
    const head = commit({}, 'rename only');
    expect(removedFrom(mergeBase(base, head), head)).toEqual([]);
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
    expect(reasonLine('collected the suite\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯')).toBe('collected the suite');
    expect(reasonLine('')).toBe('(the run produced no readable output)');
  });

  it('the EXIT CONTRACT: a verdict line on 0 and on 1, never on 2, and no reason prints as its key', () => {
    const report = render({ status: 1, reason: 'checked', findings: [{ file: 'src/a.test.ts', lost: ['b'], basePassing: 3, headRunning: 1 }], skipped: [], candidates: ['src/a.test.ts'] });
    expect(report.code).toBe(1);
    expect(report.lines.join('\n')).toContain('VERDICT report');
    expect(report.lines.join('\n')).toContain('· b');

    for (const r of [
      { status: 0, reason: 'checked', findings: [], skipped: [], candidates: ['src/a.test.ts'] },
      { status: 0, reason: 'no-candidates', findings: [], skipped: [], candidates: [] },
    ]) {
      const d = render(r);
      expect(d.code).toBe(0);
      expect(d.lines.join('\n')).toContain('VERDICT clean');
    }

    for (const reason of ['tree-dirty', 'head-mismatch', 'runner-list-empty', 'runner-unhealthy', 'tree-unreadable']) {
      const ill = render({ status: 2, reason, trackedDirty: ['M src/a.ts'] });
      expect(ill.code).toBe(2);
      // ⛔ A crash must not be able to wear a verdict; the workflow would believe it.
      expect(ill.lines.join('\n')).not.toContain('VERDICT');
      // ⛔ And every reason owes a sentence. An earlier assertion here compared against the bare key,
      // which the `deleted-assertion-guard: ` prefix made unfalsifiable — a placeholder with the
      // authority of a test.
      expect(ill.lines[0]).not.toContain('unknown reason');
    }
    expect(render({ status: 2, reason: 'something-new' }).lines[0]).toContain('unknown reason');
  });

  it('the REPORT sentence branches: a clean attribution reads differently from one with a retitle in it', () => {
    // ⚠ Two shapes, and one sentence cannot carry both. Measured on real history: a diff that
    // retitled two cases and deleted one made the single-sentence version read "3 of 8 run nowhere
    // now", which invites the reader to hunt three deletions. The count drop is the number that is
    // true; the names are only where to look.
    const clean = render({
      status: 1, reason: 'checked', skipped: [], candidates: ['src/a.test.ts'],
      findings: [{ file: 'src/a.test.ts', lost: ['b', 'c'], basePassing: 3, headRunning: 1 }],
    }).lines.join('\n');
    expect(clean).toContain('2 case(s) gone');
    expect(clean).not.toContain('renamed rather than removed');

    const mixed = render({
      status: 1, reason: 'checked', skipped: [], candidates: ['src/a.test.ts'],
      findings: [{ file: 'src/a.test.ts', lost: ['old one', 'old two', 'deleted'], basePassing: 8, headRunning: 7 }],
    }).lines.join('\n');
    expect(mixed).toContain('count dropped by 1');
    expect(mixed).toContain('at least 2 of them were renamed rather than removed');
    expect(mixed).not.toContain('3 case(s) gone');
  });

  it('the `no-candidates` line says what it READ, not that nothing was lost', () => {
    // ⛔ It used to claim "this diff removes no lines from any tracked file", which a rename that
    // dropped four cases makes false: git calls the pair `R`, `--diff-filter=MD` excludes it, and the
    // sentence then asserts the opposite of the truth with a verdict attached.
    const d = render({ status: 0, reason: 'no-candidates', findings: [], skipped: [], candidates: [] });
    expect(d.lines[0]).toContain('--diff-filter=MD');
    expect(d.lines[0]).toContain('similarity threshold');
    expect(d.lines[0]).not.toContain('removes no lines from any tracked file');
  });

  it('vitestMeasure measures the REAL runner — the region where the fatal defect lived', () => {
    // ⛔ Every earlier version of this file tested only the injected fake, and the one defect that
    // made the guard useless lived in the closure the fake replaced: the counts came from vitest's
    // coloured summary, which no fake reproduces. This runs the real thing, with the agent markers
    // stripped so the environment is the RUNNER's, and asserts the shape the guard depends on.
    process.chdir(REPO_ROOT);
    try {
      const env = { ...process.env, CI: '1' };
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE', 'AI_AGENT', 'TERM']) delete (env as Record<string, string | undefined>)[k];
      const target = 'src/core/audio-duration.test.ts';
      const m = vitestMeasure(env)([target]);
      const byFile = fileResults(m.json);
      const r = byFile.get(resolve(target));
      expect(r, 'the real runner must produce an entry for the file it was given').toBeDefined();
      expect(r?.ran.size).toBeGreaterThan(0);
      expect(r?.declared).toBe(r?.ran.size);
      // and the names are real case names, not placeholders
      expect([...(r?.passed ?? [])].every((n) => n.length > 0)).toBe(true);
    } finally {
      process.chdir(repo);
    }
  }, 180_000);

  it("the WORKFLOW's exit mapping is executed, and a code without a VERDICT line is ill health", () => {
    // ⛔ Two measured defects live here. GitHub invokes a `run:` block as `bash -e {0}`, so `-e` is on
    // before the block's own `set` runs: with a bare call followed by `CODE=$?` the step aborted the
    // instant the guard exited non-zero — the `case` never ran, nothing was printed, and the job went
    // RED on a finding. And an exit code alone cannot tell a verdict from a crash: node exits 1 for a
    // module-load failure too, so a pull request deleting this script made the job announce a finding
    // nobody had measured.
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/deleted-assertion-guard.yml'), 'utf-8').split('\n');
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
    // Positive control on the EXTRACTION: `bash -e` on an empty block exits 0, which reads exactly
    // like "nothing to report".
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
      const tag = `${String(code)}-${(sentinel ?? 'none').replace(/\W+/g, '_')}`;
      const stub = join(dir, `stub-${tag}.sh`);
      writeFileSync(stub, `${sentinel === null ? '' : `printf '%s\\n' 'deleted-assertion-guard: ${sentinel}'\n`}exit ${String(code)}\n`, 'utf-8');
      // ⚠ Only the COMMAND is substituted. Replacing to end of line swallowed the trailing
      // `|| CODE=$?` once, so the probe rebuilt the broken form and reported its own doing.
      const replaced = block.replace(/node scripts\/deleted-assertion-guard\.mjs/m, `bash ${stub}`);
      expect(replaced).not.toBe(block);
      expect(replaced).toContain('|| CODE=$?');
      const step = join(dir, `step-${tag}.sh`);
      writeFileSync(step, replaced, 'utf-8');
      const res = spawnSync('bash', ['-e', step], { encoding: 'utf-8', env: { ...process.env, BASE_SHA: 'b', HEAD_SHA: 'h' } });
      const out = `${res.stdout}${res.stderr}`;
      expect({ code, sentinel, status: res.status, out: out.slice(0, 160) }).toMatchObject({ status: wantStatus });
      expect(out).toContain(wantMarker);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('vitestRoster THROWS when the runner cannot be asked, instead of answering "no test files"', () => {
    // ⛔ It used to return `[]`, and the verdict was the same (exit 2) — which is why this survived a
    // mutation round as "equivalent". It is not: the two paths print DIFFERENT causes, and one of them
    // is false. "The runner enumerated NO test files" describes a repository with no tests; the truth
    // was that the runner could not be asked. A message that names the wrong cause sends the next
    // person to look for a missing glob instead of a broken toolchain.
    expect(() => vitestRoster({ PATH: '/nonexistent-on-purpose' })()).toThrow(/could not enumerate/);
  });

  it('a bad ref THROWS rather than returning a verdict — main turns that into exit 2', () => {
    commit({ 'src/a.ts': SRC }, 'base');
    expect(() => mergeBase('deadbeefdeadbeef', 'cafebabecafebabe')).toThrow();
  });
});
