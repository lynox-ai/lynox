import { describe, it, expect } from 'vitest';
import { PromptBudget, PromptBudgetExceededError, DEFAULT_PROMPT_BUDGET } from './prompt-budget.js';

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
});
