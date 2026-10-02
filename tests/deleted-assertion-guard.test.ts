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
type Case = { title: string; fullName: string; status: string };

/**
 * ⛔ THE FAKE MUST COMPOSE `fullName` FROM THE DESCRIBE CHAIN, because real vitest does and the whole
 * identity question turns on it. Measured: the same case under `describe('module A')` and
 * `describe('module B')` has `title` `"shared leaf"` in both and `fullName` `"module A shared leaf"`
 * vs `"module B shared leaf"`. An earlier fake used the bare `it()` title as `fullName`, which is the
 * one shape where it agrees with reality — and that is why a `fullName` key reported every
 * cross-module move as a loss for four rounds without a single test noticing.
 */
function casesOf(src: string, failing: Set<string>): Case[] {
  const out: Case[] = [];
  const stack: Array<{ title: string; gated: boolean; depth: number }> = [];
  let depth = 0;
  for (const line of src.split('\n')) {
    while (stack.length > 0 && depth <= stack[stack.length - 1].depth) stack.pop();
    const d = /\bdescribe(\.\w+(?:\([^)]*\))?)?\(\s*['"]([^'"]+)['"]/.exec(line);
    if (d) stack.push({ title: d[2], gated: /\.skip\b|\.skipIf\(\s*true\s*\)/.test(d[1] ?? ''), depth });
    const t = /\b(?:it|test)(\.\w+)?\(\s*['"]([^'"]+)['"]/.exec(line);
    if (t) {
      const mod = t[1] ?? '';
      const gated = stack.some((x) => x.gated);
      const status = gated || mod === '.skip' ? 'skipped' : mod === '.todo' ? 'todo' : failing.has(t[2]) ? 'failed' : 'passed';
      out.push({ title: t[2], fullName: [...stack.map((x) => x.title), t[2]].join(' '), status });
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return out;
}

function entryFor(file: string, failing: Set<string>): { name: string; assertionResults: Case[] } {
  return { name: resolve(file), assertionResults: casesOf(readFileSync(file, 'utf-8'), failing) };
}

/** `failing` names leaf titles the runner reports as `failed` — the status the old fake could not emit. */
const makeMeasure = (failing: Set<string> = new Set()) => (files: string[]): Measurement => ({
  ok: true,
  out: '',
  json: { testResults: files.filter((f) => existsSync(f)).map((f) => entryFor(f, failing)) },
});
const measuring = makeMeasure();

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
    testResults: files.filter((f) => existsSync(f)).map((f) => (readFileSync(f, 'utf-8') === body ? { name: resolve(f), assertionResults: [] } : entryFor(f, new Set()))),
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

const NL = '\n';
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
    expect(r.canary).toContain('src/control.test.ts');
    expect(r.canary).toContain('head'); // which of the two runs was dead is part of the diagnosis
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

  it('ONE head run plus one base run PER candidate — and every run carries a control', () => {
    // ⚠ The cost shape is a decision, not an accident. 1 + 2N (a pair of runs per candidate) put 30
    // candidates at 61 invocations and ~13 minutes against a 20-minute timeout, and a timeout is a red
    // job outside the documented exit contract. 1 + N is the compromise: the head side is measured
    // once for everything, and the base side stays per-candidate because batching it made candidates
    // observable to each other (see the contamination test below).
    const files: Record<string, string | null> = { 'src/a.ts': SRC, ...CONTROL };
    for (let i = 0; i < 6; i += 1) files[`src/t${String(i)}.test.ts`] = 'it("x", () => {});\nit("y", () => {});\n';
    const base = commit(files, 'base');
    const head = commit(Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`src/t${String(i)}.test.ts`, 'it("x", () => {});\n'])), 'drop one from each');
    const seen: string[][] = [];
    const recording = (f: string[]): Measurement => { seen.push(f); return measuring(f); };

    const r = check({ base, head, measure: recording, listFiles: listsEverything, log: () => {} });
    expect(r.findings.length).toBe(6);
    expect(seen.length).toBe(1 + 6);
    expect(seen[0]).toContain('src/control.test.ts'); // the head run
    for (const call of seen.slice(1)) {
      expect(call).toContain('src/control.test.ts'); // ⛔ the base run needs a control too: it is the
      expect(call.length).toBe(2); // run that executes rewritten files, so it is the likelier to die
    }
  });

  it('a candidate cannot see another candidate\'s reverted content', () => {
    // ⛔ Measured on the real runner before this was changed: with every base version written at once,
    // a test that reads sibling test files from disk — this repo has six, `tests/no-fixed-test-ports`
    // among them — saw another candidate's reverted content, failed, left the base's passing set, and
    // a real deletion was reported as "nothing to report". The per-candidate base run cannot do it.
    const base = commit(
      {
        'src/a.ts': SRC, ...CONTROL,
        'src/scan.test.ts': 'it("no banned token anywhere", () => {});\nit("ordinary", () => {});\n',
        'src/data.test.ts': 'it("d1", () => {});\nit("d2", () => {});\n',
      },
      'base',
    );
    const head = commit(
      { 'src/scan.test.ts': 'it("no banned token anywhere", () => {});\n', 'src/data.test.ts': 'it("d1", () => {});\n' },
      'drop one case from each',
    );
    // The scanning case fails whenever data.test.ts carries its base content — exactly the coupling.
    const coupled = (f: string[]): Measurement => {
      const dataIsReverted = existsSync('src/data.test.ts') && readFileSync('src/data.test.ts', 'utf-8').includes('d2');
      return makeMeasure(dataIsReverted ? new Set(['no banned token anywhere']) : new Set())(f);
    };

    const r = check({ base, head, measure: coupled, listFiles: listsEverything, log: () => {} });
    // Both deletions must be reported. Under the batched run, `scan` was silenced.
    expect(r.findings.map((f) => f.file).sort()).toEqual(['src/data.test.ts', 'src/scan.test.ts']);
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
    expect([a?.declared, a?.ran.length, a?.passed.length]).toEqual([3, 2, 1]);
    // ⛔ By PATH, not by position: the runner's file argument is a substring filter, so a run can
    // carry files nobody asked about. An earlier version took the first entry.
    expect(r.get(resolve('pkg/src/a.test.ts'))?.passed.map((c) => c.fullName)).toEqual(['other']);
    // declared 0 with ran 0 is the shape of a file the runner could not collect, or one with no cases
    expect(r.get(resolve('src/empty.test.ts'))).toEqual({ ran: [], passed: [], declared: 0 });
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

  it('the REPORT states its two measures and INFERS no rename from their difference', () => {
    // ⛔ An earlier version branched on `lost.length` against `basePassing - headRunning` and announced
    // a RENAME from the difference. The inference is invalid: the two numbers measure different things
    // (passed in the base, ran at head), so a base case that fails against the new source deflates the
    // difference and two deletions read as one deletion plus one rename. It also printed "at least -1
    // of them were renamed" for the shape it had not enumerated.
    const say = (lost: string[], basePassing: number, headRunning: number): string =>
      render({ status: 1, reason: 'checked', skipped: [], candidates: ['src/a.test.ts'],
        findings: [{ file: 'src/a.test.ts', lost, basePassing, headRunning }] }).lines.join('\n');

    for (const [lost, bp, hr] of [[['b', 'c'], 3, 1], [['x', 'y', 'z'], 8, 7], [['deleted'], 3, 1]] as Array<[string[], number, number]>) {
      const out = say(lost, bp, hr);
      expect(out).toContain(`${String(bp)} case(s) passed before, ${String(hr)} run now`);
      expect(out).toContain(`${String(lost.length)} of them run nowhere this diff touches`);
      // ⛔ No claim either way, and never a negative number.
      expect(out).not.toMatch(/were RENAMED rather than removed/);
      expect(out).not.toContain('-1');
      for (const n of lost) expect(out).toContain(`· ${n}`);
    }
    // and the limit it cannot resolve is named rather than computed
    expect(say(['b'], 2, 1)).toContain('does not guess');
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
      expect(r?.ran.length).toBeGreaterThan(0);
      expect(r?.declared).toBe(r?.ran.length);
      // ⛔ The shape the whole identity argument rests on, asserted against the REAL runner: the full
      // name carries the describe chain, the title does not. Four rounds of a fake that conflated
      // them is why this line exists.
      const withDescribe = r?.passed.find((c) => c.fullName !== c.title);
      expect(withDescribe, 'this file wraps its cases in a describe, so a full name must differ from its title').toBeDefined();
      expect(withDescribe?.fullName.endsWith(withDescribe.title)).toBe(true);
      // and the names are real case names, not placeholders
      expect((r?.passed ?? []).every((c) => c.title.length > 0 && c.fullName.length > 0)).toBe(true);
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

  it('a move ACROSS a describe boundary is absolved — the identity is the leaf title', () => {
    // ⛔ THE HEADLINE FINDING OF THE FOURTH GATE ROUND. The runner's `fullName` is the ancestor chain
    // joined with the leaf, so the identical case moved from `describe('module A')` into
    // `describe('module B')` arrives under a different name — and 557 of this repo's 563 test files
    // wrap their cases in a describe. Keyed on `fullName`, this reported a loss AND printed "so they
    // did not move" about a case that had.
    const base = commit(
      { 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': "describe('module A', () => {\n  it('keeps', () => {});\n  it('moves away', () => {});\n});\n" },
      'base',
    );
    const head = commit(
      {
        'src/a.test.ts': "describe('module A', () => {\n  it('keeps', () => {});\n});\n",
        'src/b.test.ts': "describe('module B', () => {\n  it('moves away', () => {});\n});\n",
      },
      'move a case into another module',
    );

    const r = run(base, head);
    expect(r.findings).toEqual([]);
    expect(r.status).toBe(0);
  });

  it('a case deleted from a describe block is still reported, with its FULL name', () => {
    // The positive twin of the test above: absolving on the leaf title must not blind the thing.
    const base = commit(
      { 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': "describe('module A', () => {\n  it('keeps', () => {});\n  it('goes', () => {});\n});\n" },
      'base',
    );
    const head = commit({ 'src/a.test.ts': "describe('module A', () => {\n  it('keeps', () => {});\n});\n" }, 'delete one');

    const r = run(base, head);
    // The identity is the title; the REPORT names the module, because that is what a reader needs.
    expect(r.findings).toEqual([{ file: 'src/a.test.ts', lost: ['module A goes'], basePassing: 2, headRunning: 1 }]);
  });

  it('the CONTROL file does not absolve, whatever its name sorts like', () => {
    // ⛔ `ranAtHead` used to be built from every entry in the head run, control included — and the
    // control is chosen precisely because the diff does NOT touch it. A case in it sharing a title
    // with a deleted one silenced the deletion and logged "every case that passed before runs
    // somewhere at head". The test that claimed otherwise passed only because its control file sorted
    // after the candidate; this one sorts BEFORE it on purpose.
    const base = commit(
      {
        'src/a.ts': SRC,
        'src/aaa-control.test.ts': "it('collides', () => {});\nit('control holds', () => {});\n",
        'src/zzz-candidate.test.ts': "it('collides', () => {});\nit('stays', () => {});\n",
      },
      'base',
    );
    const head = commit({ 'src/zzz-candidate.test.ts': "it('stays', () => {});\n" }, 'delete the colliding case');

    const r = run(base, head);
    expect(r.findings).toEqual([{ file: 'src/zzz-candidate.test.ts', lost: ['collides'], basePassing: 2, headRunning: 1 }]);
  });

  it('a base version that partly FAILS against the new source does not invent a rename', () => {
    // ⛔ `basePassing` counts what PASSED, `headRunning` counts what RAN — different measures, so their
    // difference is not "how many cases are gone". Measured consequence before the sentence was fixed:
    // two deletions plus one base case failing against the new source printed "count dropped by 1 …
    // so at least 1 of them was renamed", naming a rename that did not exist. The fake could not emit
    // a `failed` status at all, which is why nothing caught it.
    const base = commit(
      { 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': "it('a', () => {});\nit('b', () => {});\nit('c', () => {});\nit('d', () => {});\nit('e', () => {});\n" },
      'base',
    );
    const head = commit({ 'src/a.test.ts': "it('a', () => {});\nit('b', () => {});\nit('e', () => {});\n" }, 'delete c and d');

    const r = check({ base, head, measure: makeMeasure(new Set(['e'])), listFiles: listsEverything, log: () => {} });
    expect(r.findings.length).toBe(1);
    expect(r.findings[0].lost.sort()).toEqual(['c', 'd']);
    // basePassing excludes the failing `e`; headRunning counts it. The report must not read that
    // difference as a rename — the third shape of the sentence covers it.
    const said = render(r).lines.join('\n');
    // The caveat line legitimately uses the word; what must be absent is the INFERENCE
    // that the arithmetic can tell a rename from a deletion.
    expect(said).not.toMatch(/some of these were RENAMED/);
    expect(said).toContain('4 case(s) passed before, 3 run now');
    expect(said).toContain('does not guess');
  });

  it('a head version the runner could not COLLECT is not an emptied file', () => {
    // ⛔ `declared === 0` has a third cause the comment used to deny: a broken import, a syntax error,
    // or a suite with no case in it all report zero cases with a failed status. An emptied file is a
    // real loss; a collection failure is not a statement about what the diff removed.
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': "it('a', () => {});\nit('b', () => {});\n" }, 'base');
    const head = commit({ 'src/a.test.ts': "import { gone } from './nope.js';\nit('a', () => { gone(); });\n" }, 'break the import');
    const cannotCollect = (files: string[]): Measurement => {
      const m = measuring(files);
      const j = m.json as { testResults: Array<{ name: string; assertionResults: Case[] }> };
      return {
        ok: false,
        out: 'FAIL  src/a.test.ts\nError: Failed to resolve import "./nope.js"',
        json: { testResults: j.testResults.map((e) => (e.name === resolve('src/a.test.ts') && readFileSync('src/a.test.ts', 'utf-8').includes('nope') ? { ...e, assertionResults: [] } : e)) },
      };
    };

    const r = check({ base, head, measure: cannotCollect, listFiles: listsEverything, log: () => {} });
    expect(r.findings).toEqual([]);
    expect(r.skipped.find(([f]) => f === 'src/a.test.ts')?.[1]).toContain('collection failure');
  });

  it('the whole recreated directory CHAIN is removed, not just the last one', () => {
    // ⚠ Recording only the immediate parent left `deep/` and `deep/er/` behind for a deleted
    // `deep/er/still/gone.test.ts` — invisible to `git status`, so the test that claimed the property
    // used a path whose first level already existed and could not have seen it.
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'deep/er/still/gone.test.ts': "it('a', () => {});\nit('b', () => {});\n" }, 'base');
    const head = commit({ 'deep/er/still/gone.test.ts': null }, 'delete it');
    rmSync(join(repo, 'deep'), { recursive: true, force: true });

    const r = run(base, head);
    expect(r.findings.length).toBe(1);
    for (const d of ['deep', 'deep/er', 'deep/er/still']) expect(existsSync(join(repo, d))).toBe(false);
  });

  it('restoreInFlight puts a file back when one IS in flight, and removes what it created', () => {
    // ⚠ The earlier test called it with nothing in flight and asserted an empty list — so deleting the
    // entire restore loop left it green. And the first draft of THIS fixture added a case between base
    // and head, so the diff removed no line, there was no candidate, and `measure` was never called:
    // a fixture that produces no candidate cannot test the candidate loop.
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': `it('original', () => {});${NL}it('second', () => {});${NL}` }, 'base');
    const head = commit({ 'src/a.test.ts': `it('original', () => {});${NL}` }, 'drop one');
    const headBody = readFileSync(join(repo, 'src/a.test.ts'), 'utf-8');
    const restored: string[][] = [];
    const interrupting = (files: string[]): Measurement => {
      // Only the base run has a file in flight; the head run has none, which is worth pinning too.
      const put = restoreInFlight();
      if (put.length > 0) {
        restored.push(put);
        // ⛔ The signal path must put the HEAD version back, not leave the merge-base one on disk.
        expect(readFileSync(join(repo, 'src/a.test.ts'), 'utf-8')).toBe(headBody);
      }
      return measuring(files);
    };

    check({ base, head, measure: interrupting, listFiles: listsEverything, log: () => {} });
    expect(restored).toEqual([['src/a.test.ts']]);
    expect(readFileSync(join(repo, 'src/a.test.ts'), 'utf-8')).toBe(headBody);
  });

  it('a GATED control is a note, not a broken instrument — the permanently-red direction', () => {
    // ⛔ 21 files here gate their whole suite. A control picked off the roster could be one of them: it
    // runs no case, and treating that as ill health would turn the job red on EVERY pull request,
    // forever, blaming the toolchain. A control whose cases exist and did not run is a gated file.
    const base = commit(
      {
        'src/a.ts': SRC,
        'src/gatedcontrol.test.ts': "describe.skip('gated suite', () => {\n  it('never runs', () => {});\n});\n",
        'src/a.test.ts': "it('a', () => {});\nit('b', () => {});\n",
      },
      'base',
    );
    const head = commit({ 'src/a.test.ts': "it('a', () => {});\n" }, 'drop one');

    const r = run(base, head);
    // The verdict still lands; it is simply unverified, and the log says so rather than condemning.
    expect(r.status).toBe(1);
    expect(r.reason).toBe('checked');
    expect(r.findings[0].lost).toEqual(['b']);
  });

  it('the base run carries a control too — it is the run that executes rewritten files', () => {
    const base = commit({ 'src/a.ts': SRC, ...CONTROL, 'src/a.test.ts': "it('a', () => {});\nit('b', () => {});\n" }, 'base');
    const head = commit({ 'src/a.test.ts': "it('a', () => {});\n" }, 'drop one');
    // A runner that is healthy for the HEAD run and dead for the BASE run must be caught: for two
    // rounds only the head side had a control, and the base side is the likelier one to collapse.
    let call = 0;
    const deadOnBase = (files: string[]): Measurement => {
      call += 1;
      if (call === 1) return measuring(files);
      return { ok: false, out: 'Error: Failed to load PostCSS config', json: { testResults: files.filter((f) => existsSync(f)).map((f) => ({ name: resolve(f), assertionResults: [] })) } };
    };

    const r = check({ base, head, measure: deadOnBase, listFiles: listsEverything, log: () => {} });
    expect(r.status).toBe(2);
    expect(r.reason).toBe('runner-unhealthy');
    expect(r.canary).toContain('base');
  });

  it('a gated FIRST control does not cost the run its verification — a later one is used', () => {
    // ⚠ What the widening to three controls actually buys, and a mutation round is why this test
    // exists: with one control the mutant `slice(0, 1)` survived, because no fixture had a second
    // non-candidate. The widening is NOT what prevents the permanently-red failure — the
    // "gated is a note" branch does that, and either alone suffices for safety. What three controls
    // buy is a VERIFIED run where one control happens to be gated, which is the common case here:
    // 21 files gate their whole suite.
    const base = commit(
      {
        'src/a.ts': SRC,
        'src/aaa-gated.test.ts': "describe.skip('gated', () => {\n  it('never runs', () => {});\n});\n",
        'src/bbb-healthy.test.ts': "it('control holds', () => {});\n",
        'src/zzz-candidate.test.ts': "it('a', () => {});\nit('b', () => {});\n",
      },
      'base',
    );
    const head = commit({ 'src/zzz-candidate.test.ts': "it('a', () => {});\n" }, 'drop one');
    const said: string[] = [];

    const r = check({ base, head, measure: measuring, listFiles: listsEverything, log: (l) => said.push(l) });
    expect(r.findings[0].lost).toEqual(['b']);
    // ⛔ With only the gated control in hand the run proceeds UNVERIFIED and says so. With the later
    // healthy one it is verified, and that difference is the whole point of looking past the first.
    expect(said.join('\n')).toContain('src/bbb-healthy.test.ts');
    expect(said.join('\n')).not.toContain('every control file is gated');
  });

  it('a bad ref THROWS rather than returning a verdict — main turns that into exit 2', () => {
    commit({ 'src/a.ts': SRC }, 'base');
    expect(() => mergeBase('deadbeefdeadbeef', 'cafebabecafebabe')).toThrow();
  });
});
