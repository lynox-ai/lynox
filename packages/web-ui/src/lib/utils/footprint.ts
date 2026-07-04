// Record-on-spine R2b — subject-footprint render helpers.

/**
 * A glanceable one-line summary of a footprint record row: the first few user
 * columns (system `_id`/`_created_at`/`_updated_at` dropped), `key: value`-joined
 * and value-truncated. `skipCols` — the subject column(s) that link this row to the
 * viewed subject — are omitted: showing the subject's own id inside its own
 * footprint row is redundant (the panel header already names it). Dropping a skipped
 * column makes room for the next one within the 4-column cap.
 */
export function recordRowSummary(row: Record<string, unknown>, skipCols: string[] = []): string {
	const skip = new Set(skipCols);
	return Object.entries(row)
		.filter(([k]) => !k.startsWith('_') && !skip.has(k))
		.slice(0, 4)
		.map(([k, v]) => {
			const s = v === null || v === undefined ? '—' : String(v);
			return `${k}: ${s.length > 40 ? s.slice(0, 39) + '…' : s}`;
		})
		.join(' · ');
}
