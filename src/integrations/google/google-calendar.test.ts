import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createCalendarTool } from './google-calendar.js';
import type { IAgent, PromptText } from '../../types/index.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import type { GoogleAuth } from './google-auth.js';
import { FULL_SCOPES, SCOPES } from './google-auth.js';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';
import { InputRequiredError } from '../../core/input-required.js';

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
    usesServiceAccount: vi.fn().mockReturnValue(false),
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

    it('a confirmation nobody can answer ends the run — not a "Calendar error" text the model reads', async () => {
      const auth = createMockAuth(['https://www.googleapis.com/auth/calendar.events']);
      const tool = createCalendarTool(() => auth);
      await expect(tool.handler({
        action: 'create_event', summary: 'Test', start: '2026-03-20T10:00:00', end: '2026-03-20T11:00:00',
      }, { name: 'test', model: 'test-model', memory: null, tools: [], onStream: null, promptUser: vi.fn().mockRejectedValue(new InputRequiredError('Create it?')) } as unknown as IAgent)).rejects.toBeInstanceOf(InputRequiredError);
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

  describe('update_event', () => {
    const okUpdate = () => mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'ev1', summary: 'Meeting', start: { dateTime: '2026-03-20T10:00:00+01:00' }, end: { dateTime: '2026-03-20T11:00:00+01:00' }, htmlLink: 'https://calendar.google.com/event?eid=x' }),
    });
    const promptOf = (agent: IAgent): string => flattenPrompt((agent.promptUser as ReturnType<typeof vi.fn>).mock.calls[0]![0] as PromptText);
    const sentUrl = (): string => String(mockFetch.mock.calls[0]![0]);
    const sentBody = (): Record<string, unknown> => JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;
    const longText = 'Notes for the guest that run well past forty characters, all of them shown.';

    it('shows every changed field in full, guests one by one, and sends exactly that', async () => {
      const tool = createCalendarTool(() => createMockAuth());
      okUpdate();
      const agent = createMockAgent('Yes');
      await tool.handler({
        action: 'update_event', event_id: 'ev1', calendar_id: 'team@group.calendar.google.com',
        summary: 'Moved', attendees: ['a@example.org', 'b@example.org'],
        updates: { description: longText },
      }, agent);
      expect(promptOf(agent)).toBe([
        'Update event ev1',
        'Calendar: team@group.calendar.google.com',
        'These fields change:',
        `description: ${longText}`,
        'summary: Moved',
        'Guests (replace the current list): a@example.org, b@example.org',
        'Everyone listed under Guests can see this event.',
      ].join('\n'));
      expect(sentBody()).toEqual({ description: longText, summary: 'Moved', attendees: [{ email: 'a@example.org' }, { email: 'b@example.org' }] });
    });

    it('sends guests from the free-form updates object by address only, as shown', async () => {
      const tool = createCalendarTool(() => createMockAuth());
      okUpdate();
      const agent = createMockAgent('Yes');
      await tool.handler({
        action: 'update_event', event_id: 'ev1',
        updates: { attendees: [{ email: 'other@example.org', displayName: 'CEO', additionalGuests: 5 }] },
      }, agent);
      expect(promptOf(agent)).toContain('Guests (replace the current list): other@example.org');
      expect(sentBody()['attendees']).toEqual([{ email: 'other@example.org' }]);
    });

    it('says so when the update removes every guest', async () => {
      const tool = createCalendarTool(() => createMockAuth());
      okUpdate();
      const agent = createMockAgent('Yes');
      await tool.handler({ action: 'update_event', event_id: 'ev1', updates: { attendees: [] } }, agent);
      expect(promptOf(agent)).toContain('Guests: none — every current guest is removed');
      expect(sentBody()['attendees']).toEqual([]);
    });

    it('refuses a field it does not know, before asking', async () => {
      const tool = createCalendarTool(() => createMockAuth());
      const agent = createMockAgent('Yes');
      const result = await tool.handler({ action: 'update_event', event_id: 'ev1', updates: { Guests: 'none (unchanged)' } }, agent);
      expect(result).toContain('"Guests" is not an event field');
      expect(agent.promptUser).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refuses a guest without an email address, before asking', async () => {
      const tool = createCalendarTool(() => createMockAuth());
      const agent = createMockAgent('Yes');
      const result = await tool.handler({ action: 'update_event', event_id: 'ev1', updates: { attendees: [{ displayName: 'x' }] } }, agent);
      expect(result).toContain('needs an email address');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('keeps the event id inside its path segment', async () => {
      const tool = createCalendarTool(() => createMockAuth());
      okUpdate();
      await tool.handler({ action: 'update_event', event_id: 'ev1?sendUpdates=all', summary: 'x' }, createMockAgent('Yes'));
      expect(sentUrl()).toContain('/events/ev1%3FsendUpdates%3Dall');
      expect(sentUrl()).not.toContain('?sendUpdates=all');
    });

    it('sends nothing when the person declines', async () => {
      const tool = createCalendarTool(() => createMockAuth());
      const result = await tool.handler({ action: 'update_event', event_id: 'ev1', attendees: ['guest@example.org'] }, createMockAgent('No'));
      expect(result).toBe('Action cancelled by user.');
      expect(mockFetch).not.toHaveBeenCalled();
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

    it('keeps the event id inside its path segment, and names another calendar', async () => {
      const tool = createCalendarTool(() => createMockAuth());
      mockFetch.mockResolvedValueOnce({ ok: true });
      const agent = createMockAgent('Yes');
      await tool.handler({ action: 'delete_event', event_id: '../../x@group.calendar.google.com/events/ev2', calendar_id: 'team@group.calendar.google.com' }, agent);
      expect(String(mockFetch.mock.calls[0]![0])).toContain('/events/..%2F..%2Fx%40group.calendar.google.com%2Fevents%2Fev2');
      expect(flattenPrompt((agent.promptUser as ReturnType<typeof vi.fn>).mock.calls[0]![0] as PromptText)).toContain('Calendar: team@group.calendar.google.com');
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
