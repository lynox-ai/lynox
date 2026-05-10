// === Inbox classifier — daily cost budget ===
//
// PRD §Threat Model "DoS / Cost-Bound" caps daily classifier spend per
// instance. This is *separate* from `core/cost-guard.ts` which scopes a
// single Session's tool/agent loop. Inbox classifications run as background
// jobs spread across the day; per-Session caps don't bound them.
//
// Behaviour:
//   - tracks input/output token counts and converts to USD via Haiku pricing
//   - resets at UTC midnight (deterministic across instances and timezones)
//   - circuit-breaker: once exceeded, the runner short-circuits to a
//     fail-closed `requires_user` verdict without an LLM call
//   - exposes a snapshot for telemetry / UI status tile

/** Default Haiku pricing per million tokens (USD), 2026-05 reference. */
export const DEFAULT_INPUT_COST_PER_MTOK = 1.0;
export const DEFAULT_OUTPUT_COST_PER_MTOK = 5.0;

/** Default daily classifier spend cap. */
export const DEFAULT_DAILY_BUDGET_USD = 5.0;

export interface InboxCostBudgetOptions {
  /** Hard daily cap. Pass `Infinity` to disable circuit-breaking entirely. */
  maxBudgetUSD?: number | undefined;
  inputCostPerMtok?: number | undefined;
  outputCostPerMtok?: number | undefined;
  /** Test seam — defaults to wall-clock UTC now. */
  clock?: (() => Date) | undefined;
}

export interface CostSnapshot {
  /** YYYY-MM-DD bucket the spend belongs to. */
  day: string;
  spentUSD: number;
  budgetUSD: number;
  /** Integer 0..100. Zero when budget is Infinity. */
  percent: number;
  exceeded: boolean;
}

/**
 * Single-tenant daily classifier budget tracker. Thread-safe enough for
 * the queue's max-concurrency=2 — last-write-wins on race is acceptable
 * for telemetry-grade accuracy.
 */
export class InboxCostBudget {
  private spentUSD = 0;
  private currentDay: string;
  private readonly maxBudgetUSD: number;
  private readonly inputCostPerMtok: number;
  private readonly outputCostPerMtok: number;
  private readonly clock: () => Date;

  constructor(options: InboxCostBudgetOptions = {}) {
    this.maxBudgetUSD = options.maxBudgetUSD ?? DEFAULT_DAILY_BUDGET_USD;
    this.inputCostPerMtok = options.inputCostPerMtok ?? DEFAULT_INPUT_COST_PER_MTOK;
    this.outputCostPerMtok = options.outputCostPerMtok ?? DEFAULT_OUTPUT_COST_PER_MTOK;
    this.clock = options.clock ?? (() => new Date());
    this.currentDay = this._dayKey(this.clock());
  }

  /** Add usage from one classify call. Caller passes whatever the SDK reported. */
  recordUsage(inputTokens: number, outputTokens: number): void {
    this._maybeRoll();
    const cost =
      (inputTokens / 1_000_000) * this.inputCostPerMtok
      + (outputTokens / 1_000_000) * this.outputCostPerMtok;
    this.spentUSD += cost;
  }

  /** True when today's spend has hit the cap. Triggers the circuit-breaker. */
  isExceeded(): boolean {
    this._maybeRoll();
    return this.spentUSD >= this.maxBudgetUSD;
  }

  snapshot(): CostSnapshot {
    this._maybeRoll();
    const exceeded = this.spentUSD >= this.maxBudgetUSD;
    const percent = Number.isFinite(this.maxBudgetUSD) && this.maxBudgetUSD > 0
      ? Math.min(100, Math.round((this.spentUSD / this.maxBudgetUSD) * 100))
      : 0;
    return {
      day: this.currentDay,
      spentUSD: Number(this.spentUSD.toFixed(6)),
      budgetUSD: this.maxBudgetUSD,
      percent,
      exceeded,
    };
  }

  /** Force-reset — used by tests. Production rolls at UTC midnight automatically. */
  reset(): void {
    this.spentUSD = 0;
    this.currentDay = this._dayKey(this.clock());
  }

  private _maybeRoll(): void {
    const day = this._dayKey(this.clock());
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.spentUSD = 0;
    }
  }

  /** UTC YYYY-MM-DD so multi-instance deployments roll consistently. */
  private _dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
