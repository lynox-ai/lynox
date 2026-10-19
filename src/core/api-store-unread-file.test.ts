import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The store booting from the profile directory (`loadFromDirectory`, the boot without engine.db).
// A profile file it cannot read at all (no permission, a link to nothing) was seen as
// nothing but its file name, so it held only the token pair that name derives. A name its content
// carried, such as a token its sign-in wrote, was free for any other profile. Such a file now
// holds every name until it is readable at the next start or deleted, and both ways out work. A
// directory with a profile file's name is no profile and holds nothing. Every test goes through
// the real loader; the delete goes through `api_setup`.

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

// `api_setup` resolves the flat-JSON directory as `<lynox dir>/apis`.
let lynoxDir = '';
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  getLynoxDir: () => lynoxDir,
}));

import { ApiStore, type ApiProfile } from './api-store.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import type { RequestPrincipal } from './request-principal.js';

const IS_ROOT = process.getuid?.() === 0;

const dirs: string[] = [];

beforeEach(() => {
  lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-unread-'));
  dirs.push(lynoxDir);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, 'apis', 'shop.json'), 0o600); } catch { /* not there, or a link */ }
    rmSync(d, { recursive: true, force: true });
  }
});

const ackFor = (...hosts: string[]) => ({ accepted: true as const, hosts, accepted_at: '2026-10-18T00:00:00.000Z' });

/** An oauth2 profile `shop` whose sign-in wrote SHOP_OUT. */
const shop = (over: Partial<ApiProfile> = {}): ApiProfile => ({
  id: 'shop', name: 'shop', base_url: 'https://shop.example/v1', description: 'shop',
  auth: { type: 'oauth2', oauth: { token_url: 'https://shop.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'SHOP_CID', client_secret_key: 'SHOP_CSECRET' } },
  custom_endpoint_ack: ackFor('shop.example'),
  oauth_grant: { written: [{ name: 'SHOP_OUT', fp: 'x' }] },
  ...over,
} as ApiProfile);
const bearer = (id: string, key: string): ApiProfile => ({
  id, name: id, base_url: `https://${id}.example/v1`, description: id, auth: { type: 'bearer', vault_keys: [key] }, custom_endpoint_ack: ackFor(`${id}.example`),
});

const apisDir = (): string => {
  const d = join(lynoxDir, 'apis');
  mkdirSync(d, { recursive: true });
  return d;
};
const put = (dir: string, p: ApiProfile): void => writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
const boot = (dir: string): ApiStore => {
  const store = new ApiStore();
  store.loadFromDirectory(dir);
  return store;
};

const OWNER: RequestPrincipal = { kind: 'owner' } as RequestPrincipal;
const del = (store: ApiStore, id: string): Promise<string> =>
  apiSetupTool.handler({ action: 'delete', id } as never, {
    principal: OWNER,
    sessionCounters: { httpRequests: 0 },
    secretStore: null,
    promptUser: () => Promise.resolve('Allow'),
    getAvailableTools: () => [{ definition: { name: 'api_setup' } }],
    toolContext: { apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  } as never) as Promise<string>;

describe('a profile file the boot cannot read at all holds every name', () => {
  it('a link to nothing: another profile naming what it might carry is not registered', () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    put(dir, bearer('rep', 'SHOP_OUT'));
    const store = boot(dir);
    expect(store.get('rep')).toBeUndefined();
    expect(store.unreadableHolds('SHOP_OUT')).toBe(true);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
  });

  it.skipIf(IS_ROOT)('a file without read permission: the same, and once readable it is read again at the next start', () => {
    const dir = apisDir();
    put(dir, shop());
    chmodSync(join(dir, 'shop.json'), 0o000);
    put(dir, bearer('rep', 'SHOP_OUT'));
    const store = boot(dir);
    expect(store.get('rep')).toBeUndefined();
    expect(store.unreadableHolds('SHOP_OUT')).toBe(true);

    chmodSync(join(dir, 'shop.json'), 0o600);
    const next = boot(dir);
    expect(next.get('shop')).toBeDefined();
    expect(next.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
  });

  it('control: a file that was read but is no profile holds only what it carries', () => {
    const dir = apisDir();
    put(dir, shop({ description: '' }));
    put(dir, bearer('rep', 'SHOP_OUT'));
    put(dir, bearer('other', 'OTHER_KEY'));
    const store = boot(dir);
    expect(store.get('rep')).toBeUndefined();
    expect(store.get('other')).toBeDefined();
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
  });

  it('control: a file that was read but does not parse holds only the names in its text', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), '{"id": "shop", "oauth_grant": {"written": [{"name": "SHOP_OUT"');
    put(dir, bearer('rep', 'SHOP_OUT'));
    put(dir, bearer('other', 'OTHER_KEY'));
    const store = boot(dir);
    expect(store.get('rep')).toBeUndefined();
    expect(store.get('other')).toBeDefined();
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
  });

  it('a save beside it is refused, and the reason names both ways out but not other names', () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    const store = boot(dir);
    const saved = store.save(bearer('rep', 'REP_KEY'), dir);
    expect(saved.ok).toBe(false);
    const reason = saved.ok ? '' : saved.reason;
    expect(reason).toContain('delete "shop" with api_setup delete');
    expect(reason).toContain('If the file should stay, make it readable instead; it is read again at the next start.');
    expect(reason).not.toContain('vault names of its own');
  });

  it('control: beside a file that was read, the reason offers other names and not readability', () => {
    const dir = apisDir();
    put(dir, shop({ description: '' }));
    const store = boot(dir);
    const saved = store.save(bearer('rep', 'SHOP_OUT'), dir);
    expect(saved.ok).toBe(false);
    const reason = saved.ok ? '' : saved.reason;
    expect(reason).toContain('Or give "rep" vault names of its own.');
    expect(reason).not.toContain('make it readable');
  });

  it('a link to nothing is deleted with api_setup delete, and then a save goes through', async () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    const store = boot(dir);
    expect(await del(store, 'shop')).toBe('Deleted API profile "shop".');
    expect(() => lstatSync(join(dir, 'shop.json'))).toThrow();
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
    expect(store.save(bearer('rep', 'SHOP_OUT'), dir).ok).toBe(true);
  });

  it.skipIf(IS_ROOT)('a file without read permission is deleted with api_setup delete as well', async () => {
    const dir = apisDir();
    put(dir, shop());
    chmodSync(join(dir, 'shop.json'), 0o000);
    const store = boot(dir);
    expect(await del(store, 'shop')).toBe('Deleted API profile "shop".');
    expect(existsSync(join(dir, 'shop.json'))).toBe(false);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
  });
});

describe('what holding every name blocks, and the ways out', () => {
  it('a link to itself holds every name as well, and api_setup delete removes the link', async () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'shop.json'), join(dir, 'shop.json'));
    put(dir, bearer('rep', 'SHOP_OUT'));
    const store = boot(dir);
    expect(store.get('rep')).toBeUndefined();
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
    expect(await del(store, 'shop')).toBe('Deleted API profile "shop".');
    expect(() => lstatSync(join(dir, 'shop.json'))).toThrow();
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
  });

  it('a link to nothing whose name is no id: the reason says to remove it by hand, or to make it readable', () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'bad id.json'));
    const store = boot(dir);
    const saved = store.save(bearer('rep', 'REP_KEY'), dir);
    const reason = saved.ok ? '' : saved.reason;
    expect(reason).toContain('remove the file "bad id.json" from the API profile directory by hand');
    expect(reason).toContain('If the file should stay, make it readable instead; it is read again at the next start.');
  });

  it('a profile with a name of its own is held back at the start, and comes back by a save once the entry is deleted', async () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    put(dir, bearer('rep', 'REP_KEY'));
    const store = boot(dir);
    expect(store.get('rep')).toBeUndefined();
    expect(store.storedProfile('rep')).toBeDefined();
    expect(await del(store, 'shop')).toBe('Deleted API profile "shop".');
    // Not by the delete itself: it comes back by a save or at the next start.
    expect(store.get('rep')).toBeUndefined();
    expect(boot(dir).get('rep')).toBeDefined();
    expect(store.save(bearer('rep', 'REP_KEY'), dir).ok).toBe(true);
    expect(store.get('rep')).toBeDefined();
  });

  it('deleting a profile whose sign-in wrote a token is refused while the entry is there, and works once it is deleted', async () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'old.json'));
    const out = ['shop', 'out', 'value'].join('-');
    put(dir, shop({ oauth_grant: { written: [{ name: 'SHOP_OUT', fp: tokenFingerprint(out) }] } } as Partial<ApiProfile>));
    const store = boot(dir);
    // Held back too: it has names, and the entry holds every name.
    expect(store.get('shop')).toBeUndefined();
    expect(store.storedProfile('shop')).toBeDefined();
    const vault = { resolve: (n: string) => (n === 'SHOP_OUT' ? out : null) };
    expect(store.deleteRefusal(store.storedProfile('shop')!, vault as never, 'owner')).toContain('First delete "old" with api_setup delete');
    expect(await del(store, 'old')).toBe('Deleted API profile "old".');
    expect(store.deleteRefusal(store.storedProfile('shop')!, vault as never, 'owner')).toBeNull();
  });
});

describe('a directory with a profile file\'s name', () => {
  it('is no profile and holds nothing, so other profiles still register', () => {
    const dir = apisDir();
    mkdirSync(join(dir, 'z.json'));
    put(dir, bearer('rep', 'Z_KEY'));
    const store = boot(dir);
    expect(store.get('rep')).toBeDefined();
    expect(store.unreadableHolds('Z_ACCESS_TOKEN')).toBe(false);
    expect(store.unreadableSourceOf('z')).toBeNull();
  });
});
