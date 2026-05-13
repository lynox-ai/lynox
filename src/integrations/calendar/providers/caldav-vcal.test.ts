// Tests for the pure VCALENDAR build / escape helpers exposed from
// `caldav.ts`. The rest of the adapter (login, fetchCalendars, ETag plumbing)
// needs a tsdav mock and lives in Phase 1c. These two helpers are pure and
// drive the PRD §S1/§S2/§S3 escape claims, so they ship with the blocker fix
// itself.

import { describe, expect, it } from 'vitest';
import { buildVCalendar, escapeIcalText } from './caldav.js';
import type { CalendarEventInput } from '../../../types/calendar.js';

describe('escapeIcalText', () => {
  it('escapes RFC 5545 TEXT special chars', () => {
    expect(escapeIcalText('a,b;c\\d')).toBe('a\\,b\\;c\\\\d');
  });

  it('escapes backslash BEFORE other delimiters', () => {
    // If `;` were escaped first we would emit `\\;` and then escape the
    // injected backslash producing `\\\\;`. Order matters.
    expect(escapeIcalText('\\;')).toBe('\\\\\\;');
  });

  it('collapses CRLF, LF, and bare CR to literal \\n', () => {
    expect(escapeIcalText('line1\r\nline2\nline3\rline4')).toBe('line1\\nline2\\nline3\\nline4');
  });

  it('normalizes Unicode line-separators (NEL / LS / PS) to LF', () => {
    expect(escapeIcalText('ab c d')).toBe('a\\nb\\nc\\nd');
  });

  it('strips ASCII C0 control chars except TAB', () => {
    // \x09 (TAB) survives; \x00, \x01, \x07, \x1f, \x7f get stripped.
    expect(escapeIcalText('a\x00b\x07c\x1fd\x7fe\tf')).toBe('abcde\tf');
  });

  it('blocks VEVENT-smuggling via embedded CRLF + BEGIN:VEVENT', () => {
    const malicious = 'innocent\r\nBEGIN:VEVENT\r\nUID:hijack@evil';
    const escaped = escapeIcalText(malicious);
    expect(escaped).not.toContain('\r');
    expect(escaped).not.toContain('\n');
    expect(escaped).toContain('\\n');
    expect(escaped).toContain('BEGIN:VEVENT'); // still present as literal text but on the same line
  });
});

describe('buildVCalendar', () => {
  const minimalEvent: CalendarEventInput = {
    summary: 'Meeting',
    start: '2026-05-20T14:00:00Z',
    end: '2026-05-20T15:00:00Z',
  };

  it('emits CRLF line endings', () => {
    const out = buildVCalendar('uid-1', minimalEvent);
    expect(out).toContain('\r\n');
    // No bare LF that isn't part of a CRLF.
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('wraps the event in BEGIN/END:VCALENDAR + BEGIN/END:VEVENT', () => {
    const out = buildVCalendar('uid-1', minimalEvent);
    expect(out).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(out).toContain('BEGIN:VEVENT');
    expect(out).toContain('END:VEVENT');
    expect(out).toMatch(/END:VCALENDAR$/);
  });

  it('includes UID, DTSTAMP, DTSTART, DTEND, SUMMARY', () => {
    const out = buildVCalendar('test-uid@lynox.ai', minimalEvent);
    expect(out).toContain('UID:test-uid@lynox.ai');
    expect(out).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
    expect(out).toContain('DTSTART:20260520T140000Z');
    expect(out).toContain('DTEND:20260520T150000Z');
    expect(out).toContain('SUMMARY:Meeting');
  });

  it('emits DATE (no time) and VALUE=DATE param for all_day events', () => {
    const out = buildVCalendar('uid-2', { ...minimalEvent, all_day: true });
    expect(out).toContain('DTSTART;VALUE=DATE:20260520');
    expect(out).toContain('DTEND;VALUE=DATE:20260520');
    expect(out).not.toContain('DTSTART:20260520T'); // no time component
  });

  it('escapes special chars in SUMMARY / DESCRIPTION / LOCATION', () => {
    const out = buildVCalendar('uid-3', {
      ...minimalEvent,
      summary: 'A, B; C',
      description: 'line1\nline2',
      location: 'Room\\1',
    });
    expect(out).toContain('SUMMARY:A\\, B\\; C');
    expect(out).toContain('DESCRIPTION:line1\\nline2');
    expect(out).toContain('LOCATION:Room\\\\1');
  });

  it('emits one ATTENDEE line per attendee, with optional CN param', () => {
    const out = buildVCalendar('uid-4', {
      ...minimalEvent,
      attendees: [
        { email: 'alice@example.com', name: 'Alice' },
        { email: 'bob@example.com' },
      ],
    });
    expect(out).toContain('ATTENDEE;RSVP=TRUE;CN=Alice:mailto:alice@example.com');
    expect(out).toContain('ATTENDEE;RSVP=TRUE:mailto:bob@example.com');
  });

  it('emits one RRULE line per recurrence rule', () => {
    const out = buildVCalendar('uid-5', {
      ...minimalEvent,
      recurrence: ['FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=YEARLY'],
    });
    expect(out).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(out).toContain('RRULE:FREQ=YEARLY');
  });

  it('upper-cases STATUS', () => {
    const out = buildVCalendar('uid-6', { ...minimalEvent, status: 'tentative' });
    expect(out).toContain('STATUS:TENTATIVE');
  });
});
