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
 *
 * TIME IS KEPT AS THE FEED STATES IT, and this is the single most important decision in the
 * file. An earlier version normalised everything to a UTC instant, which is correct for a
 * timestamp and WRONG for a calendar: an all-day event on the 14th became 2026-08-13T22:00Z in
 * a Europe/Zurich process and got reported to the operator as the 13th. A calendar entry is
 * not an instant — it is a wall time plus, sometimes, a zone. That distinction survives to the
 * caller here, and {@link CalendarEvent.sortKey} carries the absolute instant separately for
 * the one thing it is good for: ordering.
 */
import ICAL from 'ical.js';

/** One occurrence of an appointment. */
export interface CalendarEvent {
  /** Event title. Empty string when the feed omits SUMMARY (valid, and common for busy-blocks). */
  readonly summary: string;
  /**
   * Start as the feed states it: `YYYY-MM-DD` for an all-day event, `YYYY-MM-DDTHH:MM:SS`
   * otherwise — with a trailing `Z` only when the feed itself said UTC. Read together with
   * {@link timezone}: `14:00` + `Europe/Zurich` is what the operator has written in their
   * calendar, and is what they should be told.
   */
  readonly start: string;
  /** End, same form as {@link start}. For an all-day event this is the EXCLUSIVE end date. */
  readonly end: string;
  /**
   * IANA zone the wall time belongs to, or undefined when the feed gave none. Undefined means
   * RFC 5545 "floating" — the appointment happens at that clock time wherever the reader is,
   * which is a real and different thing from "we do not know the zone".
   */
  readonly timezone?: string | undefined;
  /** True for a DATE-valued (all-day) event — {@link start} carries no clock at all. */
  readonly allDay: boolean;
  readonly location?: string | undefined;
  /**
   * Absolute instant in epoch milliseconds, for ORDERING ONLY — never display it. For a
   * floating or all-day event it is resolved against the process zone, which makes it a
   * stable sort key and a meaningless timestamp.
   */
  readonly sortKey: number;
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
  /** Occurrences overlapping the window, in chronological order. */
  readonly events: CalendarEvent[];
  /** True when the cap or the work budget cut the list short — the caller must say so rather
   *  than imply completeness. */
  readonly truncated: boolean;
  /** Components that could not be read. Reported, not thrown: one broken VEVENT in a year of
   *  calendar should not lose the other 300. */
  readonly skipped: number;
}

/** A calendar window is for reading, not for bulk export. */
export const DEFAULT_MAX_EVENTS = 200;

/**
 * Total recurrence-iterator steps allowed for the WHOLE document, shared across every series.
 *
 * A per-series ceiling does not bound this work, and the difference is not academic. A
 * recurrence iterator walks occurrences one at a time from DTSTART, so a rule that started
 * years ago costs one step per interval before it reaches the window — and `FREQ=SECONDLY`
 * with no UNTIL is a valid rule that never terminates. Such a series yields ZERO events, so
 * the output cap never trips either. Measured on this machine: ~33 ms per exhausted series, at
 * ~102 bytes of ICS per series.
 *
 * One budget for the document bounds ITERATOR STEPS at roughly 165 ms — and that is the whole
 * of what it bounds. It is not the limit that makes a hostile feed safe: with this budget in
 * place a 5 MB feed still took 302 seconds, because the time was going somewhere else
 * entirely. See {@link MAX_COMPONENTS}, which is the one that does.
 */
const MAX_TOTAL_ITERATIONS = 50_000;

/**
 * Ceiling on VEVENT components, applied to the TEXT before it is parsed.
 *
 * This is the limit that actually bounds a hostile feed, and it took two measurements that each
 * contradicted the previous fix to land on it:
 *
 *  1. The iteration budget above bounds expansion — and expansion was never where the time
 *     went. A 5 MB feed of `FREQ=SECONDLY` series still took 302 seconds.
 *  2. Capping how many components we CONSTRUCT dropped that to 29 seconds, no further, because
 *     `new ICAL.Event()` costs O(components in the enclosing VCALENDAR) — it scans the parent
 *     for RECURRENCE-ID overrides. Constructing 5,000 events inside a 57,614-component document
 *     measured 23 SECONDS; the same 5,000 in a document of their own take ~500 ms. The cost is
 *     set by the document around them, not by how many we build.
 *
 * So the cap has to shrink the DOCUMENT, which means cutting the text before `ICAL.parse` ever
 * sees it. 5,000 events is generous for a personal calendar; past it the read is honestly
 * reported as incomplete.
 */
const MAX_COMPONENTS = 5000;

/**
 * Parse an ICS document and return the occurrences overlapping a window.
 *
 * Pure: no network, no clock beyond the caller's window. Everything hard about this format —
 * recurrence, exceptions, timezones — is resolved here so the caller receives plain fields.
 */
export function parseIcsEvents(ics: string, opts: ParseIcsOptions): ParseIcsResult {
  const max = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const capped = capComponents(ics);
  const comp = new ICAL.Component(ICAL.parse(capped.ics));

  // No VTIMEZONE registration here, deliberately. ical.js ships with no timezones registered
  // — a size trade-off by its authors, with `ical.timezones.js` as the add-on — but it
  // resolves a `TZID` against the ENCLOSING VCALENDAR, and a feed that uses a zone normally
  // defines it. A feed that references an UNDEFINED TZID degrades to floating rather than
  // failing; the zone then reads as undefined, which is reported honestly instead of being
  // presented as a zone we do not actually have.
  //
  // Verified by mutation rather than assumed: removing an explicit registration loop changed
  // nothing, under a Europe/Zurich process timezone AND under UTC. Both runs were needed —
  // the first alone would have proved only that the developer's laptop sits in the same zone
  // as the test fixture.

  const from = ICAL.Time.fromJSDate(opts.from, true);
  const to = ICAL.Time.fromJSDate(opts.to, true);
  const events: CalendarEvent[] = [];
  let skipped = 0;
  let truncated = capped.capped;
  let budget = MAX_TOTAL_ITERATIONS;

  // TWO passes, because a moved instance of a series is its OWN `VEVENT` in the file: it
  // shares the master's UID and carries a RECURRENCE-ID naming the occurrence it replaces.
  // Walking the components naively yields the moved appointment twice — once from the rule,
  // once as a standalone event — which is how a calendar starts claiming meetings that do not
  // exist. So: separate them first, and let `getOccurrenceDetails` substitute the override
  // during expansion.
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
  // time. What IS load-bearing is the separation above.
  //
  // An exception whose master is missing — a truncated export, or a series that ended before
  // the window — is still a real appointment. Dropping it would hide a meeting.
  const recurringUids = new Set(masters.filter(m => m.isRecurring()).map(m => m.uid));
  const orphanExceptions = exceptions.filter(ex => !recurringUids.has(ex.uid));

  for (const ev of [...masters, ...orphanExceptions]) {
    try {
      if (isCancelled(ev.component)) continue;

      if (!ev.isRecurring()) {
        if (overlapsWindow(ev.startDate, ev.endDate, from, to)) {
          events.push(toEvent(ev.startDate, ev.endDate, ev.summary, ev.location));
        }
        continue;
      }

      const it = ev.iterator();
      for (;;) {
        if (budget-- <= 0) { truncated = true; break; }
        const next = it.next();
        if (!next) break;                 // the rule ended (UNTIL / COUNT)
        if (next.compare(to) >= 0) break; // past the window — occurrences are ascending
        // `getOccurrenceDetails` applies RECURRENCE-ID overrides: a single moved or edited
        // instance carries its own time, title and location, and reporting the rule's version
        // instead would put the operator in the wrong place.
        const details = ev.getOccurrenceDetails(next);
        // A single occurrence can be cancelled by an override while the series runs on.
        // Showing it as an appointment costs the operator a wasted trip.
        if (isCancelled(details.item.component)) continue;
        if (!overlapsWindow(details.startDate, details.endDate, from, to)) continue;
        events.push(toEvent(details.startDate, details.endDate, details.item.summary, details.item.location));
      }
    } catch {
      skipped++;
    }
  }

  // Sort BEFORE capping. Capping during expansion cuts in feed order, which is arbitrary — the
  // result is a list with holes in it while the caller tells the operator to "narrow the window
  // to see the rest". A chronological prefix is the only truncation that statement is true of.
  events.sort((a, b) => a.sortKey - b.sortKey);
  if (events.length > max) {
    events.length = max;
    truncated = true;
  }
  return { events, truncated, skipped };
}

/**
 * Cut the document to {@link MAX_COMPONENTS} events, on the text, before parsing.
 *
 * Textual rather than structural because the cost being bounded is set by the size of the
 * parsed document itself (see {@link MAX_COMPONENTS}) — dropping components after the parse
 * would leave that cost fully paid. The header, and with it any VTIMEZONE the remaining events
 * resolve against, is kept.
 *
 * The LINE ANCHOR is load-bearing, not tidiness. A plain substring search matches
 * `BEGIN:VEVENT` inside a property VALUE, and an attacker only needs to send the operator one
 * invitation whose DESCRIPTION repeats the literal 5,001 times: the cut then lands in the
 * middle of that value, `ICAL.parse` throws on the malformed document, and the operator's
 * ENTIRE calendar reads as unavailable. Verified — it threw "component began but did not end"
 * before this was anchored. RFC 5545 folds a long line by indenting the continuation with a
 * space or tab, so a line that begins in column zero with `BEGIN:VEVENT` is always a real
 * component boundary and a folded payload never is.
 */
function capComponents(ics: string): { ics: string; capped: boolean } {
  const boundary = /^BEGIN:VEVENT/gm;
  for (let seen = 0; ; seen++) {
    const match = boundary.exec(ics);
    if (!match) return { ics, capped: false };
    if (seen === MAX_COMPONENTS) {
      const head = ics.slice(0, match.index);
      // Carry any VTIMEZONE that sits AFTER the events. RFC 5545 fixes no order, and dropping
      // one turns every zoned time in the kept events into a floating one — a silently wrong
      // clock rather than a visible failure, which is the worse of the two.
      const zones = collectTimezones(ics.slice(match.index));
      return { ics: `${head}\r\n${zones}END:VCALENDAR\r\n`, capped: true };
    }
  }
}

/**
 * Pull the VTIMEZONE blocks out of the part being discarded.
 *
 * Scanned with indexOf rather than a lazy regex on purpose: `/BEGIN:VTIMEZONE[\s\S]*?END:.../g`
 * over a 5 MB tail is quadratic when the openings have no matching close, which is a document
 * an attacker can simply write. The count is capped for the same reason — no real calendar
 * defines more zones than there are zones.
 */
function collectTimezones(tail: string): string {
  const MAX_ZONES = 100;
  const out: string[] = [];
  let at = 0;
  while (out.length < MAX_ZONES) {
    const start = tail.indexOf('\nBEGIN:VTIMEZONE', at);
    if (start < 0) break;
    const end = tail.indexOf('\nEND:VTIMEZONE', start);
    if (end < 0) break;
    out.push(tail.slice(start + 1, end + '\nEND:VTIMEZONE'.length).replace(/\r$/, ''));
    at = end + 1;
  }
  return out.length > 0 ? `${out.join('\r\n')}\r\n` : '';
}

function isCancelled(component: ICAL.Component): boolean {
  return String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

/**
 * Overlap, not containment.
 *
 * Filtering on the start alone hides exactly the appointments that matter most for "am I free
 * on Tuesday": a week of holiday that began last Friday starts before the window and is
 * invisible, though it covers every day in it.
 *
 * The zero-length case is not a curiosity, and moving to overlap broke it before this line
 * existed. A VEVENT with no DTEND and no DURATION gets `endDate == startDate` from ical.js, and
 * that is the shape of every reminder and marker in a real calendar. Requiring `end > from`
 * drops such an entry when it falls exactly ON the window start — which is where it usually
 * falls, because "what is on today" starts the window at midnight. A point in time overlaps a
 * window it sits at the edge of.
 */
function overlapsWindow(start: ICAL.Time, end: ICAL.Time, from: ICAL.Time, to: ICAL.Time): boolean {
  const zeroLength = start.compare(end) === 0;
  const endsAfterStart = zeroLength ? end.compare(from) >= 0 : end.compare(from) > 0;
  return endsAfterStart && start.compare(to) < 0;
}

function toEvent(
  start: ICAL.Time,
  end: ICAL.Time,
  summary: string | null,
  location: string | null,
): CalendarEvent {
  // `toString()` renders the wall time as the feed wrote it; `zone.tzid` names the zone it
  // belongs to. 'floating' is ical.js's marker for "the feed gave no zone" and is not an IANA
  // name, so it is reported as absent rather than passed off as a zone.
  const tzid = start.zone?.tzid;
  const timezone = tzid && tzid !== 'floating' ? tzid : undefined;
  return {
    summary: summary ?? '',
    start: start.toString(),
    end: end.toString(),
    ...(timezone ? { timezone } : {}),
    allDay: start.isDate === true,
    ...(location ? { location } : {}),
    sortKey: start.toJSDate().getTime(),
  };
}
