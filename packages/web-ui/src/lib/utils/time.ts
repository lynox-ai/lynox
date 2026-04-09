/**
 * Returns a compact relative-time string for a given ISO date
 * (e.g. "now", "3m", "2h", "5d").
 *
 * Handles timezone-naive strings by treating them as UTC.
 */
export function timeAgo(dateStr: string, nowLabel = 'now'): string {
	const parsed = new Date(
		dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z',
	);
	const diff = Date.now() - parsed.getTime();
	if (Number.isNaN(diff)) return '';
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return nowLabel;
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}
