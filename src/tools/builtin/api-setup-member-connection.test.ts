import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import type { RequestPrincipal } from '../../core/request-principal.js';
import { apiSetupTool } from './api-setup.js';
import { ApiStore, type ApiProfile, type OAuthGrantRecord } from '../../core/api-store.js';
import { runCollectingMemberNotes } from '../../core/member-connection-notes.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';

// What the owner's session may do with a connection a member made with their own login:
// not save over it while the member's access lasts (P3), refine it (F6), and not renew its
// tokens (fetch_token) — each refusal names who, which provider and which profile.

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

const tmpDirs: string[] = [];
beforeEach(() => {
  mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-member-conn-test-'));
  tmpDirs.push(mockLynoxDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TAG = 'mandate:setup@example.org';
const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' } as RequestPrincipal;
const OTHER: RequestPrincipal = { kind: 'mandate', email: 'other@example.org', mandateId: 'M-2' } as RequestPrincipal;
const ACK = { accepted: true as const, hosts: ['api.crm.example'], accepted_at: '2026-09-22T00:00:00.000Z' };
const MANDATE_GRANT: OAuthGrantRecord = { origin: 'callback', state: 'connected', connected_by: TAG, connected_mandate_id: 'M-1' } as OAuthGrantRecord;
const LEAD = 'setup@example.org set up this connection (api.crm.example, profile "CRM" (id crm-api)) with their own login';

function crmProfile(over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'crm-api',
    name: 'CRM',
    base_url: 'https://api.crm.example/v1',
    description: 'CRM API',
    auth: {
      type: 'oauth2',
      vault_keys: ['CRM_CLIENT_ID', 'CRM_CLIENT_SECRET'],
      oauth: { token_url: 'https://api.crm.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'CRM_CLIENT_ID', client_secret_key: 'CRM_CLIENT_SECRET' },
    },
    endpoints: [{ method: 'GET', path: '/contacts', description: 'List contacts' }],
    guidelines: ['Read contacts only.'],
    avoid: ['Deleting contacts.'],
    custom_endpoint_ack: ACK,
    created_by: TAG,
    oauth_grant: MANDATE_GRANT,
    ...over,
  };
}

function agentWith(store: ApiStore, principal: RequestPrincipal, live: readonly string[]): never {
  return {
    principal,
    sessionCounters: { httpRequests: 0 },
    promptUser: async () => 'Allow',
    toolContext: {
      vaultNameBindings: bindingsAsMigrated(store),
      apiStore: store,
      mandateEnds: { isLive: (id: string) => live.includes(id) },
      dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [], streamHandler: null,
      networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
      isolationEnvOverride: undefined, isolationMinimalEnv: false,
    },
  } as never;
}

const run = (agent: never, input: Record<string, unknown>): Promise<string> =>
  apiSetupTool.handler(input as never, agent) as Promise<string>;

function storeWith(profile: ApiProfile = crmProfile()): ApiStore {
  const store = new ApiStore();
  expect(store.register(profile)).toBe(true);
  return store;
}

describe('the owner saving over a member\'s connection (P3)', () => {
  it('is refused while the member\'s access lasts, naming who and how to go on, and nothing changes', async () => {
    const store = storeWith();
    const reply = await run(agentWith(store, OWNER_PRINCIPAL, ['M-1']), { action: 'update', profile: crmProfile({ description: 'edited', created_by: undefined }) });

    expect(reply).toBe(`Error: API profile "crm-api" was not saved. ${LEAD}, so lynox does not use it for you. Take it over in the chat once setup@example.org's access has ended, or delete this profile under Settings → APIs and connect it yourself (that disconnects setup@example.org).`);
    expect(store.get('crm-api')?.created_by).toBe(TAG);
    expect(store.get('crm-api')?.description).toBe('CRM API');
    expect(store.get('crm-api')?.oauth_grant).toEqual(MANDATE_GRANT);
  });

  it('control: once the access has ended the owner\'s save goes through as before', async () => {
    const store = storeWith();
    const reply = await run(agentWith(store, OWNER_PRINCIPAL, []), { action: 'update', profile: crmProfile({ description: 'edited' }) });

    expect(reply).toContain('Profile saved');
    expect(store.get('crm-api')?.description).toBe('edited');
  });

  it('control: the member\'s own save is not refused by it', async () => {
    const store = storeWith();
    const reply = await run(agentWith(store, MANDATE, ['M-1']), { action: 'update', profile: crmProfile({ description: 'edited' }) });

    expect(reply).toContain('Profile saved');
    expect(store.get('crm-api')?.description).toBe('edited');
  });

  it('another member\'s save stays refused, and does not change its author', async () => {
    const store = storeWith();
    const reply = await run(agentWith(store, OTHER, ['M-1', 'M-2']), { action: 'update', profile: crmProfile({ description: 'edited', created_by: 'mandate:other@example.org' }) });

    expect(reply).toContain('was not set up in this session\'s name');
    expect(store.get('crm-api')?.created_by).toBe(TAG);
  });
});

describe('the owner refining a member\'s connection (F6)', () => {
  it('goes through while the access lasts and keeps its author and its grant', async () => {
    const store = storeWith();
    const reply = await run(agentWith(store, OWNER_PRINCIPAL, ['M-1']), { action: 'refine', id: 'crm-api', refine: { addNotes: ['Paginate with cursor.'] } });

    expect(reply).toContain('Refined profile "crm-api"');
    expect(store.get('crm-api')?.created_by).toBe(TAG);
    expect(store.get('crm-api')?.oauth_grant).toEqual(MANDATE_GRANT);
  });
});

describe('fetch_token on a member\'s connection', () => {
  it('the owner is told who connected it while the access lasts, and nothing is sent', async () => {
    const reply = await run(agentWith(storeWith(), OWNER_PRINCIPAL, ['M-1']), { action: 'fetch_token', id: 'crm-api' });

    expect(reply).toBe(`Connection not used: ${LEAD}, so lynox does not use it for you. Take it over in the chat once setup@example.org's access has ended, or delete this profile under Settings → APIs and connect it yourself (that disconnects setup@example.org). Nothing was sent.`);
  });

  it('once the access has ended the owner is told how to take it over', async () => {
    const reply = await run(agentWith(storeWith(), OWNER_PRINCIPAL, []), { action: 'fetch_token', id: 'crm-api' });

    expect(reply.startsWith(`Connection not used: ${LEAD}. To let lynox use it for you, take it over: in the chat, ask to take over the connection "CRM" (id crm-api) and confirm with "Allow". Nothing was sent.`)).toBe(true);
  });

  it('another member is told it is not used in their session', async () => {
    const reply = await run(agentWith(storeWith(), OTHER, ['M-1', 'M-2']), { action: 'fetch_token', id: 'crm-api' });

    expect(reply).toBe(`Connection not used: ${LEAD}, so it is not used in this session. Nothing was sent.`);
  });

  it('control: the member who connected it is not refused by it', async () => {
    const reply = await run(agentWith(storeWith(), MANDATE, ['M-1']), { action: 'fetch_token', id: 'crm-api' });

    expect(reply).not.toContain('Connection not used');
  });

  it('inside a run, the refusal is noted for the run\'s end', async () => {
    const { notes, done } = runCollectingMemberNotes(() => run(agentWith(storeWith(), OWNER_PRINCIPAL, ['M-1']), { action: 'fetch_token', id: 'crm-api' }));
    await done;

    expect([...notes]).toEqual([expect.stringMatching(/^Connection not used: setup@example\.org set up this connection/)]);
  });
});
