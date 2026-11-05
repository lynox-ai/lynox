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
 * once at engine init (one engine serves exactly one tenant)
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
  // A non-finite estimate (NaN from a malformed pricing override) must fail
  // CLOSED: `NaN > cap` is false, so it would otherwise skip the ceiling AND
  // poison the shared counter (`costUSD += NaN`) for the rest of the session.
  if (!Number.isFinite(estimatedCostUSD)) {
    throw new Error('Session cost check received a non-finite estimate — refusing to run (check pricing.json).');
  }
  if (counters.costUSD + estimatedCostUSD > _maxSessionCostUSD) {
    throw new Error(
      `Session cost ceiling ($${String(_maxSessionCostUSD)}) would be exceeded. ` +
      `Current: $${counters.costUSD.toFixed(2)}, estimated: $${estimatedCostUSD.toFixed(2)}.`,
    );
  }
  counters.costUSD += estimatedCostUSD; // reserve immediately
}

/**
 * Record cost spent by an agent (spawn or pipeline step). Only a finite amount above zero
 * is added: `costUSD += NaN` would leave the counter NaN for the rest of the session, and
 * `NaN + estimate > cap` is false, so {@link checkSessionBudget} would never stop again.
 */
export function recordSessionCost(counters: SessionCounters, costUSD: number): void {
  if (!(Number.isFinite(costUSD) && costUSD > 0)) return;
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
/**
 * Whether {@link configurePersistentBudget} ran. The engine calls it once at boot,
 * with or without a cost provider; until then (module load, a test that never
 * configures) nothing is enforced, as before. After it, a missing provider no longer
 * means "nothing to check": see {@link spendUnverifiable}.
 */
let _configured = false;
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
 * engine = one tenant, so a module-level
 * accumulator is process-correct.
 */
let _reservedInFlightUSD = 0;

/**
 * Configure the session cap and the persistent budget caps. Called once at
 * engine init. Without a cost provider (the run history did not open) the session
 * cap still applies, and a daily or monthly cap that is set can no longer be
 * checked: every run is refused with that reason instead of running unchecked.
 */
export function configurePersistentBudget(opts: {
  costProvider: CostQueryProvider | null;
  sessionCapUSD?: number | undefined;
  dailyCapUSD?: number | undefined;
  monthlyCapUSD?: number | undefined;
}): void {
  _costProvider = opts.costProvider;
  _configured = true;
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

/**
 * True when a daily or monthly cap is set but there is no recorded spend to hold it
 * against: the engine was configured without a cost provider, because the run history
 * did not open at boot. Fail-closed: a cap that cannot be checked refuses, it does not
 * read as "nothing spent". Before the engine configured the budget this is false.
 */
function spendUnverifiable(): boolean {
  return _configured
    && (!_costProvider || !_costProvider.getCostByDay)
    && (_dailyCapUSD < Infinity || _monthlyCapUSD < Infinity);
}

/**
 * Whether the daily/monthly caps are set but cannot be checked (see {@link spendUnverifiable}).
 * The boot reads it once to say so in the startup log.
 */
export function isPersistentBudgetUnverifiable(): boolean {
  return spendUnverifiable();
}

/** The caps that are set, as the refusal and the startup log name them: `daily $15, monthly $150`. */
export function describeSetCaps(): string {
  return [
    _dailyCapUSD < Infinity ? `daily $${_dailyCapUSD}` : null,
    _monthlyCapUSD < Infinity ? `monthly $${_monthlyCapUSD}` : null,
  ].filter((c): c is string => c !== null).join(', ');
}

/**
 * The refusal while spend is unknown. Two readers: a self-hoster can read the startup log and
 * repair the file; a managed tenant can do neither, and the operator is alerted instead (the
 * health probe reports the instance degraded). Managed is recognised by the same env as
 * everywhere else in the engine. Read per refusal, not cached at boot.
 */
function unverifiableReason(): string {
  const head = `Spending cap (${describeSetCaps()}) cannot be checked: `;
  const tail = "so today's and this month's spend are unknown. No run starts until lynox opens it again at a restart. ";
  if (process.env['LYNOX_MANAGED_INSTANCE_ID']) {
    return `${head}the history database did not open when lynox started, ${tail}`
      + 'The lynox team gets an automatic alert about it.';
  }
  return `${head}the history database (history.db) did not open when lynox started, ${tail}`
    + 'The log lynox writes at startup names the cause ("RunHistory init failed"); fix it, for example '
    + 'a full disk, missing file permissions or a damaged file, and restart lynox.';
}

/** Check if persistent daily/monthly budget allows another run. */
export function checkPersistentBudget(): PersistentBudgetCheck {
  if (spendUnverifiable()) {
    return {
      allowed: false, todayCostUSD: 0, monthCostUSD: 0,
      dailyLimitUSD: _dailyCapUSD < Infinity ? _dailyCapUSD : null,
      monthlyLimitUSD: _monthlyCapUSD < Infinity ? _monthlyCapUSD : null,
      reason: unverifiableReason(),
    };
  }
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
  // Before the zero-estimate shortcut: with spend unknown there is no headroom to admit into.
  if (spendUnverifiable()) return { allowed: false, reservedUSD: 0, reason: unverifiableReason() };
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

/**
 * How many dollars are still free under the TIGHTER of the two caps, or `null` when
 * nothing is enforced (no cost provider, or both caps disabled).
 *
 * ⛔ WHY THIS EXISTS, and it is the other half of a documented trade-off rather than a
 * new idea. {@link reservePersistentBudget} reserves a run's WORST case on purpose —
 * its own comment says so — and that is right *provided the per-run cap is smaller
 * than the daily cap*. Nothing checked that precondition, and on a deployment where
 * the two are equal it does not hold: the projection then tips at the first cent of
 * recorded spend (`0.01 + cap > cap`), and nothing the background loop schedules is
 * admitted again until the daily window rolls. Where the daily cap is smaller than the
 * worst case, it never fits at all. The arithmetic is the whole proof; the deployment
 * figures that make it bite live with the deployment, not in this file.
 *
 * With this, a caller can reserve `min(worstCase, headroom)` instead — but ONLY if it
 * also lowers the run's own hard cap to the same number, or the run outspends its own
 * reservation. ⚠ And that bound is `grant + one turn`, not `grant`: `CostGuard`
 * records a turn before it compares. A caller that needs an exact bound does not have
 * one here.
 *
 * In-flight reservations are subtracted, so two tasks admitted in the same synchronous
 * tick cannot both be granted the same headroom.
 */
export function persistentBudgetHeadroom(): number | null {
  // Unknown spend leaves nothing that can be shown free; the WorkerLoop defers the task and
  // names the reason it reads from `checkPersistentBudget`.
  if (spendUnverifiable()) return 0;
  const spend = computeRecordedSpend();
  if (!spend) return null;
  const remaining: number[] = [];
  if (_dailyCapUSD < Infinity) remaining.push(_dailyCapUSD - spend.todayCost - _reservedInFlightUSD);
  if (_monthlyCapUSD < Infinity) remaining.push(_monthlyCapUSD - spend.monthCost - _reservedInFlightUSD);
  if (remaining.length === 0) return null;
  // Never negative: spend can exceed a cap that was lowered mid-month, and a negative
  // headroom would read as "owes money" to every caller that compares it.
  return Math.max(0, Math.min(...remaining));
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
  _configured = false;
  _maxSessionCostUSD = DEFAULT_SESSION_COST_USD;
  _reservedInFlightUSD = 0;
  _dailyCapUSD = DEFAULT_DAILY_CAP_USD;
  _monthlyCapUSD = DEFAULT_MONTHLY_CAP_USD;
}
