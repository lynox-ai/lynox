/**
 * Invariants of the model-fitness harness that decide what its output MEANS.
 *
 * Covered here rather than in the scripts because `scripts/` is outside the vitest
 * include: nothing there is COLLECTED, so a test written next to the code would never
 * run. A test under `tests/` can import and execute it, which is what these do — the
 * same arrangement, and the same reason, as `tests/model-fitness-replay.test.ts`.
 * Note that `tests/model-fitness-*.test.ts` are not in `tsconfig.tests.json` either,
 * so this executes the harness; it does not typecheck it.
 *
 * Each suite below is a regression test for a defect the harness shipped with.
 */
import { describe, it, expect } from 'vitest';
import { MODEL_CAPABILITIES } from '../src/types/models.js';
import {
  ALL_CANDIDATES, collisionsIn, contextWindowOf, costOf, isEstimatedPrice, overrideCollisions,
} from '../scripts/model-fitness/models.js';
import { CAPABILITIES, countMatched, EXTRACTION_GROUND_TRUTH, TIER_JOBS } from '../scripts/model-fitness/capabilities.js';
import { JUDGE_MODEL } from '../scripts/model-fitness/judge.js';
import { SCENARIOS } from '../scripts/model-fitness/scenarios.js';

describe('OVERRIDES is a fallback, not a second source of truth', () => {
  // The shipped defect: three rows (`mistral-medium-2604`, the Fireworks `glm-5p2`
  // and the Fireworks `deepseek-v4-pro`) were written before the engine carried
  // those ids and then silently shadowed the registry, so the tier-fitness grid
  // priced Mistral Medium 3.5 at 0.40/2.00 against the 1.50/7.50 MODEL_CAPABILITIES
  // holds — on the very axis the grid exists to decide. Nothing was red.
  it('detects a row that duplicates the registry', () => {
    // The positive control, and it is the point of this suite: asserting only that
    // the live set is empty cannot tell "no duplicates" from "the detector is
    // broken" — a `collisionsIn` that returned [] unconditionally passed that.
    expect(collisionsIn({ 'a': 1, 'b': 2 }, { 'a': {} })).toEqual(['a']);
    expect(collisionsIn({ 'a': 1 }, {})).toEqual([]);
  });

  it('has no live row that duplicates the registry', () => {
    expect(overrideCollisions()).toEqual([]);
  });

  // Stated limit, measured not assumed: flipping contextWindowOf/costOf back to
  // override-wins SURVIVES every assertion here, because with the collision set
  // empty the precedence is unobservable through them. Pinning it would take an
  // injected table for a rule that is already unreachable. The drift path that
  // matters is covered — the day the engine gains an id this table holds, the
  // test above goes red on the PR that adds it.
  it('resolves every candidate to a context window and a price', () => {
    // run.ts coerces a missing window to 0 and a missing price to Infinity, so an
    // unresolvable candidate is silently dropped as "context-unfit" rather than
    // reported. Nothing in the run says it happened.
    for (const c of ALL_CANDIDATES) {
      expect(contextWindowOf(c.id), `${c.label} (${c.id}) has no context window`).toBeGreaterThan(0);
      expect(costOf(c.id), `${c.label} (${c.id}) has no price`).toBeDefined();
    }
  });

  it('marks a price as estimated exactly when it did not come from the registry', () => {
    // Named pairs, not a restatement of the implementation: a sweep that compares
    // the helper against its own first conjunct passes under an implementation that
    // has dropped the second one.
    expect(isEstimatedPrice('openai/gpt-5.2'), 'in OVERRIDES only').toBe(true);
    expect(isEstimatedPrice('mistral-medium-2604'), 'in the registry').toBe(false);
    // The case that pins the second conjunct: an id in NEITHER table has no price,
    // so there is no estimate to mark.
    expect(isEstimatedPrice('no-such-model-anywhere'), 'in neither table').toBe(false);
    // Deliberately NOT a sweep over ALL_CANDIDATES comparing the helper to its own
    // first conjunct: that restates the implementation, and it would also contradict
    // the line above for a candidate in neither table. The separate "resolves every
    // candidate" test is what catches one of those appearing.
  });
});

describe('the judge is not one of the things it judges', () => {
  it('the judge model is not in the candidate roster', () => {
    // The id-level half of "judge not in candidate families". The family-level half
    // stays prose — an id does not carry its family — and the prose has drifted here
    // twice already, so this pins what can be pinned.
    expect(ALL_CANDIDATES.map((c) => c.id)).not.toContain(JUDGE_MODEL);
  });
});

describe('a candidate resolves its key from the right provider', () => {
  // run.ts defaults an `openai`-provider candidate to MISTRAL_API_KEY. That is
  // correct for every row today only because every non-Mistral OpenAI-compatible
  // row happens to set `keyEnv`; the pairing is convention, and a row added
  // without it would send the Mistral key to another host.
  it('requires an explicit keyEnv on every non-Mistral OpenAI-compatible row', () => {
    const offenders = ALL_CANDIDATES.filter(
      (c) => c.provider === 'openai' && c.apiBaseURL !== undefined
        && !c.apiBaseURL.includes('mistral.ai') && c.keyEnv === undefined,
    );
    expect(offenders.map((c) => c.id)).toEqual([]);
  });
});

describe('the coverage index and the cases do not drift apart', () => {
  // TIER_JOBS is the ○/✓ map the README is read from. `covers` is hand-typed, so
  // without this it can name a case that was renamed or never existed, and the
  // index would claim coverage nothing provides.
  it('every TIER_JOBS `covers` names a case that exists', () => {
    const ids = new Set([...CAPABILITIES, ...SCENARIOS].map((c) => c.id));
    const dangling = Object.values(TIER_JOBS).flat()
      .map((j) => j.covers).filter((c): c is string => c !== null && c !== undefined)
      .filter((c) => !ids.has(c));
    expect(dangling).toEqual([]);
  });

  it('no job is still marked ○ once a case claims it', () => {
    // The other direction, and the one that actually went wrong: the README's map
    // showed two covered jobs as open gaps because nothing checked this way round.
    const jobsWithACase = new Set([...CAPABILITIES, ...SCENARIOS]
      .map((c) => c.job).filter((j): j is string => j !== undefined));
    const understated = Object.values(TIER_JOBS).flat()
      .filter((j) => j.covers === null && jobsWithACase.has(j.job))
      .map((j) => j.job);
    expect(understated).toEqual([]);
  });
});

describe('the entity-extraction assertion cannot be satisfied by nothing', () => {
  it('counts a wanted name only when a NAMED entity matches it', () => {
    expect(countMatched(['ada lovelace', 'acme'], ['ada lovelace', 'acme ag'])).toBe(2);
    expect(countMatched(['ada lovelace', 'acme'], ['acme ag'])).toBe(1);
  });

  it('scores an entity with a missing name as nothing, not as everything', () => {
    // The shipped defect: `want.includes('')` is true for every wanted name, so
    // one entity with no `name` field passed the whole case.
    expect(countMatched(['ada lovelace', 'acme', 'beispielware', 'zürich'], [''])).toBe(0);
    expect(countMatched(['ada lovelace'], ['', 'ada lovelace'])).toBe(1);
  });

  it('keeps the property the token filter\'s threshold rests on', () => {
    // `countMatched` keys on each wanted name's LAST token. That a one-character
    // token can never match such a key is why the filter's exact threshold is
    // unobservable — a fact about this data, not about the code. This is the alarm
    // for that: add a single-character entry and this fails here, on the PR that
    // adds it, instead of the reasoning failing silently.
    for (const w of EXTRACTION_GROUND_TRUTH) {
      const last = w.split(' ').filter((t) => t.length > 0).at(-1);
      expect(last, `"${w}" has no token`).toBeDefined();
      expect(last!.length, `"${w}" keys on a single character`).toBeGreaterThan(1);
    }
  });

  it('is not satisfied by fragments, padding, or one entity covering everything', () => {
    // Three generations of this defect, each found after the previous fix was called
    // complete: the empty string, then any fragment, then padding — and a single blob
    // naming all four, which no amount of per-name matching catches. Each form gets
    // its own line so a future narrowing cannot quietly drop one.
    const want = ['ada lovelace', 'acme', 'beispielware', 'zürich'];
    expect(countMatched(want, ['a', 'b', 'c', 'x']), 'one-character noise').toBe(0);
    expect(countMatched(want, ['lace', 'cme']), 'fragments of the new keys').toBe(0);
    expect(countMatched(want, ['xlovelacex', 'xacmex', 'xbeispielwarex', 'xzürichx']), 'padding').toBe(0);
    expect(countMatched(want, ['ada lovelace acme beispielware zürich']), 'one entity for all four').toBe(1);
    // …while the legitimate forms still count: the whole name, a longer form of it,
    // and the distinctive token on its own.
    expect(countMatched(want, ['ada lovelace', 'acme ag', 'beispielware', 'zürich'])).toBe(4);
    expect(countMatched(['ada lovelace'], ['lovelace'])).toBe(1);
  });
});
