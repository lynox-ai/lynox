// === Why a settings save was refused ===
//
// The server answers a refused `PUT /api/config` with a sentence in `error`: "Only the owner
// of this instance can change the configuration", a field a managed instance locks, a value
// that fails validation. Most settings pages threw `HTTP ${res.status}` or a bare Error and
// showed "HTTP 403" or "Save failed", so the person never learned that the setting is the
// owner's, or which field was wrong. Every save goes through `throwIfRefused`, and a test
// finds any `PUT` on `/config` that does not.
//
// The sentence is shown behind a translated lead (ux U-102): the server's reasons are English,
// and the lead says what did not happen. Some reasons repeat what was entered — the managed
// provider check quotes the `api_base_url` it refused — so a URL loses its credentials, query
// and fragment before the sentence reaches a toast. Nothing else is cut: what else the route
// repeats are model ids and preset names, which the person needs to read, and it repeats no key
// field (the schema's messages name no values). The server stripping the URL itself is its own
// register row.

import { tf } from '../i18n.svelte.js';

/** Longest sentence a toast shows; a longer one ends in "…". */
const MAX_REASON = 200;
/** A URL of any scheme: what stays is scheme, host and path. */
const URL_PART = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#'"@]*@)?([^\s/?#'"]+)([^\s?#'"]*)(?:[?#][^\s'"]*)?/gi;

/** The server's sentence as a toast may show it: no URL credentials, query or fragment, short. */
export function shownReason(reason: string): string {
	const masked = reason.replace(URL_PART, (_m, scheme: string, host: string, path: string) => `${scheme}${host}${path}`);
	return masked.length > MAX_REASON ? `${masked.slice(0, MAX_REASON - 1)}…` : masked;
}

/**
 * A save the server refused. `reason` is the sentence it sent, or null when it sent none; the
 * message is what a page shows: the translated lead with the sentence, or the status.
 */
export class SaveRefused extends Error {
	readonly reason: string | null;
	readonly status: number;

	constructor(reason: string | null, status: number) {
		super(reason === null ? `HTTP ${status}` : tf('settings.save_refused', { reason: shownReason(reason) }));
		this.name = 'SaveRefused';
		this.reason = reason;
		this.status = status;
	}
}

/** Throws `SaveRefused` when the answer is not ok, carrying the server's `error` sentence. */
export async function throwIfRefused(res: Response): Promise<void> {
	if (res.ok) return;
	let reason: string | null = null;
	try {
		const body: unknown = await res.json();
		if (body !== null && typeof body === 'object' && 'error' in body) {
			const error = (body as { error: unknown }).error;
			if (typeof error === 'string' && error.trim() !== '') reason = error.trim();
		}
	} catch {
		// Not JSON: there is no sentence to show, only the status.
	}
	throw new SaveRefused(reason, res.status);
}

/** The text for a failed save: the server's sentence behind the lead when it sent one, else `fallback`. */
export function saveFailedText(e: unknown, fallback: string): string {
	return e instanceof SaveRefused && e.reason !== null ? e.message : fallback;
}
