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

  // The component ceiling is the one limit an attacker attacks directly, and three separate
  // text-level implementations of it were each defeated by one calendar invitation. These are
  // those three payloads. They pass now for a structural reason rather than a cleverer pattern:
  // the ceiling is applied to PARSED components, so what counts as a component is ical.js's
  // decision and there is no literal left to forge.
  describe.each([
    ['the boundary literal repeated in a DESCRIPTION', () => Array.from({ length: 5001 }, () => 'BEGIN:VEVENT').join(' ')],
    ['the literal after U+2028, a JS line terminator RFC 5545 allows in a value', () => Array.from({ length: 5001 }, () => ' BEGIN:VEVENT').join('')],
    ['the literal after U+2029', () => Array.from({ length: 5001 }, () => ' BEGIN:VEVENT').join('')],
  ])('a DESCRIPTION carrying %s', (_label, payload) => {
    it('neither breaks the feed nor hides the real appointment', () => {
      const r = parseIcsEvents(cal(
        `BEGIN:VEVENT
UID:echt@t
DTSTART:20260812T120000Z
DTEND:20260812T130000Z
SUMMARY:Echter Termin
DESCRIPTION:${payload()}
END:VEVENT`,
      ), AUG);
      expect(r.events.map(e => e.summary)).toEqual(['Echter Termin']);
      expect(r.truncated).toBe(false);
    });
  });

  it('counts lower-case component names, which RFC 5545 makes equivalent', () => {
    // `begin:vevent` is legal — component names are case-insensitive — and ical.js parses it
    // into ordinary components. A ceiling that matches the upper-case literal simply does not
    // see 5,001 of them, so the cap it enforces is not a cap.
    const many = Array.from({ length: 5001 }, (_, i) =>
      `begin:vevent\nUID:l${String(i)}@t\nDTSTART:20260812T120000Z\nDTEND:20260812T235900Z\nSUMMARY:L${String(i)}\nend:vevent`);
    const r = parseIcsEvents(cal(...many), { ...AUG, maxEvents: 99_999 });
    expect(r.truncated).toBe(true);
    expect(r.events.length).toBeLessThanOrEqual(5000);
  });

  it('does not treat a FOLDED continuation line as a component boundary', () => {
    // RFC 5545 folds a long line by indenting the continuation. A payload that lands at the
    // start of such a line is still inside the value it belongs to.
    const r = parseIcsEvents([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
      'BEGIN:VEVENT', 'UID:f@t', 'DTSTART:20260812T120000Z', 'DTEND:20260812T130000Z',
      'SUMMARY:Gefaltet', 'DESCRIPTION:erste Zeile', ' BEGIN:VEVENT getarnt',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n'), AUG);
    expect(r.events.map(e => e.summary)).toEqual(['Gefaltet']);
  });

  it('cuts a CRLF feed cleanly', () => {
    // Real feeds use CRLF. Slicing at the boundary without accounting for it leaves a stray
    // carriage return where the closing line is appended.
    const ev = (i: number) =>
      `BEGIN:VEVENT\r\nUID:e${String(i)}@t\r\nDTSTART:20260812T120000Z\r\nDTEND:20260812T130000Z\r\nSUMMARY:E${String(i)}\r\nEND:VEVENT`;
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${Array.from({ length: 6000 }, (_, i) => ev(i)).join('\r\n')}\r\nEND:VCALENDAR`;
    const r = parseIcsEvents(ics, { ...AUG, maxEvents: 6000 });
    expect(r.events).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });

  it('trips the ceiling on OTHER components too, not just on events', () => {
    // The cost is `new ICAL.Event()` scanning the whole enclosing calendar, so it is driven by
    // the total component count — while a VEVENT-only trigger sees 5,000 and waves it through.
    // Measured on the earlier version: 5,000 events beside 138,000 VTODOs took 14.5 s, and the
    // same feed with one event MORE took 1.1 s. Staying under the ceiling was 13× dearer than
    // crossing it, which is precisely backwards.
    const events = Array.from({ length: 4000 }, (_, i) =>
      `BEGIN:VEVENT\nUID:e${String(i)}@t\nDTSTART:20260812T120000Z\nDTEND:20260812T235900Z\nSUMMARY:E${String(i)}\nEND:VEVENT`);
    const todos = Array.from({ length: 4000 }, (_, i) =>
      `BEGIN:VTODO\nUID:t${String(i)}@t\nDTSTAMP:20260812T120000Z\nSUMMARY:T${String(i)}\nEND:VTODO`);
    const r = parseIcsEvents(cal(...events, ...todos), { ...AUG, maxEvents: 99_999 });
    expect(r.truncated).toBe(true);
  });

  it('does not carry an unbounded number of zone definitions', () => {
    // Carrying every VTIMEZONE reintroduced the same cost by another door — 112,000 zones put
    // `new ICAL.Event()` back at 12 s. The kept events still resolve their own zone.
    const zones = Array.from({ length: 300 }, (_, i) =>
      `BEGIN:VTIMEZONE\nTZID:Zone/Z${String(i)}\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0000\nEND:STANDARD\nEND:VTIMEZONE`);
    const events = Array.from({ length: 5001 }, (_, i) =>
      `BEGIN:VEVENT\nUID:z${String(i)}@t\nDTSTART;TZID=Europe/Zurich:20260812T140000\nDTEND;TZID=Europe/Zurich:20260812T150000\nSUMMARY:Z${String(i)}\nEND:VEVENT`);
    const started = Date.now();
    const r = parseIcsEvents([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', TZ, ...zones, ...events, 'END:VCALENDAR',
    ].join('\n'), { ...AUG, maxEvents: 10 });
    expect(r.truncated).toBe(true);
    expect(r.events[0]?.timezone).toBe('Europe/Zurich');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('keeps a VTIMEZONE that sits AFTER the events when it cuts', () => {
    // RFC 5545 fixes no order between components. Cutting the tail away takes the zone
    // definition with it, and every kept event silently degrades to a floating time — a wrong
    // clock with no error, which is worse than a visible failure.
    const many = Array.from({ length: 6000 }, (_, i) =>
      `BEGIN:VEVENT\nUID:z${String(i)}@t\nDTSTART;TZID=Europe/Zurich:20260812T140000\nDTEND;TZID=Europe/Zurich:20260812T150000\nSUMMARY:Z${String(i)}\nEND:VEVENT`);
    const r = parseIcsEvents([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
      ...many, TZ, 'END:VCALENDAR',
    ].join('\n'), { ...AUG, maxEvents: 6000 });
    expect(r.truncated).toBe(true);
    expect(r.events[0]?.timezone).toBe('Europe/Zurich');
    expect(r.events[0]?.start).toBe('2026-08-12T14:00:00');
  });

  it('reads an event whose TZID the feed never defines, without inventing a zone', () => {
    // A producer that references a zone it does not embed is common enough to matter. ical.js
    // degrades such a time to floating; reporting the named-but-undefined zone would attach a
    // confident offset the feed never established.
    const r = parseIcsEvents([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
      `BEGIN:VEVENT
UID:undefzone@t
DTSTART;TZID=Mars/Olympus:20260812T140000
DTEND;TZID=Mars/Olympus:20260812T150000
SUMMARY:Unbekannte Zone
END:VEVENT`,
      'END:VCALENDAR',
    ].join('\n'), AUG);
    expect(r.events[0]?.summary).toBe('Unbekannte Zone');
    expect(r.events[0]?.start).toBe('2026-08-12T14:00:00');
    expect(r.events[0]?.timezone).toBeUndefined();
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

describe('a recurrence rule whose date can never exist', () => {
  /**
   * This is the one case the iteration budget cannot cover, and the tests that came before it
   * could not see the difference.
   *
   * ical.js expands a contracting rule by walking the calendar until the BY* parts match, and
   * it gives up after a bounded search — but only for MONTHLY and YEARLY. For DAILY and below
   * there is no counter, so a rule that can never match spins inside ONE `it.next()` and never
   * returns. The budget is decremented between calls, so it is never read again; nothing is
   * thrown, so the catch never fires; and because the loop is synchronous on the single JS
   * thread, no timer fires either. One appointment takes the tenant's whole engine down, and
   * restarting only helps until the next read, because the feed still carries the rule.
   *
   * The existing hang test uses `FREQ=SECONDLY` with no BY parts. That terminates cleanly on
   * every call and the budget stops it, so it passes either way — it cannot fail for this.
   *
   * `maxEvents` is deliberately generous below: with a small cap a passing run would prove only
   * that the cap was hit, not that the rule was refused before expansion.
   */
  const YEAR = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z'), maxEvents: 5000 };
  const withRule = (rule: string): string => [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:x@y', 'DTSTAMP:20200101T000000Z',
    'DTSTART:20200101T100000Z', 'DTEND:20200101T110000Z', 'SUMMARY:Serie',
    rule, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\n');

  it.each([
    // Impossible arithmetic — the family the guard was originally written for.
    ['30 February, daily',        'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'],
    ['31 February, daily',        'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=31'],
    ['31 April/June, daily',      'RRULE:FREQ=DAILY;BYMONTH=4,6;BYMONTHDAY=31'],
    // Possible but UNBOUNDABLE below MONTHLY — every one measured at 60-75 s before the fix,
    // and none of them caught by the impossible-date arithmetic, which reads -1 as a legal day.
    // The first is the one an ordinary exporter can really emit.
    ['last day of month, daily',  'RRULE:FREQ=DAILY;BYMONTHDAY=-1'],
    ['last Friday, daily',        'RRULE:FREQ=DAILY;BYDAY=-1FR'],
    ['2nd Monday, daily',         'RRULE:FREQ=DAILY;BYDAY=2MO'],
    ['week number, weekly',       'RRULE:FREQ=WEEKLY;BYWEEKNO=10'],
    ['day of year, daily',        'RRULE:FREQ=DAILY;BYYEARDAY=200'],
    ['last day of month, hourly', 'RRULE:FREQ=HOURLY;BYMONTHDAY=-1'],
    ['negative set position',     'RRULE:FREQ=DAILY;BYSETPOS=-1;BYDAY=MO'],
    // A SECOND rule line. RFC 5545 permits it and ical.js merges all of them, so a guard that
    // read only the first was bypassed by putting anything harmless in front of the impossible
    // one: 70 s on a feed whose single-rule form is refused in 1 ms.
    ['impossible rule behind a harmless one',
      'RRULE:FREQ=DAILY;COUNT=3\nRRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'],
  ])('returns instead of hanging: %s', (_label, rule) => {
    const started = performance.now();
    const r = parseIcsEvents(withRule(rule), YEAR);
    // The real failure detector is `skipped` below — with the guard removed this call still
    // RETURNS, just after 60-75 s, so the suite fails on the assertion rather than on a
    // deadlock. This bound is the separate claim that refusing is CHEAP: it runs in ~1 ms, so
    // a two-second ceiling catches a guard that starts doing real work without being noticed.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(r.events).toHaveLength(0);
    // Reported as unreadable rather than silently dropped: the operator is told a series is
    // missing instead of believing the calendar is empty.
    expect(r.skipped).toBeGreaterThan(0);
  });

  it.each([
    ['29 February — a real leap-day series', 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', 0],
    ['the 31st of every month',              'RRULE:FREQ=MONTHLY;BYMONTHDAY=31',           7],
    ['every day in February',                'RRULE:FREQ=DAILY;BYMONTH=2',                28],
    ['every Monday',                         'RRULE:FREQ=WEEKLY;BYDAY=MO',                52],
    ['the last day of every month',          'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1',          12],
    ['the 30th of April and June',           'RRULE:FREQ=YEARLY;BYMONTH=4,6;BYMONTHDAY=30', 2],
    // The rows that pin the SECOND family's boundary. Each is one step away from a refused rule
    // — same BY* part, either a positive value or a frequency ical.js can bound — so a guard
    // that reached one notch too far empties them.
    ['the 15th of every month, daily',       'RRULE:FREQ=DAILY;BYMONTHDAY=15',            12],
    ['the 1st and 15th, daily',              'RRULE:FREQ=DAILY;BYMONTHDAY=1,15',          24],
    ['Mondays and Fridays',                  'RRULE:FREQ=WEEKLY;BYDAY=MO,FR',            104],
    ['last Friday in November, yearly',      'RRULE:FREQ=YEARLY;BYDAY=-1FR;BYMONTH=11',    1],
  ])('still expands: %s', (_label, rule, expected) => {
    // The other direction, and it carries the weight: a guard that refuses "unusual" rules
    // instead of unexpandable ones would pass every assertion above while quietly emptying real
    // calendars. 2026 is not a leap year, so the first row legitimately yields nothing — but it
    // must reach that answer by EXPANDING, which `skipped === 0` is what pins.
    const r = parseIcsEvents(withRule(rule), YEAR);
    expect(r.skipped).toBe(0);
    expect(r.events).toHaveLength(expected);
  });

  it('keeps the plain RDATEs of a refused event even when a PERIOD RDATE sits beside them', () => {
    // The first version of the rescue duck-typed on `.compare` to skip PERIOD values —
    // and `ICAL.Period` HAS `compare`, so nothing was skipped: `addDuration` threw, the outer
    // catch abandoned the whole VEVENT, and the ordinary RDATEs went with it. Measured before
    // this: 0 events. The rescue was worse than no rescue for this feed.
    const r = parseIcsEvents(withRule(
      'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30\n'
      + 'RDATE;VALUE=PERIOD:20260805T090000Z/20260805T103000Z\n'
      + 'RDATE:20260812T090000Z',
    ), YEAR);
    // Both survive, and the PERIOD keeps its OWN end rather than inheriting the series duration.
    expect(r.events.map(e => e.start)).toEqual(['2026-08-05T09:00:00Z', '2026-08-12T09:00:00Z']);
    expect(r.events[0]?.end).toBe('2026-08-05T10:30:00Z');
  });

  it('keeps the explicit RDATE dates of an event whose RULE is refused', () => {
    // The rule is what cannot be expanded; a fixed date needs no iterator. Dropping the whole
    // VEVENT made a malformed rule swallow real appointments as collateral — measured: this
    // feed returned 0 events before the fix.
    const r = parseIcsEvents(withRule(
      'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30\nRDATE:20260805T090000Z\nRDATE:20260812T090000Z',
    ), YEAR);
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.events.map(e => e.start)).toEqual(['2026-08-05T09:00:00Z', '2026-08-12T09:00:00Z']);
  });

  it('disarms an unexpandable rule inside a VTIMEZONE and keeps the appointment', () => {
    // A DST transition is a recurrence too, expanded by a DIFFERENT path (`Timezone.
    // _expandComponent`, reached by resolving a TZID) that the VEVENT guard never sees. This
    // feed has NO event rule at all and still blocked the thread for 73 s — and lost the event.
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VTIMEZONE', 'TZID:Evil/Zone',
      'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100',
      'TZNAME:EVL', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:tz@y', 'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=Evil/Zone:20260805T090000', 'DTEND;TZID=Evil/Zone:20260805T100000',
      'SUMMARY:Zonentermin', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\n');

    const started = performance.now();
    const r = parseIcsEvents(ics, YEAR);
    expect(performance.now() - started).toBeLessThan(2_000);
    // The zone keeps its base offset, so the appointment survives with its wall time intact —
    // only the seasonal transition is gone. Dropping the zone would have degraded it to
    // floating and refusing the feed would have hidden the whole calendar.
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.summary).toBe('Zonentermin');
    expect(r.events[0]?.start).toBe('2026-08-05T09:00:00');
    expect(r.skipped).toBeGreaterThan(0);
  });
});
