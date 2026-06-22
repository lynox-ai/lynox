import type { ManifestStep, AgentOutput } from '../types/orchestration.js';
import { getByPath } from './conditions.js';
import { channels } from '../core/observability.js';
import { detectInjectionAttempt, wrapUntrustedData } from '../core/data-boundary.js';

const DEFAULT_CONTEXT_LIMIT = 16_000;

/**
 * Build the context for a step by merging global context with outputs
 * from steps listed in `input_from`.
 */
export function buildStepContext(
  globalContext: Record<string, unknown>,
  step: ManifestStep,
  outputs: Map<string, AgentOutput>,
  contextLimit = DEFAULT_CONTEXT_LIMIT,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...globalContext };
  for (const fromId of step.input_from ?? []) {
    const out = outputs.get(fromId);
    if (out === undefined) {
      throw new Error(`Step "${step.id}" input_from "${fromId}" has not run yet`);
    }
    if (!out.skipped) {
      if (out.result.length > contextLimit && channels.contentTruncation.hasSubscribers) {
        channels.contentTruncation.publish({
          source: 'pipeline_step_context',
          stepId: fromId,
          originalLength: out.result.length,
          truncatedTo: contextLimit,
        });
      }
      const result = out.result.length > contextLimit
        ? out.result.slice(0, contextLimit) + `\n...[truncated — step "${fromId}" produced ${out.result.length} chars, showing first ${contextLimit}. Set "pipeline_context_limit" in config to increase.]`
        : out.result;
      ctx[fromId] = { result, costUsd: out.costUsd };
    }
  }
  return ctx;
}

/**
 * Resolve `{{step_id.result}}` / `{{params.<name>}}` template syntax in task
 * strings. Replaces template expressions with values from context. Missing
 * paths are left as-is (e.g. `{{unknown.path}}` stays unchanged).
 */
export function resolveTaskTemplate(task: string, context: Record<string, unknown>): string {
  return task.replace(/\{\{([^}]+)\}\}/g, (_match: string, rawPath: string) => {
    const path = rawPath.trim();
    const value = getByPath(context, path);
    if (value === undefined) return `{{${path}}}`;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    // Workflow parameter values are caller/external-supplied (untrusted) → ALWAYS
    // wrap them in the data boundary, not just when an injection pattern matches.
    // Pipeline step results keep the detect-based heuristic.
    if (path === 'params' || path.startsWith('params.')) {
      return wrapUntrustedData(str, `workflow_param:${path}`);
    }
    return detectInjectionAttempt(str).detected
      ? wrapUntrustedData(str, `pipeline_step:${path}`)
      : str;
  });
}

const SOLE_PLACEHOLDER = /^\{\{\s*([^}]+)\s*\}\}$/;

/**
 * Substitute `{{params.<name>}}` (and any `{{path}}`) placeholders inside a
 * captured tool-call input object — the deterministic-replay step. Walks every
 * string leaf of `template` (recursing into nested objects/arrays) and:
 *
 *  - a string that is EXACTLY one placeholder (`"{{params.month}}"`) resolves to
 *    the raw, typed value from context (a number stays a number, so the replayed
 *    tool call keeps its input contract);
 *  - a string with an embedded placeholder (`"report for {{params.client}}"`)
 *    resolves by string interpolation (non-string values JSON-stringified);
 *  - an unresolved path is left verbatim (`{{params.x}}`), so a missing value is
 *    visible rather than silently blanked.
 *
 * Unlike `resolveTaskTemplate`, the resolved value is NOT wrapped in the data
 * boundary: this produces the literal arguments the tool executes with, not
 * prose the agent reads, so a wrapper sentinel would corrupt the call. The
 * caller binds + validates params first (`bindWorkflowParameters`); the
 * per-call permission guard remains the execution gate. Fully deterministic —
 * no model involved.
 */
export function resolveInputTemplate(
  template: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return walk(template, context) as Record<string, unknown>;
}

function walk(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') return substituteString(value, context);
  if (Array.isArray(value)) return value.map(v => walk(v, context));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, context);
    }
    return out;
  }
  return value;
}

function substituteString(s: string, context: Record<string, unknown>): unknown {
  const sole = SOLE_PLACEHOLDER.exec(s);
  if (sole) {
    const resolved = getByPath(context, sole[1]!.trim());
    return resolved === undefined ? s : resolved;
  }
  return s.replace(/\{\{([^}]+)\}\}/g, (_match: string, rawPath: string) => {
    const path = rawPath.trim();
    const resolved = getByPath(context, path);
    if (resolved === undefined) return `{{${path}}}`;
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
  });
}
