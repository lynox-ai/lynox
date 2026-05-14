/**
 * Session-level cost tracking shared across spawn_agent tool calls
 * and pipeline step agents.
 *
 * The ceiling prevents unbounded spending across all agent-creation paths
 * in a single process session.
 */

import type { PersistentBudgetCheck, SessionCounters } from '../types/index.js';

const DEFAULT_SESSION_COST_USD = 50;

/**
 * Per-Session cumulative cost lives on `SessionCounters.costUSD` (owned by
 * Session, propagated through Agent + sub-agents). Previously a
 * module-level `sessionCostUSD` that accumulated for the lifetime of the
 * engine process across every Session — the audit's T1 finding called it
 * out as "masquerades as per-session state."
 *
 * `_maxSessionCostUSD` stays module-level: it's process-wide config set
 * once at engine init (engine = 1 tenant per [[feedback_one_engine_per_tenant]])
 * and read against every Session's counters object on the hot path.
 */
let _maxSessionCostUSD = DEFAULT_SESSION_COST_USD;

/**
 * Check if the estimated cost would exceed the session ceiling.
 * Throws if it would. Reserves the estimated cost immediately to prevent
 * race conditions when parallel spawns both pass the check before either
 * records — both reservations write to the same Session's counters, so
 * the second check sees the first reservation.
 */
export function checkSessionBudget(counters: SessionCounters, estimatedCostUSD: number): void {
  if (counters.costUSD + estimatedCostUSD > _maxSessionCostUSD) {
    throw new Error(
      `Session cost ceiling ($${String(_maxSessionCostUSD)}) would be exceeded. ` +
      `Current: $${counters.costUSD.toFixed(2)}, estimated: $${estimatedCostUSD.toFixed(2)}.`,
    );
  }
  counters.costUSD += estimatedCostUSD; // reserve immediately
}

/** Record cost spent by an agent (spawn or pipeline step). */
export function recordSessionCost(counters: SessionCounters, costUSD: number): void {
  counters.costUSD += costUSD;
}

/** Adjust session cost (e.g., correct after reservation vs actual). */
export function adjustSessionCost(counters: SessionCounters, delta: number): void {
  counters.costUSD += delta;
}

/** Get the current session cost. */
export function getSessionCost(counters: SessionCounters): number {
  return counters.costUSD;
}

// === Persistent daily/monthly budget enforcement ===

/** Minimal interface to avoid importing RunHistory directly. */
export interface CostQueryProvider {
  getCostByDay(days: number): Array<{ day: string; cost_usd: number; run_count: number }>;
}

let _costProvider: CostQueryProvider | null = null;
const DEFAULT_DAILY_CAP_USD = 100;
const DEFAULT_MONTHLY_CAP_USD = 500;

let _dailyCapUSD = DEFAULT_DAILY_CAP_USD;
let _monthlyCapUSD = DEFAULT_MONTHLY_CAP_USD;

/** Configure persistent budget caps. Called once at orchestrator init. */
export function configurePersistentBudget(opts: {
  costProvider: CostQueryProvider;
  sessionCapUSD?: number | undefined;
  dailyCapUSD?: number | undefined;
  monthlyCapUSD?: number | undefined;
}): void {
  _costProvider = opts.costProvider;
  _maxSessionCostUSD = opts.sessionCapUSD ?? DEFAULT_SESSION_COST_USD;
  _dailyCapUSD = opts.dailyCapUSD ?? DEFAULT_DAILY_CAP_USD;
  _monthlyCapUSD = opts.monthlyCapUSD ?? DEFAULT_MONTHLY_CAP_USD;
}

/** Check if persistent daily/monthly budget allows another run. */
export function checkPersistentBudget(): PersistentBudgetCheck {
  if (!_costProvider || !_costProvider.getCostByDay || (_dailyCapUSD === Infinity && _monthlyCapUSD === Infinity)) {
    return { allowed: true, todayCostUSD: 0, monthCostUSD: 0, dailyLimitUSD: null, monthlyLimitUSD: null };
  }

  const rows = _costProvider.getCostByDay(31);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const todayCost = rows.find(r => r.day === today)?.cost_usd ?? 0;
  const monthCost = rows.reduce((sum, r) => sum + r.cost_usd, 0);

  if (_dailyCapUSD < Infinity && todayCost >= _dailyCapUSD) {
    return {
      allowed: false, todayCostUSD: todayCost, monthCostUSD: monthCost,
      dailyLimitUSD: _dailyCapUSD, monthlyLimitUSD: _monthlyCapUSD < Infinity ? _monthlyCapUSD : null,
      reason: `Daily spending cap ($${_dailyCapUSD}) reached. Today: $${todayCost.toFixed(2)}.`,
    };
  }

  if (_monthlyCapUSD < Infinity && monthCost >= _monthlyCapUSD) {
    return {
      allowed: false, todayCostUSD: todayCost, monthCostUSD: monthCost,
      dailyLimitUSD: _dailyCapUSD < Infinity ? _dailyCapUSD : null, monthlyLimitUSD: _monthlyCapUSD,
      reason: `Monthly spending cap ($${_monthlyCapUSD}) reached. This month: $${monthCost.toFixed(2)}.`,
    };
  }

  return {
    allowed: true, todayCostUSD: todayCost, monthCostUSD: monthCost,
    dailyLimitUSD: _dailyCapUSD < Infinity ? _dailyCapUSD : null,
    monthlyLimitUSD: _monthlyCapUSD < Infinity ? _monthlyCapUSD : null,
  };
}

/** Reset persistent budget config (for testing). */
export function resetPersistentBudget(): void {
  _costProvider = null;
  _maxSessionCostUSD = DEFAULT_SESSION_COST_USD;
  _dailyCapUSD = DEFAULT_DAILY_CAP_USD;
  _monthlyCapUSD = DEFAULT_MONTHLY_CAP_USD;
}
