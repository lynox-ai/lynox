import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import type { RequestPrincipal } from '../../core/request-principal.js';
import { apiSetupTool } from './api-setup.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { ApiStore, type ApiProfile, type OAuthGrantRecord } from '../../core/api-store.js';
import { connectionTokenAllowed, connectionWaits } from '../../core/profile-secret-view.js';

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

// One provider whose token host the profile picks through a parameter, as real presets do.
vi.mock('../../core/oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/oauth-presets.js')>();
  const register = real.presetRegisterOf([{
    id: 'example-shop',
    label: 'Example Shop',
    host: { kind: 'template', param: 'shop', template: '{shop}.shops.example.com' },
    authorizePath: '/admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    params: [{ name: 'shop', pattern: /[a-z0-9][a-z0-9-]{0,59}/, describe: 'the shop name' }],
    requiredScopes: [],
    allowedScopes: ['read_orders'],
  }]);
  return {
    ...real,
    derivePresetEndpoints: (id: string, params: Readonly<Record<string, unknown>> | undefined) => real.derivePresetEndpoints(id, params, register),
    presetIds: () => register.ids(),
    OAUTH_PRESETS: register,
  };
});

const tmpDirs: string[] = [];
beforeEach(() => {
  mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-adopt-test-'));
  tmpDirs.push(mockLynoxDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TAG = 'mandate:setup@example.org';
const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' } as RequestPrincipal;
const ACK = { accepted: true as const, hosts: ['api.crm.example'], accepted_at: '2026-09-22T00:00:00.000Z' };
const MANDATE_GRANT: OAuthGrantRecord = { origin: 'callback', state: 'connected', connected_by: TAG, connected_mandate_id: 'M-1' } as OAuthGrantRecord;

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
    custom_endpoint_ack: ACK,
    created_by: TAG,
    oauth_grant: MANDATE_GRANT,
    ...over,
  };
}

interface AgentOpts {
  principal?: RequestPrincipal;
  promptUser?: ((q: unknown, o?: string[]) => Promise<string>) | null;
  live?: readonly string[] | null;
  runSignal?: AbortSignal;
}

function agentWith(store: ApiStore, opts: AgentOpts = {}): never {
  const live = opts.live === undefined ? [] : opts.live;
  return {
    principal: opts.principal ?? OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    promptUser: opts.promptUser === null ? undefined : (opts.promptUser ?? (async () => 'Allow')),
    runSignal: opts.runSignal,
    toolContext: {
      apiStore: store,
      mandateEnds: live === null ? null : { isLive: (id: string) => live.includes(id) },
      dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [], streamHandler: null,
      networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
      isolationEnvOverride: undefined, isolationMinimalEnv: false,
    },
  } as never;
}

const run = (agent: never, input: Record<string, unknown>): Promise<string> =>
  apiSetupTool.handler(input as never, agent) as Promise<string>;
const adopt = (agent: never, id = 'crm-api'): Promise<string> => run(agent, { action: 'adopt_connection', id });

function storeWith(profile: ApiProfile = crmProfile()): ApiStore {
  const store = new ApiStore();
  expect(store.register(profile)).toBe(true);
  return store;
}

describe('connectionWaits', () => {
  const ends = (live: string[]) => ({ isLive: (id: string) => live.includes(id) });

  it('a mandate connection waits once its mandate is no longer active', () => {
    expect(connectionWaits(crmProfile(), ends([]))).toBe(true);
  });

  it('does not wait while its mandate is active', () => {
    expect(connectionWaits(crmProfile(), ends(['M-1']))).toBe(false);
  });

  it('waits when no record of mandate ends exists', () => {
    expect(connectionWaits(crmProfile(), null)).toBe(true);
  });

  it('waits when the grant names no mandate id', () => {
    expect(connectionWaits(crmProfile({ oauth_grant: { ...MANDATE_GRANT, connected_mandate_id: undefined } }), ends(['M-1']))).toBe(true);
  });

  it('never for the owner\'s connection', () => {
    expect(connectionWaits(crmProfile({ oauth_grant: { ...MANDATE_GRANT, connected_by: 'owner', connected_mandate_id: undefined } }), null)).toBe(false);
  });
});

describe('api_setup tells the owner which connections wait for them', () => {
  it('names a waiting connection after any answer to the owner', async () => {
    const reply = await run(agentWith(storeWith()), { action: 'list' });
    expect(reply).toContain('Waiting for the owner: the connection of "crm-api" was authorized in a mandate\'s session that is no longer active');
    expect(reply).toContain('action "adopt_connection"');
  });

  it('says nothing while the mandate is still active', async () => {
    const reply = await run(agentWith(storeWith(), { live: ['M-1'] }), { action: 'list' });
    expect(reply).not.toContain('Waiting for the owner');
  });

  it('says nothing to a mandate', async () => {
    const reply = await run(agentWith(storeWith(), { principal: MANDATE }), { action: 'list' });
    expect(reply).toContain('crm-api');
    expect(reply).not.toContain('Waiting for the owner');
  });

  it('says nothing about the owner\'s own connection', async () => {
    const reply = await run(agentWith(storeWith(crmProfile({ created_by: undefined, oauth_grant: { origin: 'callback', state: 'connected', connected_by: 'owner' } as OAuthGrantRecord }))), { action: 'list' });
    expect(reply).not.toContain('Waiting for the owner');
  });

  it('counts past ten instead of naming them all', async () => {
    const store = new ApiStore();
    for (let i = 0; i < 12; i++) {
      store.register(crmProfile({ id: `crm-${String(i)}`, base_url: `https://api${String(i)}.crm.example/v1`, custom_endpoint_ack: { ...ACK, hosts: [`api${String(i)}.crm.example`] } }));
    }
    const reply = await run(agentWith(store), { action: 'list' });
    expect(reply).toContain('"crm-9" and 2 more were authorized');
    expect(reply).toContain('their tokens are not used');
  });
});

describe('api_setup adopt_connection', () => {
  it('asks, then makes the profile and its connection the owner\'s', async () => {
    const store = storeWith();
    const questions: string[] = [];
    const reply = await adopt(agentWith(store, { promptUser: async (q) => { questions.push(flattenPrompt(q as never)); return 'Allow'; } }));

    expect(questions).toHaveLength(1);
    expect(reply).toContain('Adopted: the connection of API profile "crm-api" is yours now');
    const saved = store.get('crm-api')!;
    expect(saved.oauth_grant?.connected_by).toBe('owner');
    expect(saved.oauth_grant?.connected_mandate_id).toBeUndefined();
    expect(saved.created_by).toBeUndefined();
    // The grant's other fields stay: the tokens are the same tokens.
    expect(saved.oauth_grant?.state).toBe('connected');
    // And the vault hands them out again.
    expect(connectionTokenAllowed(store, null, 'CRM_API_ACCESS_TOKEN')).toBe(true);
    expect(reply).not.toContain('Waiting for the owner');
  });

  it('control: before the adoption the vault refuses the same token', () => {
    expect(connectionTokenAllowed(storeWith(), null, 'CRM_API_ACCESS_TOKEN')).toBe(false);
  });

  const asked = async (profile: ApiProfile): Promise<string> => {
    const questions: string[] = [];
    await adopt(agentWith(storeWith(profile), { promptUser: async (q) => { questions.push(flattenPrompt(q as never)); return 'Deny'; } }));
    expect(questions).toHaveLength(1);
    return questions[0]!;
  };

  it('names, before the yes, whose session authorized it and that it is no longer active', async () => {
    expect(await asked(crmProfile())).toContain(`in the session of ${TAG}, which is not active`);
  });

  it('names every vault name the profile reads, and that environment values count', async () => {
    const q = await asked(crmProfile({ auth: { ...crmProfile().auth!, vault_keys: ['CRM_CLIENT_ID', 'CRM_CLIENT_SECRET', 'OWNER_STRIPE_KEY'] } }));
    expect(q).toContain('values from the environment included');
    for (const name of ['CRM_CLIENT_ID', 'CRM_CLIENT_SECRET', 'OWNER_STRIPE_KEY', 'CRM_API_ACCESS_TOKEN', 'CRM_API_REFRESH_TOKEN']) expect(q).toContain(name);
  });

  it('names the token host as well as the API host, where they differ', async () => {
    const base = crmProfile();
    const q = await asked(crmProfile({
      auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, token_url: 'https://login.crm-auth.example/token' } },
      custom_endpoint_ack: { ...ACK, hosts: ['api.crm.example', 'login.crm-auth.example'] },
    }));
    expect(q).toContain('sends to api.crm.example, login.crm-auth.example, for your requests and runs');
  });

  it('names a vault name as it is written, not a placeholder for its shape', async () => {
    const q = await asked(crmProfile({ auth: { ...crmProfile().auth!, vault_keys: ['CRM_CLIENT_ID', 'CRM_CLIENT_SECRET', 'my_db'] } }));
    expect(q).toContain('my_db');
    expect(q).not.toContain('<unprintable>');
  });

  it('quotes each name, so a stored name with a comma does not read as two', async () => {
    const q = await asked(crmProfile({ auth: { ...crmProfile().auth!, vault_keys: ['CRM_CLIENT_ID', 'CRM_CLIENT_SECRET', 'A, B'] } }));
    expect(q).toContain('"A, B"');
    expect(q).toContain('"CRM_CLIENT_ID", "CRM_CLIENT_SECRET"');
  });

  it('names the token host a preset derives from the profile\'s parameters', async () => {
    const q = await asked(crmProfile({
      base_url: 'https://api.shops.example.com/admin',
      auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID', 'SHOP_CLIENT_SECRET'], oauth: { grant_type: 'refresh_token', client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET', preset_id: 'example-shop', preset_params: { shop: 'chosen-by-mandate' } } },
      custom_endpoint_ack: { ...ACK, hosts: ['api.shops.example.com', 'chosen-by-mandate.shops.example.com'] },
    }));
    expect(q).toContain('sends to api.shops.example.com, chosen-by-mandate.shops.example.com, for your requests and runs');
  });

  it.each([
    ['no record of mandate ends exists', null, MANDATE_GRANT],
    ['the grant names no mandate id', [] as string[], { ...MANDATE_GRANT, connected_mandate_id: undefined }],
  ])('does not claim the mandate ended when %s', async (_label, live, grant) => {
    const questions: string[] = [];
    await adopt(agentWith(storeWith(crmProfile({ oauth_grant: grant as OAuthGrantRecord })), { live, promptUser: async (q) => { questions.push(flattenPrompt(q as never)); return 'Deny'; } }));
    expect(questions[0]).toContain('this engine cannot tell whether that mandate is still active');
    expect(questions[0]).not.toContain('which is not active');
  });

  it('adopts nothing when the mandate became active again while the question was open', async () => {
    const store = storeWith();
    const live: string[] = [];
    const reply = await adopt(agentWith(store, { live, promptUser: async () => { live.push('M-1'); return 'Allow'; } }));
    expect(reply).toContain('became active again while the question was open');
    expect(store.get('crm-api')?.oauth_grant?.connected_by).toBe(TAG);
  });

  it('adopts nothing, and asks nothing, while the mandate is still active', async () => {
    const store = storeWith();
    const before = JSON.stringify(store.get('crm-api'));
    const promptUser = vi.fn(async () => 'Allow');
    const reply = await adopt(agentWith(store, { live: ['M-1'], promptUser }));
    expect(reply).toContain('still active, so its connection is in use and cannot be adopted now');
    expect(promptUser).not.toHaveBeenCalled();
    expect(JSON.stringify(store.get('crm-api'))).toBe(before);
  });

  it('says what the mandate had chosen when the profile was the mandate\'s', async () => {
    const reply = await adopt(agentWith(storeWith()));
    expect(reply).toContain('This profile had been set up in a mandate\'s session; it is now yours.');
  });

  it('adds no such note for a profile that was already the owner\'s', async () => {
    const store = storeWith(crmProfile({ created_by: undefined }));
    const reply = await adopt(agentWith(store));
    expect(reply).toContain('Adopted:');
    expect(reply).not.toContain('had been set up in a mandate\'s session');
    expect(store.get('crm-api')?.oauth_grant?.connected_by).toBe('owner');
  });

  it.each([
    ['the user declines', { promptUser: async () => 'Deny' }, 'user declined'],
    ['nobody can be asked', { promptUser: null }, 'no interactive prompt is available'],
    ['a mandate asks', { principal: MANDATE }, 'only the owner can adopt'],
  ] as const)('changes nothing when %s', async (_label, opts, says) => {
    const store = storeWith();
    const before = JSON.stringify(store.get('crm-api'));
    const reply = await adopt(agentWith(store, opts as AgentOpts));
    expect(reply).toContain(says);
    expect(JSON.stringify(store.get('crm-api'))).toBe(before);
  });

  it('asks nothing of a mandate', async () => {
    const promptUser = vi.fn(async () => 'Allow');
    await adopt(agentWith(storeWith(), { principal: MANDATE, promptUser }));
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('asks nothing and changes nothing when the run was stopped', async () => {
    const store = storeWith();
    const ac = new AbortController();
    ac.abort();
    const promptUser = vi.fn(async () => 'Allow');
    const reply = await adopt(agentWith(store, { promptUser, runSignal: ac.signal }));
    expect(reply).toContain('the run was stopped');
    expect(promptUser).not.toHaveBeenCalled();
    expect(store.get('crm-api')?.oauth_grant?.connected_by).toBe(TAG);
  });

  it('asks nothing about a connection no mandate made', async () => {
    const promptUser = vi.fn(async () => 'Allow');
    const reply = await adopt(agentWith(storeWith(crmProfile({ created_by: undefined, oauth_grant: undefined })), { promptUser }));
    expect(reply).toContain('there is nothing to adopt');
    expect(promptUser).not.toHaveBeenCalled();
  });

  it.each([
    ['the path of the host', (p: ApiProfile): ApiProfile => ({ ...p, base_url: 'https://api.crm.example/v2' })],
    ['the host', (p: ApiProfile): ApiProfile => ({ ...p, base_url: 'https://api.crm2.example/v1', custom_endpoint_ack: { ...ACK, hosts: ['api.crm2.example'] } })],
    ['a vault name', (p: ApiProfile): ApiProfile => ({ ...p, auth: { ...p.auth!, vault_keys: ['CRM_CLIENT_ID', 'OWNER_STRIPE_KEY'], oauth: { ...p.auth!.oauth!, client_secret_key: 'OWNER_STRIPE_KEY' } } })],
    ['the token endpoint', (p: ApiProfile): ApiProfile => ({ ...p, auth: { ...p.auth!, oauth: { ...p.auth!.oauth!, token_url: 'https://api.crm.example/oauth/other' } } })],
    ['the name', (p: ApiProfile): ApiProfile => ({ ...p, name: 'CRM renamed' })],
    ['the consent', (p: ApiProfile): ApiProfile => ({ ...p, oauth_grant: { ...p.oauth_grant!, connected_by: 'mandate:other@example.org' } })],
    ['the mandate id', (p: ApiProfile): ApiProfile => ({ ...p, oauth_grant: { ...p.oauth_grant!, connected_mandate_id: 'M-2' } })],
    ['the author', (p: ApiProfile): ApiProfile => ({ ...p, created_by: undefined })],
  ])('asks again when %s changed while the question was open', async (_label, change) => {
    const store = storeWith();
    const changed = change(store.get('crm-api')!);
    const reply = await adopt(agentWith(store, { promptUser: async () => { store.unregister('crm-api'); store.register(changed); return 'Allow'; } }));
    expect(reply).toContain('changed while the question was open');
    expect(store.get('crm-api')?.oauth_grant?.connected_by).not.toBe('owner');
  });

  it('adopts nothing when the profile was deleted while the question was open', async () => {
    const store = storeWith();
    const reply = await adopt(agentWith(store, { promptUser: async () => { store.remove('crm-api'); return 'Allow'; } }));
    expect(reply).toContain('was deleted while the question was open');
    expect(store.get('crm-api')).toBeUndefined();
  });

  it.each([
    ['no id', { action: 'adopt_connection' }, '"id" is required'],
    ['an unknown id', { action: 'adopt_connection', id: 'nope' }, 'not found'],
  ])('refuses %s', async (_label, input, says) => {
    expect(await run(agentWith(storeWith()), input)).toContain(says);
  });
});

describe('adopt_connection compares against the profile as it was asked about', () => {
  it('asks again when the stored object itself was changed in place while the question was open', async () => {
    const store = storeWith();
    const reply = await adopt(agentWith(store, { promptUser: async () => { store.get('crm-api')!.base_url = 'https://api.crm.example/elsewhere'; return 'Allow'; } }));
    expect(reply).toContain('changed while the question was open');
    expect(store.get('crm-api')?.oauth_grant?.connected_by).toBe(TAG);
  });
});
