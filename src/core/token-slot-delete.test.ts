import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// What a delete takes with a profile. A token the profile's own exchange wrote leaves with it,
// whoever else names it, with two exceptions: a stored entry the boot could not read names it too
// (whose it is cannot be told: the delete is refused before anything is removed), or the other
// half of a `-`/`_` pair records the same token on the same vault slot. A profile the boot held
// back is deleted like a registered one: asked, by its author only, and purged. Every test goes
// through the real loader, `api_setup` and `purgeRecordedTokens`.

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
import { slotMayReach } from './profile-secret-view.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { setPinnedTransportForTests } from './network-guard.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { flattenPrompt } from './prompt-value.js';
import type { RequestPrincipal } from './request-principal.js';

// Values assembled at runtime: no literal here has the shape of a credential.
const value = (...parts: string[]): string => parts.join('-');

let sent = 0;
let restoreTransport: (() => void) | undefined;
const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  sent = 0;
  lynoxDir = tmp('lynox-delete-home-');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  restoreTransport = setPinnedTransportForTests(async () => {
    sent += 1;
    return new Response('ok', { status: 200 });
  });
});

afterEach(() => {
  restoreTransport?.();
  restoreTransport = undefined;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ackFor = (...hosts: string[]) => ({ accepted: true as const, hosts, accepted_at: '2026-10-18T00:00:00.000Z' });
const slotOf = (id: string): string => id.toUpperCase().replace(/-/g, '_');
type Written = Record<string, string>;
const record = (w: Written) => ({ written: Object.entries(w).map(([name, v]) => ({ name, fp: tokenFingerprint(v) })) });

/** An oauth2 profile on `<id>.example`, with a client pair of its own. */
function oauth(id: string, written: Written = {}, over: Partial<ApiProfile> = {}): ApiProfile {
  const host = `${id.replace(/_/g, '-')}.example`;
  return {
    id, name: id, base_url: `https://${host}/v1`, description: id,
    auth: { type: 'oauth2', oauth: { token_url: `https://${host}/oauth/token`, grant_type: 'refresh_token', client_id_key: `${slotOf(id)}_CID`, client_secret_key: `${slotOf(id)}_CSECRET` } },
    custom_endpoint_ack: ackFor(host),
    ...(Object.keys(written).length > 0 ? { oauth_grant: record(written) } : {}),
    ...over,
  };
}
const bearer = (id: string, key: string, over: Partial<ApiProfile> = {}): ApiProfile => ({
  id, name: id, base_url: `https://${id}.example/v1`, description: id, auth: { type: 'bearer', vault_keys: [key] }, custom_endpoint_ack: ackFor(`${id}.example`), ...over,
});

/** The flat-JSON directory `api_setup` deletes from, booted: profiles as files, `raw` as text that does not parse. */
function boot(files: ReadonlyArray<ApiProfile | { file: string; raw: string }>): { store: ApiStore; dir: string } {
  const dir = join(lynoxDir, 'apis');
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    if ('raw' in f) writeFileSync(join(dir, f.file), f.raw);
    else writeFileSync(join(dir, `${f.id}.json`), JSON.stringify(f));
  }
  const store = new ApiStore();
  store.loadFromDirectory(dir);
  return { store, dir };
}

/** A vault over a plain map. */
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

const OWNER: RequestPrincipal = { kind: 'owner' } as RequestPrincipal;
const mandate = (email: string): RequestPrincipal => ({ kind: 'mandate', email, mandateId: 'M-1' } as RequestPrincipal);

function agentFor(store: ApiStore, vault: Vault, opts: { principal?: RequestPrincipal; promptUser?: () => Promise<string> } = {}): never {
  return {
    principal: opts.principal ?? OWNER,
    sessionCounters: { httpRequests: 0 },
    secretStore: vault,
    promptUser: opts.promptUser,
    getAvailableTools: () => [{ definition: { name: 'http_request' } }, { definition: { name: 'api_setup' } }],
    toolContext: { apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  } as never;
}
const del = (store: ApiStore, vault: Vault, id: string, opts: Parameters<typeof agentFor>[2] = {}): Promise<string> =>
  apiSetupTool.handler({ action: 'delete', id } as never, agentFor(store, vault, opts)) as Promise<string>;
const allow = (): Promise<string> => Promise.resolve('Allow');

// ── A: a profile the boot held back is deleted like a registered one ──

describe('deleting a profile the boot held back', () => {
  const OUT = value('reporting', 'out');
  // `reporting` signs in with the access slot `crm` derives: the boot holds it back.
  const setup = () => {
    const { store, dir } = boot([
      oauth('crm'),
      bearer('reporting', 'CRM_ACCESS_TOKEN', { created_by: 'mandate:a@example.org', oauth_grant: record({ REPORTING_OUT: OUT }) }),
    ]);
    expect(store.get('reporting')).toBeUndefined();
    expect(store.storedProfile('reporting')).toBeDefined();
    return { store, dir, vault: vaultOf({ REPORTING_OUT: OUT }) };
  };

  it('is refused to another author, and nothing is removed', async () => {
    const { store, dir, vault } = setup();
    const asked = vi.fn(allow);
    const result = await del(store, vault, 'reporting', { principal: mandate('b@example.org'), promptUser: asked });
    expect(result).toBe('Error: API profile "reporting" was not set up in this session\'s name, so this session may not change or delete it. Nothing was changed. Ask the owner to make the change.');
    expect(asked).not.toHaveBeenCalled();
    expect(store.storedProfile('reporting')).toBeDefined();
    expect(existsSync(join(dir, 'reporting.json'))).toBe(true);
    expect(vault.snapshot()).toEqual({ REPORTING_OUT: OUT });
  });

  it('without anyone to ask, deletes nothing and leaves the vault as it was', async () => {
    const { store, dir, vault } = setup();
    const result = await del(store, vault, 'reporting');
    expect(result).toBe('Blocked: deleting API profile "reporting" needs the user\'s confirmation, and no interactive prompt is available here. Nothing was deleted.');
    expect(store.storedProfile('reporting')).toBeDefined();
    expect(existsSync(join(dir, 'reporting.json'))).toBe(true);
    expect(vault.snapshot()).toEqual({ REPORTING_OUT: OUT });
  });

  it('control: its own author, asked and agreeing, deletes it and its tokens', async () => {
    const { store, dir, vault } = setup();
    const asked = vi.fn(allow);
    const result = await del(store, vault, 'reporting', { principal: mandate('a@example.org'), promptUser: asked });
    expect(asked).toHaveBeenCalledOnce();
    expect(result).toBe('Deleted API profile "reporting". Removed the tokens its exchanges wrote: REPORTING_OUT.');
    expect(store.storedProfile('reporting')).toBeUndefined();
    expect(existsSync(join(dir, 'reporting.json'))).toBe(false);
    expect(vault.snapshot()).toEqual({});
  });
});

// ── B: a token an unreadable entry names too: the delete is refused before anything is removed ──

describe('deleting a profile whose written token an unreadable entry names', () => {
  const TOKEN = value('shop', 'access');
  // The entry's text holds the name as a literal; the boot holds `shop` back beside it.
  const placeholder = (file: string) => ({ file, raw: '{"id": "owner", "auth": {"vault_keys": ["SHOP_ACCESS_TOKEN"' });

  it('is refused before the question, names the entry and the way out, and changes nothing', async () => {
    const { store, dir } = boot([oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN }), placeholder('owner.json')]);
    expect(store.storedProfile('shop')).toBeDefined();
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN });
    const asked = vi.fn(allow);
    const result = await del(store, vault, 'shop', { promptUser: asked });
    expect(result).toBe('Error: API profile "shop" was not deleted. Its sign-in wrote SHOP_ACCESS_TOKEN, and the delete would have to remove that token with it, but a stored API profile that could not be read (file "owner.json", id "owner") names it too, so whose it is cannot be told. Nothing was changed. First delete "owner" with api_setup delete (it takes an id that is not registered), then delete "shop" again.');
    expect(asked).not.toHaveBeenCalled();
    expect(store.storedProfile('shop')).toBeDefined();
    expect(existsSync(join(dir, 'shop.json'))).toBe(true);
    expect(existsSync(join(dir, 'owner.json'))).toBe(true);
    expect(store.unreadableHolds('SHOP_ACCESS_TOKEN')).toBe(true);
    expect(vault.snapshot()).toEqual({ SHOP_ACCESS_TOKEN: TOKEN });
  });

  it('control: once the entry is deleted by its id, the repeated delete removes the profile and its token', async () => {
    const { store, dir } = boot([oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN }), placeholder('owner.json')]);
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN });
    expect(await del(store, vault, 'owner', { promptUser: allow })).toBe('Deleted API profile "owner".');
    expect(store.unreadableHolds('SHOP_ACCESS_TOKEN')).toBe(false);
    expect(await del(store, vault, 'shop', { promptUser: allow })).toBe('Deleted API profile "shop". Removed the tokens its exchanges wrote: SHOP_ACCESS_TOKEN.');
    expect(existsSync(join(dir, 'shop.json'))).toBe(false);
    expect(vault.snapshot()).toEqual({});
  });

  it('says to remove the file by hand when its name is no id a delete takes', async () => {
    const { store } = boot([oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN }), placeholder('bad id.json')]);
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN });
    const result = await del(store, vault, 'shop', { promptUser: allow });
    expect(result).toContain('a stored API profile that could not be read (file "bad id.json", id "bad id") names it too');
    expect(result).toContain('First remove the file "bad id.json" from the API profile directory by hand (its name is no id api_setup delete takes), then delete "shop" again.');
    expect(result).not.toContain('api_setup delete (it takes');
    expect(vault.snapshot()).toEqual({ SHOP_ACCESS_TOKEN: TOKEN });
  });

  it('does not refuse for a name the entry holds when the vault no longer has the value written', async () => {
    const { store } = boot([oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN }), placeholder('owner.json')]);
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: value('replaced', 'since') });
    expect(await del(store, vault, 'shop', { promptUser: allow })).toMatch(/^Deleted API profile "shop"\./);
  });

  it('names every token an entry holds, in the plural', async () => {
    const { store } = boot([
      oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN, SHOP_REFRESH_TOKEN: value('shop', 'refresh') }),
      { file: 'owner.json', raw: '{"id": "owner", "auth": {"vault_keys": ["SHOP_ACCESS_TOKEN", "SHOP_REFRESH_TOKEN"' },
    ]);
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN, SHOP_REFRESH_TOKEN: value('shop', 'refresh') });
    expect(await del(store, vault, 'shop', { promptUser: allow })).toBe('Error: API profile "shop" was not deleted. Its sign-in wrote SHOP_ACCESS_TOKEN, SHOP_REFRESH_TOKEN, and the delete would have to remove those tokens with it, but a stored API profile that could not be read (file "owner.json", id "owner") names them too, so whose they are cannot be told. Nothing was changed. First delete "owner" with api_setup delete (it takes an id that is not registered), then delete "shop" again.');
  });

  it('weighs every entry: one that names nothing of the profile does not end the check', async () => {
    const { store } = boot([
      oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN }),
      { file: 'aaa.json', raw: '{"id": "aaa", "auth": {"vault_keys": ["SOMEONE_ELSES_KEY"' },
      placeholder('owner.json'),
    ]);
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN });
    expect(await del(store, vault, 'shop', { promptUser: allow })).toContain('(file "owner.json", id "owner") names it too');
  });

  it('an entry past the bounds of what is collected holds every recorded name', async () => {
    const deep = { ...bearer('deep', 'DEEP_KEY'), description: '', extra: JSON.parse(`${'['.repeat(40)}"x"${']'.repeat(40)}`) as unknown };
    const { store } = boot([oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN }), deep as unknown as ApiProfile]);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN });
    expect(await del(store, vault, 'shop', { promptUser: allow })).toContain('First delete "deep" with api_setup delete');
    expect(vault.snapshot()).toEqual({ SHOP_ACCESS_TOKEN: TOKEN });
  });

  it('does not refuse for a token a mandate\'s consent wrote, and removes it', async () => {
    const { store } = boot([
      oauth('shop', {}, { oauth_grant: { connected_by: 'mandate:a@example.org', ...record({ SHOP_ACCESS_TOKEN: TOKEN }) } }),
      placeholder('owner.json'),
    ]);
    expect(store.storedProfile('shop')).toBeDefined();
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN });
    expect(await del(store, vault, 'shop', { promptUser: allow })).toBe('Deleted API profile "shop". Removed the tokens its exchanges wrote: SHOP_ACCESS_TOKEN.');
    expect(vault.snapshot()).toEqual({});
  });

  it('does not refuse for a protected name on the record', () => {
    const { store } = boot([{ file: 'owner.json', raw: '{"id": "owner", "auth": {"vault_keys": ["GOOGLE_OAUTH_X_ACCESS_TOKEN"' }]);
    const shop = oauth('shop', { GOOGLE_OAUTH_X_ACCESS_TOKEN: TOKEN });
    expect(store.unreadableHolds('GOOGLE_OAUTH_X_ACCESS_TOKEN')).toBe(true);
    expect(store.deleteRefusal(shop, vaultOf({ GOOGLE_OAUTH_X_ACCESS_TOKEN: TOKEN }))).toBeNull();
  });

  it('does not refuse when the vault cannot read the name, and does not throw', () => {
    const { store } = boot([placeholder('owner.json')]);
    const shop = oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN });
    const throwing = { ...vaultOf({}), resolve: (): string | null => { throw new Error('locked'); } };
    expect(store.deleteRefusal(shop, throwing)).toBeNull();
    // Control: a vault that reads the value written is refused.
    expect(store.deleteRefusal(shop, vaultOf({ SHOP_ACCESS_TOKEN: TOKEN }))).toContain('was not deleted');
  });

  // The check and the purge are not one step: an entry read in between is still weighed.
  it('keeps the token when an unreadable entry naming it appears between the check and the purge', async () => {
    const { store } = boot([oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN })]);
    expect(store.get('shop')).toBeDefined();
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN });
    const late = tmp('lynox-delete-late-');
    writeFileSync(join(late, 'owner.json'), placeholder('owner.json').raw);
    // The question is asked after the check; the entry is read while it is open.
    const result = await del(store, vault, 'shop', { promptUser: async () => { store.loadFromDirectory(late); return 'Allow'; } });
    expect(result).toBe('Deleted API profile "shop". Left in the vault although this profile\'s sign-in wrote it: SHOP_ACCESS_TOKEN. A stored API profile that could not be read names it too, so whose it is cannot be told, so it was not removed. This profile is gone, so no later delete takes it away: remove it from the vault by hand once it is clear it is not that profile\'s.');
    expect(vault.snapshot()).toEqual({ SHOP_ACCESS_TOKEN: TOKEN });
  });
});

// ── D: an unreadable entry holds every name it carries; only the owner deletes it, asked ──

describe('deleting an entry the boot could not read', () => {
  const TOKEN = value('shop', 'access');
  const placeholder = (file: string) => ({ file, raw: '{"id": "owner", "auth": {"vault_keys": ["SHOP_ACCESS_TOKEN"' });

  it('is asked of the owner, names where the entry is, and goes through on agreement', async () => {
    const { store, dir } = boot([placeholder('owner.json')]);
    const asked = vi.fn(allow);
    expect(await del(store, vaultOf({}), 'owner', { promptUser: asked })).toBe('Deleted API profile "owner".');
    expect(asked).toHaveBeenCalledOnce();
    expect(flattenPrompt((asked.mock.calls[0] as unknown[])[0] as never)).toBe('⚠ api_setup: delete the stored API profile owner, which could not be read (file "owner.json")? Every vault name it carries is free for other profiles once it is gone. Delete it?');
    expect(existsSync(join(dir, 'owner.json'))).toBe(false);
    expect(store.unreadableHolds('SHOP_ACCESS_TOKEN')).toBe(false);
  });

  it.each([
    ['nobody to ask', undefined, 'Blocked: deleting the unreadable API profile entry "owner" needs the user\'s confirmation, and no interactive prompt is available here. Nothing was deleted.'],
    ['the owner declines', async () => 'Deny', 'Blocked: API profile entry "owner" not deleted — user declined.'],
  ] as const)('%s: nothing is deleted', async (_case, promptUser, reply) => {
    const { store, dir } = boot([placeholder('owner.json')]);
    expect(await del(store, vaultOf({}), 'owner', promptUser ? { promptUser } : {})).toBe(reply);
    expect(existsSync(join(dir, 'owner.json'))).toBe(true);
    expect(store.unreadableHolds('SHOP_ACCESS_TOKEN')).toBe(true);
  });

  it('is refused to a mandate, unasked, and nothing is deleted', async () => {
    const { store, dir } = boot([placeholder('owner.json')]);
    const asked = vi.fn(allow);
    expect(await del(store, vaultOf({}), 'owner', { principal: mandate('a@example.org'), promptUser: asked })).toBe('Error: "owner" is a stored API profile that could not be read (file "owner.json"). Only the owner may delete it, since it holds every vault name it carries until it is gone. Nothing was changed. Ask the owner to delete it.');
    expect(asked).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'owner.json'))).toBe(true);
    expect(store.unreadableHolds('SHOP_ACCESS_TOKEN')).toBe(true);
  });

  it('control: an id with neither a stored profile nor such an entry is answered unasked', async () => {
    const { store } = boot([placeholder('owner.json')]);
    const asked = vi.fn(allow);
    expect(await del(store, vaultOf({}), 'nothing-here', { principal: mandate('a@example.org'), promptUser: asked })).toBe('API profile "nothing-here" not found.');
    expect(asked).not.toHaveBeenCalled();
  });

  // The refusal of a held profile's delete shows a mandate no way it may not take.
  it.each([
    ['owner.json', 'First ask the owner to delete "owner"; only the owner may delete it, then delete "shop" again.'],
    ['bad id.json', 'First ask the owner to remove the file "bad id.json" from the API profile directory by hand (its name is no id api_setup delete takes), then delete "shop" again.'],
  ])('tells a mandate author to ask the owner to clear %s', async (file, way) => {
    const { store } = boot([oauth('shop', { SHOP_ACCESS_TOKEN: TOKEN }, { created_by: 'mandate:a@example.org' }), placeholder(file)]);
    const vault = vaultOf({ SHOP_ACCESS_TOKEN: TOKEN });
    const result = await del(store, vault, 'shop', { principal: mandate('a@example.org'), promptUser: allow });
    expect(result).toContain('API profile "shop" was not deleted.');
    expect(result).toContain(way);
    expect(result).not.toContain('First delete');
    expect(result).not.toContain('First remove');
    expect(vault.snapshot()).toEqual({ SHOP_ACCESS_TOKEN: TOKEN });
  });
});

// ── C: only the other half of a `-`/`_` pair keeps a token, and only the same one ──

describe('a token another stored profile records too', () => {
  const TOKEN = value('pair', 'access');

  it('stays when the other half of a `-`/`_` pair records it with the same fingerprint', () => {
    const store = new ApiStore();
    expect(store.register(oauth('x-y', { X_Y_ACCESS_TOKEN: TOKEN }))).toBe(true);
    const half = oauth('x_y', { X_Y_ACCESS_TOKEN: TOKEN });
    store.register(half);
    expect(store.storedProfile('x_y')).toBeDefined();
    const vault = vaultOf({ X_Y_ACCESS_TOKEN: TOKEN });
    const result = purgeRecordedTokens(store, half, vault);
    expect(result.heldBySlotPartner).toEqual(['X_Y_ACCESS_TOKEN']);
    expect(result.removed).toEqual([]);
    expect(vault.snapshot()).toEqual({ X_Y_ACCESS_TOKEN: TOKEN });
  });

  it('is removed when a profile on another vault slot records it with the same fingerprint', () => {
    const store = new ApiStore();
    const crm = oauth('crm', { SHARED_TOKEN: TOKEN });
    expect(store.register(crm)).toBe(true);
    store.register(oauth('second', { SHARED_TOKEN: TOKEN }));
    expect(store.storedProfile('second')).toBeDefined();
    const vault = vaultOf({ SHARED_TOKEN: TOKEN });
    const result = purgeRecordedTokens(store, crm, vault);
    expect(result.removed).toEqual(['SHARED_TOKEN']);
    expect(result.heldBySlotPartner).toEqual([]);
    expect(vault.snapshot()).toEqual({});
  });

  it('is removed when the other half of the pair records the same value under another name', () => {
    const store = new ApiStore();
    expect(store.register(oauth('x-y', { X_Y_OTHER: TOKEN }))).toBe(true);
    const half = oauth('x_y', { X_Y_ACCESS_TOKEN: TOKEN });
    store.register(half);
    const vault = vaultOf({ X_Y_ACCESS_TOKEN: TOKEN });
    const result = purgeRecordedTokens(store, half, vault);
    expect(result.removed).toEqual(['X_Y_ACCESS_TOKEN']);
    expect(result.heldBySlotPartner).toEqual([]);
  });

  it('is removed when the other half of the pair records another value under the name', () => {
    const store = new ApiStore();
    expect(store.register(oauth('x-y', { X_Y_ACCESS_TOKEN: value('older', 'one') }))).toBe(true);
    const half = oauth('x_y', { X_Y_ACCESS_TOKEN: TOKEN });
    store.register(half);
    const vault = vaultOf({ X_Y_ACCESS_TOKEN: TOKEN });
    const result = purgeRecordedTokens(store, half, vault);
    expect(result.removed).toEqual(['X_Y_ACCESS_TOKEN']);
    expect(result.heldBySlotPartner).toEqual([]);
    expect(vault.snapshot()).toEqual({});
  });
});

// ── a token outlives no owner (N4) ──

describe('a token whose owner is deleted while another profile names it', () => {
  it('is removed, and a `secret:` reference to it resolves to nothing', async () => {
    const TOKEN = value('crm', 'access');
    const { store } = boot([oauth('crm', { CRM_ACCESS_TOKEN: TOKEN }), bearer('reporting', 'CRM_ACCESS_TOKEN')]);
    expect(store.storedProfile('reporting')).toBeDefined();
    const vault = vaultOf({ CRM_ACCESS_TOKEN: TOKEN });
    expect(await del(store, vault, 'crm', { promptUser: allow })).toBe('Deleted API profile "crm". Removed the tokens its exchanges wrote: CRM_ACCESS_TOKEN.');
    expect(vault.resolveSecretRefs({ header: 'Bearer secret:CRM_ACCESS_TOKEN' })).toEqual({ header: 'Bearer secret:CRM_ACCESS_TOKEN' });
    expect(sent).toBe(0);
  });
});

// ── A-F2: a configured refresh slot that no grant holds is its configurer's ──

describe('a refresh slot an oauth2 profile configures and nothing else names', () => {
  const shop = (): ApiProfile => oauth('shop', {}, {
    auth: { type: 'oauth2', oauth: { token_url: 'https://shop.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'SHOP_CID', client_secret_key: 'SHOP_CSECRET', refresh_token_key: 'SHOP_RT' } },
  });

  it('goes to no target outside the profile\'s grant', () => {
    const store = new ApiStore();
    expect(store.register(shop())).toBe(true);
    expect(slotMayReach(store, 'SHOP_RT', 'other', undefined)).toBe(false);
    expect(slotMayReach(store, 'SHOP_RT', 'request', 'https://evil.example/collect')).toBe(false);
    expect(slotMayReach(store, 'SHOP_RT', 'exchange', 'https://evil.example/token')).toBe(false);
  });

  it('control: goes to the profile\'s own token endpoint in its own exchange', () => {
    const store = new ApiStore();
    expect(store.register(shop())).toBe(true);
    expect(slotMayReach(store, 'SHOP_RT', 'exchange', 'https://shop.example/oauth/token', store.get('shop'))).toBe(true);
  });

  // A bearer profile reads no refresh slot, even under the name its id would derive one as.
  it('control: a name only a bearer profile configures is no token slot', () => {
    const store = new ApiStore();
    expect(store.register(bearer('plain', 'PLAIN_REFRESH_TOKEN'))).toBe(true);
    expect(slotMayReach(store, 'PLAIN_REFRESH_TOKEN', 'other', undefined)).toBe(true);
  });

  it('control: another name the oauth2 profile configures is not made its token slot', () => {
    const store = new ApiStore();
    expect(store.register(shop())).toBe(true);
    expect(slotMayReach(store, 'SHOP_CSECRET', 'other', undefined)).toBe(true);
  });
});
