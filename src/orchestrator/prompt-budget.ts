/**
 * Per-pipeline-run prompt budget.
 *
 * Counter shared across every sub-agent in a single pipeline run. The
 * spawner wraps the parent's prompt callbacks with a checker that
 * decrements this budget; once exhausted, further ask_user / ask_secret
 * calls reject with a clear error.
 *
 * Why: a compromised tool output (e.g. attacker-controlled web_search
 * markdown) could persuade a sub-agent to spam the user with prompts —
 * a low-effort phishing surface. The cap puts a hard ceiling on that.
 */

export const DEFAULT_PROMPT_BUDGET = 5;

/**
 * The most prompts one run may raise, whatever `pipeline_prompt_budget` says. A scheduled
 * workflow run that asks its owner holds its wall clock and its schedule slot for up to 24 h
 * per question, so the budget is also what bounds how long such a run can stand.
 */
export const MAX_PROMPT_BUDGET = 10;

/** The budget a run gets: the configured one, capped at {@link MAX_PROMPT_BUDGET}. A value
 *  that is not a finite number gets the default — `NaN` would otherwise compare as no cap. */
export function promptBudgetLimit(configured: number | undefined): number {
  if (configured === undefined || !Number.isFinite(configured)) return DEFAULT_PROMPT_BUDGET;
  return Math.min(configured, MAX_PROMPT_BUDGET);
}

export class PromptBudgetExceededError extends Error {
  constructor(public readonly limit: number) {
    super(
      `Pipeline prompt budget exceeded: this run is capped at ${limit} interactive prompts. ` +
      `Refuse further ask_user / ask_secret calls. ` +
      `Configure 'pipeline_prompt_budget' to raise the cap (at most ${MAX_PROMPT_BUDGET}) if a higher count is genuinely needed.`,
    );
    this.name = 'PromptBudgetExceededError';
  }
}

export class PromptBudget {
  private used = 0;

  constructor(public readonly limit: number) {
    if (limit < 0) throw new Error(`PromptBudget.limit must be >= 0, got ${limit}`);
  }

  /** Consume one prompt, throwing PromptBudgetExceededError if the cap is hit. */
  consume(): void {
    if (this.used >= this.limit) {
      throw new PromptBudgetExceededError(this.limit);
    }
    this.used += 1;
  }

  /**
   * Release a previously-consumed slot. Used when the parent prompt
   * rejects/aborts before the user actually saw it — a flaky network must
   * not drain the cap.
   */
  refund(): void {
    if (this.used > 0) this.used -= 1;
  }

  get usedCount(): number { return this.used; }
  get remaining(): number { return Math.max(0, this.limit - this.used); }
}
