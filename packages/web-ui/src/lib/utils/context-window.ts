// Settings v3 Items 6/8 helpers — pure functions extracted from LLMAdvancedView
// so the option-list logic is unit-testable without Svelte runtime.

export interface ContextMilestone {
	value: number;
	labelKey: string;
	hintKey: string;
}

export interface ContextOption {
	value: number | undefined;
	labelKey: string;
	hintKey: string;
	/** True when the milestone exceeds the active model's native window —
	 *  rendered disabled with a tooltip rather than hidden (Item 8). */
	disabled: boolean;
	/** True when the milestone equals the active model's native window —
	 *  redundant with the "Default" radio; hidden to keep the list clean. */
	hidden: boolean;
}

/**
 * Build the context-window radio list with show-all-grayed semantics:
 * - `< native` → enabled (real cap users can pick)
 * - `== native` → hidden (redundant with the "Default" radio above)
 * - `> native` → disabled (over-promise: engine would silently clamp)
 *
 * When `native` is undefined (older engine without /api/config.active_model
 * or registry miss), all milestones render enabled (legacy behaviour).
 *
 * Pre-2026-05-19 the UI hard-coded [200k, 500k, 1M] regardless of model,
 * so Sonnet base users saw "1M" silently clamping to 200K — lying UI.
 */
export function buildContextOptions(
	native: number | undefined,
	milestones: ReadonlyArray<ContextMilestone>,
): ContextOption[] {
	return milestones.map((m) => ({
		value: m.value,
		labelKey: m.labelKey,
		hintKey: m.hintKey,
		disabled: native !== undefined && m.value > native,
		hidden: native !== undefined && m.value === native,
	}));
}

/**
 * Format a context-window size for the active-model label. Splits on
 * the 1M boundary so 1_000_000 renders as "1M" rather than "1000K".
 * Half-millions (e.g. 500_000) stay as "500K" since "0.5M" reads worse.
 *
 * Edge case: tokens that round to ≥1000K (e.g. 999_500) cross over to "1M"
 * to avoid the misleading "1000K" rendering for near-1M registry entries.
 */
export function formatContextWindow(tokens: number): string {
	const k = Math.round(tokens / 1000);
	if (k >= 1000) {
		// Derive `m` from the rounded `k` so near-1M values (e.g. 999_999 K=1000)
		// render as "1M" instead of "1.0M" via `toFixed(1)` on 0.999999.
		const m = k / 1000;
		return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
	}
	return `${k}K`;
}
