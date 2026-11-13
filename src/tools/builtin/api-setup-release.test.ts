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
import { bindingOf, releaseBinding, settingsVersion } from '../../core/profile-secret-view.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../core/request-principal.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';
import { testAuditLog } from '../../../tests/helpers/audit-log.js';

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
  const conns = new ConnectionStore(edb);
  const s = new ApiStore();
  s.setConnectionStore(conns);
  for (const p of profiles) {
    // A profile in use has its row, and the row its opaque id, which the release question names.
    const saved = s.save(p, join(dir, 'apis'), { trailId: s.newTrailId() });
    if (!saved.ok) throw new Error(`fixture save refused: ${saved.reason}`);
  }
  return s;
}

const bearer = (over: Partial<ApiProfile> = {}): ApiProfile => ({
  id: 'crm-api', name: 'CRM', base_url: 'https://api.crm.example/v1', description: 'd', created_by: M,
  auth: { type: 'bearer', vault_keys: ['CRM_KEY'] }, custom_endpoint_ack: ACK,
  endpoints: [{ method: 'GET', path: '/contacts', description: 'list contacts' }],
  guidelines: ['page with ?page='], avoid: ['no bulk deletes'], ...over,
});

function agentOf(apiStore: ApiStore, v: unknown, opts: {
  principal?: RequestPrincipal; promptUser?: (q: unknown) => Promise<string>; autonomy?: 'autonomous' | 'guided'; userTimezone?: string;
} = {}): never {
  return {
    principal: opts.principal ?? OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    secretStore: v,
    autonomy: opts.autonomy,
    userTimezone: opts.userTimezone,
    getAvailableTools: () => [{ definition: { name: 'api_setup' } }, { definition: { name: 'http_request' } }],
    promptUser: opts.promptUser,
    toolContext: {
      apiStore, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
      vaultNameBindings: bindingsAsMigrated(apiStore),
      secretReleases: releases, mandateEnds: { isLive: (id: string) => live.has(id) },
      // A mandate's writes leave rows in the actor trail and are refused without one.
      auditLog: testAuditLog().log,
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

  it('asks nothing for a profile on plain http, and tells the mandate the same as on https', async () => {
    const plain = bearer({ base_url: 'http://api.crm.example/v1' });
    const out = await apiSetupTool.handler({ action: 'create', profile: plain } as never, agentOf(apis([]), vault({ CRM_KEY: 'v' }), { principal: MANDATE, promptUser: async () => 'Allow' }));
    expect(out).toContain('"CRM_KEY"');
    expect(out).toContain('The owner sees what the profile asks for');
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
    for (const part of ['"CRM_KEY"', apiStore.trailIdOf('crm-api')!, M, 'api.crm.example']) expect(question).toContain(part);
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

  it('counts every field whose change ends the release, and says whose runs send it', async () => {
    const p = bearer({ auth: { type: 'header', header_name: 'X-Api-Key', vault_keys: ['CRM_KEY'] } });
    const apiStore = apis([p]);
    ask(p);
    let question = '';
    await release(apiStore, { promptUser: async (q) => { question = flattenPrompt(q as never); return 'Deny'; } });
    expect(question).not.toContain('X-Api-Key');
    expect(question).toMatch(/ 2 more settings of this profile \(such as its auth type, scopes, path or query\) are part of the release too; a change to any of them ends it\./);
    expect(question).toContain('your own and bulk runs included, until that mandate ends or you withdraw the release');
    expect(question).not.toContain('while that mandate is active');
  });

  it('names the token endpoint by its host only', async () => {
    const p = bearer({ auth: { type: 'oauth2', vault_keys: ['CRM_KEY'], oauth: { token_url: 'https://auth.crm.example/oauth/token?tenant=t1', client_secret_key: 'CRM_KEY', grant_type: 'client_credentials' } } });
    const apiStore = apis([p]);
    ask(p);
    let question = '';
    await release(apiStore, { promptUser: async (q) => { question = flattenPrompt(q as never); return 'Deny'; } });
    expect(question).toContain('auth.crm.example');
    expect(question).not.toContain('/oauth/token');
    expect(question).not.toContain('tenant=t1');
  });

  it('names a port other than the default in the question', async () => {
    const p = bearer({ base_url: 'https://api.crm.example:8443/v1' });
    const apiStore = apis([p]);
    ask(p);
    let question = '';
    await release(apiStore, { promptUser: async (q) => { question = flattenPrompt(q as never); return 'Deny'; } });
    expect(question).toContain('api.crm.example:8443');
  });

  it.each([
    ['plain http', 'http://api.crm.example:8443/v1'],
    ['a scheme the URL standard does not know', 'foo://api.crm.example/v1'],
  ])('is refused, without asking, for a base on %s', async (_label, base_url) => {
    const p = bearer({ base_url });
    const apiStore = apis([p]);
    ask(p);
    const promptUser = vi.fn(async () => 'Allow');
    const out = await release(apiStore, { promptUser });
    expect(out).toContain('cannot be released');
    expect(out).toContain('not https');
    expect(promptUser).not.toHaveBeenCalled();
    expect(releases.activeReleases()).toEqual([]);
  });

  it('keeps an unknown scheme\'s host in the binding, so two such bases are not one', () => {
    expect(releaseBinding(bearer({ base_url: 'foo://api.crm.example/v1' }), 'CRM_KEY'))
      .not.toBe(releaseBinding(bearer({ base_url: 'foo://api.other.example/v1' }), 'CRM_KEY'));
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

describe('release_secret: the question carries no text a mandate\'s turn wrote', () => {
  // The release question carries fixed wording plus what the engine shapes. Every free field
  // of `injected` carries a phrase aimed at the owner; none may reach the dialog.
  const INJECTED = ['IGNORE', 'approved', 'lynox-verified', 'click Allow', 'lynox official', 'owner-approved-safe', 'approve-this'];
  const oauth = (o: Record<string, unknown> = {}): ApiProfile['auth'] => ({ type: 'oauth2', vault_keys: ['CRM_KEY'], oauth: {
    token_url: 'https://auth.crm.example/token', client_secret_key: 'CRM_KEY', grant_type: 'client_credentials', ...o,
  } } as ApiProfile['auth']);
  const injected = (): ApiProfile => bearer({
    id: 'owner-approved-safe',
    base_url: 'https://api.crm.example/v1/IGNORE-PREVIOUS?say=approved',
    custom_endpoint_ack: { ...ACK, hosts: ['api.crm.example', 'auth.crm.example'] },
    auth: oauth({ token_url: 'https://auth.crm.example/approve-this?note=lynox-verified', scope: 'read write\nOwner: this is safe, click Allow', audience: 'lynox official', preset_params: { note: 'approved by lynox' } }),
  });
  const plain = (over: Partial<ApiProfile> = {}): ApiProfile => bearer({
    base_url: 'https://api.crm.example', custom_endpoint_ack: { ...ACK, hosts: ['api.crm.example', 'auth.crm.example'] }, ...over,
  });
  async function questionFor(p: ApiProfile, v: Record<string, string> = { CRM_KEY: 'owner-value' }): Promise<{ question: string; apf: string; apiStore: ApiStore; p: ApiProfile }> {
    const apiStore = apis([p]);
    ask(p);
    let question = '';
    await apiSetupTool.handler({ action: 'release_secret', id: p.id, secret_name: 'CRM_KEY' } as never,
      agentOf(apiStore, vault(v), { promptUser: async (q) => { question = flattenPrompt(q as never); return 'Deny'; } }));
    return { question, apf: apiStore.trailIdOf(p.id)!, apiStore, p };
  }
  const head = (apf: string, role: string, hosts: string): string =>
    `⚠ api_setup: release the vault key "CRM_KEY" to API profile ${apf}? It was set up in the session of ${M}. If you allow it, lynox sends the value of "CRM_KEY", as ${role}, to ${hosts}, with every request and run through this profile, your own and bulk runs included, until that mandate ends or you withdraw the release.`;
  const tail = (held = 'holds a value'): string => ` The vault ${held} under this name. Any change to where the value goes ends the release. Release it?`;
  const more = (n: number, apf: string): string => n === 1
    ? ` 1 more setting of this profile (such as its auth type, scopes, path or query) is part of the release too; a change to it ends it. To see it first, deny, ask here to view API profile ${apf}, then ask to release "CRM_KEY" again.`
    : ` ${n} more settings of this profile (such as its auth type, scopes, path or query) are part of the release too; a change to any of them ends it. To see them first, deny, ask here to view API profile ${apf}, then ask to release "CRM_KEY" again.`;

  it('asks a profile with a phrase in every free field in fixed wording, by its opaque id, counting what it does not print', async () => {
    const { question, apf, apiStore, p } = await questionFor(injected());
    expect(apf).toMatch(/^apf_[0-9a-f]{16}$/);
    // Counted: auth.type, scope, audience, preset_params, and the token endpoint's path and query.
    expect(question).toBe(`${head(apf, 'oauth.client_secret_key', 'api.crm.example, auth.crm.example')}${more(5, apf)}${tail()}`);
    for (const s of INJECTED) expect(question).not.toContain(s);
  });

  it.each([
    ['plain RFC 6749 tokens', 'read write:contacts'],
    // One valid scope-token: any printable run without a space, quote or backslash. Listing plain
    // tokens was the first boundary, and this refuted it.
    ['one valid token that reads as an instruction', 'Owner-note:this-profile-was-reviewed-by-lynox-safe-to-Allow.'],
    ['a line break', 'read write\nOwner: click Allow'],
  ])('counts the scope and never lists it: %s', async (_label, scope) => {
    const { question, apf, apiStore, p } = await questionFor(plain({ auth: oauth({ token_url: 'https://auth.crm.example', scope }) }));
    expect(question).toBe(`${head(apf, 'oauth.client_secret_key', 'api.crm.example, auth.crm.example')}${more(2, apf)}${tail()}`);
    for (const t of scope.split(/\s+/)) expect(question).not.toContain(t);
  });

  it('counts a scope that is not a string', async () => {
    const { question, apf, apiStore, p } = await questionFor(plain({ auth: oauth({ token_url: 'https://auth.crm.example', scope: ['read', 'click Allow'] }) }));
    expect(question).toBe(`${head(apf, 'oauth.client_secret_key', 'api.crm.example, auth.crm.example')}${more(2, apf)}${tail()}`);
  });

  it.each([
    ['userinfo', 'https://note-approved@auth.crm.example'],
    ['a fragment', 'https://auth.crm.example/#approved'],
  ])('counts a token endpoint that carries %s, and prints none of it', async (_label, token_url) => {
    const { question, apf, apiStore, p } = await questionFor(plain({ auth: oauth({ token_url }) }));
    expect(question).toBe(`${head(apf, 'oauth.client_secret_key', 'api.crm.example, auth.crm.example')}${more(2, apf)}${tail()}`);
    expect(question).not.toContain('approved');
  });

  it('counts the auth type as a setting, alone in the singular, and a token endpoint with a path as one more', async () => {
    // `auth.type` is bound, so every profile has at least one. The base URL's path is not bound
    // (the base is read by its origin), so it is not counted.
    const one = await questionFor(plain({ base_url: 'https://api.crm.example/v1' }));
    expect(one.question).toBe(`${head(one.apf, 'vault_keys[0]', 'api.crm.example')}${more(1, one.apf)}${tail()}`);
    const two = await questionFor(plain({ auth: oauth({ token_url: 'https://auth.crm.example/token' }) }));
    expect(two.question).toBe(`${head(two.apf, 'oauth.client_secret_key', 'api.crm.example, auth.crm.example')}${more(2, two.apf)}${tail()}`);
  });

  it('adds the sign-in link for a client id, and says when the vault holds no value yet', async () => {
    const { question, apf, apiStore, p } = await questionFor(plain({ auth: { type: 'oauth2', vault_keys: ['CRM_KEY'], oauth: { token_url: 'https://auth.crm.example', client_id_key: 'CRM_KEY' } } as ApiProfile['auth'] }), {});
    expect(question).toBe(`${head(apf, 'oauth.client_id_key', 'api.crm.example, auth.crm.example')}${more(1, apf)} A client id also goes into the sign-in link, to the browser of whoever opens it.${tail('holds no value yet')}`);
  });

  it('leaves the request standing on a deny, so the owner can view the profile and be asked again', async () => {
    const p = plain({ base_url: 'https://api.crm.example/v1' });
    const { apf, apiStore } = await questionFor(p);
    expect(releases.requestOf(p.id, 'CRM_KEY')).toBeDefined();
    const viewed = await apiSetupTool.handler({ action: 'view', id: apf } as never, agentOf(apiStore, vault({})));
    expect(viewed).toContain('https://api.crm.example/v1');
    // The owner asks again by the id the question named.
    const again = await apiSetupTool.handler({ action: 'release_secret', id: apf, secret_name: 'CRM_KEY' } as never,
      agentOf(apiStore, vault({ CRM_KEY: 'owner-value' }), { promptUser: async () => 'Allow' }));
    expect(again).toContain('Released "CRM_KEY"');
    expect(releases.releaseOf(p.id, M, 'CRM_KEY')).toBeDefined();
    const back = await apiSetupTool.handler({ action: 'withdraw_release', id: apf, secret_name: 'CRM_KEY' } as never, agentOf(apiStore, vault({})));
    expect(back).toContain('was taken back');
    expect(releases.activeReleases()).toEqual([]);
  });

  describe('the owner\'s view and the next question', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T13:05:00Z')); });
    afterEach(() => { vi.useRealTimers(); });
    const asked = async (apiStore: ApiStore, id: string, opts: { userTimezone?: string } = {}): Promise<string> => {
      let q = '';
      await apiSetupTool.handler({ action: 'release_secret', id, secret_name: 'CRM_KEY' } as never,
        agentOf(apiStore, vault({ CRM_KEY: 'owner-value' }), { promptUser: async (x) => { q = flattenPrompt(x as never); return 'Deny'; }, ...opts }));
      return q;
    };
    const viewAs = (apiStore: ApiStore, id: string, principal: RequestPrincipal = OWNER_PRINCIPAL): Promise<string> =>
      apiSetupTool.handler({ action: 'view', id } as never, agentOf(apiStore, vault({}), { principal, promptUser: async () => 'Deny' })) as Promise<string>;

    it('says nothing of a view the owner has not made, and view names the version', async () => {
      const p = plain({ auth: oauth({ token_url: 'https://auth.crm.example', scope: 'read' }) });
      const { question, apf, apiStore } = await questionFor(p);
      expect(question).not.toContain('last read');
      expect(await viewAs(apiStore, apf)).toContain(`Release settings of API profile ${apf}: version ${settingsVersion(p)}.`);
    });

    it('says the settings have not changed since the owner viewed them, at the owner\'s time', async () => {
      const p = plain({ auth: oauth({ token_url: 'https://auth.crm.example', scope: 'read' }) });
      const { apf, apiStore } = await questionFor(p);
      await viewAs(apiStore, apf);
      vi.setSystemTime(new Date('2026-11-09T13:20:00Z'));
      expect(await asked(apiStore, apf)).toContain(` These settings were last read in one of your chats at 13:05 UTC and have not changed since (version ${settingsVersion(p)}).`);
      expect(await asked(apiStore, apf, { userTimezone: 'Europe/Zurich' })).toContain(' These settings were last read in one of your chats at 14:05 and have not changed since');
    });

    it('says the settings changed when a mandate saved the profile again after the owner\'s view, though the words are the same', async () => {
      const p = plain({ auth: oauth({ token_url: 'https://auth.crm.example', scope: 'read' }) });
      const { apf, apiStore } = await questionFor(p);
      await viewAs(apiStore, apf);
      const before = await asked(apiStore, apf);
      const changed = plain({ auth: oauth({ token_url: 'https://auth.crm.example', scope: 'read write' }) });
      apiStore.register(changed, 'load');
      ask(changed);
      const after = await asked(apiStore, apf);
      expect(after).toContain(` These settings changed after they were last read in one of your chats at 13:05 UTC; deny and view the profile again before you allow it (version ${settingsVersion(changed)}).`);
      expect(before).not.toContain('changed after');
      // Apart from that sentence, the two questions read the same.
      const strip = (q: string): string => q.replace(/ These settings (were last read|changed after)[^()]*\(version [0-9a-f]{8}\)\./, '');
      expect(strip(after)).toBe(strip(before));
    });

    it('compares the whole digest, not the version it shows', async () => {
      // A mandate writes both settings and could match an 8-digit prefix by trying; the engine
      // compares all of it. A view whose digest shares only the prefix counts as a change.
      const p = plain();
      const { apf, apiStore } = await questionFor(p);
      const full = bindingOf(p);
      apiStore.noteOwnerView(p.id, `${full.slice(0, 8)}${full.slice(8).replace(/./g, (c) => (c === '0' ? '1' : '0'))}`, new Date());
      expect(await asked(apiStore, apf)).toContain(' These settings changed after they were last read in one of your chats at 13:05 UTC;');
    });

    it.each([
      ['a workflow or worker run, with no one to prompt', { promptUser: undefined }],
      // A prompt channel present, so only the autonomy decides.
      ['an autonomous turn', { autonomy: 'autonomous' as const, promptUser: async () => 'Deny' }],
    ])('does not count the owner\'s view from %s as a read', async (_label, opts) => {
      const p = plain();
      const { apf, apiStore } = await questionFor(p);
      expect(await apiSetupTool.handler({ action: 'view', id: apf } as never, agentOf(apiStore, vault({}), opts))).toContain(`Release settings of API profile ${apf}:`);
      expect(apiStore.ownerViewOf(p.id)).toBeUndefined();
      expect(await asked(apiStore, apf)).not.toContain('last read');
    });

    it('does not count a mandate\'s view as the owner\'s', async () => {
      const p = plain();
      const { apf, apiStore } = await questionFor(p);
      // The mandate's view goes through and names the version; it just is not the owner's.
      expect(await viewAs(apiStore, apf, MANDATE)).toContain(`Release settings of API profile ${apf}:`);
      expect(await asked(apiStore, apf)).not.toContain('last read');
    });
  });

  it('view of the owner\'s own profile names no release version', async () => {
    const apiStore = apis([plain({ created_by: undefined })]);
    const viewed = await apiSetupTool.handler({ action: 'view', id: 'crm-api' } as never, agentOf(apiStore, vault({})));
    expect(viewed).not.toContain('Release settings');
  });

  it('refuses a new profile id shaped like an opaque id, and still loads a stored one', () => {
    const apiStore = apis([]);
    const shaped = plain({ id: 'apf_0123456789abcdef' });
    const saved = apiStore.save(shaped, join(dir, 'apis'), { trailId: apiStore.newTrailId() });
    expect(saved.ok).toBe(false);
    expect(saved.ok ? '' : saved.reason).toContain('reserved');
    expect(apiStore.register(shaped, 'load')).toBe(true);
  });

  it.each(['view', 'release_secret', 'withdraw_release'] as const)('%s reaches the profile the question named, even when a stored profile\'s id is spelled like its opaque id', async (action) => {
    const p = plain();
    const apiStore = apis([p]);
    const apf = apiStore.trailIdOf('crm-api')!;
    apiStore.register(plain({ id: apf, name: 'Lookalike', base_url: 'https://api.lookalike.example' }), 'load');
    ask(p);
    if (action === 'withdraw_release') releases.release({ kind: 'owner' }, { profileId: 'crm-api', profileAuthor: M, name: 'CRM_KEY', binding: releaseBinding(p, 'CRM_KEY')!, mandateId: 'M-1' });
    let question = '';
    const out = await apiSetupTool.handler({ action, id: apf, secret_name: 'CRM_KEY' } as never,
      agentOf(apiStore, vault({ CRM_KEY: 'v' }), { promptUser: async (q) => { question = flattenPrompt(q as never); return 'Deny'; } }));
    if (action === 'view') { expect(out).toContain('api.crm.example'); expect(out).not.toContain('api.lookalike.example'); }
    if (action === 'release_secret') { expect(question).toContain('to api.crm.example,'); expect(question).not.toContain('lookalike'); }
    if (action === 'withdraw_release') { expect(out).toContain('was taken back'); expect(releases.activeReleases()).toEqual([]); }
  });

  it('view takes the opaque id, and an unknown one is not found', async () => {
    const apiStore = apis([plain()]);
    const apf = apiStore.trailIdOf('crm-api')!;
    expect(await apiSetupTool.handler({ action: 'view', id: apf } as never, agentOf(apiStore, vault({})))).toContain('crm-api');
    expect(await apiSetupTool.handler({ action: 'view', id: 'apf_0000000000000000' } as never, agentOf(apiStore, vault({})))).toContain('not found');
  });

  it('asks nothing for a profile with no opaque id to name it by', async () => {
    const p = plain();
    const apiStore = new ApiStore();
    apiStore.register(p);
    ask(p);
    const promptUser = vi.fn(async () => 'Allow');
    const out = await apiSetupTool.handler({ action: 'release_secret', id: p.id, secret_name: 'CRM_KEY' } as never, agentOf(apiStore, vault({ CRM_KEY: 'v' }), { promptUser }));
    expect(String(out).split('\n')[0]).toBe('"CRM_KEY" cannot be released to this API profile yet: it has no opaque id to name it by in the question. lynox assigns one when it starts; after that, the release can be asked for again. Nothing was changed.');
    expect(promptUser).not.toHaveBeenCalled();
    expect(releases.activeReleases()).toEqual([]);
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
    expect(out).toContain('is a name API profile "crm-api" uses');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(v.peek('CRM_API_ACCESS_TOKEN')).toBeUndefined();
  });
});
