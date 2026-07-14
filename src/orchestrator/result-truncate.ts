/**
 * Step-result truncation, shared by the orchestrator's durable step-record
 * write (runner.ts finalize) and the tool-layer result formatter (pipeline.ts).
 * Lives in the orchestrator layer so both can import it without the tool layer
 * owning a util the orchestrator depends on.
 */
export const DEFAULT_RESULT_BYTES = 20_480; // 20KB per step result

export function truncateResult(result: string, limit = DEFAULT_RESULT_BYTES): string {
  if (result.length <= limit) return result;
  const limitKB = Math.round(limit / 1024);
  return result.slice(0, limit) + `\n...[truncated — result was ${result.length} chars, showing first ${limitKB}KB. Set "pipeline_step_result_limit" in config to increase.]`;
}
