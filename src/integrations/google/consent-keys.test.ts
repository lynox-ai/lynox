import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createDriveTool } from './google-drive.js';
import { createCalendarTool } from './google-calendar.js';
import { createSheetsTool } from './google-sheets.js';
import type { GoogleAuth } from './google-auth.js';
import type { IAgent, PromptMeta, PromptText } from '../../types/index.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { CONSENT_UNRECOGNISED_SENTENCE } from '../../core/consent-ask.js';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';

// A calendar update reads the event's current guests before it asks (none here), so that one read
// is answered; nothing else reaches Google, because no case gets past its question.
let restorePinnedFetchBridge: (() => void) | undefined;
beforeAll(() => { restorePinnedFetchBridge = installPinnedFetchBridge(); });
afterAll(() => { restorePinnedFetchBridge?.(); });
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'e1' }) })));

/**
 * A Google write goes ahead on the `confirm` key only. Its button names the action (`meta.consentAction`),
 * but that is words: neither the label in either language, nor an older client's "Yes" or "1", nor
 * typed text approves. The approving path itself is covered by each tool's own tests.
 */

function auth(): GoogleAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue('mock-token'),
    hasScope: vi.fn().mockReturnValue(true),
    hasOwnClientPair: vi.fn().mockReturnValue(true),
    usesServiceAccount: vi.fn().mockReturnValue(false),
  } as unknown as GoogleAuth;
}

interface Seen { question?: string; options?: string[]; meta?: PromptMeta }

function agent(answer: string, seen: Seen = {}, dialogLanguage?: 'de' | 'en'): IAgent {
  return {
    name: 'test', model: 'm', memory: null, tools: [], onStream: null, dialogLanguage,
    principal: { kind: 'owner' }, ownerKnown: { known: () => 'known' },
    promptUser: vi.fn().mockImplementation((q: string | PromptText, options?: string[], meta?: PromptMeta) => {
      seen.question = flattenPrompt(q); seen.options = options; seen.meta = meta;
      return Promise.resolve(answer);
    }),
  } as unknown as IAgent;
}

const CASES = [
  { tool: 'drive', action: 'upload', run: (a: IAgent) => createDriveTool(auth).handler({ action: 'upload', file_name: 'q3.pdf', content: 'x' } as never, a) },
  { tool: 'drive', action: 'create', run: (a: IAgent) => createDriveTool(auth).handler({ action: 'create_doc', file_name: 'Notes' } as never, a) },
  { tool: 'drive', action: 'move', run: (a: IAgent) => createDriveTool(auth).handler({ action: 'move', file_id: 'f1', target_folder_id: 'dst' } as never, a) },
  { tool: 'drive', action: 'share', run: (a: IAgent) => createDriveTool(auth).handler({ action: 'share', file_id: 'f1', email: 'bob@example.com', role: 'writer' } as never, a) },
  { tool: 'sheets', action: 'overwrite', run: (a: IAgent) => createSheetsTool(auth).handler({ action: 'write', spreadsheet_id: 's1', range: 'A1:B2', values: [['1']] } as never, a) },
  { tool: 'sheets', action: 'append', run: (a: IAgent) => createSheetsTool(auth).handler({ action: 'append', spreadsheet_id: 's1', range: 'A1', values: [['1']] } as never, a) },
  { tool: 'sheets', action: 'format', run: (a: IAgent) => createSheetsTool(auth).handler({ action: 'format', spreadsheet_id: 's1', requests: [{}] } as never, a) },
  { tool: 'calendar', action: 'create', run: (a: IAgent) => createCalendarTool(auth).handler({ action: 'create_event', summary: 'Review', start: '2026-11-21T09:00:00Z', end: '2026-11-21T10:00:00Z' } as never, a) },
  { tool: 'calendar', action: 'update', run: (a: IAgent) => createCalendarTool(auth).handler({ action: 'update_event', event_id: 'e1', summary: 'Moved' } as never, a) },
  { tool: 'calendar', action: 'delete', run: (a: IAgent) => createCalendarTool(auth).handler({ action: 'delete_event', event_id: 'e1' } as never, a) },
] as const;

const NOT_KEYS = ['Yes', 'yes', '1', 'ja', 'y', 'ok', 'Confirm', 'Bestätigen', 'Upload', 'Löschen', 'Delete', 'Share', 'allow', ' confirm', 'CONFIRM'];

describe('Google writes go ahead on the `confirm` key only', () => {
  for (const c of CASES) {
    it(`${c.tool} ${c.action}: offers the google keys and names the action`, async () => {
      const seen: Seen = {};
      await c.run(agent('cancel', seen));
      expect(seen.options).toEqual(['confirm', 'cancel']);
      expect(seen.meta).toMatchObject({ consent: 'google', consentAction: c.action });
    });

    it(`${c.tool} ${c.action}: a word in place of the key approves nothing, and says it was not understood`, async () => {
      for (const answer of NOT_KEYS) {
        const out = await c.run(agent(answer));
        expect(out, answer).toBe(`Action cancelled by user. ${CONSENT_UNRECOGNISED_SENTENCE}`);
      }
    });

    it(`${c.tool} ${c.action}: \`cancel\` and a closed question are a plain no`, async () => {
      for (const answer of ['cancel', '', '__dismissed__']) {
        expect(await c.run(agent(answer)), JSON.stringify(answer)).toBe('Action cancelled by user.');
      }
    });
  }

  it('an append is asked as an append: nothing it says is an overwrite', async () => {
    const seen: Seen = {};
    await createSheetsTool(auth).handler({ action: 'append', spreadsheet_id: 's1', range: 'A1', values: [['1']] } as never, agent('cancel', seen));
    expect(seen.question).toContain('Add rows to range “A1”');
    // "Nothing is overwritten" is the one mention, and it says the opposite of an overwrite.
    expect(seen.question).not.toMatch(/^Overwrite|replace/i);
  });

  it('asks in German on a German instance, values as they are', async () => {
    const seen: Seen = {};
    await createCalendarTool(auth).handler({ action: 'delete_event', event_id: 'e1' } as never, agent('cancel', seen, 'de'));
    expect(seen.question).toBe('Termin e1 löschen\nDas lässt sich nicht rückgängig machen.');
    await createDriveTool(auth).handler({ action: 'share', file_id: 'f1', email: 'bob@example.com', role: 'writer' } as never, agent('cancel', seen, 'de'));
    expect(seen.question).toBe('Datei f1 für bob@example.com freigeben, als writer?');
    await createSheetsTool(auth).handler({ action: 'append', spreadsheet_id: 's1', range: 'A1', values: [['1']] } as never, agent('cancel', seen, 'de'));
    expect(seen.question).toBe('Zeilen zum Bereich „A1“ in Tabelle s1 hinzufügen? Es wird nichts überschrieben.');
  });
});
