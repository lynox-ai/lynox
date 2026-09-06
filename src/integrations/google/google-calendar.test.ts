import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createCalendarTool } from './google-calendar.js';
import type { IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';
import { FULL_SCOPES, SCOPES } from './google-auth.js';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';

// §3.8 moved this module's calls onto the connector egress surface, so they now
// go through the pinned transport instead of `globalThis.fetch`. The bridge
// hands them back to the stub these tests already install; the policy gate is
// NOT bypassed. See the helper for why this is adapted rather than rewritten.
let restorePinnedFetchBridge: (() => void) | undefined;
beforeAll(() => { restorePinnedFetchBridge = installPinnedFetchBridge(); });
afterAll(() => { restorePinnedFetchBridge?.(); });

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Default: a FULLY granted BYO connection. These tests exercise the tool's
// mechanics, not its scope gate — the gate has its own tests, which pass a
// narrow list explicitly. Before the per-action gate existed the default was
// `[]`, i.e. every one of these read paths ran on a connection that had
// granted nothing, which is precisely the hole this wave closes.
function createMockAuth(scopes: string[] = [...FULL_SCOPES], ownPair = true): GoogleAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue('mock-token'),
    hasScope: vi.fn().mockImplementation((s: string) => scopes.includes(s)),
    hasOwnClientPair: vi.fn().mockReturnValue(ownPair),
  } as unknown as GoogleAuth;
}

function createMockAgent(promptAnswer?: string): IAgent {
  return {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    promptUser: promptAnswer !== undefined
      ? vi.fn().mockResolvedValue(promptAnswer)
      : undefined,
  } as unknown as IAgent;
}

describe('google_calendar tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_events', () => {
    it('lists upcoming events', async () => {
      const auth = createMockAuth();
      const tool = createCalendarTool(() => auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          summary: 'My Calendar',
          timeZone: 'Europe/Berlin',
          items: [
            {
              id: 'ev1',
              summary: 'Team Meeting',
              start: { dateTime: '2026-03-18T10:00:00+01:00' },
              end: { dateTime: '2026-03-18T11:00:00+01:00' },
              attendees: [
                { email: 'alice@example.com', responseStatus: 'accepted' },
              ],
            },
            {
              id: 'ev2',
              summary: 'Lunch',
              start: { date: '2026-03-18' },
              end: { date: '2026-03-18' },
            },
          ],
        }),
      });

      const result = await tool.handler({ action: 'list_events' }, createMockAgent());

      expect(result).toContain('Team Meeting');
      expect(result).toContain('Lunch');
      expect(result).toContain('alice@example.com');
      expect(result).toContain('My Calendar');
    });

    it('handles empty calendar', async () => {
      const auth = createMockAuth();
      const tool = createCalendarTool(() => auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

      const result = await tool.handler({ action: 'list_events' }, createMockAgent());
      expect(result).toContain('No events found');
    });
  });

  describe('create_event', () => {
    it('requires write scope', async () => {
      const auth = createMockAuth([]);
      const tool = createCalendarTool(() => auth);

      const result = await tool.handler({
        action: 'create_event',
        summary: 'Test Event',
        start: '2026-03-20T10:00:00+01:00',
        end: '2026-03-20T11:00:00+01:00',
      }, createMockAgent('Yes'));

      expect(result).toContain(SCOPES.CALENDAR_EVENTS);
    });

    it('creates event with confirmation', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/calendar.events']);
      const tool = createCalendarTool(() => auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'created1',
          summary: 'New Meeting',
          start: { dateTime: '2026-03-20T10:00:00+01:00' },
          end: { dateTime: '2026-03-20T11:00:00+01:00' },
          htmlLink: 'https://calendar.google.com/event?eid=...',
        }),
      });

      const result = await tool.handler({
        action: 'create_event',
        summary: 'New Meeting',
        start: '2026-03-20T10:00:00+01:00',
        end: '2026-03-20T11:00:00+01:00',
      }, createMockAgent('Yes'));

      expect(result).toContain('Event created');
      expect(result).toContain('New Meeting');
    });

    it('cancels on user decline', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/calendar.events']);
      const tool = createCalendarTool(() => auth);

      const result = await tool.handler({
        action: 'create_event',
        summary: 'Test',
        start: '2026-03-20T10:00:00',
        end: '2026-03-20T11:00:00',
      }, createMockAgent('No'));

      expect(result).toBe('Action cancelled by user.');
    });

    it('requires start and end', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/calendar.events']);
      const tool = createCalendarTool(() => auth);

      const result = await tool.handler({ action: 'create_event' }, createMockAgent('Yes'));
      expect(result).toContain('"start" is required');
    });
  });

  describe('delete_event', () => {
    it('deletes event with confirmation', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/calendar.events']);
      const tool = createCalendarTool(() => auth);

      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await tool.handler({
        action: 'delete_event',
        event_id: 'ev1',
      }, createMockAgent('Yes'));

      expect(result).toContain('deleted');
    });
  });

  describe('free_busy', () => {
    it('checks free/busy times', async () => {
      const auth = createMockAuth();
      const tool = createCalendarTool(() => auth);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          timeMin: '2026-03-17T00:00:00Z',
          timeMax: '2026-03-24T00:00:00Z',
          calendars: {
            primary: {
              busy: [
                { start: '2026-03-18T10:00:00Z', end: '2026-03-18T11:00:00Z' },
              ],
            },
          },
        }),
      });

      const result = await tool.handler({ action: 'free_busy' }, createMockAgent());

      expect(result).toContain('primary');
      expect(result).toContain('1 busy slots');
    });
  });

  describe('tool definition', () => {
    it('has correct name and schema', () => {
      const auth = createMockAuth();
      const tool = createCalendarTool(() => auth);

      expect(tool.definition.name).toBe('google_calendar');
      expect(tool.definition.input_schema.required).toEqual(['action']);
    });
  });
});
