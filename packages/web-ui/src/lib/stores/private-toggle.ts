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
): { skip: boolean; messageKey: 'threads.private_purge_incomplete' | 'threads.error_extraction' } {
	const stored =
		typeof body === 'object' && body !== null
			? (body as { skip_extraction?: unknown }).skip_extraction
			: undefined;
	if (stored === true) return { skip: true, messageKey: 'threads.private_purge_incomplete' };
	return { skip: typeof stored === 'boolean' ? stored : previous, messageKey: 'threads.error_extraction' };
}
