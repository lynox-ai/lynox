import type { ProcessParameter } from '../types/pipeline.js';
import type { ParamConstraint } from '../types/capability-contract.js';

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
  opts?: { requireAll?: boolean; constraints?: Record<string, ParamConstraint> | undefined },
): ParamBindResult {
  const requireAll = opts?.requireAll ?? true;
  const out: Record<string, unknown> = {};
  const given = supplied ?? {};
  for (const param of schema) {
    const has = Object.prototype.hasOwnProperty.call(given, param.name);
    const raw = has ? given[param.name] : undefined;
    if (raw === undefined || raw === null) {
      if (param.defaultValue !== undefined && param.defaultValue !== null) {
        // A defaulted value still flows into the literal call, so it is
        // constrained too (a stored default can't dodge the contract).
        const checkedDefault = opts?.constraints?.[param.name]
          ? applyConstraint(param.defaultValue, opts.constraints[param.name]!, param.name)
          : { ok: true as const };
        if (!checkedDefault.ok) return checkedDefault;
        out[param.name] = param.defaultValue;
        continue;
      }
      if (!requireAll) continue; // leave unbound → placeholder stays unresolved
      return { ok: false, error: `Missing required parameter "${param.name}".` };
    }
    const coerced = coerceParam(raw, param);
    if (!coerced.ok) return coerced;
    // Capability-contract constraint (Slice B / S1): a contract-governed run
    // passes the contract's per-param constraints; a supplied value that flows
    // into a literal tool call must satisfy enum/regex/min-max BEFORE it is
    // substituted raw, so a re-target param can't pick which data is exfiltrated.
    const constraint = opts?.constraints?.[param.name];
    if (constraint) {
      const checked = applyConstraint(coerced.value, constraint, param.name);
      if (!checked.ok) return checked;
    }
    out[param.name] = coerced.value;
  }
  return { ok: true, params: out };
}

/**
 * Enforce a per-parameter capability constraint on an already-coerced value.
 * All declared facets are AND-combined. Bounds the regex input length to keep an
 * author-supplied pattern from running away on a long value (self-DoS guard).
 */
export function applyConstraint(
  value: unknown,
  c: ParamConstraint,
  name: string,
): { ok: true } | { ok: false; error: string } {
  // An explicit `enum` is a closed allow-list — an EMPTY enum admits nothing
  // (deny-all), never everything. (A vacuous constraint is also rejected at
  // save by `validateContractAgainstSteps`; this is the defence-in-depth half.)
  if (c.enum !== undefined) {
    if (!c.enum.some(e => e === value)) {
      return { ok: false, error: `Parameter "${name}" must be one of: ${c.enum.join(', ') || '(none)'}.` };
    }
  }
  if (c.regex !== undefined) {
    let re: RegExp;
    try {
      // Anchor to a FULL match (the type contract: the value must fully satisfy
      // the pattern) so an un-anchored author pattern can't match a substring
      // and let a re-target value smuggle an unconstrained prefix/suffix.
      re = new RegExp(`^(?:${c.regex})$`);
    } catch {
      return { ok: false, error: `Parameter "${name}" has an invalid constraint pattern.` };
    }
    const s = String(value);
    if (s.length > 8192) {
      return { ok: false, error: `Parameter "${name}" exceeds the maximum length (8192).` };
    }
    if (!re.test(s)) {
      return { ok: false, error: `Parameter "${name}" does not match the required pattern.` };
    }
  }
  if (c.min !== undefined || c.max !== undefined) {
    // min/max only applies to a value that is ALREADY a number (a `type:'number'`
    // param, coerced by coerceParam). A non-number value is a contract
    // misconfiguration — fail closed rather than loosely `Number()`-coercing it
    // (which would let "0x10"/""/" " satisfy a numeric bound while a different
    // literal is substituted).
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `Parameter "${name}" must be a numeric parameter for its min/max constraint.` };
    }
    if (c.min !== undefined && value < c.min) {
      return { ok: false, error: `Parameter "${name}" must be >= ${c.min}.` };
    }
    if (c.max !== undefined && value > c.max) {
      return { ok: false, error: `Parameter "${name}" must be <= ${c.max}.` };
    }
  }
  return { ok: true };
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
