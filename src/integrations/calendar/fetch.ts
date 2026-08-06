/**
 * Fetch an ICS feed over the engine's guarded egress path.
 *
 * Thin on purpose: it reuses `fetchWithValidatedRedirects` (per-hop host policy, DNS-pinned
 * connect, credential headers dropped on a cross-origin hop) and `readBodyLimited` rather than
 * opening a second, less-guarded way onto the network. What it adds is a cap suited to this
 * payload, a repair pass so that cap degrades instead of failing, and a narrow error vocabulary.
 */
import { fetchWithValidatedRedirects, readBodyLimited } from '../../tools/builtin/http.js';
import type { ToolContext } from '../../core/tool-context.js';

/**
 * Wire-byte ceiling for a calendar feed.
 *
 * `http_request` defaults to 100 KB, which is right for an API response and wrong here: a
 * full-history export of a working calendar runs past it. 5 MB covers a busy multi-year
 * calendar.
 *
 * Be precise about what this bounds and what it does not: it bounds BYTES OFF THE WIRE. It does
 * not bound the cost of parsing them — `ICAL.parse` is synchronous and allocates a multiple of
 * the input — and it does not bound recurrence expansion at all, since the most expensive
 * possible document is a small one (see `MAX_TOTAL_ITERATIONS` in `ics.ts`). This is one of
 * three limits, not the limit.
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
 * EVERY error out of here is one of this function's own messages. That is deliberate and it is
 * not tidiness: the URL is a credential, the layers below raise errors carrying the host they
 * were given, and a thrown message travels into model context and the run history. Translating
 * at this boundary means the caller cannot leak by forgetting to.
 */
export async function fetchIcsFeed(url: string, ctx?: ToolContext | undefined): Promise<FetchIcsResult> {
  let response: Response;
  try {
    ({ response } = await fetchWithValidatedRedirects(
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
    ));
  } catch {
    // Network failure, timeout, or a host the egress policy refused. The distinction matters to
    // an operator reading logs and not to the model, which needs exactly one fact: the calendar
    // could not be reached, so "nothing scheduled" is not a safe conclusion.
    throw new Error('the calendar feed could not be reached');
  }

  if (!response.ok) {
    // Status only. A 404 here usually means the secret address was reset, and saying so is
    // useful; echoing the URL that produced it is not.
    throw new Error(`calendar feed responded ${String(response.status)}`);
  }

  let text: string;
  let truncated: boolean;
  try {
    ({ text, truncated } = await readBodyLimited(response, MAX_ICS_BYTES));
  } catch {
    // Reading the body is a second chance to fail — a socket dropped mid-stream, a decode
    // error — and it sits after the headers arrived, so leaving it outside the guard made the
    // "every error is one of ours" claim above false for exactly the errors nobody tests.
    throw new Error('the calendar feed could not be read');
  }
  // A reset or wrong address commonly returns an HTML error page with a 200. Failing on the
  // content rather than the status keeps the operator from being told "0 appointments" when
  // the truth is "this link no longer works".
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('the response was not an iCalendar document — the feed address may have been reset');
  }
  return { ics: truncated ? repairTruncated(text) : text, truncated };
}

/**
 * Make a body that was cut mid-line parseable again.
 *
 * Without this the cap is not a cap but a cliff: a document cut at 5 MB ends inside a property,
 * `ICAL.parse` throws on the partial line, and the operator is told the calendar is unreadable
 * rather than being given the 5 MB that arrived. Dropping back to the last complete VEVENT and
 * closing the calendar turns the ceiling into what it was meant to be — fewer appointments,
 * still true ones.
 */
function repairTruncated(text: string): string {
  // Anchored to a line start, for the same reason the component cap is: a plain search finds
  // `END:VEVENT` inside a SUMMARY or DESCRIPTION, and cutting there leaves the event that
  // contains it unterminated — reproducing precisely the parse failure this function exists to
  // prevent. RFC 5545 folds continuation lines with a leading space, so a payload can never
  // occupy column zero.
  const lastComplete = text.lastIndexOf('\nEND:VEVENT');
  if (lastComplete < 0) return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
  return `${text.slice(0, lastComplete + '\nEND:VEVENT'.length)}\r\nEND:VCALENDAR\r\n`;
}
