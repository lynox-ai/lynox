/**
 * Fetch an ICS feed over the engine's guarded egress path.
 *
 * Thin on purpose: it reuses `fetchWithValidatedRedirects` (per-hop host policy, DNS-pinned
 * connect, credential headers dropped on a cross-origin hop) and `readBodyLimited` rather than
 * opening a second, less-guarded way onto the network. The only thing it adds is a cap suited
 * to this payload.
 */
import { fetchWithValidatedRedirects, readBodyLimited } from '../../tools/builtin/http.js';
import type { ToolContext } from '../../core/tool-context.js';

/**
 * Response ceiling for a calendar feed.
 *
 * `http_request` defaults to 100 KB, which is right for an API response and wrong here: a
 * full-history export of a working calendar runs past it, and a truncated ICS is not "fewer
 * events" — it is a broken record mid-line, so the tail of the file is lost rather than the
 * tail of the list. 5 MB covers a busy multi-year calendar while still bounding a hostile or
 * misconfigured feed.
 */
export const MAX_ICS_BYTES = 5 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 20_000;

export interface FetchIcsResult {
  readonly ics: string;
  /** True when the cap cut the document short — the caller must not treat it as complete. */
  readonly truncated: boolean;
}

/**
 * GET an ICS document. Throws on a non-2xx or a body that is not iCalendar.
 *
 * The URL is a credential (its secrecy is the whole access control), so no error raised here
 * includes it — a thrown message travels into model context and the run history.
 */
export async function fetchIcsFeed(url: string, ctx?: ToolContext | undefined): Promise<FetchIcsResult> {
  const { response } = await fetchWithValidatedRedirects(
    url,
    {
      method: 'GET',
      headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    // `discovery`, not `full-control`: this is a read of a subscribed feed, the same shape as
    // fetching a page, and it should stay reachable under a `guarded` egress policy without
    // the operator having to allow-list a full-control target.
    'discovery',
    ctx,
  );

  if (!response.ok) {
    // Status only. A 404 here usually means the secret address was reset, and saying so is
    // useful; echoing the URL that produced it is not.
    throw new Error(`calendar feed responded ${String(response.status)}`);
  }

  const { text, truncated } = await readBodyLimited(response, MAX_ICS_BYTES);
  // A reset or wrong address commonly returns an HTML error page with a 200. Failing on the
  // content rather than the status keeps the operator from being told "0 appointments" when
  // the truth is "this link no longer works".
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('the response was not an iCalendar document — the feed address may have been reset');
  }
  return { ics: text, truncated };
}
