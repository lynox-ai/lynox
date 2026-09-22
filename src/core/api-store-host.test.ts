import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore, type ApiProfile } from './api-store.js';

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

  it('names a caller-chosen access-token slot in the purge trail', () => {
    const cs = makeCs();
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save(oauthProfile({ oauth_grant: { written_keys: ['CRM_CUSTOM_TOKEN'] } }));
    expect(cs.get('crm-api')?.vaultKeys).toContain('CRM_CUSTOM_TOKEN');
  });
});
