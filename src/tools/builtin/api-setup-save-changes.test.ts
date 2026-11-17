import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

let lynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => lynoxDir }));

import { apiSetupTool } from './api-setup.js';
import { ApiStore, type ApiProfile } from '../../core/api-store.js';
import { OAUTH_PRESETS } from '../../core/oauth-presets.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';
import { testAuditLog } from '../../../tests/helpers/audit-log.js';

/** An owner's agent; `answer` undefined = no one to ask (a background run). */
function agentFor(store: ApiStore, asked: string[], answer: string | undefined) {
  return {
    principal: OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    ...(answer === undefined ? {} : {
      promptUser: async (q: unknown): Promise<string> => { asked.push(flattenPrompt(q as string)); return answer; },
    }),
    secretStore: { resolve: (): string | null => null, listNames: (): string[] => [] },
    toolContext: {
      auditLog: testAuditLog().log,
      apiStore: store,
      vaultNameBindings: bindingsAsMigrated(store),
      dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null,
      userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined,
      allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null,
      hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
      isolationEnvOverride: undefined, isolationMinimalEnv: false,
    },
  } as never;
}

async function save(store: ApiStore, action: 'create' | 'update', profile: ApiProfile, answer: string | undefined): Promise<{ result: string; asked: string[] }> {
  const asked: string[] = [];
  const result = await apiSetupTool.handler({ action, profile: structuredClone(profile) }, agentFor(store, asked, answer)) as string;
  return { result, asked };
}

const PINNED = OAUTH_PRESETS.get('shopify')?.adminApiVersion ?? '';

/** A store connection through the built-in provider: every save of it asks (the sign-in redirect). */
function shop(over: { scope?: string; shopName?: string } = {}): ApiProfile {
  const shopName = over.shopName ?? 'acme';
  return {
    id: 'shop', name: 'Shop', base_url: `https://${shopName}.myshopify.com/admin/api/${PINNED}`,
    description: 'The admin API of one store',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: shopName }, scope: over.scope ?? 'read_products' } },
  };
}

/** An OAuth sign-in of its own whose token the agent fetches itself, on a listed host: no host question. */
function ownGrant(over: { scope?: string; audience?: string; grant_type?: 'client_credentials' | 'refresh_token' } = {}): ApiProfile {
  return {
    id: 'svc', name: 'Service', base_url: 'https://api.openai.com/v1', description: 'A service of its own',
    rate_limit: { requests_per_minute: 60 },
    endpoints: [{ method: 'GET', path: '/items', description: 'List items' }],
    guidelines: ['Read only'], avoid: ['No writes'],
    auth: { type: 'oauth2', vault_keys: ['SVC_CID', 'SVC_CSECRET'], oauth: {
      token_url: 'https://api.openai.com/oauth/token', client_id_key: 'SVC_CID', client_secret_key: 'SVC_CSECRET',
      ...(over.grant_type === undefined ? { grant_type: 'client_credentials' as const } : { grant_type: over.grant_type }),
      scope: over.scope ?? 'read',
      ...(over.audience === undefined ? {} : { audience: over.audience }),
    } },
  };
}

const stored = (store: ApiStore, id: string): ApiProfile | undefined => store.storedProfile(id);

describe('api_setup: a save names what it changes, and a refused change is not stored', () => {
  beforeEach(() => { lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-save-changes-')); });
  afterEach(() => { rmSync(lynoxDir, { recursive: true, force: true }); });

  it('names an added scope in the question, and a denied save keeps the stored scope', async () => {
    const store = new ApiStore();
    expect((await save(store, 'create', shop(), 'Allow')).result).not.toMatch(/^(Error|Blocked|Validation)/);
    const { result, asked } = await save(store, 'update', shop({ scope: 'read_products write_products' }), 'Deny');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('This save changes:\n- scopes added: write_products');
    expect(result).toMatch(/^Blocked: .*declined/);
    expect(stored(store, 'shop')?.auth?.oauth?.scope).toBe('read_products');
  });

  it('names a removed scope and the store a provider parameter moves to', async () => {
    const store = new ApiStore();
    await save(store, 'create', shop({ scope: 'read_products write_products' }), 'Allow');
    const { asked } = await save(store, 'update', shop({ scope: 'read_products', shopName: 'other' }), 'Deny');
    expect(asked[0]).toContain('- scopes removed: write_products');
    expect(asked[0]).toContain('- provider parameter shop: acme → other');
    expect(stored(store, 'shop')?.auth?.oauth?.preset_params).toEqual({ shop: 'acme' });
  });

  it('control: a save that changes none of these fields lists no changes, and an allowed one is stored', async () => {
    const store = new ApiStore();
    await save(store, 'create', shop(), 'Allow');
    const same = await save(store, 'update', { ...shop(), description: 'Another text' }, 'Allow');
    expect(same.asked[0]).not.toContain('This save changes:');
    const more = await save(store, 'update', shop({ scope: 'read_products write_products' }), 'Allow');
    expect(more.asked[0]).toContain('- scopes added: write_products');
    expect(stored(store, 'shop')?.auth?.oauth?.scope).toBe('read_products write_products');
  });

  it('an own sign-in fetched by the agent: a scope change with nobody to ask is refused and not stored', async () => {
    const store = new ApiStore();
    expect((await save(store, 'create', ownGrant(), 'Allow')).result).not.toMatch(/^(Error|Blocked|Validation)/);
    const { result } = await save(store, 'update', ownGrant({ scope: 'read write' }), undefined);
    expect(result).toMatch(/^Blocked: profile "svc" not saved\. The save changes the scope, audience or grant type/);
    expect(stored(store, 'svc')?.auth?.oauth?.scope).toBe('read');
  });

  it.each([
    ['scope', { scope: 'read write' }, '- scopes added: write'],
    ['audience', { audience: 'https://other.example' }, '- audience: (none) → https://other.example'],
    ['grant type', { grant_type: 'refresh_token' as const }, '- grant type: client_credentials → refresh_token'],
  ])('an own sign-in fetched by the agent: its %s change is asked about, named, and kept out when denied', async (_n, over, line) => {
    const store = new ApiStore();
    await save(store, 'create', ownGrant(), 'Allow');
    const before = structuredClone(stored(store, 'svc'));
    const { result, asked } = await save(store, 'update', ownGrant(over), 'Deny');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(line);
    expect(result).toMatch(/^Blocked: .*declined/);
    expect(stored(store, 'svc')?.auth?.oauth).toEqual(before?.auth?.oauth);
  });

  it('control: the same sign-in with nothing of its grant changed saves without a question', async () => {
    const store = new ApiStore();
    await save(store, 'create', ownGrant(), 'Allow');
    const { result } = await save(store, 'update', { ...ownGrant(), description: 'Another text' }, undefined);
    expect(result).not.toMatch(/^(Error|Blocked|Validation)/);
    expect(stored(store, 'svc')?.description).toBe('Another text');
  });
});
