/**
 * What a compaction did, phrased for a person.
 *
 * The user asked for compaction to be visible — "in the bar or on the button,
 * as a percentage if need be". A percentage is the one thing that cannot be
 * shown honestly: compaction is a single blocking summarizer call with no
 * intermediate state, so any number ticking upward would be invented. What DOES
 * exist is the result, and it is the more useful fact anyway: how much context
 * the compaction actually freed.
 */

/** `163492` → `164k`; small values keep their digits. */
export function formatTokensShort(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return '?';
	if (tokens < 1000) return String(Math.round(tokens));
	const thousands = tokens / 1000;
	// One decimal below 10k so a compaction down to 2 600 does not read as "3k"
	// — the point of the line is the size of the drop.
	return thousands < 10
		? `${thousands.toFixed(1).replace(/\.0$/, '')}k`
		: `${Math.round(thousands)}k`;
}

/**
 * The `163k → 2.6k` line, or `null` when the numbers are not both known.
 *
 * Returning `null` rather than a partial string is the point: an engine that
 * predates this pair sends neither, and a marker claiming "compacted to 0" or
 * showing a lone arrow would be worse than one that simply says a compaction
 * happened. The caller renders nothing extra in that case.
 *
 * A compaction that did not shrink anything also returns `null` — reporting
 * `2.6k → 2.6k` invites the reader to conclude something failed, when the
 * honest reading is that there was nothing to reclaim.
 */
export function formatCompactionDelta(before?: number, after?: number): string | null {
	if (typeof before !== 'number' || typeof after !== 'number') return null;
	if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
	if (before <= 0 || after < 0) return null;
	if (after >= before) return null;
	return `${formatTokensShort(before)} → ${formatTokensShort(after)}`;
}
