import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

import { apiSetupTool } from './api-setup.js';
import { ApiStore, type ApiProfile } from '../../core/api-store.js';
import { ConnectionStore } from '../../core/connection-store.js';
import { EngineDb } from '../../core/engine-db.js';
import { SecretReleases } from '../../core/secret-releases.js';
import { releaseBinding } from '../../core/profile-secret-view.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../core/request-principal.js';

// PRD customer-granted-operator-access §3.13: the way a profile a mandate wrote comes to read a name
// of the owner's — the mandate's save asks, the owner answers in person.

const M = 'mandate:setup@example.org';
const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' };
const ACK = { accepted: true as const, hosts: ['api.crm.example'], accepted_at: '2026-09-22T00:00:00.000Z' };

let dir: string;
let edb: EngineDb;
let releases: SecretReleases;
let live: Set<string>;

beforeEach(() => {
  mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-api-release-test-'));
  dir = mockLynoxDir;
  edb = new EngineDb(join(dir, 'engine.db'));
  releases = new SecretReleases(edb.getDb());
  live = new Set(['M-1']);
});
afterEach(() => {
  vi.restoreAllMocks();
  edb.close();
  rmSync(dir, { recursive: true, force: true });
});

function vault(seed: Record<string, string>, env: readonly string[] = []): Record<string, unknown> & { peek(n: string): string | undefined } {
  const store: Record<string, string> = { ...seed };
  return {
    resolve: (n: string) => store[n] ?? null,
    resolveSecretRefs: (input: unknown) => JSON.parse(JSON.stringify(input).replace(/secret:([A-Z_][A-Z0-9_]*)/g, (m, n: string) => store[n] ?? m)) as unknown,
    extractSecretNames: (input: unknown) => [...JSON.stringify(input).matchAll(/secret:([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!),
    isEnvironmentSecret: (n: string) => env.includes(n),
    listNames: () => Object.keys(store),
    set: (n: string, v: string) => { store[n] = v; },
    peek: (n: string) => store[n],
  };
}

function apis(profiles: ApiProfile[]): ApiStore {
  const s = new ApiStore(join(dir, 'apis'), new ConnectionStore(edb));
  for (const p of profiles) s.register(p);
  return s;
}

const bearer = (over: Partial<ApiProfile> = {}): ApiProfile => ({
  id: 'crm-api', name: 'CRM', base_url: 'https://api.crm.example/v1', description: 'd', created_by: M,
  auth: { type: 'bearer', vault_keys: ['CRM_KEY'] }, custom_endpoint_ack: ACK,
  endpoints: [{ method: 'GET', path: '/contacts', description: 'list contacts' }],
  guidelines: ['page with ?page='], avoid: ['no bulk deletes'], ...over,
});

function agentOf(apiStore: ApiStore, v: unknown, opts: {
  principal?: RequestPrincipal; promptUser?: (q: unknown) => Promise<string>; autonomy?: 'autonomous' | 'guided';
} = {}): never {
  return {
    principal: opts.principal ?? OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    secretStore: v,
    autonomy: opts.autonomy,
    getAvailableTools: () => [{ definition: { name: 'api_setup' } }, { definition: { name: 'http_request' } }],
    promptUser: opts.promptUser,
    toolContext: {
      apiStore, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
      secretReleases: releases, mandateEnds: { isLive: (id: string) => live.has(id) }, auditLog: null,
    },
  } as never;
}

const ask = (p: ApiProfile, name = 'CRM_KEY', mandateId = 'M-1'): void => {
  releases.replaceRequests(p.id, p.created_by!, mandateId, [{ name, binding: releaseBinding(p, name)! }]);
};

describe('a mandate\'s save asks the owner', () => {
  it('records what the profile reads of the owner\'s, and tells the mandate it was asked', async () => {
    const apiStore = apis([]);
    const out = await apiSetupTool.handler({ action: 'create', profile: bearer() } as never, agentOf(apiStore, vault({ CRM_KEY: 'v' }), { principal: MANDATE, promptUser: async () => 'Allow' }));
    expect(out).toContain('"CRM_KEY"');
    expect(out).toContain('The owner sees what the profile asks for');
    expect(releases.pendingReleases().map((r) => [r.profileId, r.profileAuthor, r.name, r.mandateId])).toEqual([['crm-api', M, 'CRM_KEY', 'M-1']]);
  });

  it('asks the same whether the vault holds the name or not', async () => {
    const out = await apiSetupTool.handler({ action: 'create', profile: bearer() } as never, agentOf(apis([]), vault({}), { principal: MANDATE, promptUser: async () => 'Allow' }));
    expect(out).toContain('The owner sees what the profile asks for');
    expect(releases.pendingReleases()).toHaveLength(1);
  });

  it('tells the mandate the same whether or not the name can be asked for: a value from the environment', async () => {
    const asked = await apiSetupTool.handler({ action: 'create', profile: bearer() } as never, agentOf(apis([]), vault({ CRM_KEY: 'v' }), { principal: MANDATE, promptUser: async () => 'Allow' }));
    releases.forgetProfile('crm-api');
    rmSync(join(dir, 'apis'), { recursive: true, force: true });
    const env = await apiSetupTool.handler({ action: 'create', profile: bearer() } as never, agentOf(apis([]), vault({ CRM_KEY: 'v' }, ['CRM_KEY']), { principal: MANDATE, promptUser: async () => 'Allow' }));
    expect(env).toContain('"CRM_KEY"');
    expect(env).toBe(asked);
    // Only what can be released is put before the owner.
    expect(releases.pendingReleases()).toEqual([]);
  });

  it('asks nothing for a mandate without a grant id: there is no grant a release could be for', async () => {
    const noId: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org' };
    await apiSetupTool.handler({ action: 'create', profile: bearer() } as never, agentOf(apis([]), vault({ CRM_KEY: 'v' }), { principal: noId, promptUser: async () => 'Allow' }));
    expect(releases.pendingReleases()).toEqual([]);
  });

  it('asks nothing for a name that cannot be released: a query parameter', async () => {
    const q = bearer({ auth: { type: 'query', query_param: 'key', vault_keys: ['CRM_KEY'] } });
    await apiSetupTool.handler({ action: 'create', profile: q } as never, agentOf(apis([]), vault({ CRM_KEY: 'v' }), { principal: MANDATE, promptUser: async () => 'Allow' }));
    expect(releases.pendingReleases()).toEqual([]);
  });

  it('the owner hears of an open request in every answer, while the mandate that asked is active', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    const out = await apiSetupTool.handler({ action: 'list' } as never, agentOf(apiStore, vault({})));
    expect(out).toContain('Waiting for the owner');
    expect(out).toContain('"CRM_KEY" for "crm-api"');
    live.clear();
    expect(await apiSetupTool.handler({ action: 'list' } as never, agentOf(apiStore, vault({})))).not.toContain('"CRM_KEY" for "crm-api"');
    // A mandate's turn hears nothing of it.
    live.add('M-1');
    expect(await apiSetupTool.handler({ action: 'list' } as never, agentOf(apiStore, vault({}), { principal: MANDATE }))).not.toContain('Waiting for the owner');
  });
});

describe('release_secret: the owner answers in person', () => {
  const release = (apiStore: ApiStore, opts: Parameters<typeof agentOf>[2] = {}): Promise<string> =>
    apiSetupTool.handler({ action: 'release_secret', id: 'crm-api', secret_name: 'CRM_KEY' } as never, agentOf(apiStore, vault({ CRM_KEY: 'owner-value' }), opts));

  it('asks the person, naming the profile, its author, every host and the name, and records the release', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    let question = '';
    const out = await release(apiStore, { promptUser: async (q) => { question = flattenPrompt(q as never); return 'Allow'; } });
    expect(out).toContain('Released "CRM_KEY"');
    for (const part of ['"CRM_KEY"', 'crm-api', M, 'api.crm.example']) expect(question).toContain(part);
    expect(releases.releaseOf('crm-api', M, 'CRM_KEY')).toEqual({ binding: releaseBinding(p, 'CRM_KEY'), mandateId: 'M-1' });
    expect(releases.pendingReleases()).toEqual([]);
  });

  it('records nothing on a no', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    expect(await release(apiStore, { promptUser: async () => 'Deny' })).toContain('user declined');
    expect(releases.activeReleases()).toEqual([]);
  });

  it('is refused in an unattended run, before anyone is asked, even with a prompt channel', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    const promptUser = vi.fn(async () => 'Allow');
    expect(await release(apiStore, { promptUser, autonomy: 'autonomous' })).toContain('Blocked');
    expect(promptUser).not.toHaveBeenCalled();
    expect(releases.activeReleases()).toEqual([]);
  });

  it('is refused with no one to ask', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    expect(await release(apiStore)).toContain('Blocked');
    expect(releases.activeReleases()).toEqual([]);
  });

  it('is refused to a mandate, which answers its own session\'s questions', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    expect(await release(apiStore, { principal: MANDATE, promptUser: async () => 'Allow' })).toContain('only the owner');
    expect(releases.activeReleases()).toEqual([]);
  });

  it('records nothing when where the value goes changed while the question was open', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    const out = await release(apiStore, { promptUser: async () => { apiStore.register(bearer({ base_url: 'https://elsewhere.example/v1' }), 'load'); return 'Allow'; } });
    expect(out).toContain('changed while the question was open');
    expect(releases.activeReleases()).toEqual([]);
  });

  it('keeps the answer when only what the engine rewrites changed while the question was open', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    const out = await release(apiStore, { promptUser: async () => { apiStore.register(bearer({ oauth_grant: { state: 'connected' } }), 'load'); return 'Allow'; } });
    expect(out).toContain('Released');
  });

  it('is refused once the mandate that asked is no longer active: its release could never be read', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    live.clear();
    const promptUser = vi.fn(async () => 'Allow');
    expect(await release(apiStore, { promptUser })).toContain('no longer active');
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('is refused, without asking, once the profile no longer is what it was when it asked', async () => {
    const p = bearer();
    ask(p);
    const apiStore = apis([bearer({ base_url: 'https://elsewhere.example/v1' })]);
    const promptUser = vi.fn(async () => 'Allow');
    expect(await release(apiStore, { promptUser })).toContain('changed since it asked');
    expect(promptUser).not.toHaveBeenCalled();
    expect(releases.activeReleases()).toEqual([]);
  });

  it('is refused, without asking, when the name cannot be released any more though it was asked for', async () => {
    const p = bearer();
    ask(p);
    const other = bearer({ id: 'erp-api', base_url: 'https://api.erp.example', created_by: 'mandate:other@example.org' });
    const apiStore = apis([p, other]);
    const promptUser = vi.fn(async () => 'Allow');
    expect(await release(apiStore, { promptUser })).toContain('cannot be released');
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('records nothing when the author changed while the question was open', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    const out = await release(apiStore, { promptUser: async () => { apiStore.register(bearer({ created_by: 'mandate:other@example.org' }), 'load'); return 'Allow'; } });
    expect(out).toContain('changed while the question was open');
    expect(releases.activeReleases()).toEqual([]);
  });

  it('records nothing when the mandate that asked ended while the question was open', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    const out = await release(apiStore, { promptUser: async () => { live.clear(); return 'Allow'; } });
    expect(out).toContain('ended while the question was open');
    expect(releases.activeReleases()).toEqual([]);
  });

  it('names a port and a scheme other than https in the question', async () => {
    const p = bearer({ base_url: 'http://api.crm.example:8443/v1' });
    const apiStore = apis([p]);
    ask(p);
    let question = '';
    await release(apiStore, { promptUser: async (q) => { question = flattenPrompt(q as never); return 'Deny'; } });
    expect(question).toContain('http://api.crm.example:8443');
  });

  it('asks for a base with a scheme the URL standard does not know, naming it', async () => {
    const p = bearer({ base_url: 'foo://api.crm.example/v1' });
    const apiStore = apis([p]);
    ask(p);
    let question = '';
    const out = await release(apiStore, { promptUser: async (q) => { question = flattenPrompt(q as never); return 'Deny'; } });
    expect(out).toContain('user declined');
    expect(question).toContain('foo://api.crm.example');
    expect(releaseBinding(p, 'CRM_KEY')).not.toBe(releaseBinding(bearer({ base_url: 'foo://api.other.example/v1' }), 'CRM_KEY'));
  });

  it('is refused for a name the profile never asked for', async () => {
    const apiStore = apis([bearer()]);
    expect(await release(apiStore, { promptUser: async () => 'Allow' })).toContain('has not asked for');
  });

  it('withdraw_release takes it back without asking', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    releases.release({ kind: 'owner' }, { profileId: 'crm-api', profileAuthor: M, name: 'CRM_KEY', binding: releaseBinding(p, 'CRM_KEY')!, mandateId: 'M-1' });
    const out = await apiSetupTool.handler({ action: 'withdraw_release', id: 'crm-api', secret_name: 'CRM_KEY' } as never, agentOf(apiStore, vault({})));
    expect(out).toContain('was taken back');
    expect(releases.activeReleases()).toEqual([]);
  });

  it('a delete of the profile drops its requests and releases', async () => {
    const p = bearer();
    const apiStore = apis([p]);
    ask(p);
    await apiSetupTool.handler({ action: 'delete', id: 'crm-api' } as never, agentOf(apiStore, vault({}), { promptUser: async () => 'Allow' }));
    expect(releases.pendingReleases()).toEqual([]);
  });
});

describe('the owner\'s exchange does not write into a mandate\'s token slot', () => {
  it('refuses an output_secret_name that is where a profile a mandate wrote keeps its tokens, and sends nothing', async () => {
    const owners: ApiProfile = {
      id: 'erp-api', name: 'ERP', base_url: 'https://api.erp.example', description: 'd', custom_endpoint_ack: { ...ACK, hosts: ['api.erp.example'] },
      auth: { type: 'oauth2', vault_keys: ['ERP_CLIENT_ID', 'ERP_CLIENT_SECRET'], oauth: { token_url: 'https://api.erp.example/token', grant_type: 'client_credentials', client_id_key: 'ERP_CLIENT_ID', client_secret_key: 'ERP_CLIENT_SECRET' } },
    };
    const mandates = bearer({ auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID'], oauth: { token_url: 'https://api.crm.example/token', client_id_key: 'CRM_CLIENT_ID' } } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const v = vault({ ERP_CLIENT_ID: 'i', ERP_CLIENT_SECRET: 's' });
    const out = await apiSetupTool.handler({ action: 'fetch_token', id: 'erp-api', output_secret_name: 'CRM_API_ACCESS_TOKEN' } as never, agentOf(apis([owners, mandates]), v));
    expect(out).toContain('set up in a mandate\'s session');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(v.peek('CRM_API_ACCESS_TOKEN')).toBeUndefined();
  });
});
