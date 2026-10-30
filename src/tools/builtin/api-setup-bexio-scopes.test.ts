import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { apiSetupTool } from './api-setup.js';
import { ApiStore, type ApiProfile } from '../../core/api-store.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';

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
    toolContext: { vaultNameBindings: bindingsAsMigrated(store), apiStore: store, dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity, isolationEnvOverride: undefined, isolationMinimalEnv: false },
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

// The connect route shows the approved text and the write scopes before it sends anyone to bexio;
// the link the model hands out says so, and names the write scopes, so a scope an update added is
// not news to the person on bexio's page.
describe('connect tells the model about the page before bexio', () => {
  let originBefore: string | undefined;
  beforeEach(() => { originBefore = process.env['ORIGIN']; process.env['ORIGIN'] = 'https://tenant.lynox.example'; });
  afterEach(() => { if (originBefore === undefined) delete process.env['ORIGIN']; else process.env['ORIGIN'] = originBefore; });
  const connect = (scope: string): Promise<string> => {
    const store = new ApiStore();
    store.register({
      ...bexioProfile(scope),
      custom_endpoint_ack: { accepted: true, hosts: ['api.bexio.com', 'auth.bexio.com'], redirect_hosts: ['auth.bexio.com'], accepted_at: '2026-10-08T00:00:00.000Z' },
    });
    // The client pair is in the vault, as it is before a connect: `secret:NAME` resolves.
    const agent = {
      ...(agentWith(store) as object),
      secretStore: {
        extractSecretNames: (input: unknown): string[] => [...JSON.stringify(input).matchAll(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g)].map((m) => m[1]!),
        resolveSecretRefs: (input: unknown): unknown => JSON.parse(JSON.stringify(input).replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, 'fixture-value')) as unknown,
      },
    } as never;
    return apiSetupTool.handler({ action: 'connect', id: 'bexio-api' }, agent) as Promise<string>;
  };

  it('names the page and the write scopes the link asks for', async () => {
    const reply = await connect('contact_show kb_invoice_edit');
    expect(reply).toContain('It first shows a page on this instance with what lynox may do there and the write access this link asks for (kb_invoice_edit); they read it and continue to auth.bexio.com, where they authorize this engine.');
  });

  it('control: a read-only link opens bexio, as before', async () => {
    const reply = await connect('contact_show');
    expect(reply).toContain('It opens auth.bexio.com, where they authorize this engine.');
    expect(reply).not.toContain('first shows a page');
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

describe('the bexio API is reached only through the provider', () => {
  const PREFIX = 'Invalid profile: the API of bexio is connected only through this engine\'s built-in "bexio" provider';
  const rest = { endpoints: [{ method: 'POST', path: '/2.0/contact', description: 'create a contact' }], guidelines: ['x'], avoid: ['x'] };
  const save = async (action: 'create' | 'update', profile: ApiProfile, store = new ApiStore()): Promise<{ out: string; store: ApiStore }> => {
    // A person accepts the hosts when asked, so a refusal here is this check's and not that gate's.
    const agent = Object.assign(agentWith(store) as object, { promptUser: async (): Promise<string> => 'Allow' }) as never;
    const out = await apiSetupTool.handler({ action, profile: { ...profile, ...rest } }, agent) as string;
    return { out, store };
  };
  const bearer = (baseUrl: string): ApiProfile => ({ id: 'bexio-pat', name: 'bexio', base_url: baseUrl, description: 'd', auth: { type: 'bearer', vault_keys: ['BEXIO_PAT'] } });
  const ownOauth: ApiProfile = {
    id: 'bexio-own', name: 'bexio', base_url: 'https://api.bexio.com/2.0', description: 'd',
    auth: { type: 'oauth2', vault_keys: ['BX_ID', 'BX_SECRET'], oauth: { grant_type: 'client_credentials', token_url: 'https://auth.bexio.com/realms/bexio/protocol/openid-connect/token', client_id_key: 'BX_ID', client_secret_key: 'BX_SECRET' } },
  };

  it.each([
    ['a pasted token', bearer('https://api.bexio.com/2.0')],
    ['a pasted token, the host spelled with a root dot', bearer('https://api.bexio.com./2.0')],
    ['an OAuth sign-in of its own', ownOauth],
  ] as const)('refuses a profile with %s, and saves nothing', async (_label, profile) => {
    const { out, store } = await save('create', profile);
    expect(out).toContain(PREFIX);
    expect(out).toContain('Use auth.type "oauth2" with auth.oauth.preset_id "bexio", then api_setup action "connect".');
    expect(store.get(profile.id)).toBeUndefined();
  });

  it('refuses an update that keeps a stored profile with a pasted token', async () => {
    const store = new ApiStore();
    store.register({ ...bearer('https://api.bexio.com/2.0'), ...rest });
    const { out } = await save('update', bearer('https://api.bexio.com/2.0'), store);
    expect(out).toContain(PREFIX);
  });

  // A stored profile with a pasted token is refined only into the provider's form: the reason
  // is the engine's own and is said, and the way out is this profile's update.
  it('refuses a refine of a stored profile with a pasted token, and says why', async () => {
    const store = new ApiStore();
    store.register({ ...bearer('https://api.bexio.com/2.0'), ...rest });
    const out = await apiSetupTool.handler({ action: 'refine', id: 'bexio-pat', refine: { addNotes: ['x'] } }, agentWith(store)) as string;
    expect(out).toContain('Error: the stored profile "bexio-pat" cannot be refined: the API of bexio is connected only through this engine\'s built-in "bexio" provider');
    expect(out).toContain('Change this profile with api_setup action="update"; reading through it works until then.');
    // bexio's host is a constant: it has no parameter to name.
    expect(out).not.toContain('preset_params');
  });

  it('control: saves the profile that goes through the provider', async () => {
    const { out, store } = await save('create', bexioProfile('contact_show'));
    expect(out).not.toContain('Invalid profile');
    expect(store.get('bexio-api')?.auth?.oauth?.preset_id).toBe('bexio');
  });

  it('control: saves a profile with a pasted token on a host no provider claims', async () => {
    const { out, store } = await save('create', bearer('https://api.crm.example/v1'));
    expect(out).not.toContain('Invalid profile');
    expect(store.get('bexio-pat')).toBeDefined();
  });
});
