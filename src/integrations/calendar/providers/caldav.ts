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

import ical from 'node-ical';
import { DAVClient } from 'tsdav';
import { wrap } from '../../../core/data-boundary.js';
import { CalendarError } from '../provider.js';
import { hasDangerousFreq } from './rrule-safety.js';
import type {
  CalendarAttendee,
  CalendarEvent,
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
