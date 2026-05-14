import type { ManifestCondition, AgentOutput } from '../types/orchestration.js';

/**
 * Resolve a dot-notation path into an object.
 * Returns `undefined` if any segment is missing.
 */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Evaluate a single condition against a step context.
 */
export function evaluateCondition(ctx: Record<string, unknown>, cond: ManifestCondition): boolean {
  const actual = getByPath(ctx, cond.path);

  switch (cond.operator) {
    case 'exists':
      return actual !== undefined;
    case 'not_exists':
      return actual === undefined;
    case 'eq':
      return actual === cond.value;
    case 'neq':
      return actual !== cond.value;
    case 'contains':
      return actual !== null && actual !== undefined && String(actual).includes(String(cond.value));
    case 'lt': {
      const n = Number(actual);
      const v = Number(cond.value);
      return !isNaN(n) && !isNaN(v) && n < v;
    }
    case 'gt': {
      const n = Number(actual);
      const v = Number(cond.value);
      return !isNaN(n) && !isNaN(v) && n > v;
    }
    case 'gte': {
      const n = Number(actual);
      const v = Number(cond.value);
      return !isNaN(n) && !isNaN(v) && n >= v;
    }
    case 'lte': {
      const n = Number(actual);
      const v = Number(cond.value);
      return !isNaN(n) && !isNaN(v) && n <= v;
    }
  }
}

/**
 * AND semantics — all conditions must pass.
 * Returns `true` if conditions is undefined or empty.
 */
export function shouldRunStep(ctx: Record<string, unknown>, conditions: ManifestCondition[] | undefined): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(cond => evaluateCondition(ctx, cond));
}

/**
 * Build condition context by merging ALL completed outputs (not just input_from).
 * Used for evaluating conditions that reference any upstream step result.
 */
export function buildConditionContext(
  globalContext: Record<string, unknown>,
  outputs: Map<string, AgentOutput>,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...globalContext };
  for (const [id, out] of outputs) {
    if (!out.skipped) {
      ctx[id] = { result: out.result, costUsd: out.costUsd, error: out.error };
    }
  }
  return ctx;
}
