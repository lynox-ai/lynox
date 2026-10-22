/**
 * What a profile shows after its provider revoked the grant: when it was revoked, and while an
 * erasure of what lynox sent through it is pending, when that erasure falls — on the revoked
 * profile, and on a profile connected again while such an erasure still stands.
 *
 * The engine decides which erasures to tell about (`GET /api/connections/records`, owner-only);
 * this only reads the answer, drops a notice whose deadline has passed while the page was open,
 * and picks the text by the profile's state (`revocationView`).
 * Dates are shown without a time, in the reader's time zone: the erasure never happens before the
 * local day of `holdUntil`, and is done by the local day of `deadline` unless a run is still going
 * or the instance is off, which the notice says.
 */

import { connectionLine, type OAuthGrantView } from './oauth-connection.js';

/**
 * When a profile's pending erasures fall: the earliest refusal, the earliest end of a hold, the
 * latest deadline. The earliest refusal is the one whose hold ends first, so "within 14 days of the
 * revocation" and the earliest date count from the same moment.
 */
export interface ProviderNotice {
	revokedAt: string;
	holdUntil: string;
	deadline: string;
	/** Whether a new consent connected the profile again after every pending refusal. */
	reconnected: boolean;
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
		const { recordId, connectionId, revokedAt, holdUntil, deadline, reconnected } = n as Record<string, unknown>;
		if (typeof recordId !== 'number' || typeof connectionId !== 'string' || typeof revokedAt !== 'string' || typeof holdUntil !== 'string' || typeof deadline !== 'string' || typeof reconnected !== 'boolean') continue;
		if (Number.isNaN(Date.parse(revokedAt)) || Number.isNaN(Date.parse(holdUntil)) || Number.isNaN(Date.parse(deadline))) continue;
		const seen = out.get(connectionId);
		out.set(connectionId, seen === undefined ? { revokedAt, holdUntil, deadline, reconnected } : {
			reconnected: seen.reconnected && reconnected,
			revokedAt: Date.parse(revokedAt) < Date.parse(seen.revokedAt) ? revokedAt : seen.revokedAt,
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

/**
 * What the profile shows, by its state:
 * - `revoked`: the profile is revoked. The revocation line (the earliest pending refusal, else the
 *   grant's own; none when neither is known), the button, and while a notice applies its dates and
 *   text. A mandate's own grant refused is this case too.
 * - `reconnected`: a mandate's new consent connected it again while an erasure stands. Who, the
 *   dates and the text; the way out and the button only while every pending hold still runs, since
 *   the owner's reconnect cancels only the erasures still held.
 * - `connectedAgain`: connected otherwise while every pending hold still runs: it works again
 *   without a new consent (a later grant's refusal lifted, an exchange on a new credential; its
 *   `connected_by` is the refused grant's), or the owner adopted a mandate's connection. It names
 *   no one. The dates, the text and the button: the owner's reconnect still cancels them all.
 * - `pending`: connected otherwise past a hold (the owner's reconnect after it, or any of the
 *   above). The revocation line and the dates only.
 * - null: nothing to show.
 */
export type RevocationView =
	| { kind: 'revoked'; revokedAt: string | null; notice: ProviderNotice | null }
	| { kind: 'reconnected'; who: string; notice: ProviderNotice; avertable: boolean }
	| { kind: 'connectedAgain' | 'pending'; notice: ProviderNotice };

export function revocationView(
	grant: { state?: unknown; revoked_at?: unknown; connected_by?: unknown } | undefined,
	notice: ProviderNotice | undefined,
	now: Date,
): RevocationView | null {
	const shown = noticeShows(notice, now) ? notice : null;
	if (grant?.state === 'revoked') return { kind: 'revoked', revokedAt: shown?.revokedAt ?? revokedAt(grant), notice: shown };
	if (shown === null) return null;
	const held = Date.parse(shown.holdUntil) > now.getTime();
	const by = connectionLine(grant as OAuthGrantView | undefined)?.by;
	if (shown.reconnected && by?.kind === 'helper') return { kind: 'reconnected', who: by.address, notice: shown, avertable: held };
	return { kind: held ? 'connectedAgain' : 'pending', notice: shown };
}

/** A date without a time, in the reader's time zone. */
export function localDay(iso: string, locale: 'de' | 'en'): string {
	return new Date(iso).toLocaleDateString(locale === 'de' ? 'de-CH' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
