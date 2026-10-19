/**
 * What the page shows after a private-mode toggle the server did not answer with 2xx.
 *
 * Switching private mode ON also removes what is stored under the chat's id. When that
 * removal fails, the server has still stored the flag and answers 500 with
 * `skip_extraction: true` — so rolling the switch back would show private mode as OFF while
 * it is on, and the user would think the chat is being remembered when it is not, or the
 * reverse. The server's stored state wins whenever it says one; only without it does the
 * page fall back to the value it had before.
 */
export function privateToggleFailure(
	previous: boolean,
	body: unknown,
): {
	skip: boolean;
	messageKey: 'threads.private_purge_incomplete' | 'threads.error_extraction' | 'threads.error_contained';
	contained?: true;
} {
	const stored =
		typeof body === 'object' && body !== null
			? (body as { skip_extraction?: unknown }).skip_extraction
			: undefined;
	if (stored === true) return { skip: true, messageKey: 'threads.private_purge_incomplete' };
	// The chat read data through a store connection: private mode stays on for its life, and the
	// page says why instead of a generic failure.
	if (typeof body === 'object' && body !== null && (body as { code?: unknown }).code === 'contained') {
		return { skip: true, messageKey: 'threads.error_contained', contained: true };
	}
	return { skip: typeof stored === 'boolean' ? stored : previous, messageKey: 'threads.error_extraction' };
}

/**
 * Whether a private-mode toggle ended without saying what the server holds: no answer at all
 * (`status` null), or a server error whose body names no stored state. A gateway's 502/504 can
 * come after the engine stored the flag, so such an error is not evidence that nothing changed.
 * A 4xx is: the request was refused before anything was stored, and `privateToggleFailure` holds.
 */
export function privateToggleOutcomeUnknown(status: number | null, body: unknown): boolean {
	if (status === null) return true;
	const stored =
		typeof body === 'object' && body !== null
			? (body as { skip_extraction?: unknown }).skip_extraction
			: undefined;
	return status >= 500 && typeof stored !== 'boolean';
}

/**
 * What the page shows after a private-mode toggle whose outcome is unknown (see
 * `privateToggleOutcomeUnknown`): the request may have been stored or not, in either direction.
 *
 * OFF, whichever way the user switched. Of the two wrong pictures, showing private mode on while
 * the server holds it off is the one that lets a chat be remembered while the user thinks it is
 * not. Showing it off while the server holds it on only under-promises; the next click asks again.
 */
export function privateToggleNoAnswer(): { skip: false; messageKey: 'threads.error_extraction' } {
	return { skip: false, messageKey: 'threads.error_extraction' };
}
