import { describe, it, expect } from 'vitest';
import { getByPath, evaluateCondition, shouldRunStep, buildConditionContext } from './conditions.js';
import type { ManifestCondition, AgentOutput } from '../types/orchestration.js';

function makeOutput(stepId: string, result: string, opts: Partial<AgentOutput> = {}): AgentOutput {
  const now = new Date().toISOString();
  return {
    stepId, result, startedAt: now, completedAt: now,
    durationMs: 1, tokensIn: 5, tokensOut: 10, costUsd: 0.001, skipped: false,
    ...opts,
  };
}

describe('getByPath', () => {
  it('returns top-level value', () => {
    expect(getByPath({ a: 1 }, 'a')).toBe(1);
  });

  it('returns nested value', () => {
    expect(getByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing key', () => {
    expect(getByPath({ a: 1 }, 'b')).toBeUndefined();
  });

  it('returns undefined when intermediate is missing', () => {
    expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined when intermediate is null', () => {
    expect(getByPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('handles array values (not traversed by index)', () => {
    expect(getByPath({ a: [1, 2] }, 'a')).toEqual([1, 2]);
  });
});

describe('evaluateCondition', () => {
  const ctx: Record<string, unknown> = { score: 80, name: 'test', value: 0 };

  describe('exists / not_exists', () => {
    it('exists returns true when key present', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'exists' })).toBe(true);
    });
    it('exists returns false when key absent', () => {
      expect(evaluateCondition(ctx, { path: 'missing', operator: 'exists' })).toBe(false);
    });
    it('not_exists returns true when key absent', () => {
      expect(evaluateCondition(ctx, { path: 'missing', operator: 'not_exists' })).toBe(true);
    });
    it('not_exists returns false when key present', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'not_exists' })).toBe(false);
    });
  });

  describe('eq', () => {
    it('returns true for strict equality', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'eq', value: 80 })).toBe(true);
    });
    it('returns false for different value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'eq', value: 90 })).toBe(false);
    });
    it('does not coerce types — string vs number', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'eq', value: '80' })).toBe(false);
    });
  });

  describe('lt', () => {
    it('returns true when actual < value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'lt', value: 100 })).toBe(true);
    });
    it('returns false when actual >= value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'lt', value: 80 })).toBe(false);
    });
    it('returns false for NaN', () => {
      expect(evaluateCondition(ctx, { path: 'name', operator: 'lt', value: 100 })).toBe(false);
    });
  });

  describe('gt', () => {
    it('returns true when actual > value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'gt', value: 50 })).toBe(true);
    });
    it('returns false when actual <= value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'gt', value: 80 })).toBe(false);
    });
  });

  describe('gte', () => {
    it('returns true when actual >= value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'gte', value: 80 })).toBe(true);
      expect(evaluateCondition(ctx, { path: 'score', operator: 'gte', value: 79 })).toBe(true);
    });
    it('returns false when actual < value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'gte', value: 81 })).toBe(false);
    });
  });

  describe('lte', () => {
    it('returns true when actual <= value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'lte', value: 80 })).toBe(true);
      expect(evaluateCondition(ctx, { path: 'score', operator: 'lte', value: 81 })).toBe(true);
    });
    it('returns false when actual > value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'lte', value: 79 })).toBe(false);
    });
  });

  describe('neq', () => {
    it('returns true when actual !== value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'neq', value: 90 })).toBe(true);
    });
    it('returns false when actual === value', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'neq', value: 80 })).toBe(false);
    });
    it('does not coerce types — string vs number are not equal', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'neq', value: '80' })).toBe(true);
    });
    it('returns true when path is missing (undefined !== value)', () => {
      expect(evaluateCondition(ctx, { path: 'missing', operator: 'neq', value: 'anything' })).toBe(true);
    });
  });

  describe('contains', () => {
    it('returns true when actual string contains value', () => {
      expect(evaluateCondition(ctx, { path: 'name', operator: 'contains', value: 'es' })).toBe(true);
    });
    it('returns false when actual string does not contain value', () => {
      expect(evaluateCondition(ctx, { path: 'name', operator: 'contains', value: 'xyz' })).toBe(false);
    });
    it('coerces number to string for check', () => {
      expect(evaluateCondition(ctx, { path: 'score', operator: 'contains', value: '8' })).toBe(true);
    });
    it('returns false when actual is null', () => {
      const ctxWithNull = { val: null };
      expect(evaluateCondition(ctxWithNull, { path: 'val', operator: 'contains', value: 'x' })).toBe(false);
    });
    it('returns false when actual is undefined (missing path)', () => {
      expect(evaluateCondition(ctx, { path: 'missing', operator: 'contains', value: 'x' })).toBe(false);
    });
    it('returns true for exact match', () => {
      expect(evaluateCondition(ctx, { path: 'name', operator: 'contains', value: 'test' })).toBe(true);
    });
    it('returns true for empty string value (always contained)', () => {
      expect(evaluateCondition(ctx, { path: 'name', operator: 'contains', value: '' })).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('value 0 is truthy for exists', () => {
      expect(evaluateCondition(ctx, { path: 'value', operator: 'exists' })).toBe(true);
    });
    it('value 0 works with eq', () => {
      expect(evaluateCondition(ctx, { path: 'value', operator: 'eq', value: 0 })).toBe(true);
    });
  });
});

describe('shouldRunStep', () => {
  const ctx = { score: 80, env: 'production' };

  it('returns true when conditions is undefined', () => {
    expect(shouldRunStep(ctx, undefined)).toBe(true);
  });

  it('returns true when conditions is empty array', () => {
    expect(shouldRunStep(ctx, [])).toBe(true);
  });

  it('returns true when all conditions pass', () => {
    const conds: ManifestCondition[] = [
      { path: 'score', operator: 'gt', value: 50 },
      { path: 'env', operator: 'eq', value: 'production' },
    ];
    expect(shouldRunStep(ctx, conds)).toBe(true);
  });

  it('returns false when any condition fails (AND semantics)', () => {
    const conds: ManifestCondition[] = [
      { path: 'score', operator: 'gt', value: 50 },
      { path: 'env', operator: 'eq', value: 'staging' },
    ];
    expect(shouldRunStep(ctx, conds)).toBe(false);
  });

  it('returns false when first condition fails', () => {
    const conds: ManifestCondition[] = [
      { path: 'score', operator: 'gt', value: 100 },
    ];
    expect(shouldRunStep(ctx, conds)).toBe(false);
  });
});

describe('buildConditionContext', () => {
  it('returns globalContext when outputs is empty', () => {
    const global = { foo: 'bar', x: 1 };
    const result = buildConditionContext(global, new Map());
    expect(result).toEqual({ foo: 'bar', x: 1 });
  });

  it('does not mutate globalContext', () => {
    const global = { foo: 'bar' };
    const outputs = new Map([['step-a', makeOutput('step-a', 'hello')]]);
    buildConditionContext(global, outputs);
    expect(global).toEqual({ foo: 'bar' });
  });

  it('merges all completed outputs into context', () => {
    const outputs = new Map([
      ['step-a', makeOutput('step-a', 'result-a')],
      ['step-b', makeOutput('step-b', 'result-b')],
    ]);
    const ctx = buildConditionContext({}, outputs);
    expect(ctx['step-a']).toEqual({ result: 'result-a', costUsd: 0.001, error: undefined });
    expect(ctx['step-b']).toEqual({ result: 'result-b', costUsd: 0.001, error: undefined });
  });

  it('skips outputs where skipped is true', () => {
    const outputs = new Map([
      ['step-a', makeOutput('step-a', 'result-a')],
      ['step-b', makeOutput('step-b', '', { skipped: true })],
    ]);
    const ctx = buildConditionContext({}, outputs);
    expect(ctx['step-a']).toEqual({ result: 'result-a', costUsd: 0.001, error: undefined });
    expect(ctx['step-b']).toBeUndefined();
  });

  it('includes error field when output has an error', () => {
    const outputs = new Map([
      ['step-a', makeOutput('step-a', '', { error: 'something went wrong' })],
    ]);
    const ctx = buildConditionContext({}, outputs);
    expect(ctx['step-a']).toEqual({ result: '', costUsd: 0.001, error: 'something went wrong' });
  });

  it('globalContext values are overwritten by step outputs with same key', () => {
    const global = { 'step-a': 'original' };
    const outputs = new Map([['step-a', makeOutput('step-a', 'new')]]);
    const ctx = buildConditionContext(global, outputs);
    expect(ctx['step-a']).toEqual({ result: 'new', costUsd: 0.001, error: undefined });
  });

  it('merges outputs without requiring input_from references', () => {
    // This is the key difference from buildStepContext — ALL outputs are merged
    const outputs = new Map([
      ['step-a', makeOutput('step-a', 'ra')],
      ['step-b', makeOutput('step-b', 'rb')],
      ['step-c', makeOutput('step-c', 'rc')],
    ]);
    const ctx = buildConditionContext({ global: true }, outputs);
    expect(ctx['step-a']).toBeDefined();
    expect(ctx['step-b']).toBeDefined();
    expect(ctx['step-c']).toBeDefined();
    expect(ctx['global']).toBe(true);
  });
});
