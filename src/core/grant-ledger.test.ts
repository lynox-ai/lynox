import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, credentialTuple, type ApiProfile } from './api-store.js';

/**
 * The grant ledger and where it mints (PRD connection-attribution A1, A2 (1)(2)(3)(6)).
 * A grant is one epoch of a connection; everything here asks whether a save starts a new
 * one exactly when the PRD says, and keeps the stored one otherwise.
 */
describe('grant ledger', () => {
  let dir: string;
  let db: EngineDb;
  let conn: ConnectionStore;
  let ledger: GrantLedger;
  let store: ApiStore;

  const profile = (id: string, over: Partial<ApiProfile> = {}): ApiProfile => ({
    id, name: id, base_url: `https://${id}.example`, description: 'd',
    auth: { type: 'bearer', vault_keys: [`${id.toUpperCase().replace(/-/g, '_')}_KEY`] },
    ...over,
  });
  const grantOf = (id: string): string | undefined => store.get(id)?.oauth_grant?.grant_id;
  const storedGrantOf = (id: string): string | undefined => {
    const row = conn.get(id);
    return row ? (JSON.parse(row.configJson) as ApiProfile).oauth_grant?.grant_id : undefined;
  };
  const wire = (): void => {
    store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-grant-ledger-'));
    db = new EngineDb(join(dir, 'engine.db'));
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
    wire();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a new profile gets a grant, recorded in the ledger with its connection', () => {
    expect(store.save(profile('shop')).ok).toBe(true);
    const g = grantOf('shop');
    expect(g).toMatch(/^[0-9a-f-]{36}$/);
    expect(storedGrantOf('shop')).toBe(g);
    expect(ledger.get(g!)).toMatchObject({ connection_id: 'shop', kind: 'api', reason: 'new' });
  });

  it('a save that leaves the credentials as they are keeps the grant — whatever grant the caller passed', () => {
    store.save(profile('shop'));
    const g = grantOf('shop');
    store.save({ ...profile('shop', { description: 'changed' }), oauth_grant: { grant_id: 'forged' } });
    expect(grantOf('shop')).toBe(g);
    expect(storedGrantOf('shop')).toBe(g);
    store.save(profile('shop', { description: 'again' })); // a caller passing no record at all
    expect(grantOf('shop')).toBe(g);
    expect(ledger.forConnection('shop')).toHaveLength(1);
  });

  it('a renewal-shaped save (the record spread, `written` extended) keeps the grant', () => {
    store.save(profile('shop', { auth: { type: 'oauth2', vault_keys: [], oauth: { grant_type: 'refresh_token', client_id_key: 'C_ID' } } }));
    const g = grantOf('shop');
    const current = store.get('shop')!;
    store.save({ ...current, oauth_grant: { ...current.oauth_grant, written: [{ name: 'SHOP_ACCESS_TOKEN', fp: 'abc' }] } });
    expect(grantOf('shop')).toBe(g);
  });

  it.each([
    ['another vault key', { auth: { type: 'bearer' as const, vault_keys: ['OTHER_KEY'] } }],
    ['another auth type', { auth: { type: 'header' as const, vault_keys: ['SHOP_KEY'], header_name: 'X-Key' } }],
    ['another header name', { auth: { type: 'bearer' as const, vault_keys: ['SHOP_KEY'], header_name: 'X-Other' } }],
  ])('a save with %s mints a new grant (reason credentials)', (_label, over) => {
    store.save(profile('shop'));
    const g = grantOf('shop');
    store.save(profile('shop', over));
    const next = grantOf('shop');
    expect(next).not.toBe(g);
    expect(ledger.get(next!)).toMatchObject({ connection_id: 'shop', reason: 'credentials' });
    expect(ledger.get(g!)).toBeDefined(); // the old grant stays in the ledger
  });

  it('a save flipping the OAuth grant type mints', () => {
    const oauth = (grant_type: 'client_credentials' | 'refresh_token'): Partial<ApiProfile> =>
      ({ auth: { type: 'oauth2', vault_keys: [], oauth: { grant_type, client_id_key: 'C_ID' } } });
    store.save(profile('shop', oauth('client_credentials')));
    const g = grantOf('shop');
    store.save(profile('shop', oauth('refresh_token')));
    expect(grantOf('shop')).not.toBe(g);
  });

  it('a new consent mints even when nothing else changed', () => {
    store.save(profile('shop'));
    const g = grantOf('shop');
    store.save(store.get('shop')!, undefined, { newConsent: true });
    const next = grantOf('shop');
    expect(next).not.toBe(g);
    expect(ledger.get(next!)).toMatchObject({ reason: 'consent' });
  });

  it('a refused save leaves no ledger row behind', () => {
    const refused = store.save(profile('bad id!'));
    expect(refused.ok).toBe(false);
    expect(ledger.forConnection('bad id!')).toHaveLength(0);
  });

  it('a deleted connection\'s grants stay in the ledger and still name it', () => {
    store.save(profile('shop'));
    const g = grantOf('shop')!;
    store.remove('shop');
    expect(conn.get('shop')).toBeUndefined();
    expect(ledger.get(g)).toMatchObject({ connection_id: 'shop' });
  });

  describe('boot backfill', () => {
    const seed = (p: ApiProfile): void => {
      // Written straight into `connections`, the way a pre-ledger engine or an import left it.
      const { id, name, ...rest } = p;
      conn.upsert({ id, kind: 'api', name, subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
    };

    it('gives a profile without a grant one, and a second boot mints nothing', () => {
      seed(profile('shop'));
      wire();
      expect(store.backfillGrants()).toBe(1);
      const g = grantOf('shop');
      expect(ledger.get(g!)).toMatchObject({ reason: 'backfill', connection_id: 'shop' });
      expect(storedGrantOf('shop')).toBe(g);
      wire();
      expect(store.backfillGrants()).toBe(0);
      expect(grantOf('shop')).toBe(g);
    });

    it('replaces a grant the ledger does not know (a file copied with its record)', () => {
      seed({ ...profile('shop'), oauth_grant: { grant_id: 'from-another-engine' } });
      wire();
      expect(store.backfillGrants()).toBe(1);
      expect(grantOf('shop')).not.toBe('from-another-engine');
      expect(ledger.get(grantOf('shop')!)).toBeDefined();
    });

    it('splits two profiles sharing a grant: the one the ledger names keeps it', () => {
      store.save(profile('shop'));
      const g = grantOf('shop')!;
      seed({ ...profile('copy'), oauth_grant: { grant_id: g } });
      wire();
      expect(store.backfillGrants()).toBe(1);
      expect(grantOf('shop')).toBe(g);
      expect(grantOf('copy')).not.toBe(g);
      expect(ledger.get(grantOf('copy')!)).toMatchObject({ reason: 'split', connection_id: 'copy' });
      wire();
      expect(store.backfillGrants()).toBe(0);
    });

    it('when the ledger names neither sharer, both get a fresh grant', () => {
      seed({ ...profile('one'), oauth_grant: { grant_id: 'shared-unknown' } });
      seed({ ...profile('two'), oauth_grant: { grant_id: 'shared-unknown' } });
      wire();
      expect(store.backfillGrants()).toBe(2);
      expect(grantOf('one')).not.toBe(grantOf('two'));
      wire();
      expect(store.backfillGrants()).toBe(0);
    });
  });

  it('the credential tuple ignores what an exchange writes and the token names derived from the id', () => {
    const base = profile('shop', { auth: { type: 'oauth2', vault_keys: [], oauth: { grant_type: 'refresh_token', client_id_key: 'C_ID' } } });
    const renewed: ApiProfile = { ...base, oauth_grant: { written: [{ name: 'CUSTOM_OUT', fp: 'x' }] }, auth: { ...base.auth!, oauth: { ...base.auth!.oauth, token_expires_at: 123 } } };
    expect(credentialTuple(renewed)).toBe(credentialTuple(base));
  });

  it('the full erasure empties the ledger', () => {
    store.save(profile('shop'));
    db.deleteAllData();
    expect(ledger.forConnection('shop')).toHaveLength(0);
  });

  it('the migration is idempotent across a reopen', () => {
    store.save(profile('shop'));
    const g = grantOf('shop')!;
    db.close();
    db = new EngineDb(join(dir, 'engine.db'));
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
    const v = db.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(33);
    expect(ledger.get(g)).toMatchObject({ connection_id: 'shop' });
  });
});
