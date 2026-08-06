import { describe, it, expect } from 'vitest';
import { parseIcsEvents } from './ics.js';

/**
 * The cases here are the ones a hand-rolled parser gets quietly wrong. Each is written as a
 * calendar someone could actually have, not as a protocol curiosity — a wrong answer about a
 * person's Tuesday is the failure this module exists to prevent.
 *
 * Every assertion on `start`/`end` is a WALL TIME, which makes this file independent of the
 * process timezone by construction. That is not incidental: the previous version asserted UTC
 * instants, and its all-day test passed only because it never looked at the date. It does now,
 * and an implementation that normalises to an instant fails it under every zone including UTC.
 */

const TZ = `BEGIN:VTIMEZONE
TZID:Europe/Zurich
BEGIN:STANDARD
DTSTART:19701025T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE`;

function cal(...events: string[]): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', TZ,
    ...events, 'END:VCALENDAR',
  ].join('\n');
}

const AUG = { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') };

describe('parseIcsEvents', () => {
  it('reads a single appointment as the wall time and zone the feed states', () => {
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260812T140000
DTEND;TZID=Europe/Zurich:20260812T150000
SUMMARY:Termin Roland
LOCATION:St. Gallen
END:VEVENT`,
    ), AUG);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      summary: 'Termin Roland',
      start: '2026-08-12T14:00:00',
      end: '2026-08-12T15:00:00',
      timezone: 'Europe/Zurich',
      location: 'St. Gallen',
      allDay: false,
    });
  });

  it('resolves the SAME local time to a different instant across the DST boundary', () => {
    // 09:00 Zurich is 07:00 UTC in summer and 08:00 UTC in winter. A parser that pins one
    // offset per feed is wrong for half the year — and looks perfectly right in a test that
    // only ever asks about one season. The wall time is 09:00 in both, so this asserts on
    // `sortKey`, which is where the resolved instant now lives.
    const ics = cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260810T090000
DTEND;TZID=Europe/Zurich:20260810T093000
RRULE:FREQ=MONTHLY;BYMONTHDAY=10
SUMMARY:Monatsstart
END:VEVENT`,
    );
    const summer = parseIcsEvents(ics, { from: new Date('2026-08-10T00:00:00Z'), to: new Date('2026-08-11T00:00:00Z') });
    const winter = parseIcsEvents(ics, { from: new Date('2026-12-10T00:00:00Z'), to: new Date('2026-12-11T00:00:00Z') });
    expect(summer.events[0]?.start).toBe('2026-08-10T09:00:00');
    expect(winter.events[0]?.start).toBe('2026-12-10T09:00:00');
    expect(new Date(summer.events[0]?.sortKey ?? 0).toISOString()).toBe('2026-08-10T07:00:00.000Z');
    expect(new Date(winter.events[0]?.sortKey ?? 0).toISOString()).toBe('2026-12-10T08:00:00.000Z');
  });

  it('gives an all-day event the date the feed wrote, in any process timezone', () => {
    // THE regression this file exists for. Resolving a DATE-valued event to an instant and
    // formatting it back lands on the PREVIOUS day everywhere east of Greenwich: a holiday on
    // the 14th was reported to a Zurich operator as the 13th. A date is not an instant.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;VALUE=DATE:20260814
DTEND;VALUE=DATE:20260815
SUMMARY:Ferientag
END:VEVENT`,
    ), AUG);
    expect(r.events[0]).toMatchObject({
      summary: 'Ferientag',
      start: '2026-08-14',
      end: '2026-08-15',
      allDay: true,
    });
    expect(r.events[0]?.timezone).toBeUndefined();
  });

  it('reports a floating time as having no zone rather than inventing one', () => {
    // RFC 5545 floating: the appointment happens at that clock time wherever the reader is.
    // Reporting a zone we do not have would be a confident wrong answer.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART:20260812T090000
DTEND:20260812T100000
SUMMARY:Ohne Zone
END:VEVENT`,
    ), AUG);
    expect(r.events[0]?.start).toBe('2026-08-12T09:00:00');
    expect(r.events[0]?.timezone).toBeUndefined();
  });

  it('shows a multi-day event that STARTED before the window', () => {
    // Filtering on the start alone hides exactly what matters for "am I free on Tuesday": a
    // week of holiday that began last Friday covers every day in the window and starts outside
    // it. The failure direction is the expensive one — the operator is told they are free.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;VALUE=DATE:20260728
DTEND;VALUE=DATE:20260810
SUMMARY:Ferien Roland
END:VEVENT`,
    ), { from: new Date('2026-08-03T00:00:00Z'), to: new Date('2026-08-04T00:00:00Z') });
    expect(r.events.map(e => e.summary)).toEqual(['Ferien Roland']);
  });

  it('keeps a zero-length entry sitting exactly on the window start', () => {
    // A VEVENT with no DTEND and no DURATION — every reminder and marker in a real calendar —
    // gets `endDate == startDate`. Moving from a start-filter to an overlap-filter fixed the
    // multi-day case and broke this one in the same stroke: `end > from` drops a point in time
    // at the edge, and the edge is exactly where it lands, because "what is on today" starts
    // the window at midnight.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
UID:marker@t
DTSTART:20260814T090000Z
SUMMARY:Marker ohne Dauer
END:VEVENT`,
    ), { from: new Date('2026-08-14T09:00:00Z'), to: new Date('2026-08-15T00:00:00Z') });
    expect(r.events.map(e => e.summary)).toEqual(['Marker ohne Dauer']);
  });

  it('drops an appointment that ENDED exactly at the window start', () => {
    // The other direction of the same edge, and the reason the zero-length case gets a special
    // branch instead of relaxing the comparison for everything: a meeting that ran 08:00–09:00
    // is over when the window opens at 09:00. Making the bound inclusive for all events would
    // resurrect it, and "what is on now" would open with a meeting that already happened.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
UID:vorbei@t
DTSTART:20260814T080000Z
DTEND:20260814T090000Z
SUMMARY:Schon vorbei
END:VEVENT`,
    ), { from: new Date('2026-08-14T09:00:00Z'), to: new Date('2026-08-15T00:00:00Z') });
    expect(r.events).toHaveLength(0);
  });

  it('expands a weekly series and honours EXDATE', () => {
    // The cancelled instance is the point: a series minus one week is what a real calendar
    // looks like, and listing the skipped week is how someone ends up at an empty room.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260803T090000
DTEND;TZID=Europe/Zurich:20260803T093000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Europe/Zurich:20260817T090000
SUMMARY:Wochenstart
END:VEVENT`,
    ), AUG);
    const days = r.events.map(e => e.start.slice(0, 10));
    expect(days).toEqual(['2026-08-03', '2026-08-10', '2026-08-24', '2026-08-31']);
    expect(days).not.toContain('2026-08-17');
  });

  it('stops a series at its UNTIL instead of running to the window edge', () => {
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260803T090000
DTEND;TZID=Europe/Zurich:20260803T093000
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260811T000000Z
SUMMARY:Kurzserie
END:VEVENT`,
    ), AUG);
    expect(r.events.map(e => e.start.slice(0, 10))).toEqual(['2026-08-03', '2026-08-10']);
  });

  it('takes a MOVED instance at its new time, not the rule time', () => {
    // A RECURRENCE-ID override is one instance of a series edited on its own. Reporting the
    // rule's time would send the operator to the wrong hour for exactly the meeting somebody
    // took the trouble to move.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
UID:series-1
DTSTART;TZID=Europe/Zurich:20260803T090000
DTEND;TZID=Europe/Zurich:20260803T093000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Wochenstart
END:VEVENT
BEGIN:VEVENT
UID:series-1
RECURRENCE-ID;TZID=Europe/Zurich:20260810T090000
DTSTART;TZID=Europe/Zurich:20260810T160000
DTEND;TZID=Europe/Zurich:20260810T163000
SUMMARY:Wochenstart (verschoben)
LOCATION:Anderer Raum
END:VEVENT`,
    ), { from: new Date('2026-08-10T00:00:00Z'), to: new Date('2026-08-11T00:00:00Z') });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.start).toBe('2026-08-10T16:00:00'); // 16:00, not the rule's 09:00
    expect(r.events[0]?.summary).toBe('Wochenstart (verschoben)');
    // The override carries its own location too — reading it from the master would send the
    // operator to the room the meeting was moved OUT of.
    expect(r.events[0]?.location).toBe('Anderer Raum');
  });

  it('keeps a moved instance whose SERIES is not in the feed', () => {
    // A truncated export, or a series that ended before the window: the override VEVENT is
    // present, its master is not. It is still a real appointment on a real day, and dropping
    // it hides a meeting — the failure direction that costs someone a missed client.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
UID:verwaist-1
RECURRENCE-ID;TZID=Europe/Zurich:20260810T090000
DTSTART;TZID=Europe/Zurich:20260810T160000
DTEND;TZID=Europe/Zurich:20260810T163000
SUMMARY:Einzeln verschoben, Serie fehlt
END:VEVENT`,
    ), AUG);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.start).toBe('2026-08-10T16:00:00');
    expect(r.events[0]?.summary).toBe('Einzeln verschoben, Serie fehlt');
  });

  it('leaves a CANCELLED event out', () => {
    // It is still in the feed. Showing it errs in the one direction that costs a wasted trip.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260812T140000
DTEND;TZID=Europe/Zurich:20260812T150000
STATUS:CANCELLED
SUMMARY:Abgesagt
END:VEVENT`,
    ), AUG);
    expect(r.events).toHaveLength(0);
  });

  it('leaves out a single occurrence cancelled while the series runs on', () => {
    // Cancelling one week of a standing meeting produces an override with STATUS:CANCELLED.
    // Reading STATUS from the master only keeps the series clean and still lists the week that
    // was called off.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
UID:series-2
DTSTART;TZID=Europe/Zurich:20260803T090000
DTEND;TZID=Europe/Zurich:20260803T093000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Wochenstart
END:VEVENT
BEGIN:VEVENT
UID:series-2
RECURRENCE-ID;TZID=Europe/Zurich:20260810T090000
DTSTART;TZID=Europe/Zurich:20260810T090000
DTEND;TZID=Europe/Zurich:20260810T093000
STATUS:CANCELLED
SUMMARY:Wochenstart
END:VEVENT`,
    ), AUG);
    const days = r.events.map(e => e.start.slice(0, 10));
    expect(days).toContain('2026-08-03');
    expect(days).not.toContain('2026-08-10');
    expect(days).toContain('2026-08-17');
  });

  it('excludes what falls outside the window on both sides', () => {
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260715T100000
DTEND;TZID=Europe/Zurich:20260715T110000
SUMMARY:Vorher
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260915T100000
DTEND;TZID=Europe/Zurich:20260915T110000
SUMMARY:Nachher
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260815T100000
DTEND;TZID=Europe/Zurich:20260815T110000
SUMMARY:Mittendrin
END:VEVENT`,
    ), AUG);
    expect(r.events.map(e => e.summary)).toEqual(['Mittendrin']);
  });

  it('includes an event starting exactly AT the window start, excludes one at the end', () => {
    // Half-open [from, to). Untested boundaries are how "what is on today" quietly gains
    // tomorrow's first meeting or loses this morning's — every other case in this file sits
    // comfortably inside the window and would pass either way.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART:20260801T000000Z
DTEND:20260801T010000Z
SUMMARY:Genau am Anfang
END:VEVENT
BEGIN:VEVENT
DTSTART:20260901T000000Z
DTEND:20260901T010000Z
SUMMARY:Genau am Ende
END:VEVENT`,
    ), AUG);
    expect(r.events.map(e => e.summary)).toEqual(['Genau am Anfang']);
  });

  it('returns events in chronological order regardless of feed order', () => {
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260820T100000
DTEND;TZID=Europe/Zurich:20260820T110000
SUMMARY:Spaeter
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260805T100000
DTEND;TZID=Europe/Zurich:20260805T110000
SUMMARY:Frueher
END:VEVENT`,
    ), AUG);
    expect(r.events.map(e => e.summary)).toEqual(['Frueher', 'Spaeter']);
  });

  it('caps to the EARLIEST events, not to whatever the feed listed first', () => {
    // Capping during expansion cuts in feed order, which is arbitrary: the result is a list
    // with holes while the caller tells the operator to "narrow the window to see the rest".
    // A chronological prefix is the only truncation that statement is true of.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260828T100000
DTEND;TZID=Europe/Zurich:20260828T110000
SUMMARY:Ende August
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260803T100000
DTEND;TZID=Europe/Zurich:20260803T110000
SUMMARY:Anfang August
END:VEVENT`,
    ), { ...AUG, maxEvents: 1 });
    expect(r.events.map(e => e.summary)).toEqual(['Anfang August']);
    expect(r.truncated).toBe(true);
  });

  it('caps the result and SAYS it did, instead of implying completeness', () => {
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260801T090000
DTEND;TZID=Europe/Zurich:20260801T093000
RRULE:FREQ=DAILY
SUMMARY:Taeglich
END:VEVENT`,
    ), { ...AUG, maxEvents: 5 });
    expect(r.events).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });

  it('does not hang on an unbounded high-frequency rule', () => {
    // `FREQ=SECONDLY` with no UNTIL is valid and never terminates. The window bound alone does
    // not save us — it only stops the loop once the iterator ARRIVES there, and starting years
    // earlier it never does. This asserts the run FINISHES, which is the actual property.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20200101T090000
DTEND;TZID=Europe/Zurich:20200101T090010
RRULE:FREQ=SECONDLY
SUMMARY:Pathologisch
END:VEVENT`,
    ), { ...AUG, maxEvents: 10 });
    expect(r.truncated).toBe(true);
    expect(r.events.length).toBeLessThanOrEqual(10);
  });

  it('finishes on a feed packed with pathological series, and says it was cut', () => {
    // The shape a hostile feed actually has: not one expensive series but thousands of them,
    // each yielding nothing, so the output cap never trips. Without a budget shared across
    // series this runs for minutes with the event loop held shut.
    const series = Array.from({ length: 3000 }, (_, i) =>
      `BEGIN:VEVENT\nUID:s${String(i)}@t\nDTSTART:20200101T000000Z\nRRULE:FREQ=SECONDLY\nSUMMARY:s${String(i)}\nEND:VEVENT`);
    const started = Date.now();
    const r = parseIcsEvents(cal(...series), { ...AUG, maxEvents: 10 });
    expect(r.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops reading a document with more events than the ceiling', () => {
    // A SEPARATE limit from the iteration budget, and it needs its own case: plain events with
    // no recurrence at all never touch the budget, so a test built from pathological series
    // passes with the component cap deleted. Measured, this is the limit that matters —
    // `new ICAL.Event()` costs O(components in the enclosing calendar), so 57,000 of them
    // inside the 5 MB fetch ceiling is minutes of synchronous work no expansion budget bounds.
    //
    // `maxEvents` is raised past the feed size deliberately: leaving it at the default would
    // make the output cap alone produce `truncated`, and the case would prove nothing.
    const many = Array.from({ length: 6000 }, (_, i) =>
      `BEGIN:VEVENT\nUID:p${String(i)}@t\nDTSTART:20260812T${String(Math.floor(i / 60) % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00Z\nDTEND:20260812T235900Z\nSUMMARY:p${String(i)}\nEND:VEVENT`);
    const r = parseIcsEvents(cal(...many), { ...AUG, maxEvents: 6000 });
    expect(r.truncated).toBe(true);
    expect(r.events.length).toBeLessThan(6000);
  });

  it('keeps the rest of the calendar when one event is broken', () => {
    // One malformed VEVENT in a year of calendar must not lose the other 300.
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:20260812T140000
DTEND;TZID=Europe/Zurich:20260812T150000
SUMMARY:Gut
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Zurich:not-a-date
SUMMARY:Kaputt
END:VEVENT`,
    ), AUG);
    expect(r.events.map(e => e.summary)).toContain('Gut');
    expect(r.skipped).toBeGreaterThan(0);
  });

  it('reads a feed that carries no VTIMEZONE at all (UTC stamps)', () => {
    // Not every producer embeds one; a UTC-stamped feed must still work.
    const r = parseIcsEvents([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
      `BEGIN:VEVENT
DTSTART:20260812T120000Z
DTEND:20260812T130000Z
SUMMARY:UTC-Termin
END:VEVENT`,
      'END:VCALENDAR',
    ].join('\n'), AUG);
    expect(r.events[0]?.start).toBe('2026-08-12T12:00:00Z');
    expect(r.events[0]?.timezone).toBe('UTC');
  });
});
