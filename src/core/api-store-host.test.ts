import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore, purgeRecordedTokens, type ApiProfile } from './api-store.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';

/**
 * One profile per host, and the grant record's two projections (the
 * `connections.status` column and the `vault_keys` purge trail).
 *
 * The host rule exists because `http_request` resolves the credential by
 * hostname alone: two profiles on one host used to be last-write-wins, and the
 * attach sent whichever had loaded last without a word.
 */
describe('ApiStore — one profile per host', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function makeCs(): ConnectionStore {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-apihost-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return new ConnectionStore(engine);
  }

  function profile(id: string, baseUrl: string, over: Partial<ApiProfile> = {}): ApiProfile {
    return { id, name: id, base_url: baseUrl, description: `${id} API`, auth: { type: 'bearer', vault_keys: [`${id.toUpperCase()}_KEY`] }, ...over };
  }

  afterEach(() => {
    for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('refuses to save a second profile on a host another profile holds, and names the holder', () => {
    const store = new ApiStore();
    expect(store.save(profile('crm-a', 'https://api.crm.example/v1'))).toEqual({ ok: true, isNew: true });
    const second = store.save(profile('crm-b', 'https://api.crm.example/v2'));
    expect(second.ok).toBe(false);
    expect(second.ok ? '' : second.reason).toContain('"crm-a" already maps to api.crm.example');
    expect(store.get('crm-b')).toBeUndefined();
    // The holder is untouched and still resolves.
    expect(store.getByHostname('api.crm.example')?.id).toBe('crm-a');
  });

  it('sends the actor to the user, not to a delete, when it refuses', () => {
    const store = new ApiStore();
    store.save(profile('crm-a', 'https://api.crm.example/v1'));
    const second = store.save(profile('crm-b', 'https://api.crm.example/v2'));
    expect(second.ok ? '' : second.reason).toContain('Ask the user whether "crm-a" should be updated instead.');
    expect(second.ok ? '' : second.reason).not.toContain('delete');
  });

  it('lets a profile the boot left on a shared host save in place, but no third one join', () => {
    const store = new ApiStore();
    store.register(profile('crm-a', 'https://api.crm.example/v1'));
    store.register(profile('crm-b', 'https://api.crm.example/v2'));
    // An expiry, a revocation, an edit — none of them makes the conflict worse.
    expect(store.save(profile('crm-a', 'https://api.crm.example/v1', { description: 'edited' }))).toEqual({ ok: true, isNew: false });
    expect(store.get('crm-a')?.description).toBe('edited');
    expect(store.getHostConflict('api.crm.example')).toEqual(['crm-a', 'crm-b']);
    expect(store.save(profile('crm-c', 'https://api.crm.example/v3')).ok).toBe(false);
  });

  it('saves the same profile again on its own host (an update is not a second profile)', () => {
    const store = new ApiStore();
    store.save(profile('crm-a', 'https://api.crm.example/v1'));
    expect(store.save(profile('crm-a', 'https://api.crm.example/v1', { description: 'changed' }))).toEqual({ ok: true, isNew: false });
    expect(store.getByHostname('api.crm.example')?.description).toBe('changed');
  });

  it('refuses an update that moves a profile onto a host another profile holds', () => {
    const store = new ApiStore();
    store.save(profile('crm-a', 'https://api.crm.example/v1'));
    store.save(profile('billing', 'https://api.billing.example/v1'));
    const moved = store.save(profile('billing', 'https://api.crm.example/v1'));
    expect(moved.ok).toBe(false);
    // Refused means nothing moved: billing keeps its old host.
    expect(store.getByHostname('api.billing.example')?.id).toBe('billing');
    expect(store.getByHostname('api.crm.example')?.id).toBe('crm-a');
  });

  it('releases the old host when an update moves a profile away, so a new profile can take it', () => {
    const store = new ApiStore();
    store.save(profile('crm-a', 'https://api.old.example/v1'));
    expect(store.save(profile('crm-a', 'https://api.new.example/v1')).ok).toBe(true);
    expect(store.getByHostname('api.old.example')).toBeUndefined();
    // Without the release, the old host kept pointing at crm-a and this was refused.
    expect(store.save(profile('crm-b', 'https://api.old.example/v1'))).toEqual({ ok: true, isNew: true });
    expect(store.getByHostname('api.old.example')?.id).toBe('crm-b');
  });

  it('marks a duplicate host at boot instead of dropping a profile, and resolves it on delete', () => {
    const store = new ApiStore();
    // `register` is what the boot paths call; it must not refuse here, or a
    // restart would silently lose a profile that already existed.
    expect(store.register(profile('crm-a', 'https://api.crm.example/v1'))).toBe(true);
    expect(store.register(profile('crm-b', 'https://api.crm.example/v2'))).toBe(true);
    expect(store.get('crm-a')).toBeDefined();
    expect(store.get('crm-b')).toBeDefined();
    expect(store.getByHostname('api.crm.example')).toBeUndefined();
    expect(store.getHostConflict('api.crm.example')).toEqual(['crm-a', 'crm-b']);

    expect(store.unregister('crm-b')).toBe(true);
    expect(store.getHostConflict('api.crm.example')).toBeUndefined();
    expect(store.getByHostname('api.crm.example')?.id).toBe('crm-a');
  });

  it('boots both profiles of a pre-existing duplicate out of engine.db as a marked conflict', () => {
    const cs = makeCs();
    // Rows written directly, as a database from before the rule would hold them.
    const writer = new ApiStore();
    writer.setConnectionStore(cs);
    writer.save(profile('crm-a', 'https://api.crm.example/v1'));
    writer.save(profile('crm-b', 'https://api.other.example/v1'));
    // Move crm-b onto crm-a's host behind the store's back.
    const row = cs.get('crm-b');
    expect(row).toBeDefined();
    cs.upsert({ ...row!, configJson: JSON.stringify({ ...JSON.parse(row!.configJson) as object, base_url: 'https://api.crm.example/v2' }) });

    const booted = new ApiStore();
    expect(booted.loadFromConnections(cs)).toBe(2);
    expect(booted.get('crm-a')).toBeDefined();
    expect(booted.get('crm-b')).toBeDefined();
    expect(booted.getHostConflict('api.crm.example')).toEqual(['crm-a', 'crm-b']);
  });

  it('says so in the operator log when the boot marks a shared host', () => {
    const store = new ApiStore();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      store.register(profile('crm-a', 'https://api.crm.example/v1'));
      store.register(profile('crm-b', 'https://api.crm.example/v2'));
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toContain('Host api.crm.example is mapped by more than one profile (crm-a, crm-b)');
  });

  it('hands the host\'s rate bucket to the profile that remains, not the one that left', () => {
    const store = new ApiStore();
    // The throttled profile boots first, the unthrottled one shares its host.
    store.register(profile('crm-a', 'https://api.crm.example/v1', { rate_limit: { requests_per_second: 1 } }));
    store.register(profile('crm-b', 'https://api.crm.example/v2'));
    store.unregister('crm-a');
    // crm-b declares no limit, so none of crm-a's may linger on the host.
    expect(store.checkRateLimit('api.crm.example')).toBeNull();
    expect(store.checkRateLimit('api.crm.example')).toBeNull();
  });

  it('gives the remaining profile its OWN rate limit back once the other one leaves', () => {
    const store = new ApiStore();
    store.register(profile('crm-a', 'https://api.crm.example/v1', { rate_limit: { requests_per_second: 1 } }));
    // The later profile's generous limit is the one on the host while both stay.
    store.register(profile('crm-b', 'https://api.crm.example/v2', { rate_limit: { requests_per_second: 100 } }));
    store.unregister('crm-b');
    expect(store.checkRateLimit('api.crm.example')).toBeNull();
    // crm-a's own 1/s applies again, not none and not crm-b's.
    expect(store.checkRateLimit('api.crm.example')).not.toBeNull();
  });

  it('names the ids of a shared host in a stable order, whichever booted first', () => {
    const store = new ApiStore();
    store.register(profile('crm-b', 'https://api.crm.example/v2'));
    store.register(profile('crm-a', 'https://api.crm.example/v1'));
    expect(store.getHostConflict('api.crm.example')).toEqual(['crm-a', 'crm-b']);
  });

  it('drops a rate bucket when an update removes the profile\'s rate_limit', () => {
    const store = new ApiStore();
    store.save(profile('crm-a', 'https://api.crm.example/v1', { rate_limit: { requests_per_second: 1 } }));
    expect(store.checkRateLimit('api.crm.example')).toBeNull();
    expect(store.checkRateLimit('api.crm.example')).not.toBeNull();
    store.save(profile('crm-a', 'https://api.crm.example/v1'));
    expect(store.checkRateLimit('api.crm.example')).toBeNull();
    expect(store.checkRateLimit('api.crm.example')).toBeNull();
  });

  it('keeps refusing a vault-slot collision at boot, unlike a shared host', () => {
    const store = new ApiStore();
    expect(store.register(profile('x-y', 'https://api.one.example/v1'))).toBe(true);
    // `x-y` and `x_y` derive the same slot; marking cannot make that safe.
    expect(store.register(profile('x_y', 'https://api.two.example/v1'))).toBe(false);
    expect(store.get('x_y')).toBeUndefined();
  });
});

describe('ApiStore — grant record projections', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function makeCs(): ConnectionStore {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-apigrant-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return new ConnectionStore(engine);
  }

  afterEach(() => {
    for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const oauthProfile = (over: Partial<ApiProfile> = {}): ApiProfile => ({
    id: 'crm-api',
    name: 'CRM',
    base_url: 'https://api.crm.example/v1',
    description: 'CRM API',
    auth: {
      type: 'oauth2',
      vault_keys: ['CRM_CLIENT_ID', 'CRM_CLIENT_SECRET'],
      oauth: { token_url: 'https://api.crm.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'CRM_CLIENT_ID', client_secret_key: 'CRM_CLIENT_SECRET' },
    },
    ...over,
  });

  it('projects a revoked grant into connections.status, and a live one as active', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save(oauthProfile());
    expect(cs.get('crm-api')?.status).toBe('active');
    store.save(oauthProfile({ oauth_grant: { state: 'revoked', revoked_fp: '0123456789abcdef', revoked_at: '2026-09-22T00:00:00.000Z' } }));
    expect(cs.get('crm-api')?.status).toBe('revoked');
  });

  it('never reads the status column back: the record in config_json is the one writer', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save(oauthProfile());
    // A column that disagrees with the record changes nothing on load.
    const row = cs.get('crm-api');
    cs.upsert({ ...row!, status: 'revoked' });
    const booted = new ApiStore();
    booted.loadFromConnections(cs);
    expect(booted.get('crm-api')?.oauth_grant).toBeUndefined();
  });

  it('does not project a revocation for a profile that is no longer oauth2', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    // The oauth block is left over from before; the type decides.
    const leftover = oauthProfile().auth!.oauth!;
    store.save({ ...oauthProfile({ oauth_grant: { state: 'revoked' } }), auth: { type: 'bearer', vault_keys: ['CRM_KEY'], oauth: leftover } });
    expect(cs.get('crm-api')?.status).toBe('active');
  });

  it('does not project a revocation for an oauth2 profile moved to client credentials — the attach lets it through', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    const base = oauthProfile({ oauth_grant: { state: 'revoked' } });
    store.save({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, grant_type: 'client_credentials' } } });
    expect(cs.get('crm-api')?.status).toBe('active');
  });

  it('lists only string entries of vault_keys in the trail', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save({ ...oauthProfile(), auth: { type: 'bearer', vault_keys: [5, 'CRM_KEY'] as unknown as string[] } });
    expect(cs.get('crm-api')?.vaultKeys).toEqual(['CRM_KEY']);
  });

  it('lists what the attach reads from an array-like vault_keys: its first two entries', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save({ ...oauthProfile(), auth: { type: 'basic', basic_format: 'user_pass_split', vault_keys: { 0: 'CRM_USER', 1: 'CRM_PASS', 2: 'CRM_UNREAD' } as unknown as string[] } });
    expect(cs.get('crm-api')?.vaultKeys).toEqual(['CRM_USER', 'CRM_PASS']);
  });

  it('lists the derived token names in the trail only for an oauth2 profile', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save({ ...oauthProfile(), auth: { type: 'bearer', vault_keys: ['CRM_KEY'] } });
    expect(cs.get('crm-api')?.vaultKeys).toEqual(['CRM_KEY']);
  });

  it('does not count the profile itself as "another profile" when the purge runs before it left the store', () => {
    const store = new ApiStore();
    store.register(oauthProfile({ oauth_grant: { written: [{ name: 'CRM_API_ACCESS_TOKEN', fp: tokenFingerprint('at-1') }] } }));
    const values: Record<string, string> = { CRM_API_ACCESS_TOKEN: 'at-1' };
    const vault = {
      resolve: (n: string) => values[n] ?? null,
      deleteSecret: (n: string) => { const had = n in values; delete values[n]; return had; },
    } as unknown as import('../types/index.js').SecretStoreLike;
    const purge = purgeRecordedTokens(store, store.get('crm-api')!, vault);
    expect(purge.removed).toEqual(['CRM_API_ACCESS_TOKEN']);
  });

  it('lists a basic profile\'s username and password keys in the trail', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save({ ...oauthProfile(), auth: { type: 'basic', basic_format: 'user_pass_split', username_key: 'CRM_USER', password_key: 'CRM_PASS' } });
    expect([...(cs.get('crm-api')?.vaultKeys ?? [])].sort()).toEqual(['CRM_PASS', 'CRM_USER']);
  });

  it('does not throw on a neighbour whose vault_keys is not an array', () => {
    const store = new ApiStore();
    store.register(oauthProfile({ oauth_grant: { written: [{ name: 'CRM_API_ACCESS_TOKEN', fp: tokenFingerprint('at-1') }] } }));
    store.register({ ...oauthProfile(), id: 'broken', base_url: 'https://broken.example/v1', auth: { type: 'bearer', vault_keys: {} as unknown as string[] } });
    const values: Record<string, string> = { CRM_API_ACCESS_TOKEN: 'at-1' };
    const vault = {
      resolve: (n: string) => values[n] ?? null,
      deleteSecret: (n: string) => { const had = n in values; delete values[n]; return had; },
    } as unknown as import('../types/index.js').SecretStoreLike;
    const gone = store.get('crm-api')!;
    store.unregister('crm-api');
    expect(purgeRecordedTokens(store, gone, vault).removed).toEqual(['CRM_API_ACCESS_TOKEN']);
  });

  it('names a caller-chosen access-token slot in the purge trail', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save(oauthProfile({ oauth_grant: { written: [{ name: 'CRM_CUSTOM_TOKEN', fp: tokenFingerprint('v') }] } }));
    expect(cs.get('crm-api')?.vaultKeys).toContain('CRM_CUSTOM_TOKEN');
  });
});
