import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

function agentFor(store: ApiStore, promptUser: (question: string) => Promise<string>) {
  return {
    principal: OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    promptUser,
    toolContext: {
      auditLog: testAuditLog().log,
      apiStore: store,
      vaultNameBindings: bindingsAsMigrated(store),
      dataStore: null,
      taskManager: null,
      knowledgeLayer: null,
      runHistory: null,
      userConfig: {},
      tools: [],
      streamHandler: null,
      networkPolicy: undefined,
      allowedHosts: undefined,
      allowedWildcards: [],
      rateLimitProvider: null,
      hourlyRateLimit: Infinity,
      dailyRateLimit: Infinity,
      isolationEnvOverride: undefined,
      isolationMinimalEnv: false,
    },
  } as never;
}

/** What a profile of its own needs beyond its address to count as complete. */
const COMPLETE = {
  rate_limit: { requests_per_minute: 60 },
  endpoints: [{ method: 'GET', path: '/items', description: 'List items' }],
  guidelines: ['Read only'],
  avoid: ['No writes'],
} as const;

const PINNED = OAUTH_PRESETS.get('shopify')?.adminApiVersion ?? '';

function storeProfile(baseUrl: string): ApiProfile {
  return {
    id: 'shop',
    name: 'Shop',
    base_url: baseUrl,
    description: 'The admin API of one store',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'acme' }, scope: 'read_products' } },
  };
}

/** Saves with every question answered "Allow" and returns the result and the questions asked. */
async function save(store: ApiStore, action: 'create' | 'update', profile: ApiProfile): Promise<{ result: string; asked: string[] }> {
  const asked: string[] = [];
  const result = await apiSetupTool.handler({ action, profile }, agentFor(store, async (q) => {
    asked.push(flattenPrompt(q));
    return 'Allow';
  })) as string;
  return { result, asked };
}

const paragraphsNaming = (text: string, host: string): number =>
  text.split('\n\n').filter((p) => p.startsWith(`Custom endpoint outside lynox's listed sub-processors: ${host}.`)).length;

describe('api_setup: the acceptance question names each host once', () => {
  beforeEach(() => { lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-disclosure-per-host-')); });
  afterEach(() => { rmSync(lynoxDir, { recursive: true, force: true }); });

  it('a store profile, whose base, token and authorize URLs share one host, gets one paragraph for it', async () => {
    const store = new ApiStore();
    const { result, asked } = await save(store, 'create', storeProfile(`https://acme.myshopify.com/admin/api/${PINNED}`));
    expect(result).toContain('Created API profile');
    const acceptance = asked.find((q) => q.includes('needs your acceptance')) ?? '';
    expect(paragraphsNaming(acceptance, 'acme.myshopify.com')).toBe(1);
    // The redirect half is its own sentence and stays.
    expect(acceptance).toContain('You will be sent to acme.myshopify.com in your own browser');
  });

  it('a profile on two hosts keeps one paragraph for each', async () => {
    const store = new ApiStore();
    const { result, asked } = await save(store, 'create', {
      id: 'two-hosts',
      name: 'Two hosts',
      base_url: 'https://api.example-data.com/v1',
      description: 'Data on one host, tokens on another',
      ...COMPLETE,
      auth: {
        type: 'oauth2',
        vault_keys: ['TWO_CLIENT', 'TWO_SECRET'],
        oauth: { token_url: 'https://auth.example-tokens.com/oauth/token', client_id_key: 'TWO_CLIENT', client_secret_key: 'TWO_SECRET' },
      },
    });
    expect(result).toContain('Created API profile');
    const acceptance = asked.find((q) => q.includes('needs your acceptance')) ?? '';
    expect(paragraphsNaming(acceptance, 'api.example-data.com')).toBe(1);
    expect(paragraphsNaming(acceptance, 'auth.example-tokens.com')).toBe(1);
  });
});

describe('api_setup: a store profile is saved on the API version its provider pins', () => {
  beforeEach(() => { lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-api-version-')); });
  afterEach(() => { rmSync(lynoxDir, { recursive: true, force: true }); });

  const refusal = `Validation error: Invalid base_url: a profile on the built-in "shopify" provider uses its API version ${PINNED}, the one this engine's own requests name. Save it again with base_url ending in /admin/api/${PINNED}; you do not need to ask the user which version to use.`;

  it('pins a version, so the refusal below names one', () => {
    expect(PINNED).toMatch(/^\d{4}-\d{2}$/);
  });

  it.each([
    ['an old version', 'https://acme.myshopify.com/admin/api/2024-01'],
    ['an old version with a path behind it', 'https://acme.myshopify.com/admin/api/2024-01/graphql.json'],
    ['a version name other than the pin', 'https://acme.myshopify.com/admin/api/unstable'],
    ['an old version behind a doubled slash', 'https://acme.myshopify.com/admin/api//2024-01'],
    ['an old version behind doubled slashes before api/', 'https://acme.myshopify.com//admin//api/2024-01'],
  ])('refuses %s on create, asks nobody and stores nothing', async (_label, baseUrl) => {
    const store = new ApiStore();
    const { result, asked } = await save(store, 'create', storeProfile(baseUrl));
    expect(result).toBe(refusal);
    expect(asked).toEqual([]);
    expect(store.get('shop')).toBeUndefined();
  });

  it('refuses it on update and keeps the stored base', async () => {
    const store = new ApiStore();
    const pinnedBase = `https://acme.myshopify.com/admin/api/${PINNED}`;
    expect((await save(store, 'create', storeProfile(pinnedBase))).result).toContain('Created API profile');
    const { result } = await save(store, 'update', storeProfile('https://acme.myshopify.com/admin/api/2024-01'));
    expect(result).toBe(refusal);
    expect(store.get('shop')?.base_url).toBe(pinnedBase);
  });

  it.each([
    ['the pinned version', `https://acme.myshopify.com/admin/api/${PINNED}`],
    ['no version at all', 'https://acme.myshopify.com'],
    ['the version path with no version in it', 'https://acme.myshopify.com/admin/api/'],
    ['a path under /admin/ that names no version', 'https://acme.myshopify.com/admin/products.json'],
    ['the pinned version behind doubled slashes', `https://acme.myshopify.com/admin//api//${PINNED}/`],
  ])('saves a base on %s as written', async (_label, baseUrl) => {
    const store = new ApiStore();
    const { result } = await save(store, 'create', storeProfile(baseUrl));
    expect(result).toContain('Created API profile');
    expect(store.get('shop')?.base_url).toBe(baseUrl);
    expect((JSON.parse(readFileSync(join(lynoxDir, 'apis', 'shop.json'), 'utf8')) as ApiProfile).base_url).toBe(baseUrl);
  });

  it('control: a profile without a built-in provider keeps any version in its path', async () => {
    const store = new ApiStore();
    const own: ApiProfile = {
      id: 'own', name: 'Own', base_url: 'https://api.openai.com/admin/api/2024-01', description: 'd', auth: { type: 'bearer' }, ...COMPLETE,
    };
    const { result } = await save(store, 'create', own);
    expect(result).toContain('Created API profile');
    expect(store.get('own')?.base_url).toBe('https://api.openai.com/admin/api/2024-01');
  });

  it('still refines a stored store profile on another version: the rule binds the save, not what is stored', async () => {
    const store = new ApiStore();
    store.register(storeProfile('https://acme.myshopify.com/admin/api/2026-04'));
    const result = await apiSetupTool.handler(
      { action: 'refine', id: 'shop', refine: { addNotes: ['Read products only.'] } },
      agentFor(store, async () => 'Allow'),
    ) as string;
    expect(result).toContain('Refined profile "shop"');
    expect(store.get('shop')?.notes).toContain('Read products only.');
  });
});
