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
 * Smart cost formatting:
 * - null/0 → '-'
 * - < $0.01 → '$0.003' (3 significant digits)
 * - < $1 → '$0.12' (2 decimal places)
 * - ≥ $1 → '$1.23' (2 decimal places)
 */
export function formatCost(usd: number | null | undefined): string {
	if (usd == null || usd === 0) return '-';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
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
