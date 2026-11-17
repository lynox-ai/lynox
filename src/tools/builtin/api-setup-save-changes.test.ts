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

/** A profile that sends a stored key as a bearer token, on a listed host. */
function keyProfile(over: { base_url?: string; key?: string } = {}): ApiProfile {
  return {
    id: 'kp', name: 'Key profile', base_url: over.base_url ?? 'https://api.openai.com/v1', description: 'A key of its own',
    rate_limit: { requests_per_minute: 60 },
    endpoints: [{ method: 'GET', path: '/items', description: 'List items' }],
    guidelines: ['Read only'], avoid: ['No writes'],
    auth: { type: 'bearer', vault_keys: [over.key ?? 'KP_KEY_A'] },
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
    expect(result).toMatch(/^Blocked: profile "svc" not saved\. The save changes its scopes/);
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

  it('an own sign-in without a grant type is fetched as client_credentials: a scope change is asked about, or refused with nobody to ask', async () => {
    const store = new ApiStore();
    const noGrant = (scope: string): ApiProfile => {
      const p = ownGrant({ scope });
      delete p.auth!.oauth!.grant_type;
      return p;
    };
    await save(store, 'create', noGrant('read'), 'Allow');
    expect(stored(store, 'svc')?.auth?.oauth?.grant_type).toBeUndefined();
    const nobody = await save(store, 'update', noGrant('read write'), undefined);
    expect(nobody.result).toMatch(/^Blocked: profile "svc" not saved\. The save changes its scopes/);
    const denied = await save(store, 'update', noGrant('read write'), 'Deny');
    expect(denied.asked[0]).toContain('- scopes added: write');
    expect(stored(store, 'svc')?.auth?.oauth?.scope).toBe('read');
  });

  it('a refresh_token sign-in whose grant type is dropped becomes client_credentials, and that is asked about', async () => {
    const store = new ApiStore();
    await save(store, 'create', ownGrant({ grant_type: 'refresh_token' }), 'Allow');
    const dropped = ownGrant({ scope: 'read write' });
    delete dropped.auth!.oauth!.grant_type;
    const { result } = await save(store, 'update', dropped, undefined);
    expect(result).toMatch(/^Blocked: profile "svc" not saved\. The save changes its scopes/);
    expect(stored(store, 'svc')?.auth?.oauth?.grant_type).toBe('refresh_token');
  });

  it('a value that carries a line break is shown on one line, and one shaped like a credential is not shown', async () => {
    const store = new ApiStore();
    await save(store, 'create', ownGrant(), 'Allow');
    const forged = await save(store, 'update', ownGrant({ audience: 'x\n- scopes removed: read' }), 'Deny');
    expect(forged.asked[0]).toContain('- audience: (none) → x - scopes removed: read');
    expect(forged.asked[0].split('\n').filter((l) => l.startsWith('- scopes removed'))).toEqual([]);
    const key = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');
    const masked = await save(store, 'update', ownGrant({ audience: key }), 'Deny');
    expect(masked.asked[0]).toContain('- audience: (none) → (a value shaped like a credential, not shown)');
    expect(masked.asked[0]).not.toContain(key);
  });

  it('a refresh_token sign-in: a scope or audience change, which the next refresh sends, is asked about, named, and refused with nobody to ask', async () => {
    const store = new ApiStore();
    await save(store, 'create', ownGrant({ grant_type: 'refresh_token' }), 'Allow');
    const denied = await save(store, 'update', ownGrant({ grant_type: 'refresh_token', scope: 'read write', audience: 'https://other.example' }), 'Deny');
    expect(denied.asked[0]).toContain('- scopes added: write');
    expect(denied.asked[0]).toContain('- audience: (none) → https://other.example');
    expect(denied.result).toMatch(/^Blocked: .*declined/);
    const nobody = await save(store, 'update', ownGrant({ grant_type: 'refresh_token', scope: 'read write' }), undefined);
    expect(nobody.result).toMatch(/^Blocked: profile "svc" not saved\. The save changes its scopes/);
    expect(stored(store, 'svc')?.auth?.oauth).toMatchObject({ scope: 'read', grant_type: 'refresh_token' });
    expect(stored(store, 'svc')?.auth?.oauth?.audience).toBeUndefined();
  });

  it('a key profile: a swap of the secret it reads is asked about first, before any binding question, and refused with nobody to ask', async () => {
    const store = new ApiStore();
    expect((await save(store, 'create', keyProfile(), 'Allow')).result).not.toMatch(/^(Error|Blocked|Validation)/);
    const denied = await save(store, 'update', keyProfile({ key: 'KP_KEY_B' }), 'Deny');
    expect(denied.asked).toHaveLength(1);
    expect(denied.asked[0]).toContain('This save changes:\n- secret sent as the key: KP_KEY_A → KP_KEY_B');
    const nobody = await save(store, 'update', keyProfile({ key: 'KP_KEY_B' }), undefined);
    expect(nobody.result).toMatch(/^Blocked: profile "kp" not saved\. The save changes its scopes/);
    expect(stored(store, 'kp')?.auth?.vault_keys).toEqual(['KP_KEY_A']);
  });

  it('a key profile: a move to another listed host is asked about and named, and kept out when denied', async () => {
    const store = new ApiStore();
    await save(store, 'create', keyProfile(), 'Allow');
    const { result, asked } = await save(store, 'update', keyProfile({ base_url: 'https://api.mistral.ai/v1' }), 'Deny');
    expect(asked[0]).toContain('- address (base_url): https://api.openai.com/v1 → https://api.mistral.ai/v1');
    expect(result).toMatch(/^Blocked: .*declined/);
    expect(stored(store, 'kp')?.base_url).toBe('https://api.openai.com/v1');
  });

  it('refine ignores any field outside its patch, so it cannot change where a credential goes', async () => {
    const store = new ApiStore();
    await save(store, 'create', keyProfile(), 'Allow');
    const asked: string[] = [];
    const patch = { addNotes: ['x'], base_url: 'https://evil.example', auth: { type: 'bearer', vault_keys: ['KP_KEY_B'] } };
    const result = await apiSetupTool.handler({ action: 'refine', id: 'kp', refine: patch }, agentFor(store, asked, 'Allow')) as string;
    expect(result).not.toMatch(/^(Error|Blocked|Validation)/);
    expect(stored(store, 'kp')?.notes).toEqual(['x']);
    expect(stored(store, 'kp')?.base_url).toBe('https://api.openai.com/v1');
    expect(stored(store, 'kp')?.auth).toEqual({ type: 'bearer', vault_keys: ['KP_KEY_A'] });
  });

  it('a store profile whose sign-in address cannot be derived: a scope widened while the store is dropped is refused with nobody to ask, and named when asked', async () => {
    const store = new ApiStore();
    await save(store, 'create', shop(), 'Allow');
    const noStore = shop({ scope: 'read_products write_products' });
    delete noStore.auth!.oauth!.preset_params;
    const nobody = await save(store, 'update', noStore, undefined);
    expect(nobody.result).toMatch(/^Blocked: profile "shop" /);
    expect(stored(store, 'shop')?.auth?.oauth?.scope).toBe('read_products');
    const denied = await save(store, 'update', noStore, 'Deny');
    expect(denied.asked[0]).toContain('- scopes added: write_products');
    expect(denied.asked[0]).toContain('- provider parameter shop: acme → (none)');
    expect(stored(store, 'shop')?.auth?.oauth).toMatchObject({ scope: 'read_products', preset_params: { shop: 'acme' } });
  });

  it('a store profile cannot be saved to read its app from other secret names', async () => {
    const store = new ApiStore();
    await save(store, 'create', shop(), 'Allow');
    const before = stored(store, 'shop')?.auth?.oauth?.client_secret_key;
    expect(before).toBeDefined();
    const other = shop();
    other.auth!.oauth!.client_secret_key = 'MY_OWN_SECRET';
    const { result, asked } = await save(store, 'update', other, 'Allow');
    expect(result).toContain('Invalid auth.oauth.client_secret_key: a profile on the built-in "shopify" provider reads its app from');
    expect(asked).toEqual([]);
    expect(stored(store, 'shop')?.auth?.oauth?.client_secret_key).toBe(before);
  });

  it.each([
    ['another order of vault_keys', { auth: { type: 'bearer', vault_keys: ['KP_KEY_B', 'KP_KEY_A'] } }, '- secret sent as the key: KP_KEY_A → KP_KEY_B'],
    ['the key put in the query string', { auth: { type: 'query', query_param: 'key', vault_keys: ['KP_KEY_A', 'KP_KEY_B'] } }, '- how the secret is attached (auth.type): bearer → query'],
  ] as const)('a key profile: %s sends a credential differently with the same names, and is asked about and refused with nobody to ask', async (_n, over, line) => {
    const store = new ApiStore();
    await save(store, 'create', { ...keyProfile(), auth: { type: 'bearer', vault_keys: ['KP_KEY_A', 'KP_KEY_B'] } }, 'Allow');
    const before = structuredClone(stored(store, 'kp')?.auth);
    const next = { ...keyProfile(), ...over } as ApiProfile;
    const denied = await save(store, 'update', next, 'Deny');
    expect(denied.asked[0]).toContain(line);
    const nobody = await save(store, 'update', next, undefined);
    expect(nobody.result).toMatch(/^Blocked: profile "kp" not saved\. The save changes its scopes/);
    expect(stored(store, 'kp')?.auth).toEqual(before);
  });

  it('basic auth: dropping username_key sends vault_keys[0] as the user instead, and that is named and asked about', async () => {
    const store = new ApiStore();
    const basic = (username?: string): ApiProfile => ({ ...keyProfile(), auth: {
      type: 'basic', basic_format: 'user_pass_split', vault_keys: ['KP_KEY_A', 'KP_KEY_B'], ...(username === undefined ? {} : { username_key: username }),
    } });
    await save(store, 'create', basic('KP_USER'), 'Allow');
    const denied = await save(store, 'update', basic(), 'Deny');
    expect(denied.asked[0]).toContain('- secret sent as the user name: KP_USER → KP_KEY_A');
    const nobody = await save(store, 'update', basic(), undefined);
    expect(nobody.result).toMatch(/^Blocked: profile "kp" not saved\. The save changes its scopes/);
    expect(stored(store, 'kp')?.auth?.username_key).toBe('KP_USER');
  });

  it('the same credential written another way is no change: a background save goes through', async () => {
    const store = new ApiStore();
    const split = { type: 'basic', basic_format: 'user_pass_split', vault_keys: ['KP_KEY_A', 'KP_KEY_B'] } as const;
    await save(store, 'create', { ...keyProfile(), auth: { ...split } }, 'Allow');
    const named = await save(store, 'update', { ...keyProfile(), auth: { ...split, username_key: 'KP_KEY_A', password_key: 'KP_KEY_B' } }, undefined);
    expect(named.result).not.toMatch(/^(Error|Blocked|Validation)/);
    expect(stored(store, 'kp')?.auth?.username_key).toBe('KP_KEY_A');
    const header = new ApiStore();
    await save(header, 'create', { ...keyProfile(), auth: { type: 'header', vault_keys: ['KP_KEY_A'] } }, 'Allow');
    const spelled = await save(header, 'update', { ...keyProfile(), auth: { type: 'header', header_name: 'X-Api-Key', vault_keys: ['KP_KEY_A'] } }, undefined);
    expect(spelled.result).not.toMatch(/^(Error|Blocked|Validation)/);
    expect(stored(header, 'kp')?.auth?.header_name).toBe('X-Api-Key');
  });

  it('an own sign-in: dropping refresh_token_key reads another slot, and that is asked about', async () => {
    const store = new ApiStore();
    const withRt = (rt?: string): ApiProfile => {
      const p = ownGrant({ grant_type: 'refresh_token' });
      if (rt !== undefined) p.auth!.oauth!.refresh_token_key = rt;
      return p;
    };
    await save(store, 'create', withRt('SVC_RT'), 'Allow');
    const denied = await save(store, 'update', withRt(), 'Deny');
    expect(denied.asked[0]).toContain("- secret sent as the refresh token: SVC_RT → (this profile's own)");
    const nobody = await save(store, 'update', withRt(), undefined);
    expect(nobody.result).toMatch(/^Blocked: profile "svc" not saved\. The save changes its scopes/);
    expect(stored(store, 'svc')?.auth?.oauth?.refresh_token_key).toBe('SVC_RT');
  });

  it('a save that takes the last scope away leaves the choice to the provider: that is asked about', async () => {
    const store = new ApiStore();
    await save(store, 'create', ownGrant({ scope: 'read' }), 'Allow');
    const none = ownGrant();
    delete none.auth!.oauth!.scope;
    const nobody = await save(store, 'update', none, undefined);
    expect(nobody.result).toMatch(/^Blocked: profile "svc" not saved\. The save changes its scopes/);
    const denied = await save(store, 'update', none, 'Deny');
    expect(denied.asked[0]).toContain('- scopes removed: read (none left: the provider decides which it grants)');
    expect(stored(store, 'svc')?.auth?.oauth?.scope).toBe('read');
  });

  it('an address whose path is shaped like a credential still shows its host', async () => {
    const store = new ApiStore();
    await save(store, 'create', keyProfile(), 'Allow');
    const key = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');
    const { asked } = await save(store, 'update', keyProfile({ base_url: `https://api.mistral.ai/${key}` }), 'Deny');
    expect(asked[0]).toContain('- address (base_url): https://api.openai.com/v1 → https://api.mistral.ai (the rest is shaped like a credential, not shown)');
    expect(asked[0]).not.toContain(key);
  });

  it('a save that only takes a scope away narrows the profile: it saves with nobody to ask', async () => {
    const store = new ApiStore();
    await save(store, 'create', ownGrant({ scope: 'read write' }), 'Allow');
    const { result } = await save(store, 'update', ownGrant({ scope: 'read' }), undefined);
    expect(result).not.toMatch(/^(Error|Blocked|Validation)/);
    expect(stored(store, 'svc')?.auth?.oauth?.scope).toBe('read');
  });

  it('control: the same sign-in with nothing of its grant changed saves without a question', async () => {
    const store = new ApiStore();
    await save(store, 'create', ownGrant(), 'Allow');
    const { result } = await save(store, 'update', { ...ownGrant(), description: 'Another text' }, undefined);
    expect(result).not.toMatch(/^(Error|Blocked|Validation)/);
    expect(stored(store, 'svc')?.description).toBe('Another text');
  });
});
