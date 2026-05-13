// === ICS-Feed adapter (Phase 1a: read-only, polled) ===
//
// Two layers:
//
//   1. `IcsFeedCalendarProvider`  — implements CalendarProvider#list() by
//      reading the `calendar_event_cache` table. NEVER hits the network.
//
//   2. `pollIcsFeed()` + `testIcsFeed()` — standalone functions that do the
//      actual network fetch with streaming byte-cap, ETag/Last-Modified
//      conditional requests, circuit-breaker bookkeeping. Invoked by
//      `watch.ts` (WorkerLoop TaskRecord) on schedule and by the
//      `/api/calendar/accounts/test` HTTP route for live-connection probes
//      (PRD §S15).
//
// PRD anchors:
//   • §S5 — 5MB streaming hard-cap (ignores Content-Length), per-tenant
//     bandwidth budget, max-accounts limit, circuit-breaker on 3 fails.
//   • §S14 — RRULE iteration-cap enforced in the parse phase. node-ical
//     internally uses rrule-temporal for expansion.
//   • §S15 — Google Workspace admins often disable the Secret-iCal URL →
//     test-connection must distinguish 404 (URL invalid / admin-blocked)
//     from 401/403 (token revoked).
//   • §Risk 7 — fetch-all + client-side filter (cache holds all events,
//     time window applied at read time).

import ical from 'node-ical';
import { wrap } from '../../../core/data-boundary.js';
import { CalendarError } from '../provider.js';
import { hasDangerousFreq, recurrenceEndedBefore } from './rrule-safety.js';
import { assertSafeUrl } from './ssrf-safe.js';
import type { CalendarStateDb } from '../state.js';
import type { CalendarAttendee, CalendarEvent, CalendarListOptions, CalendarProvider } from '../../../types/calendar.js';

const ICS_SOURCE = 'calendar:ics-feed';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — PRD §S5
const DEFAULT_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_FAIL_THRESHOLD = 3;
const CIRCUIT_BREAKER_PAUSE_MS = 60 * 60 * 1000; // 1 hour

// ── Provider class (cache-read only) ────────────────────────────────────────

export interface IcsFeedProviderInit {
  accountId: string;
  state: CalendarStateDb;
}

export class IcsFeedCalendarProvider implements CalendarProvider {
  readonly name = 'ics-feed' as const;
  readonly accountId: string;
  readonly authType = 'none' as const;

  private readonly state: CalendarStateDb;

  constructor(init: IcsFeedProviderInit) {
    this.accountId = init.accountId;
    this.state = init.state;
  }

  async list(time_min: string, time_max: string, _opts?: CalendarListOptions): Promise<ReadonlyArray<CalendarEvent>> {
    const minDate = new Date(time_min);
    const maxDate = new Date(time_max);
    if (Number.isNaN(minDate.getTime()) || Number.isNaN(maxDate.getTime())) {
      throw new CalendarError('malformed_event', `Invalid time_min/time_max: ${time_min} → ${time_max}`);
    }

    const cached = readCachedEvents(this.state, this.accountId);
    return cached.filter((ev) => overlapsWindow(ev, minDate, maxDate));
  }

  async close(): Promise<void> {
    // No long-lived resources — the state DB is shared and owned by the context.
  }
}

// ── Standalone poll + test ──────────────────────────────────────────────────

export interface PollResult {
  /** Cache rows written (created + updated). */
  events_written: number;
  bytes_read: number;
  /** True when the server responded 304 Not Modified — cache untouched. */
  not_modified: boolean;
}

/**
 * Fetch + parse + cache for a single ICS feed. Caller is responsible for
 * looking up the URL from Vault (`vault://calendar/{accountId}/ics_url`).
 *
 * Honors ETag + Last-Modified for conditional GETs. On parse-error or
 * non-2xx-non-304: increments the circuit-breaker counter; after 3 fails
 * sets `circuit_open_until = now + 1h`.
 */
export async function pollIcsFeed(
  state: CalendarStateDb,
  accountId: string,
  url: string,
  signal?: AbortSignal,
): Promise<PollResult> {
  const previous = readPrevState(state, accountId);

  // PRD §S3 — honour the circuit-breaker. If a prior failure tripped it,
  // skip the network round-trip until the cooldown passes. Throwing keeps
  // the watcher's onError path uniform (logged once per skipped tick).
  if (previous?.circuit_open_until) {
    const openUntil = new Date(previous.circuit_open_until);
    if (Number.isFinite(openUntil.getTime()) && openUntil > new Date()) {
      throw new CalendarError(
        'rate_limited',
        `ICS poll skipped: circuit-breaker open until ${previous.circuit_open_until} (3+ consecutive failures).`,
      );
    }
  }

  // PRD §S2 — SSRF guard before any network fetch. User-supplied ICS URLs
  // could target cloud-metadata, RFC1918, loopback. Counts circuit-breaker
  // failures so a misconfigured private URL doesn't burn quota on each poll.
  try {
    await assertSafeUrl(url, 'ICS feed url');
  } catch (err) {
    failWithCircuit(state, accountId);
    throw err;
  }

  const headers: Record<string, string> = { Accept: 'text/calendar, application/calendar+xml;q=0.9, */*;q=0.5' };
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.last_modified) headers['If-Modified-Since'] = previous.last_modified;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch (err) {
    failWithCircuit(state, accountId);
    throw asNetworkError(err, 'ICS feed fetch failed');
  }

  if (res.status === 304) {
    state.recordPollSuccess(accountId, previous?.etag ?? null, previous?.last_modified ?? null);
    return { events_written: 0, bytes_read: 0, not_modified: true };
  }
  if (res.status === 401 || res.status === 403) {
    failWithCircuit(state, accountId);
    throw new CalendarError('auth_failed', `ICS feed unauthorized (HTTP ${res.status})`);
  }
  if (res.status === 404) {
    failWithCircuit(state, accountId);
    // PRD §S15 — surface the admin-block hint to the user via publicMessage,
    // not just stderr. The hint is generic enough to be safe (no URL/host leak).
    const hint = 'ICS feed returned 404. The URL may be invalid, the token may have been revoked, or the calendar provider (e.g. Google Workspace) may have admin-disabled external sharing.';
    throw new CalendarError('not_found', hint, undefined, hint);
  }
  if (res.status === 429) {
    failWithCircuit(state, accountId);
    throw new CalendarError('rate_limited', `ICS feed rate-limited (HTTP ${res.status})`);
  }
  if (!res.ok) {
    failWithCircuit(state, accountId);
    throw new CalendarError('network', `ICS feed HTTP ${res.status}`);
  }

  // Streaming byte-cap (PRD §S5). Ignores Content-Length — server may lie.
  let body: string;
  let bytesRead: number;
  try {
    ({ body, bytesRead } = await readBodyCapped(res, MAX_BYTES));
  } catch (err) {
    failWithCircuit(state, accountId);
    throw asNetworkError(err, 'ICS feed body read failed');
  }

  // Parse + diff + cache.
  let parsed: ical.CalendarComponent[];
  try {
    parsed = Object.values(ical.parseICS(body)).filter((v): v is ical.CalendarComponent => v !== undefined);
  } catch (err) {
    failWithCircuit(state, accountId);
    throw new CalendarError('parse_error', `ICS feed parse failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }

  let written = 0;
  // Wrap upserts in a single SQLite transaction — without it each upsertEvent
  // becomes its own implicit transaction (one fsync per VEVENT). Real feeds
  // can carry hundreds of events; the loop went from O(N) fsyncs to 1.
  const db = state.internalGetDb();
  db.transaction(() => {
    for (const v of parsed) {
      if (v.type !== 'VEVENT') continue;
      // node-ical can yield VEVENT without UID for malformed feeds. Skip
      // those — they would otherwise hit the NOT NULL PK constraint and
      // abort the entire poll (PRD K5 hardening).
      if (typeof v.uid !== 'string' || v.uid === '') continue;
      state.upsertEvent(accountId, v.uid, null, JSON.stringify(serializeForCache(v, accountId)));
      written += 1;
    }
  })();

  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  state.recordPollSuccess(accountId, etag, lastModified);

  return { events_written: written, bytes_read: bytesRead, not_modified: false };
}

/**
 * Live-probe an ICS-feed URL without persisting anything. Used by
 * `POST /api/calendar/accounts/test` to surface 404/401/403 errors at
 * account-add time (PRD §S15). Reads at most the first 16 KB.
 */
export async function testIcsFeed(url: string, signal?: AbortSignal): Promise<void> {
  // PRD §S2 — SSRF guard. testIcsFeed is an UNAUTHENTICATED 10/min probe,
  // so an attacker could otherwise use it as a port-scanner against
  // 127.0.0.1, 169.254.169.254, or RFC1918 addresses on the same host.
  await assertSafeUrl(url, 'ICS feed url');

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch (err) {
    throw asNetworkError(err, 'ICS feed test fetch failed');
  }
  if (res.status === 401 || res.status === 403) {
    throw new CalendarError('auth_failed', `ICS feed unauthorized (HTTP ${res.status})`);
  }
  if (res.status === 404) {
    {
      const hint = 'ICS feed returned 404. Verify the Secret-iCal URL and that your provider allows external sharing.';
      throw new CalendarError('not_found', hint, undefined, hint);
    }
  }
  if (!res.ok) {
    throw new CalendarError('network', `ICS feed HTTP ${res.status}`);
  }
  // Quick parse-sanity on the first chunk — drop the connection after 16 KB.
  const { body } = await readBodyCapped(res, 16 * 1024);
  if (!body.includes('BEGIN:VCALENDAR')) {
    throw new CalendarError('parse_error', 'Response does not look like an iCalendar feed (no BEGIN:VCALENDAR marker).');
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

interface CachedEventPayload extends Omit<CalendarEvent, 'summary' | 'description' | 'location' | 'attendees' | 'organizer'> {
  summary_raw: string;
  description_raw?: string | undefined;
  location_raw?: string | undefined;
  attendees?: ReadonlyArray<{ email: string; name_raw?: string | undefined; rsvp?: CalendarAttendee['rsvp'] | undefined }> | undefined;
  organizer?: { email: string; name_raw?: string | undefined } | undefined;
}

function serializeForCache(v: ical.VEvent, accountId: string): CachedEventPayload {
  // Persist RAW values (PRD §S13). Wrap happens at read time.
  const payload: CachedEventPayload = {
    id: v.uid,
    uid: v.uid,
    summary_raw: pv(v.summary),
    start: toIso(v.start),
    end: toIso(v.end ?? v.start),
    source: { account_id: accountId, provider: 'ics-feed' },
  };
  const desc = pv(v.description);
  if (desc) payload.description_raw = desc;
  const loc = pv(v.location);
  if (loc) payload.location_raw = loc;
  if (v.datetype === 'date') payload.all_day = true;
  if (v.status) payload.status = mapStatus(pv(v.status));
  if (v.rrule) payload.recurrence = [v.rrule.toString()];

  const attendees = extractRawAttendees(v.attendee);
  if (attendees.length > 0) payload.attendees = attendees;

  const organizer = extractRawOrganizer(v.organizer);
  if (organizer) payload.organizer = organizer;

  return payload;
}

function rehydrateFromCache(payload: CachedEventPayload): CalendarEvent {
  const event: CalendarEvent = {
    id: payload.id,
    uid: payload.uid,
    summary: wrap(payload.summary_raw, ICS_SOURCE),
    start: payload.start,
    end: payload.end,
    source: payload.source,
  };
  if (payload.description_raw) event.description = wrap(payload.description_raw, ICS_SOURCE);
  if (payload.location_raw) event.location = wrap(payload.location_raw, ICS_SOURCE);
  if (payload.all_day) event.all_day = true;
  if (payload.status) event.status = payload.status;
  if (payload.recurrence) event.recurrence = payload.recurrence;
  if (payload.attendees) {
    event.attendees = payload.attendees.map((a) => {
      const attendee: CalendarAttendee = { email: a.email };
      if (a.name_raw) attendee.name = wrap(a.name_raw, ICS_SOURCE);
      if (a.rsvp) attendee.rsvp = a.rsvp;
      return attendee;
    });
  }
  if (payload.organizer) {
    event.organizer = payload.organizer.name_raw
      ? { email: payload.organizer.email, name: wrap(payload.organizer.name_raw, ICS_SOURCE) }
      : { email: payload.organizer.email };
  }
  return event;
}

function readCachedEvents(state: CalendarStateDb, accountId: string): CalendarEvent[] {
  const rows = readCacheRows(state, accountId);
  const out: CalendarEvent[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as CachedEventPayload;
      out.push(rehydrateFromCache(payload));
    } catch {
      // Skip corrupted cache rows; next poll will replace them.
    }
  }
  return out;
}

// CalendarStateDb does not expose a "list cached events" method publicly,
// so we reach into the underlying DB via a typed inspector. Keeping this
// here avoids leaking SQLite types into the public state API.
interface CacheRow { event_uid: string; payload: string }
function readCacheRows(state: CalendarStateDb, accountId: string): CacheRow[] {
  return state.internalGetDb()
    .prepare('SELECT event_uid, payload FROM calendar_event_cache WHERE account_id = ?')
    .all(accountId) as CacheRow[];
}

interface PollPrevState { etag: string | null; last_modified: string | null; circuit_open_until: string | null }
function readPrevState(state: CalendarStateDb, accountId: string): PollPrevState | null {
  const row = state.internalGetDb()
    .prepare('SELECT etag, last_modified, circuit_open_until FROM calendar_poll_state WHERE account_id = ?')
    .get(accountId) as PollPrevState | undefined;
  return row ?? null;
}

function failWithCircuit(state: CalendarStateDb, accountId: string): void {
  state.recordPollFailure(accountId, { threshold: CIRCUIT_BREAKER_FAIL_THRESHOLD, pauseMs: CIRCUIT_BREAKER_PAUSE_MS });
}

async function readBodyCapped(res: Response, capBytes: number): Promise<{ body: string; bytesRead: number }> {
  if (!res.body) {
    const text = await res.text();
    if (text.length > capBytes) throw new CalendarError('quota_exceeded', `ICS body exceeds ${capBytes} bytes`);
    return { body: text, bytesRead: text.length };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > capBytes) {
        await reader.cancel();
        throw new CalendarError('quota_exceeded', `ICS body exceeds ${capBytes} bytes (read ${bytesRead})`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return { body: chunks.join(''), bytesRead };
}

function overlapsWindow(ev: CalendarEvent, minDate: Date, maxDate: Date): boolean {
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  if (ev.recurrence && ev.recurrence.length > 0) {
    // PRD §K7 — drop master rows whose RRULE ended before the window starts.
    // Catches the common case where an ICS feed still ships a recurring
    // event with UNTIL=<past>.
    if (recurrenceEndedBefore(ev.recurrence, minDate)) return false;
    // PRD §S4 — sub-hourly recurrences are not expanded (CPU-DoS hazard).
    // Show the master row so the agent at least knows the event exists.
    if (ev.recurrence.some(hasDangerousFreq)) return start <= maxDate;
    // Phase 2: store expanded instances in the cache and filter on real
    // occurrences. For now: best-effort upper-bound by master start.
    return start <= maxDate;
  }
  return start <= maxDate && end >= minDate;
}

interface IcalAttendeeLike { val?: string; params?: { CN?: string; PARTSTAT?: string } }

function extractRawAttendees(raw: unknown): ReadonlyArray<{ email: string; name_raw?: string | undefined; rsvp?: CalendarAttendee['rsvp'] | undefined }> {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: Array<{ email: string; name_raw?: string | undefined; rsvp?: CalendarAttendee['rsvp'] | undefined }> = [];
  for (const item of list) {
    const a = item as IcalAttendeeLike;
    const val = typeof a.val === 'string' ? a.val : '';
    const email = val.toLowerCase().startsWith('mailto:') ? val.slice(7) : val;
    if (email === '') continue;
    const attendee: { email: string; name_raw?: string | undefined; rsvp?: CalendarAttendee['rsvp'] | undefined } = { email };
    if (a.params?.CN) attendee.name_raw = a.params.CN;
    if (a.params?.PARTSTAT) attendee.rsvp = mapPartstat(a.params.PARTSTAT);
    out.push(attendee);
  }
  return out;
}

function extractRawOrganizer(raw: unknown): { email: string; name_raw?: string | undefined } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const a = raw as IcalAttendeeLike;
  const val = typeof a.val === 'string' ? a.val : '';
  const email = val.toLowerCase().startsWith('mailto:') ? val.slice(7) : val;
  if (email === '') return undefined;
  return a.params?.CN ? { email, name_raw: a.params.CN } : { email };
}

function mapStatus(s: string): 'confirmed' | 'tentative' | 'cancelled' | undefined {
  const lower = s.toLowerCase();
  if (lower === 'confirmed' || lower === 'tentative' || lower === 'cancelled') return lower;
  return undefined;
}

function mapPartstat(s: string): CalendarAttendee['rsvp'] {
  switch (s.toUpperCase()) {
    case 'ACCEPTED': return 'accepted';
    case 'DECLINED': return 'declined';
    case 'TENTATIVE': return 'tentative';
    case 'NEEDS-ACTION': return 'needs-action';
    default: return undefined;
  }
}

function toIso(d: Date | string | undefined): string {
  if (d === undefined) return new Date(0).toISOString();
  return typeof d === 'string' ? d : d.toISOString();
}

/** Coerce node-ical's `ParameterValue` (string OR `{val, params}`) into a plain string. */
function pv(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'val' in value) {
    const v = (value as { val: unknown }).val;
    return typeof v === 'string' ? v : '';
  }
  return '';
}

function asNetworkError(err: unknown, fallbackMessage: string): CalendarError {
  if (err instanceof CalendarError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CalendarError('network', `${fallbackMessage}: ${message}`, err);
}
