/**
 * When a store's access runs out, as the engine tells it (`GET /api/api-profiles`,
 * `store_access_ends`, from `storeAccessEnd`): a store whose refresh token runs out within the
 * hint's window or has, or whose refresh ended, until it is connected again; with the host the
 * engine derives. The same store and end as the owner's push, but for as long as it holds: an owner
 * without web push sees it in the app before the end.
 */


export interface StoreAccessEnd {
	host: string;
	/** Whether the access ended: the end passed, or the refresh ended. */
	ended?: boolean | undefined;
	/** The end, ISO time; missing when the engine does not know it. */
	at?: string | undefined;
}

export interface StoreAccessProfile {
	id: string;
	store_access_ends?: StoreAccessEnd | undefined;
	oauth_grant?: { state?: unknown } | undefined;
	reader_may_connect?: boolean | undefined;
}

export type StoreAccessShown = { kind: 'soon' | 'ended'; profileId: string; host: string; date: string; mayConnect: boolean };

/**
 * What a profile shows of its store's end at `now`: `soon` before it, `ended` once the engine says
 * so, the end passed, or the refresh ended (`refresh-dead`); null for a profile the engine told
 * nothing. A value that is not the engine's shape shows nothing; `soon` needs a known end.
 */
export function storeAccessShown(profile: StoreAccessProfile, now: Date, locale: 'de' | 'en'): StoreAccessShown | null {
	const end = profile.store_access_ends;
	if (end === undefined || end === null || typeof end.host !== 'string' || end.host === '') return null;
	const at = typeof end.at === 'string' ? Date.parse(end.at) : Number.NaN;
	if (end.at !== undefined && Number.isNaN(at)) return null;
	const known = !Number.isNaN(at);
	const ended = end.ended === true || profile.oauth_grant?.state === 'refresh-dead' || (known && at <= now.getTime());
	if (!ended && !known) return null;
	return { kind: ended ? 'ended' : 'soon', profileId: profile.id, host: end.host, date: known ? longDay(end.at!, locale) : '', mayConnect: profile.reader_may_connect !== false };
}

/**
 * Whether the page should ask the engine again (`GET /api/api-profiles`): an end it was told of
 * has come since the last question that was answered was sent (`askedAt`). Until an answer to a newer one the page shows what the
 * engine said then, so an end that passes in an open tab is never called ended on the browser's
 * clock alone: a run may have renewed the store meanwhile. An end at or before `askedAt` was
 * already the engine's word and asks nothing; neither does a page that has no answer yet.
 */
export function storeAccessAskAgain(profiles: readonly StoreAccessProfile[], askedAt: number | null, now: Date): boolean {
	if (askedAt === null) return false;
	return profiles.some((p) => {
		const iso = p.store_access_ends?.at;
		const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
		return !Number.isNaN(at) && at > askedAt && at <= now.getTime();
	});
}

/**
 * A deadline's day with the month's name, in the reader's time zone (U-391): `5. Dezember 2026`,
 * `December 5, 2026`. Never in digits alone: `05/12/2026` reads as May 12 to an American reader.
 */
export function longDay(iso: string, locale: 'de' | 'en'): string {
	// Held together by no-break spaces: a line never ends between the day and its month.
	return new Date(iso).toLocaleDateString(locale === 'de' ? 'de-CH' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/ /g, '\u00a0');
}
