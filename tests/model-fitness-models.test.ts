/**
 * The candidate roster's one invariant: `OVERRIDES` is a FALLBACK for models the
 * engine does not ship yet, never a second opinion about one it does.
 *
 * Covered here rather than in the script because `scripts/` is outside the vitest
 * include, so nothing there is executed by CI — the same arrangement, and the same
 * reason, as `tests/model-fitness-replay.test.ts`.
 *
 * This is a regression test for a defect the harness shipped with: three rows
 * (`mistral-medium-2604`, the Fireworks `glm-5p2`, the Fireworks `deepseek-v4-pro`)
 * were written before the engine carried those ids and then silently shadowed the
 * registry, so the tier-fitness grid priced Mistral Medium 3.5 at 0.40/2.00 against
 * the 1.50/7.50 `MODEL_CAPABILITIES` holds — on the very axis the grid exists to
 * decide. Nothing was red; the numbers were simply wrong.
 *
 * A stated limit, measured rather than assumed: the first test is the load-bearing
 * one. Flipping `contextWindowOf`/`costOf` back to override-wins SURVIVES all three
 * assertions, because with the collision set empty the precedence is unobservable —
 * the two halves of the fix hide each other. Pinning it would take an injected table,
 * and the drift path that actually matters is covered: the day the engine gains an id
 * this table holds, the first test goes red on that PR.
 */
import { describe, it, expect } from 'vitest';
import { MODEL_CAPABILITIES } from '../src/types/models.js';
import { ALL_CANDIDATES, contextWindowOf, costOf, overrideCollisions } from '../scripts/model-fitness/models.js';

describe('model-fitness candidate roster', () => {
  it('has no OVERRIDES row that duplicates the engine registry', () => {
    expect(overrideCollisions()).toEqual([]);
  });

  it('reads context and price from the registry when it carries the id', () => {
    const id = 'mistral-medium-2604';
    const reg = MODEL_CAPABILITIES[id];
    expect(reg, `${id} must be in the engine registry for this test to mean anything`).toBeDefined();
    expect(contextWindowOf(id)).toBe(reg!.contextWindow);
    expect(costOf(id)?.input).toBe(reg!.pricing.input);
    expect(costOf(id)?.output).toBe(reg!.pricing.output);
  });

  it('still resolves a candidate the registry does not carry', () => {
    const off = ALL_CANDIDATES.find((c) => MODEL_CAPABILITIES[c.id] === undefined);
    expect(off, 'the roster should keep at least one not-yet-shipped candidate').toBeDefined();
    expect(contextWindowOf(off!.id)).toBeGreaterThan(0);
    expect(costOf(off!.id)?.input).toBeGreaterThan(0);
  });
});
