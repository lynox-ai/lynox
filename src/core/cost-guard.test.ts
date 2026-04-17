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
      // input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 → total: 36.75
      expect(snap.estimatedCostUSD).toBeCloseTo(36.75, 2);
    });

    it('calculates sonnet pricing correctly', () => {
      const cg = new CostGuard({}, 'claude-sonnet-4-6');
      cg.recordTurn(usage(1_000_000, 1_000_000, 1_000_000, 1_000_000));
      const snap = cg.snapshot();
      // input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 → total: 22.05
      expect(snap.estimatedCostUSD).toBeCloseTo(22.05, 2);
    });

    it('calculates haiku pricing correctly', () => {
      const cg = new CostGuard({}, 'claude-haiku-4-5-20251001');
      cg.recordTurn(usage(1_000_000, 1_000_000, 1_000_000, 1_000_000));
      const snap = cg.snapshot();
      // input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 → total: 7.35
      expect(snap.estimatedCostUSD).toBeCloseTo(7.35, 2);
    });

    it('cache write tokens use cacheWrite rate, not input rate', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      // Only cache write tokens, no input/output
      cg.recordTurn(usage(0, 0, 1_000_000, 0));
      expect(cg.snapshot().estimatedCostUSD).toBeCloseTo(6.25, 2);
    });

    it('cache read tokens use cacheRead rate', () => {
      const cg = new CostGuard({}, 'claude-opus-4-6');
      cg.recordTurn(usage(0, 0, 0, 1_000_000));
      expect(cg.snapshot().estimatedCostUSD).toBeCloseTo(0.50, 2);
    });
  });

  describe('reset', () => {
    it('clears all accumulated state', () => {
      const cg = new CostGuard({ maxBudgetUSD: 10 }, 'claude-opus-4-6');
      cg.recordTurn(usage(1000, 2000, 500, 300));
      cg.reset();
      const snap = cg.snapshot();
      expect(snap.inputTokens).toBe(0);
      expect(snap.outputTokens).toBe(0);
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
