import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkSessionBudget, recordSessionCost, getSessionCost,
  configurePersistentBudget, checkPersistentBudget, resetPersistentBudget,
  reservePersistentBudget, releasePersistentBudget, getReservedInFlight,
  persistentBudgetHeadroom,
  type CostQueryProvider,
} from './session-budget.js';
import type { SessionCounters } from '../types/index.js';

function makeCounters(): SessionCounters {
  return {
    httpRequests: 0,
    writeBytes: 0,
    costUSD: 0,
    approvedOutboundDomains: new Set<string>(),
    pendingOutboundPrompts: new Map<string, Promise<boolean>>(),
  };
}

describe('session-budget', () => {
  let counters: SessionCounters;

  beforeEach(() => {
    counters = makeCounters();
    resetPersistentBudget();
  });

  it('starts at zero', () => {
    expect(getSessionCost(counters)).toBe(0);
  });

  it('recordSessionCost increments', () => {
    recordSessionCost(counters, 5);
    expect(getSessionCost(counters)).toBe(5);
    recordSessionCost(counters, 3);
    expect(getSessionCost(counters)).toBe(8);
  });

  it('checkSessionBudget passes under ceiling', () => {
    recordSessionCost(counters, 10);
    expect(() => checkSessionBudget(counters, 30)).not.toThrow();
  });

  it('checkSessionBudget throws when over ceiling', () => {
    recordSessionCost(counters, 45);
    expect(() => checkSessionBudget(counters, 10)).toThrow(/Session cost ceiling/);
  });

  it('checkSessionBudget throws at exact boundary', () => {
    recordSessionCost(counters, 50);
    expect(() => checkSessionBudget(counters, 0.01)).toThrow(/Session cost ceiling/);
  });

  it('checkSessionBudget fails closed on a non-finite estimate without poisoning the counter', () => {
    recordSessionCost(counters, 5);
    // NaN slipping through would make `NaN > cap` false (ceiling skipped) AND
    // `costUSD += NaN` poison the counter permanently.
    expect(() => checkSessionBudget(counters, NaN)).toThrow(/non-finite/);
    expect(getSessionCost(counters)).toBe(5);
  });

  it('fresh counters object starts at zero (replaces process-wide reset)', () => {
    recordSessionCost(counters, 25);
    counters = makeCounters();
    expect(getSessionCost(counters)).toBe(0);
    expect(() => checkSessionBudget(counters, 40)).not.toThrow();
  });

  it('counters are isolated per Session — two counters do not see each other', () => {
    const sessionA = makeCounters();
    const sessionB = makeCounters();
    recordSessionCost(sessionA, 45);
    // Session A is near its cap; Session B is fresh
    expect(() => checkSessionBudget(sessionA, 10)).toThrow();
    expect(() => checkSessionBudget(sessionB, 10)).not.toThrow();
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
    const monthStart = today.slice(0, 7) + '-01'; // a different day in the SAME month
    configurePersistentBudget({
      costProvider: mockProvider([
        { day: today, cost_usd: 5.00, run_count: 5 },
        { day: monthStart, cost_usd: 20.00, run_count: 50 },
      ]),
      monthlyCapUSD: 20.00,
    });
    const result = checkPersistentBudget();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Monthly spending cap');
    expect(result.monthCostUSD).toBeCloseTo(25.00, 2);
  });

  it('monthly cap counts only the current calendar month — a prior-month row is excluded', () => {
    // Last day of the previous month — getCostByDay(31) can still return it near
    // a month boundary, but a calendar-month cap must NOT count it.
    const d = new Date();
    const prevMonthLastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0))
      .toISOString().slice(0, 10);
    configurePersistentBudget({
      costProvider: mockProvider([
        { day: today, cost_usd: 5.00, run_count: 5 },
        { day: prevMonthLastDay, cost_usd: 100.00, run_count: 200 },
      ]),
      monthlyCapUSD: 20.00,
    });
    const result = checkPersistentBudget();
    // Only this month's $5 counts → under the $20 cap (the old rolling 31-day
    // window summed $105 and wrongly blocked, never resetting on the 1st).
    expect(result.allowed).toBe(true);
    expect(result.monthCostUSD).toBeCloseTo(5.00, 2);
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

describe('persistent budget — in-flight reservation (parallel-fire admission control)', () => {
  const today = new Date().toISOString().slice(0, 10);

  function mockProvider(rows: Array<{ day: string; cost_usd: number; run_count: number }>): CostQueryProvider {
    return { getCostByDay: () => rows };
  }

  beforeEach(() => {
    resetPersistentBudget();
  });

  it('no-op when no provider configured (self-hosted, caps off)', () => {
    const r = reservePersistentBudget(15);
    expect(r.allowed).toBe(true);
    expect(r.reservedUSD).toBe(0);
    expect(getReservedInFlight()).toBe(0);
  });

  it('nothing is held for a zero/negative estimate (non-money tasks)', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 10, run_count: 5 }]),
      dailyCapUSD: 100,
    });
    const r = reservePersistentBudget(0);
    expect(r.allowed).toBe(true);
    expect(r.reservedUSD).toBe(0);
    expect(getReservedInFlight()).toBe(0);
  });

  it('admits and HOLDS the estimate when the projection stays within the cap', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 70, run_count: 5 }]),
      dailyCapUSD: 100,
    });
    const r = reservePersistentBudget(15);
    expect(r.allowed).toBe(true);
    expect(r.reservedUSD).toBe(15);
    expect(getReservedInFlight()).toBe(15);
  });

  it('closes the parallel-fire race: sequential reservations accumulate and the cap holds', () => {
    // Recorded $70, cap $100 — the exact race SEC-LC-2 describes: three $15
    // tasks firing in ONE synchronous tick. Without reservation all three read
    // $70 < $100 and run → up to $115 recorded. With reservation the third is
    // refused because 70 + 30 (held) + 15 > 100.
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 70, run_count: 5 }]),
      dailyCapUSD: 100,
    });
    const a = reservePersistentBudget(15); // 70 + 0 + 15 = 85 <= 100
    const b = reservePersistentBudget(15); // 70 + 15 + 15 = 100 <= 100 (reaching the ceiling is allowed)
    const c = reservePersistentBudget(15); // 70 + 30 + 15 = 115 > 100 → BLOCKED
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.reason).toContain('Daily spending cap');
    expect(getReservedInFlight()).toBe(30); // only the two admitted are held
  });

  it('blocks against the monthly cap too', () => {
    const monthStart = today.slice(0, 7) + '-01';
    configurePersistentBudget({
      costProvider: mockProvider([
        { day: today, cost_usd: 1, run_count: 1 },
        { day: monthStart, cost_usd: 495, run_count: 100 },
      ]),
      monthlyCapUSD: 500,
    });
    const r = reservePersistentBudget(15); // month 496 + 15 = 511 > 500
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Monthly spending cap');
    expect(getReservedInFlight()).toBe(0);
  });

  it('release frees the accumulator so recorded spend (not the estimate) governs next', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 70, run_count: 5 }]),
      dailyCapUSD: 100,
    });
    const a = reservePersistentBudget(15);
    const b = reservePersistentBudget(15);
    expect(getReservedInFlight()).toBe(30);
    releasePersistentBudget(a.reservedUSD);
    releasePersistentBudget(b.reservedUSD);
    expect(getReservedInFlight()).toBe(0);
    // Headroom restored → a fresh task admits again.
    expect(reservePersistentBudget(15).allowed).toBe(true);
  });

  it('release never drives the accumulator below zero', () => {
    releasePersistentBudget(999);
    expect(getReservedInFlight()).toBe(0);
  });

  it('reservations do NOT affect checkPersistentBudget — it reads recorded spend only (no self-block)', () => {
    // A worker task reserves its estimate, then session-entry checkPersistentBudget
    // runs for that same task. It must see recorded spend ($70) — NOT the $15
    // reservation — or the task would block itself at its own entry gate.
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 70, run_count: 5 }]),
      dailyCapUSD: 100,
    });
    reservePersistentBudget(15);
    expect(getReservedInFlight()).toBe(15);
    const check = checkPersistentBudget();
    expect(check.allowed).toBe(true);
    expect(check.todayCostUSD).toBe(70);
  });

  // ── persistentBudgetHeadroom: what the WorkerLoop grants a run instead of
  // demanding its worst case. Its own four properties, pinned here rather than through
  // the worker, so each one dies on its own line.

  it('headroom is null when nothing is enforced', () => {
    // No provider configured at all — the caller must be able to tell "no limit" from
    // "no room", because those are opposite decisions. Zero would mean the second.
    expect(persistentBudgetHeadroom()).toBeNull();
  });

  it('headroom is what the TIGHTER of the two caps has left', () => {
    // Daily leaves $5, monthly leaves $2 → $2. A mutant taking the daily cap alone, or
    // Math.max instead of Math.min, hands out money the monthly cap does not have.
    configurePersistentBudget({
      costProvider: mockProvider([
        { day: today, cost_usd: 95, run_count: 1 },
        { day: `${today.slice(0, 8)}01`, cost_usd: 403, run_count: 9 },
      ]),
      dailyCapUSD: 100,
      monthlyCapUSD: 500,
    });
    // today 95 of 100 → 5 · month 498 of 500 → 2
    expect(persistentBudgetHeadroom()).toBeCloseTo(2, 6);
  });

  it('headroom subtracts what is already reserved in flight', () => {
    // The tick dispatches every due task synchronously, so without this two tasks are
    // both granted the same headroom and together overshoot the cap — the exact race
    // the reservation accumulator exists for.
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 10, run_count: 1 }]),
      dailyCapUSD: 100,
    });
    expect(persistentBudgetHeadroom()).toBe(90);
    reservePersistentBudget(40);
    expect(persistentBudgetHeadroom(), 'the second task sees the first one\'s hold').toBe(50);
  });

  it('headroom never goes negative', () => {
    // A cap lowered below what was already spent. Negative would read as "owes money" to
    // a caller that compares it against a minimum, and `min(estimate, -3)` would travel
    // into a run's cost ceiling as a negative dollar amount.
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 13, run_count: 1 }]),
      dailyCapUSD: 10,
    });
    expect(persistentBudgetHeadroom()).toBe(0);
  });

  it('resetPersistentBudget clears the in-flight accumulator', () => {
    configurePersistentBudget({
      costProvider: mockProvider([{ day: today, cost_usd: 10, run_count: 1 }]),
      dailyCapUSD: 100,
    });
    reservePersistentBudget(15);
    expect(getReservedInFlight()).toBe(15);
    resetPersistentBudget();
    expect(getReservedInFlight()).toBe(0);
  });
});
