/**
 * When a store's access runs out, as the engine tells it (`GET /api/api-profiles`,
 * `store_access_ends`: a store whose refresh token runs out within the hint's window, or has, with
 * the host the engine derives). The same store and end as the owner's push, but for as long as it
 * holds: an owner without web push sees it in the app before the end.
 */

import { localDay } from './provider-revocation.js';

export interface StoreAccessEnd {
	host: string;
	/** The end, ISO time. */
	at: string;
}

export interface StoreAccessProfile {
	id: string;
	store_access_ends?: StoreAccessEnd | undefined;
	oauth_grant?: { state?: unknown } | undefined;
	reader_may_connect?: boolean | undefined;
}

export type StoreAccessShown = { kind: 'soon' | 'ended'; profileId: string; host: string; date: string; mayConnect: boolean };

/**
 * What a profile shows of its store's end at `now`: `soon` before it, `ended` once it passed or the
 * refresh ended (`refresh-dead`), null for a profile the engine told nothing. A value that is not
 * the engine's shape shows nothing.
 */
export function storeAccessShown(profile: StoreAccessProfile, now: Date, locale: 'de' | 'en'): StoreAccessShown | null {
	const end = profile.store_access_ends;
	if (end === undefined || end === null || typeof end.host !== 'string' || end.host === '' || typeof end.at !== 'string') return null;
	const at = Date.parse(end.at);
	if (Number.isNaN(at)) return null;
	const ended = at <= now.getTime() || profile.oauth_grant?.state === 'refresh-dead';
	return { kind: ended ? 'ended' : 'soon', profileId: profile.id, host: end.host, date: localDay(end.at, locale), mayConnect: profile.reader_may_connect !== false };
}

/** A sentence split at `{host}`, with its other placeholders filled: the host goes between the parts. */
export function hostParts(sentence: string): { before: string; after: string } {
	const i = sentence.indexOf('{host}');
	return i < 0 ? { before: sentence, after: '' } : { before: sentence.slice(0, i), after: sentence.slice(i + '{host}'.length) };
}

/**
 * A host in pieces that end after each dot, for a line break only there: never inside a name, at a
 * hyphen or mid-word (`acme-store.` / `myshopify.com`). The page keeps each piece whole.
 */
export function hostSegments(host: string): string[] {
	return host.split(/(?<=\.)/);
}
