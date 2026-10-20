import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createCalendarTool } from './google-calendar.js';
import { createDriveTool } from './google-drive.js';
import { createSheetsTool } from './google-sheets.js';
import { createDocsTool } from './google-docs.js';
import type { IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';
import { FULL_SCOPES } from './google-auth.js';
import { runInCallSlot } from '../../core/call-connection.js';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';

/**
 * A stop of the run reaches the Google tools' READ actions and no write. Each case runs one
 * action inside a call slot, then stops the call and looks at the signal its request carried.
 */

let restorePinnedFetchBridge: (() => void) | undefined;
beforeAll(() => { restorePinnedFetchBridge = installPinnedFetchBridge(); });
afterAll(() => { restorePinnedFetchBridge?.(); });

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function auth(): GoogleAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue('mock-token'),
    hasScope: vi.fn().mockReturnValue(true),
    hasOwnClientPair: vi.fn().mockReturnValue(true),
    usesServiceAccount: vi.fn().mockReturnValue(false),
    grantedScopes: [...FULL_SCOPES],
  } as unknown as GoogleAuth;
}

function agent(): IAgent {
  return { name: 'test', model: 'm', memory: null, tools: [], onStream: null, promptUser: vi.fn().mockResolvedValue('Yes') } as unknown as IAgent;
}

/** One answer that every action below can read without failing before its request. */
function anyAnswer(): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: async () => ({ items: [], files: [], values: [], calendars: {}, id: 'x', name: 'a.txt', mimeType: 'text/plain', size: '3', body: { content: [] }, title: 't' }),
    text: async () => 'abc',
  };
}

/** The signals the requests of `run` carried, after the call was stopped. */
async function signalsAfterStop(run: () => Promise<unknown>): Promise<{ call: AbortSignal; sent: AbortSignal[] }> {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => anyAnswer());
  const call = new AbortController();
  await runInCallSlot({ abort: call }, run);
  call.abort();
  const sent = mockFetch.mock.calls.map((c) => (c[1] as RequestInit).signal as AbortSignal);
  return { call: call.signal, sent };
}

describe('a stop of the run reaches Google reads', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const reads: Array<[string, () => Promise<unknown>]> = [
    ['calendar list_events', () => createCalendarTool(() => auth()).handler({ action: 'list_events' } as never, agent())],
    ['calendar free_busy', () => createCalendarTool(() => auth()).handler({ action: 'free_busy', time_min: '2026-03-20T00:00:00Z', time_max: '2026-03-21T00:00:00Z' } as never, agent())],
    ['drive search', () => createDriveTool(() => auth()).handler({ action: 'search', query: 'name contains "a"' } as never, agent())],
    ['drive read', () => createDriveTool(() => auth()).handler({ action: 'read', file_id: 'f1' } as never, agent())],
    ['drive list', () => createDriveTool(() => auth()).handler({ action: 'list' } as never, agent())],
    ['sheets read', () => createSheetsTool(() => auth()).handler({ action: 'read', spreadsheet_id: 's1', range: 'A1:B2' } as never, agent())],
    ['sheets list', () => createSheetsTool(() => auth()).handler({ action: 'list' } as never, agent())],
    ['docs read', () => createDocsTool(() => auth()).handler({ action: 'read', document_id: 'd1' } as never, agent())],
  ];

  for (const [name, run] of reads) {
    it(`${name}: its request ends with the call, and keeps its own limit`, async () => {
      const { call, sent } = await signalsAfterStop(run);
      expect(sent.length, 'a request went out').toBeGreaterThan(0);
      for (const s of sent) {
        expect(s.aborted, 'the stop reached the request').toBe(true);
        // Not the call's signal itself: joined with the 30 s limit, which a plain `??` would drop.
        expect(s).not.toBe(call);
      }
    });
  }

  it('a write is not ended by the stop (calendar create_event)', async () => {
    const { sent } = await signalsAfterStop(() => createCalendarTool(() => auth()).handler({
      action: 'create_event', summary: 'x', start: '2026-03-20T10:00:00+01:00', end: '2026-03-20T11:00:00+01:00',
    } as never, agent()));
    expect(sent.length, 'the write went out').toBeGreaterThan(0);
    for (const s of sent) expect(s.aborted, 'the write keeps running').toBe(false);
  });

  it('outside a call a read still carries its own limit', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => anyAnswer());
    await createDocsTool(() => auth()).handler({ action: 'read', document_id: 'd1' } as never, agent());
    const s = (mockFetch.mock.calls[0]![1] as RequestInit).signal;
    expect(s).toBeInstanceOf(AbortSignal);
  });
});
