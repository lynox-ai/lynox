/**
 * A tool call that COMPLETED but did not succeed.
 *
 * ## The hole this fills
 *
 * `agent.ts` publishes `toolEnd` with `success: true` whenever a handler
 * RETURNS, and `success: false` only when it THROWS. `engine-init.ts` then
 * writes the ledger as `outputJson: data.success ? '' : error`, and
 * `run-history-analytics.ts` counts `output_json != ''` as `error_count`.
 *
 * Several tools legitimately return their failure as a normal string, because
 * the agent should read it and adapt rather than have the turn aborted:
 *
 *   - `web_research` catches everything and returns `Failed to read URL: …`
 *   - `bash` catches a non-zero exit and returns the combined stdout+stderr
 *
 * Both therefore recorded as successes. Measured on one real thread
 * (`fa3f2b23`, 2026-08-02): **123 tool calls, exactly 1 counted as an error**,
 * while roughly 35 of its 63 `web_research` reads had 404'd and a long run of
 * `wget` calls had failed. Any dashboard built on `error_count` reports green
 * for a session where half the tool calls went nowhere — and the analysis that
 * found this had to reconstruct the truth by reading tool inputs by hand.
 *
 * ## Why an exception and not a heuristic
 *
 * Sniffing the returned string for "Failed"/"Error" is not viable: a fetched web
 * page or a grepped log legitimately contains those words, so the classifier
 * would be wrong in both directions on exactly the tools that matter. The tool
 * already KNOWS — `bash` caught a non-zero exit, `web_research` caught a throw.
 * This just lets it say so.
 *
 * ## Why it does not change what the agent sees
 *
 * `agentVisibleResult` is returned to the model verbatim, on the ordinary
 * success path — it is still secret-masked, injection-scanned via
 * `scanToolResult`, and truncated to `max_tool_result_chars`. It is NOT marked
 * `is_error`, so the agent loop behaves exactly as before. The only thing that
 * changes is the ledger. That separation is the point: this is an observability
 * fix, and an observability fix that alters agent behaviour would be a
 * behaviour change wearing a disguise.
 */
export class ToolSoftFailure extends Error {
  /**
   * @param agentVisibleResult What the model reads — byte-identical to what the
   *   tool returned before this class existed.
   * @param reason Short, ledger-facing description of the failure. Goes into
   *   `tool_calls.output_json`, which is the error field despite the name.
   */
  constructor(
    readonly agentVisibleResult: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'ToolSoftFailure';
  }
}

/** Narrow an unknown throw to a soft failure. */
export function isToolSoftFailure(err: unknown): err is ToolSoftFailure {
  return err instanceof ToolSoftFailure;
}
