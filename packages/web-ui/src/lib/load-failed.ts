import { t } from './i18n.svelte.js';

// What a page says when it could not load. The engine answers a burst of requests from one
// client with 429 (`RATE_MAX` per window, `http-api.ts`); a tab reloaded a few times reaches
// it, and the page then said "Is the engine reachable?" — a cause it did not have. A 429 says
// that it came too often and what helps; every other failure keeps the sentence it had.

/** A response that was not ok, with its status, so the place that shows the failure can say
 *  which it was. */
export class LoadFailedError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
		this.name = 'LoadFailedError';
	}
}

/** `res`, or a {@link LoadFailedError} with its status where it is not ok. */
export function ensureOk(res: Response): Response {
	if (!res.ok) throw new LoadFailedError(res.status);
	return res;
}

/** The status a failure carries: a {@link LoadFailedError}'s, a response's, or a bare number;
 *  null for anything else (a network error, a parse error). */
function statusOf(cause: unknown): number | null {
	if (cause instanceof LoadFailedError) return cause.status;
	if (typeof cause === 'number') return cause;
	if (typeof Response !== 'undefined' && cause instanceof Response) return cause.status;
	return null;
}

/** The sentence for a failed load: the rate limit's for a 429, the general one for all else. */
export function loadFailedText(cause?: unknown): string {
	return statusOf(cause) === 429 ? t('common.rate_limited') : t('common.load_failed');
}
