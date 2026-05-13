// === CalDAV adapter (Phase 1a: list-only) ===
//
// Backed by `tsdav` (PRD §Phase 0). Login + discovery + fetchCalendarObjects
// happen lazily on first `list()` call, then cached on the instance.
//
// IMPORTANT design choices anchored in the PRD:
//
//   • Fetch-all + client-side filter — iCloud silently ignores the CalDAV
//     `<C:time-range>` REPORT filter (PRD §Risk 7, confirmed Phase 0.5
//     2026-05-13). To stay provider-agnostic the adapter never passes the
//     timeRange option to tsdav. Phase 2 may add per-provider opt-in once
//     Fastmail + Nextcloud behavior is verified.
//
//   • Untrusted-wrap at adapter exit — every user-string returned to the
//     engine (summary, description, location, attendee names) is passed
//     through `wrap()` (PRD §S2). The branded `Wrapped<string>` type makes
//     the requirement compile-time enforced.
//
//   • No watch/push — CalDAV has no native push. Polling for ICS lives in
//     `watch.ts`; CalDAV reads happen on tool call (Phase 1a) and on user-
//     initiated refresh.

import { randomUUID } from 'node:crypto';
import ical from 'node-ical';
import { DAVClient } from 'tsdav';
import { wrap } from '../../../core/data-boundary.js';
import { CalendarError } from '../provider.js';
import { hasDangerousFreq } from './rrule-safety.js';
import type {
  CalendarAttendee,
  CalendarEvent,
  CalendarEventInput,
  CalendarListOptions,
  CalendarProvider,
} from '../../../types/calendar.js';

const TSDAV_SOURCE = 'calendar:caldav';

export interface CalDavCredentials {
  username: string;
  /** App-specific password (iCloud / Fastmail / Yahoo / Zoho) or regular password (mailbox.org / Posteo / Nextcloud). */
  password: string;
}

export interface CalDavProviderInit {
  accountId: string;
  serverUrl: string;
  credentials: CalDavCredentials;
  /** Pre-verified presets (mailbox.org, Posteo) skip RFC 6764 well-known discovery. */
  skipDiscovery: boolean;
  /** Optional collection-URL whitelist from `CalendarAccount.enabled_calendars`. Empty/undefined = all calendars. */
  enabledCalendars?: ReadonlyArray<string> | undefined;
}

export class CalDavCalendarProvider implements CalendarProvider {
  readonly name = 'caldav' as const;
  readonly accountId: string;
  readonly authType = 'basic' as const;

  private readonly client: DAVClient;
  private readonly enabledCalendars: ReadonlySet<string> | null;
  private loggedIn = false;

  constructor(init: CalDavProviderInit) {
    this.accountId = init.accountId;
    this.client = new DAVClient({
      serverUrl: init.serverUrl,
      credentials: { username: init.credentials.username, password: init.credentials.password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
    this.enabledCalendars = init.enabledCalendars && init.enabledCalendars.length > 0
      ? new Set(init.enabledCalendars)
      : null;
    // tsdav handles RFC 6764 discovery internally. `skipDiscovery` is parsed
    // by the caller for future use (pre-populate principal/home-set URLs to
    // skip the PROPFIND chain) but not consumed here yet.
  }

  async list(time_min: string, time_max: string, opts?: CalendarListOptions): Promise<ReadonlyArray<CalendarEvent>> {
    await this.ensureLoggedIn();

    const minDate = new Date(time_min);
    const maxDate = new Date(time_max);
    if (Number.isNaN(minDate.getTime()) || Number.isNaN(maxDate.getTime())) {
      throw new CalendarError('malformed_event', `Invalid time_min/time_max: ${time_min} → ${time_max}`);
    }

    let calendars;
    try {
      calendars = await this.client.fetchCalendars();
    } catch (err) {
      throw asCalendarError(err, 'auth_failed', 'fetchCalendars failed');
    }

    const veventCalendars = calendars.filter((c) => {
      const components = c.components;
      const hasVevent = Array.isArray(components) && components.includes('VEVENT');
      if (!hasVevent) return false;
      if (this.enabledCalendars === null) return true;
      // Resolve filter by collection URL (server-stable) or display name (user-friendly fallback).
      const url = typeof c.url === 'string' ? c.url : '';
      const displayName = typeof c.displayName === 'string' ? c.displayName : '';
      return this.enabledCalendars.has(url) || (displayName !== '' && this.enabledCalendars.has(displayName));
    });

    // Apply explicit per-call calendar filter on top of account-level filter.
    const effectiveCalendars = opts?.calendars && opts.calendars.length > 0
      ? veventCalendars.filter((c) => {
          const url = typeof c.url === 'string' ? c.url : '';
          return opts.calendars!.includes(url);
        })
      : veventCalendars;

    const events: CalendarEvent[] = [];

    for (const cal of effectiveCalendars) {
      let objects;
      try {
        // Risk 7: NO timeRange — fetch all, filter client-side below.
        objects = await this.client.fetchCalendarObjects({ calendar: cal });
      } catch (err) {
        throw asCalendarError(err, 'network', `fetchCalendarObjects failed for ${cal.displayName ?? cal.url}`);
      }

      for (const obj of objects) {
        const raw = typeof obj.data === 'string' ? obj.data : '';
        if (!raw.startsWith('BEGIN:VCALENDAR')) continue;

        let parsed;
        try {
          parsed = ical.parseICS(raw);
        } catch {
          // Single malformed event must not poison the entire fetch.
          continue;
        }

        for (const v of Object.values(parsed)) {
          if (v === undefined || v.type !== 'VEVENT') continue;
          // VEVENT without UID is malformed iCalendar — skip rather than emit
          // an event the agent cannot stably reference (PRD K5 hardening).
          if (typeof v.uid !== 'string' || v.uid === '') continue;
          if (!occursInWindow(v, minDate, maxDate)) continue;
          events.push(toCalendarEvent(v, this.accountId, obj.etag));
        }
      }
    }

    return events;
  }

  async create(event: CalendarEventInput): Promise<CalendarEvent> {
    await this.ensureLoggedIn();

    let calendars;
    try {
      calendars = await this.client.fetchCalendars();
    } catch (err) {
      throw asCalendarError(err, 'auth_failed', 'fetchCalendars failed during create');
    }

    const target = pickWritableCalendar(calendars, this.enabledCalendars);
    if (!target) {
      throw new CalendarError('not_found', 'No writable VEVENT calendar found on this account');
    }

    const uid = `${randomUUID()}@lynox.ai`;
    const filename = `${uid}.ics`;
    const iCalString = buildVCalendar(uid, event);

    let res: Response;
    try {
      res = await this.client.createCalendarObject({ calendar: target, iCalString, filename });
    } catch (err) {
      throw asCalendarError(err, 'network', 'CalDAV create failed');
    }
    if (!res.ok) {
      const code = res.status === 401 ? 'auth_failed'
        : res.status === 412 ? 'conflict_412'
        : res.status === 429 ? 'rate_limited'
        : 'network';
      throw new CalendarError(code, `CalDAV create HTTP ${res.status}`);
    }

    const etagHeader = res.headers.get('etag');
    // Build the response from the input + the new uid. Re-fetching just to
    // get the server's normalized representation isn't worth a round-trip
    // for Phase 1b; the caller already has every field it sent.
    const created: CalendarEvent = {
      id: uid,
      uid,
      summary: wrap(event.summary, TSDAV_SOURCE),
      start: event.start,
      end: event.end,
      source: {
        account_id: this.accountId,
        provider: 'caldav',
        ...(etagHeader !== null ? { etag: etagHeader } : {}),
      },
    };
    if (event.description !== undefined) created.description = wrap(event.description, TSDAV_SOURCE);
    if (event.location !== undefined) created.location = wrap(event.location, TSDAV_SOURCE);
    if (event.all_day !== undefined) created.all_day = event.all_day;
    if (event.recurrence !== undefined) created.recurrence = event.recurrence;
    if (event.status !== undefined) created.status = event.status;
    if (event.attendees !== undefined) {
      created.attendees = event.attendees.map((a) => {
        const att: CalendarAttendee = { email: a.email };
        if (a.name !== undefined) att.name = wrap(a.name, TSDAV_SOURCE);
        return att;
      });
    }
    if (event.organizer !== undefined) {
      created.organizer = event.organizer.name !== undefined
        ? { email: event.organizer.email, name: wrap(event.organizer.name, TSDAV_SOURCE) }
        : { email: event.organizer.email };
    }
    return created;
  }

  async close(): Promise<void> {
    // tsdav does not expose an explicit close — TCP teardown happens via fetch lifecycle.
    this.loggedIn = false;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn) return;
    try {
      await this.client.login();
      this.loggedIn = true;
    } catch (err) {
      throw asCalendarError(err, 'auth_failed', 'CalDAV login failed');
    }
  }
}

// ── ICS-event → CalendarEvent mapping ──────────────────────────────────────

interface IcalAttendeeLike {
  val?: string;
  params?: { CN?: string; PARTSTAT?: string };
}

function toCalendarEvent(v: ical.VEvent, accountId: string, etag: string | undefined): CalendarEvent {
  const summary = wrap(pv(v.summary), TSDAV_SOURCE);
  const event: CalendarEvent = {
    id: v.uid,
    uid: v.uid,
    summary,
    start: toIso(v.start),
    end: toIso(v.end ?? v.start),
    source: {
      account_id: accountId,
      provider: 'caldav',
      ...(etag !== undefined ? { etag } : {}),
    },
  };
  const desc = pv(v.description);
  if (desc) event.description = wrap(desc, TSDAV_SOURCE);
  const loc = pv(v.location);
  if (loc) event.location = wrap(loc, TSDAV_SOURCE);
  if (v.datetype === 'date') event.all_day = true;
  if (v.status) event.status = mapStatus(pv(v.status));
  if (v.rrule) event.recurrence = [v.rrule.toString()];

  const attendees = extractAttendees(v.attendee);
  if (attendees.length > 0) event.attendees = attendees;

  const organizer = extractOrganizer(v.organizer);
  if (organizer) event.organizer = organizer;

  return event;
}

function extractAttendees(raw: unknown): CalendarAttendee[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: CalendarAttendee[] = [];
  for (const item of list) {
    const a = item as IcalAttendeeLike;
    const val = typeof a.val === 'string' ? a.val : '';
    const email = val.toLowerCase().startsWith('mailto:') ? val.slice(7) : val;
    if (email === '') continue;
    const attendee: CalendarAttendee = { email };
    if (a.params?.CN) attendee.name = wrap(a.params.CN, TSDAV_SOURCE);
    if (a.params?.PARTSTAT) attendee.rsvp = mapPartstat(a.params.PARTSTAT);
    out.push(attendee);
  }
  return out;
}

function extractOrganizer(raw: unknown): { email: string; name?: import('../../../types/calendar.js').Wrapped<string> | undefined } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const a = raw as IcalAttendeeLike;
  const val = typeof a.val === 'string' ? a.val : '';
  const email = val.toLowerCase().startsWith('mailto:') ? val.slice(7) : val;
  if (email === '') return undefined;
  return a.params?.CN
    ? { email, name: wrap(a.params.CN, TSDAV_SOURCE) }
    : { email };
}

function mapStatus(s: string): 'confirmed' | 'tentative' | 'cancelled' | undefined {
  const lower = s.toLowerCase();
  if (lower === 'confirmed' || lower === 'tentative' || lower === 'cancelled') return lower;
  return undefined;
}

function mapPartstat(s: string): 'accepted' | 'declined' | 'tentative' | 'needs-action' | undefined {
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

function occursInWindow(v: ical.VEvent, minDate: Date, maxDate: Date): boolean {
  // Non-recurring: simple overlap.
  if (!v.rrule) {
    const start = v.start instanceof Date ? v.start : new Date(v.start);
    const end = v.end instanceof Date ? v.end : (v.end ? new Date(v.end) : start);
    return start <= maxDate && end >= minDate;
  }
  // PRD §S4/§S14 — sub-hourly recurrences (FREQ=SECONDLY/MINUTELY) over a
  // 90-day window can enumerate millions of instances and stall the event
  // loop. Assume "may occur" rather than risk DoS via .between(); the
  // resulting overload is bounded by per-account event counts at the agent layer.
  if (hasDangerousFreq(v.rrule.toString())) return true;
  try {
    const occurrences = v.rrule.between(minDate, maxDate, true);
    return occurrences.length > 0;
  } catch {
    // RRULE parse error → include defensively; the engine will still see the event.
    return true;
  }
}

// ── Create-path helpers ─────────────────────────────────────────────────────

type DAVCalendarLike = Awaited<ReturnType<DAVClient['fetchCalendars']>>[number];

function pickWritableCalendar(
  calendars: ReadonlyArray<DAVCalendarLike>,
  enabledFilter: ReadonlySet<string> | null,
): DAVCalendarLike | null {
  const vevent = calendars.filter((c) => Array.isArray(c.components) && c.components.includes('VEVENT'));
  if (vevent.length === 0) return null;
  if (enabledFilter === null) return vevent[0] ?? null;
  const match = vevent.find((c) => {
    const url = typeof c.url === 'string' ? c.url : '';
    const displayName = typeof c.displayName === 'string' ? c.displayName : '';
    return enabledFilter.has(url) || (displayName !== '' && enabledFilter.has(displayName));
  });
  return match ?? vevent[0] ?? null;
}

/**
 * Build a minimal RFC 5545 VCALENDAR document for a single VEVENT. CR/LF
 * line endings are required (RFC 5545 §3.1); some CalDAV servers reject
 * plain `\n`-separated payloads. Exported for direct unit testing.
 */
export function buildVCalendar(uid: string, event: CalendarEventInput): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//lynox//lynox 1.0//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcalDateTime(new Date().toISOString(), false)}`,
    `DTSTART${event.all_day ? ';VALUE=DATE' : ''}:${formatIcalDateTime(event.start, event.all_day === true)}`,
    `DTEND${event.all_day ? ';VALUE=DATE' : ''}:${formatIcalDateTime(event.end, event.all_day === true)}`,
    `SUMMARY:${escapeIcalText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcalText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcalText(event.location)}`);
  if (event.status) lines.push(`STATUS:${event.status.toUpperCase()}`);
  if (event.organizer?.email) {
    const cn = event.organizer.name ? `;CN=${escapeIcalText(event.organizer.name)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${event.organizer.email}`);
  }
  if (event.attendees) {
    for (const a of event.attendees) {
      const cn = a.name ? `;CN=${escapeIcalText(a.name)}` : '';
      lines.push(`ATTENDEE;RSVP=TRUE${cn}:mailto:${a.email}`);
    }
  }
  if (event.recurrence) {
    for (const r of event.recurrence) lines.push(`RRULE:${r}`);
  }
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/**
 * RFC 5545 §3.3.11 TEXT escaping plus defensive control-char + line-separator
 * stripping. Bare `\r`, NUL, and Unicode line-separators (U+2028/U+2029/U+0085)
 * can survive a naive newline-only escape and let an attacker break line
 * folding on stricter CalDAV parsers — a smuggling vector for forged VEVENT
 * blocks. We normalize all of them to a safe `\n` literal escape first, then
 * apply the standard TEXT escapes.
 */
export function escapeIcalText(value: string): string {
  return value
    // 1. Strip ASCII C0 control chars EXCEPT TAB (\x09) — these have no place in iCal TEXT.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // 2. Normalize Unicode line-separators (NEL U+0085, LS U+2028, PS U+2029)
    //    to LF before line-collapse. NOTE: U+2028 and U+2029 are ECMAScript
    //    line-terminators inside a regex literal, so we must use escape
    //    sequences here, not the raw characters.
    .replace(/[\u0085\u2028\u2029]/g, '\n')
    // 3. Escape backslash FIRST so the subsequent replacements don't double-escape themselves.
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    // 4. Collapse all newlines (CR, LF, CRLF) into the literal escape sequence.
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** ISO 8601 → RFC 5545 DATE-TIME (UTC) or DATE format. */
function formatIcalDateTime(iso: string, dateOnly: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new CalendarError('malformed_event', `Invalid date in create input: ${iso}`);
  }
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  if (dateOnly) return `${y}${mo}${da}`;
  return `${y}${mo}${da}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function asCalendarError(err: unknown, defaultCode: import('../../../types/calendar.js').CalendarErrorCode, fallbackMessage: string): CalendarError {
  if (err instanceof CalendarError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Cheap heuristic: tsdav surfaces HTTP status in the message string.
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized')) return new CalendarError('auth_failed', message, err);
  if (lower.includes('429') || lower.includes('too many')) return new CalendarError('rate_limited', message, err);
  if (lower.includes('404') || lower.includes('not found')) return new CalendarError('not_found', message, err);
  return new CalendarError(defaultCode, `${fallbackMessage}: ${message}`, err);
}
