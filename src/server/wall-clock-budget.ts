/**
 * Pausable execution-budget clock for a single run's 30-min wall-clock.
 *
 * A run's wall-clock must count ONLY the time the agent is actively
 * computing — NOT the time it sits parked awaiting a human answer to an
 * `ask_user` / `ask_secret` / `connect_mail` / tabs prompt. Counting human
 * think-time against the budget means a user who answers after the budget
 * elapsed lands on an already-aborted run: their reply is captured (POST
 * /reply 200) but nobody is awaiting it (issue #77). ask_user is exempt from
 * the per-tool 15-min cap, so during a human wait ONLY this wall-clock can
 * fire — which is exactly why it must be paused for the wait.
 *
 * This class owns ONLY the budget arithmetic — no timers, no I/O — so the
 * pause/resume invariant is unit-testable in isolation. The HTTP handler wraps
 * it with the actual `setTimeout`:
 *   - `arm(now)`   → returns the delay (ms) to schedule the abort timer with
 *   - `pause(now)` → banks the compute-time consumed since the last arm, disarms
 *   - `arm(now)`   → re-arm on prompt-settle with the REMAINING budget
 *
 * Invariant: after any interleaving of compute intervals and paused (human)
 * intervals, the budget consumed equals the SUM of the compute intervals only.
 * Human think-time never advances the clock.
 */
export class WallClockBudget {
  /** Compute budget still available, in ms. May go negative if a compute interval overran. */
  private remainingMs: number;
  /** Timestamp the current compute interval started; `undefined` while paused. */
  private armedAt: number | undefined = undefined;

  constructor(
    totalMs: number,
    /**
     * Floor for a re-arm delay. If compute already exhausted the budget while a
     * prompt was pending, the resumed run still gets this minimal slice rather
     * than a zero/negative delay that would fire synchronously mid-settle.
     */
    private readonly minRearmMs = 1_000,
  ) {
    this.remainingMs = totalMs;
  }

  /**
   * Arm (or re-arm) a compute interval starting at `now`. Returns the delay to
   * schedule the abort timer with — the remaining budget, floored at
   * `minRearmMs`. The caller tracks the actual timer handle and must not arm
   * while a timer is already live; calling `arm` simply (re)sets the interval
   * start to `now`.
   */
  arm(now: number): number {
    this.armedAt = now;
    return Math.max(this.remainingMs, this.minRearmMs);
  }

  /**
   * Pause the clock at `now`: subtract the compute-time consumed since the last
   * arm from the remaining budget, then disarm. Idempotent — a second pause
   * with no active interval is a no-op, so a double-bracket (e.g. a defensive
   * re-entrant pause) can never double-subtract the budget.
   */
  pause(now: number): void {
    if (this.armedAt === undefined) return;
    this.remainingMs -= now - this.armedAt;
    this.armedAt = undefined;
  }

  /** True while paused (no active compute interval is being timed). */
  get paused(): boolean {
    return this.armedAt === undefined;
  }

  /** Remaining compute budget in ms (may be negative after an overrun). */
  get remaining(): number {
    return this.remainingMs;
  }
}
