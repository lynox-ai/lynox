/**
 * Tests for scripts/drift-guard.sh — specifically that it FIRES.
 *
 * drift-guard is a Required Check (pre-push + CI), yet it had NO test at all:
 * the CI job only proves the tree is currently clean, which is a different
 * claim from "the guard still works". A dropped `-z`, a reordered loop, or a
 * pattern typo all leave the tree clean and the job green while the gate quietly
 * stops catching anything — the same silent-skip class core#1184 closed in
 * public-repo-guard.sh, which drift-guard shared byte-for-byte in its file loops.
 *
 * Each case stages a known-bad artifact and asserts a NON-ZERO exit; the clean
 * cases assert the inverse. The guard scans `git ls-files` (the INDEX), so
 * staging is enough — no commit needed. git config is pinned to /dev/null so a
 * developer's global `core.quotePath` / `hooksPath` cannot make a case vacuous.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/drift-guard.sh', import.meta.url));

// Pin git config so the fixture repos are hermetic: a dev with global
// core.quotePath=false would otherwise make the umlaut cases pass even against a
// reverted `-z` fix, and a global core.hooksPath would run foreign hooks here.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** The git conflict markers, assembled so THIS file is not itself a drift hit. */
const OPEN_MARKER = '<'.repeat(7);
const CLOSE_MARKER = '>'.repeat(7);
/** A removed-feature word (class B), assembled so this file stays clean. */
const REMOVED_WORD = ['Tele', 'gram'].join('');

let dir: string;

/** Run drift-guard inside `dir`; return the exit code (0 = clean). */
function runGuard(): number {
  try {
    execFileSync('bash', [SCRIPT], { cwd: dir, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

/** Stage a file so `git ls-files` (the index, which drift-guard scans) sees it. */
function stageFile(relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  // `--` so a path beginning with '-' is a pathspec, not a `git add` option.
  execFileSync('git', ['add', '--', relPath], { cwd: dir, env: GIT_ENV });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drift-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  // Classes D (README provider matrix vs catalog) and E (test-count badge) scan
  // fixed files and HARD-fail if they are absent — which would tautologise every
  // `.not.toBe(0)` below. Give them a minimal satisfied surface: one verified
  // preset the README names, agreeing badge/prose numbers, one real it() site.
  stageFile(
    'README.md',
    'tests-1%2B badge, 1+ tests prose.\nOllama is verified.\n',
  );
  stageFile(
    'src/core/llm/catalog.ts',
    "const OPENAI_COMPAT_PRESETS = [\n" +
      '  {\n' +
      "    display_name: 'Ollama (local)',\n" +
      "    verification: 'verified',\n" +
      '  },\n' +
      '] as const;\n',
  );
  stageFile('src/x.test.ts', 'it("t", () => {});\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('drift-guard — fires on planted drift', () => {
  it('is clean on a benign tree (baseline — keeps the fixture honest)', () => {
    expect(runGuard()).toBe(0);
  });

  it('catches an A/merge-conflict marker in an ASCII-named file', () => {
    stageFile('src/conflict.ts', `${OPEN_MARKER} HEAD\nconst x = 1;\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches an A/merge marker in a file whose NAME holds a non-ASCII byte', () => {
    // git quotes such a path under default core.quotePath; the pre-fix
    // `git ls-files` (no -z) returned the quoted literal, `[ -f ]` failed on it,
    // and the file was skipped — silently, on the one class that is never exempt.
    // Pins the `-z` + `read -d ''` fix (loop A).
    stageFile('docs/Grüße.md', `${CLOSE_MARKER} branch\ntext\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches an A/merge marker in a file whose NAME begins with a dash', () => {
    // `-x.md`: the pre-fix inner `grep ... "$f"` read `-x.md` as options → error
    // → the file was skipped. Pins the `./$f` operand fix.
    stageFile('-x.md', `${OPEN_MARKER} HEAD\ntext\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('still scans later files when a path is literally "-" (no stdin drain)', () => {
    // The sharpest edge: a file named exactly `-` makes `grep ... -` read STDIN,
    // which inside the loop is the NUL file listing — grep drains it and every
    // later file is skipped. `./$f` (never the stdin `-`) is what keeps the
    // marker in the later file visible. `zz-` sorts after `-`.
    stageFile('-', 'nothing\n');
    stageFile('zz-conflict.ts', `${OPEN_MARKER} HEAD\nx\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches a B/removed-feature word in a LIVE doc with a non-ASCII name', () => {
    // Second loop, same fix: the class-B scan iterates the same quoted listing.
    stageFile('docs/src/content/docs/Übersicht.md', `Use the ${REMOVED_WORD} bot.\n`);
    expect(runGuard()).not.toBe(0);
  });
});

// `file:line` is the dominant citation form in the register and in these scripts'
// own comments, and class C could not see it: PATH_RE excluded `:` from its
// character class, so `` `src/core/agent.ts:1010` `` matched nothing while the bare
// path was checked. A guard over one spelling is blind to every other — and this
// one was blind to the form people actually write.
describe('drift-guard — class C reads the citation form people use', () => {
  // The fixture path is not arbitrary: class C scans `*CLAUDE.md`, `*README.md`
  // and `docs/src/content/docs/*` only. A doc placed anywhere else is never read,
  // and every assertion below would pass against a guard that does nothing.

  it('⭐ THE POINT: a dead path cited as file:line is caught', () => {
    stageFile('docs/src/content/docs/live.md', 'See `src/core/does-not-exist.ts:1010` for the wiring.\n');
    expect(runGuard(), 'a dead file:line citation must fire').not.toBe(0);
  });

  it('a line RANGE is caught too', () => {
    stageFile('docs/src/content/docs/live.md', 'See `src/core/does-not-exist.ts:1010-1042`.\n');
    expect(runGuard()).not.toBe(0);
  });

  // The control that keeps the fix from being "fire on everything": the line
  // number is a pointer INTO the file, not part of its name, so a LIVE path
  // cited with one must stay clean.
  it('the control: a LIVE path cited as file:line stays clean', () => {
    stageFile('docs/src/content/docs/live.md', 'See `src/x.test.ts:1` and `src/x.test.ts:1-9`.\n');
    expect(runGuard(), 'the line tail must be stripped before the existence check').toBe(0);
  });

  // The form that already worked must keep working — both directions, or the
  // change could have traded one blindness for another.
  it('the bare form still fires on a dead path', () => {
    stageFile('docs/src/content/docs/live.md', 'See `src/core/does-not-exist.ts`.\n');
    expect(runGuard()).not.toBe(0);
  });

  it('the bare form still passes on a live path', () => {
    stageFile('docs/src/content/docs/live.md', 'See `src/x.test.ts`.\n');
    expect(runGuard()).toBe(0);
  });

  // ⚠ The residual, stated rather than assumed away. A NON-numeric tail does not
  // match the optional group, so the whole backticked token fails PATH_RE and the
  // line is not scanned at all — exactly as before this change, which excluded `:`
  // outright. Widening to any colon tail was considered and rejected: `src/foo.ts:
  // see below` would then be read as a path, and a guard that invents references
  // is worse than one that misses a rare spelling.
  //
  // The truncation risk this test was written for cannot arise: the strip is an
  // anchored `:digits(-digits)?$` match, not a cut at the first colon. There is no
  // input where it removes part of a name — which is why this asserts the scan
  // boundary instead of a truncation that has no code path.
  it('a non-numeric colon tail is NOT scanned — the known edge of class C', () => {
    stageFile('docs/src/content/docs/live.md', 'See `src/core/does-not-exist.ts:notaline`.\n');
    expect(runGuard(), 'unmatched by PATH_RE, so unscanned — the pre-existing edge').toBe(0);
    // The contrast that makes it a boundary rather than a bug report: the same
    // dead path WITH a numeric tail does fire.
    stageFile('docs/src/content/docs/live.md', 'See `src/core/does-not-exist.ts:12`.\n');
    expect(runGuard(), 'the numeric form is exactly what this change added').not.toBe(0);
  });
});

describe('drift-guard — does NOT fire on benign trees', () => {
  it('exempts a removed-feature word inside an archive/ doc (B is archive-exempt)', () => {
    // The real archive-exemption assertion: class B skips */archive/*. Mutating
    // that skip in the script makes this fire — so it is not asserted-by-name.
    stageFile('docs/src/content/docs/archive/whatsapp.md', `The ${REMOVED_WORD} bot was removed.\n`);
    expect(runGuard()).toBe(0);
  });

  it('does not falsely report a dead path for an ASCII ref under a non-ASCII dir', () => {
    // Pins `core.quotePath=false` on ALL_TRACKED: the tracked path `päck/src/a.ts`
    // is quoted by default (`"p\303\244ck/src/a.ts"`), and the trailing quote
    // breaks exists_path's `(/|$)` end-anchor for the ASCII ref `src/a.ts` in the
    // README — so a reverted quotePath would falsely fire class C here.
    stageFile('päck/src/a.ts', 'export const a = 1;\n');
    stageFile('README.md', 'tests-1%2B badge, 1+ tests prose.\nOllama is verified.\nSee `src/a.ts`.\n');
    expect(runGuard()).toBe(0);
  });
});
