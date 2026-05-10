import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_BUDGET_USD,
  DEFAULT_INPUT_COST_PER_MTOK,
  DEFAULT_OUTPUT_COST_PER_MTOK,
  InboxCostBudget,
} from './cost-budget.js';

describe('InboxCostBudget — accounting', () => {
  it('starts at zero spend, not exceeded', () => {
    const b = new InboxCostBudget();
    const s = b.snapshot();
    expect(s.spentUSD).toBe(0);
    expect(s.exceeded).toBe(false);
    expect(s.percent).toBe(0);
    expect(s.budgetUSD).toBe(DEFAULT_DAILY_BUDGET_USD);
  });

  it('records usage and converts to USD via Haiku reference pricing', () => {
    const b = new InboxCostBudget();
    // 1M input tokens * $1 + 1M output tokens * $5 = $6
    b.recordUsage(1_000_000, 1_000_000);
    const s = b.snapshot();
    expect(s.spentUSD).toBeCloseTo(
      DEFAULT_INPUT_COST_PER_MTOK + DEFAULT_OUTPUT_COST_PER_MTOK,
    );
    expect(s.exceeded).toBe(true);
  });

  it('caps percent at 100 even when overspent', () => {
    const b = new InboxCostBudget({ maxBudgetUSD: 1 });
    b.recordUsage(2_000_000, 0); // $2 > $1 budget
    expect(b.snapshot().percent).toBe(100);
  });

  it('returns percent=0 when budget is Infinity (cap disabled)', () => {
    const b = new InboxCostBudget({ maxBudgetUSD: Infinity });
    b.recordUsage(1_000_000, 1_000_000);
    expect(b.snapshot().percent).toBe(0);
    expect(b.snapshot().exceeded).toBe(false);
  });
});

describe('InboxCostBudget — circuit breaker', () => {
  it('isExceeded flips once spend hits the cap exactly', () => {
    const b = new InboxCostBudget({ maxBudgetUSD: 0.001 });
    expect(b.isExceeded()).toBe(false);
    // 1000 input tokens * $1 / 1M = $0.001 — at the cap, exceeded=true
    b.recordUsage(1000, 0);
    expect(b.isExceeded()).toBe(true);
  });

  it('uses custom per-Mtok pricing overrides', () => {
    const b = new InboxCostBudget({
      maxBudgetUSD: 0.5,
      inputCostPerMtok: 10,
      outputCostPerMtok: 50,
    });
    // 10K input * $10 / 1M + 1K output * $50 / 1M = $0.10 + $0.05 = $0.15
    b.recordUsage(10_000, 1000);
    expect(b.snapshot().spentUSD).toBeCloseTo(0.15);
    expect(b.isExceeded()).toBe(false);
  });
});

describe('InboxCostBudget — daily roll', () => {
  it('resets spend when the UTC day changes', () => {
    let now = new Date('2026-05-10T23:50:00Z');
    const b = new InboxCostBudget({ clock: () => now });
    b.recordUsage(500_000, 0);
    expect(b.snapshot().day).toBe('2026-05-10');
    expect(b.snapshot().spentUSD).toBeCloseTo(0.5);
    // Cross UTC midnight
    now = new Date('2026-05-11T00:01:00Z');
    const s = b.snapshot();
    expect(s.day).toBe('2026-05-11');
    expect(s.spentUSD).toBe(0);
    expect(s.exceeded).toBe(false);
  });

  it('reset() forces a roll within the same day', () => {
    const b = new InboxCostBudget();
    b.recordUsage(1_000_000, 0);
    expect(b.snapshot().spentUSD).toBeGreaterThan(0);
    b.reset();
    expect(b.snapshot().spentUSD).toBe(0);
  });
});
