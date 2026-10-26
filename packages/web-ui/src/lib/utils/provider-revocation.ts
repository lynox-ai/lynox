/**
 * What a profile shows after its provider revoked the grant: when it was revoked, and while an
 * erasure of what lynox sent through it is pending, when that erasure falls.
 *
 * The engine decides which erasures to tell about (`GET /api/connections/records`, owner-only);
 * this only reads the answer and drops a notice whose deadline has passed while the page was open.
 * Dates are shown without a time, in the reader's time zone: the erasure never happens before the
 * local day of `holdUntil`, and is done by the local day of `deadline` unless a run is still going
 * or the instance is off, which the notice says.
 */

/** When a profile's pending erasures fall: the earliest end of a hold, the latest deadline. */
export interface ProviderNotice {
	holdUntil: string;
	deadline: string;
}

/** The time the grant was revoked, or null when the profile's grant is not revoked. */
export function revokedAt(grant: { state?: unknown; revoked_at?: unknown } | undefined): string | null {
	if (grant === undefined || grant === null || grant.state !== 'revoked') return null;
	return typeof grant.revoked_at === 'string' && !Number.isNaN(Date.parse(grant.revoked_at)) ? grant.revoked_at : null;
}

/**
 * The notices of the answer that are well formed, keyed by profile id. A profile can have more than
 * one pending erasure; its notice spans them all, from the earliest hold to the latest deadline. A
 * malformed answer is none.
 */
export function noticesByProfile(body: unknown): Map<string, ProviderNotice> {
	const out = new Map<string, ProviderNotice>();
	const list = typeof body === 'object' && body !== null ? (body as { notices?: unknown }).notices : undefined;
	if (!Array.isArray(list)) return out;
	for (const n of list) {
		if (typeof n !== 'object' || n === null) continue;
		const { recordId, connectionId, holdUntil, deadline } = n as Record<string, unknown>;
		if (typeof recordId !== 'number' || typeof connectionId !== 'string' || typeof holdUntil !== 'string' || typeof deadline !== 'string') continue;
		if (Number.isNaN(Date.parse(holdUntil)) || Number.isNaN(Date.parse(deadline))) continue;
		const seen = out.get(connectionId);
		out.set(connectionId, seen === undefined ? { holdUntil, deadline } : {
			holdUntil: Date.parse(holdUntil) < Date.parse(seen.holdUntil) ? holdUntil : seen.holdUntil,
			deadline: Date.parse(deadline) > Date.parse(seen.deadline) ? deadline : seen.deadline,
		});
	}
	return out;
}

/** Whether a notice still shows at `now`: until its deadline. */
export function noticeShows(notice: ProviderNotice | undefined, now: Date): notice is ProviderNotice {
	return notice !== undefined && Date.parse(notice.deadline) > now.getTime();
}

/** A date without a time, in the reader's time zone. */
export function localDay(iso: string, locale: 'de' | 'en'): string {
	return new Date(iso).toLocaleDateString(locale === 'de' ? 'de-CH' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
