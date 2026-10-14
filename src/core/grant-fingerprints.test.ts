import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, accessTokenKey, refreshTokenKey, watchedNames, type ApiProfile } from './api-store.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';

/**
 * Credential fingerprints on the grant (PRD connection-attribution A2 (2)(2')(4)(5)). A grant
 * records which credential each watched name held when it was minted; a credential the epoch
 * did not record starts a new one. The vault here is a Map read the way the engine's reader
 * reads it.
 */
describe('grant fingerprints', () => {
  let dir: string;
  let db: EngineDb;
  let conn: ConnectionStore;
  let ledger: GrantLedger;
  let store: ApiStore;
  const vault = new Map<string, string>();
  // Stands in for the engine's keyed hash: any stable function of the value will do here, and
  // `key` stands in for the vault key it is taken under.
  let key = 'k';
  const fp = (v: string): string => (v === '' ? '' : `${key}-${tokenFingerprint(v)}`);
  // The plain token fingerprint the foreign tokens record — told apart from the keyed one here.
  const tok = (v: string): string => (v === '' ? '' : `t-${tokenFingerprint(v)}`);

  const bearer = (id: string, key = `${id.toUpperCase()}_KEY`): ApiProfile => ({
    id, name: id, base_url: `https://${id}.example`, description: 'd',
    auth: { type: 'bearer', vault_keys: [key] },
  });
  const oauth = (id: string): ApiProfile => ({
    id, name: id, base_url: `https://${id}.example`, description: 'd',
    auth: { type: 'oauth2', vault_keys: [], oauth: { grant_type: 'refresh_token', client_id_key: 'C_ID', client_secret_key: 'C_SECRET', token_url: `https://${id}.example/token` } },
  });
  const grantOf = (id: string): string | undefined => store.get(id)?.oauth_grant?.grant_id;
  const fpsOf = (id: string): Record<string, string> | undefined => store.get(id)?.oauth_grant?.fingerprints;
  const foreignOf = (id: string): string[] | undefined => store.get(id)?.oauth_grant?.foreign;
  const reasonOf = (id: string): string | undefined => ledger.get(grantOf(id)!)?.reason;
  const wire = (withFingerprinter = true): void => {
    store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
    if (withFingerprinter) store.setFingerprinter({
      keyCheck: `check-${key}`, ofValue: fp, tokenOfValue: tok,
      read: (name, hash) => hash(vault.get(name) ?? ''),
    });
  };
  /** A renewal's save, as `fetch_token`'s success path makes it: what it presented, replaced and wrote. */
  const renew = (id: string, presented: string, newAccess: string, rotated?: string): void => {
    const replacedAccessFp = store.currentFingerprint(accessTokenKey(id));
    vault.set(accessTokenKey(id), newAccess);
    const wrote = [accessTokenKey(id)];
    if (rotated !== undefined) { vault.set(refreshTokenKey(id), rotated); wrote.push(refreshTokenKey(id)); }
    const current = store.get(id)!;
    const saved = store.save(current, undefined,
      { exchange: { presentedRefreshFp: store.valueFingerprint(presented)!, presentedRefreshTokenFp: store.tokenFingerprint(presented)!, replacedAccessFp, wrote } });
    expect(saved.ok).toBe(true);
  };
  /** The OAuth callback's save: tokens stored, then a consent save carrying the stored refresh token or none. */
  const consent = (id: string, access: string, refresh: string | null): void => {
    vault.set(accessTokenKey(id), access);
    if (refresh !== null) vault.set(refreshTokenKey(id), refresh);
    const current = store.get(id)!;
    const written = [{ name: accessTokenKey(id), fp: fp(access) }, ...(refresh !== null ? [{ name: refreshTokenKey(id), fp: fp(refresh) }] : [])];
    // Merged like the callback merges: an earlier entry for a name this exchange did not write stays.
    const kept = (current.oauth_grant?.written ?? []).filter((w) => !written.some((x) => x.name === w.name));
    store.save({ ...current, oauth_grant: { ...current.oauth_grant, written: [...kept, ...written] } }, undefined,
      { newConsent: true, consentRefresh: refresh });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-grant-fp-'));
    db = new EngineDb(join(dir, 'engine.db'));
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
    vault.clear();
    key = 'k';
    wire();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('watches every configured name, plus the derived token pair of an OAuth profile', () => {
    expect(watchedNames(bearer('shop'))).toEqual(['SHOP_KEY']);
    expect(watchedNames({ ...oauth('crm'), auth: { ...oauth('crm').auth!, username_key: 'U', password_key: 'P', oauth: { ...oauth('crm').auth!.oauth!, refresh_token_key: 'R' } } }))
      .toEqual(['CRM_ACCESS_TOKEN', 'CRM_REFRESH_TOKEN', 'C_ID', 'C_SECRET', 'P', 'R', 'U'].sort());
  });

  it('a mint records each watched name as the vault holds it, an empty one as empty', () => {
    vault.set('SHOP_KEY', 'k1');
    store.save(bearer('shop'));
    expect(fpsOf('shop')).toEqual({ SHOP_KEY: fp('k1') });
    store.save(bearer('crm'));
    expect(fpsOf('crm')).toEqual({ CRM_KEY: '' });
  });

  it('a save that keeps the grant keeps its fingerprints, whatever the caller passed', () => {
    vault.set('SHOP_KEY', 'k1');
    store.save(bearer('shop'));
    const current = store.get('shop')!;
    store.save({ ...current, description: 'x', oauth_grant: { ...current.oauth_grant, fingerprints: { SHOP_KEY: 'forged' } } });
    expect(fpsOf('shop')).toEqual({ SHOP_KEY: fp('k1') });
  });

  describe('boot comparison', () => {
    it('a grant minted before fingerprints mints its baseline, and the next check mints nothing', () => {
      vault.set('SHOP_KEY', 'k1');
      store.save(bearer('shop'));
      const current = store.get('shop')!;
      // As a grant from before fingerprints were recorded: grant, no fingerprints.
      const { fingerprints: _dropped, ...rest } = current.oauth_grant!;
      conn.upsert({ id: 'shop', kind: 'api', name: 'shop', subjectId: null, direction: 'outbound', configJson: JSON.stringify({ ...current, id: undefined, name: undefined, oauth_grant: rest }), vaultKeys: [], status: 'active' });
      wire();
      const g = grantOf('shop');
      expect(store.checkFingerprints()).toBe(1);
      expect(grantOf('shop')).not.toBe(g);
      expect(reasonOf('shop')).toBe('baseline');
      expect(fpsOf('shop')).toEqual({ SHOP_KEY: fp('k1') });
      expect(store.checkFingerprints()).toBe(0);
    });

    it('a grant missing the fingerprint of one watched name mints its baseline too', () => {
      store.save(bearer('shop'));
      const current = store.get('shop')!;
      conn.upsert({ id: 'shop', kind: 'api', name: 'shop', subjectId: null, direction: 'outbound', configJson: JSON.stringify({ ...current, id: undefined, name: undefined, oauth_grant: { ...current.oauth_grant, fingerprints: {} } }), vaultKeys: [], status: 'active' });
      wire();
      expect(store.checkFingerprints()).toBe(1);
      expect(reasonOf('shop')).toBe('baseline');
    });

    it('a grant minted with fingerprints is not re-minted while the vault holds what it recorded', () => {
      vault.set('SHOP_KEY', 'k1');
      store.save(bearer('shop'));
      const g = grantOf('shop');
      wire();
      expect(store.checkFingerprints()).toBe(0);
      expect(grantOf('shop')).toBe(g);
    });

    it('a recorded empty fingerprint is a value: still empty mints nothing, filled mints', () => {
      store.save(bearer('shop'));
      expect(store.checkFingerprints()).toBe(0);
      vault.set('SHOP_KEY', 'k1');
      expect(store.checkFingerprints()).toBe(1);
      expect(reasonOf('shop')).toBe('secret-changed');
    });

    it('a credential changed outside the engine mints, and the new grant records it', () => {
      vault.set('SHOP_KEY', 'k1');
      store.save(bearer('shop'));
      const g = grantOf('shop');
      vault.set('SHOP_KEY', 'k2');
      expect(store.checkFingerprints()).toBe(1);
      expect(grantOf('shop')).not.toBe(g);
      expect(reasonOf('shop')).toBe('secret-changed');
      expect(fpsOf('shop')).toEqual({ SHOP_KEY: fp('k2') });
      expect(store.checkFingerprints()).toBe(0);
    });

    it('a fingerprint record of the wrong shape counts as none, and mints the baseline', () => {
      store.save(bearer('shop'));
      const current = store.get('shop')!;
      conn.upsert({ id: 'shop', kind: 'api', name: 'shop', subjectId: null, direction: 'outbound', configJson: JSON.stringify({ ...current, id: undefined, name: undefined, oauth_grant: { ...current.oauth_grant, fingerprints: { SHOP_KEY: 7 } } }), vaultKeys: [], status: 'active' });
      wire();
      expect(store.checkFingerprints()).toBe(1);
      expect(reasonOf('shop')).toBe('baseline');
    });

    it('a grant the backfill reissues records fingerprints, so the comparison after it mints nothing', () => {
      vault.set('SHOP_KEY', 'k1');
      const { id, name, ...rest } = bearer('shop');
      conn.upsert({ id, kind: 'api', name, subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
      wire();
      expect(store.backfillGrants()).toBe(1);
      expect(fpsOf('shop')).toEqual({ SHOP_KEY: fp('k1') });
      expect(store.checkFingerprints()).toBe(0);
    });

    it('fingerprints taken under another vault key mint once per profile, as a rekey, and keep the foreign tokens', () => {
      vault.set('C_ID', 'cid');
      vault.set('C_SECRET', 'csec');
      store.save(oauth('crm'));
      consent('crm', 'acc-1', 'ref-1');
      consent('crm', 'acc-B', null);
      store.save(bearer('shop'));
      key = 'k2';
      wire();
      expect(store.checkFingerprints()).toBe(2);
      expect(reasonOf('crm')).toBe('rekey');
      expect(reasonOf('shop')).toBe('rekey');
      expect(fpsOf('crm')).toMatchObject({ CRM_REFRESH_TOKEN: fp('ref-1') });
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      expect(store.checkFingerprints()).toBe(0);
      // The previous account's token is still not this epoch's.
      const g = grantOf('crm');
      renew('crm', 'ref-1', 'acc-B2');
      expect(grantOf('crm')).not.toBe(g);
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('a grant with fingerprints but no key check mints its baseline', () => {
      store.save(bearer('shop'));
      const current = store.get('shop')!;
      const { fingerprint_check: _dropped, ...rest } = current.oauth_grant!;
      conn.upsert({ id: 'shop', kind: 'api', name: 'shop', subjectId: null, direction: 'outbound', configJson: JSON.stringify({ ...current, id: undefined, name: undefined, oauth_grant: rest }), vaultKeys: [], status: 'active' });
      wire();
      expect(store.checkFingerprints()).toBe(1);
      expect(reasonOf('shop')).toBe('baseline');
      expect(store.get('shop')!.oauth_grant!.fingerprint_check).toBe('check-k');
    });

    it('a credential removed outside the engine mints as well', () => {
      vault.set('SHOP_KEY', 'k1');
      store.save(bearer('shop'));
      vault.delete('SHOP_KEY');
      expect(store.checkFingerprints()).toBe(1);
    });
  });

  describe('a credential the user stores', () => {
    it('mints for every connection that watches the name, and only those', () => {
      store.save(bearer('shop', 'SHARED_KEY'));
      store.save(bearer('crm', 'SHARED_KEY'));
      store.save(bearer('other'));
      const before = { shop: grantOf('shop'), crm: grantOf('crm'), other: grantOf('other') };
      vault.set('SHARED_KEY', 'v2');
      expect(store.secretWritten('SHARED_KEY')).toBe(2);
      expect(grantOf('shop')).not.toBe(before.shop);
      expect(grantOf('crm')).not.toBe(before.crm);
      expect(grantOf('other')).toBe(before.other);
      expect(reasonOf('shop')).toBe('secret-write');
      expect(fpsOf('shop')).toEqual({ SHARED_KEY: fp('v2') });
    });

    it('a name no connection watches mints nothing', () => {
      store.save(bearer('shop'));
      expect(store.secretWritten('UNRELATED')).toBe(0);
    });
  });

  describe('token exchange', () => {
    const connected = (id: string): void => {
      vault.set('C_ID', 'cid');
      vault.set('C_SECRET', 'csec');
      store.save(oauth(id));
      consent(id, 'acc-1', 'ref-1');
    };

    it('a renewal on the recorded tokens keeps the grant and moves the fingerprints it wrote', () => {
      connected('crm');
      const g = grantOf('crm');
      renew('crm', 'ref-1', 'acc-2', 'ref-2');
      expect(grantOf('crm')).toBe(g);
      expect(fpsOf('crm')).toMatchObject({ CRM_ACCESS_TOKEN: fp('acc-2'), CRM_REFRESH_TOKEN: fp('ref-2') });
      // The next renewal presents the rotated token and replaces the new access value: still this epoch.
      renew('crm', 'ref-2', 'acc-3');
      expect(grantOf('crm')).toBe(g);
      // And the boot finds what the renewals recorded.
      expect(store.checkFingerprints()).toBe(0);
    });

    it('after a consent without a refresh token, a renewal presenting the previous account\'s token mints', () => {
      connected('crm');
      // Account B consents; the answer carries no refresh token, so account A's stays in the slot.
      consent('crm', 'acc-B', null);
      const g = grantOf('crm');
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      renew('crm', 'ref-1', 'acc-B2');
      expect(grantOf('crm')).not.toBe(g);
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('the previous account\'s leftover is not "changed" at the boot, and not adopted by it', () => {
      connected('crm');
      consent('crm', 'acc-B', null);
      const g = grantOf('crm');
      expect(store.checkFingerprints()).toBe(0);
      expect(grantOf('crm')).toBe(g);
      renew('crm', 'ref-1', 'acc-B2');
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('a later mint carries the leftover forward as foreign, so a renewal on it still mints', () => {
      connected('crm');
      consent('crm', 'acc-B', null);
      // Another watched name is written — a new grant, which reads every slot again.
      vault.set('C_ID', 'cid-2');
      expect(store.secretWritten('C_ID')).toBe(1);
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      // And a configuration change, as re-enabling the grant type after such a consent is.
      store.save({ ...store.get('crm')!, auth: { ...store.get('crm')!.auth!, oauth: { ...store.get('crm')!.auth!.oauth!, scope: 'more' } } });
      expect(reasonOf('crm')).toBe('credentials');
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      const g = grantOf('crm');
      renew('crm', 'ref-1', 'acc-B2');
      expect(grantOf('crm')).not.toBe(g);
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('the exchange that mints adopts the token it presented, so the next renewal on it does not mint again', () => {
      connected('crm');
      consent('crm', 'acc-B', null);
      renew('crm', 'ref-1', 'acc-A2');
      const g = grantOf('crm');
      expect(foreignOf('crm')).toBeUndefined();
      renew('crm', 'ref-1', 'acc-A3');
      expect(grantOf('crm')).toBe(g);
    });

    it('a consent marks a configured refresh slot it did not write as foreign, so a renewal from it mints', () => {
      vault.set('C_ID', 'cid');
      vault.set('MY_REFRESH', 'ref-A');
      store.save({ ...oauth('crm'), auth: { ...oauth('crm').auth!, oauth: { ...oauth('crm').auth!.oauth!, refresh_token_key: 'MY_REFRESH' } } });
      consent('crm', 'acc-B', 'ref-B');
      expect(fpsOf('crm')).toMatchObject({ MY_REFRESH: fp('ref-A'), CRM_REFRESH_TOKEN: fp('ref-B') });
      expect(foreignOf('crm')).toEqual([tok('ref-A')]);
      const g = grantOf('crm');
      renew('crm', 'ref-A', 'acc-A2');
      expect(grantOf('crm')).not.toBe(g);
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('a name an exchange writes for one connection is a new credential for every other connection reading it', () => {
      connected('crm');
      store.save(bearer('mirror', 'CRM_OUT'));
      const g = grantOf('mirror');
      // An exchange whose token went to a name of the caller's choosing (`output_secret_name`).
      vault.set('CRM_OUT', 'acc-2');
      store.save(store.get('crm')!, undefined, { exchange: { presentedRefreshFp: fp('ref-1'), presentedRefreshTokenFp: tok('ref-1'), wrote: ['CRM_OUT'] } });
      expect(grantOf('mirror')).not.toBe(g);
      expect(reasonOf('mirror')).toBe('engine-write');
    });

    describe('a profile that reads another OAuth profile\'s token', () => {
      const mirrored = (): string | undefined => {
        connected('crm');
        store.save(bearer('mirror', accessTokenKey('crm')));
        return grantOf('mirror');
      };

      it('follows that profile\'s renewals: keeps its grant and records the renewed value', () => {
        const g = mirrored();
        renew('crm', 'ref-1', 'acc-2');
        expect(grantOf('mirror')).toBe(g);
        expect(fpsOf('mirror')).toEqual({ [accessTokenKey('crm')]: fp('acc-2') });
        // Stored, not only held: a restart reads the same.
        wire();
        expect(fpsOf('mirror')).toEqual({ [accessTokenKey('crm')]: fp('acc-2') });
        expect(store.checkFingerprints()).toBe(0);
        expect(grantOf('mirror')).toBe(g);
      });

      it('mints when that profile consents again: another account may be behind it', () => {
        const g = mirrored();
        consent('crm', 'acc-B', 'ref-B');
        expect(grantOf('mirror')).not.toBe(g);
        expect(reasonOf('mirror')).toBe('engine-write');
      });

      it('mints when the user stores a value under that name', () => {
        const g = mirrored();
        vault.set(accessTokenKey('crm'), 'acc-user');
        expect(store.secretWritten(accessTokenKey('crm'))).toBe(2);
        expect(grantOf('mirror')).not.toBe(g);
        expect(reasonOf('mirror')).toBe('secret-write');
      });

      it('mints when the value changed outside the engine', () => {
        const g = mirrored();
        vault.set(accessTokenKey('crm'), 'acc-outside');
        expect(store.checkFingerprints()).toBe(2);
        expect(grantOf('mirror')).not.toBe(g);
        expect(reasonOf('mirror')).toBe('secret-changed');
      });

      it('mints at a renewal when it had recorded another value there than the renewed profile', () => {
        const g = mirrored();
        // The reader's grant recorded a value the renewed profile's epoch never held.
        const current = store.get('mirror')!;
        conn.upsert({ id: 'mirror', kind: 'api', name: 'mirror', subjectId: null, direction: 'outbound', configJson: JSON.stringify({ ...current, id: undefined, name: undefined, oauth_grant: { ...current.oauth_grant, fingerprints: { [accessTokenKey('crm')]: fp('acc-elsewhere') } } }), vaultKeys: [], status: 'active' });
        wire();
        renew('crm', 'ref-1', 'acc-2');
        expect(grantOf('mirror')).not.toBe(g);
        expect(reasonOf('mirror')).toBe('engine-write');
      });

      it('keeps watching its own key under a name an OAuth profile created later derives', () => {
        vault.set('GITHUB_ACCESS_TOKEN', 'pat-1');
        store.save(bearer('github-rest', 'GITHUB_ACCESS_TOKEN'));
        store.save(oauth('github'));
        const g = grantOf('github-rest');
        expect(fpsOf('github-rest')).toEqual({ GITHUB_ACCESS_TOKEN: fp('pat-1') });
        vault.set('GITHUB_ACCESS_TOKEN', 'pat-2');
        expect(store.secretWritten('GITHUB_ACCESS_TOKEN')).toBe(2);
        expect(grantOf('github-rest')).not.toBe(g);
        const g2 = grantOf('github-rest');
        vault.set('GITHUB_ACCESS_TOKEN', 'pat-3');
        expect(store.checkFingerprints()).toBe(2);
        expect(grantOf('github-rest')).not.toBe(g2);
      });
    });

    it('only tokens become foreign: a consent never marks a client secret, a client id or an API key', () => {
      vault.set('C_ID', 'cid');
      vault.set('C_SECRET', 'csec');
      vault.set('CRM_API_KEY', 'api-key');
      store.save({ ...oauth('crm'), auth: { ...oauth('crm').auth!, vault_keys: ['CRM_API_KEY'] } });
      consent('crm', 'acc-1', 'ref-1');
      consent('crm', 'acc-B', null);
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
    });

    it('a refresh slot a profile configures for a password or a key is never marked: its value may not be a token', () => {
      vault.set('C_ID', 'cid');
      vault.set('SHOP_PASSWORD', 'hunter2');
      store.save({ ...bearer('shop'), auth: { type: 'basic', vault_keys: [], username_key: 'SHOP_USER', password_key: 'SHOP_PASSWORD' } });
      store.save({ ...oauth('crm'), auth: { ...oauth('crm').auth!, oauth: { ...oauth('crm').auth!.oauth!, refresh_token_key: 'SHOP_PASSWORD' } } });
      consent('crm', 'acc-B', 'ref-B');
      expect(foreignOf('crm')).toBeUndefined();
      // The same for a name the profile itself reads as a key.
      vault.set('CRM_KEY', 'key-1');
      store.save({ ...oauth('own'), auth: { ...oauth('own').auth!, vault_keys: ['CRM_KEY'], oauth: { ...oauth('own').auth!.oauth!, refresh_token_key: 'CRM_KEY' } } });
      consent('own', 'acc-O', 'ref-O');
      expect(foreignOf('own')).toBeUndefined();
    });

    it('the derived refresh name is not marked either when another profile reads it as a password', () => {
      connected('crm');
      store.save({ ...bearer('shop'), auth: { type: 'basic', vault_keys: [], username_key: 'SHOP_USER', password_key: refreshTokenKey('crm') } });
      consent('crm', 'acc-B', null);
      expect(foreignOf('crm')).toBeUndefined();
    });

    it('a mint without a fingerprinter keeps the foreign tokens, so the leftover is still foreign once fingerprints return', () => {
      connected('crm');
      consent('crm', 'acc-B', null);
      wire(false);
      const current = store.get('crm')!;
      store.save({ ...current, auth: { ...current.auth!, oauth: { ...current.auth!.oauth!, scope: 'more' } } });
      expect(reasonOf('crm')).toBe('credentials');
      expect(fpsOf('crm')).toBeUndefined();
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      store.save({ ...store.get('crm')!, description: 'edited' });
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      wire();
      expect(store.checkFingerprints()).toBe(1);
      expect(reasonOf('crm')).toBe('baseline');
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      const g = grantOf('crm');
      renew('crm', 'ref-1', 'acc-B2');
      expect(grantOf('crm')).not.toBe(g);
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('a Basic profile never records a foreign token, even on a name that held one', () => {
      vault.set('C_ID', 'cid');
      vault.set('SHARED_RT', 'ref-A');
      store.save({ ...oauth('crm'), auth: { ...oauth('crm').auth!, oauth: { ...oauth('crm').auth!.oauth!, refresh_token_key: 'SHARED_RT' } } });
      consent('crm', 'acc-B', 'ref-B');
      expect(foreignOf('crm')).toEqual([tok('ref-A')]);
      // The same profile turned into a Basic one that reads its password from that name.
      const current = store.get('crm')!;
      store.save({ ...current, auth: { type: 'basic', vault_keys: [], username_key: 'U', password_key: 'SHARED_RT' } });
      expect(reasonOf('crm')).toBe('credentials');
      expect(foreignOf('crm')).toBeUndefined();
      expect(store.checkFingerprints()).toBe(0);
      expect(foreignOf('crm')).toBeUndefined();
    });

    it('a leftover stays foreign by its value, wherever the profile reads it from next', () => {
      connected('crm');
      consent('crm', 'acc-B', null);
      // The previous account's token, also under a name the profile is then pointed at.
      vault.set('MY_REFRESH', 'ref-1');
      const current = store.get('crm')!;
      store.save({ ...current, auth: { ...current.auth!, oauth: { ...current.auth!.oauth!, refresh_token_key: 'MY_REFRESH' } } });
      expect(reasonOf('crm')).toBe('credentials');
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      const g = grantOf('crm');
      renew('crm', 'ref-1', 'acc-A2');
      expect(grantOf('crm')).not.toBe(g);
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('a leftover no token slot holds any more leaves the foreign set at the next mint', () => {
      connected('crm');
      consent('crm', 'acc-B', null);
      vault.set(refreshTokenKey('crm'), 'ref-B');
      expect(store.secretWritten(refreshTokenKey('crm'))).toBe(1);
      expect(foreignOf('crm')).toBeUndefined();
    });

    it('a renewal that replaces an access value the epoch never recorded mints', () => {
      connected('crm');
      const g = grantOf('crm');
      // A consent whose save was refused: its tokens landed, the grant did not move.
      vault.set(accessTokenKey('crm'), 'acc-B');
      renew('crm', 'ref-1', 'acc-B2');
      expect(grantOf('crm')).not.toBe(g);
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('a renewal presenting a refresh token the epoch never recorded mints', () => {
      connected('crm');
      const g = grantOf('crm');
      vault.set(refreshTokenKey('crm'), 'ref-foreign');
      renew('crm', 'ref-foreign', 'acc-2');
      expect(grantOf('crm')).not.toBe(g);
    });

    it('a consent records the access and refresh token it stored', () => {
      connected('crm');
      expect(fpsOf('crm')).toMatchObject({ CRM_ACCESS_TOKEN: fp('acc-1'), CRM_REFRESH_TOKEN: fp('ref-1') });
      expect(reasonOf('crm')).toBe('consent');
    });

    it('an exchange on a grant without fingerprints mints', () => {
      connected('crm');
      const current = store.get('crm')!;
      const { fingerprints: _dropped, ...rest } = current.oauth_grant!;
      conn.upsert({ id: 'crm', kind: 'api', name: 'crm', subjectId: null, direction: 'outbound', configJson: JSON.stringify({ ...current, id: undefined, name: undefined, oauth_grant: rest }), vaultKeys: [], status: 'active' });
      wire();
      const g = grantOf('crm');
      renew('crm', 'ref-1', 'acc-2');
      expect(grantOf('crm')).not.toBe(g);
    });

    it('an exchange that presents nothing and writes elsewhere, on a grant without fingerprints, mints too', () => {
      connected('crm');
      const current = store.get('crm')!;
      const { fingerprints: _dropped, ...rest } = current.oauth_grant!;
      conn.upsert({ id: 'crm', kind: 'api', name: 'crm', subjectId: null, direction: 'outbound', configJson: JSON.stringify({ ...current, id: undefined, name: undefined, oauth_grant: rest }), vaultKeys: [], status: 'active' });
      wire();
      const g = grantOf('crm');
      // Nothing to compare — no refresh token presented, no derived slot overwritten — and still
      // no record of what this epoch held: that is not "known".
      store.save(store.get('crm')!, undefined, { exchange: { presentedRefreshFp: null, wrote: ['CRM_CUSTOM_TOKEN'] } });
      expect(grantOf('crm')).not.toBe(g);
      expect(reasonOf('crm')).toBe('exchange');
    });

    it('a save that keeps the grant keeps the foreign tokens and the key check', () => {
      connected('crm');
      consent('crm', 'acc-B', null);
      const g = grantOf('crm');
      store.save({ ...store.get('crm')!, description: 'edited' });
      expect(grantOf('crm')).toBe(g);
      expect(foreignOf('crm')).toEqual([tok('ref-1')]);
      expect(store.checkFingerprints()).toBe(0);
    });

    it('a profile reading another OAuth profile\'s derived refresh name as its own refresh slot still watches it', () => {
      connected('crm');
      const sub = { ...oauth('sub'), auth: { ...oauth('sub').auth!, oauth: { ...oauth('sub').auth!.oauth!, refresh_token_key: refreshTokenKey('crm') } } };
      expect(store.save(sub).ok).toBe(true);
      expect(fpsOf('sub')).toMatchObject({ [refreshTokenKey('crm')]: fp('ref-1') });
      const g = grantOf('sub');
      renew('sub', 'ref-1', 'sub-acc-2');
      expect(grantOf('sub')).toBe(g);
    });

    it('a save that is not an exchange never moves the fingerprints', () => {
      connected('crm');
      const before = fpsOf('crm');
      vault.set(accessTokenKey('crm'), 'acc-elsewhere');
      store.save({ ...store.get('crm')!, description: 'edited' });
      expect(fpsOf('crm')).toEqual(before);
    });
  });
});
