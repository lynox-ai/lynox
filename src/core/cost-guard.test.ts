import { describe, it, expect } from 'vitest';
import { CostGuard } from './cost-guard.js';
import type { CostGuardConfig } from '../types/index.js';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

function usage(
  input_tokens: number,
  output_tokens: number,
  cache_creation_input_tokens?: number,
  cache_read_input_tokens?: number,
) {
  return { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } as BetaUsage;
}

describe('CostGuard', () => {
  describe('constructor defaults', () => {
    it('uses Infinity budget and 200 max iterations by default', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      const snap = cg.snapshot();
      expect(snap.estimatedCostUSD).toBe(0);
      expect(snap.budgetPercent).toBe(0);
      expect(snap.iterationsUsed).toBe(0);
    });

    it('sets warnAtUSD to 80% of maxBudgetUSD when not specified', () => {
      const cg = new CostGuard({ maxBudgetUSD: 10 }, 'claude-opus-4-6');
      // Record enough to get past 80% ($8) but not 100%
      // opus input: $5 per 1M tokens → 1M tokens = $5, so 1.6M tokens = $8
      cg.recordTurn(usage(1_600_001, 0));
      expect(cg.shouldWarn()).toBe(true);
    });

    it('falls back to opus pricing for unknown model', () => {
      const cg = new CostGuard({ maxBudgetUSD: 1 }, 'unknown-model-xyz');
      // 1M input tokens at opus pricing = $5
      cg.recordTurn(usage(1_000_000, 0));
      const snap = cg.snapshot();
      expect(snap.estimatedCostUSD).toBe(5);
    });
  });

  describe('iterationCapReached', () => {
    it('tells "out of turns" apart from "out of money"', () => {
      const byTurns = new CostGuard({ maxBudgetUSD: 100, maxIterations: 2 }, 'claude-sonnet-4-6');
      byTurns.recordTurn({ input_tokens: 10, output_tokens: 10 } as never);
      expect(byTurns.isExceeded()).toBe(false);
      expect(byTurns.iterationCapReached()).toBe(false);
      byTurns.recordTurn({ input_tokens: 10, output_tokens: 10 } as never);
      expect(byTurns.isExceeded()).toBe(true);
      expect(byTurns.iterationCapReached()).toBe(true);

      const byMoney = new CostGuard({ maxBudgetUSD: 0.0000001, maxIterations: 50 }, 'claude-sonnet-4-6');
      byMoney.recordTurn({ input_tokens: 1000, output_tokens: 1000 } as never);
      expect(byMoney.isExceeded()).toBe(true);
      expect(byMoney.iterationCapReached()).toBe(false);
    });
  });

  describe('recordTurn', () => {
    it('accumulates tokens across multiple turns', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      cg.recordTurn(usage(100, 200));
      cg.recordTurn(usage(300, 400));
      const snap = cg.snapshot();
      expect(snap.inputTokens).toBe(400);
      expect(snap.outputTokens).toBe(600);
      expect(snap.iterationsUsed).toBe(2);
    });

    it('handles undefined cache fields gracefully', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      cg.recordTurn(usage(100, 200, undefined, undefined));
      const snap = cg.snapshot();
      expect(snap.inputTokens).toBe(100);
      expect(snap.outputTokens).toBe(200);
    });

    it('returns true when budget is exceeded', () => {
      const cg = new CostGuard({ maxBudgetUSD: 0.001 }, 'claude-opus-4-6');
      // 1000 input tokens at opus = $0.015, which exceeds $0.001
      const exceeded = cg.recordTurn(usage(1000, 0));
      expect(exceeded).toBe(true);
    });

    it('returns false when budget is not exceeded', () => {
      const cg = new CostGuard({ maxBudgetUSD: 100 }, 'claude-opus-4-6');
      const exceeded = cg.recordTurn(usage(100, 100));
      expect(exceeded).toBe(false);
    });
  });

  describe('shouldWarn', () => {
    it('fires once when threshold is reached', () => {
      const cg = new CostGuard({ maxBudgetUSD: 10, warnAtUSD: 5 }, 'claude-sonnet-4-6');
      // sonnet input: $3/1M → 2M tokens = $6, which exceeds $5
      cg.recordTurn(usage(2_000_000, 0));
      expect(cg.shouldWarn()).toBe(true);
      expect(cg.shouldWarn()).toBe(false); // second call returns false
    });

    it('resets warned flag after reset()', () => {
      const cg = new CostGuard({ maxBudgetUSD: 10, warnAtUSD: 5 }, 'claude-sonnet-4-6');
      cg.recordTurn(usage(2_000_000, 0));
      expect(cg.shouldWarn()).toBe(true);
      cg.reset();
      // After reset, tokens are 0, so shouldWarn should return false until threshold hit again
      cg.recordTurn(usage(2_000_000, 0));
      expect(cg.shouldWarn()).toBe(true);
    });

    it('returns false when below threshold', () => {
      const cg = new CostGuard({ maxBudgetUSD: 100, warnAtUSD: 50 }, 'claude-opus-4-6');
      cg.recordTurn(usage(100, 100));
      expect(cg.shouldWarn()).toBe(false);
    });
  });

  describe('isExceeded', () => {
    it('true when cost exceeds budget', () => {
      const cg = new CostGuard({ maxBudgetUSD: 0.01 }, 'claude-opus-4-6');
      cg.recordTurn(usage(10_000, 0)); // $0.15, exceeds $0.01
      expect(cg.isExceeded()).toBe(true);
    });

    it('true when iterations reach max', () => {
      const cg = new CostGuard({ maxIterations: 3 }, 'claude-opus-4-6');
      cg.recordTurn(usage(1, 1));
      cg.recordTurn(usage(1, 1));
      expect(cg.isExceeded()).toBe(false);
      cg.recordTurn(usage(1, 1));
      expect(cg.isExceeded()).toBe(true);
    });

    it('false when within both limits', () => {
      const cg = new CostGuard({ maxBudgetUSD: 100, maxIterations: 100 }, 'claude-opus-4-6');
      cg.recordTurn(usage(100, 100));
      expect(cg.isExceeded()).toBe(false);
    });
  });

  describe('snapshot', () => {
    it('returns correct fields', () => {
      const cg = new CostGuard({ maxBudgetUSD: 10 }, 'claude-opus-4-6');
      cg.recordTurn(usage(1000, 2000, 500, 300));
      const snap = cg.snapshot();
      expect(snap.inputTokens).toBe(1000);
      expect(snap.outputTokens).toBe(2000);
      expect(snap.iterationsUsed).toBe(1);
      expect(snap.estimatedCostUSD).toBeGreaterThan(0);
      expect(snap.budgetPercent).toBeGreaterThanOrEqual(0);
      expect(snap.budgetPercent).toBeLessThanOrEqual(100);
    });

    it('budgetPercent is 0 for Infinity budget', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      cg.recordTurn(usage(1_000_000, 1_000_000));
      expect(cg.snapshot().budgetPercent).toBe(0);
    });

    it('budgetPercent reflects cost ratio', () => {
      // opus input $5/1M, so 1M input = $5 → 50% of $10 budget
      const cg = new CostGuard({ maxBudgetUSD: 10 }, 'claude-opus-4-6');
      cg.recordTurn(usage(1_000_000, 0));
      expect(cg.snapshot().budgetPercent).toBe(50);
    });
  });

  describe('estimateCost with cache pricing', () => {
    it('calculates opus pricing correctly', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      cg.recordTurn(usage(1_000_000, 1_000_000, 1_000_000, 1_000_000));
      const snap = cg.snapshot();
      // input: 5, output: 25, cacheWrite: 10 (1h TTL = 2×), cacheRead: 0.50 → total: 40.50
      expect(snap.estimatedCostUSD).toBeCloseTo(40.50, 2);
    });

    it('calculates sonnet pricing correctly', () => {
      const cg = new CostGuard({}, 'claude-sonnet-4-6');
      cg.recordTurn(usage(1_000_000, 1_000_000, 1_000_000, 1_000_000));
      const snap = cg.snapshot();
      // input: 3, output: 15, cacheWrite: 6 (1h TTL = 2×), cacheRead: 0.3 → total: 24.30
      expect(snap.estimatedCostUSD).toBeCloseTo(24.30, 2);
    });

    it('calculates haiku pricing correctly', () => {
      const cg = new CostGuard({}, 'claude-haiku-4-5-20251001');
      cg.recordTurn(usage(1_000_000, 1_000_000, 1_000_000, 1_000_000));
      const snap = cg.snapshot();
      // input: 1, output: 5, cacheWrite: 2 (1h TTL = 2×), cacheRead: 0.10 → total: 8.10
      expect(snap.estimatedCostUSD).toBeCloseTo(8.10, 2);
    });

    it('cache write tokens use cacheWrite rate, not input rate', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      // Only cache write tokens, no input/output — opus 1h cacheWrite = 2× input = $10/M
      cg.recordTurn(usage(0, 0, 1_000_000, 0));
      expect(cg.snapshot().estimatedCostUSD).toBeCloseTo(10, 2);
    });

    it('cache read tokens use cacheRead rate', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      cg.recordTurn(usage(0, 0, 0, 1_000_000));
      expect(cg.snapshot().estimatedCostUSD).toBeCloseTo(0.50, 2);
    });
  });

  /**
   * A run may make a helper call on a DIFFERENT model than its own (the
   * follow-up-chip recovery runs on the fast tier). Those dollars belong on this
   * run's ceiling, but their TOKENS must never be priced here: this guard holds a
   * single `pricePerM`, the run's own.
   */
  describe('recordExternalCost', () => {
    it('charges the ceiling in dollars, at no token price of its own', () => {
      const cg = new CostGuard({ maxBudgetUSD: 10 }, 'claude-opus-4-6');
      cg.recordExternalCost(2.5);
      const snap = cg.snapshot();
      // Exact, not `toBeGreaterThan`: the amount is already priced, so anything
      // that re-prices it (booking it as tokens against opus rates) lands
      // somewhere else entirely.
      expect(snap.estimatedCostUSD).toBe(2.5);
      expect(snap.inputTokens).toBe(0);
      expect(snap.outputTokens).toBe(0);
    });

    it('does not count as an iteration — the model never took this turn', () => {
      const cg = new CostGuard({ maxIterations: 2 }, 'claude-opus-4-6');
      cg.recordExternalCost(0.01);
      cg.recordExternalCost(0.01);
      cg.recordExternalCost(0.01);
      // Implemented via recordTurn (or with an `iterations++`), three helper
      // calls would end the run at its iteration cap having done no work.
      expect(cg.snapshot().iterationsUsed).toBe(0);
      expect(cg.isExceeded()).toBe(false);
    });

    it('trips the ceiling on its own, with no turn ever recorded', () => {
      const cg = new CostGuard({ maxBudgetUSD: 1 }, 'claude-opus-4-6');
      expect(cg.recordExternalCost(0.4)).toBe(false);
      expect(cg.recordExternalCost(0.7)).toBe(true);
      expect(cg.isExceeded()).toBe(true);
    });

    it('ignores a non-finite or non-positive amount instead of poisoning the ceiling', () => {
      const cg = new CostGuard({ maxBudgetUSD: 10 }, 'claude-opus-4-6');
      cg.recordExternalCost(NaN);
      cg.recordExternalCost(Infinity);
      cg.recordExternalCost(-5);
      // A stored NaN makes `estimateCost` non-finite, and `isExceeded` fails
      // CLOSED on that — one malformed price would end every later turn of the
      // run with a budget error. A negative one would refund the ceiling.
      expect(cg.snapshot().estimatedCostUSD).toBe(0);
      expect(cg.isExceeded()).toBe(false);
      cg.recordExternalCost(1);
      expect(cg.snapshot().estimatedCostUSD).toBe(1);
    });
  });

  describe('reset', () => {
    it('clears all accumulated state', () => {
      const cg = new CostGuard({ maxBudgetUSD: 10 }, 'claude-opus-4-6');
      cg.recordTurn(usage(1000, 2000, 500, 300));
      cg.recordExternalCost(3);
      cg.reset();
      const snap = cg.snapshot();
      expect(snap.inputTokens).toBe(0);
      expect(snap.outputTokens).toBe(0);
      // Helper spend included: it is accumulated state like any other, and a
      // field the reset forgets keeps charging the next run for the last one.
      expect(snap.estimatedCostUSD).toBe(0);
      expect(snap.iterationsUsed).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('maxBudgetUSD: 0 is immediately exceeded', () => {
      const cg = new CostGuard({ maxBudgetUSD: 0 }, 'claude-opus-4-6');
      const exceeded = cg.recordTurn(usage(0, 0));
      expect(exceeded).toBe(true);
    });

    it('zero-token usage does not increase cost', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      cg.recordTurn(usage(0, 0, 0, 0));
      expect(cg.snapshot().estimatedCostUSD).toBe(0);
      expect(cg.snapshot().iterationsUsed).toBe(1);
    });
  });
});
