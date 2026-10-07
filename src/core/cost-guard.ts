import type { CostGuardConfig, CostSnapshot } from '../types/index.js';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { getPricing } from './pricing.js';

export class CostGuard {
  private readonly maxBudgetUSD: number;
  private readonly warnAtUSD: number;
  private readonly maxIterations: number;
  private readonly pricePerM: { input: number; output: number; cacheWrite: number; cacheRead: number };
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheWriteTokens = 0;
  private cacheReadTokens = 0;
  /** Helper-call spend already priced on ITS model — see recordExternalCost. */
  private externalCostUSD = 0;
  /**
   * Dollars HELD for work that was admitted but has not reported its cost yet — a
   * spawned fan-out between dispatch and settle.
   *
   * ⛔ A separate accumulator from `externalCostUSD`, not a shortcut through it: a hold
   * has to be GIVEN BACK once the actual figure arrives, and booking it as spend would
   * mean subtracting spend later — which `recordExternalCost` deliberately refuses
   * (it ignores negatives, so a malformed figure cannot mint budget). Two accumulators
   * keep "already spent" and "promised" separable, and only the first outlives the run.
   */
  private reservedUSD = 0;
  private iterations = 0;
  private warned = false;

  constructor(config: CostGuardConfig, model: string) {
    this.maxBudgetUSD = config.maxBudgetUSD ?? Infinity;
    this.warnAtUSD = config.warnAtUSD ?? this.maxBudgetUSD * 0.8;
    this.maxIterations = config.maxIterations ?? 200;
    this.pricePerM = getPricing(model);
  }

  /** Record a turn's usage. Returns true if budget is exceeded. */
  recordTurn(usage: BetaUsage): boolean {
    this.inputTokens += usage.input_tokens;
    this.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.outputTokens += usage.output_tokens;
    this.iterations++;
    return this.isExceeded();
  }

  shouldWarn(): boolean {
    if (this.warned) return false;
    const cost = this.estimateCost();
    if (cost >= this.warnAtUSD) {
      this.warned = true;
      return true;
    }
    return false;
  }

  isExceeded(): boolean {
    const cost = this.estimateCost();
    // Fail closed on a non-finite cost (NaN from a malformed pricing override):
    // `NaN >= cap` is false and would silently disable the dollar ceiling. An
    // explicitly-disabled budget (Infinity) stays the user's opt-out.
    const costExceeded = Number.isFinite(cost)
      ? cost >= this.maxBudgetUSD
      : this.maxBudgetUSD !== Infinity;
    return costExceeded || this.iterations >= this.maxIterations;
  }

  /** True once the iteration cap is consumed. Lets the caller tell "out of turns"
   *  from "out of money" when `recordTurn` reports exceeded — the two need
   *  different words on the way out (a turn cap is raised with `max_turns`, a
   *  budget with `max_budget_usd`), and a stop that names the wrong one sends
   *  the caller to the wrong knob. */
  iterationCapReached(): boolean {
    return this.iterations >= this.maxIterations;
  }

  snapshot(): CostSnapshot {
    const cost = this.estimateCost();
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedCostUSD: cost,
      iterationsUsed: this.iterations,
      budgetPercent: this.maxBudgetUSD === Infinity ? 0 : Math.round((cost / this.maxBudgetUSD) * 100),
    };
  }

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheWriteTokens = 0;
    this.cacheReadTokens = 0;
    this.externalCostUSD = 0;
    // A hold belongs to work that is in flight; a reset means there is none.
    this.reservedUSD = 0;
    this.iterations = 0;
    this.warned = false;
  }

  /**
   * Dollars still free under this run's ceiling, or `null` when it has none.
   *
   * ⛔ THREE STATES, TWO VALUES, and that is the decision this function exists to make.
   * `null` means "no ceiling". An UNKNOWN remainder returns **0** — nothing free — so a
   * caller asking "does this fit?" is refused rather than waved through. A previous
   * attempt at this function returned `Math.max(0, ceiling - spent)` without that
   * guard: `Math.max(0, NaN)` is `NaN`, every comparison against `NaN` is false, and
   * the caller was told yes. The non-finite input is reachable — `recordTurn` sums
   * `usage.*` unguarded and a pricing override can poison the estimate, which is the
   * same input `isExceeded` already fails closed for.
   *
   * Holds are subtracted, so two callers in the same instant cannot both be granted the
   * same room.
   */
  remainingBudgetUSD(): number | null {
    if (this.maxBudgetUSD === Infinity) return null;
    // ⛔ BOTH inputs, not one. The first version of this guard checked the spend and not
    // the ceiling — so a non-finite-but-not-`Infinity` ceiling produced `NaN`, every
    // comparison against it was false, and a fan-out was admitted unbounded. The
    // docblock above claimed coverage this line did not have. Not reachable today (every
    // caller clamps or validates), which is exactly why it has to fail closed: the
    // reachability is a property of the callers, and callers change.
    if (!Number.isFinite(this.maxBudgetUSD)) return 0;
    const spent = this.estimateCost();
    if (!Number.isFinite(spent)) return 0;
    return Math.max(0, this.maxBudgetUSD - spent - this.reservedUSD);
  }

  /**
   * Hold `usd` against the ceiling for work about to start, and say whether it fit.
   *
   * ⛔ RESERVING, not reading, and the difference is the whole reason this exists. A
   * caller that merely READ the remainder could be one of several running in the same
   * instant — the agent dispatches up to ten tool calls in parallel — and each would
   * see the same room and claim it. Its neighbour `checkSessionBudget` has always
   * reserved on the spot for exactly this reason; the budget half of a fan-out did not,
   * and two concurrent batches each claimed the full remainder.
   *
   * Returns `false` holding NOTHING when it does not fit, so a refused caller has
   * nothing to give back. A non-positive or non-finite amount is a no-op that fits —
   * there is nothing to hold, and refusing it would turn a rounding artefact into an
   * error.
   */
  reserveExternalCost(usd: number): boolean {
    if (!Number.isFinite(usd) || usd <= 0) return true;
    const remaining = this.remainingBudgetUSD();
    if (remaining !== null && usd > remaining) return false;
    this.reservedUSD += usd;
    return true;
  }

  /**
   * Give back a hold taken by {@link reserveExternalCost} — once the work reported its
   * ACTUAL cost (booked separately via {@link recordExternalCost}), or when it never ran.
   *
   * Floored at 0, so a double release cannot mint budget. Same floor the worker's own
   * reservation accumulator keeps, and for the same reason: the release paths outnumber
   * the reserve path, so one of them running twice is a question of when, not if.
   */
  releaseExternalCost(usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.reservedUSD = Math.max(0, this.reservedUSD - usd);
  }

  /**
   * Charge an already-priced amount against this run's ceiling.
   *
   * For a helper call the run makes on a DIFFERENT model than its own — the
   * follow-up-chip recovery runs on the `fast` tier. `recordTurn` cannot serve:
   * it books raw tokens against `pricePerM`, which is this guard's single model,
   * so an Opus run charging Haiku tokens at Opus rates trips its own ceiling
   * roughly twenty times too early (and inflates the iteration count with a turn
   * the model never took).
   *
   * Fails OPEN on a malformed amount — deliberately, and opposite to
   * `isExceeded`. Storing a NaN makes `estimateCost` non-finite, which
   * `isExceeded` reads as "over budget" and would end EVERY later turn of the
   * run. Dropping one unpriceable helper call understates the ceiling by cents;
   * the alternative kills the run.
   */
  recordExternalCost(usd: number): boolean {
    if (Number.isFinite(usd) && usd > 0) this.externalCostUSD += usd;
    return this.isExceeded();
  }

  private estimateCost(): number {
    return (this.inputTokens / 1_000_000) * this.pricePerM.input
         + (this.outputTokens / 1_000_000) * this.pricePerM.output
         + (this.cacheWriteTokens / 1_000_000) * this.pricePerM.cacheWrite
         + (this.cacheReadTokens / 1_000_000) * this.pricePerM.cacheRead
         + this.externalCostUSD;
  }
}
