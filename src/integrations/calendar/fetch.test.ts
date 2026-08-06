import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * These exist because the tool's own suite mocks this module wholesale — every line here could
 * have been inverted and stayed green. What is asserted is the part that is easy to get wrong
 * silently: which egress surface the request claims, and that no error carries the address.
 *
 * The URL is the credential. A message naming it travels into model context and the run
 * history, so "the error text" is a security surface and not a nicety.
 */

const fetchWithValidatedRedirects = vi.fn();
const readBodyLimited = vi.fn();

vi.mock('../../tools/builtin/http.js', () => ({
  fetchWithValidatedRedirects: (...args: unknown[]) => fetchWithValidatedRedirects(...args),
  readBodyLimited: (...args: unknown[]) => readBodyLimited(...args),
}));

const { fetchIcsFeed, MAX_ICS_BYTES } = await import('./fetch.js');
const { parseIcsEvents } = await import('./ics.js');

const SECRET_URL = 'https://calendar.example.com/ical/roland/private-9f3a7c21b4/basic.ics';

const VALID_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:a@t
DTSTART:20260812T120000Z
DTEND:20260812T130000Z
SUMMARY:Termin
END:VEVENT
END:VCALENDAR`;

function respond(ok: boolean, status = 200): void {
  fetchWithValidatedRedirects.mockResolvedValue({ response: { ok, status } });
}

beforeEach(() => {
  vi.clearAllMocks();
  respond(true);
  readBodyLimited.mockResolvedValue({ text: VALID_ICS, truncated: false });
});

describe('fetchIcsFeed', () => {
  it('reads a feed over the guarded path and returns its body', async () => {
    const r = await fetchIcsFeed(SECRET_URL);
    expect(r.ics).toBe(VALID_ICS);
    expect(r.truncated).toBe(false);
    expect(fetchWithValidatedRedirects.mock.calls[0]?.[0]).toBe(SECRET_URL);
  });

  it('claims the discovery egress surface, not full-control', async () => {
    // A read of a subscribed feed is the same shape as fetching a page. Asking for
    // full-control would make the operator allow-list a write-capable target to read their own
    // calendar; the surface argument is the only thing that decides it, and nothing else here
    // would notice if it changed.
    await fetchIcsFeed(SECRET_URL);
    expect(fetchWithValidatedRedirects.mock.calls[0]?.[2]).toBe('discovery');
  });

  it('reads at most MAX_ICS_BYTES', async () => {
    await fetchIcsFeed(SECRET_URL);
    expect(readBodyLimited.mock.calls[0]?.[1]).toBe(MAX_ICS_BYTES);
    expect(MAX_ICS_BYTES).toBe(5 * 1024 * 1024);
  });

  it('reports the status on a non-2xx without echoing the address', async () => {
    // 404 here usually means the secret address was reset — worth saying. The address that
    // produced it is not.
    respond(false, 404);
    await expect(fetchIcsFeed(SECRET_URL)).rejects.toThrow(/404/);
    await expect(fetchIcsFeed(SECRET_URL)).rejects.not.toThrow(/private-9f3a7c21b4|calendar\.example\.com/);
  });

  it('rejects an HTML error page served with a 200', async () => {
    // A reset or wrong address commonly returns a login page with a 200. Trusting the status
    // would tell the operator "no appointments" when the truth is "this link is dead".
    readBodyLimited.mockResolvedValue({ text: '<!doctype html><title>Sign in</title>', truncated: false });
    await expect(fetchIcsFeed(SECRET_URL)).rejects.toThrow(/not an iCalendar document/);
  });

  it('never lets a lower layer leak the host through its own error', async () => {
    // The egress guard refuses with a message naming the host it was handed. That message would
    // otherwise travel up unchanged — this asserts the translation at the boundary, which is
    // what makes the caller unable to leak by forgetting to.
    fetchWithValidatedRedirects.mockRejectedValue(
      new Error('Blocked: hostname "calendar.example.com" resolves to private IP "10.0.0.5"'),
    );
    await expect(fetchIcsFeed(SECRET_URL)).rejects.toThrow(/could not be reached/);
    await expect(fetchIcsFeed(SECRET_URL)).rejects.not.toThrow(/calendar\.example\.com|10\.0\.0\.5/);
  });

  it('repairs a body cut mid-event so the cap degrades instead of failing', async () => {
    // Without the repair the ceiling is a cliff: the document ends inside a property, the
    // parser throws on the partial line, and the operator is told the calendar is unreadable
    // rather than being given the events that did arrive.
    const cut = `${VALID_ICS.slice(0, VALID_ICS.indexOf('END:VCALENDAR'))}BEGIN:VEVENT
UID:b@t
DTSTART:20260813T120000Z
SUMM`;
    readBodyLimited.mockResolvedValue({ text: cut, truncated: true });
    const r = await fetchIcsFeed(SECRET_URL);
    expect(r.truncated).toBe(true);
    const parsed = parseIcsEvents(r.ics, { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') });
    expect(parsed.events.map(e => e.summary)).toEqual(['Termin']);
  });

  it('yields a parseable empty calendar when the cut left no complete event', async () => {
    readBodyLimited.mockResolvedValue({ text: 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTA', truncated: true });
    const r = await fetchIcsFeed(SECRET_URL);
    const parsed = parseIcsEvents(r.ics, { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') });
    expect(parsed.events).toEqual([]);
  });
});
