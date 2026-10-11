import { describe, it, expect } from 'vitest';
import { PromptBudget, PromptBudgetExceededError, DEFAULT_PROMPT_BUDGET, MAX_PROMPT_BUDGET, promptBudgetLimit } from './prompt-budget.js';

describe('PromptBudget', () => {
  it('exposes a sensible default', () => {
    expect(DEFAULT_PROMPT_BUDGET).toBe(5);
  });

  it('allows up to limit consumes', () => {
    const b = new PromptBudget(2);
    b.consume();
    b.consume();
    expect(b.usedCount).toBe(2);
    expect(b.remaining).toBe(0);
  });

  it('throws PromptBudgetExceededError on overflow', () => {
    const b = new PromptBudget(1);
    b.consume();
    expect(() => b.consume()).toThrow(PromptBudgetExceededError);
  });

  it('rejects negative limits', () => {
    expect(() => new PromptBudget(-1)).toThrow('PromptBudget.limit must be >= 0');
  });

  it('zero-limit budget throws on first consume', () => {
    const b = new PromptBudget(0);
    expect(() => b.consume()).toThrow(PromptBudgetExceededError);
  });

  it('refund() releases a slot', () => {
    const b = new PromptBudget(1);
    b.consume();
    b.refund();
    expect(b.usedCount).toBe(0);
    expect(b.remaining).toBe(1);
    // Still usable.
    expect(() => b.consume()).not.toThrow();
  });

  it('refund() floors at 0 (cannot go negative)', () => {
    const b = new PromptBudget(1);
    b.refund();
    expect(b.usedCount).toBe(0);
  });

  it('rejected consume() does not increment the count', () => {
    const b = new PromptBudget(1);
    b.consume();
    try { b.consume(); } catch { /* expected */ }
    expect(b.usedCount).toBe(1); // not 2
  });
});

describe('promptBudgetLimit', () => {
  it('takes the default when nothing is configured, and a value that is not a number', () => {
    expect(promptBudgetLimit(undefined)).toBe(DEFAULT_PROMPT_BUDGET);
    expect(promptBudgetLimit(Number.NaN)).toBe(DEFAULT_PROMPT_BUDGET);
    expect(promptBudgetLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PROMPT_BUDGET);
  });

  it('keeps a configured value up to the cap, and caps one above it', () => {
    expect(promptBudgetLimit(3)).toBe(3);
    expect(promptBudgetLimit(MAX_PROMPT_BUDGET)).toBe(MAX_PROMPT_BUDGET);
    expect(promptBudgetLimit(MAX_PROMPT_BUDGET + 1)).toBe(MAX_PROMPT_BUDGET);
    expect(promptBudgetLimit(500)).toBe(10);
  });
});

describe('PromptBudgetExceededError', () => {
  it('offers to raise the cap below the maximum, and names the maximum', () => {
    expect(new PromptBudgetExceededError(5).message).toContain(`raise the cap (at most ${MAX_PROMPT_BUDGET})`);
  });

  it('offers nothing to raise at the maximum', () => {
    const msg = new PromptBudgetExceededError(MAX_PROMPT_BUDGET).message;
    expect(msg).toContain('capped at 10 interactive prompts');
    expect(msg).not.toContain('pipeline_prompt_budget');
  });
});
