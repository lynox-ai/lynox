import { describe, it, expect } from 'vitest';
import type { GoogleAuth } from './google-auth.js';
import { GOOGLE_NOT_CONNECTED } from './not-connected.js';
import { createGoogleTools } from './index.js';
import { createDriveTool } from './google-drive.js';
import { createCalendarTool } from './google-calendar.js';
import { createSheetsTool } from './google-sheets.js';
import { createDocsTool } from './google-docs.js';
import type { IAgent } from '../../types/index.js';

/**
 * The visibility half of PRD Stage 1 §3.2: the four Google tools are registered
 * from boot, connected or not, so they WILL be called before a connection
 * exists. What they answer then is prompt surface, not an error string.
 *
 * Each test names the mutation it kills, because a refusal text with no test is
 * a string and not a specification.
 */
const agent = {} as IAgent;
const FACTORIES = [
  ['google_drive', createDriveTool, { action: 'search', query: 'x' }],
  ['google_calendar', createCalendarTool, { action: 'list' }],
  ['google_sheets', createSheetsTool, { action: 'read', spreadsheet_id: 'x', range: 'A1' }],
  ['google_docs', createDocsTool, { action: 'read', document_id: 'x' }],
] as const;

describe('a Google tool called before a connection exists', () => {
  it.each(FACTORIES)('%s answers the connect-path sentence, not a bare error', async (_name, factory, input) => {
    // MUTATION THIS KILLS: replace the guard with `throw new Error('not configured')`,
    // or spell the sentence per file instead of importing the constant.
    const tool = factory(() => null) as { handler: (i: unknown, a: IAgent) => Promise<string> };
    await expect(tool.handler(input, agent)).resolves.toBe(GOOGLE_NOT_CONNECTED);
  });

  it('the sentence names the state, the place, the boundary and the retry', () => {
    // Not a spell-check: each clause is load-bearing and was argued in the PRD.
    // MUTATION THIS KILLS: dropping any clause while keeping the constant.
    expect(GOOGLE_NOT_CONNECTED).toContain('not connected');
    expect(GOOGLE_NOT_CONNECTED).toContain('Settings → Channels → Google');
    expect(GOOGLE_NOT_CONNECTED).toContain('cannot connect it yourself');
    expect(GOOGLE_NOT_CONNECTED).toContain('do not retry');
  });

  it('does NOT refuse once the resolver has something — the guard is not unconditional', async () => {
    // MUTATION THIS KILLS: `return GOOGLE_NOT_CONNECTED` before the null check,
    // which would make every test above pass and the product dead.
    const auth = { hasScope: () => false } as unknown as GoogleAuth;
    const tool = createCalendarTool(() => auth) as { handler: (i: unknown, a: IAgent) => Promise<string> };
    const out = await tool.handler({ action: 'list' }, agent);
    expect(out).not.toBe(GOOGLE_NOT_CONNECTED);
  });
});

describe('the resolver is read per call, not captured', () => {
  it('a tool built while disconnected works after the credential arrives', async () => {
    // MUTATION THIS KILLS: memoising the resolved auth in createGoogleTools or
    // in a factory. `reloadGoogle()` replaces the instance after a credential
    // change, and a captured one would leave a reconnected tenant refusing
    // until a process restart — which managed tenants cannot trigger.
    let auth: GoogleAuth | null = null;
    const { tools } = createGoogleTools(() => auth);
    const calendar = tools.find(t => t.definition.name === 'google_calendar') as
      unknown as { handler: (i: unknown, a: IAgent) => Promise<string> };

    await expect(calendar.handler({ action: 'list' }, agent)).resolves.toBe(GOOGLE_NOT_CONNECTED);
    auth = { hasScope: () => false } as unknown as GoogleAuth;
    await expect(calendar.handler({ action: 'list' }, agent)).resolves.not.toBe(GOOGLE_NOT_CONNECTED);
  });

  it('and stops working again when the credential goes away', async () => {
    // The other direction, because a resolver that only ever upgrades would
    // pass the test above while leaking a disconnected tenant's access.
    let auth: GoogleAuth | null = { hasScope: () => false } as unknown as GoogleAuth;
    const { tools } = createGoogleTools(() => auth);
    const drive = tools.find(t => t.definition.name === 'google_drive') as
      unknown as { handler: (i: unknown, a: IAgent) => Promise<string> };

    await expect(drive.handler({ action: 'search', query: 'x' }, agent)).resolves.not.toBe(GOOGLE_NOT_CONNECTED);
    auth = null;
    await expect(drive.handler({ action: 'search', query: 'x' }, agent)).resolves.toBe(GOOGLE_NOT_CONNECTED);
  });
});
