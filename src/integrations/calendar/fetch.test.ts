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
    expect(fetchWithValidatedRedirects.mock.calls[0]?.[2]).toEqual({ surface: 'discovery' });
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

  it('is not fooled by the terminator literal inside an event title', async () => {
    // Same class as the component cap: an unanchored search finds `END:VEVENT` inside a
    // SUMMARY, and cutting there leaves the event containing it unterminated — reproducing
    // exactly the parse failure the repair exists to prevent, on attacker-chosen text.
    const cut = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:a@t
DTSTART:20260812T120000Z
DTEND:20260812T130000Z
SUMMARY:Termin
END:VEVENT
BEGIN:VEVENT
UID:b@t
DTSTART:20260813T120000Z
DTEND:20260813T130000Z
SUMMARY:Wie man END:VEVENT schreibt
DESCR`;
    readBodyLimited.mockResolvedValue({ text: cut, truncated: true });
    const r = await fetchIcsFeed(SECRET_URL);
    const parsed = parseIcsEvents(r.ics, { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') });
    expect(parsed.events.map(e => e.summary)).toEqual(['Termin']);
  });

  it('translates a failure while READING the body, not only while opening it', async () => {
    // A socket dropped mid-stream fails after the headers arrived. Leaving that path outside
    // the guard made the "every error is one of ours" claim false for exactly the errors
    // nobody writes a test for.
    readBodyLimited.mockRejectedValue(new Error('socket hang up on calendar.example.com'));
    await expect(fetchIcsFeed(SECRET_URL)).rejects.toThrow(/could not be read/);
    await expect(fetchIcsFeed(SECRET_URL)).rejects.not.toThrow(/calendar\.example\.com/);
  });

  it('yields a parseable empty calendar when the cut left no complete event', async () => {
    readBodyLimited.mockResolvedValue({ text: 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTA', truncated: true });
    const r = await fetchIcsFeed(SECRET_URL);
    const parsed = parseIcsEvents(r.ics, { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') });
    expect(parsed.events).toEqual([]);
  });
});

// PRD customer-granted-operator-access §3.9: a delegated session's feed read is recorded by its
// HOST before it is sent, every redirect hop too — never the path, which is the credential.
describe('fetchIcsFeed — a recorded read', () => {
  it('reports the host before the request and on every hop, and never the path', async () => {
    const hosts: string[] = [];
    const sentAtReport: number[] = [];
    await fetchIcsFeed(SECRET_URL, undefined, (h) => { hosts.push(h); sentAtReport.push(fetchWithValidatedRedirects.mock.calls.length); });
    expect(hosts).toEqual(['calendar.example.com']);
    expect(sentAtReport, 'reported before the request').toEqual([0]);
    const onRedirect = fetchWithValidatedRedirects.mock.calls[0]?.[7] as (u: string, m: string) => void;
    onRedirect('https://cdn.example.net/private-9f3a7c21b4/x.ics', 'GET');
    expect(hosts).toEqual(['calendar.example.com', 'cdn.example.net']);
  });

  it('sends nothing when the read cannot be recorded, and says so without the address', async () => {
    const { OutwardReadUnrecorded } = await import('../../core/audit-log.js');
    const err = await fetchIcsFeed(SECRET_URL, undefined, () => { throw new OutwardReadUnrecorded(); }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OutwardReadUnrecorded);
    expect(fetchWithValidatedRedirects).not.toHaveBeenCalled();
    expect(String(err)).not.toContain('private-9f3a7c21b4');
  });

  it('passes a hop that cannot be recorded on as such, not as an unreachable feed', async () => {
    const { OutwardReadUnrecorded } = await import('../../core/audit-log.js');
    fetchWithValidatedRedirects.mockRejectedValueOnce(new OutwardReadUnrecorded());
    await expect(fetchIcsFeed(SECRET_URL, undefined, () => {})).rejects.toBeInstanceOf(OutwardReadUnrecorded);
  });
});

// A stop of the run ends the feed read, and says it was stopped: "could not be reached" would tell
// the model the calendar is down, and agent.ts gives an AbortError the stop's own sentence.
describe('fetchIcsFeed — a stopped run', () => {
  /** Rejects the way a fetch does once its signal aborts, after the test stopped the call. Hands
   *  back whether the request's signal saw the stop — read by the test, not asserted in here,
   *  where a failed assert would be caught by fetchIcsFeed and read as the stop itself. */
  function failOnceStopped(call: AbortController): { reached?: boolean } {
    const seen: { reached?: boolean } = {};
    fetchWithValidatedRedirects.mockImplementation(async (_u: string, init: RequestInit) => {
      call.abort();
      seen.reached = init.signal?.aborted === true;
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    return seen;
  }

  it('ends the request and leaves as an AbortError without the address', async () => {
    const { runInCallSlot } = await import('../../core/call-connection.js');
    const call = new AbortController();
    const seen = failOnceStopped(call);
    const err = await runInCallSlot({ abort: call }, () => fetchIcsFeed(SECRET_URL)).then(() => null, (e: unknown) => e);
    expect(seen.reached, 'the stop reached the request').toBe(true);
    expect((err as Error).name).toBe('AbortError');
    expect(String(err)).not.toMatch(/could not be reached|private-9f3a7c21b4|calendar\.example\.com/);
  });

  it('a stop while the body is read is a stop too, not an unreadable feed', async () => {
    const { runInCallSlot } = await import('../../core/call-connection.js');
    const call = new AbortController();
    readBodyLimited.mockImplementation(async () => { call.abort(); throw new Error('socket hang up on calendar.example.com'); });
    const err = await runInCallSlot({ abort: call }, () => fetchIcsFeed(SECRET_URL)).then(() => null, (e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(String(err)).not.toMatch(/could not be read|calendar\.example\.com/);
  });

  it('a failure in a call that was not stopped still reads as unreachable', async () => {
    const { runInCallSlot } = await import('../../core/call-connection.js');
    fetchWithValidatedRedirects.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(runInCallSlot({ abort: new AbortController() }, () => fetchIcsFeed(SECRET_URL))).rejects.toThrow(/could not be reached/);
  });

  it('keeps its own limit inside a call: the signal is joined, not replaced', async () => {
    const { runInCallSlot } = await import('../../core/call-connection.js');
    const call = new AbortController();
    await runInCallSlot({ abort: call }, () => fetchIcsFeed(SECRET_URL));
    const sent = (fetchWithValidatedRedirects.mock.calls[0]?.[1] as RequestInit).signal;
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent).not.toBe(call.signal);
  });
});
