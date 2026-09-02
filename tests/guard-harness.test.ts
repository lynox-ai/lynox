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
  'security-scan': {
    kind: 'exempt',
    reason: 'refuses rather than reporting clean when its source tree is absent',
    expectStrippedExit: 1,
  },
  'default-on-inventory': {
    kind: 'exempt',
    reason:
      'resolves its schema relative to the script, so the working directory cannot starve it — and it already carries the assertion this harness generalises ("read zero fields … refusing to report a clean run")',
    expectStrippedExit: 0,
  },
  'no-ai-attribution': {
    kind: 'exempt',
    reason: 'takes a commit-message file as an argument; it enumerates no tree and refuses a call without one',
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
          expect(`${res.stdout}${res.stderr}`, `${name} must SAY why it refused, not merely exit`)
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
