import { describe, it, expect } from 'vitest';
import { parseIcsEvents } from './ics.js';

/**
 * The cases here are the ones a hand-rolled parser gets quietly wrong. Each is written as a
 * calendar someone could actually have, not as a protocol curiosity — a wrong answer about a
 * person's Tuesday is the failure this module exists to prevent.
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
  it('reads a single appointment with its local time resolved to the right instant', () => {
    // 14:00 in Zurich in August is CEST (+2) → 12:00 UTC. Getting this wrong by an hour is
    // the single most common calendar bug there is.
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
      start: '2026-08-12T12:00:00.000Z',
      end: '2026-08-13T00:00:00.000Z'.slice(0, 0) + '2026-08-12T13:00:00.000Z',
      location: 'St. Gallen',
      recurring: false,
      allDay: false,
    });
  });

  it('resolves the SAME local time differently across the DST boundary', () => {
    // 09:00 Zurich is 07:00 UTC in summer and 08:00 UTC in winter. A parser that pins one
    // offset per feed is wrong for half the year — and looks perfectly right in a test that
    // only ever asks about one season.
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
    expect(summer.events[0]?.start).toBe('2026-08-10T07:00:00.000Z');
    expect(winter.events[0]?.start).toBe('2026-12-10T08:00:00.000Z');
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
    expect(r.events.every(e => e.recurring)).toBe(true);
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
END:VEVENT`,
    ), { from: new Date('2026-08-10T00:00:00Z'), to: new Date('2026-08-11T00:00:00Z') });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.start).toBe('2026-08-10T14:00:00.000Z'); // 16:00 CEST, not 09:00
    expect(r.events[0]?.summary).toBe('Wochenstart (verschoben)');
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
    expect(r.events[0]?.start).toBe('2026-08-10T14:00:00.000Z');
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

  it('marks an all-day event as such rather than inventing a clock time', () => {
    const r = parseIcsEvents(cal(
      `BEGIN:VEVENT
DTSTART;VALUE=DATE:20260814
DTEND;VALUE=DATE:20260815
SUMMARY:Ferientag
END:VEVENT`,
    ), AUG);
    expect(r.events[0]?.allDay).toBe(true);
    expect(r.events[0]?.summary).toBe('Ferientag');
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
    expect(r.events[0]?.start).toBe('2026-08-12T12:00:00.000Z');
  });
});
