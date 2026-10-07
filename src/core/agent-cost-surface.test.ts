import { describe, it, expect } from 'vitest';
import { Agent } from './agent.js';

/**
 * `chargeExternalCost` against a REAL Agent — the method `spawn_agent` reaches a
 * delegating run's cost ceiling through.
 *
 * ⛔ WHY THIS FILE EXISTS: a surviving mutant. Making the method a no-op passed every
 * test of the spawn and cost-guard suites, because those drive a MOCKED agent — they
 * prove the tool CALLS the method, never that the method reaches the guard. The ceiling
 * lives on a private field, so this wiring is the only thing between a child's spend and
 * the run's own arithmetic, and it was held by nothing.
 *
 * The effect is read through `getCostSnapshot`, which is the surface `spawn.ts` already
 * uses to read a child's cost — so this asserts a number the product itself consumes
 * rather than one added for the test.
 *
 * No LLM call and no network: the booking is a write against the guard the constructor
 * built.
 */
describe("the agent's booking onto its own cost ceiling", () => {
  it('books an external cost so the run can see it', () => {
    const agent = new Agent({
      name: 'parent', model: 'claude-sonnet-4-6',
      costGuard: { maxBudgetUSD: 1 },
    });
    expect(agent.getCostSnapshot()?.estimatedCostUSD, 'nothing spent before the booking').toBe(0);

    agent.chargeExternalCost(0.25);

    // ⛔ The assertion the no-op mutant cannot pass: the number MOVED. A test that only
    // checked the call did not throw would survive it.
    expect(agent.getCostSnapshot()?.estimatedCostUSD, "a child's spend is on the parent's ceiling")
      .toBeCloseTo(0.25, 6);
  });

  it('is a no-op without a ceiling, and does not throw', () => {
    // A run with no cost guard at all — self-host or BYOK with no configured budget.
    // The caller books before it knows whether anyone is counting, so this must be safe.
    const agent = new Agent({ name: 'parent', model: 'claude-sonnet-4-6' });
    expect(() => agent.chargeExternalCost(0.25)).not.toThrow();
    expect(agent.getCostSnapshot(), 'no guard, no snapshot').toBeNull();
  });
});
