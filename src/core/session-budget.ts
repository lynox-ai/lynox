/**
 * Session-level cost tracking shared across spawn_agent tool calls
 * and pipeline step agents.
 *
 * The ceiling prevents unbounded spending across all agent-creation paths
 * in a single process session.
 */

import type { PersistentBudgetCheck, PersistentBudgetReservation, SessionCounters } from '../types/index.js';

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

/**
 * Estimated cost held for background runs that have passed the daily/monthly
 * gate but whose actual spend hasn't yet landed in the cost provider. The
 * WorkerLoop tick fires ALL due tasks in parallel (`void executeTask(...)`);
 * without a reservation each reads the same pre-run recorded total, all pass,
 * and collectively overshoot the cap. Each money-minting task reserves its
 * worst-case cost before dispatch and releases it once the run records. One
 * engine = one tenant ([[feedback_one_engine_per_tenant]]), so a module-level
 * accumulator is process-correct.
 */
let _reservedInFlightUSD = 0;

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

/**
 * Recorded today/month spend from the cost provider, or null when no provider
 * is configured or both caps are disabled (no enforcement). Shared by
 * {@link checkPersistentBudget} (recorded-only hard stop) and
 * {@link reservePersistentBudget} (admission control) so the two never drift.
 */
function computeRecordedSpend(): { todayCost: number; monthCost: number } | null {
  if (!_costProvider || !_costProvider.getCostByDay || (_dailyCapUSD === Infinity && _monthlyCapUSD === Infinity)) {
    return null;
  }
  const rows = _costProvider.getCostByDay(31);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const currentMonth = today.slice(0, 7); // YYYY-MM
  const todayCost = rows.find(r => r.day === today)?.cost_usd ?? 0;
  // Calendar-month cap, not a rolling 31-day window: only sum rows in the
  // current month so the cap actually RESETS on the 1st. Summing all 31 rows let
  // last month's spend bleed into "this month" and the cap never reset, wrongly
  // blocking (or, mid-month, allowing) a tenant near month boundaries. 31 days is
  // always enough to cover any calendar month, so no row is missed.
  const monthCost = rows
    .filter(r => r.day.slice(0, 7) === currentMonth)
    .reduce((sum, r) => sum + r.cost_usd, 0);
  return { todayCost, monthCost };
}

/** Check if persistent daily/monthly budget allows another run. */
export function checkPersistentBudget(): PersistentBudgetCheck {
  const spend = computeRecordedSpend();
  if (!spend) {
    return { allowed: true, todayCostUSD: 0, monthCostUSD: 0, dailyLimitUSD: null, monthlyLimitUSD: null };
  }
  const { todayCost, monthCost } = spend;

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

/**
 * Admission control for parallel background dispatch. Projects `estimatedCostUSD`
 * (a run's WORST case) on top of recorded spend AND already-reserved in-flight
 * cost, then admits only if the projection stays within the caps — so a tick
 * that fires N due tasks at once can't collectively overshoot. On admission the
 * estimate is held in the module accumulator (visible to the next task in the
 * same synchronous tick); the caller MUST {@link releasePersistentBudget} it
 * once the run's actual cost has landed in the provider.
 *
 * Worst-case reservation is deliberate: it can defer a would-be-cheap task when
 * the tenant is right at the cap edge — which for a hard cost ceiling is the
 * intended safe behavior (the task retries next tick / after the daily reset).
 * `checkPersistentBudget` still reads recorded-only, so this never self-blocks a
 * run at its own session-entry gate.
 */
export function reservePersistentBudget(estimatedCostUSD: number): PersistentBudgetReservation {
  const spend = computeRecordedSpend();
  if (!spend || estimatedCostUSD <= 0) {
    // No enforcement (no provider / caps disabled), or nothing to reserve.
    return { allowed: true, reservedUSD: 0 };
  }
  const projectedToday = spend.todayCost + _reservedInFlightUSD + estimatedCostUSD;
  const projectedMonth = spend.monthCost + _reservedInFlightUSD + estimatedCostUSD;
  if (_dailyCapUSD < Infinity && projectedToday > _dailyCapUSD) {
    return {
      allowed: false, reservedUSD: 0,
      reason: `Daily spending cap ($${_dailyCapUSD}) would be exceeded by in-flight tasks.`,
    };
  }
  if (_monthlyCapUSD < Infinity && projectedMonth > _monthlyCapUSD) {
    return {
      allowed: false, reservedUSD: 0,
      reason: `Monthly spending cap ($${_monthlyCapUSD}) would be exceeded by in-flight tasks.`,
    };
  }
  _reservedInFlightUSD += estimatedCostUSD;
  return { allowed: true, reservedUSD: estimatedCostUSD };
}

/** Release a reservation held by {@link reservePersistentBudget}. */
export function releasePersistentBudget(reservedUSD: number): void {
  if (reservedUSD <= 0) return;
  _reservedInFlightUSD = Math.max(0, _reservedInFlightUSD - reservedUSD);
}

/** @internal Current in-flight reservation total (exposed for testing). */
export function getReservedInFlight(): number {
  return _reservedInFlightUSD;
}

/**
 * The per-session cost ceiling ($50 default, configurable). It is the worst-case
 * a run with no tighter per-run costGuard can spend before it records — used by
 * the WorkerLoop as the admission reservation for effects that lack their own
 * dollar cap (e.g. a scheduled workflow, bounded only by this ceiling via the
 * orchestrator's per-step checkSessionBudget).
 */
export function getSessionCostCeiling(): number {
  return _maxSessionCostUSD;
}

/** Reset persistent budget config (for testing). */
export function resetPersistentBudget(): void {
  _costProvider = null;
  _maxSessionCostUSD = DEFAULT_SESSION_COST_USD;
  _reservedInFlightUSD = 0;
  _dailyCapUSD = DEFAULT_DAILY_CAP_USD;
  _monthlyCapUSD = DEFAULT_MONTHLY_CAP_USD;
}
