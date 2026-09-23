/**
 * Invariants of the model-fitness harness that decide what its output MEANS.
 *
 * Covered here rather than in the scripts because `scripts/` is outside the vitest
 * include, so nothing there is executed by CI — the same arrangement, and the same
 * reason, as `tests/model-fitness-replay.test.ts`.
 *
 * Each suite below is a regression test for a defect the harness shipped with.
 */
import { describe, it, expect } from 'vitest';
import { MODEL_CAPABILITIES } from '../src/types/models.js';
import {
  ALL_CANDIDATES, collisionsIn, contextWindowOf, costOf, isEstimatedPrice, overrideCollisions,
} from '../scripts/model-fitness/models.js';
import { CAPABILITIES, countMatched, TIER_JOBS } from '../scripts/model-fitness/capabilities.js';
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
    for (const c of ALL_CANDIDATES) {
      expect(isEstimatedPrice(c.id), `${c.id}`).toBe(MODEL_CAPABILITIES[c.id]?.pricing === undefined);
    }
    expect(ALL_CANDIDATES.some((c) => isEstimatedPrice(c.id)), 'the marker must have something to mark').toBe(true);
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
});

describe('the entity-extraction assertion cannot be satisfied by nothing', () => {
  it('counts a wanted name only when a NAMED entity matches it', () => {
    expect(countMatched(['markus oehrli', 'brunnmatt'], ['markus oehrli', 'brunnmatt ag'])).toBe(2);
    expect(countMatched(['markus oehrli', 'brunnmatt'], ['brunnmatt ag'])).toBe(1);
  });

  it('scores an entity with a missing name as nothing, not as everything', () => {
    // The shipped defect: `want.includes('')` is true for every wanted name, so
    // one entity with no `name` field passed the whole case.
    expect(countMatched(['markus oehrli', 'brunnmatt', 'bexio', 'zürich'], [''])).toBe(0);
    expect(countMatched(['markus oehrli'], ['', 'markus oehrli'])).toBe(1);
  });
});
