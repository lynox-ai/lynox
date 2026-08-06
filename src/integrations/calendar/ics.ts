/**
 * Read a calendar from an iCalendar (ICS) feed.
 *
 * WHY THIS EXISTS, and why it is not the Google Calendar API. Google Calendar's API — and its
 * CalDAV endpoint, which explicitly refuses Basic auth — require OAuth. That means a Google
 * Cloud project per operator, or one shipped client id whose *sensitive* Calendar scope caps
 * an unverified app at 100 users for the lifetime of the project, unresettable. For READING a
 * calendar none of that is necessary: Google, Outlook and Apple all publish a private ICS URL
 * whose secrecy IS the credential. So does most booking software. One code path, every
 * calendar, no consent screen.
 *
 * The URL is therefore a SECRET, and is handled as one: it lives in the vault and is resolved
 * inside the tool, never passed as a parameter. A URL the model can name is a URL that lands
 * in the run history.
 *
 * Recurrence is expanded here rather than handed to the model. RFC 5545 recurrence is where a
 * plausible-looking implementation quietly gets someone's calendar wrong — RRULE against a
 * timezone, minus EXDATE, plus RECURRENCE-ID overrides. A model reading raw ICS will answer
 * confidently and sometimes wrongly, which is worse than not answering.
 */
import ICAL from 'ical.js';

/** One occurrence, already resolved to an absolute instant. */
export interface CalendarEvent {
  /** Event title. Empty string when the feed omits SUMMARY (valid, and common for busy-blocks). */
  readonly summary: string;
  /** Start as an ISO-8601 instant (UTC). */
  readonly start: string;
  /** End as an ISO-8601 instant (UTC). */
  readonly end: string;
  /** True for a DATE-valued (all-day) event — the times carry no meaningful clock. */
  readonly allDay: boolean;
  readonly location?: string | undefined;
  /** True when this occurrence came from a recurrence rule rather than a standalone event. */
  readonly recurring: boolean;
}

export interface ParseIcsOptions {
  /** Window start (inclusive). */
  readonly from: Date;
  /** Window end (exclusive). */
  readonly to: Date;
  /** Hard cap on returned occurrences. Default {@link DEFAULT_MAX_EVENTS}. */
  readonly maxEvents?: number | undefined;
}

export interface ParseIcsResult {
  readonly events: CalendarEvent[];
  /** True when the cap cut the list short — the caller should say so rather than imply completeness. */
  readonly truncated: boolean;
  /** Components that could not be read. Reported, not thrown: one broken VEVENT in a year of
   *  calendar should not lose the other 300. */
  readonly skipped: number;
}

/** A calendar window is for reading, not for bulk export. */
export const DEFAULT_MAX_EVENTS = 200;

/**
 * Per-series iteration ceiling.
 *
 * A recurrence iterator walks occurrences one at a time from DTSTART, so a rule that started
 * years ago costs one step per interval before it reaches the window — and `FREQ=SECONDLY`
 * with no UNTIL is a valid rule that never terminates. The window bound alone does not save
 * us: it stops the loop only once the iterator ARRIVES there. This does.
 */
const MAX_ITERATIONS_PER_SERIES = 10_000;

/**
 * Parse an ICS document and return the occurrences that fall inside a window.
 *
 * Pure: no network, no clock beyond the caller's window. Everything hard about this format —
 * recurrence, exceptions, timezones — is resolved here so the caller receives plain instants.
 */
export function parseIcsEvents(ics: string, opts: ParseIcsOptions): ParseIcsResult {
  const max = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const comp = new ICAL.Component(ICAL.parse(ics));

  // No VTIMEZONE registration here, deliberately. ical.js ships with no timezones registered
  // — a size trade-off by its authors, with `ical.timezones.js` as the add-on — but it
  // resolves a `TZID` against the ENCLOSING VCALENDAR, and a feed that uses a zone is required
  // to define it. So a self-contained feed needs neither the add-on nor a registration pass.
  //
  // Verified by mutation rather than assumed: removing an explicit registration loop changed
  // nothing, under a Europe/Zurich process timezone AND under UTC. Both runs were needed —
  // the first alone would have proved only that the developer's laptop sits in the same zone
  // as the test fixture.

  const from = ICAL.Time.fromJSDate(opts.from, true);
  const to = ICAL.Time.fromJSDate(opts.to, true);
  const events: CalendarEvent[] = [];
  let skipped = 0;
  let truncated = false;

  // TWO passes, because a moved instance of a series is its OWN `VEVENT` in the file: it
  // shares the master's UID and carries a RECURRENCE-ID naming the occurrence it replaces.
  // Walking the components naively yields the moved appointment twice — once from the rule,
  // once as a standalone event — which is how a calendar starts claiming meetings that do not
  // exist. So: relate every exception to its master first, and let `getOccurrenceDetails`
  // substitute it during expansion.
  const masters: ICAL.Event[] = [];
  const exceptions: ICAL.Event[] = [];
  for (const ve of comp.getAllSubcomponents('vevent')) {
    try {
      const ev = new ICAL.Event(ve);
      (ev.isRecurrenceException() ? exceptions : masters).push(ev);
    } catch {
      skipped++;
    }
  }
  // Only the ORPHANS need handling. ical.js relates an exception to its master itself when
  // both sit in the same VCALENDAR — verified by mutation: dropping an explicit
  // `relateException` call changed nothing, and the moved instance still reported its new
  // time. What IS load-bearing is the separation above: an exception is its own VEVENT, so a
  // naive walk emits the moved appointment twice, once from the rule and once standalone.
  //
  // An exception whose master is missing — a truncated export, or a series that ended before
  // the window — is still a real appointment. Dropping it would hide a meeting.
  const orphanExceptions = exceptions.filter(
    ex => !masters.some(m => m.uid === ex.uid && m.isRecurring()),
  );

  for (const ev of [...masters, ...orphanExceptions]) {
    if (events.length >= max) { truncated = true; break; }
    try {
      // A cancelled occurrence is still IN the feed; showing it as an appointment would be a
      // lie in the one direction that costs the operator a wasted trip.
      if (String(ev.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') continue;

      if (!ev.isRecurring()) {
        if (withinWindow(ev.startDate, from, to)) {
          events.push(toEvent(ev, ev.startDate, ev.endDate, false));
        }
        continue;
      }

      const it = ev.iterator();
      let steps = 0;
      for (;;) {
        if (steps++ >= MAX_ITERATIONS_PER_SERIES) { truncated = true; break; }
        const next = it.next();
        if (!next) break;                 // the rule ended (UNTIL / COUNT)
        if (next.compare(to) >= 0) break; // past the window — occurrences are ascending
        if (next.compare(from) < 0) continue;
        if (events.length >= max) { truncated = true; break; }
        // `getOccurrenceDetails` applies RECURRENCE-ID overrides: a single moved or edited
        // instance of a series carries its own time and summary, and reporting the rule's
        // version instead would put the operator in the wrong place.
        const details = ev.getOccurrenceDetails(next);
        events.push(toEvent(ev, details.startDate, details.endDate, true, details.item.summary));
      }
    } catch {
      skipped++;
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return { events, truncated, skipped };
}

function withinWindow(start: ICAL.Time, from: ICAL.Time, to: ICAL.Time): boolean {
  return start.compare(from) >= 0 && start.compare(to) < 0;
}

function toEvent(
  ev: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time,
  recurring: boolean,
  summaryOverride?: string | undefined,
): CalendarEvent {
  const location = ev.location ?? '';
  return {
    summary: summaryOverride ?? ev.summary ?? '',
    start: start.toJSDate().toISOString(),
    end: end.toJSDate().toISOString(),
    allDay: start.isDate === true,
    ...(location ? { location } : {}),
    recurring,
  };
}
