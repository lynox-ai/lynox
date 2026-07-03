import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore, type ApiProfile } from './api-store.js';

describe('ApiStore ⇄ connections projection (Foundation Rework v2 — S4b)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function makeCs(): { cs: ConnectionStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-apiconn-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return { cs: new ConnectionStore(engine), engine };
  }

  function apisDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-apis-'));
    tmpDirs.push(dir);
    return dir;
  }

  /** A rich v2 profile exercising every serialized field. schema_version=2 so
   *  migrateV1Profile is a no-op → the round-trip must be byte-faithful. */
  function richProfile(over: Partial<ApiProfile> = {}): ApiProfile {
    return {
      id: 'stripe',
      name: 'Stripe',
      base_url: 'https://api.stripe.com',
      description: 'Payments API',
      auth: {
        type: 'oauth2',
        oauth: {
          token_url: 'https://api.stripe.com/oauth/token',
          grant_type: 'client_credentials',
          client_id_key: 'STRIPE_CLIENT_ID',
          client_secret_key: 'STRIPE_CLIENT_SECRET',
        },
        vault_keys: ['STRIPE_REFRESH'],
      },
      rate_limit: { requests_per_second: 25 },
      endpoints: [{ method: 'GET', path: '/v1/charges', description: 'List charges' }],
      guidelines: ['Use idempotency keys'],
      avoid: ['Do not poll'],
      notes: ['Cursor pagination'],
      response_shape: { kind: 'reduce', include: ['data[].id'], max_array_items: 10 },
      concurrency: { parallel_ok: true, max_in_flight: 5 },
      output_volume: 'medium',
      cost: { model: 'per_call', rate_usd: 0 },
      provenance: { source: 'openapi', source_url: 'https://stripe.com/openapi.json', schema_version: 2 },
      ...over,
    };
  }

  afterEach(() => {
    for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
    for (const d of tmpDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('save → loadFromConnections round-trips a rich profile byte-faithfully', () => {
    const { cs } = makeCs();
    const w = new ApiStore();
    w.setConnectionStore(cs);
    const p = richProfile();
    expect(w.save(p)).toBe(true); // isNew

    // A fresh store projecting from connections reconstructs the exact profile.
    const r = new ApiStore();
    expect(r.loadFromConnections(cs)).toBe(1);
    expect(r.get('stripe')).toEqual(p);
    // and the hostname hot-path index is rebuilt.
    expect(r.getByHostname('api.stripe.com')?.id).toBe('stripe');
  });

  it('save derives vault_keys from auth.vault_keys + oauth key fields', () => {
    const { cs } = makeCs();
    const w = new ApiStore();
    w.setConnectionStore(cs);
    w.save(richProfile());
    const keys = cs.get('stripe')?.vaultKeys ?? [];
    expect([...keys].sort()).toEqual(['STRIPE_CLIENT_ID', 'STRIPE_CLIENT_SECRET', 'STRIPE_REFRESH']);
  });

  it('save stores kind=api, direction=outbound, subject_id=null', () => {
    const { cs } = makeCs();
    const w = new ApiStore();
    w.setConnectionStore(cs);
    w.save(richProfile());
    const row = cs.get('stripe');
    expect(row?.kind).toBe('api');
    expect(row?.direction).toBe('outbound');
    expect(row?.subjectId).toBeNull();
  });

  it('save returns false on update (existing profile)', () => {
    const { cs } = makeCs();
    const w = new ApiStore();
    w.setConnectionStore(cs);
    expect(w.save(richProfile())).toBe(true);
    expect(w.save(richProfile({ description: 'Updated' }))).toBe(false);
    expect(cs.count('api')).toBe(1);
    // fresh projection reflects the update.
    const r = new ApiStore();
    r.loadFromConnections(cs);
    expect(r.get('stripe')?.description).toBe('Updated');
  });

  it('remove deletes from memory AND connections', () => {
    const { cs } = makeCs();
    const w = new ApiStore();
    w.setConnectionStore(cs);
    w.save(richProfile());
    expect(w.remove('stripe')).toBe(true);
    expect(w.get('stripe')).toBeUndefined();
    expect(cs.get('stripe')).toBeUndefined();
    expect(w.remove('stripe')).toBe(false);
  });

  it('importFromDirectoryIfNeeded imports flat JSON, writes a sentinel, keeps files, and is idempotent', () => {
    const { cs } = makeCs();
    const dir = apisDir();
    writeFileSync(join(dir, 'stripe.json'), JSON.stringify(richProfile()), { mode: 0o600 });
    writeFileSync(join(dir, 'plausible.json'), JSON.stringify(richProfile({ id: 'plausible', name: 'Plausible', base_url: 'https://plausible.io' })), { mode: 0o600 });

    const w = new ApiStore();
    expect(w.importFromDirectoryIfNeeded(dir, cs)).toBe(2);
    expect(cs.count('api')).toBe(2);
    expect(existsSync(join(dir, '.imported-to-connections'))).toBe(true);
    // flat files preserved as backup (not deleted).
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).sort()).toEqual(['plausible.json', 'stripe.json']);

    // Second call: sentinel guard → no-op, no double-import.
    expect(w.importFromDirectoryIfNeeded(dir, cs)).toBe(0);
    expect(cs.count('api')).toBe(2);
  });

  it('importFromDirectoryIfNeeded skips (no clobber) when connections already has api rows', () => {
    const { cs } = makeCs();
    const dir = apisDir();
    // connections already authoritative (e.g. re-provision) with a DIFFERENT row.
    const seed = new ApiStore();
    seed.setConnectionStore(cs);
    seed.save(richProfile({ id: 'preexisting', name: 'Pre', base_url: 'https://pre.example' }));
    writeFileSync(join(dir, 'stripe.json'), JSON.stringify(richProfile()), { mode: 0o600 });

    const w = new ApiStore();
    expect(w.importFromDirectoryIfNeeded(dir, cs)).toBe(0); // count>0 guard
    expect(cs.count('api')).toBe(1); // stripe NOT imported
    expect(cs.get('stripe')).toBeUndefined();
    // sentinel written so we stop re-scanning.
    expect(existsSync(join(dir, '.imported-to-connections'))).toBe(true);
  });

  it('importFromDirectoryIfNeeded is a no-op on a fresh install (no dir / no files)', () => {
    const { cs } = makeCs();
    const w = new ApiStore();
    // absent dir
    expect(w.importFromDirectoryIfNeeded(join(tmpdir(), 'lynox-does-not-exist-xyz'), cs)).toBe(0);
    // empty dir → no sentinel (cheap re-check next boot), nothing imported
    const dir = apisDir();
    expect(w.importFromDirectoryIfNeeded(dir, cs)).toBe(0);
    expect(existsSync(join(dir, '.imported-to-connections'))).toBe(false);
    expect(cs.count('api')).toBe(0);
  });

  it('degraded (no ConnectionStore): save/remove fall back to the flat-JSON directory', () => {
    const dir = apisDir();
    const w = new ApiStore(); // no setConnectionStore
    expect(w.save(richProfile(), dir)).toBe(true);
    expect(existsSync(join(dir, 'stripe.json'))).toBe(true);
    // fallback delete removes the file.
    expect(w.remove('stripe', dir)).toBe(true);
    expect(existsSync(join(dir, 'stripe.json'))).toBe(false);
  });

  it('degraded: remove deletes an on-disk orphan not registered in memory (pre-S4b behaviour)', () => {
    const dir = apisDir();
    const w = new ApiStore(); // no connStore
    // A profile file dropped into apisDir after boot — never registered in memory.
    writeFileSync(join(dir, 'orphan.json'), JSON.stringify(richProfile({ id: 'orphan' })), { mode: 0o600 });
    expect(w.get('orphan')).toBeUndefined();
    expect(w.remove('orphan', dir)).toBe(true); // disk-only orphan delete
    expect(existsSync(join(dir, 'orphan.json'))).toBe(false);
  });

  it('round-trips custom_endpoint_ack faithfully — the BYOK consent gate survives the projection', () => {
    const { cs } = makeCs();
    const w = new ApiStore();
    w.setConnectionStore(cs);
    const ack = { accepted: true as const, hosts: ['custom.example.com'], accepted_at: '2026-07-03T00:00:00.000Z' };
    w.save(richProfile({ base_url: 'https://custom.example.com', custom_endpoint_ack: ack }));
    const r = new ApiStore();
    r.loadFromConnections(cs);
    expect(r.get('stripe')?.custom_endpoint_ack).toEqual(ack);
  });

  it('save collects oauth.refresh_token_key into vault_keys', () => {
    const { cs } = makeCs();
    const w = new ApiStore();
    w.setConnectionStore(cs);
    w.save(richProfile({
      auth: { type: 'oauth2', oauth: { grant_type: 'refresh_token', refresh_token_key: 'RT_KEY' }, vault_keys: [] },
    }));
    expect(cs.get('stripe')?.vaultKeys).toContain('RT_KEY');
  });

  it('loadFromConnections skips a connection row missing required profile fields', () => {
    const { cs, engine } = makeCs();
    // A malformed api row: config_json with no base_url/description.
    engine.getDb().prepare(
      "INSERT INTO connections (id, kind, name, config_json) VALUES ('broken','api','Broken','{}')",
    ).run();
    const r = new ApiStore();
    expect(r.loadFromConnections(cs)).toBe(0); // skipped, not loaded
    expect(r.get('broken')).toBeUndefined();
  });

  it('importFromDirectoryIfNeeded skips a file with an invalid profile id', () => {
    const { cs } = makeCs();
    const dir = apisDir();
    writeFileSync(join(dir, 'good.json'), JSON.stringify(richProfile({ id: 'good' })), { mode: 0o600 });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(richProfile({ id: 'Bad ID!' })), { mode: 0o600 });
    const w = new ApiStore();
    expect(w.importFromDirectoryIfNeeded(dir, cs)).toBe(1); // only the valid id
    expect(cs.get('good')).toBeDefined();
    expect(cs.count('api')).toBe(1);
  });

  it('importFromDirectoryIfNeeded skips a malformed JSON file and imports the rest', () => {
    const { cs } = makeCs();
    const dir = apisDir();
    writeFileSync(join(dir, 'good.json'), JSON.stringify(richProfile({ id: 'good' })), { mode: 0o600 });
    writeFileSync(join(dir, 'corrupt.json'), '{ not valid json', { mode: 0o600 });
    const w = new ApiStore();
    expect(w.importFromDirectoryIfNeeded(dir, cs)).toBe(1);
    expect(cs.get('good')).toBeDefined();
    // the import still completes + marks done (the corrupt file is a permanent skip).
    expect(existsSync(join(dir, '.imported-to-connections'))).toBe(true);
  });
});
