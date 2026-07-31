/**
 * Pure helpers for the chat-message usage footer. Kept as plain TS (no Svelte
 * runes, no `.svelte.ts`) so they can be unit-tested without a Svelte runtime —
 * the chat store re-exports `usageFromDoneEvent` and exercises it from the
 * `done` SSE handler.
 */

import { formatCost } from '../format.js';

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
	/** What this turn's sub-agents spent, at any spawn depth. Absent when the
	 *  turn delegated nothing. Held apart from `costUsd` because the engine
	 *  keeps each child as its own run row (folding it in would double-count
	 *  thread totals) — the footer adds the two for display. */
	spawnCostUsd?: number;
	/** Actual model that produced this turn — comes from the engine's turn_end
	 *  event. Differs from the session default when the auto-downgrade flipped
	 *  to the haiku-tier for a simple task; surfaces in the footer so the user
	 *  can tell which model their reply came from. */
	model?: string;
	// ── Diagnostics (opt-in panel, not shown in the baseline footer) ──
	/** Final turn's stop_reason (end_turn / max_tokens / tool_use). Live-only
	 *  (from turn_end); absent after a reload. */
	stopReason?: string;
	/** Agent-loop iteration count for the run. Live-only (from turn_end usage). */
	iterations?: number;
	/** Client-measured time-to-first-token (ms): first streamed content event
	 *  minus run start. Live-only. */
	ttfbMs?: number;
	/** Engine wall-to-wall run duration (ms). Persisted via usage_json. */
	durationMs?: number;
	/** Run id for log/Bugsink correlation. Persisted via usage_json. */
	runId?: string;
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
		...(typeof u['spawnCostUsd'] === 'number' && u['spawnCostUsd'] > 0
			? { spawnCostUsd: u['spawnCostUsd'] }
			: {}),
		...(typeof u['model'] === 'string' ? { model: u['model'] } : {}),
		...(typeof u['runId'] === 'string' ? { runId: u['runId'] } : {}),
		...(typeof u['durationMs'] === 'number' ? { durationMs: u['durationMs'] } : {}),
	};
}

/**
 * Merge the engine's authoritative per-run usage (from the `done` event) into
 * the message's footer state. Multi-turn agent loops fire many `turn_end`
 * events which the UI accumulates while streaming for a live counter; on
 * `done` we REPLACE that running total with the engine's cumulative figure
 * — the same value RunHistory + `/api/history/cost/daily` use as truth.
 * `apiCostUsd` (third-party API cost) is preserved across the replacement
 * because the engine's run-usage covers LLM cost only. The live-only
 * diagnostics fields (`stopReason`, `iterations`, `ttfbMs`) are likewise
 * carried over — they come from `turn_end` / client timing, not the `done`
 * payload, so a naive replace would drop them.
 */
export function mergeDoneUsage(
	prior: UsageInfo | undefined,
	rawDoneUsage: unknown,
): UsageInfo | undefined {
	const parsed = usageFromDoneEvent(rawDoneUsage);
	if (!parsed) return prior;
	const carried: Partial<UsageInfo> = {};
	if (prior?.apiCostUsd !== undefined) carried.apiCostUsd = prior.apiCostUsd;
	if (prior?.stopReason !== undefined) carried.stopReason = prior.stopReason;
	if (prior?.iterations !== undefined) carried.iterations = prior.iterations;
	if (prior?.ttfbMs !== undefined) carried.ttfbMs = prior.ttfbMs;
	return { ...parsed, ...carried };
}

/**
 * The per-turn token total shown at the HEAD of the message footer. This is the
 * engine's cumulative `RunUsageSummary` — a SUM across every internal tool-loop
 * iteration of the run — so on a multi-step answer it can legitimately exceed
 * the model's context window (e.g. 1.5M on a 1M-context model = ~10 iterations
 * summed, NOT one 1.5M prompt). It is NOT a single prompt size and NOT the
 * current window fill (that's the adjacent occupancy chip). The `Σ` prefix +
 * the footer tooltip (`chat.footer_tokens_tooltip`) make the sum-nature
 * glanceable so the number no longer reads as broken. (rafael 2026-07-08)
 */
export function formatTurnTokens(u: UsageInfo): string {
	return `Σ ${(u.tokensIn + u.tokensOut).toLocaleString()} tokens`;
}

/** One footer segment. `title` carries the untruncated value when the rendered
 *  `text` is a shortened form (currently only the model id). */
export interface UsageMetaPart {
	text: string;
	title?: string;
}

/**
 * Everything AFTER the token count in the footer: LLM $ (+ third-party API $
 * when meaningful), cache-hit %, and the dispatched model id. Split out from
 * `formatTurnTokens` so the token value can carry its own tooltip while the
 * rest stays plain.
 *
 * `includeCost` gates ONLY the dollar figures (LLM + third-party API). The
 * cache/model metrics always render — they're free of pricing and carry the
 * provider/tier verification self-hosters + BYOK users rely on. Demo tenants
 * pass includeCost=false so the public playground shows metrics (not a black
 * box) without surfacing prices. Real tenants (self-host, BYOK, Managed) always
 * see cost — keeping AI spend transparent rather than hidden. (rafael 2026-05-29)
 */
export function formatUsageMetaParts(u: UsageInfo, includeCost: boolean): UsageMetaPart[] {
	const parts: UsageMetaPart[] = [];
	if (includeCost) {
		// A delegated turn costs what the main run cost PLUS what its sub-agents
		// spent, and the two live in separate run rows. Show the sum — that is the
		// number the question "what did this answer cost?" asks for — and name the
		// split in the tooltip so the main-run figure stays recoverable. Showing
		// only `costUsd` understated a measured deep review by 18%.
		const spawn = u.spawnCostUsd ?? 0;
		parts.push(spawn > 0
			? {
				text: formatCost(u.costUsd + spawn),
				title: `${formatCost(u.costUsd)} + ${formatCost(spawn)} sub-agents`,
			}
			: { text: formatCost(u.costUsd) });
		// Phase E: surface third-party API cost (DataForSEO etc.) next to the LLM
		// cost when the message hit any profiled API. Threshold of >$0.001 keeps
		// the row clean when nothing meaningful happened.
		if (u.apiCostUsd !== undefined && u.apiCostUsd > 0.001) {
			parts.push({ text: `API: ${formatCost(u.apiCostUsd)}` });
		}
	}
	const cachePct = u.tokensIn > 0 ? Math.round((u.cacheRead / u.tokensIn) * 100) : 0;
	if (cachePct > 0) parts.push({ text: `${cachePct}% cache` });
	// rafael QA 2026-05-18: surface the actual dispatched model id so the user
	// can verify their provider choice actually applies (and so auto-downgrade is
	// observable rather than hidden behind an Anthropic-flavoured tier alias in
	// the model's text response).
	if (u.model) {
		const short = shortModelLabel(u.model);
		parts.push(short === u.model ? { text: short } : { text: short, title: u.model });
	}
	return parts;
}

/**
 * Display form of a dispatched model id. Hosted-inference providers namespace
 * their ids as a path (`accounts/fireworks/models/glm-5p2`), which crowds the
 * footer line without adding information — the last segment is the model. Ids
 * without a slash (every Anthropic and Mistral id) are returned untouched, so
 * this only ever shortens the case that needs it. The full id stays reachable:
 * callers put it in the `title` of the shortened part.
 */
export function shortModelLabel(model: string): string {
	if (!model.includes('/')) return model;
	const last = model.split('/').filter(Boolean).pop();
	return last && last.length > 0 ? last : model;
}

/**
 * The footer tail as a single ` · `-joined string. Kept for callers/tests that
 * want the flat form; the ChatView footer renders the parts individually (via
 * `formatUsageMetaParts`) so every separator is one consistent styled element.
 */
export function formatUsageMeta(u: UsageInfo, includeCost: boolean): string {
	return formatUsageMetaParts(u, includeCost).map((p) => p.text).join(' · ');
}
