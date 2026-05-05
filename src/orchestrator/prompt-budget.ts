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

export class PromptBudgetExceededError extends Error {
  constructor(public readonly limit: number) {
    super(
      `Pipeline prompt budget exceeded: this run is capped at ${limit} interactive prompts. ` +
      `Refuse further ask_user / ask_secret calls. ` +
      `Configure 'pipeline_prompt_budget' to raise the cap if a higher count is genuinely needed.`,
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
