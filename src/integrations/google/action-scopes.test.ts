import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';
import { createSheetsTool } from './google-sheets.js';
import { createDocsTool } from './google-docs.js';
import { createCalendarTool } from './google-calendar.js';
import { createDriveTool } from './google-drive.js';
import { SCOPES, STANDARD_SCOPES } from './google-auth.js';
import type { GoogleAuth } from './google-auth.js';
import type { IAgent, ToolEntry } from '../../types/index.js';

let restore: (() => void) | undefined;
beforeAll(() => { restore = installPinnedFetchBridge(); });
afterAll(() => { restore?.(); });

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function auth(scopes: readonly string[], ownPair = true): GoogleAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue('mock-token'),
    hasScope: vi.fn().mockImplementation((s: string) => scopes.includes(s)),
    hasOwnClientPair: vi.fn().mockReturnValue(ownPair),
  } as unknown as GoogleAuth;
}

function agent(): IAgent {
  return { name: 't', model: 'm', memory: null, tools: [], onStream: null,
    promptUser: vi.fn().mockResolvedValue('Yes') } as unknown as IAgent;
}

/**
 * Every action of every tool Stage 1 registers, with a minimal input that
 * reaches the scope gate. The scope check runs before argument validation, so
 * the inputs only have to be shaped, not meaningful.
 */
const ACTIONS: { tool: string; make: (a: GoogleAuth) => ToolEntry; input: Record<string, unknown> }[] = [
  { tool: 'sheets', make: (a) => createSheetsTool(() => a) as ToolEntry, input: { action: 'read', spreadsheet_id: 'x', range: 'A1' } },
  { tool: 'sheets', make: (a) => createSheetsTool(() => a) as ToolEntry, input: { action: 'list' } },
  { tool: 'sheets', make: (a) => createSheetsTool(() => a) as ToolEntry, input: { action: 'write', spreadsheet_id: 'x', range: 'A1', values: [['a']] } },
  { tool: 'sheets', make: (a) => createSheetsTool(() => a) as ToolEntry, input: { action: 'append', spreadsheet_id: 'x', range: 'A1', values: [['a']] } },
  { tool: 'sheets', make: (a) => createSheetsTool(() => a) as ToolEntry, input: { action: 'create', title: 'x' } },
  { tool: 'sheets', make: (a) => createSheetsTool(() => a) as ToolEntry, input: { action: 'format', spreadsheet_id: 'x', format_requests: [] } },
  { tool: 'docs', make: (a) => createDocsTool(() => a) as ToolEntry, input: { action: 'read', document_id: 'x' } },
  { tool: 'docs', make: (a) => createDocsTool(() => a) as ToolEntry, input: { action: 'create', title: 'x' } },
  { tool: 'docs', make: (a) => createDocsTool(() => a) as ToolEntry, input: { action: 'append', document_id: 'x', text: 'y' } },
  { tool: 'docs', make: (a) => createDocsTool(() => a) as ToolEntry, input: { action: 'replace', document_id: 'x', search: 'a', replace: 'b' } },
  { tool: 'calendar', make: (a) => createCalendarTool(() => a) as ToolEntry, input: { action: 'list_events' } },
  { tool: 'calendar', make: (a) => createCalendarTool(() => a) as ToolEntry, input: { action: 'free_busy' } },
  { tool: 'calendar', make: (a) => createCalendarTool(() => a) as ToolEntry, input: { action: 'create_event', summary: 's', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' } },
  { tool: 'calendar', make: (a) => createCalendarTool(() => a) as ToolEntry, input: { action: 'update_event', event_id: 'e' } },
  { tool: 'calendar', make: (a) => createCalendarTool(() => a) as ToolEntry, input: { action: 'delete_event', event_id: 'e' } },
  { tool: 'drive', make: (a) => createDriveTool(() => a) as ToolEntry, input: { action: 'search', query: 'q' } },
  { tool: 'drive', make: (a) => createDriveTool(() => a) as ToolEntry, input: { action: 'list' } },
  { tool: 'drive', make: (a) => createDriveTool(() => a) as ToolEntry, input: { action: 'read', file_id: 'f' } },
  { tool: 'drive', make: (a) => createDriveTool(() => a) as ToolEntry, input: { action: 'upload', file_name: 'f', content: 'c' } },
  { tool: 'drive', make: (a) => createDriveTool(() => a) as ToolEntry, input: { action: 'create_doc', file_name: 'f' } },
  { tool: 'drive', make: (a) => createDriveTool(() => a) as ToolEntry, input: { action: 'move', file_id: 'f', target_folder_id: 't' } },
  { tool: 'drive', make: (a) => createDriveTool(() => a) as ToolEntry, input: { action: 'share', file_id: 'f', email: 'a@b.c', role: 'reader' } },
];

/** A refusal produced by the scope gate, as opposed to any other error. */
function isScopeRefusal(result: string): boolean {
  return result.includes('requires one of these Google permissions:');
}

describe('the broker set: every action either works or refuses with a remedy', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('covers every action of all four tools', () => {
    // Membership is the claim; a table that quietly loses a row would pass
    // every assertion below.
    expect(ACTIONS).toHaveLength(22);
    expect(new Set(ACTIONS.map((a) => a.tool))).toEqual(new Set(['sheets', 'docs', 'calendar', 'drive']));
  });

  it('no action on the broker grant reaches Google without an authorising scope', async () => {
    const refused: string[] = [];
    for (const { tool, make, input } of ACTIONS) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}), text: async () => '' });
      const result = await make(auth(STANDARD_SCOPES, false)).handler(input, agent()) as string;
      if (isScopeRefusal(result)) {
        refused.push(`${tool}:${String(input['action'])}`);
        // A refusal must be actionable: it names the missing scope AND where
        // this tenant can actually widen the grant. On a brokered tenant that
        // is NOT "Settings → Channels → Google", which renders no such control.
        expect(result, `${tool} ${String(input['action'])}`).toMatch(/https:\/\/(www\.googleapis\.com|mail\.google\.com)/);
        expect(result, `${tool} ${String(input['action'])}`).toContain('your own Google Cloud client');
        expect(mockFetch, `${tool} ${String(input['action'])} must not call Google`).not.toHaveBeenCalled();
      }
    }
    // The assertions above live inside an `if`, so without this they would all
    // pass on a build whose gate refuses NOTHING. This names the Stage-1
    // surface exactly: eleven of the twenty-two actions are out of reach on
    // the broker set, and which eleven is the product decision.
    expect(refused.sort()).toEqual([
      'docs:append', 'docs:create', 'docs:read', 'docs:replace',
      'drive:move', 'drive:share',
      'sheets:append', 'sheets:create', 'sheets:format', 'sheets:read', 'sheets:write',
    ]);
  });

  it('refuses the reads that ran unbraked before, and lets the granted ones through', async () => {
    // The four that the broker set cannot authorise. Before the per-action
    // table these had NO gate at all: they reached Google and came back with a
    // bare 403 body on the prompt surface.
    mockFetch.mockReset();
    const read = await (createSheetsTool(() => auth(STANDARD_SCOPES)) as ToolEntry)
      .handler({ action: 'read', spreadsheet_id: 'x', range: 'A1' }, agent()) as string;
    expect(read).toContain(SCOPES.SHEETS_READONLY);
    expect(mockFetch).not.toHaveBeenCalled();

    // `list` queries Drive, not Sheets, so `drive.file` DOES authorise it —
    // the control that keeps the assertion above from reading as "Sheets is
    // simply off on the broker set".
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ files: [] }) });
    const list = await (createSheetsTool(() => auth(STANDARD_SCOPES)) as ToolEntry)
      .handler({ action: 'list' }, agent()) as string;
    expect(isScopeRefusal(list)).toBe(false);
    expect(mockFetch).toHaveBeenCalled();

    mockFetch.mockReset();
    const docs = await (createDocsTool(() => auth(STANDARD_SCOPES)) as ToolEntry)
      .handler({ action: 'read', document_id: 'x' }, agent()) as string;
    expect(docs).toContain(SCOPES.DOCS_READONLY);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('admits free/busy on calendar.freebusy and REFUSES it on calendar.events alone', async () => {
    // `freebusy.query` is not authorised by `calendar.events`. A single write
    // gate could never express this: free/busy is a read, and the read scope
    // it needs is not the one the write actions use.
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ calendars: {} }) });
    const ok = await (createCalendarTool(() => auth([SCOPES.CALENDAR_FREEBUSY])) as ToolEntry)
      .handler({ action: 'free_busy' }, agent()) as string;
    expect(isScopeRefusal(ok)).toBe(false);

    mockFetch.mockReset();
    const refused = await (createCalendarTool(() => auth([SCOPES.CALENDAR_EVENTS])) as ToolEntry)
      .handler({ action: 'free_busy' }, agent()) as string;
    expect(refused).toContain(SCOPES.CALENDAR_FREEBUSY);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not admit Drive move/share on drive.file', async () => {
    for (const input of [
      { action: 'move', file_id: 'f', target_folder_id: 't' },
      { action: 'share', file_id: 'f', email: 'a@b.c', role: 'reader' },
    ] as Record<string, unknown>[]) {
      mockFetch.mockReset();
      const r = await (createDriveTool(() => auth([SCOPES.DRIVE_FILE])) as ToolEntry).handler(input, agent()) as string;
      expect(r).toContain(SCOPES.DRIVE);
      expect(r).not.toContain(SCOPES.DRIVE_FILE);
      expect(mockFetch).not.toHaveBeenCalled();
    }
  });

  it('points a BYO tenant at the control it actually has', async () => {
    const r = await (createSheetsTool(() => auth([], true)) as ToolEntry)
      .handler({ action: 'read', spreadsheet_id: 'x', range: 'A1' }, agent()) as string;
    expect(r).toContain('Settings → Channels → Google.');
    expect(r).not.toContain('your own Google Cloud client');
  });

  it('an unknown action is not silently admitted by the gate', async () => {
    mockFetch.mockReset();
    const r = await (createSheetsTool(() => auth([])) as ToolEntry)
      .handler({ action: 'teleport' } as Record<string, unknown>, agent()) as string;
    expect(r).toContain('Unknown action');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
