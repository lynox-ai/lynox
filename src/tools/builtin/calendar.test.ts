import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calendarReadTool, CALENDAR_FEED_PREFIX } from './calendar.js';
import { isInfraSecret } from '../../core/secret-store.js';
import type { IAgent } from '../../types/index.js';

vi.mock('../../integrations/calendar/fetch.js', () => ({
  fetchIcsFeed: vi.fn(),
  MAX_ICS_BYTES: 5 * 1024 * 1024,
}));
const { fetchIcsFeed } = await import('../../integrations/calendar/fetch.js');

const TZ_ICS = (...events: string[]): string => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...events, 'END:VCALENDAR',
].join('\n');

function agentWith(secrets: Record<string, string>): IAgent {
  return {
    toolContext: {},
    secretStore: {
      listNames: () => Object.keys(secrets),
      resolve: (n: string) => secrets[n] ?? null,
    },
  } as unknown as IAgent;
}

describe('calendar_read', () => {
  beforeEach(() => { vi.mocked(fetchIcsFeed).mockReset(); });

  it('THE BOUNDARY: the feed address is an infrastructure secret, invisible to the model', () => {
    // The URL is the whole access control — anyone holding it reads the calendar. Classing it
    // with the mail credentials keeps `resolveSecretRefs` from ever substituting it into agent
    // tool input, which is what would let a prompt-injected turn post it to another host. It
    // matches none of the vendor-prefixed shapes the egress body scan looks for, so this
    // classification is the control, not the scan.
    expect(isInfraSecret(`${CALENDAR_FEED_PREFIX}MAIN`)).toBe(true);
  });

  it('takes no url parameter at all', () => {
    // Not "does not require" — cannot accept. A URL the model can name reaches the run history.
    const props = calendarReadTool.definition.input_schema.properties ?? {};
    expect(Object.keys(props)).not.toContain('url');
    expect(calendarReadTool.definition.input_schema.required ?? []).toHaveLength(0);
  });

  it('says how to connect one when none is configured, instead of failing blankly', async () => {
    const out = await calendarReadTool.handler({}, agentWith({}));
    expect(out).toContain('No calendar is connected');
    expect(out).toContain('Secret address in iCal format');
  });

  it('lists appointments in the window', async () => {
    vi.mocked(fetchIcsFeed).mockResolvedValue({
      ics: TZ_ICS(`BEGIN:VEVENT
DTSTART:20260812T120000Z
DTEND:20260812T130000Z
SUMMARY:Termin Roland
LOCATION:St. Gallen
END:VEVENT`),
      truncated: false,
    });
    const out = await calendarReadTool.handler(
      { from: '2026-08-01', to: '2026-08-31' },
      agentWith({ [`${CALENDAR_FEED_PREFIX}MAIN`]: 'https://calendar.example/secret/basic.ics' }),
    );
    expect(out).toContain('Termin Roland');
    expect(out).toContain('St. Gallen');
    expect(out).toContain('1 appointment');
  });

  it('never echoes the feed address, not even on success', async () => {
    // The result travels into model context and the transcript.
    const url = 'https://calendar.example/private-abc123secret/basic.ics';
    vi.mocked(fetchIcsFeed).mockResolvedValue({
      ics: TZ_ICS(`BEGIN:VEVENT
DTSTART:20260812T120000Z
DTEND:20260812T130000Z
SUMMARY:Termin
END:VEVENT`),
      truncated: false,
    });
    const out = await calendarReadTool.handler(
      { from: '2026-08-01', to: '2026-08-31' },
      agentWith({ [`${CALENDAR_FEED_PREFIX}MAIN`]: url }),
    );
    expect(out).not.toContain('private-abc123secret');
    expect(out).not.toContain(url);
  });

  it('distinguishes "could not reach it" from "nothing on"', async () => {
    // The two answers look alike and only one is safe to act on: telling someone their
    // afternoon is free when the calendar was unreachable is how a double-booking happens.
    vi.mocked(fetchIcsFeed).mockRejectedValue(new Error('calendar feed responded 404'));
    const out = await calendarReadTool.handler(
      { from: '2026-08-01', to: '2026-08-31' },
      agentWith({ [`${CALENDAR_FEED_PREFIX}MAIN`]: 'https://calendar.example/x.ics' }),
    );
    expect(out).toContain('Could not read');
    expect(out).toContain('incomplete');
  });

  it('says when the list was cut short rather than implying completeness', async () => {
    vi.mocked(fetchIcsFeed).mockResolvedValue({
      ics: TZ_ICS(`BEGIN:VEVENT
DTSTART:20260812T120000Z
DTEND:20260812T130000Z
SUMMARY:Termin
END:VEVENT`),
      truncated: true,
    });
    const out = await calendarReadTool.handler(
      { from: '2026-08-01', to: '2026-08-31' },
      agentWith({ [`${CALENDAR_FEED_PREFIX}MAIN`]: 'https://calendar.example/x.ics' }),
    );
    expect(out).toContain('cut short');
  });

  it('refuses a window longer than the cap', async () => {
    const out = await calendarReadTool.handler(
      { from: '2026-01-01', to: '2026-12-31' },
      agentWith({ [`${CALENDAR_FEED_PREFIX}MAIN`]: 'https://calendar.example/x.ics' }),
    );
    expect(out).toMatch(/at most/);
    expect(fetchIcsFeed).not.toHaveBeenCalled();
  });

  it('refuses a backwards window', async () => {
    const out = await calendarReadTool.handler(
      { from: '2026-08-31', to: '2026-08-01' },
      agentWith({ [`${CALENDAR_FEED_PREFIX}MAIN`]: 'https://calendar.example/x.ics' }),
    );
    expect(out).toContain('ends before it starts');
    expect(fetchIcsFeed).not.toHaveBeenCalled();
  });

  it('reads every connected calendar when none is named, and labels the rows', async () => {
    vi.mocked(fetchIcsFeed).mockResolvedValue({
      ics: TZ_ICS(`BEGIN:VEVENT
DTSTART:20260812T120000Z
DTEND:20260812T130000Z
SUMMARY:Termin
END:VEVENT`),
      truncated: false,
    });
    const out = await calendarReadTool.handler(
      { from: '2026-08-01', to: '2026-08-31' },
      agentWith({
        [`${CALENDAR_FEED_PREFIX}WORK`]: 'https://a.example/x.ics',
        [`${CALENDAR_FEED_PREFIX}BOOKINGS`]: 'https://b.example/y.ics',
      }),
    );
    expect(fetchIcsFeed).toHaveBeenCalledTimes(2);
    expect(out).toContain('[WORK]');
    expect(out).toContain('[BOOKINGS]');
  });

  it('reads only the named calendar when one is given', async () => {
    vi.mocked(fetchIcsFeed).mockResolvedValue({ ics: TZ_ICS(), truncated: false });
    await calendarReadTool.handler(
      { calendar: 'work', from: '2026-08-01', to: '2026-08-31' },
      agentWith({
        [`${CALENDAR_FEED_PREFIX}WORK`]: 'https://a.example/x.ics',
        [`${CALENDAR_FEED_PREFIX}BOOKINGS`]: 'https://b.example/y.ics',
      }),
    );
    expect(fetchIcsFeed).toHaveBeenCalledTimes(1);
  });
});
