import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkSessionBudget, recordSessionCost, getSessionCost, resetSessionCost,
  configurePersistentBudget, checkPersistentBudget, resetPersistentBudget,
  type CostQueryProvider,
} from './session-budget.js';

describe('session-budget', () => {
  beforeEach(() => {
    resetSessionCost();
    resetPersistentBudget();
  });

  it('starts at zero', () => {
    expect(getSessionCost()).toBe(0);
  });

  it('recordSessionCost increments', () => {
    recordSessionCost(5);
    expect(getSessionCost()).toBe(5);
    recordSessionCost(3);
    expect(getSessionCost()).toBe(8);
  });

  it('checkSessionBudget passes under ceiling', () => {
    recordSessionCost(10);
    expect(() => checkSessionBudget(30)).not.toThrow();
  });

  it('checkSessionBudget throws when over ceiling', () => {
    recordSessionCost(45);
    expect(() => checkSessionBudget(10)).toThrow(/Session cost ceiling/);
  });

  it('checkSessionBudget throws at exact boundary', () => {
    recordSessionCost(50);
    expect(() => checkSessionBudget(0.01)).toThrow(/Session cost ceiling/);
  });

  it('resetSessionCost clears counter', () => {
    recordSessionCost(25);
    resetSessionCost();
    expect(getSessionCost()).toBe(0);
    expect(() => checkSessionBudget(40)).not.toThrow();
  });
});

describe('persistent budget', () => {
  const today = new Date().toISOString().slice(0, 10);

  function mockProvider(rows: Array<{ day: string; cost_usd: number; run_count: number }>): CostQueryProvider {
    return { getCostByDay: () => rows };
  }

  beforeEach(() => {
    resetPersistentBudget();
  });

  it('returns allowed when no provider configured', () => {
    const result = checkPersistentBudget();
    expect(result.allowed).toBe(true);
  });

  it('returns allowed when no caps set', () => {
    configurePersistentBudget({ costProvider: mockProvider([]) });
    const result = checkPersistentBudget();
    expect(result.allowed).toBe(true);
  });

  it('returns allowed when under daily cap', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 0.50, run_count: 5 }]),
      dailyCapUSD: 1.00,
    });
    const result = checkPersistentBudget();
    expect(result.allowed).toBe(true);
    expect(result.todayCostUSD).toBe(0.50);
    expect(result.dailyLimitUSD).toBe(1.00);
  });

  it('blocks when daily cap exceeded', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 1.50, run_count: 10 }]),
      dailyCapUSD: 1.00,
    });
    const result = checkPersistentBudget();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily spending cap');
  });

  it('blocks when monthly cap exceeded', () => {
    configurePersistentBudget({
      costProvider: mockProvider([
        { day: today, cost_usd: 5.00, run_count: 5 },
        { day: '2026-03-01', cost_usd: 20.00, run_count: 50 },
      ]),
      monthlyCapUSD: 20.00,
    });
    const result = checkPersistentBudget();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Monthly spending cap');
    expect(result.monthCostUSD).toBe(25.00);
  });

  it('daily cap checked before monthly cap', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 5.00, run_count: 10 }]),
      dailyCapUSD: 1.00,
      monthlyCapUSD: 100.00,
    });
    const result = checkPersistentBudget();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily');
  });

  it('uses default monthly cap when not explicitly set', () => {
    configurePersistentBudget({
      costProvider: mockProvider([]),
      dailyCapUSD: 5.00,
    });
    const result = checkPersistentBudget();
    expect(result.dailyLimitUSD).toBe(5.00);
    expect(result.monthlyLimitUSD).toBe(500); // default cap
  });

  it('allows Infinity to disable caps', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 999, run_count: 1 }]),
      dailyCapUSD: Infinity,
      monthlyCapUSD: Infinity,
    });
    const result = checkPersistentBudget();
    expect(result.allowed).toBe(true);
    expect(result.dailyLimitUSD).toBeNull();
    expect(result.monthlyLimitUSD).toBeNull();
  });

  it('resetPersistentBudget clears config', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 100, run_count: 1 }]),
      dailyCapUSD: 1.00,
    });
    expect(checkPersistentBudget().allowed).toBe(false);
    resetPersistentBudget();
    expect(checkPersistentBudget().allowed).toBe(true);
  });
});
