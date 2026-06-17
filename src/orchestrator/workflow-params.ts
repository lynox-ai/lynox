import type { ProcessParameter } from '../types/pipeline.js';

export type ParamBindResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate + coerce caller-supplied parameter values against a saved workflow's
 * parameter schema, producing the `params` namespace for the run context
 * (`{{params.<name>}}` resolves against this). Used by every parametrised
 * run path (HTTP `/run`, the agent `run_workflow` tool, the scheduler).
 *
 * - A declared param with a supplied value is coerced to its declared type.
 * - A declared param with no supplied value falls back to `defaultValue`.
 * - A declared param with neither a value nor a default is REQUIRED → error.
 * - Undeclared supplied keys are ignored — only the schema binds, so a caller
 *   can never inject an unexpected key into the run context.
 */
export function bindWorkflowParameters(
  schema: ProcessParameter[],
  supplied: Record<string, unknown> | undefined,
): ParamBindResult {
  const out: Record<string, unknown> = {};
  const given = supplied ?? {};
  for (const param of schema) {
    const has = Object.prototype.hasOwnProperty.call(given, param.name);
    const raw = has ? given[param.name] : undefined;
    if (raw === undefined || raw === null) {
      if (param.defaultValue !== undefined) {
        out[param.name] = param.defaultValue;
        continue;
      }
      return { ok: false, error: `Missing required parameter "${param.name}".` };
    }
    const coerced = coerceParam(raw, param);
    if (!coerced.ok) return coerced;
    out[param.name] = coerced.value;
  }
  return { ok: true, params: out };
}

function coerceParam(
  raw: unknown,
  param: ProcessParameter,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (param.type) {
    case 'number': {
      if (typeof raw === 'number') {
        return Number.isFinite(raw)
          ? { ok: true, value: raw }
          : { ok: false, error: `Parameter "${param.name}" must be a number.` };
      }
      const s = typeof raw === 'string' ? raw.trim() : '';
      // Strict decimal/float (optional sign + exponent). Rejects what Number()
      // would silently coerce: "" → 0, "  " → 0, "0x1f" → 31, "0b101" → 5.
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
        return { ok: false, error: `Parameter "${param.name}" must be a number.` };
      }
      return { ok: true, value: Number(s) };
    }
    case 'date': {
      const s = typeof raw === 'string' ? raw.trim() : '';
      // Require an ISO-8601 date (YYYY-MM-DD, optionally with a time part) AND a
      // real calendar date — Date.parse alone accepts "2026", "0", "garbage 2026".
      if (!/^\d{4}-\d{2}-\d{2}([T ]\S*)?$/.test(s) || Number.isNaN(Date.parse(s))) {
        return { ok: false, error: `Parameter "${param.name}" must be an ISO date (YYYY-MM-DD).` };
      }
      return { ok: true, value: s };
    }
    case 'string':
    default:
      return { ok: true, value: typeof raw === 'string' ? raw : String(raw) };
  }
}
