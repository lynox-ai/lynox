/**
 * Behavioural harness for every gate script lefthook runs.
 *
 * THE FAILURE THIS EXISTS FOR. A guard that examines nothing and exits 0 is
 * worse than no guard: the tick still appears, and in the output "scanned and
 * clean" is indistinguishable from "scanned nothing". We have now hit that shape
 * three times, on three different axes:
 *
 *   · the producer failed   — `done < <(git ls-files -z)` hides its producer's
 *     exit status from `set -e`; outside a work tree the loop ran zero times and
 *     public-repo-guard printed `clean ✓`.
 *   · the curated list went stale — positioning-guard scans a hand-written
 *     COPY_FILES set and skips paths that do not exist, so renaming a copy file
 *     emptied its whole input silently.
 *   · the class was disabled — a guard invoked with its pattern source missing
 *     passes because it has no patterns left to apply.
 *
 * They share ONE predicate, and it is the predicate this file tests:
 * **a guard must never exit 0 after checking nothing.**
 *
 * WHY A HARNESS AND NOT A LINT OVER THE SOURCE. The obvious version of this
 * check is a regex hunting `done < <(git ls-files …)`. That catches exactly one
 * syntax. `for f in $(git ls-files)`, `mapfile -t a < <(…)`, `find … > tmp` then
 * reading tmp, `xargs` — same defect, invisible to the pattern, and the next
 * guard gets written in whichever shape the regex does not know. So this asserts
 * BEHAVIOUR: put the script in a state where it would check nothing, and require
 * a non-zero exit.
 *
 * THREE POINTS PER SCRIPT, because one is not enough. A guard that always fails
 * would satisfy "starved → non-zero" on its own, so each entry also pins that a
 * planted violation is caught and that a clean input passes. Only all three
 * together say the guard works.
 *
 * THE COMPLETENESS TEST IS THE POINT. Anyone can add an entry; what stops this
 * from decaying into a per-instance chore is the last test in this file, which
 * derives the gate set from `lefthook.yml` itself and fails when a gate has no
 * entry. That question — "does every gate have a line?" — does not repeat per
 * instance, which is precisely what "fix the class, not the instance" means here.
 *
 * An entry may declare a point EXEMPT, but only with a reason, and the reason is
 * reviewed like code. Four of the seven gates are exempt from `starve` today, and
 * each says why: they are not in the class rather than untested.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Hermetic git: a developer's global core.quotePath / hooksPath must not decide
// whether a case is vacuous.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** Markers assembled at runtime so THIS file is not itself a guard violation. */
const INFRA_HOST = ['control', 'staging'].join('-') + '.lynox.cloud';
const MERGE_MARKER = '<'.repeat(7);
const AVOID_WORD = ['AI', 'powered'].join('-');

let dir: string;

interface RunResult { status: number; stderr: string }

function runFull(cmd: string, args: string[], cwd = dir): RunResult {
  try {
    execFileSync(cmd, args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string | Buffer; signal?: string };
    // `status` is undefined when the process could not be spawned at all. Mapping
    // that to a non-zero number would let a broken harness satisfy every
    // "must refuse" assertion below, so it is its own value and the assertions
    // check for the exact code they expect rather than merely "not 0".
    const status = typeof e.status === 'number' ? e.status : Number.NaN;
    return { status, stderr: String(e.stderr ?? '') };
  }
}

function run(script: string, args: string[] = [], cwd = dir): number {
  return runFull('bash', [join(repoRoot, script), ...args], cwd).status;
}

/** A starved guard must refuse with the shared code AND say why. Exit 2 alone is
 *  not enough: an unrelated crash inside a guard also produces 2, and swapping
 *  the helper's `exit 2` for `exit 1` left every "not 0" assertion green — so the
 *  distinct third code, which is the point of the change, went unpinned. */
function expectRefusedListing(res: RunResult): void {
  expect(res.status, `expected the shared refusal code 2, got ${res.status}`).toBe(2);
  expect(res.stderr).toMatch(/Refusing to report/);
}

function put(relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  execFileSync('git', ['add', '--', relPath], { cwd: dir, env: GIT_ENV });
}

/** The fixture drift-guard's classes D and E need before its A/B/C scans are
 *  reachable — without it those hard-fail and every assertion below is vacuous. */
function driftFixture(): void {
  put('README.md', 'tests-1%2B badge, 1+ tests prose.\nOllama is verified.\n');
  put(
    'src/core/llm/catalog.ts',
    "const OPENAI_COMPAT_PRESETS = [\n  {\n    display_name: 'Ollama (local)',\n    verification: 'verified',\n  },\n] as const;\n",
  );
  put('src/x.test.ts', 'it("t", () => {});\n');
}

/** Every file positioning-guard's curated COPY_FILES names, clean. */
function positioningFixture(): void {
  put('docs/src/content/docs/index.mdx', '# lynox\n\nRuns your business operations.\n');
  put('docs/README.md', '# docs\n\nHow the documentation is organised.\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gharness-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── The three in-class gates: starved, planted, clean ───────────────────────

describe('public-repo-guard', () => {
  it('STARVED (public-repo-guard): refuses instead of reporting clean when the listing fails', () => {
    // Outside a work tree `git ls-files` errors. Before the shared helper the
    // loop ran zero times and this printed `clean ✓` with exit 0.
    const notARepo = mkdtempSync(join(tmpdir(), 'gharness-bare-'));
    try {
      expectRefusedListing(runFull('bash', [join(repoRoot, 'scripts/public-repo-guard.sh')], notARepo));
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('PLANTED: catches a HARD infra marker', () => {
    put('src/leak.ts', `const h = '${INFRA_HOST}';\n`);
    expect(run('scripts/public-repo-guard.sh')).not.toBe(0);
  });

  it('CLEAN: passes a benign tree', () => {
    put('src/ok.ts', 'export const x = 1;\n');
    expect(run('scripts/public-repo-guard.sh')).toBe(0);
  });
});

describe('drift-guard', () => {
  it('STARVED (drift-guard): refuses instead of reporting clean when the listing fails', () => {
    // The fixture is deliberate: a directory that is NOT a git work tree but DOES
    // carry the files classes D and E read. An empty directory would also make
    // this script exit non-zero — but for the wrong reason (class D's awk dies on
    // the missing catalog under `set -e`), which would leave the listing check
    // itself unpinned and the assertion measuring someone else's work. With D/E
    // satisfied, the failed listing is the only thing left to catch.
    const noRepo = mkdtempSync(join(tmpdir(), 'gharness-nogit-'));
    try {
      mkdirSync(join(noRepo, 'src/core/llm'), { recursive: true });
      writeFileSync(join(noRepo, 'README.md'), 'tests-1%2B badge, 1+ tests prose.\nOllama is verified.\n');
      writeFileSync(
        join(noRepo, 'src/core/llm/catalog.ts'),
        "const OPENAI_COMPAT_PRESETS = [\n  {\n    display_name: 'Ollama (local)',\n    verification: 'verified',\n  },\n] as const;\n",
      );
      writeFileSync(join(noRepo, 'src/x.test.ts'), 'it("t", () => {});\n');
      expectRefusedListing(runFull('bash', [join(repoRoot, 'scripts/drift-guard.sh')], noRepo));
    } finally {
      rmSync(noRepo, { recursive: true, force: true });
    }
  });

  it('PLANTED: catches a merge-conflict marker', () => {
    driftFixture();
    put('src/conflict.ts', `${MERGE_MARKER} HEAD\nconst x = 1;\n`);
    expect(run('scripts/drift-guard.sh')).not.toBe(0);
  });

  it('CLEAN: passes a benign tree', () => {
    driftFixture();
    expect(run('scripts/drift-guard.sh')).toBe(0);
  });
});

describe('positioning-guard', () => {
  it('STARVED (positioning-guard): refuses when the curated copy list resolves to nothing', () => {
    // An empty tree: every COPY_FILES path is absent, so the guard would scan
    // zero files. Before the fix it answered `clean ✓`. This is the stale-list
    // axis — no producer failed, the input simply was not there.
    expectRefusedListing(runFull('bash', [join(repoRoot, 'scripts/positioning-guard.sh')]));
  });

  it('STARVED (positioning-guard, partial): refuses when only PART of the curated set is gone', () => {
    // The sharper half. "At least one present" still left a renamed hero page
    // unscanned and green, because the guard kept reporting clean on the part it
    // could still see — a guard half-blind is the same failure direction as one
    // fully blind, just harder to notice.
    positioningFixture();
    rmSync(join(dir, 'docs/README.md'));
    expectRefusedListing(runFull('bash', [join(repoRoot, 'scripts/positioning-guard.sh')]));
  });

  it('PLANTED: catches an avoid-word in a curated copy file', () => {
    // The WHOLE curated set exists here on purpose. With one file missing this
    // case went green off the missing-file refusal instead of the avoid-word
    // scan — an assertion passing for a reason unrelated to what it names.
    positioningFixture();
    put('docs/src/content/docs/index.mdx', `# lynox\n\nAn ${AVOID_WORD} assistant for your business.\n`);
    const res = runFull('bash', [join(repoRoot, 'scripts/positioning-guard.sh')]);
    expect(res.status, 'expected the avoid-word exit 1, not the refusal code').toBe(1);
  });

  it('CLEAN: passes curated copy without an avoid-word', () => {
    positioningFixture();
    expect(run('scripts/positioning-guard.sh')).toBe(0);
  });
});

// ── Completeness: every gate lefthook runs has an entry above ───────────────

/**
 * Every gate lefthook runs, keyed by its step name, with what this harness does
 * about it. `covered` means a starved/planted/clean trio exists above; anything
 * else must say — and PROVE — why it is not in the class.
 *
 * The `starved` probe on an exempt entry is not decoration: an exemption written
 * as prose is a claim, and a claim nobody runs is how "not in the class" quietly
 * becomes "never checked". Each one below re-runs the gate in the stripped state
 * and asserts the exit code the reason names.
 */
type GateEntry =
  | { kind: 'covered' }
  | { kind: 'exempt'; reason: string; expectStrippedExit: number; expectStrippedStderr?: RegExp }
  | { kind: 'external'; reason: string };

const GATES: Readonly<Record<string, GateEntry>> = {
  'public-repo-guard': { kind: 'covered' },
  'drift-guard': { kind: 'covered' },
  'positioning-guard': { kind: 'covered' },
  // The reason below was true and aimed past the defect. This harness starves a
  // guard of its whole TREE, and security-scan does refuse that. What it did not
  // refuse was a single missing member of its hardcoded wrap list: the `-f` test
  // sat inside the grep condition, so a path that had gone dropped out of the set
  // and the loop printed its tick for a set one file short. Measured 2026-09-05 —
  // six of seven existed; google-gmail.ts went with its tool in 1a5eacbd (#180),
  // four months earlier. Fixed, and covered by tests/security-scan.test.ts, which
  // drives the real script against a fixture tree and asserts every member is
  // load-bearing rather than only the one that happened to go.
  //
  // The stripped exit moved 1 → 2 as a RESULT of that fix, and the change is the
  // improvement, not a side effect: outside a source tree the old script fell
  // through to its own exit 1, claiming it had found a violation when what it had
  // was no tree to look at. This harness caught the move on the first run.
  'security-scan': {
    kind: 'exempt',
    reason:
      'refuses rather than reporting clean when its source tree is absent — the starvation THIS harness models, and it now answers 2 rather than 1, because "there is no tree" is not a finding. The other door, a single absent member of its hardcoded wrap list, is not reachable from here and is covered by tests/security-scan.test.ts',
    expectStrippedExit: 2,
  },
  'default-on-inventory': {
    kind: 'exempt',
    reason:
      'resolves its schema relative to the script, so the working directory cannot starve it — and it already carries the assertion this harness generalises ("read zero fields … refusing to report a clean run")',
    expectStrippedExit: 0,
  },
  // Same shape as `no-ai-attribution` below: its input is a commit RANGE passed as
  // arguments, not a tree it enumerates, so the starvation this harness models —
  // an empty file list read as a clean tree — cannot reach it. What it does refuse
  // is a call that supplies only half a range, and that refusal is decided before
  // any pattern is read, which is what makes it the same answer on every machine.
  //
  // What the probe does NOT cover, said here because an exemption that lists only
  // its wins is how a gap becomes invisible: this class is inert until an operator
  // puts patterns in ~/.lynox/private-names.re, and with none it warns and exits 0
  // — which is what a FULL range does on this machine today, measured, not feared.
  // That IS a fail-open, deliberate and with no CI twin. It is not unproven,
  // though — tests/public-repo-guard.test.ts covers it directly ("stands down
  // without a pattern, and refuses a half-given range"); the arming itself is an
  // operator duty no check in this repo can stand in for.
  'public-repo-guard-meta': {
    kind: 'exempt',
    reason:
      'takes its commit range as arguments and enumerates no tree, and refuses a call that does not supply both — same shape as no-ai-attribution below. NOT exempt from exiting 0 after checking nothing: with no pattern configured it does exactly that, deliberately, and the comment above says so',
    expectStrippedExit: 2,
  },
  // The other surface of the same class, and the exemption is the same one for
  // the same reason: the range arrives as arguments, so there is no tree to
  // starve. What it does enumerate — the files each commit in the range touches —
  // it enumerates through `git diff-tree`, whose failure it does NOT swallow: an
  // unresolvable range exits 1 rather than reporting a clean scan, and an empty
  // one says "NO files" instead of "clean ✓". Both are covered directly in
  // tests/public-repo-guard.test.ts, along with the fail-open this shares with
  // the meta half: no pattern configured means it stands down and exits 0, which
  // is deliberate, has no CI twin, and is an operator duty no check here replaces.
  'public-repo-guard-files': {
    kind: 'exempt',
    reason:
      'takes its commit range as arguments and enumerates no tree; a call that does not supply both refs is refused. NOT exempt from the class: the range door is covered in tests/public-repo-guard.test.ts, where an unresolvable range exits 1 and an empty one announces that it scanned nothing rather than reporting clean',
    expectStrippedExit: 2,
  },
  // Same correction as security-scan above. The probe invokes this script with NO
  // arguments, so what it proved was the `usage` path — and the old reason
  // described only the `strip` verb, which takes a file. The `check` verb takes a
  // commit RANGE, and an unresolvable base was exactly the starvation this harness
  // models, reached through a door the probe cannot open: `git rev-list` sat in a
  // `for` header with its status discarded, so it exited 0 with
  // `clean ✓ (0 commits scanned)` on a range it could not read — on a check that
  // is REQUIRED in both repos. Fixed, and covered by tests/no-ai-attribution.test.ts
  // with both halves of an identical-substrate pair.
  'no-ai-attribution': {
    kind: 'exempt',
    reason:
      'enumerates no tree: `strip` takes a commit-message file and `check` takes a commit range, both as arguments, and a call with neither is refused — which is what this probe exercises. It is NOT exempt from the class: the range door is covered by tests/no-ai-attribution.test.ts, where an unreadable range exits 2 instead of reporting clean',
    expectStrippedExit: 2,
  },
  'hex-guard': {
    kind: 'exempt',
    reason: 'staged-mode only, where an empty candidate set is the normal case (most commits stage no component)',
    expectStrippedExit: 0,
  },
  'osv-report-gate': {
    kind: 'exempt',
    reason:
      'judges a report handed to it rather than a tree it enumerates, so it cannot be starved by an empty directory — and it refuses a call with no report instead of reporting clean',
    expectStrippedExit: 1,
    // The exit code alone proves nothing here: a syntax error, a bad import and
    // a deliberate refusal all exit 1. The sentence is what separates "refused"
    // from "crashed", which is the whole claim the exemption makes.
    expectStrippedStderr: /--report <path> is required/,
  },
  // Not our scripts, so there is nothing here to harden — but they still have to
  // be ACCOUNTED for, otherwise "every gate has a line" is only true of the ones
  // that happened to be shell scripts.
  gitleaks: { kind: 'external', reason: 'third-party binary (`gitleaks protect`), not a script in this repo' },
  'pattern-scan': { kind: 'external', reason: 'inline shell in lefthook.yml, not a script file' },
  typecheck: { kind: 'external', reason: 'inline `tsc` invocation, not a scanning guard' },
  'token-contract': { kind: 'external', reason: 'node .mjs design-token check; its own suite covers it' },
  'shape-contract': { kind: 'external', reason: 'node .mjs design-shape check; its own suite covers it' },
  // CI-ONLY: lefthook never runs this one, which is why deriving the inventory
  // from the hook config alone could not see it. Found by the workflow-side
  // derivation below, not by review.
  'gate-record': {
    kind: 'external',
    reason: 'CI-only attestation check (scripts/gate-record.mjs); it reads the PR body, not the tree, and has its own suite',
  },
};

/** The stripped state each exemption is judged in: a git repo with nothing in it. */
function strippedDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gharness-strip-'));
  execFileSync('git', ['init', '-q'], { cwd: d, env: GIT_ENV });
  return d;
}

const EXEMPT_COMMAND: Readonly<Record<string, { cmd: string; args: string[] }>> = {
  'security-scan': { cmd: 'sh', args: [join(repoRoot, 'scripts/security-scan.sh')] },
  'default-on-inventory': { cmd: 'bash', args: [join(repoRoot, 'scripts/default-on-inventory.sh')] },
  // A HALF-given range on purpose. A full one would exit 0 here whenever the
  // operator's pattern list is empty, so the probe's answer would depend on the
  // home directory it runs in — measured, not predicted: on this machine the
  // list holds 33 comment lines and no pattern, and `check-meta A B` returns 0
  // having scanned nothing. The argument-count refusal is decided before any
  // pattern lookup, so it is the same answer everywhere.
  'public-repo-guard-meta': {
    cmd: 'bash',
    args: [join(repoRoot, 'scripts/public-repo-guard.sh'), 'check-meta', 'HEAD'],
  },
  // Half-given range, for the same reason as the line above and measured the same
  // way: a FULL range would return whatever the operator's list happens to be on
  // the machine running the suite, so the probe would answer differently in CI
  // than on a laptop. The argument-count refusal is decided before any pattern
  // lookup and is therefore the same answer everywhere.
  'public-repo-guard-files': {
    cmd: 'bash',
    args: [join(repoRoot, 'scripts/public-repo-guard.sh'), 'check-files', 'HEAD'],
  },
  'no-ai-attribution': { cmd: 'bash', args: [join(repoRoot, 'scripts/no-ai-attribution.sh')] },
  'hex-guard': { cmd: 'bash', args: [join(repoRoot, 'packages/web-ui/scripts/hex-guard.sh')] },
  'osv-report-gate': { cmd: 'node', args: [join(repoRoot, 'scripts/osv-report-gate.mjs')] },
};

/** Gate names derived from the OTHER executor: the workflow files. Mapped by
 *  basename, tolerating the `check-` prefix that two design-token gates carry in
 *  their filename but not in their lefthook step name. */
function ciGateNames(): { names: Set<string>; paths: string[] } {
  const wfDir = join(repoRoot, '.github/workflows');
  const paths = new Set<string>();
  for (const f of readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
    const body = readFileSync(join(wfDir, f), 'utf8');
    for (const m of body.matchAll(/(?:bash|sh|node)\s+((?:[\w./-]+\/)?[\w.-]+\.(?:sh|mjs))/g)) {
      paths.add(m[1] as string);
    }
  }
  const names = new Set<string>();
  for (const p of paths) {
    const base = (p.split('/').pop() ?? '').replace(/\.(sh|mjs)$/, '');
    names.add(base);
    names.add(base.replace(/^check-/, ''));
  }
  return { names, paths: [...paths] };
}

/** Scripts CI runs that are not gates at all. Named, never pattern-matched. */
const NON_GATE = new Set(['scripts/smoke-local.sh']);

describe('gate coverage', () => {
  it('every gate step in lefthook.yml has an entry — whatever it is written in', () => {
    // Keyed on the STEP NAME, not on a path pattern. The first version of this
    // matched `scripts/*.sh`, which is the same discovery-by-name mistake the
    // guards themselves made, one extension further out: it could not see the two
    // `.mjs` gates, the third-party binary, or the inline blocks, and they were
    // silently unaccounted for while the test reported full coverage.
    const lefthook = readFileSync(join(repoRoot, 'lefthook.yml'), 'utf8');
    const steps = [...lefthook.matchAll(/^ {4}([a-z0-9][a-z0-9-]*):$/gm)].map((m) => m[1] as string);
    const unique = [...new Set(steps)].sort();

    expect(unique.length, 'no gate steps parsed out of lefthook.yml — the file shape changed').toBeGreaterThan(5);

    const missing = unique.filter((g) => !(g in GATES));
    expect(
      missing,
      `gate step(s) with no harness entry: ${missing.join(', ')}. Add a starved/planted/clean ` +
      'trio above, or a GATES entry stating — and proving — why the gate is not in the class.',
    ).toEqual([]);

    // And the inverse: an entry for a gate NOTHING runs any more is a stale claim.
    // "Nothing" spans both executors — an entry that only CI runs is not stale.
    const alive = new Set([...unique, ...ciGateNames().names]);
    const stale = Object.keys(GATES).filter((g) => !alive.has(g));
    expect(stale, `harness entries for gates neither lefthook nor CI runs: ${stale.join(', ')}`).toEqual([]);
  });

  it('every gate script CI runs is accounted for too — not just the ones lefthook runs', () => {
    // The membership list has to come from the things that EXECUTE the gates, and
    // there are two of them. Deriving it from lefthook alone leaves a CI-only gate
    // with no entry and nobody the wiser — the same class one level further out,
    // which is how the first version of this test (a `scripts/*.sh` glob) missed
    // the two `.mjs` gates. This assertion is not hypothetical: it is what found
    // `scripts/gate-record.mjs`, a required check lefthook never runs.
    const { paths } = ciGateNames();
    expect(paths.length, 'no gate scripts parsed out of .github/workflows — the shape changed').toBeGreaterThan(0);
    const gateNames = new Set(Object.keys(GATES));
    const unaccounted = paths.filter((path) => {
      if (NON_GATE.has(path)) return false;
      const base = (path.split('/').pop() ?? '').replace(/\.(sh|mjs)$/, '');
      return ![base, base.replace(/^check-/, '')].some((c) => gateNames.has(c));
    });
    expect(
      unaccounted,
      `gate script(s) run by CI with no harness entry: ${unaccounted.join(', ')}. ` +
      'Add a GATES entry, or list it in NON_GATE with the reason it is not a guard.',
    ).toEqual([]);
  });

  for (const [name, entry] of Object.entries(GATES)) {
    if (entry.kind !== 'exempt') continue;
    it(`EXEMPTION HOLDS (${name}): stripped, it exits ${entry.expectStrippedExit} as claimed`, () => {
      const spec = EXEMPT_COMMAND[name];
      expect(spec, `${name} is exempt but has no command to run it with`).toBeDefined();
      const d = strippedDir();
      try {
        const res = runFull(spec!.cmd, spec!.args, d);
        expect(res.status, `exemption reason claims exit ${entry.expectStrippedExit}: ${entry.reason}`)
          .toBe(entry.expectStrippedExit);
        if (entry.expectStrippedStderr) {
          // `res.stderr` alone: `RunResult` declares no `stdout` and `runFull` never
          // sets one, so the old `${res.stdout}` interpolated the literal string
          // "undefined" into every haystack. Harmless only because the one message
          // it guards is on stderr — and invisible because tests are outside tsc.
          expect(res.stderr, `${name} must SAY why it refused, not merely exit`)
            .toMatch(entry.expectStrippedStderr);
        }
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
      // Generous: default-on-inventory scans the real schema and takes ~25s, and
      // the first draft of this loop read that as a failing exemption rather than
      // a slow one. A timeout dressed as a wrong exit code is its own small
      // version of measuring the wrong thing.
    }, 90_000);
  }
});
