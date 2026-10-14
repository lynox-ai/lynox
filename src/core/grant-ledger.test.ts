import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  // One row per component of the credential tuple, each changing ONLY that component, so a
  // tuple that drops any one of them fails its own row.
  type Auth = NonNullable<ApiProfile['auth']>;
  const baseAuth: Auth = {
    type: 'oauth2', vault_keys: ['SHOP_KEY'], basic_format: 'user_pass_split',
    username_key: 'SHOP_USER', password_key: 'SHOP_PASS', header_name: 'X-Key', query_param: 'key',
    oauth: { grant_type: 'refresh_token', client_id_key: 'C_ID', client_secret_key: 'C_SECRET', refresh_token_key: 'C_REFRESH' },
  };
  it.each<[string, (a: Auth) => Auth]>([
    ['auth type', (a) => ({ ...a, type: 'bearer' })],
    ['vault keys', (a) => ({ ...a, vault_keys: ['OTHER_KEY'] })],
    ['basic format', (a) => ({ ...a, basic_format: 'pre_encoded_b64' })],
    ['username key', (a) => ({ ...a, username_key: 'OTHER_USER' })],
    ['password key', (a) => ({ ...a, password_key: 'OTHER_PASS' })],
    ['header name', (a) => ({ ...a, header_name: 'X-Other' })],
    ['query param', (a) => ({ ...a, query_param: 'token' })],
    ['grant type', (a) => ({ ...a, oauth: { ...a.oauth, grant_type: 'client_credentials' } })],
    ['client id key', (a) => ({ ...a, oauth: { ...a.oauth, client_id_key: 'OTHER_ID' } })],
    ['client secret key', (a) => ({ ...a, oauth: { ...a.oauth, client_secret_key: 'OTHER_SECRET' } })],
    ['refresh token key', (a) => ({ ...a, oauth: { ...a.oauth, refresh_token_key: 'OTHER_REFRESH' } })],
  ])('a save that changes only the %s mints a new grant (reason credentials)', (_label, change) => {
    store.save(profile('shop', { auth: baseAuth }));
    const g = grantOf('shop');
    store.save(profile('shop', { auth: change(baseAuth) }));
    const next = grantOf('shop');
    expect(next).not.toBe(g);
    expect(ledger.get(next!)).toMatchObject({ connection_id: 'shop', reason: 'credentials' });
    expect(ledger.get(g!)).toBeDefined(); // the old grant stays in the ledger
  });

  // Where the credentials go and what their token may do: the fields that end a release
  // (`credentialBearing`) start a new grant too, one row each.
  it.each<[string, (a: Auth) => Auth]>([
    ['token endpoint', (a) => ({ ...a, oauth: { ...a.oauth, token_url: 'https://issuer.example/token' } })],
    ['scope', (a) => ({ ...a, oauth: { ...a.oauth, scope: 'read write' } })],
    ['audience', (a) => ({ ...a, oauth: { ...a.oauth, audience: 'https://api.example' } })],
    ['preset', (a) => ({ ...a, oauth: { ...a.oauth, preset_id: 'bexio' } })],
    ['preset parameters', (a) => ({ ...a, oauth: { ...a.oauth, preset_params: { shop: 'other' } } })],
    ['body format', (a) => ({ ...a, oauth: { ...a.oauth, body_format: 'json' } })],
  ])('a save that changes only the %s mints a new grant (reason credentials)', (_label, change) => {
    store.save(profile('shop', { auth: baseAuth }));
    const g = grantOf('shop');
    store.save(profile('shop', { auth: change(baseAuth) }));
    expect(grantOf('shop')).not.toBe(g);
    expect(ledger.get(grantOf('shop')!)).toMatchObject({ reason: 'credentials' });
  });

  it('a save that moves base_url to another origin mints; one that changes only its path keeps the grant', () => {
    store.save(profile('shop', { base_url: 'https://shop.example/v1' }));
    const g = grantOf('shop');
    store.save(profile('shop', { base_url: 'https://shop.example/v2' }));
    expect(grantOf('shop')).toBe(g);
    store.save(profile('shop', { base_url: 'https://shop.example:8443/v2' }));
    expect(grantOf('shop')).not.toBe(g);
  });

  it('the same preset parameters in another key order are the same configuration', () => {
    const withParams = (preset_params: Record<string, string>): Partial<ApiProfile> =>
      ({ auth: { ...baseAuth, oauth: { ...baseAuth.oauth, preset_params } } });
    store.save(profile('shop', withParams({ a: '1', b: '2' })));
    const g = grantOf('shop');
    store.save(profile('shop', withParams({ b: '2', a: '1' })));
    expect(grantOf('shop')).toBe(g);
  });

  it('an empty vault-key list and no list are the same configuration', () => {
    store.save(profile('shop', { auth: { type: 'bearer', vault_keys: [] } }));
    const g = grantOf('shop');
    store.save(profile('shop', { auth: { type: 'bearer' } }));
    expect(grantOf('shop')).toBe(g);
  });

  it('a write that throws during a mint leaves memory and ledger as they were', () => {
    store.save(profile('shop'));
    const g = grantOf('shop');
    const upsert = conn.upsert.bind(conn);
    conn.upsert = () => { throw new Error('disk full'); };
    expect(() => store.save(profile('shop'), undefined, { newConsent: true })).toThrow('disk full');
    conn.upsert = upsert;
    expect(grantOf('shop')).toBe(g);
    expect(ledger.forConnection('shop')).toHaveLength(1);
    // A later plain save stores the recorded grant, not one the ledger never saw.
    store.save(profile('shop', { description: 'later' }));
    expect(storedGrantOf('shop')).toBe(g);
  });

  it('a write that throws during a mint keeps a profile in the host conflict the boot left, so the host stays refused', () => {
    for (const id of ['alpha', 'beta']) {
      const { name, ...rest } = profile(id, { base_url: 'https://shared.example' });
      conn.upsert({ id, kind: 'api', name, subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
    }
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      wire();
      expect(store.getHostConflict('shared.example')).toEqual(['alpha', 'beta']);
      const upsert = conn.upsert.bind(conn);
      conn.upsert = () => { throw new Error('disk full'); };
      expect(() => store.save(store.get('alpha')!, undefined, { newConsent: true })).toThrow('disk full');
      conn.upsert = upsert;
    } finally { stderr.mockRestore(); }
    expect(store.get('alpha')).toBeDefined();
    expect(store.getHostConflict('shared.example')).toEqual(['alpha', 'beta']);
    expect(store.getByHostname('shared.example')).toBeUndefined();
  });

  it('a write that throws during a mint that moved the host leaves the new host free', () => {
    store.save(profile('shop', { base_url: 'https://old.example' }));
    const upsert = conn.upsert.bind(conn);
    conn.upsert = () => { throw new Error('disk full'); };
    expect(() => store.save(profile('shop', { base_url: 'https://new.example' }), undefined, { newConsent: true })).toThrow('disk full');
    conn.upsert = upsert;
    expect(store.getByHostname('old.example')?.id).toBe('shop');
    expect(store.getByHostname('new.example')).toBeUndefined();
    expect(store.save(profile('other', { base_url: 'https://new.example' })).ok).toBe(true);
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

    it('replaces a grant the ledger records for another connection, also when no one else holds it', () => {
      store.save(profile('shop'));
      const g = grantOf('shop')!;
      store.remove('shop');
      seed({ ...profile('other'), oauth_grant: { grant_id: g } });
      wire();
      expect(store.backfillGrants()).toBe(1);
      expect(grantOf('other')).not.toBe(g);
      expect(ledger.get(grantOf('other')!)).toMatchObject({ connection_id: 'other', reason: 'backfill' });
    });

    it('replaces a grant of this connection that a later one superseded', () => {
      store.save(profile('shop'));
      const old = grantOf('shop')!;
      store.save(store.get('shop')!, undefined, { newConsent: true });
      const current = grantOf('shop')!;
      // The row comes back carrying the superseded grant, as a restored backup or a copy would.
      seed({ ...profile('shop'), oauth_grant: { grant_id: old } });
      wire();
      expect(store.backfillGrants()).toBe(1);
      const next = grantOf('shop')!;
      expect([old, current]).not.toContain(next);
      expect(ledger.get(next)).toMatchObject({ connection_id: 'shop', reason: 'backfill' });
      expect(store.backfillGrants()).toBe(0);
    });

    it('a profile whose write throws gets no grant in memory, and the others still get theirs', () => {
      seed(profile('one'));
      seed(profile('two'));
      wire();
      const upsert = conn.upsert.bind(conn);
      conn.upsert = (row) => { if (row.id === 'one') throw new Error('disk full'); upsert(row); };
      const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        expect(store.backfillGrants()).toBe(1);
      } finally {
        errors.mockRestore();
        conn.upsert = upsert;
      }
      expect(grantOf('one')).toBeUndefined();
      expect(ledger.forConnection('one')).toHaveLength(0);
      expect(ledger.get(grantOf('two')!)).toMatchObject({ connection_id: 'two' });
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
    expect(v.v).toBe(34);
    expect(ledger.get(g)).toMatchObject({ connection_id: 'shop' });
  });
});
