/**
 * Pure helpers for the chat-message usage footer. Kept as plain TS (no Svelte
 * runes, no `.svelte.ts`) so they can be unit-tested without a Svelte runtime —
 * the chat store re-exports `usageFromDoneEvent` and exercises it from the
 * `done` SSE handler.
 */

export interface UsageInfo {
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	/** Cumulative third-party API cost (DataForSEO etc.) charged this message,
	 *  populated by the api_cost stream event. Distinct from `costUsd` which is
	 *  LLM-only. Surfaces in the thread footer rollup. */
	apiCostUsd?: number;
	/** Actual model that produced this turn — comes from the engine's turn_end
	 *  event. Differs from the session default when the auto-downgrade flipped
	 *  to the haiku-tier for a simple task; surfaces in the footer so the user
	 *  can tell which model their reply came from. */
	model?: string;
}

/**
 * Parse the `usage` payload echoed by the HTTP API `done` SSE event into a
 * UsageInfo. The payload mirrors the engine's `RunUsageSummary` shape (see
 * `core/src/core/session.ts`) — i.e. the authoritative cumulative cost for
 * the just-completed run, sourced from `session.getLastRunUsage()` and equal
 * to what RunHistory persists in `cost_usd`. Used by the `done` handler to
 * REPLACE any `turn_end`-accumulated total with the engine's single source of
 * truth. Returns null if the payload is missing or malformed so the caller
 * can leave the prior `msg.usage` untouched.
 */
export function usageFromDoneEvent(raw: unknown): UsageInfo | null {
	if (!raw || typeof raw !== 'object') return null;
	const u = raw as Record<string, unknown>;
	return {
		tokensIn: Number(u['tokensIn'] ?? 0),
		tokensOut: Number(u['tokensOut'] ?? 0),
		cacheRead: Number(u['cacheRead'] ?? 0),
		cacheWrite: Number(u['cacheWrite'] ?? 0),
		costUsd: Number(u['costUsd'] ?? 0),
		...(typeof u['model'] === 'string' ? { model: u['model'] } : {}),
	};
}

/**
 * Merge the engine's authoritative per-run usage (from the `done` event) into
 * the message's footer state. Multi-turn agent loops fire many `turn_end`
 * events which the UI accumulates while streaming for a live counter; on
 * `done` we REPLACE that running total with the engine's cumulative figure
 * — the same value RunHistory + `/api/history/cost/daily` use as truth.
 * `apiCostUsd` (third-party API cost) is preserved across the replacement
 * because the engine's run-usage covers LLM cost only.
 */
export function mergeDoneUsage(
	prior: UsageInfo | undefined,
	rawDoneUsage: unknown,
): UsageInfo | undefined {
	const parsed = usageFromDoneEvent(rawDoneUsage);
	if (!parsed) return prior;
	const apiCostUsd = prior?.apiCostUsd;
	return apiCostUsd !== undefined ? { ...parsed, apiCostUsd } : parsed;
}
