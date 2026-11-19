/**
 * What a question's card says about the time it has left, or null for nothing. A day-long
 * countdown ticking by the second makes pressure there is none of, so with an hour or more left
 * the card shows no number. Under an hour it names whole minutes, rounded down so it never
 * promises time the question does not have; under a minute, seconds.
 */
export function promptExpiry(secondsLeft: number): { key: 'chat.prompt_expires_min' | 'chat.prompt_expires_s'; n: number } | null {
	const safe = Math.max(0, Math.floor(secondsLeft));
	if (safe >= 3600) return null;
	if (safe >= 60) return { key: 'chat.prompt_expires_min', n: Math.floor(safe / 60) };
	return { key: 'chat.prompt_expires_s', n: safe };
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
