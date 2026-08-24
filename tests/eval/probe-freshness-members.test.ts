import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The MEMBER COUNT for probe fact-freshness.
 *
 * `DEF-dk-xprov-facts-not-fresh-across-runs` was filed against one script. It is not a
 * property of one script: any probe that POSTs a fact to `/api/sessions/:id/run` writes into
 * a store that KEEPS it, so its next run measures dedup. Three such probes existed when this
 * was written, and the first sweep for them missed one — because it was drawn over the
 * DIRECTORY `scripts/model-fitness/` while the class is defined by BEHAVIOUR. A control that
 * proves a pattern matches inside a directory does not prove the directory is the right
 * place to look.
 *
 * ⚠️ WHAT THIS SWEEP IS, stated exactly, because an earlier version of this comment claimed
 * more than it does. It enumerates files that NAME the run route (or reach it through the
 * known transport) and requires each to import the shared module. It is a completeness job
 * over that population — not proof that no probe can hide. **Known gap:** a probe that
 * assembles the path from constants the sweep cannot see would be invisible. That gap is
 * narrow today (`RUN_PARTS` matches the path in pieces, so a split literal still trips it)
 * and it is named here rather than papered over.
 */

const REPO = path.resolve(__dirname, '../..');
/** Where a probe could plausibly live. Kept wide on purpose — the point is not to guess. */
const ROOTS = ['scripts', 'tests'];
/**
 * The route a probe drives, matched in PIECES. A single literal regex missed
 * `base + '/api/sessions/' + id + '/run'`, which is how a probe written by hand tends to
 * look; requiring both fragments in one file catches the split form too.
 */
const RUN_PARTS = ['/api/sessions', '/run'];
/** The module every member must import. */
const FRESHNESS = 'probe-freshness';
/**
 * The module itself. Its docstring names the route it exists to protect, which makes it
 * match the sweep — a module cannot be its own member.
 */
const SELF = 'scripts/model-fitness/probe-freshness.mjs';
/**
 * A TRANSPORT, not a member: an `EngineClient` class with a `run` helper and no fact of its
 * own. Its CALLERS are candidates, so importing it puts a file in the sweep — that is how a
 * probe hiding behind the transport is caught rather than excused.
 */
const TRANSPORT = 'scripts/agent-efficiency/engine-client.ts';

/**
 * Candidates that are NOT members, each with the reason someone had to write down.
 *
 * An allowlist, but not a silent one: a new candidate fails the suite until it is either
 * given the module or entered here WITH a justification. The failure mode is "somebody has
 * to think about it", not "it slipped through" — which is the difference between this and
 * the hand-maintained exclusion the first version had.
 */
const NOT_MEMBERS: Readonly<Record<string, string>> = {
  'scripts/agent-efficiency/measure.ts':
    'drives the engine through EngineClient but writes no KNOWLEDGE row. Its prompts in '
    + 'scripts/agent-efficiency/scenarios.ts do persist things — the promote-attempt scenario '
    + 'orders capture_process '
    + 'and promote_process — but a process/pipeline is not a knowledge_entries row and never '
    + 'enters this dedup candidate set. (An earlier version of this reason claimed every '
    + 'prompt is a question, which is false; the exclusion was right for the wrong reason.)',
};

/**
 * Exclusions that no longer describe a candidate, plus those with no real reason.
 *
 * A pure function on purpose: the previous version inlined this in the `it`, so the only way
 * to mutate it was to edit the assertion — a circular probe that proves nothing
 * (`memory/fb_probe_vs_survivor.md`). Extracted, it can be fed synthetic inputs and the
 * mutation lands on logic instead of on the test.
 */
export function badExclusions(
  notMembers: Readonly<Record<string, string>>,
  found: readonly string[],
): string[] {
  return Object.entries(notMembers)
    // A reason must be substantive AND cite a PATH the next reader can open. Three rules
    // were tried and the first two measured nothing: length alone let the test's own
    // `'a'.repeat(41)` filler through, and a bare filename let `"x.ts"` through — and worse,
    // any prose mentioning `node.js` satisfied it. Requiring a directory separator is what
    // distinguishes a citation from a word that happens to contain a dot.
    //
    // Both halves are AND. The first fix REPLACED the length floor instead of adding to it,
    // which is the overshoot `memory/fb_review_overshoot.md` warns about: adopting a finding
    // is not licence to run the other way.
    .filter(([rel, why]) =>
      !found.includes(rel)
      || why.trim().length <= 40
      // `[\w.-]` on both sides of the separator, not `[\w-]`: the first path-requiring version
      // could not cross a dot in the stem, so it rejected `tests/eval/x.test.ts`,
      // `src/types/index.d.ts` and `./scenarios.ts` — and a reason citing a `.test.ts` is the
      // likeliest entry anyone will write next. Fail-closed, so it was a false red rather
      // than a hole, but a rule that rejects the common case teaches people to skip it.
      || !/[\w.-]*\/[\w.-]*[\w-]\.(ts|tsx|mts|cts|mjs|cjs|js|json|md|ya?ml|sh)\b/.test(why))
    .map(([rel]) => rel)
    .sort();
}

/** Does this source actually IMPORT the thing, or merely mention it? */
export function importsModule(src: string, name: string): boolean {
  return new RegExp(`(import|require)[^\\n]*${name}`).test(src);
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(mjs|ts|js)$/.test(e)) out.push(full);
  }
  return out;
}

function candidates(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(path.join(REPO, root))) {
      const rel = path.relative(REPO, file);
      if (rel === SELF || rel === TRANSPORT) continue;
      if (rel.endsWith('probe-freshness-members.test.ts')) continue;
      const src = readFileSync(file, 'utf8');
      const drivesRoute = RUN_PARTS.every(part => src.includes(part));
      // Import-anchored, not substring: `tests/contract-env.test.ts` merely NAMES
      // `engine-client-pair-boot.test.ts` in a comment and a bare `includes` swept it in.
      const usesTransport = importsModule(src, path.basename(TRANSPORT, '.ts'));
      if (drivesRoute || usesTransport) found.push(rel);
    }
  }
  return found.sort();
}

/** Candidates minus the ones someone has classified out, with a reason, in NOT_MEMBERS. */
function members(): string[] {
  return candidates().filter(rel => !(rel in NOT_MEMBERS));
}

describe('probe fact freshness — every engine-facing probe is a member', () => {
  it('names every CANDIDATE it found, so a shrunken sweep is visible and not silent', () => {
    // The control the first sweep lacked. A wrong root or a broken pattern reports full
    // compliance by finding nothing — the reassuring shape of a blind query
    // (`memory/fb_grep_ist_blind.md`). An exact list, not a `>=` bound: an earlier version
    // asserted `length >= 3` beside three `toContain`s, which cannot fail once they pass.
    expect(candidates()).toEqual([
      'scripts/agent-efficiency/measure.ts',
      'scripts/model-fitness/dk-capture-crossprovider.mjs',
      'scripts/model-fitness/dk-capture-repro.mjs',
      'tests/eval/capture-fitness-runner.mjs',
    ]);
  });

  it('requires every member to import the shared module, and names the ones that do not', () => {
    const offenders = members().filter(
      rel => !importsModule(readFileSync(path.join(REPO, rel), 'utf8'), FRESHNESS),
    );
    // Named, not counted: a new probe should read WHICH file it forgot, not a number.
    expect(offenders).toEqual([]);
  });

  it('rejects a STALE exclusion — an entry that is no longer a candidate', () => {
    // Without this the allowlist rots the way every hand-maintained list rots: the file is
    // renamed or stops driving the engine, the entry stays, and the next reader believes a
    // decision was made about something that is no longer there.
    expect(badExclusions(NOT_MEMBERS, candidates())).toEqual([]);
  });

  it('CATCHES a stale entry and a reasonless one — the check proving it can say no', () => {
    // Fed synthetic inputs, so the mutation lands on `badExclusions` rather than on an
    // assertion. Without this the rule above passes for an empty rule set as readily as for
    // a correct one.
    const real = 'scripts/x.ts';
    const reason = 'not a member: scripts/agent-efficiency/scenarios.ts sends no knowledge row';
    expect(badExclusions({ [real]: reason }, [real])).toEqual([]);
    expect(badExclusions({ 'scripts/gone.ts': reason }, [real])).toEqual(['scripts/gone.ts']);
    // Filler of any length is not a reason — it names no file anyone can open.
    expect(badExclusions({ [real]: 'a'.repeat(200) }, [real])).toEqual([real]);
    expect(badExclusions({ [real]: 'because' }, [real])).toEqual([real]);
    // Short-but-cites and long-but-vague are both rejected — the two halves are AND, not OR.
    expect(badExclusions({ [real]: 'see x.ts' }, [real])).toEqual([real]);
    // Prose that merely contains a dotted word is not a citation — `node.js` passed the
    // bare-filename rule and named nothing anyone can open.
    expect(badExclusions({ [real]: 'this runs under node.js and therefore never persists a row' }, [real])).toEqual([real]);
    // A reason citing a non-TypeScript file by PATH is still a reason.
    expect(badExclusions({ [real]: 'excluded because the deploy path lives in .github/workflows/release.yml only' }, [real])).toEqual([]);
    // A PATH but no substance — the case that makes the length half load-bearing. Without it
    // every fixture failed the path rule first, so removing the length floor changed nothing
    // and survived mutation (measured).
    expect(badExclusions({ [real]: 'a/b.ts' }, [real])).toEqual([real]);
    // Dots INSIDE the stem are the common case and must not be rejected.
    expect(badExclusions({ [real]: 'not a member, the coverage lives in tests/eval/x.test.ts instead' }, [real])).toEqual([]);
    expect(badExclusions({ [real]: 'not a member because the shape is pinned in src/types/index.d.ts' }, [real])).toEqual([]);
  });

  it('FIRES on a file that only mentions the module in a comment', () => {
    // The detector proving it can say no. Without this, an empty needle passes every
    // assertion above — the check would be vacuous and look thorough (verified: it did).
    expect(importsModule('// see probe-freshness.mjs for why\nconst x = 1;', FRESHNESS)).toBe(false);
    expect(importsModule('const s = "probe-freshness";', FRESHNESS)).toBe(false);
    expect(importsModule("import { runToken } from './probe-freshness.mjs';", FRESHNESS)).toBe(true);
    expect(importsModule("const m = require('../probe-freshness.mjs');", FRESHNESS)).toBe(true);
  });

  it('treats a caller of the transport as a candidate, not as exempt', () => {
    // A probe can reach the engine through `EngineClient` and never name the route. The
    // sweep must not let that hide — this pins the rule rather than the current file list.
    const viaTransport = 'import { EngineClient } from "../agent-efficiency/engine-client.js";';
    expect(RUN_PARTS.every(p => viaTransport.includes(p))).toBe(false);
    expect(importsModule(viaTransport, path.basename(TRANSPORT, '.ts'))).toBe(true);
  });
});
