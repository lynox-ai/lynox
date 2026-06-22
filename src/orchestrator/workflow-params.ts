import type { ProcessParameter } from '../types/pipeline.js';

export type ParamBindResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate + coerce caller-supplied parameter values against a saved workflow's
 * parameter schema, producing the `params` namespace for the run context
 * (`{{params.<name>}}` resolves against this). Used by every parametrised
 * run path (HTTP `/run`, the saved-workflow library, the scheduler).
 *
 * - A declared param with a supplied value is coerced to its declared type.
 * - A declared param with no supplied value falls back to `defaultValue`
 *   (a `null` default counts as NO default — Haiku emits `"defaultValue": null`).
 * - A declared param with neither a value nor a usable default:
 *     - `requireAll: true`  (default — a caller is actively re-targeting, e.g.
 *       the HTTP `/run` body or the run UI): REQUIRED → error.
 *     - `requireAll: false` (an autonomous run that supplies no values — cron /
 *       the `run_workflow` tool): the param is simply left UNBOUND, so its
 *       `{{params.<name>}}` placeholder stays unresolved instead of erroring.
 *       This preserves the pre-replay cron behaviour (no regression) until
 *       scheduled re-targeting / relative-date resolution lands.
 * - Undeclared supplied keys are ignored — only the schema binds, so a caller
 *   can never inject an unexpected key into the run context.
 */
export function bindWorkflowParameters(
  schema: ProcessParameter[],
  supplied: Record<string, unknown> | undefined,
  opts?: { requireAll?: boolean },
): ParamBindResult {
  const requireAll = opts?.requireAll ?? true;
  const out: Record<string, unknown> = {};
  const given = supplied ?? {};
  for (const param of schema) {
    const has = Object.prototype.hasOwnProperty.call(given, param.name);
    const raw = has ? given[param.name] : undefined;
    if (raw === undefined || raw === null) {
      if (param.defaultValue !== undefined && param.defaultValue !== null) {
        out[param.name] = param.defaultValue;
        continue;
      }
      if (!requireAll) continue; // leave unbound → placeholder stays unresolved
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
