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
  /** Things this read could not take at face value: a component that could not be read, a
   *  series whose rule was refused, or a timezone whose transition rule was disarmed (counted
   *  per subcomponent). Reported, not thrown: one broken VEVENT in a year of calendar should
   *  not lose the other 300. */
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
 * Ceiling on VEVENT components read from one document.
 *
 * Landing on the right MECHANISM here took four attempts, and the first three failed in the
 * same way, which is the useful part of the history:
 *
 *  1. The iteration budget above bounds expansion — and expansion was never where the time
 *     went. A 5 MB feed of `FREQ=SECONDLY` series still took 302 seconds.
 *  2. Capping how many events we CONSTRUCT dropped that to 29 seconds, no further, because
 *     `new ICAL.Event()` costs O(components in the enclosing VCALENDAR) — it scans the parent
 *     for RECURRENCE-ID overrides. Building 5,000 events inside a 57,614-component document
 *     measured 23 SECONDS; the same 5,000 in a document of their own take ~600 ms. The cost is
 *     set by the document AROUND them.
 *  3. So the document has to shrink — and cutting the TEXT to shrink it meant deciding where a
 *     component begins without a parser, which is a second and much worse parser. Every fix to
 *     it revealed the next way around: a plain substring match was fooled by the literal inside
 *     a DESCRIPTION; anchoring with a `/m` regex was fooled by U+2028, which JavaScript treats
 *     as a line terminator and RFC 5545 permits inside a value; and neither noticed
 *     `begin:vevent`, which is legal because component names are case-insensitive. Each of the
 *     three was attacker-triggerable with one calendar invitation.
 *
 * The fix is to stop guessing: PARSE the document — which is cheap, ~100 ms for 5 MB — and then
 * REHOME the first {@link MAX_COMPONENTS} events into a fresh, small VCALENDAR. ical.js decides
 * what a component is, so there is nothing left to spoof. 5,000 events is generous for a
 * personal calendar; past it the read is honestly reported as incomplete.
 */
const MAX_COMPONENTS = 5000;

/** Zone definitions carried into the rehomed document. A calendar cannot legitimately need
 *  more zones than the world has; unbounded, they cost as much as the events did. */
const MAX_TIMEZONES = 100;

/**
 * Parse an ICS document and return the occurrences overlapping a window.
 *
 * Pure: no network, no clock beyond the caller's window. Everything hard about this format —
 * recurrence, exceptions, timezones — is resolved here so the caller receives plain fields.
 */
export function parseIcsEvents(ics: string, opts: ParseIcsOptions): ParseIcsResult {
  const max = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const parsed = new ICAL.Component(ICAL.parse(ics));
  const capped = capComponents(parsed);
  const comp = capped.comp;

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
  // Counted as skipped: a zone whose transition rule was removed no longer describes the feed
  // exactly, and the caller is told rather than quietly handed a slightly-wrong calendar.
  let skipped = disarmTimezoneRules(comp);
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

      // Refuse a rule whose date can never exist BEFORE handing it to the iterator. This is
      // not defence in depth — it is the only defence, because the iteration budget below
      // cannot reach this case.
      //
      // ical.js expands a contracting rule by stepping the calendar forward until the BY*
      // parts match, and it carries a give-up counter for exactly that search — but only for
      // MONTHLY and YEARLY (`invalid_count`, 336 and 28). For DAILY and below there is none,
      // so a rule that can NEVER match spins inside a single `it.next()` and never returns.
      // The budget below is decremented BETWEEN calls, so it is never read again; nothing is
      // thrown, so the catch never fires; the loop is synchronous on the one JS thread, so no
      // timer fires either — not the fetch timeout, not an AbortSignal, nothing. One
      // appointment permanently takes the tenant's engine down, and a restart only survives
      // until the next read, because the feed still carries the rule.
      //
      // Measured on ical.js 2.2.1: `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` never returns from the
      // FIRST next() (killed at 8s), the same rule as YEARLY returns in 0ms, and as WEEKLY it
      // throws in the constructor. That spread is the give-up counter, not luck.
      //
      // The check is narrow on purpose: only an IMPOSSIBLE day is refused, never a merely rare
      // one. `BYMONTHDAY=29 BYMONTH=2` is a real leap-day series and still expands — it costs
      // a bounded scan and returns.
      if (hasUnexpandableRule(ev.component)) {
        skipped++;
        // The RULE is what cannot be expanded — the event's explicit RDATE occurrences are
        // ordinary fixed dates and need no iterator at all. Dropping the whole VEVENT would
        // hide real appointments as collateral for a malformed rule, so read them directly.
        for (const prop of ev.component.getAllProperties('rdate')) {
          for (const value of prop.getValues()) {
            // Reading these costs work, so they come out of the same document budget as the
            // iterator steps — otherwise a feed of 200,000 RDATE values on one refused event
            // sits entirely outside the only bound this file documents.
            if (budget-- <= 0) { truncated = true; break; }
            // An RDATE may be a PERIOD (start/end) rather than a plain date. `ICAL.Period` HAS
            // a `compare` method, so duck-typing on that filtered nothing: `addDuration` threw,
            // the outer catch abandoned the WHOLE VEVENT, and the event's other perfectly
            // ordinary RDATEs went with it. Measured before this: a feed with one PERIOD and
            // one plain RDATE returned zero events.
            const period = value as { start?: ICAL.Time; getEnd?: () => ICAL.Time };
            const isPeriod = typeof period?.getEnd === 'function' && period.start !== undefined;
            const start = isPeriod ? period.start! : (value as ICAL.Time);
            if (typeof start?.clone !== 'function') continue; // neither a date nor a period
            let end: ICAL.Time;
            if (isPeriod) {
              end = period.getEnd!();
            } else {
              end = start.clone();
              end.addDuration(ev.duration);
            }
            if (overlapsWindow(start, end, from, to)) {
              events.push(toEvent(start, end, ev.summary, ev.location));
            }
          }
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
 * Bound the document to {@link MAX_COMPONENTS} events, structurally.
 *
 * Rehoming rather than cutting: the events that survive are moved into a NEW, small VCALENDAR,
 * because the cost being bounded is `new ICAL.Event()`'s scan of the enclosing document (see
 * {@link MAX_COMPONENTS}) and only a genuinely smaller enclosure pays it down. Doing this after
 * the parse instead of on the text is what makes it unspoofable — ical.js has already decided
 * what a component is, so there is no literal for an invitation to forge.
 *
 * Three details here are each a measured defect from an earlier version, and each is invisible
 * until measured:
 *
 *  · The trigger counts ALL components, not just VEVENTs. `new ICAL.Event()` scans the whole
 *    enclosing calendar, so 5,000 events beside 138,000 VTODOs cost 14.5 s while never
 *    tripping a VEVENT-only ceiling — staying just UNDER it was 13× more expensive than
 *    crossing it, which is the opposite of what a ceiling is for.
 *  · Components are COPIED into the new document, not moved. `addSubcomponent` calls
 *    `removeSubcomponent` on the old parent, which is a linear scan and a splice per item —
 *    O(source) each, measured at 8.5 s to rehome out of a 143,000-component feed. Pushing the
 *    jCal array is O(1) and the zones still resolve.
 *  · VTIMEZONEs are capped too. Carrying them unbounded reintroduced the same cost by another
 *    door: 112,000 zones put `new ICAL.Event()` back at 12 s. No real calendar defines more
 *    zones than the world has.
 *
 * Zones are carried at all — rather than dropped with the tail — because RFC 5545 fixes no
 * order between components, and leaving one behind turns every zoned time in the kept events
 * into a floating one: a silently wrong clock, which is worse than a visible failure.
 */
function capComponents(parsed: ICAL.Component): { comp: ICAL.Component; capped: boolean } {
  if (parsed.getAllSubcomponents().length <= MAX_COMPONENTS) return { comp: parsed, capped: false };

  const small = new ICAL.Component(['vcalendar', [], []]);
  const take = (components: ICAL.Component[], limit: number): void => {
    for (const c of components.slice(0, limit)) small.jCal[2].push(c.jCal);
  };
  take(parsed.getAllSubcomponents('vtimezone'), MAX_TIMEZONES);
  take(parsed.getAllSubcomponents('vevent'), MAX_COMPONENTS);
  return { comp: small, capped: true };
}

/**
 * Remove recurrence rules that {@link hasUnexpandableRule} refuses from VTIMEZONE definitions,
 * and report how many SUBCOMPONENTS were disarmed — one zone with a bad STANDARD and a bad
 * DAYLIGHT counts twice, because that is what the loop counts.
 *
 * A DST transition is a recurrence too, and it is expanded by a DIFFERENT code path — resolving
 * a `TZID` runs `Timezone._expandComponent`, not `Event.iterator()`. So the VEVENT guard does
 * not cover it, and a feed whose VTIMEZONE carries `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` blocks
 * the thread for 73 seconds (measured) with the guard fully in place. One invitation, no VEVENT
 * rule at all, same outcome.
 *
 * The rule is STRIPPED rather than the zone dropped, because the zone still carries the part
 * that matters. `TZOFFSETTO` gives the base offset; only the seasonal transition is lost, so
 * appointments keep their wall time and at worst shift by the DST hour on one side of a
 * changeover. Dropping the zone would degrade every event in it to floating, and refusing the
 * feed would hide the whole calendar — both a bigger loss than a transition rule that was
 * malformed to begin with.
 */
function disarmTimezoneRules(comp: ICAL.Component): number {
  let disarmed = 0;
  for (const vtz of comp.getAllSubcomponents('vtimezone')) {
    for (const sub of vtz.getAllSubcomponents()) {
      if (!hasUnexpandableRule(sub)) continue;
      sub.removeAllProperties('rrule');
      disarmed++;
    }
  }
  return disarmed;
}

function isCancelled(component: ICAL.Component): boolean {
  return String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

/** Longest possible month, 1-indexed. February is 29 — a leap-day series is legal. */
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Frequencies for which ical.js carries NO give-up counter.
 *
 * It expands a contracting rule by stepping the calendar forward until the BY* parts match, and
 * `invalid_count` bounds that search for MONTHLY (336) and YEARLY (28) only. At these
 * frequencies the search is unbounded, which is what makes a non-matching rule a hang rather
 * than an empty result. The same rule one step up the ladder is harmless: measured,
 * `FREQ=MONTHLY;BYMONTHDAY=-1` returns in 2 ms and `FREQ=DAILY;BYMONTHDAY=-1` takes 73 s.
 */
const UNBOUNDED_FREQS = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY']);

const nums = (v: unknown): number[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
    .map(Number)
    .filter((n) => Number.isFinite(n));

/**
 * True when ANY of the component's recurrence rules is one ical.js cannot expand in bounded
 * time — so it must never reach `ev.iterator()`.
 *
 * Two families, and the second is why this is not named after the first any more:
 *
 * 1. **Arithmetically impossible** — `BYMONTH=2;BYMONTHDAY=30`. February has no 30th, so the
 *    search runs forever. Checked at every frequency.
 * 2. **Unboundable by construction** — a {@link UNBOUNDED_FREQS} frequency carrying a part the
 *    expander has to SEARCH for: a negative BYMONTHDAY/BYSETPOS, a positional BYDAY (`-1FR`),
 *    or BYWEEKNO/BYYEARDAY, which RFC 5545 does not permit below YEARLY at all. Each measured
 *    at 60-75 s for a single event; `FREQ=DAILY;BYMONTHDAY=-1` — "the last day of every month"
 *    — is the one an ordinary exporter can really emit, and it was NOT caught by the
 *    impossible-date arithmetic, which reads `-1` as a legal day.
 *
 * Every rule is checked, not just the first: RFC 5545 allows repeated RRULE lines and ical.js
 * merges them all (`RecurExpansion` reads `getAllProperties('rrule')`). Reading only the first
 * left the guard trivially bypassable — a harmless `FREQ=DAILY;COUNT=3` in front of an
 * impossible rule blocked the thread for 70 s, on a feed the single-rule form skips in 1 ms.
 *
 * It stays conservative about REFUSING, because a false refusal silently drops a real
 * appointment. Verified against the legitimate shapes rather than assumed: `BYMONTHDAY=15`,
 * `BYMONTHDAY=1,15`, `BYDAY=FR`, `BYDAY=MO;INTERVAL=2`, `BYHOUR=9`, `BYSETPOS=1;BYDAY=MO` on
 * sub-monthly frequencies all expand in 2-3 ms and all still pass. 29 February passes too — a
 * real leap-day series costs a bounded scan and returns.
 */
function hasUnexpandableRule(component: ICAL.Component): boolean {
  return component.getAllProperties('rrule').some((prop) => {
    const recur = prop.getFirstValue() as { freq?: string; parts?: Record<string, unknown> } | null;
    const parts = recur?.parts;
    if (!parts) return false;

    // (1) Impossible only when EVERY pinned day fails in EVERY pinned month — one workable pair
    // is enough for the iterator to terminate. No BYMONTH ⇒ checked against the longest month
    // there is, so only >31 fails.
    const days = nums(parts['BYMONTHDAY']);
    if (days.length > 0) {
      const months = nums(parts['BYMONTH']);
      const lengths = months.length > 0 ? months.map((m) => DAYS_IN_MONTH[m] ?? 0) : [31];
      if (days.every((d) => lengths.every((len) => Math.abs(d) > len || d === 0))) return true;
    }

    // (2) Only below MONTHLY, where nothing bounds the search.
    if (!UNBOUNDED_FREQS.has(String(recur?.freq ?? '').toUpperCase())) return false;
    if (parts['BYWEEKNO'] !== undefined || parts['BYYEARDAY'] !== undefined) return true;
    if (nums(parts['BYMONTHDAY']).some((n) => n < 0)) return true;
    if (nums(parts['BYSETPOS']).some((n) => n < 0)) return true;
    // A positional BYDAY carries an ordinal prefix (`-1FR`, `2MO`); a plain `FR` does not.
    const byDay = parts['BYDAY'];
    return (Array.isArray(byDay) ? byDay : []).some((d) => /^[+-]?\d/.test(String(d)));
  });
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
