/**
 * Format a remaining-seconds countdown as MM:SS or H:MM:SS.
 * The previous formula in ChatView (`Math.floor(s/60)`:`s%60`) showed
 * `1439:40` for the 24h resumable-prompt default instead of `23:59:40`.
 */
export function formatCountdown(totalSeconds: number): string {
	const safe = Math.max(0, Math.floor(totalSeconds));
	const pad = (n: number) => String(n).padStart(2, '0');
	const seconds = safe % 60;
	const minutes = Math.floor(safe / 60) % 60;
	const hours = Math.floor(safe / 3600);
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
	return `${minutes}:${pad(seconds)}`;
}

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
