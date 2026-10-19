import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, type ApiProfile } from './api-store.js';

/**
 * The hosts of each grant, as snapshots (PRD connection-attribution A4). A snapshot is the
 * grant's full host set; it is written at the mint, on a save that changes the set, and by the
 * boot recompute where the set moved or a snapshot is missing — and nowhere else.
 */
describe('grant host snapshots', () => {
  let dir: string;
  let db: EngineDb;
  let conn: ConnectionStore;
  let ledger: GrantLedger;
  let store: ApiStore;

  const profile = (id: string, over: Partial<ApiProfile> = {}): ApiProfile => ({
    id, name: id, base_url: `https://api.${id}.example/v1`, description: 'd',
    auth: { type: 'bearer', vault_keys: [`${id.toUpperCase()}_KEY`] },
    ...over,
  });
  const grantOf = (id: string): string => store.get(id)!.oauth_grant!.grant_id!;
  const snapshots = (grantId: string): string[][] => ledger.hostsHistory(grantId).map((s) => s.hosts);
  const rows = (): number => (db.getDb().prepare('SELECT COUNT(*) n FROM connection_grant_hosts').get() as { n: number }).n;
  const wire = (): void => {
    store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-grant-hosts-'));
    db = new EngineDb(join(dir, 'engine.db'));
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
    wire();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the mint writes the grant\'s full host set: the base host and the token endpoint\'s', () => {
    expect(store.save(profile('shop', {
      auth: { type: 'oauth2', vault_keys: [], oauth: { grant_type: 'refresh_token', client_id_key: 'C_ID', token_url: 'https://auth.shop.example/token' } },
    })).ok).toBe(true);
    expect(snapshots(grantOf('shop'))).toEqual([['api.shop.example', 'auth.shop.example']]);
  });

  it('a save that leaves the hosts as they are writes no snapshot', () => {
    store.save(profile('shop'));
    const before = rows();
    expect(store.save(profile('shop', { description: 'changed', base_url: 'https://api.shop.example/v2' })).ok).toBe(true);
    expect(rows()).toBe(before);
    expect(snapshots(grantOf('shop'))).toEqual([['api.shop.example']]);
  });

  it('a save that moves the base host mints, and the new grant starts with its own snapshot; the old one keeps its', () => {
    store.save(profile('shop'));
    const old = grantOf('shop');
    expect(store.save(profile('shop', { base_url: 'https://api.shop-eu.example/v1' })).ok).toBe(true);
    const next = grantOf('shop');
    expect(next).not.toBe(old);
    expect(snapshots(old)).toEqual([['api.shop.example']]);
    expect(snapshots(next)).toEqual([['api.shop-eu.example']]);
  });

  it('a snapshot that failed to write does not fail the save, and the boot recompute writes it', () => {
    const spy = vi.spyOn(ledger, 'recordHosts').mockImplementationOnce(() => { throw new Error('disk full'); });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(store.save(profile('shop')).ok).toBe(true);
    stderr.mockRestore();
    spy.mockRestore();
    expect(snapshots(grantOf('shop'))).toEqual([]);
    expect(store.recomputeGrantHosts()).toBe(1);
    expect(snapshots(grantOf('shop'))).toEqual([['api.shop.example']]);
  });

  it('the boot recompute appends a full snapshot where the set moved, and a second run writes nothing', () => {
    store.save(profile('shop'));
    const g = grantOf('shop');
    // A snapshot that no longer matches what the profile names now, as after a preset moved.
    db.getDb().prepare("UPDATE connection_grant_hosts SET hosts_json = '[\"old.shop.example\"]' WHERE grant_id = ?").run(g);
    expect(store.recomputeGrantHosts()).toBe(1);
    expect(snapshots(g)).toEqual([['old.shop.example'], ['api.shop.example']]);
    expect(store.recomputeGrantHosts()).toBe(0);
  });

  it('a grant the ledger records for another connection gets no snapshot, at a write or at the recompute', () => {
    store.save(profile('crm'));
    const crmGrant = grantOf('crm');
    const before = rows();
    // A profile row that carries crm's grant, as a copied file would; loaded without the backfill.
    conn.upsert({ ...conn.get('crm')!, id: 'shop', configJson: JSON.stringify({ ...profile('shop'), oauth_grant: { grant_id: crmGrant } }) });
    wire();
    expect(store.get('shop')?.oauth_grant?.grant_id).toBe(crmGrant);
    // A save that keeps the grant writes the row again.
    expect(store.save(profile('shop', { description: 'changed' })).ok).toBe(true);
    expect(store.get('shop')?.oauth_grant?.grant_id).toBe(crmGrant);
    expect(store.recomputeGrantHosts()).toBe(0);
    expect(rows()).toBe(before);
    expect(snapshots(crmGrant)).toEqual([['api.crm.example']]);
  });

  it('keeps the snapshots indexed by grant', () => {
    const cols = (db.getDb().prepare("SELECT name FROM pragma_index_info('idx_connection_grant_hosts_grant')").all() as { name: string }[]).map((r) => r.name);
    expect(cols).toEqual(['grant_id']);
  });

  it('records a set once whatever its order or duplicates', () => {
    expect(ledger.recordHosts('g-1', ['b.example', 'a.example', 'b.example'])).toBe(true);
    expect(ledger.recordHosts('g-1', ['a.example', 'b.example'])).toBe(false);
    expect(ledger.latestHosts('g-1')).toBe('["a.example","b.example"]');
  });
});
