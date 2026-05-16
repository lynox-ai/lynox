/**
 * Shared formatting utilities for consistent display across all dashboards.
 */

/** Model pricing per 1M tokens (USD). Mirrors core/src/core/pricing.ts. */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
	'claude-opus-4-6':           { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.5  },
	'claude-sonnet-4-6':         { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.3  },
	'claude-haiku-4-5-20251001': { input: 0.80, output: 4,   cacheWrite: 1.0,   cacheRead: 0.08 },
};

const FALLBACK_PRICING = MODEL_PRICING['claude-sonnet-4-6']!;

export function getModelPricing(model: string | null | undefined) {
	if (!model) return FALLBACK_PRICING;
	return MODEL_PRICING[model] ?? FALLBACK_PRICING;
}

/**
 * Estimate cost in USD from token usage and model.
 * input_tokens should NOT include cache tokens (matches Anthropic API semantics).
 */
export function estimateCost(
	model: string | null | undefined,
	usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
): number {
	const p = getModelPricing(model);
	return (usage.input_tokens / 1_000_000) * p.input
		+ (usage.output_tokens / 1_000_000) * p.output
		+ ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cacheWrite
		+ ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheRead;
}

/**
 * Smart cost formatting — canonical SSoT (PRD-IA-V2 P1-PR-B).
 * Float-USD input. Used everywhere a precise per-run / per-step / per-day cost
 * is rendered (HistoryView, ActivityHub, WorkflowsView, StatusBar, ColdStartBanner, …).
 *
 * - null/0 → '-' (no-data sentinel)
 * - < $0.01 → '$0.0042' (4 decimals — preserves migration-estimate sub-cent precision)
 * - ≥ $0.01 → '$0.12' / '$1.23' (2 decimals)
 *
 * For integer-cents input (Dashboard / budget contexts where sub-cent precision
 * is already lost on the wire), see `formatCostCents`.
 */
export function formatCost(usd: number | null | undefined): string {
	if (usd == null || usd === 0) return '-';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

/**
 * Cost formatting for integer-cents input (Dashboard / budget contexts).
 * Sub-integer-cent precision is lost on the wire, so we render '< $0.01'
 * instead of '$0.00' to signal "non-zero but rounded".
 *
 * - null/undefined → '-' (no-data)
 * - 0 → '$0.00' (real zero — explicit, not a sentinel)
 * - 0 < c < 1 → '< $0.01' (sub-cent rounded value)
 * - ≥ 1 cent → '$X.YY'
 */
export function formatCostCents(cents: number | null | undefined): string {
	if (cents == null) return '-';
	if (cents === 0) return '$0.00';
	if (cents < 1) return '< $0.01';
	const d = Math.floor(cents / 100);
	const r = (cents % 100).toString().padStart(2, '0');
	return `$${d}.${r}`;
}

/** Duration formatting: ms → human-readable. */
export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || ms === 0) return '-';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

/** Shorten model IDs for display: strip provider prefix + date suffix. */
export function shortModel(id: string): string {
	return id.replace(/^(anthropic|openai|google)[./]/, '').replace(/-\d{8}$/, '');
}
