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
 * Resolve `{{step_id.result}}` template syntax in task strings.
 * Replaces template expressions with values from context.
 * Missing paths are left as-is (e.g. `{{unknown.path}}` stays unchanged).
 */
export function resolveTaskTemplate(task: string, context: Record<string, unknown>): string {
  return task.replace(/\{\{([^}]+)\}\}/g, (_match: string, path: string) => {
    const value = getByPath(context, path.trim());
    if (value === undefined) return `{{${path}}}`;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    // Wrap with untrusted boundary only if injection patterns are detected
    return detectInjectionAttempt(str).detected
      ? wrapUntrustedData(str, `pipeline_step:${path.trim()}`)
      : str;
  });
}
