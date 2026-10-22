import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({ default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) } }));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

let dir = '';
vi.mock('../../core/config.js', async (orig) => ({ ...(await orig<typeof import('../../core/config.js')>()), getLynoxDir: () => dir }));

import { ApiStore, accessTokenKey, type ApiProfile } from '../../core/api-store.js';
import { EngineDb } from '../../core/engine-db.js';
import { SecretReleases } from '../../core/secret-releases.js';
import { releaseBinding, slotMayReach, slotsToClearBeforeSave } from '../../core/profile-secret-view.js';
import { setPinnedTransportForTests } from '../../core/network-guard.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import type { PromptText } from '../../types/index.js';
import { apiSetupTool } from './api-setup.js';
import { httpRequestTool } from './http.js';

/**
 * Where a vault secret may go (`vault-name-bindings.ts`), end to end through the tools that send
 * one: the attach of `http_request`, `api_setup fetch_token`, and the saves that may widen it.
 *
 * Each case boots the way an engine does: the profiles stored at the first boot are registered,
 * then the one-time migration binds every name they agree on. What a test adds after that is a
 * profile stored later (a file edited by hand, or a save), which the binding does not follow.
 * The bindings module is loaded only if it exists, so the same cases also run against a tree
 * without it and show what went out there.
 */
const bindingsModule = await import('../../core/vault-name-bindings.js').catch(() => null);

// Values built at runtime: nothing here has the shape of a real credential.
const value = (tag: string): string => `${tag}-${randomBytes(6).toString('hex')}`;

const ACK_AT = '2026-10-18T00:00:00.000Z';
const ack = (...hosts: string[]): ApiProfile['custom_endpoint_ack'] => ({ accepted: true, hosts, accepted_at: ACK_AT });
const extra = { endpoints: [{ method: 'GET', path: '/items', description: 'List items' }], guidelines: ['Page with cursor'], avoid: ['Do not poll'] };

/** The owner's OAuth app on owner.example, with its own client pair. */
const owner = (): ApiProfile => ({
  id: 'owner', name: 'Owner', base_url: 'https://owner.example/v1', description: 'd', custom_endpoint_ack: ack('owner.example'),
  auth: { type: 'oauth2', vault_keys: ['OWN_CID', 'OWN_CSECRET'], oauth: { token_url: 'https://owner.example/oauth/token', grant_type: 'client_credentials', client_id_key: 'OWN_CID', client_secret_key: 'OWN_CSECRET' } },
} as ApiProfile);

/** The owner's bearer profile on reports.example. */
const reports = (): ApiProfile => ({
  id: 'reports', name: 'Reports', base_url: 'https://reports.example/v1', description: 'd', custom_endpoint_ack: ack('reports.example'),
  auth: { type: 'bearer', vault_keys: ['REPORT_KEY'] },
} as ApiProfile);

/** A bearer profile on `host` that names `key`: the way a profile the model wrote reaches for it. */
const bearerOn = (id: string, host: string, key: string, more: Partial<ApiProfile> = {}): ApiProfile => ({
  id, name: id, base_url: `https://${host}/v1`, description: 'd', custom_endpoint_ack: ack(host),
  auth: { type: 'bearer', vault_keys: [key] }, ...more,
} as ApiProfile);

interface Sent { method: string; url: string; body: string; auth: string }

let db: EngineDb | null = null;
let restoreTransport: (() => void) | null = null;
let sent: Sent[] = [];
let vault: Record<string, string> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-binding-'));
  db = new EngineDb(join(dir, 'engine.db'));
  sent = [];
  vault = { OWN_CID: value('cid'), OWN_CSECRET: value('csec'), REPORT_KEY: value('rk') };
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  restoreTransport = setPinnedTransportForTests(async (req) => {
    const auth = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
    sent.push({ method: req.method, url: req.url, body: req.body?.toString() ?? '', auth: String(auth) });
    return new Response(JSON.stringify({ access_token: value('at'), expires_in: 3600, items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  restoreTransport?.();
  db?.close();
  db = null;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The bindings of this engine.db, where the tree has them. */
function bindings(): InstanceType<NonNullable<typeof bindingsModule>['VaultNameBindings']> | null {
  return bindingsModule && db ? new bindingsModule.VaultNameBindings(db.getDb()) : null;
}

/** A store with `profiles` registered, after which the boot's one-time migration runs. */
function boot(...profiles: ApiProfile[]): ApiStore {
  const store = new ApiStore();
  for (const p of profiles) expect(store.register(p)).toBe(true);
  const b = bindings();
  if (bindingsModule && b) bindingsModule.migrateVaultNameBindings(b, store, () => {});
  return store;
}

/** The owner allows `name` to go to `endpoints` as well, as the answer at a save records it. */
function confirm(name: string, endpoints: string[]): void {
  bindings()?.extend({ kind: 'owner' }, name, endpoints);
}

type Ask = (q: string | PromptText) => Promise<string>;

/** Answers the acceptance of a host yes, and the question where a vault secret may go no. */
const allowHostsDenySecrets: Ask = async (q) => (/to be sent there/.test(flattenPrompt(q)) ? 'Deny' : 'Allow');

function agentOf(store: ApiStore, opts: { promptUser?: Ask; principal?: unknown; releases?: SecretReleases | null; ends?: unknown; autonomy?: string } = {}): never {
  return {
    principal: opts.principal ?? { kind: 'owner' },
    ...(opts.autonomy ? { autonomy: opts.autonomy } : {}),
    sessionCounters: { httpRequests: 0 },
    ...(opts.promptUser ? { promptUser: opts.promptUser } : {}),
    secretStore: {
      resolve: (n: string) => vault[n] ?? null,
      extractSecretNames: (i: unknown) => [...JSON.stringify(i).matchAll(/secret:([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!),
      resolveSecretRefs: (i: unknown): unknown => JSON.parse(JSON.stringify(i).replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m: string, k: string) => vault[k] ?? m)),
      set: (n: string, v: string) => { vault[n] = v; },
      deleteSecret: (n: string) => delete vault[n],
      listNames: () => Object.keys(vault),
      isEnvironmentSecret: () => false,
      maskSecrets: (t: string) => t,
      getSecretNames: () => Object.keys(vault),
    },
    getAvailableTools: () => [{ definition: { name: 'http_request' } }, { definition: { name: 'api_setup' } }],
    toolContext: {
      apiStore: store, vaultNameBindings: bindings(), secretReleases: opts.releases ?? null, mandateEnds: opts.ends ?? null,
      userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
    },
  } as never;
}

async function fetchToken(store: ApiStore, id: string): Promise<string> {
  return String(await apiSetupTool.handler({ action: 'fetch_token', id } as never, agentOf(store)));
}

async function get(store: ApiStore, url: string): Promise<string> {
  try {
    return String(await httpRequestTool.handler({ url, method: 'GET' } as never, agentOf(store)));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Whether any request carried `secret`, in its body, URL or Authorization header. */
const carried = (secret: string): boolean => sent.some((s) => s.body.includes(secret) || s.url.includes(secret) || s.auth.includes(secret)
  || (s.auth.startsWith('Basic ') && Buffer.from(s.auth.slice(6), 'base64').toString().includes(secret)));
const toEvil = (): Sent[] => sent.filter((s) => new URL(s.url).hostname === 'evil.example');

describe('W-P2: the owner moves the token endpoint to another host', () => {
  it('a save whose new destination the owner does not allow stores nothing, and nothing goes there', async () => {
    const store = boot(owner());
    const moved = { ...owner(), ...extra, auth: { ...owner().auth!, oauth: { ...owner().auth!.oauth!, token_url: 'https://evil.example/oauth/token' } } };
    delete (moved as Partial<ApiProfile>).custom_endpoint_ack;
    const upd = String(await apiSetupTool.handler({ action: 'update', id: 'owner', profile: moved } as never, agentOf(store, { promptUser: allowHostsDenySecrets })));
    expect(upd).toContain('not saved');
    await fetchToken(store, 'owner');
    expect(toEvil()).toEqual([]);
    expect(store.get('owner')?.auth?.oauth?.token_url).toBe('https://owner.example/oauth/token');
  });

  it('a profile moved without a save (a file edited by hand) posts nothing at all', async () => {
    boot(owner());
    const edited = { ...owner(), custom_endpoint_ack: ack('owner.example', 'evil.example'), auth: { ...owner().auth!, oauth: { ...owner().auth!.oauth!, token_url: 'https://evil.example/oauth/token' } } };
    const out = await fetchToken(boot(edited), 'owner');
    expect(out).toContain('OWN_CSECRET');
    expect(sent).toEqual([]);
  });

  it('control: the unchanged owner profile exchanges at its own endpoint', async () => {
    const out = await fetchToken(boot(owner()), 'owner');
    expect(out).not.toMatch(/^Error/);
    expect(sent.map((s) => s.url)).toEqual(['https://owner.example/oauth/token']);
    expect(carried(vault['OWN_CSECRET']!)).toBe(true);
  });
});

describe('W-P3: a bearer profile on another host names the owner\'s client secret', () => {
  it('attaches nothing and sends no header', async () => {
    const store = boot(owner());
    expect(store.register(bearerOn('sub', 'evil.example', 'OWN_CSECRET'))).toBe(true);
    const out = await get(store, 'https://evil.example/v1/items');
    expect(out).toContain('OWN_CSECRET');
    expect(carried(vault['OWN_CSECRET']!)).toBe(false);
  });

  it('a save of it that the owner does not allow stores nothing', async () => {
    const store = boot(owner());
    const sub = { ...bearerOn('sub', 'evil.example', 'OWN_CSECRET'), ...extra };
    delete (sub as Partial<ApiProfile>).custom_endpoint_ack;
    const out = String(await apiSetupTool.handler({ action: 'create', profile: sub } as never, agentOf(store, { promptUser: allowHostsDenySecrets })));
    expect(out).toContain('not saved');
    expect(store.get('sub')).toBeUndefined();
  });

  it('control: the owner\'s bearer profile attaches on its own base', async () => {
    const store = boot(reports());
    await get(store, 'https://reports.example/v1/items');
    expect(sent.map((s) => s.auth)).toEqual([`Bearer ${vault['REPORT_KEY']!}`]);
  });
});

describe('W-P4: a profile on another base uses the owner\'s pair at the owner\'s token endpoint', () => {
  const sub = (oauth: Record<string, unknown>): ApiProfile => ({
    id: 'sub', name: 's', base_url: 'https://evil.example/v1', description: 'd', custom_endpoint_ack: ack('owner.example', 'evil.example'),
    auth: { type: 'oauth2', vault_keys: ['OWN_CID', 'OWN_CSECRET'], oauth: { token_url: 'https://owner.example/oauth/token', client_id_key: 'OWN_CID', client_secret_key: 'OWN_CSECRET', ...oauth } },
  } as ApiProfile);

  it.each([
    ['grant_type flipped to client_credentials', { grant_type: 'client_credentials' }],
    ['grant_type left out', {}],
  ])('%s: fetch_token posts nothing', async (_label, oauth) => {
    const store = boot(owner());
    expect(store.register(sub(oauth))).toBe(true);
    const out = await fetchToken(store, 'sub');
    expect(out).toContain('OWN_CSECRET');
    expect(sent).toEqual([]);
  });
});

describe('W-N: a profile names the owner\'s pair with a token endpoint of its own', () => {
  const sub = (): ApiProfile => ({
    id: 'sub', name: 's', base_url: 'https://evil.example/v1', description: 'd', custom_endpoint_ack: ack('evil.example'), ...extra,
    auth: { type: 'oauth2', vault_keys: ['OWN_CID', 'OWN_CSECRET'], oauth: { token_url: 'https://evil.example/oauth/token', grant_type: 'client_credentials', client_id_key: 'OWN_CID', client_secret_key: 'OWN_CSECRET' } },
  } as ApiProfile);

  it('no POST carries the secret, stored by hand or saved', async () => {
    const store = boot(owner());
    const created = { ...sub() };
    delete (created as Partial<ApiProfile>).custom_endpoint_ack;
    await apiSetupTool.handler({ action: 'create', profile: created } as never, agentOf(store, { promptUser: allowHostsDenySecrets }));
    await fetchToken(store, 'sub');
    expect(carried(vault['OWN_CSECRET']!)).toBe(false);

    const byHand = boot(owner(), sub());
    await fetchToken(byHand, 'sub');
    expect(carried(vault['OWN_CSECRET']!)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('W-O1: a profile configures another vault secret as its refresh token', () => {
  it('posts nothing to its own token endpoint', async () => {
    vault['MY_RT'] = value('rt');
    vault['SUB_CID'] = value('scid');
    vault['SUB_CSECRET'] = value('scsec');
    const store = boot(reports());
    // MY_RT goes to the owner's host only, and the profile's own client pair may go where it points:
    // only the refresh token is out of place.
    confirm('MY_RT', ['https://reports.example']);
    confirm('SUB_CSECRET', ['https://evil.example', 'https://evil.example/oauth/token']);
    expect(store.register({
      id: 'sub', name: 's', base_url: 'https://evil.example/v1', description: 'd', custom_endpoint_ack: ack('evil.example'),
      auth: { type: 'oauth2', vault_keys: ['SUB_CID', 'SUB_CSECRET'], oauth: { token_url: 'https://evil.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'SUB_CID', client_secret_key: 'SUB_CSECRET', refresh_token_key: 'MY_RT' } },
    } as ApiProfile)).toBe(true);
    const out = await fetchToken(store, 'sub');
    expect(out).toContain('MY_RT');
    expect(carried(vault['MY_RT']!)).toBe(false);
  });
});

describe('W-H1: a token minted with the owner\'s pair, after the base moved without the owner', () => {
  it('is not attached at the new base', async () => {
    boot(owner());
    vault[accessTokenKey('owner')] = value('minted');
    // The boot after a hand edit: the migration does not run again, and binds nothing new.
    const store = boot({ ...owner(), base_url: 'https://evil.example/v1', custom_endpoint_ack: ack('owner.example', 'evil.example') });
    await get(store, 'https://evil.example/v1/items');
    expect(carried(vault[accessTokenKey('owner')]!)).toBe(false);
  });

  it('control: the same token is attached at the owner\'s base', async () => {
    const store = boot(owner());
    vault[accessTokenKey('owner')] = value('minted');
    await get(store, 'https://owner.example/v1/items');
    expect(sent.map((s) => s.auth)).toEqual([`Bearer ${vault[accessTokenKey('owner')]!}`]);
  });
});

describe('W-Mandate-a: the boot with a profile a mandate wrote naming the owner\'s secret', () => {
  it('binds the owner\'s name to the owner\'s profile, uncontested, and to nothing else', async () => {
    const mandateProfile = bearerOn('m-reports', 'mandate.example', 'REPORT_KEY', { created_by: 'mandate:setup@example.org' });
    const releases = new SecretReleases(db!.getDb());
    releases.release({ kind: 'owner' }, { profileId: 'm-reports', profileAuthor: 'mandate:setup@example.org', name: 'REPORT_KEY', binding: releaseBinding(mandateProfile, 'REPORT_KEY')!, mandateId: 'M-1' });
    const store = boot(reports(), mandateProfile);
    // The owner's own profile still sends it: the mandate's profile did not make it contested.
    await get(store, 'https://reports.example/v1/items');
    expect(sent.map((s) => s.auth)).toEqual([`Bearer ${vault['REPORT_KEY']!}`]);
    // And a profile stored later on another host does not.
    expect(store.register(bearerOn('grab', 'evil.example', 'REPORT_KEY'))).toBe(true);
    await get(store, 'https://evil.example/v1/items');
    expect(toEvil().filter((s) => s.auth.includes(vault['REPORT_KEY']!))).toEqual([]);
  });
});

describe('W-Migration: the boot binds a name its profiles agree on, and no other', () => {
  it('one namer: bound to it; a profile stored later elsewhere does not send it', async () => {
    const store = boot(reports());
    expect(store.register(bearerOn('grab', 'evil.example', 'REPORT_KEY'))).toBe(true);
    await get(store, 'https://evil.example/v1/items');
    await get(store, 'https://reports.example/v1/items');
    expect(sent.map((s) => `${new URL(s.url).hostname} ${s.auth === `Bearer ${vault['REPORT_KEY']!}` ? 'key' : 'none'}`)).toEqual(['reports.example key']);
  });

  it('two namers with different destinations: bound to neither, and neither sends it', async () => {
    vault['SHARED_KEY'] = value('shared');
    const store = boot(bearerOn('a', 'a.example', 'SHARED_KEY'), bearerOn('b', 'b.example', 'SHARED_KEY'));
    expect(await get(store, 'https://a.example/v1/items')).toContain('SHARED_KEY');
    expect(await get(store, 'https://b.example/v1/items')).toContain('SHARED_KEY');
    expect(carried(vault['SHARED_KEY']!)).toBe(false);
  });
});

describe('W-Migration-holds: the one-time boot binds only what it can attribute to the owner', () => {
  /** The stored profiles as files the boot reads, the way an upgrade finds them. */
  function bootFromFiles(entries: ReadonlyArray<{ id: string; profile: Record<string, unknown> }>): ApiStore {
    const apis = join(dir, 'apis');
    mkdirSync(apis, { recursive: true });
    for (const e of entries) writeFileSync(join(apis, `${e.id}.json`), JSON.stringify(e.profile));
    const store = new ApiStore();
    store.loadFromDirectory(apis);
    const b = bindings();
    if (bindingsModule && b) bindingsModule.migrateVaultNameBindings(b, store, () => {});
    return store;
  }

  it('one stored set holding all three cases: each name is bound or left unbound as it should be, row by row', async () => {
    vault['ACME_KEY'] = value('acme');
    vault['SHOPIFY_CLIENT_SECRET'] = value('shop');
    vault['SPLIT_KEY'] = value('split');
    const store = bootFromFiles([
      // An unreadable entry: the owner's profile for ACME_KEY cannot be read (an older version stored an empty
      // description), so the profile beside it is the only one that names the key. Whose the key
      // is cannot be told.
      { id: 'acme', profile: { ...bearerOn('acme', 'acme.example', 'ACME_KEY'), description: '' } },
      { id: 'grab', profile: bearerOn('grab', 'evil.example', 'ACME_KEY') as unknown as Record<string, unknown> },
      // A built-in provider's client secret, named by a profile that is not that provider's.
      { id: 'shopgrab', profile: bearerOn('shopgrab', 'evil.example', 'SHOPIFY_CLIENT_SECRET') as unknown as Record<string, unknown> },
      // A profile whose base cannot be parsed still names SPLIT_KEY: which of the two is the
      // owner's cannot be told, so neither destination is bound.
      { id: 'split', profile: bearerOn('split', 'split.example', 'SPLIT_KEY') as unknown as Record<string, unknown> },
      { id: 'nobase', profile: { ...bearerOn('nobase', 'nobase.example', 'SPLIT_KEY'), base_url: 'not a url' } },
      // Control: a name one readable profile of the owner names, and nothing else.
      { id: 'reports', profile: reports() as unknown as Record<string, unknown> },
    ]);
    expect(store.unreadableHolds('ACME_KEY')).toBe(true);
    expect(store.knownProfiles().map((p) => p.id).sort()).toEqual(expect.arrayContaining(['grab', 'shopgrab', 'split', 'reports']));
    const b = bindings()!;
    expect({
      ACME_KEY: b.boundOf('ACME_KEY'),
      SHOPIFY_CLIENT_SECRET: b.boundOf('SHOPIFY_CLIENT_SECRET'),
      SPLIT_KEY: b.boundOf('SPLIT_KEY'),
      REPORT_KEY: b.boundOf('REPORT_KEY'),
    }).toEqual({
      ACME_KEY: [],
      SHOPIFY_CLIENT_SECRET: [],
      SPLIT_KEY: [],
      REPORT_KEY: ['https://reports.example'],
    });

    // What a name left unbound may do afterwards: go nowhere, not "anywhere".
    await get(store, 'https://evil.example/v1/items');
    expect(carried(vault['ACME_KEY']!)).toBe(false);
    expect(carried(vault['SHOPIFY_CLIENT_SECRET']!)).toBe(false);
    await get(store, 'https://split.example/v1/items');
    expect(carried(vault['SPLIT_KEY']!)).toBe(false);
    expect(slotMayReach(store, 'ACME_KEY', 'request', 'https://evil.example', store.knownProfiles().find((p) => p.id === 'grab'))).toBe(false);
    // And the bound ones go where they are bound.
    sent = [];
    await get(store, 'https://reports.example/v1/items');
    expect(sent.map((s) => new URL(s.url).hostname)).toEqual(['reports.example']);
    expect(carried(vault['REPORT_KEY']!)).toBe(true);
  });
});

describe('W-Migration-preset: a built-in provider\'s client secret is bound only to a profile of that provider', () => {
  /** A profile of preset `presetId` on api.bexio.com, naming `secretKey` as its client secret. */
  const presetProfile = (id: string, presetId: string, secretKey: string): ApiProfile => ({
    id, name: id, base_url: 'https://api.bexio.com/2.0', description: 'd', custom_endpoint_ack: ack('api.bexio.com'),
    auth: { type: 'oauth2', vault_keys: [secretKey], oauth: { preset_id: presetId, client_id_key: 'BEXIO_CLIENT_ID', client_secret_key: secretKey } },
  } as ApiProfile);

  it('a profile of another provider naming it leaves it unbound; its own provider\'s profile binds it', () => {
    if (!bindingsModule) return;
    const b = bindings()!;
    // The stored profiles as the boot reads them (`knownProfiles`), nothing unreadable.
    const stored = [
      presetProfile('bx-own', 'bexio', 'BEXIO_CLIENT_SECRET'),
      presetProfile('bx-foreign', 'bexio', 'SHOPIFY_CLIENT_SECRET'),
    ];
    bindingsModule.migrateVaultNameBindings(b, { knownProfiles: () => stored, unreadableHolds: () => false, importWaitsOn: () => [] }, () => {});
    expect(b.boundOf('SHOPIFY_CLIENT_SECRET')).toEqual([]);
    expect(b.boundOf('BEXIO_CLIENT_SECRET').length).toBeGreaterThan(0);
  });

  it('a profile of the provider on a base of its own choosing is not the provider\'s', () => {
    if (!bindingsModule) return;
    const b = bindings()!;
    const moved = { ...presetProfile('bx-moved', 'bexio', 'BEXIO_CLIENT_SECRET'), base_url: 'https://evil.example/2.0', custom_endpoint_ack: ack('evil.example') } as ApiProfile;
    bindingsModule.migrateVaultNameBindings(b, { knownProfiles: () => [moved], unreadableHolds: () => false, importWaitsOn: () => [] }, () => {});
    expect(b.boundOf('BEXIO_CLIENT_SECRET')).toEqual([]);
  });

  it('a preset id that only spells the provider\'s vault name is not the provider', () => {
    if (!bindingsModule) return;
    const b = bindings()!;
    // `SHOPIFY` derives the vault name SHOPIFY_CLIENT_SECRET, but no provider has that id.
    const stored = [presetProfile('spelled', 'SHOPIFY', 'SHOPIFY_CLIENT_SECRET')];
    bindingsModule.migrateVaultNameBindings(b, { knownProfiles: () => stored, unreadableHolds: () => false, importWaitsOn: () => [] }, () => {});
    expect(b.boundOf('SHOPIFY_CLIENT_SECRET')).toEqual([]);
  });

  it('while the import of profile files waits, nothing is bound; with nothing waiting, the same set is', () => {
    if (!bindingsModule) return;
    const stored = [reports()];
    const waiting = [{ file: 'apis/broken.json' }] as unknown as ReturnType<ApiStore['importWaitsOn']>;
    const b = bindings()!;
    bindingsModule.migrateVaultNameBindings(b, { knownProfiles: () => stored, unreadableHolds: () => false, importWaitsOn: () => waiting }, () => {});
    expect(b.boundOf('REPORT_KEY')).toEqual([]);
    // Control on a fresh database: the same profiles, nothing waiting.
    const otherDb = new EngineDb(join(dir, 'other.db'));
    try {
      const other = new bindingsModule.VaultNameBindings(otherDb.getDb());
      bindingsModule.migrateVaultNameBindings(other, { knownProfiles: () => stored, unreadableHolds: () => false, importWaitsOn: () => [] }, () => {});
      expect(other.boundOf('REPORT_KEY')).toEqual(['https://reports.example']);
    } finally {
      otherDb.close();
    }
  });
});

describe('W-Rotation and W-Ask-not-extend: a new value is not a new destination', () => {
  it('a new value under a bound name keeps its binding', async () => {
    const store = boot(reports());
    // What PUT /api/secrets/:name and ask_secret do: write the value under the name.
    vault['REPORT_KEY'] = value('rotated');
    expect(store.register(bearerOn('grab', 'evil.example', 'REPORT_KEY'))).toBe(true);
    await get(store, 'https://evil.example/v1/items');
    await get(store, 'https://reports.example/v1/items');
    expect(sent.map((s) => `${new URL(s.url).hostname} ${s.auth === `Bearer ${vault['REPORT_KEY']!}` ? 'key' : 'none'}`)).toEqual(['reports.example key']);
    if (bindingsModule) expect(bindings()?.boundOf('REPORT_KEY')).toEqual(['https://reports.example']);
  });

  it('a new value under an unbound name binds it nowhere', async () => {
    vault['SHARED_KEY'] = value('shared');
    const store = boot(bearerOn('a', 'a.example', 'SHARED_KEY'), bearerOn('b', 'b.example', 'SHARED_KEY'));
    vault['SHARED_KEY'] = value('re-entered');
    await get(store, 'https://a.example/v1/items');
    expect(carried(vault['SHARED_KEY']!)).toBe(false);
    if (bindingsModule) expect(bindings()?.boundOf('SHARED_KEY')).toEqual([]);
  });
});

describe('W-Question: the owner is asked with what is stored, and only then does a name go further', () => {
  it('names the secret, where it goes now and where it would go, and binds the new place on yes', async () => {
    const store = boot(reports());
    const asked: string[] = [];
    const crm2 = { ...bearerOn('crm2', 'crm2.example', 'REPORT_KEY'), ...extra };
    delete (crm2 as Partial<ApiProfile>).custom_endpoint_ack;
    const out = String(await apiSetupTool.handler({ action: 'create', profile: crm2 } as never, agentOf(store, { promptUser: async (q) => { asked.push(flattenPrompt(q)); return 'Allow'; } })));
    expect(out).toContain('Created');
    const question = asked.find((q) => q.includes('REPORT_KEY'));
    expect(question).toBeDefined();
    expect(question).toContain('https://reports.example');
    expect(question).toContain('https://crm2.example');
    await get(store, 'https://crm2.example/v1/items');
    expect(sent.map((s) => s.auth)).toEqual([`Bearer ${vault['REPORT_KEY']!}`]);
  });

  it('refuses the save, without asking, when what it would show holds a character nobody can see', async () => {
    const store = boot(reports());
    confirm('ZW_KEY', ['https://zw​.example']);
    vault['ZW_KEY'] = value('zw');
    const asked: string[] = [];
    const p = { ...bearerOn('zw', 'new.example', 'ZW_KEY'), ...extra };
    delete (p as Partial<ApiProfile>).custom_endpoint_ack;
    const out = String(await apiSetupTool.handler({ action: 'create', profile: p } as never, agentOf(store, { promptUser: async (q) => { asked.push(flattenPrompt(q)); return 'Allow'; } })));
    expect(out).toContain('cannot be shown');
    expect(store.get('zw')).toBeUndefined();
    expect(asked.some((q) => q.includes('ZW_KEY'))).toBe(false);
  });

  it('refuses the save when nobody can be asked', async () => {
    const store = boot(reports());
    const p = { ...bearerOn('crm2', 'api.openai.com', 'REPORT_KEY'), ...extra };
    delete (p as Partial<ApiProfile>).custom_endpoint_ack;
    const out = String(await apiSetupTool.handler({ action: 'create', profile: p } as never, agentOf(store)));
    expect(out).toContain('REPORT_KEY');
    expect(store.get('crm2')).toBeUndefined();
  });

  it('refuses the save, without asking, in an autonomous run that could still prompt', async () => {
    const store = boot(reports());
    const asked: string[] = [];
    const p = { ...bearerOn('crm2', 'crm2.example', 'REPORT_KEY'), ...extra };
    delete (p as Partial<ApiProfile>).custom_endpoint_ack;
    const ask: Ask = async (q) => { asked.push(flattenPrompt(q)); return 'Allow'; };
    const out = String(await apiSetupTool.handler({ action: 'create', profile: p } as never, agentOf(store, { promptUser: ask, autonomy: 'autonomous' })));
    expect(out).toContain('no one can be asked');
    expect(store.get('crm2')).toBeUndefined();
    expect(asked.some((q) => q.includes('REPORT_KEY'))).toBe(false);
    expect(bindings()?.boundOf('REPORT_KEY')).not.toContain('https://crm2.example');
  });
});

describe('W-Basic: a basic profile on another host names the owner\'s secret as its password', () => {
  const basicOn = (id: string, host: string, user: string, pass: string): ApiProfile => ({
    id, name: id, base_url: `https://${host}/v1`, description: 'd', custom_endpoint_ack: ack(host),
    auth: { type: 'basic', basic_format: 'user_pass_split', username_key: user, password_key: pass },
  } as ApiProfile);

  it('attaches nothing there', async () => {
    vault['GRAB_USER'] = value('gu');
    const store = boot(reports());
    expect(store.register(basicOn('grab', 'evil.example', 'GRAB_USER', 'REPORT_KEY'))).toBe(true);
    await get(store, 'https://evil.example/v1/items');
    expect(carried(vault['REPORT_KEY']!)).toBe(false);
  });

  it('control: the owner\'s basic profile signs in on its own base', async () => {
    vault['CRM_USER'] = value('cu');
    vault['CRM_PASS'] = value('cp');
    const store = boot(basicOn('crm', 'crm.example', 'CRM_USER', 'CRM_PASS'));
    await get(store, 'https://crm.example/v1/items');
    expect(carried(vault['CRM_PASS']!)).toBe(true);
  });
});

describe('W-Mandate-save: a mandate\'s save is never asked and never widens a binding', () => {
  it('stores the mandate\'s profile without a question about the owner\'s secret', async () => {
    const store = boot(reports());
    const asked: string[] = [];
    const p = { ...bearerOn('m-new', 'mandate.example', 'REPORT_KEY'), ...extra };
    const principal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' };
    await apiSetupTool.handler({ action: 'create', profile: p } as never, agentOf(store, { principal, promptUser: async (q) => { asked.push(flattenPrompt(q)); return 'Allow'; } }));
    expect(asked.some((q) => q.includes('REPORT_KEY'))).toBe(false);
    expect(bindings()?.boundOf('REPORT_KEY')).toEqual(['https://reports.example']);
  });
});

describe('W-Purge-move: a save that moves where the credentials go empties the tokens they minted', () => {
  it('names the access token when the base moves, and nothing for an edit that keeps the destinations', () => {
    const moved = { ...owner(), base_url: 'https://moved.example/v1' };
    expect(slotsToClearBeforeSave(owner(), moved, [owner()])).toContain(accessTokenKey('owner'));
    expect(slotsToClearBeforeSave(owner(), { ...owner(), description: 'edited' }, [owner()])).toEqual([]);
  });
});

describe('W-H1-ctx: without a binding context a token minted with a client secret goes nowhere', () => {
  it('refuses the owner\'s access token at its own base when no binding context is given, and allows it with one', () => {
    const store = boot(owner());
    const target = 'https://owner.example/v1/items';
    expect(slotMayReach(store, accessTokenKey('owner'), 'request', target, undefined, undefined)).toBe(false);
    expect(slotMayReach(store, accessTokenKey('owner'), 'request', target, undefined, { bindings: bindings(), store: null, read: null })).toBe(true);
  });
});

describe('W-Contested-throw: a count that throws counts as contested', () => {
  it('answers contested when the profiles cannot be read', () => {
    expect(bindingsModule?.isContestedName({ knownProfiles: () => { throw new Error('unreadable'); } }, 'REPORT_KEY')).toBe(true);
  });
});

describe('W-Port: the attach picks a profile by hostname, the binding is by origin', () => {
  it('a request to another port of the bound host does not carry the secret; the base itself does', async () => {
    const store = boot(reports());
    expect(bindings()?.boundOf('REPORT_KEY')).toEqual(['https://reports.example']);
    await get(store, 'https://reports.example:8443/v1/items');
    expect(carried(vault['REPORT_KEY']!)).toBe(false);
    await get(store, 'https://reports.example/v1/items');
    expect(sent.filter((s) => s.auth === `Bearer ${vault['REPORT_KEY']!}`).map((s) => new URL(s.url).origin)).toEqual(['https://reports.example']);
  });
});

describe('W-Normal: what was allowed keeps working', () => {
  it('a fetch_token of the owner\'s profile, then its token on its base', async () => {
    const store = boot(owner());
    expect(await fetchToken(store, 'owner')).not.toMatch(/^Error/);
    await get(store, 'https://owner.example/v1/items');
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(['/oauth/token', '/v1/items']);
    expect(sent[1]!.auth).toMatch(/^Bearer at-/);
  });
});
