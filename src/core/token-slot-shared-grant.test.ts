import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OAuthPreset } from './oauth-presets.js';

// The cases of a shared grant the other token-slot files leave to the predicate, through the real
// paths: deleting the owner while a reader shares its grant, a provider with two API hosts, each
// condition of sharing broken on the owner's side, and a reader that takes the owner's whole
// sign-in. The one provider registered today has a single API host, so a second provider with
// two is added to the register here, next to the real one. It is a fixture, not a provider.

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  class APIError extends Error {
    status: number;
    constructor(status: number, _error: unknown, message: string | undefined) {
      super(message ?? 'error');
      this.status = status;
      this.name = 'APIError';
    }
  }
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

vi.mock('../tools/permission-guard.js', async (importOriginal) => ({
  // The real module, so every export a test does not replace stays what it is.
  ...(await importOriginal<typeof import('../tools/permission-guard.js')>()),
  isDangerous: vi.fn().mockReturnValue(null),
  isDangerousDetailed: vi.fn().mockReturnValue(null),
  contractGrants: vi.fn().mockReturnValue(false),
}));

vi.mock('./observability.js', () => ({
  channels: {
    toolStart: { publish: vi.fn() },
    toolEnd: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: true, publish: vi.fn() },
    cacheHealth: { publish: vi.fn() },
    securityFlagged: { hasSubscribers: true, publish: vi.fn() },
    securityInjection: { hasSubscribers: false, publish: vi.fn() },
    secretAccess: { publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

let lynoxDir = '';
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  getLynoxDir: () => lynoxDir,
}));

/** `twohost`: bexio's shape with a token host of its own and two API hosts. */
vi.mock('./oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./oauth-presets.js')>();
  const bexio = real.OAUTH_PRESETS.get('bexio');
  if (bexio === undefined) throw new Error('the real register no longer has bexio; rebuild this fixture');
  const twohost: OAuthPreset = Object.freeze({
    ...bexio,
    id: 'twohost',
    label: 'twohost',
    host: { kind: 'constant', host: 'auth.twohost.example' },
    apiHosts: ['api.one.example', 'api.two.example'],
  });
  const backing = new Map<string, OAuthPreset>(real.OAUTH_PRESETS.ids().map((id) => [id, real.OAUTH_PRESETS.get(id)!] as const));
  backing.set('twohost', twohost);
  const register = Object.freeze({ get: (id: string) => backing.get(id), ids: () => [...backing.keys()].sort() });
  return {
    ...real,
    OAUTH_PRESETS: register,
    derivePresetEndpoints: (presetId: string, params: Readonly<Record<string, unknown>> | undefined) => real.derivePresetEndpoints(presetId, params, register),
    presetNotFollowed: (profile: Parameters<typeof real.presetNotFollowed>[0]) => real.presetNotFollowed(profile, register),
    presetIds: () => real.presetIds(register),
  };
});

import { Agent } from './agent.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { createToolContext } from './tool-context.js';
import { setPinnedTransportForTests } from './network-guard.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { derivePresetEndpoints } from './oauth-presets.js';
import { httpRequestTool } from '../tools/builtin/http.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { bindingsAsMigrated } from '../../tests/helpers/vault-bindings.js';

// Values assembled at runtime: no literal here has the shape of a credential.
const value = (...parts: string[]): string => parts.join('-');

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[] = [];
let restoreTransport: (() => void) | undefined;
const dirs: string[] = [];
const engines: EngineDb[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  lynoxDir = tmp('lynox-shared-grant-home-');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  restoreTransport = setPinnedTransportForTests(async (req) => {
    sent.push({ url: req.url, method: req.method, headers: req.headers, body: req.body?.toString('utf8') ?? '' });
    if (req.url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: value('minted', 'access'), expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('ok', { status: 200 });
  });
});

afterEach(() => {
  restoreTransport?.();
  restoreTransport = undefined;
  vi.restoreAllMocks();
  for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ackFor = (...hosts: string[]) => ({ accepted: true as const, hosts, accepted_at: '2026-10-18T00:00:00.000Z' });
type OAuthOver = Partial<NonNullable<NonNullable<ApiProfile['auth']>['oauth']>>;
const slotOf = (id: string): string => id.toUpperCase().replace(/-/g, '_');

/** An oauth2 profile on `host`, with a client pair of its own. */
function oauth(id: string, over: OAuthOver = {}, host = `${id}.example`): ApiProfile {
  return {
    id, name: id, base_url: `https://${host}/v1`, description: id,
    auth: { type: 'oauth2', oauth: { token_url: `https://${host}/oauth/token`, grant_type: 'refresh_token', client_id_key: `${slotOf(id)}_CID`, client_secret_key: `${slotOf(id)}_CSECRET`, ...over } },
    custom_endpoint_ack: ackFor(host),
  };
}
/** A profile of `preset` on `base`. */
function ofPreset(preset: string, id: string, base: string, over: OAuthOver = {}, tokenHost = preset === 'bexio' ? 'auth.bexio.com' : 'auth.twohost.example'): ApiProfile {
  return {
    ...oauth(id, { preset_id: preset, ...over }),
    base_url: base,
    custom_endpoint_ack: ackFor(new URL(base).hostname, tokenHost),
  };
}
/** `p` as `api_setup` accepts it: endpoints, guidelines and avoid rules, and its client pair among its vault keys. */
const complete = (p: ApiProfile): ApiProfile => ({
  ...p,
  auth: { ...p.auth!, vault_keys: [p.auth!.oauth!.client_id_key!, p.auth!.oauth!.client_secret_key!] },
  endpoints: [{ method: 'GET', path: '/x', description: 'x' }], guidelines: ['g'], avoid: ['a'],
});

type Loader = (profiles: ApiProfile[]) => ApiStore;
const fromDirectory: Loader = (profiles) => {
  const dir = tmp('lynox-shared-grant-');
  for (const p of profiles) writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
  const store = new ApiStore();
  store.loadFromDirectory(dir);
  return store;
};
const fromConnections: Loader = (profiles) => {
  const engine = new EngineDb(join(tmp('lynox-shared-grant-db-'), 'engine.db'), '');
  engines.push(engine);
  const cs = new ConnectionStore(engine);
  for (const p of profiles) {
    const { id, name, ...rest } = p;
    cs.upsert({ id, kind: 'api', name, subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
  }
  const store = new ApiStore();
  store.setConnectionStore(cs);
  store.loadFromConnections(cs);
  return store;
};
const loaders = [['loadFromDirectory', fromDirectory], ['loadFromConnections', fromConnections]] as const;
/** Both read orders: as listed, and reversed. */
const orders = [['as listed', <T>(xs: T[]): T[] => xs], ['reversed', <T>(xs: T[]): T[] => [...xs].reverse()]] as const;

/** A vault for the tool handlers, over a plain map: resolves names and `secret:` references. */
function vaultOf(entries: Record<string, string>) {
  const map: Record<string, string> = { ...entries };
  return {
    resolve: (name: string): string | null => map[name] ?? null,
    resolveSecretRefs: (input: unknown): unknown => JSON.parse(JSON.stringify(input).replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m, n: string) => map[n] ?? m)) as unknown,
    set: (name: string, v: string): void => { map[name] = v; },
    deleteSecret: (name: string): boolean => delete map[name],
    listNames: (): string[] => Object.keys(map),
    snapshot: (): Record<string, string> => ({ ...map }),
  };
}
type Vault = ReturnType<typeof vaultOf>;

function agentOf(store: ApiStore, vault: Vault): never {
  return {
    principal: { kind: 'owner' },
    sessionCounters: { httpRequests: 0 },
    secretStore: vault,
    promptUser: async () => 'Allow',
    getAvailableTools: () => [{ definition: { name: 'http_request' } }, { definition: { name: 'api_setup' } }],
    toolContext: { apiStore: store, secretReleases: null, mandateEnds: null, vaultNameBindings: bindingsAsMigrated(store), userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  } as never;
}
const tool = (store: ApiStore, vault: Vault, input: Record<string, unknown>): Promise<string> =>
  apiSetupTool.handler(input as never, agentOf(store, vault)) as Promise<string>;

/** One `http_request` through the real agent loop, with a `secret:` reference in a header. */
async function referenced(store: ApiStore, vault: Record<string, string>, url: string, name: string): Promise<string> {
  const ctx = createToolContext({});
  (ctx as { apiStore: unknown }).apiStore = store;
  (ctx as { vaultNameBindings: unknown }).vaultNameBindings = bindingsAsMigrated(store);
  const { SecretStore } = await import('./secret-store.js');
  const agentVault = new SecretStore(undefined, { getAll: () => new Map(Object.entries(vault).map(([k, v]) => [k, { value: v, scope: 'any', ttlMs: 0 }])) } as unknown as import('./secret-vault.js').SecretVault);
  mockProcess.mockReset();
  mockProcess
    .mockResolvedValueOnce({ content: [{ type: 'tool_use' as const, id: 'tu_1', name: 'http_request', input: { url, method: 'GET', headers: { 'X-Data': `secret:${name}` } } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } })
    .mockResolvedValueOnce({ content: [{ type: 'text' as const, text: 'Done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
  const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [httpRequestTool], secretStore: agentVault, toolContext: ctx, promptUser: vi.fn().mockResolvedValue('Allow') });
  await agent.send('go');
  return JSON.stringify(agent.getMessages()[2]);
}

/** The engine's own attach for a request, through the `http_request` handler. */
async function attached(store: ApiStore, vault: Record<string, string>, url: string): Promise<string> {
  try {
    return String(await httpRequestTool.handler({ url, method: 'GET' }, agentOf(store, vaultOf(vault))));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const tokenPosts = (): Sent[] => sent.filter((s) => s.method === 'POST' && s.url.includes('/token'));

const endpointOf = (preset: string): string => {
  const e = derivePresetEndpoints(preset, undefined);
  if ('kind' in e) throw new Error(`fixture preset refused: ${e.kind}`);
  return e.tokenUrl;
};

// ── no ownership passes on: deleting the owner while a reader shares its grant ──

describe('deleting the owner of a grant a reader shares through a built-in provider', () => {
  const A_REFRESH = value('a', 'refresh');
  const A_ACCESS = value('a', 'access');
  /** A name the owner's exchange wrote that is not one of its derived names. */
  const A_OUT = value('a', 'out');
  const owner = (): ApiProfile => ({
    ...ofPreset('bexio', 'bexio-a', 'https://api.bexio.com/2.0'),
    oauth_grant: { written: [{ name: 'BEXIO_A_REFRESH_TOKEN', fp: tokenFingerprint(A_REFRESH) }, { name: 'BEXIO_A_ACCESS_TOKEN', fp: tokenFingerprint(A_ACCESS) }, { name: 'A_OUT', fp: tokenFingerprint(A_OUT) }] },
  });
  const reader = (): ApiProfile => ofPreset('bexio', 'bexio-b', 'https://api.bexio.com/2.0', { refresh_token_key: 'BEXIO_A_REFRESH_TOKEN' });
  const VAULT = { BEXIO_A_REFRESH_TOKEN: A_REFRESH, BEXIO_A_ACCESS_TOKEN: A_ACCESS, A_OUT, BEXIO_A_CID: 'a-client', BEXIO_A_CSECRET: value('a', 'secret'), BEXIO_B_CID: 'b-client', BEXIO_B_CSECRET: value('b', 'secret') };
  /** The directory `api_setup` deletes from, booted with both. */
  const booted = (): ApiStore => {
    const dir = join(lynoxDir, 'apis');
    mkdirSync(dir, { recursive: true });
    for (const p of [owner(), reader()]) writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
    const store = new ApiStore();
    store.loadFromDirectory(dir);
    return store;
  };

  it('control: both are registered, and the reader exchanges the owner\'s refresh token at the provider\'s endpoint', async () => {
    const store = booted();
    expect(store.get('bexio-a')).toBeDefined();
    expect(store.get('bexio-b')).toBeDefined();
    expect(await tool(store, vaultOf(VAULT), { action: 'fetch_token', id: 'bexio-b' })).toContain('Token exchange OK');
    expect(tokenPosts().map((p) => p.url)).toEqual([endpointOf('bexio')]);
    expect(tokenPosts()[0]!.body).toContain(A_REFRESH);
  });

  // The owner's values are gone, so the reader has none of them to send.
  it('removes the owner\'s tokens, derived and written, and the reader then has none of them to send', async () => {
    const store = booted();
    const vault = vaultOf(VAULT);
    expect(await tool(store, vault, { action: 'delete', id: 'bexio-a' })).toMatch(/^Deleted API profile "bexio-a"\./);
    expect(vault.resolve('BEXIO_A_REFRESH_TOKEN')).toBeNull();
    expect(vault.resolve('BEXIO_A_ACCESS_TOKEN')).toBeNull();
    expect(vault.resolve('A_OUT')).toBeNull();
    const result = await tool(store, vault, { action: 'fetch_token', id: 'bexio-b' });
    expect(result).not.toContain('Token exchange OK');
    expect(sent).toHaveLength(0);
    // The reader holds nothing of the owner's: no value under the owner's names came back.
    expect(Object.keys(vault.snapshot()).filter((n) => n.startsWith('BEXIO_A_'))).toEqual(['BEXIO_A_CID', 'BEXIO_A_CSECRET']);
  });
});

// ── a provider with two API hosts ──

describe('a grant shared through a provider with two API hosts (fixture provider)', () => {
  const owner = (): ApiProfile => ofPreset('twohost', 'two-a', 'https://api.one.example/v1');
  const reader = (base = 'https://api.two.example/v1'): ApiProfile => ofPreset('twohost', 'two-b', base, { refresh_token_key: 'TWO_A_REFRESH_TOKEN' });
  const B_ACCESS = value('b', 'access');
  const A_ACCESS = value('a', 'access');
  const VAULT = { TWO_A_ACCESS_TOKEN: A_ACCESS, TWO_A_REFRESH_TOKEN: value('a', 'refresh'), TWO_B_ACCESS_TOKEN: B_ACCESS, TWO_A_CID: 'a-client', TWO_A_CSECRET: value('a', 'secret'), TWO_B_CID: 'b-client', TWO_B_CSECRET: value('b', 'secret') };

  describe.each(loaders)('boot through %s', (_loader, load) => {
    it.each(orders)('registers an owner on one API host and a reader on the other, read %s', (_order, order) => {
      const store = load(order([owner(), reader()]));
      expect(store.get('two-a')).toBeDefined();
      expect(store.get('two-b')).toBeDefined();
    });

    it.each(orders)('registers neither when the reader\'s base is off both API hosts, read %s', (_order, order) => {
      const store = load(order([owner(), reader('https://elsewhere.example/v1')]));
      expect(store.get('two-b')).toBeUndefined();
      expect(store.get('two-a')).toBeUndefined();
    });
  });

  it('save: the reader on the second API host is saved beside the owner', () => {
    const store = new ApiStore();
    expect(store.save(owner()).ok).toBe(true);
    expect(store.save(reader()).ok).toBe(true);
  });

  it('save: a reader off both API hosts is refused', () => {
    const store = new ApiStore();
    expect(store.save(owner()).ok).toBe(true);
    const last = store.save(reader('https://elsewhere.example/v1'));
    expect(last.ok).toBe(false);
    expect(last.ok ? '' : last.reason).toContain('TWO_A_REFRESH_TOKEN');
    expect(store.get('two-b')).toBeUndefined();
  });

  it('the reader exchanges the owner\'s refresh token at the provider\'s endpoint (control)', async () => {
    const store = fromDirectory([owner(), reader()]);
    expect(await tool(store, vaultOf(VAULT), { action: 'fetch_token', id: 'two-b' })).toContain('Token exchange OK');
    expect(tokenPosts().map((p) => p.url)).toEqual([endpointOf('twohost')]);
  });

  it.each(['https://api.one.example/v1/x', 'https://api.two.example/v1/x'])('a secret: reference to the reader\'s access token goes to the API host %s', async (url) => {
    const store = fromDirectory([owner(), reader()]);
    await referenced(store, VAULT, url, 'TWO_B_ACCESS_TOKEN');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['X-Data']).toBe(B_ACCESS);
  });

  it.each([
    ['a host of neither', 'https://collector.example/x'],
    ['an API host on another port', 'https://api.two.example:8443/v1/x'],
  ])('a secret: reference to the reader\'s access token is refused to %s, and nothing is sent', async (_label, url) => {
    const store = fromDirectory([owner(), reader()]);
    const result = await referenced(store, VAULT, url, 'TWO_B_ACCESS_TOKEN');
    expect(result).toContain('would send TWO_B_ACCESS_TOKEN');
    expect(sent).toHaveLength(0);
  });

  it('the engine attaches the reader\'s access token at the reader\'s base', async () => {
    const store = fromDirectory([owner(), reader()]);
    await attached(store, VAULT, 'https://api.two.example/v1/x');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['Authorization']).toBe(`Bearer ${B_ACCESS}`);
  });

  it('a secret: reference to the owner\'s access token goes to the other API host, and not to a host of neither', async () => {
    const store = fromDirectory([owner(), reader()]);
    await referenced(store, VAULT, 'https://api.two.example/v1/x', 'TWO_A_ACCESS_TOKEN');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['X-Data']).toBe(A_ACCESS);
    sent = [];
    expect(await referenced(store, VAULT, 'https://collector.example/x', 'TWO_A_ACCESS_TOKEN')).toContain('would send TWO_A_ACCESS_TOKEN');
    expect(sent).toHaveLength(0);
  });
});

// ── conditions 1 and 2 of sharing, on the owner's and the register's side ──
// The reader's side of condition 2 (host, port, scheme) is in token-slot-admission.test.ts, and
// condition 3 (the same token endpoint) in token-slot-shared-endpoint.test.ts. Condition 1 cannot
// be broken on its own: a preset the register does not have has no API hosts and derives no token
// endpoint, so conditions 2 and 3 fail with it.

describe('sharing: condition 1 on the register side, condition 2 on the owner\'s side', () => {
  describe.each(loaders)('boot through %s', (_loader, load) => {
    it.each(orders)('sharing condition 1: two profiles on the same preset id that is not in the register are not registered, read %s', (_order, order) => {
      const a = ofPreset('unlisted', 'un-a', 'https://api.unlisted.example/v1', {}, 'auth.unlisted.example');
      const b = ofPreset('unlisted', 'un-b', 'https://api.unlisted.example/v1', { refresh_token_key: 'UN_A_REFRESH_TOKEN' }, 'auth.unlisted.example');
      const store = load(order([a, b]));
      expect(store.get('un-b')).toBeUndefined();
    });

    it.each(orders)('control (condition 1): the same two without the shared slot are both registered, read %s', (_order, order) => {
      const a = ofPreset('unlisted', 'un-a', 'https://api.unlisted.example/v1', {}, 'auth.unlisted.example');
      const b = ofPreset('unlisted', 'un-b', 'https://api.unlisted.example/v1', {}, 'auth.unlisted.example');
      const store = load(order([a, b]));
      expect(store.get('un-a')).toBeDefined();
      expect(store.get('un-b')).toBeDefined();
    });

    it.each(orders)('control (condition 1): the same sharing through a preset the register has, on its API hosts, registers both, read %s', (_order, order) => {
      const a = ofPreset('twohost', 'two-a', 'https://api.one.example/v1');
      const b = ofPreset('twohost', 'two-b', 'https://api.two.example/v1', { refresh_token_key: 'TWO_A_REFRESH_TOKEN' });
      const store = load(order([a, b]));
      expect(store.get('two-a')).toBeDefined();
      expect(store.get('two-b')).toBeDefined();
    });

    it.each(orders)('control (condition 2): the same owner beside a reader of its own is registered with it, read %s', (_order, order) => {
      const a = ofPreset('twohost', 'two-a', 'https://elsewhere.example/v1');
      const b = ofPreset('twohost', 'two-b', 'https://api.two.example/v1');
      const store = load(order([a, b]));
      expect(store.get('two-a')).toBeDefined();
      expect(store.get('two-b')).toBeDefined();
    });

    it.each(orders)('sharing condition 2: an owner off the provider\'s API hosts beside a reader on one is not shared with, read %s', (_order, order) => {
      const a = ofPreset('twohost', 'two-a', 'https://elsewhere.example/v1');
      const b = ofPreset('twohost', 'two-b', 'https://api.two.example/v1', { refresh_token_key: 'TWO_A_REFRESH_TOKEN' });
      const store = load(order([a, b]));
      expect(store.get('two-b')).toBeUndefined();
    });
  });

  it('sharing condition 2, save: a reader on an API host is refused beside an owner off them', () => {
    const store = new ApiStore();
    expect(store.save(ofPreset('twohost', 'two-a', 'https://elsewhere.example/v1')).ok).toBe(true);
    const last = store.save(ofPreset('twohost', 'two-b', 'https://api.two.example/v1', { refresh_token_key: 'TWO_A_REFRESH_TOKEN' }));
    expect(last.ok).toBe(false);
    expect(store.get('two-b')).toBeUndefined();
  });
});

// ── a reader that takes the owner's whole sign-in ──

describe('a reader on a foreign base with the owner\'s refresh slot, token_url and client names', () => {
  const owner = (): ApiProfile => oauth('shop-api', {}, 'api.shop.example');
  const sub = (): ApiProfile => ({
    ...oauth('sub', { refresh_token_key: 'SHOP_API_REFRESH_TOKEN', token_url: 'https://api.shop.example/oauth/token', client_id_key: 'SHOP_API_CID', client_secret_key: 'SHOP_API_CSECRET' }),
    custom_endpoint_ack: ackFor('sub.example', 'api.shop.example'),
  });
  const VAULT = { SHOP_API_REFRESH_TOKEN: value('shop', 'refresh'), SHOP_API_CID: 'shop-client', SHOP_API_CSECRET: value('shop', 'secret') };

  it('is refused by api_setup create, saves nothing and sends nothing', async () => {
    const store = new ApiStore();
    expect(store.register(owner())).toBe(true);
    const vault = vaultOf(VAULT);
    const result = await tool(store, vault, { action: 'create', profile: complete(sub()) });
    expect(result).toMatch(/^Error: /);
    expect(result).toContain('SHOP_API_REFRESH_TOKEN');
    expect(store.storedProfile('sub')).toBeUndefined();
    expect(await tool(store, vault, { action: 'fetch_token', id: 'sub' })).not.toContain('Token exchange OK');
    expect(sent).toHaveLength(0);
  });

  describe.each(loaders)('boot through %s', (_loader, load) => {
    it.each(orders)('is not registered, read %s, and fetch_token sends nothing', async (_order, order) => {
      const store = load(order([owner(), sub()]));
      expect(store.get('sub')).toBeUndefined();
      expect(await tool(store, vaultOf(VAULT), { action: 'fetch_token', id: 'sub' })).not.toContain('Token exchange OK');
      expect(sent).toHaveLength(0);
    });
  });
});
