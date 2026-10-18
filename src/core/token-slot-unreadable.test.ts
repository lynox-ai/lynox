import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A stored entry the boot cannot read or register is not a profile any check can weigh, so it
// holds every name it carries: no profile that names one is registered or saved, no such name
// leaves the process, and a delete leaves it in the vault. Deleting the entry by its id clears it.
// Every test goes through the real loaders (both, in both orders where order could matter), the
// real `ApiStore.save`, and `api_setup` with the transport pinned.

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

// `api_setup` resolves the flat-JSON directory as `<lynox dir>/apis`.
let lynoxDir = '';
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  getLynoxDir: () => lynoxDir,
}));

import { ApiStore, purgeRecordedTokens, type ApiProfile } from './api-store.js';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { slotMayReach } from './profile-secret-view.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { setPinnedTransportForTests } from './network-guard.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';

// Values assembled at runtime: no literal here has the shape of a credential.
const value = (...parts: string[]): string => parts.join('-');

interface Sent { url: string; method: string }
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
  sent = [];
  lynoxDir = tmp('lynox-unreadable-home-');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  restoreTransport = setPinnedTransportForTests(async (req) => {
    sent.push({ url: req.url, method: req.method });
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

/** An oauth2 profile on `<id>.example`, with a client pair of its own. */
function oauth(id: string, over: OAuthOver = {}, host = `${id}.example`): ApiProfile {
  return {
    id, name: id, base_url: `https://${host}/v1`, description: id,
    auth: { type: 'oauth2', oauth: { token_url: `https://${host}/oauth/token`, grant_type: 'refresh_token', client_id_key: `${slotOf(id)}_CID`, client_secret_key: `${slotOf(id)}_CSECRET`, ...over } },
    custom_endpoint_ack: ackFor(host),
  };
}
const bearer = (id: string, key: string): ApiProfile => ({
  id, name: id, base_url: `https://${id}.example/v1`, description: id, auth: { type: 'bearer', vault_keys: [key] }, custom_endpoint_ack: ackFor(`${id}.example`),
});

/** `sub`: reads the owner's derived refresh slot and posts it to an endpoint of its own choosing. */
const sub = (): ApiProfile => ({
  ...oauth('sub', { refresh_token_key: 'OWNER_REFRESH_TOKEN', token_url: 'https://evil.example/token' }),
  custom_endpoint_ack: ackFor('sub.example', 'evil.example'),
});
/** The owner as an older version could have stored it: oauth2, with an empty description. */
const brokenOwner = (): Record<string, unknown> => ({ ...oauth('owner'), description: '' });

/** One stored entry: a profile-shaped object, or text that may not parse. */
type Entry = { id: string; profile: Record<string, unknown> } | { id: string; raw: string };

interface Booted { store: ApiStore; dir: string }
type Loader = (entries: readonly Entry[]) => Booted;

/** Files `<id>.json` in `<lynox dir>/apis`, the directory `api_setup` deletes from. */
const fromDirectory: Loader = (entries) => {
  const dir = join(lynoxDir, 'apis');
  mkdirSync(dir, { recursive: true });
  for (const e of entries) writeFileSync(join(dir, `${e.id}.json`), 'raw' in e ? e.raw : JSON.stringify(e.profile));
  const store = new ApiStore();
  store.loadFromDirectory(dir);
  return { store, dir };
};
/** Rows of engine.db `connections`, the store wired to them. */
const fromConnections: Loader = (entries) => {
  const engine = new EngineDb(join(tmp('lynox-unreadable-db-'), 'engine.db'), '');
  engines.push(engine);
  const cs = new ConnectionStore(engine);
  for (const e of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    let configJson: string;
    let name = e.id;
    if ('raw' in e) configJson = e.raw;
    else {
      const { id: _id, name: n, ...rest } = e.profile;
      if (typeof n === 'string') name = n;
      configJson = JSON.stringify(rest);
    }
    cs.upsert({ id: e.id, kind: 'api', name, subjectId: null, direction: 'outbound', configJson, vaultKeys: [], status: 'active' });
  }
  const store = new ApiStore();
  store.setConnectionStore(cs);
  store.loadFromConnections(cs);
  return { store, dir: join(lynoxDir, 'apis') };
};
const loaders = [['loadFromDirectory', fromDirectory], ['loadFromConnections', fromConnections]] as const;
const asEntry = (p: ApiProfile): Entry => ({ id: p.id, profile: p as unknown as Record<string, unknown> });

/** A vault for the tool handlers, over a plain map. */
function handlerVault(entries: Record<string, string>) {
  const map: Record<string, string> = { ...entries };
  return {
    resolve: (name: string): string | null => map[name] ?? null,
    resolveSecretRefs: (input: unknown): unknown => JSON.parse(JSON.stringify(input).replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m, n: string) => map[n] ?? m)) as unknown,
    set: (name: string, v: string): void => { map[name] = v; },
    deleteSecret: (name: string): boolean => delete map[name],
    listNames: (): string[] => Object.keys(map),
    peek: (name: string): string | undefined => map[name],
  };
}
function handlerAgent(store: ApiStore, vault: ReturnType<typeof handlerVault>): never {
  return {
    principal: { kind: 'owner' },
    sessionCounters: { httpRequests: 0 },
    secretStore: vault,
    getAvailableTools: () => [{ definition: { name: 'http_request' } }, { definition: { name: 'api_setup' } }],
    toolContext: { apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  } as never;
}
const OWNER_VAULT = { OWNER_REFRESH_TOKEN: value('owner', 'refresh'), OWNER_ACCESS_TOKEN: value('owner', 'access'), SUB_CID: 'sub-client', SUB_CSECRET: value('sub', 'secret') };
const callTool = (store: ApiStore, input: Record<string, unknown>, vault = handlerVault(OWNER_VAULT)): Promise<string> =>
  apiSetupTool.handler(input as never, handlerAgent(store, vault)) as Promise<string>;

const reasonOf = (r: ReturnType<ApiStore['save']>): string => (r.ok ? '' : r.reason);

// ── a stored owner the boot skips: its reader is not registered, and its slot goes nowhere ──

describe.each(loaders)('a stored owner the boot cannot read, through %s', (_loader, boot) => {
  it.each([
    ['owner first', (): Entry[] => [{ id: 'owner', profile: brokenOwner() }, asEntry(sub())]],
    ['reader first', (): Entry[] => [asEntry(sub()), { id: 'owner', profile: brokenOwner() }]],
  ])('%s: the reader of its refresh slot is not registered, and fetch_token sends nothing', async (_order, entries) => {
    const { store } = boot(entries());
    expect(store.get('sub')).toBeUndefined();
    expect(store.get('owner')).toBeUndefined();
    const result = await callTool(store, { action: 'fetch_token', id: 'sub' });
    expect(result).not.toContain('Token exchange OK');
    expect(sent).toHaveLength(0);
  });

  it('control: without the skipped owner, the reader is registered and its exchange goes out', async () => {
    const { store } = boot([asEntry(sub())]);
    expect(store.get('sub')).toBeDefined();
    expect(await callTool(store, { action: 'fetch_token', id: 'sub' })).toContain('Token exchange OK');
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(1);
  });

  it('a name the skipped owner derives reaches no target, in any role', () => {
    const { store } = boot([{ id: 'owner', profile: brokenOwner() }]);
    expect(store.unreadableHolds('OWNER_REFRESH_TOKEN')).toBe(true);
    for (const role of ['request', 'exchange', 'other'] as const) {
      expect(slotMayReach(store, 'OWNER_REFRESH_TOKEN', role, 'https://evil.example/token', sub()), role).toBe(false);
    }
    // Control: a name nothing stored names may go where this predicate is concerned with.
    expect(slotMayReach(store, 'NOBODY_KEY', 'other', undefined)).toBe(true);
  });

  it('holds back a reader registered before the boot', () => {
    const { store: first } = boot([]);
    expect(first.register(sub())).toBe(true);
    const dir = tmp('lynox-unreadable-late-');
    writeFileSync(join(dir, 'owner.json'), JSON.stringify(brokenOwner()));
    first.loadFromDirectory(dir);
    expect(first.get('sub')).toBeUndefined();
  });
});

// ── a `written` entry with a broken fingerprint still names its slot ──

describe.each(loaders)('a written entry whose fingerprint is not a string, through %s', (_loader, boot) => {
  const shop = (): ApiProfile => ({ ...oauth('shop'), oauth_grant: { written: [{ name: 'SHOP_OUT', fp: 7 as unknown as string }] } });
  it.each([
    ['writer first', 'z-rep'],
    ['signer first', 'a-rep'],
  ])('%s: a profile signing in with the written name is not registered', (_order, rep) => {
    const { store } = boot([asEntry(shop()), asEntry(bearer(rep, 'SHOP_OUT'))]);
    expect(store.get('shop')).toBeDefined();
    expect(store.get(rep)).toBeUndefined();
  });
  it('control: a profile signing in with a name of its own is registered beside it', () => {
    const { store } = boot([asEntry(shop()), asEntry(bearer('rep', 'REP_KEY'))]);
    expect(store.get('rep')).toBeDefined();
  });
});

// ── an unreadable entry: refused saves name it, others go through, deleting it clears it ──

describe.each(loaders)('an entry whose content does not parse, through %s', (_loader, boot) => {
  const broken = (): Entry => ({ id: 'owner', raw: '{"id": "owner", "auth": {"type": "oauth2", "oauth": {"refresh_token_key": "OWNER_OLD_RT"' });

  it('refuses a save that names its derived slot, names where it is, and the save goes through once it is deleted', async () => {
    const { store, dir } = boot([broken()]);
    const refused = store.save(sub(), dir);
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain('uses the vault name OWNER_REFRESH_TOKEN');
    expect(reasonOf(refused)).toMatch(/could not be read \((file "owner\.json"|connection "owner"), id "owner"\)/);
    expect(reasonOf(refused)).toContain('delete "owner" with api_setup delete');
    expect(reasonOf(refused)).toContain('Nothing was saved');
    expect(await callTool(store, { action: 'delete', id: 'owner' })).toBe('Deleted API profile "owner".');
    expect(existsSync(join(dir, 'owner.json'))).toBe(false);
    expect(store.unreadableHolds('OWNER_REFRESH_TOKEN')).toBe(false);
    expect(store.save(sub(), dir).ok).toBe(true);
  });

  it('refuses a save that names a string literal of its text', () => {
    const { store, dir } = boot([broken()]);
    expect(reasonOf(store.save(bearer('crm', 'OWNER_OLD_RT'), dir))).toContain('uses the vault name OWNER_OLD_RT');
  });

  it('refuses a save under its id', () => {
    const { store, dir } = boot([broken()]);
    const result = store.save(bearer('owner', 'FRESH_KEY'), dir);
    expect(reasonOf(result)).toContain('profile "owner" has the id of a stored API profile that could not be read');
  });

  it('refuses no save that names none of its strings', () => {
    const { store, dir } = boot([broken()]);
    expect(store.save(bearer('crm', 'CRM_KEY'), dir).ok).toBe(true);
    expect(store.get('crm')).toBeDefined();
  });

  it('refuses a registration whose names cannot be read', () => {
    const { store } = boot([broken()]);
    const odd = bearer('odd', 'X');
    Object.defineProperty(odd.auth, 'vault_keys', { get: () => { throw new Error('unreadable'); }, enumerable: true });
    expect(store.register(odd)).toBe(false);
    expect(vi.mocked(process.stderr.write).mock.calls.join('')).toContain('the vault names of profile "odd" could not be read');
  });

  it('a later boot that reads it without fault clears it', () => {
    const { store } = boot([broken()]);
    expect(store.unreadableHolds('OWNER_REFRESH_TOKEN')).toBe(true);
    if (_loader === 'loadFromDirectory') {
      const dir = join(lynoxDir, 'apis');
      writeFileSync(join(dir, 'owner.json'), JSON.stringify(oauth('owner')));
      store.loadFromDirectory(dir);
    } else {
      const cs = (store as unknown as { connStore: ConnectionStore }).connStore;
      const { id: _id, name: _n, ...rest } = oauth('owner');
      cs.upsert({ id: 'owner', kind: 'api', name: 'owner', subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
      store.loadFromConnections(cs);
    }
    expect(store.unreadableHolds('OWNER_REFRESH_TOKEN')).toBe(false);
    expect(store.get('owner')).toBeDefined();
  });
});

describe.each(loaders)('an entry with a required field that is not a string, through %s', (_loader, boot) => {
  it('holds every string it carries', () => {
    const { store, dir } = boot([{ id: 'odd', profile: { ...bearer('odd', 'ODD_KEY'), base_url: 42 } }]);
    expect(store.get('odd')).toBeUndefined();
    expect(reasonOf(store.save(bearer('crm', 'ODD_KEY'), dir))).toContain('uses the vault name ODD_KEY');
  });
});

// ── two files with one id ──

describe('two files with one id', () => {
  const versions = [
    { ...oauth('shop'), description: 'oauth' },
    { ...bearer('shop', 'SHOP_KEY'), description: 'bearer' },
  ];
  it.each([[0, 1], [1, 0]])('reading version %i first: neither is registered, and both hold their names', (a, b) => {
    const { store, dir } = fromDirectory([
      { id: 'a', profile: versions[a]! as unknown as Record<string, unknown> },
      { id: 'b', profile: versions[b]! as unknown as Record<string, unknown> },
    ]);
    expect(store.get('shop')).toBeUndefined();
    expect(store.size).toBe(0);
    expect(reasonOf(store.save(bearer('crm', 'SHOP_KEY'), dir))).toContain('uses the vault name SHOP_KEY');
    expect(reasonOf(store.save(bearer('rep', 'SHOP_REFRESH_TOKEN'), dir))).toContain('uses the vault name SHOP_REFRESH_TOKEN');
    expect(reasonOf(store.save(bearer('shop', 'FRESH_KEY'), dir))).toContain('profile "shop" has the id of');
  });

  it('a save of the id goes through once both files are deleted by their names', async () => {
    const { store, dir } = fromDirectory([
      { id: 'a', profile: versions[0]! as unknown as Record<string, unknown> },
      { id: 'b', profile: versions[1]! as unknown as Record<string, unknown> },
    ]);
    expect(await callTool(store, { action: 'delete', id: 'a' })).toBe('Deleted API profile "a".');
    expect(reasonOf(store.save(bearer('shop', 'FRESH_KEY'), dir))).toContain('file "b.json"');
    expect(await callTool(store, { action: 'delete', id: 'b' })).toBe('Deleted API profile "b".');
    expect(store.save(bearer('shop', 'FRESH_KEY'), dir).ok).toBe(true);
  });
});

// ── a registration that throws during the boot ──

describe.each(loaders)('a profile whose registration throws during the boot, through %s', (_loader, boot) => {
  it('becomes an unreadable entry, and a profile registered earlier in the pass with one of its names is held back', () => {
    const real = ApiStore.prototype.register;
    const spy = vi.spyOn(ApiStore.prototype, 'register').mockImplementation(function (this: ApiStore, p: ApiProfile, mode) {
      if (p.id === 'shop') throw new Error('boom');
      return real.call(this, p, mode);
    });
    const { store } = boot([asEntry(bearer('a-rep', 'SHOP_ACCESS_TOKEN')), asEntry(oauth('shop'))]);
    spy.mockRestore();
    expect(store.get('shop')).toBeUndefined();
    expect(store.unreadableHolds('SHOP_ACCESS_TOKEN')).toBe(true);
    expect(store.get('a-rep')).toBeUndefined();
  });
});

// ── bounds: past them, the entry holds every name ──

describe('an entry past the bounds of what is collected', () => {
  it.each([
    ['more strings than the bound', { ...bearer('big', 'BIG_KEY'), notes: Array.from({ length: 10_001 }, (_, i) => `n${String(i)}`) }],
    ['nested deeper than the bound', { ...bearer('deep', 'DEEP_KEY'), extra: JSON.parse(`${'['.repeat(40)}"x"${']'.repeat(40)}`) as unknown, description: '' }],
  ])('%s: holds every name', (_what, profile) => {
    const p = profile as Record<string, unknown>;
    const { store, dir } = fromDirectory([{ id: String(p['id']), profile: { ...p, description: '' } }]);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
    expect(store.save(bearer('crm', 'CRM_KEY'), dir).ok).toBe(false);
  });
  it('control: within the bounds, a name it does not carry is not held', () => {
    const { store } = fromDirectory([{ id: 'small', profile: { ...bearer('small', 'SMALL_KEY'), description: '' } }]);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
  });
});

// ── the purge on delete keeps what an unreadable entry holds ──

describe('the purge on delete', () => {
  const written = value('shared', 'token');
  const deleted = (): ApiProfile => ({ ...oauth('crm'), oauth_grant: { written: [{ name: 'SHARED_T', fp: tokenFingerprint(written) }] } });
  it('leaves a token in the vault whose name an unreadable entry holds', () => {
    const { store } = fromDirectory([{ id: 'odd', raw: '{"vault_keys": ["SHARED_T"' }]);
    const vault = handlerVault({ SHARED_T: written });
    expect(purgeRecordedTokens(store, deleted(), vault).removed).toEqual([]);
    expect(vault.peek('SHARED_T')).toBe(written);
  });
  it('control: without the entry, the token is removed', () => {
    const { store } = fromDirectory([]);
    const vault = handlerVault({ SHARED_T: written });
    expect(purgeRecordedTokens(store, deleted(), vault).removed).toEqual(['SHARED_T']);
  });
});
