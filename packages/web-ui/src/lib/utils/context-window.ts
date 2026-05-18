// Settings v3 Item 6 helpers — pure functions extracted from LLMAdvancedView
// so the filter + formatter logic is unit-testable without Svelte runtime.

export interface ContextMilestone {
	value: number;
	labelKey: string;
	hintKey: string;
}

/**
 * Filter cap milestones to those strictly below the active model's native
 * context window. Above-native is redundant with the "default" radio
 * (which uses native, no cap) and pre-fix the UI offered "1M" on
 * Sonnet base which silently capped to 200K — lying UI.
 *
 * When `native` is undefined (older engine without /api/config.active_model
 * or registry miss), returns all milestones so the page still renders.
 */
export function filterContextMilestones(
	native: number | undefined,
	milestones: ReadonlyArray<ContextMilestone>,
): ContextMilestone[] {
	if (native === undefined) return [...milestones];
	return milestones.filter((m) => m.value < native);
}

/**
 * Format a context-window size for the active-model label. Splits on
 * the 1M boundary so 1_000_000 renders as "1M" rather than "1000K".
 * Half-millions (e.g. 500_000) stay as "500K" since "0.5M" reads worse.
 */
export function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		// Strip trailing .0 (1.0M → 1M) but keep .5/.1/etc when present.
		return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
	}
	return `${Math.round(tokens / 1000)}K`;
}
