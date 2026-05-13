// Tests for the PRD §S1 calendar-URL scrubber. The scrubbing function runs
// inside Sentry's beforeSend/beforeBreadcrumb hooks; we test the pure helper
// in isolation since wiring it into Sentry requires a full SDK init.

import { describe, expect, it } from 'vitest';
import { _scrubCalendarUrlsForTest as scrub } from './error-reporting.js';

describe('scrubCalendarUrls', () => {
  it('redacts the token segment in a Google Calendar Secret-iCal URL', () => {
    const input = 'fetch failed: https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-deadbeef12345/basic.ics 404';
    const out = scrub(input);
    expect(out).toContain('https://calendar.google.com/<redacted-calendar-token>');
    expect(out).not.toContain('private-deadbeef12345');
    expect(out).not.toContain('basic.ics');
  });

  it('redacts iCloud caldav paths', () => {
    const input = 'CalDAV login failed for https://caldav.icloud.com/123456/calendars/abc-def/';
    const out = scrub(input);
    expect(out).toContain('https://caldav.icloud.com/<redacted-calendar-token>');
    expect(out).not.toContain('123456');
  });

  it('redacts webcal:// URLs', () => {
    const input = 'subscribed to webcal://example.com/webcal/SECRET-token-here/feed';
    const out = scrub(input);
    expect(out).toContain('<redacted-calendar-token>');
    expect(out).not.toContain('SECRET-token-here');
  });

  it('leaves non-calendar URLs alone', () => {
    const input = 'GET https://api.example.com/users/123 → 200';
    expect(scrub(input)).toBe(input);
  });

  it('redacts multiple calendar URLs in the same string', () => {
    const input = 'tried https://srv.example.com/ical/aaa-bbb/feed then https://other.example.com/caldav/xxx-yyy/';
    const out = scrub(input);
    const matches = (out.match(/<redacted-calendar-token>/g) ?? []).length;
    expect(matches).toBe(2);
    expect(out).not.toContain('aaa-bbb');
    expect(out).not.toContain('xxx-yyy');
  });

  it('handles strings without any URL', () => {
    expect(scrub('plain error message')).toBe('plain error message');
  });

  it('preserves the host for debuggability', () => {
    const input = 'https://caldav.icloud.com/8156990261/calendars/work/';
    const out = scrub(input);
    expect(out).toMatch(/caldav\.icloud\.com/);
  });
});
