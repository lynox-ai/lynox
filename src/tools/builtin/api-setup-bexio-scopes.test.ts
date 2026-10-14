import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { apiSetupTool } from './api-setup.js';
import { ApiStore, type ApiProfile } from '../../core/api-store.js';

/**
 * The scopes a bexio profile may hold, against the shipped register (no mock): what a save
 * refuses, and what the view tells the model before it offers anything.
 */

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

beforeEach(() => { mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-bexio-scopes-')); });
afterEach(() => { rmSync(mockLynoxDir, { recursive: true, force: true }); });

function bexioProfile(scope: string | undefined): ApiProfile {
  return {
    id: 'bexio-api',
    name: 'bexio',
    base_url: 'https://api.bexio.com',
    description: 'bexio API',
    auth: {
      type: 'oauth2',
      vault_keys: ['BEXIO_CLIENT_ID', 'BEXIO_CLIENT_SECRET'],
      oauth: {
        grant_type: 'refresh_token',
        client_id_key: 'BEXIO_CLIENT_ID',
        client_secret_key: 'BEXIO_CLIENT_SECRET',
        preset_id: 'bexio',
        ...(scope === undefined ? {} : { scope }),
      },
    },
  };
}

function agentWith(store: ApiStore): never {
  return {
    principal: OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    secretStore: { extractSecretNames: (): string[] => [], resolveSecretRefs: (input: unknown): unknown => input },
    toolContext: { apiStore: store, dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity, isolationEnvOverride: undefined, isolationMinimalEnv: false },
  } as never;
}

const create = (scope: string | undefined): Promise<string> =>
  apiSetupTool.handler({ action: 'create', profile: {
    ...bexioProfile(scope),
    endpoints: [{ method: 'GET', path: '/2.0/contact', description: 'contacts' }], guidelines: ['x'], avoid: ['x'],
  } }, agentWith(new ApiStore())) as Promise<string>;

describe('a bexio profile holds only the decided scopes', () => {
  it.each([
    ['accounting'],
    ['bank_payment_edit'],
    ['kb_bill_edit'],
    ['contact_edit accounting'],
  ])('refuses %s when the profile is saved', async (scope) => {
    const result = await create(scope);
    expect(result).toContain('Invalid auth.oauth.scope');
    expect(result).toContain('does not allow');
  });

  it('saves a profile that names the five write scopes', async () => {
    const result = await create('contact_show contact_edit note_edit task_edit kb_offer_edit kb_invoice_edit');
    expect(result).not.toContain('auth.oauth.scope');
  });
});

describe('a bexio profile that writes documents, notes or tasks can read the contact they concern', () => {
  it.each([['kb_invoice_edit'], ['kb_offer_edit'], ['note_edit'], ['task_edit'], ['kb_invoice_show kb_invoice_edit']])('refuses %s without a contact scope', async (scope) => {
    const result = await create(scope);
    expect(result).toContain('Invalid auth.oauth.scope for the provider "bexio"');
    expect(result).toContain('needs contact_show or contact_edit as well: the question before each write names the contact it concerns');
  });

  it.each([['kb_invoice_edit contact_show'], ['kb_offer_edit contact_edit'], ['contact_edit'], ['kb_invoice_show']])('control: saves %s', async (scope) => {
    expect(await create(scope)).not.toContain('auth.oauth.scope');
  });
});

describe('view tells the model which bexio scopes exist', () => {
  it('lists the write scopes as allowed, and no scope outside the preset', async () => {
    const store = new ApiStore();
    store.register(bexioProfile('contact_show'));
    const reply = await apiSetupTool.handler({ action: 'view', id: 'bexio-api' }, agentWith(store)) as string;
    const allowed = /OAuth scopes the "bexio" preset allows: ([^.]*)\./.exec(reply)?.[1]?.split(' ') ?? [];
    for (const s of ['contact_edit', 'note_edit', 'task_edit', 'kb_offer_edit', 'kb_invoice_edit']) expect(allowed).toContain(s);
    for (const s of ['accounting', 'bank_payment_edit', 'kb_bill_edit']) expect(allowed).not.toContain(s);
    expect(reply).toContain('OAuth scopes this connection asks for: openid offline_access contact_show');
  });
});
