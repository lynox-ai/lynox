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
 * Legacy entry point — kept for back-compat with PR 2 callers. Returns the
 * subset of milestones that should render as enabled radios (drops both
 * hidden + disabled). New code should call `buildContextOptions` and render
 * the disabled milestones grayed with tooltip per Item 8.
 *
 * @deprecated use `buildContextOptions` instead.
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
