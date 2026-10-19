import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A token slot belongs to one connection, and the store admits no profile that would make it
// otherwise. Every test here goes through the real gate: `ApiStore.save`, the two boot loaders in
// both read orders, or `api_setup` update with the transport pinned. The sending checks are tested
// in `token-slot-reach.test.ts`.

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

vi.mock('../tools/permission-guard.js', () => ({
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

// `api_setup` writes a profile of a store without engine.db into `<lynox dir>/apis`.
let lynoxDir = '';
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  getLynoxDir: () => lynoxDir,
}));

import { Agent } from './agent.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { createToolContext } from './tool-context.js';
import { setPinnedTransportForTests } from './network-guard.js';
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
  lynoxDir = tmp('lynox-admission-home-');
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

const logged = (): string => vi.mocked(process.stderr.write).mock.calls.join('');
const ackFor = (...hosts: string[]) => ({ accepted: true as const, hosts, accepted_at: '2026-10-17T00:00:00.000Z' });
type OAuthOver = Partial<NonNullable<NonNullable<ApiProfile['auth']>['oauth']>>;
const slotOf = (id: string): string => id.toUpperCase().replace(/-/g, '_');

/** An oauth2 profile on `<id>.example`, with a client pair of its own. */
function oauth(id: string, over: OAuthOver = {}, host = `${id}.example`): ApiProfile {
  return {
    id, name: id, base_url: `https://${host}/v1`, description: id,
    auth: { type: 'oauth2', oauth: { token_url: `https://${host}/oauth/token`, grant_type: 'refresh_token', client_id_key: `${slotOf(id)}_CID`, client_secret_key: `${slotOf(id)}_CSECRET`, ...over } },
    custom_endpoint_ack: ackFor(host),
  };
}
const withWrites = (p: ApiProfile, ...names: string[]): ApiProfile => ({ ...p, oauth_grant: { written: names.map((name) => ({ name, fp: `fp-${name}` })) } });
const plain = (id: string, auth: NonNullable<ApiProfile['auth']>): ApiProfile => ({
  id, name: id, base_url: `https://${id}.example/v1`, description: id, auth, custom_endpoint_ack: ackFor(`${id}.example`),
});

/** `p` as `api_setup` accepts it: endpoints, guidelines and avoid rules, and an oauth2 profile's vault keys. */
const complete = (p: ApiProfile): ApiProfile => ({
  ...p,
  ...(p.auth?.type === 'oauth2' && p.auth.oauth?.preset_id === undefined ? { auth: { ...p.auth, vault_keys: [p.auth.oauth!.client_id_key!, p.auth.oauth!.client_secret_key!] } } : {}),
  endpoints: [{ method: 'GET', path: '/x', description: 'x' }], guidelines: ['g'], avoid: ['a'],
});

type Loader = (profiles: ApiProfile[]) => ApiStore;
const fromDirectory: Loader = (profiles) => {
  const dir = tmp('lynox-admission-');
  for (const p of profiles) writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
  const store = new ApiStore();
  store.loadFromDirectory(dir);
  return store;
};
const fromConnections: Loader = (profiles) => {
  const engine = new EngineDb(join(tmp('lynox-admission-db-'), 'engine.db'), '');
  engines.push(engine);
  const cs = new ConnectionStore(engine);
  // Written in id order, so created_at and the id tiebreaker agree on the read order.
  for (const p of [...profiles].sort((a, b) => a.id.localeCompare(b.id))) {
    const { id, name, ...rest } = p;
    cs.upsert({ id, kind: 'api', name, subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
  }
  const store = new ApiStore();
  store.setConnectionStore(cs);
  store.loadFromConnections(cs);
  return store;
};
const loaders = [['loadFromDirectory', fromDirectory], ['loadFromConnections', fromConnections]] as const;

/** Save `profiles` one after the other; every one but the last must land. */
function saved(...profiles: ApiProfile[]): { store: ApiStore; last: ReturnType<ApiStore['save']> } {
  const store = new ApiStore();
  const head = profiles.slice(0, -1);
  for (const p of head) expect(store.save(p).ok, p.id).toBe(true);
  return { store, last: store.save(profiles[profiles.length - 1]!) };
}

/** A refusal to a save names the other profile, never asks for it to be changed or deleted. */
function expectArrivingRefused(result: ReturnType<ApiStore['save']>, arriving: string, other: string, name: string): void {
  expect(result.ok).toBe(false);
  const reason = result.ok ? '' : result.reason;
  expect(reason).toContain(name);
  expect(reason).toContain(`"${other}"`);
  expect(reason).toContain('Nothing was saved');
  expect(reason).toContain(`Save "${arriving}" under a different id or with a vault name of its own, or ask the user`);
  expect(reason).not.toMatch(new RegExp(`(point|update|delete|remove|rename|change) (api_profile |profile )?"${other}"`, 'i'));
}

// ── every field a profile names a vault name in, against every kind of token slot ──

describe('admission: a profile that sends another profile\'s token slot as a credential of its own', () => {
  // The owner derives SHOP_API_ACCESS_TOKEN and SHOP_API_REFRESH_TOKEN, and its exchanges wrote
  // SHOP_OUT. `crm` names one of them in one of its fields.
  const owner = (id = 'shop-api'): ApiProfile => withWrites(oauth(id, {}, 'api.shop.example'), 'SHOP_OUT');
  const targets = ['SHOP_API_ACCESS_TOKEN', 'SHOP_API_REFRESH_TOKEN', 'SHOP_OUT'] as const;
  const fields: Array<[string, (id: string, name: string) => ApiProfile]> = [
    ['vault_keys[0] of a bearer profile', (id, name) => plain(id, { type: 'bearer', vault_keys: [name] })],
    ['vault_keys[1] of a header profile', (id, name) => plain(id, { type: 'header', header_name: 'X-Key', vault_keys: [`${slotOf(id)}_KEY`, name] })],
    ['username_key', (id, name) => plain(id, { type: 'basic', username_key: name, password_key: `${slotOf(id)}_PW` })],
    ['password_key', (id, name) => plain(id, { type: 'basic', username_key: `${slotOf(id)}_USER`, password_key: name })],
    ['client_id_key', (id, name) => oauth(id, { client_id_key: name })],
    ['client_secret_key', (id, name) => oauth(id, { client_secret_key: name })],
  ];
  const cases = fields.flatMap(([field, make]) => targets.map((target) => [field, target, make] as const));

  it.each(cases)('save: refuses %s on %s when it arrives after the owner', (_field, target, make) => {
    const { store, last } = saved(owner(), make('crm', target));
    expectArrivingRefused(last, 'crm', 'shop-api', target);
    expect(store.get('crm')).toBeUndefined();
    expect(store.get('shop-api')).toBeDefined();
  });

  it.each(cases)('save: refuses the owner when %s on %s was stored first', (_field, target, make) => {
    const { store, last } = saved(make('crm', target), owner());
    expectArrivingRefused(last, 'shop-api', 'crm', target);
    expect(store.get('crm')).toBeDefined();
    expect(store.get('shop-api')).toBeUndefined();
  });

  describe.each(loaders)('boot through %s', (_loader, load) => {
    it.each(cases)('keeps the owner and holds back %s on %s, read before and after it', (_field, target, make) => {
      for (const holder of ['aaa-crm', 'zzz-crm']) {
        const store = load([owner(), make(holder, target)]);
        expect(store.get('shop-api'), holder).toBeDefined();
        expect(store.get(holder), holder).toBeUndefined();
        expect(store.knownProfiles().map((p) => p.id)).toContain(holder);
        expect(logged()).toContain(`So profile "${holder}" is not registered and cannot be used. Nothing was deleted`);
      }
    });
  });

  it('control: a profile with keys of its own is admitted beside the owner, saved and booted', () => {
    expect(saved(owner(), plain('crm', { type: 'bearer', vault_keys: ['CRM_KEY', 'CRM_OTHER'] })).last.ok).toBe(true);
    for (const [, load] of loaders) {
      const store = load([owner(), plain('crm', { type: 'basic', username_key: 'CRM_USER', password_key: 'CRM_PW' })]);
      expect(store.get('crm')).toBeDefined();
      expect(store.get('shop-api')).toBeDefined();
    }
  });
});

// ── two claims on one token slot — neither is registered at boot ──

describe('admission: two claims on one token slot', () => {
  // [label, first claimant, second claimant, the name]: each pair is booted with either one read
  // first. Neither may be registered, and the operator line names both.
  const pairs: Array<[string, (id: string) => ApiProfile, (id: string) => ApiProfile, (a: string, b: string) => string]> = [
    // P1: an oauth2 profile configures the refresh slot another derives.
    ['derived vs configured', (id) => oauth(id), (id) => oauth(id, { refresh_token_key: 'X' }), (a) => `${slotOf(a)}_REFRESH_TOKEN`],
    // An exchange wrote a name before the profile that derives it existed.
    ['derived vs written', (id) => oauth(id), (id) => withWrites(oauth(id), 'X'), (a) => `${slotOf(a)}_ACCESS_TOKEN`],
    ['written vs written', (id) => withWrites(oauth(id), 'SHARED_OUT'), (id) => withWrites(oauth(id), 'SHARED_OUT'), () => 'SHARED_OUT'],
    ['written vs configured', (id) => withWrites(oauth(id), 'SHARED_OUT'), (id) => oauth(id, { refresh_token_key: 'SHARED_OUT' }), () => 'SHARED_OUT'],
    ['configured vs configured', (id) => oauth(id, { refresh_token_key: 'SHARED_RT' }), (id) => oauth(id, { refresh_token_key: 'SHARED_RT' }), () => 'SHARED_RT'],
    // A configured refresh slot another profile signs in with.
    ['signed in with vs configured', (id) => plain(id, { type: 'bearer', vault_keys: ['SHARED_RT'] }), (id) => oauth(id, { refresh_token_key: 'SHARED_RT' }), () => 'SHARED_RT'],
  ];
  /** The second claimant names the first's slot where the pair needs its id. */
  const build = (first: (id: string) => ApiProfile, second: (id: string) => ApiProfile, name: (a: string, b: string) => string, a: string, b: string): [ApiProfile, ApiProfile, string] => {
    const slot = name(a, b);
    const p2 = second(b);
    const fix = JSON.parse(JSON.stringify(p2).replace(/"X"/g, JSON.stringify(slot))) as ApiProfile;
    return [first(a), fix, slot];
  };

  describe.each(loaders)('boot through %s', (_loader, load) => {
    it.each(pairs)('%s: neither is registered, whichever is read first', (_label, first, second, name) => {
      for (const [a, b] of [['aaa-one', 'zzz-two'], ['zzz-one', 'aaa-two']]) {
        const [pa, pb, slot] = build(first, second, name, a, b);
        const store = load([pa, pb]);
        expect(store.get(a), `${a}/${b}`).toBeUndefined();
        expect(store.get(b), `${a}/${b}`).toBeUndefined();
        expect(store.knownProfiles().map((p) => p.id).sort()).toEqual([a, b].sort());
        expect(logged()).toContain(slot);
        expect(logged()).toMatch(new RegExp(`So neither profile "(${a}|${b})" nor profile "(${a}|${b})" is registered`));
        expect(logged()).toContain('Nothing was deleted');
      }
    });
  });

  it.each(pairs)('%s: a save refuses the one that arrives second, in either order', (_label, first, second, name) => {
    const [pa, pb, slot] = build(first, second, name, 'one', 'two');
    const ab = saved(pa, pb);
    expectArrivingRefused(ab.last, 'two', 'one', slot);
    expect(ab.store.get('one')).toBeDefined();
    const ba = saved(pb, pa);
    expectArrivingRefused(ba.last, 'one', 'two', slot);
    expect(ba.store.get('two')).toBeDefined();
  });

  it('an oauth2 profile whose derived name another profile\'s exchange wrote is refused with the reason; without the record it is admitted', () => {
    const writer = withWrites(oauth('writer'), 'FOO_ACCESS_TOKEN');
    const { last } = saved(writer, oauth('foo'));
    expectArrivingRefused(last, 'foo', 'writer', 'FOO_ACCESS_TOKEN');
    expect(last.ok ? '' : last.reason).toContain('api_profile "foo" is oauth2 and writes its tokens to FOO_ACCESS_TOKEN, and api_profile "writer" has a token an exchange of its own wrote to FOO_ACCESS_TOKEN');
    expect(saved(oauth('writer'), oauth('foo')).last.ok).toBe(true);
  });

  it('P1: an oauth2 profile saved under the id whose refresh name another profile configures is refused, so it never exchanges it', () => {
    const { store, last } = saved(oauth('evil', { refresh_token_key: 'STRIPE_REFRESH_TOKEN' }), oauth('stripe'));
    expectArrivingRefused(last, 'stripe', 'evil', 'STRIPE_REFRESH_TOKEN');
    expect(store.get('stripe')).toBeUndefined();
  });
});

// ── a configured refresh slot is shared only under every condition ──

describe('admission: sharing a refresh slot through a built-in provider', () => {
  const TOKEN_HOSTS = ['api.bexio.com', 'auth.bexio.com'];
  const bexio = (id: string, over: OAuthOver = {}, base = 'https://api.bexio.com/2.0'): ApiProfile => ({
    ...oauth(id, { preset_id: 'bexio', ...over }, 'api.bexio.com'),
    base_url: base,
    custom_endpoint_ack: ackFor(...TOKEN_HOSTS),
  });
  const READS = { refresh_token_key: 'BEXIO_A_REFRESH_TOKEN' };

  describe.each(loaders)('boot through %s', (_loader, load) => {
    it('control: an owner and a reader of the same provider on its API host are both registered', () => {
      const store = load([bexio('bexio-a'), bexio('bexio-b', READS)]);
      expect(store.get('bexio-a')).toBeDefined();
      expect(store.get('bexio-b')).toBeDefined();
    });

    it.each([
      ['another preset id', () => bexio('bexio-b', { ...READS, preset_id: 'nonexistent' })],
      ['no preset at all', () => ({ ...oauth('bexio-b', READS, 'api.bexio.com'), base_url: 'https://api.bexio.com/2.0' })],
      ['a base off the provider\'s API hosts', () => bexio('bexio-b', READS, 'https://evil.example/2.0')],
      ['a base on the API host with a port of its own', () => bexio('bexio-b', READS, 'https://api.bexio.com:8443/2.0')],
      ['a base on the API host over plain http', () => bexio('bexio-b', READS, 'http://api.bexio.com/2.0')],
    ])('a reader with %s is not registered, and neither is the owner', (_label, reader) => {
      const store = load([bexio('bexio-a'), reader()]);
      expect(store.get('bexio-b')).toBeUndefined();
      expect(store.get('bexio-a')).toBeUndefined();
    });

    it('a reader of the owner\'s ACCESS name is not sharing: neither is registered', () => {
      const store = load([bexio('bexio-a'), bexio('bexio-b', { refresh_token_key: 'BEXIO_A_ACCESS_TOKEN' })]);
      expect(store.get('bexio-a')).toBeUndefined();
      expect(store.get('bexio-b')).toBeUndefined();
    });
  });

  it('save: a reader off the provider\'s API hosts is refused by the slot check, not by the host map', () => {
    const { last } = saved(bexio('bexio-a'), bexio('bexio-b', READS, 'https://evil.example/2.0'));
    expectArrivingRefused(last, 'bexio-b', 'bexio-a', 'BEXIO_A_REFRESH_TOKEN');
    expect(last.ok ? '' : last.reason).toContain('without sharing that connection through a built-in provider');
  });
});

// ── a partner held back for a reason of its own still makes the other lose ──

describe('admission: a claimant the boot holds back for a reason of its own', () => {
  // `zzz-evil`/`aaa-evil` configure shopify's refresh name AND keep their client secret under their
  // own access name, which the boot refuses before it asks anything else.
  const shopify = (): ApiProfile => oauth('shopify');
  const evil = (id: string): ApiProfile => oauth(id, { refresh_token_key: 'SHOPIFY_REFRESH_TOKEN', client_secret_key: `${slotOf(id)}_ACCESS_TOKEN` });

  describe.each(loaders)('boot through %s', (_loader, load) => {
    it.each(['aaa-evil', 'zzz-evil'])('%s: shopify is not registered either', (id) => {
      const store = load([shopify(), evil(id)]);
      expect(store.get(id)).toBeUndefined();
      expect(store.get('shopify')).toBeUndefined();
      expect(logged()).toContain(`keeps its OAuth client secret under ${slotOf(id)}_ACCESS_TOKEN`);
    });
  });

  it('register one at a time: the claimant refused for its own reason unregisters the one already there', () => {
    const store = new ApiStore();
    expect(store.register(shopify())).toBe(true);
    expect(store.register(evil('evil'))).toBe(false);
    expect(store.get('shopify')).toBeUndefined();
    expect(store.knownProfiles().map((p) => p.id).sort()).toEqual(['evil', 'shopify']);
  });

  it('register one at a time, the other order: shopify arrives second and is refused', () => {
    const store = new ApiStore();
    expect(store.register(evil('evil'))).toBe(false);
    expect(store.register(shopify())).toBe(false);
    expect(store.get('shopify')).toBeUndefined();
  });
});

// ── a save is measured against every stored profile, and against what it already had ──

describe('admission at save: the stored set and the conflicts a registered profile already had', () => {
  const shopApi = (): ApiProfile => oauth('shop-api', {}, 'api.shop.example');
  const reporter = (): ApiProfile => plain('reporter', { type: 'bearer', vault_keys: ['SHOP_API_ACCESS_TOKEN'] });

  it('the registered winner of a boot conflict saves again; the held-back loser stays held back', () => {
    const store = fromDirectory([shopApi(), reporter()]);
    expect(store.get('reporter')).toBeUndefined();
    const edited = { ...store.get('shop-api')!, description: 'edited' };
    expect(store.save(edited).ok).toBe(true);
    expect(store.get('shop-api')?.description).toBe('edited');
  });

  it('…but a new conflict on that save is refused', () => {
    const store = fromDirectory([shopApi(), reporter()]);
    const edited = withWrites(store.get('shop-api')!, 'OTHER_NAME');
    const other = plain('other', { type: 'bearer', vault_keys: ['OTHER_NAME'] });
    expect(store.save(other).ok).toBe(true);
    expectArrivingRefused(store.save(edited), 'shop-api', 'other', 'OTHER_NAME');
  });

  it('a new profile is refused for a claim a held-back profile has', () => {
    // `held` is held back for its own reason (its client secret on its own access name), and it
    // configures STRIPE_REFRESH_TOKEN.
    const held = oauth('held', { refresh_token_key: 'STRIPE_REFRESH_TOKEN', client_secret_key: 'HELD_ACCESS_TOKEN' });
    const store = fromDirectory([held]);
    expect(store.get('held')).toBeUndefined();
    expectArrivingRefused(store.save(oauth('stripe')), 'stripe', 'held', 'STRIPE_REFRESH_TOKEN');
  });

  it('a registered profile\'s own save is refused for a claim a held-back profile has (it no longer reads registered profiles only)', () => {
    const held = withWrites(oauth('held', { client_secret_key: 'HELD_ACCESS_TOKEN' }), 'CRM_NEW');
    const crm = plain('crm', { type: 'bearer', vault_keys: ['CRM_KEY'] });
    const store = fromDirectory([held, crm]);
    expect(store.get('crm')).toBeDefined();
    expectArrivingRefused(store.save({ ...crm, auth: { type: 'bearer', vault_keys: ['CRM_NEW'] } }), 'crm', 'held', 'CRM_NEW');
  });
});

// ── a profile whose names cannot be read ──

describe('admission: a profile whose vault names cannot be read', () => {
  /** A profile whose `vault_keys` throws when read: what no admission may take as "names nothing". */
  const unreadable = (id: string): ApiProfile => {
    const p = plain(id, { type: 'bearer', vault_keys: ['X'] });
    Object.defineProperty(p.auth, 'vault_keys', { get: () => { throw new Error('unreadable'); }, enumerable: true });
    return p;
  };

  it('is refused at save and at registration beside another profile', () => {
    const saving = new ApiStore();
    expect(saving.save(oauth('shopify')).ok).toBe(true);
    expect(saving.save(unreadable('odd')).ok).toBe(false);
    const store = new ApiStore();
    expect(store.register(oauth('shopify'))).toBe(true);
    expect(store.register(unreadable('odd'))).toBe(false);
    expect(logged()).toContain('the vault names of api_profile "odd" could not be read');
  });

  it('holds back only itself: the profile beside it stays registered', () => {
    const store = new ApiStore();
    expect(store.register(oauth('shopify'))).toBe(true);
    expect(store.register(unreadable('odd'))).toBe(false);
    expect(store.get('shopify')).toBeDefined();
  });

  it('control: the same profile with keys that read is admitted', () => {
    const store = new ApiStore();
    expect(store.save(oauth('shopify')).ok).toBe(true);
    expect(store.save(plain('odd', { type: 'bearer', vault_keys: ['X'] })).ok).toBe(true);
  });

  it('a stored file whose id is not a string refuses no save of a registered profile that names none of its strings', () => {
    // The file's id is an object: the boot does not read it as a profile, and it holds the strings
    // it carries. The registered profile beside it names none of them, so its save goes through.
    const dir = tmp('lynox-admission-odd-id-');
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ ...plain('x', { type: 'bearer', vault_keys: ['X_KEY'] }), id: { o: 1 } }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(oauth('shop')));
    const store = new ApiStore();
    store.loadFromDirectory(dir);
    expect(store.getAll().map((p) => p.id)).toEqual(['shop']);
    expect(store.knownProfiles()).toHaveLength(1);
    expect(store.unreadableHolds('X_KEY')).toBe(true);
    const result = store.save({ ...store.get('shop')!, notes: ['n'] });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, isNew: false });
    expect(store.get('shop')?.notes).toEqual(['n']);
  });

  it('a registered profile whose names cannot be read is refused on its next save, though the profile beside it was saved', () => {
    // Registered alone, it met no one. The profile saved beside it is not refused for it, so the
    // two are stored together; the unreadable one's own next save is still refused, and the
    // conflict its registered version already had does not count as one it may keep.
    const store = new ApiStore();
    expect(store.register(unreadable('odd'))).toBe(true);
    expect(store.save(oauth('shopify')).ok).toBe(true);
    const result = store.save(unreadable('odd'));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('the vault names of api_profile \\"odd\\" could not be read');
  });
});

// ── a held-back owner's access token reaches no request ──

describe('the predicate: a request carries only a registered owner\'s access token', () => {
  async function agentVault(entries: Record<string, string>) {
    const { SecretStore } = await import('./secret-store.js');
    const vault = {
      getAll: () => new Map(Object.entries(entries).map(([k, v]) => [k, { value: v, scope: 'any', ttlMs: 0 }])),
    } as unknown as import('./secret-vault.js').SecretVault;
    return new SecretStore(undefined, vault);
  }
  async function reference(store: ApiStore, name: string, url: string): Promise<string> {
    const ctx = createToolContext({});
    (ctx as { apiStore: unknown }).apiStore = store;
    ctx.vaultNameBindings = bindingsAsMigrated(store);
    mockProcess.mockReset();
    mockProcess
      .mockResolvedValueOnce({ content: [{ type: 'tool_use' as const, id: 'tu_1', name: 'http_request', input: { url, method: 'GET', headers: { 'X-Data': `secret:${name}` } } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: 'text' as const, text: 'Done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [httpRequestTool], secretStore: await agentVault({ SHOPIFY_ACCESS_TOKEN: value('shop', 'access') }), toolContext: ctx, promptUser: vi.fn().mockResolvedValue('Allow') });
    await agent.send('go');
    return JSON.stringify(agent.getMessages()[2]);
  }

  it('refuses a secret: reference to the access token of an owner the boot held back, even to its own base', async () => {
    const store = fromDirectory([oauth('shopify'), oauth('zzz-evil', { refresh_token_key: 'SHOPIFY_REFRESH_TOKEN' })]);
    expect(store.get('shopify')).toBeUndefined();
    const result = await reference(store, 'SHOPIFY_ACCESS_TOKEN', 'https://shopify.example/v1/x');
    expect(result).toContain('would send SHOPIFY_ACCESS_TOKEN to shopify.example');
    expect(sent).toHaveLength(0);
  });

  it('control: the same reference goes out when the owner is registered', async () => {
    const store = fromDirectory([oauth('shopify')]);
    await reference(store, 'SHOPIFY_ACCESS_TOKEN', 'https://shopify.example/v1/x');
    expect(sent).toHaveLength(1);
  });
});

// ── a reader that stops sharing loses the tokens it holds first ──

describe('an update that ends sharing empties the reader\'s token slots before it is saved', () => {
  const bexio = (id: string, over: OAuthOver = {}, base = 'https://api.bexio.com/2.0'): ApiProfile => ({
    ...oauth(id, { preset_id: 'bexio', ...over }, 'api.bexio.com'),
    base_url: base,
    custom_endpoint_ack: ackFor('api.bexio.com', 'auth.bexio.com'),
  });
  const reader = (over: OAuthOver = {}, base?: string): ApiProfile => withWrites(bexio('bexio-b', { refresh_token_key: 'BEXIO_A_REFRESH_TOKEN', ...over }, base), 'B_OUT');
  const VAULT = (): Record<string, string> => ({
    BEXIO_A_REFRESH_TOKEN: value('owner', 'refresh'), BEXIO_A_ACCESS_TOKEN: value('owner', 'access'),
    BEXIO_B_ACCESS_TOKEN: value('owner', 'account', 'access'), B_OUT: value('owner', 'account', 'out'),
    BEXIO_B_CID: 'b-client', BEXIO_B_CSECRET: value('b', 'secret'),
  });

  interface Vault {
    resolve(name: string): string | null;
    resolveSecretRefs(input: unknown): unknown;
    set(name: string, v: string): void;
    deleteSecret?(name: string): boolean;
    explainUnresolved?(name: string): 'out-of-scope' | undefined;
    listNames(): string[];
    entries(): Record<string, string>;
  }
  function vaultOf(entries: Record<string, string>, opts: { canDelete?: boolean; deleteThrows?: boolean; outOfScope?: string } = {}): Vault {
    const map: Record<string, string> = { ...entries };
    const v: Vault = {
      resolve: (name) => (name === opts.outOfScope ? null : map[name] ?? null),
      resolveSecretRefs: (input) => JSON.parse(JSON.stringify(input).replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m, n: string) => map[n] ?? m)) as unknown,
      set: (name, val) => { map[name] = val; },
      listNames: () => Object.keys(map),
      entries: () => ({ ...map }),
    };
    if (opts.outOfScope !== undefined) v.explainUnresolved = (name) => (name === opts.outOfScope ? 'out-of-scope' : undefined);
    if (opts.canDelete !== false) {
      v.deleteSecret = (name) => {
        if (opts.deleteThrows) throw new Error('vault locked');
        if (name === opts.outOfScope) return false;
        return delete map[name];
      };
    }
    return v;
  }
  function agentOf(store: ApiStore, vault: Vault): never {
    return {
      principal: { kind: 'owner' },
      sessionCounters: { httpRequests: 0 },
      secretStore: vault,
      promptUser: async () => 'Allow',
      getAvailableTools: () => [{ definition: { name: 'http_request' } }, { definition: { name: 'api_setup' } }],
      toolContext: { vaultNameBindings: bindingsAsMigrated(store), apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
    } as never;
  }
  const update = (store: ApiStore, vault: Vault, profile: ApiProfile): Promise<string> =>
    apiSetupTool.handler({ action: 'update', profile }, agentOf(store, vault)) as Promise<string>;
  const booted = (): ApiStore => fromDirectory([bexio('bexio-a'), reader()]);
  const TOKENS = ['BEXIO_B_ACCESS_TOKEN', 'BEXIO_B_REFRESH_TOKEN', 'B_OUT'];

  it('control: both are registered and share the grant', () => {
    const store = booted();
    expect(store.get('bexio-a')).toBeDefined();
    expect(store.get('bexio-b')).toBeDefined();
  });

  it('(a) an update without refresh_token_key empties the derived pair and the written names first, and keeps the record', async () => {
    const store = booted();
    const vault = vaultOf(VAULT());
    const result = await update(store, vault, bexio('bexio-b'));
    expect(result, result).toContain('Updated API profile');
    expect(result).toContain('the tokens it held were removed first');
    for (const n of TOKENS) expect(vault.resolve(n), n).toBeNull();
    expect(vault.resolve('BEXIO_A_REFRESH_TOKEN')).not.toBeNull();
    expect(vault.resolve('BEXIO_B_CSECRET')).not.toBeNull();
    expect(store.get('bexio-b')?.oauth_grant?.written?.map((w) => w.name)).toEqual(['B_OUT']);
  });

  it('(b) an update to another base empties them first', async () => {
    const store = booted();
    const vault = vaultOf(VAULT());
    expect(await update(store, vault, reader({}, 'https://api.bexio.com/3.0'))).toContain('Updated API profile');
    for (const n of TOKENS) expect(vault.resolve(n), n).toBeNull();
  });

  it('(c) a name an exchange wrote is emptied too: a secret: reference to it then reaches nothing at the new base', async () => {
    // The update ends the sharing and moves the base off the provider's API host, where no second
    // profile shares the host and the reference would otherwise go out.
    const store = booted();
    const vault = vaultOf(VAULT());
    expect(await update(store, vault, bexio('bexio-b', {}, 'https://bexio-b.example/v1'))).toContain('Updated API profile');
    const ctx = createToolContext({});
    (ctx as { apiStore: unknown }).apiStore = store;
    ctx.vaultNameBindings = bindingsAsMigrated(store);
    const { SecretStore } = await import('./secret-store.js');
    // bexio-b has connected on its own since: an access token of its own lets the request through
    // the attach, so only the emptied name can keep the reference from going out.
    const OWN = value('b', 'own', 'access');
    const left = { ...vault.entries(), BEXIO_B_ACCESS_TOKEN: OWN };
    const agentStore = new SecretStore(undefined, { getAll: () => new Map(Object.entries(left).map(([k, v]) => [k, { value: v, scope: 'any', ttlMs: 0 }])) } as unknown as import('./secret-vault.js').SecretVault);
    const run = async (headers: Record<string, string>): Promise<void> => {
      mockProcess.mockReset();
      mockProcess
        .mockResolvedValueOnce({ content: [{ type: 'tool_use' as const, id: 'tu_1', name: 'http_request', input: { url: 'https://bexio-b.example/v1/x', method: 'GET', headers } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } })
        .mockResolvedValueOnce({ content: [{ type: 'text' as const, text: 'Done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
      await new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [httpRequestTool], secretStore: agentStore, toolContext: ctx, promptUser: vi.fn().mockResolvedValue('Allow') }).send('go');
    };
    await run({ 'X-Data': 'secret:B_OUT' });
    expect(sent.some((s) => JSON.stringify(s.headers).includes(VAULT()['B_OUT']!))).toBe(false);
    // Control: the same request without the reference goes out with the profile's own token.
    await run({ 'X-Data': 'nothing secret' });
    expect(sent.some((s) => s.headers['Authorization'] === `Bearer ${OWN}`)).toBe(true);
  });

  it.each([
    ['a store with no delete', { canDelete: false }],
    ['a delete that throws', { deleteThrows: true }],
    ['a name this view may not see', { outOfScope: 'B_OUT' }],
  ] as const)('(d) refuses the update, saving nothing, with %s', async (_label, opts) => {
    const store = booted();
    const vault = vaultOf(VAULT(), opts);
    const result = await update(store, vault, bexio('bexio-b'));
    expect(result).toContain('Nothing was saved');
    expect(store.get('bexio-b')?.auth?.oauth?.refresh_token_key).toBe('BEXIO_A_REFRESH_TOKEN');
  });

  it('(e) a reader the boot held back is emptied too, and its update keeps the record of its writes', async () => {
    // `sub` reads shop-api's refresh slot with no provider between them: the boot registers
    // neither. An update that drops the slot empties what sub holds.
    const sub = withWrites(oauth('sub', { refresh_token_key: 'SHOP_API_REFRESH_TOKEN' }), 'SUB_OUT');
    const store = fromDirectory([oauth('shop-api', {}, 'api.shop.example'), sub]);
    expect(store.get('sub')).toBeUndefined();
    const vault = vaultOf({ SUB_ACCESS_TOKEN: value('shop', 'account'), SUB_OUT: value('shop', 'out'), SUB_CID: 'c', SUB_CSECRET: value('s') });
    const result = await update(store, vault, complete(oauth('sub')));
    // "Created": `save` names a profile new when it was not registered, held back or not.
    expect(result, result).toContain('Profile saved and activated immediately');
    expect(vault.resolve('SUB_ACCESS_TOKEN')).toBeNull();
    expect(vault.resolve('SUB_OUT')).toBeNull();
    expect(store.get('sub')?.oauth_grant?.written?.map((w) => w.name)).toEqual(['SUB_OUT']);
  });

  it('(f) control: an update that keeps the shared slot and where the tokens go empties nothing', async () => {
    const store = booted();
    const vault = vaultOf(VAULT());
    const result = await update(store, vault, { ...reader(), description: 'edited' });
    expect(result).toContain('Updated API profile');
    expect(result).not.toContain('removed first');
    for (const n of TOKENS) if (VAULT()[n] !== undefined) expect(vault.resolve(n), n).not.toBeNull();
  });

  it('(f) control: the owner, which reads no other profile\'s slot, keeps its tokens when its base changes', async () => {
    const store = booted();
    const vault = vaultOf(VAULT());
    expect(await update(store, vault, bexio('bexio-a', {}, 'https://api.bexio.com/3.0'))).toContain('Updated API profile');
    expect(vault.resolve('BEXIO_A_ACCESS_TOKEN')).not.toBeNull();
    expect(vault.resolve('BEXIO_B_ACCESS_TOKEN')).not.toBeNull();
  });

  it('(f) control: a profile whose configured refresh slot no other profile names is no reader, and keeps its tokens when its base changes', async () => {
    const own = complete(oauth('solo', { refresh_token_key: 'SOLO_RT' }));
    const store = fromDirectory([own]);
    const vault = vaultOf({ SOLO_RT: value('solo', 'rt'), SOLO_ACCESS_TOKEN: value('solo', 'at'), SOLO_CID: 'c', SOLO_CSECRET: value('s') });
    const result = await update(store, vault, { ...own, base_url: 'https://solo.example/v2' });
    expect(result, result).toContain('Updated API profile');
    expect(vault.resolve('SOLO_ACCESS_TOKEN')).not.toBeNull();
  });

  // A save refused for a reason known before the emptying deletes nothing.
  const crmOn = (host: string): ApiProfile => ({ ...plain('crm', { type: 'bearer', vault_keys: ['CRM_KEY'] }), base_url: `https://${host}/v1`, custom_endpoint_ack: ackFor(host) });

  it('a save refused because another profile holds the new host empties nothing, and says so', async () => {
    const store = booted();
    expect(store.save(crmOn('crm.example')).ok).toBe(true);
    const vault = vaultOf(VAULT());
    const result = await update(store, vault, bexio('bexio-b', {}, 'https://crm.example/v2'));
    expect(result).toContain('already maps to crm.example');
    expect(result).toContain('Nothing was saved');
    expect(result).toContain('No token slot was emptied');
    for (const n of TOKENS) if (VAULT()[n] !== undefined) expect(vault.resolve(n), n).not.toBeNull();
    expect(store.get('bexio-b')?.auth?.oauth?.refresh_token_key).toBe('BEXIO_A_REFRESH_TOKEN');
  });

  it('a save refused for a token-slot conflict it would bring empties nothing, and says so', async () => {
    const store = booted();
    expect(store.save(crmOn('crm.example')).ok).toBe(true);
    const vault = vaultOf(VAULT());
    // The new refresh slot is a name crm signs in with: a conflict both lose, so the save is refused.
    const result = await update(store, vault, bexio('bexio-b', { refresh_token_key: 'CRM_KEY' }));
    expect(result).toContain('which api_profile "crm" signs in with');
    expect(result).toContain('Nothing was saved');
    expect(result).toContain('No token slot was emptied');
    for (const n of TOKENS) if (VAULT()[n] !== undefined) expect(vault.resolve(n), n).not.toBeNull();
  });

  it('a save refused because another id derives the same vault slot empties nothing, and says so', async () => {
    // `sub-x` reads shop-api's refresh slot with no provider between them, so the boot holds it
    // back; `sub_x` derives the same vault slot base and is registered. A save of the held-back
    // `sub-x` is asked against every stored profile and refused for the shared slot.
    const subX = withWrites(oauth('sub-x', { refresh_token_key: 'SHOP_API_REFRESH_TOKEN' }), 'SUBX_OUT');
    const store = fromDirectory([oauth('shop-api', {}, 'api.shop.example'), subX, plain('sub_x', { type: 'bearer', vault_keys: ['SUBX_KEY'] })]);
    expect(store.get('sub-x')).toBeUndefined();
    expect(store.get('sub_x')).toBeDefined();
    const vault = vaultOf({ SUB_X_ACCESS_TOKEN: value('shop', 'account'), SUBX_OUT: value('shop', 'out'), SUB_X_CID: 'c', SUB_X_CSECRET: value('s') });
    const result = await update(store, vault, complete(oauth('sub-x')));
    expect(result).toContain('derives the vault slot SUB_X');
    expect(result).toContain('No token slot was emptied');
    expect(vault.resolve('SUB_X_ACCESS_TOKEN')).not.toBeNull();
    expect(vault.resolve('SUBX_OUT')).not.toBeNull();
  });

  it('a save still refused after the emptying names every slot it emptied', async () => {
    const store = booted();
    const vault = vaultOf(VAULT());
    vi.spyOn(store, 'save').mockReturnValue({ ok: false, reason: 'refused after the check.' });
    const result = await update(store, vault, bexio('bexio-b'));
    expect(result).toContain('refused after the check.');
    expect(result).toContain('emptied before this refusal and are empty now: BEXIO_B_ACCESS_TOKEN, BEXIO_B_REFRESH_TOKEN, B_OUT');
    for (const n of TOKENS) expect(vault.resolve(n), n).toBeNull();
  });

  it('a partial emptying names what it emptied as well as what is left', async () => {
    const store = booted();
    const vault = vaultOf(VAULT(), { outOfScope: 'B_OUT' });
    const result = await update(store, vault, bexio('bexio-b'));
    expect(result).toContain('Nothing was saved');
    expect(result).toContain('so B_OUT must be emptied first');
    expect(result).toContain('BEXIO_B_ACCESS_TOKEN, BEXIO_B_REFRESH_TOKEN were emptied already and are empty now');
    expect(vault.resolve('BEXIO_B_ACCESS_TOKEN')).toBeNull();
  });

  it('a delete that empties nothing says so', async () => {
    const store = booted();
    const vault = vaultOf(VAULT(), { deleteThrows: true });
    const result = await update(store, vault, bexio('bexio-b'));
    expect(result).toContain('None of them was emptied');
  });

  it('the admission asked before the emptying registers nothing and stores nothing', () => {
    const store = new ApiStore();
    expect(store.saveRefusal(oauth('fresh'))).toBeNull();
    expect(store.get('fresh')).toBeUndefined();
    expect(store.knownProfiles()).toEqual([]);
    expect(store.save(crmOn('crm.example')).ok).toBe(true);
    expect(store.saveRefusal({ ...oauth('other'), base_url: 'https://crm.example/v1' })).toContain('already maps to crm.example');
  });

  it('(f) control: an owner that names its own derived refresh slot is no reader either', async () => {
    const owner = bexio('bexio-a', { refresh_token_key: 'BEXIO_A_REFRESH_TOKEN' });
    const store = fromDirectory([owner, reader()]);
    expect(store.get('bexio-a')).toBeDefined();
    const vault = vaultOf(VAULT());
    expect(await update(store, vault, { ...owner, base_url: 'https://api.bexio.com/3.0' })).toContain('Updated API profile');
    expect(vault.resolve('BEXIO_A_ACCESS_TOKEN')).not.toBeNull();
  });

  it('(b) a reader that moves to another profile\'s refresh slot empties what it held from the first', async () => {
    const store = fromDirectory([bexio('bexio-a'), reader(), bexio('bexio-c')]);
    expect(store.get('bexio-b')).toBeDefined();
    const vault = vaultOf(VAULT());
    expect(await update(store, vault, reader({ refresh_token_key: 'BEXIO_C_REFRESH_TOKEN' }))).toContain('Updated API profile');
    for (const n of TOKENS) expect(vault.resolve(n), n).toBeNull();
  });

  it('(d) refuses, and deletes nothing protected, when the reader\'s record names a protected name', async () => {
    const store = fromDirectory([bexio('bexio-a'), withWrites(bexio('bexio-b', { refresh_token_key: 'BEXIO_A_REFRESH_TOKEN' }), 'GOOGLE_OAUTH_X_ACCESS_TOKEN')]);
    expect(store.get('bexio-b')).toBeDefined();
    const vault = vaultOf({ ...VAULT(), GOOGLE_OAUTH_X_ACCESS_TOKEN: value('platform') });
    const result = await update(store, vault, bexio('bexio-b'));
    expect(result).toContain('Nothing was saved');
    expect(vault.resolve('GOOGLE_OAUTH_X_ACCESS_TOKEN')).not.toBeNull();
  });

  it('(d) refuses when a delete reports success and the value is still there', async () => {
    const store = booted();
    const vault = vaultOf(VAULT());
    vault.deleteSecret = () => true;
    const result = await update(store, vault, bexio('bexio-b'));
    expect(result).toContain('Nothing was saved');
    expect(store.get('bexio-b')?.auth?.oauth?.refresh_token_key).toBe('BEXIO_A_REFRESH_TOKEN');
  });
});

describe('an update of a profile the boot held back', () => {
  it('keeps the stored record of its writes', async () => {
    // Held back for its own reason (client secret on its own access name); the update corrects it.
    const held = withWrites(oauth('held', { client_secret_key: 'HELD_ACCESS_TOKEN' }), 'HELD_OUT');
    const store = fromDirectory([held]);
    expect(store.get('held')).toBeUndefined();
    const agent = {
      principal: { kind: 'owner' }, sessionCounters: { httpRequests: 0 },
      secretStore: { resolve: () => null, resolveSecretRefs: (i: unknown) => i, listNames: () => [] },
      promptUser: async () => 'Allow',
      getAvailableTools: () => [{ definition: { name: 'api_setup' } }],
      toolContext: { vaultNameBindings: bindingsAsMigrated(store), apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
    } as never;
    const fixed = complete(oauth('held'));
    const result = await apiSetupTool.handler({ action: 'update', profile: fixed }, agent) as string;
    expect(result, result).toContain('Profile saved and activated immediately');
    expect(store.get('held')?.oauth_grant?.written?.map((w) => w.name)).toEqual(['HELD_OUT']);
  });

  const heldAgent = (store: ApiStore, principal: unknown): never => ({
    principal, sessionCounters: { httpRequests: 0 },
    secretStore: { resolve: () => null, resolveSecretRefs: (i: unknown) => i, listNames: () => [] },
    promptUser: async () => 'Allow',
    getAvailableTools: () => [{ definition: { name: 'api_setup' } }],
    toolContext: { vaultNameBindings: bindingsAsMigrated(store), apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  }) as never;

  it('is refused for a mandate that did not write it, as a registered one is', async () => {
    const held = { ...oauth('held', { client_secret_key: 'HELD_ACCESS_TOKEN' }), created_by: 'mandate:a@example.org' };
    const store = fromDirectory([held]);
    expect(store.get('held')).toBeUndefined();
    const result = await apiSetupTool.handler({ action: 'update', profile: complete(oauth('held')) }, heldAgent(store, { kind: 'mandate', email: 'b@example.org', mandateId: 'TEST-M-B' })) as string;
    expect(result).not.toContain('Profile saved');
    expect(store.storedProfile('held')?.created_by).toBe('mandate:a@example.org');
  });

  it('keeps the built-in provider it was set up with', async () => {
    const held = { ...oauth('held', { preset_id: 'bexio', client_secret_key: 'HELD_ACCESS_TOKEN' }, 'api.bexio.com'), base_url: 'https://api.bexio.com/2.0' };
    const store = fromDirectory([held]);
    expect(store.get('held')).toBeUndefined();
    const result = await apiSetupTool.handler({ action: 'update', profile: complete(oauth('held')) }, heldAgent(store, { kind: 'owner' })) as string;
    expect(result).toContain('set up through the built-in "bexio" provider');
  });
});

// ── Branches each verdict above rests on ──

describe('admission: the parts a profile plays on one name', () => {
  it('a profile that is not oauth2 sends a refresh_token_key it carries as a credential: it goes, the owner stays', () => {
    const odd = plain('odd', { type: 'bearer', vault_keys: ['ODD_KEY'], oauth: { refresh_token_key: 'SHOP_API_REFRESH_TOKEN' } });
    for (const [, load] of loaders) {
      const store = load([oauth('shop-api', {}, 'api.shop.example'), odd]);
      expect(store.get('shop-api')).toBeDefined();
      expect(store.get('odd')).toBeUndefined();
    }
  });

  it('an oauth2 profile that names its own derived refresh slot only derives it: a profile signing in with it goes alone', () => {
    const own = oauth('shop-api', { refresh_token_key: 'SHOP_API_REFRESH_TOKEN' }, 'api.shop.example');
    const store = fromDirectory([own, plain('crm', { type: 'bearer', vault_keys: ['SHOP_API_REFRESH_TOKEN'] })]);
    expect(store.get('shop-api')).toBeDefined();
    expect(store.get('crm')).toBeUndefined();
  });

  it('a profile that loses one part of a name and makes the other lose another: neither is registered', () => {
    // `two` configures one's refresh name (both lose) and keeps its client secret there (two loses).
    const two = oauth('two', { refresh_token_key: 'ONE_REFRESH_TOKEN', client_secret_key: 'ONE_REFRESH_TOKEN' });
    for (const [, load] of loaders) {
      const store = load([oauth('one'), two]);
      expect(store.get('one')).toBeUndefined();
      expect(store.get('two')).toBeUndefined();
    }
  });

  it('two ids on one vault slot are still first come, first served (not both held back)', () => {
    for (const [, load] of loaders) {
      const store = load([oauth('x-y'), oauth('x_y')]);
      expect(store.getAll().map((p) => p.id)).toHaveLength(1);
    }
  });

  it('a profile registered before a boot answers to what the boot reads', () => {
    const dir = tmp('lynox-admission-pre-');
    writeFileSync(join(dir, 'evil.json'), JSON.stringify(oauth('evil', { refresh_token_key: 'SHOPIFY_REFRESH_TOKEN' })));
    const store = new ApiStore();
    expect(store.register(oauth('shopify'))).toBe(true);
    store.loadFromDirectory(dir);
    expect(store.get('shopify')).toBeUndefined();
    expect(store.get('evil')).toBeUndefined();
    expect(store.knownProfiles().map((p) => p.id).sort()).toEqual(['evil', 'shopify']);
  });

  it('a registered profile whose save changes how it meets a held-back profile on the same name is refused', () => {
    // `one` wrote ONE_OUT, which `crm` signs in with: crm is held back, one stays. A save of one that
    // also configures ONE_OUT as its refresh slot makes the conflict one both lose — a new one.
    const one = withWrites(oauth('one'), 'ONE_OUT');
    const store = fromDirectory([one, plain('crm', { type: 'bearer', vault_keys: ['ONE_OUT'] })]);
    expect(store.get('one')).toBeDefined();
    expect(store.get('crm')).toBeUndefined();
    expectArrivingRefused(store.save(withWrites(oauth('one', { refresh_token_key: 'ONE_OUT' }), 'ONE_OUT')), 'one', 'crm', 'ONE_OUT');
  });
});

describe('the comparison itself (slotsToClearBeforeSave)', () => {
  // A reader of `owner`'s refresh slot: every field of where its tokens go is compared on its own.
  // Asked directly, because `api_setup` keeps a preset profile on its provider, and the one
  // provider registered today has no parameters.
  it.each([
    ['preset_params', { preset_id: 'tenanted', preset_params: { tenant: 'alpha' } }, { preset_id: 'tenanted', preset_params: { tenant: 'beta' } }],
    ['preset_id', {}, { preset_id: 'bexio' }],
  ] as const)('clears when only %s changes', async (_label, before, after) => {
    const { slotsToClearBeforeSave } = await import('./profile-secret-view.js');
    const owner = oauth('owner');
    const stored = withWrites(oauth('sub', { refresh_token_key: 'OWNER_REFRESH_TOKEN', ...before }), 'SUB_OUT');
    const next = oauth('sub', { refresh_token_key: 'OWNER_REFRESH_TOKEN', ...after });
    expect(slotsToClearBeforeSave(stored, next, [owner, stored]).sort()).toEqual(['SUB_ACCESS_TOKEN', 'SUB_OUT', 'SUB_REFRESH_TOKEN']);
    // Control: the same save without the change clears nothing.
    expect(slotsToClearBeforeSave(stored, { ...stored, description: 'edited' }, [owner, stored])).toEqual([]);
  });
});

// ── the boot registers no profile only to take it back ──

describe('the boot weighs the whole stored set before it registers anyone', () => {
  // Each pair in both read orders: a signer of the holder's access name (the signer loses), and a
  // configurer of the holder's refresh name (both lose). A boot that registered what it had read
  // so far would register the first of a pair and unregister it when the second arrives.
  const pairs: Array<[string, ApiProfile[]]> = [];
  for (const id of ['aaa-rep', 'zzz-rep']) pairs.push([`signer ${id}`, [oauth('mmm'), plain(id, { type: 'bearer', vault_keys: ['MMM_ACCESS_TOKEN'] })]]);
  for (const id of ['aaa-evil', 'zzz-evil']) pairs.push([`configurer ${id}`, [oauth('mmm'), oauth(id, { refresh_token_key: 'MMM_REFRESH_TOKEN' })]]);

  describe.each(loaders)('boot through %s', (name) => {
    it.each(pairs)('%s: unregister is never called during the boot of an empty store', (_label, profiles) => {
      const store = new ApiStore();
      const spy = vi.spyOn(store, 'unregister');
      if (name === 'loadFromDirectory') {
        const dir = tmp('lynox-admission-r3-');
        for (const p of profiles) writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
        store.loadFromDirectory(dir);
      } else {
        const engine = new EngineDb(join(tmp('lynox-admission-r3-db-'), 'engine.db'), '');
        engines.push(engine);
        const cs = new ConnectionStore(engine);
        for (const p of [...profiles].sort((a, b) => a.id.localeCompare(b.id))) {
          const { id, name: n, ...rest } = p;
          cs.upsert({ id, kind: 'api', name: n, subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
        }
        store.setConnectionStore(cs);
        store.loadFromConnections(cs);
      }
      // Control: the pair is a conflict the boot decides (someone is held back).
      expect(store.getAll().length).toBeLessThan(2);
      expect(store.knownProfiles()).toHaveLength(2);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
