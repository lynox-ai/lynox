import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { AuditLog } from './audit-log.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import * as erasure from './connection-erasure.js';
import { coveredGrantSet } from './connection-erasure.js';

/**
 * A save over a profile the boot held back reads its stored grant as a save over a registered one
 * does: it keeps the grant and its fingerprints where nothing calls for a mint, and a new consent
 * ends a provider's erasure still held on it — by the same rule of who may (the owner; a mandate
 * only on the grant it connected). Before, the held-back profile counted as new: every save minted
 * afresh, and the owner's reconnect left the erasure of the refused grant pending, to run once its
 * hold ended.
 *
 * Each case runs on a registered profile and on a held-back one, and expects the same outcome.
 */

const DAY = 24 * 3600 * 1000;
const T0 = new Date(Date.now() - DAY);
const HELPER: RequestPrincipal = { kind: 'mandate', email: 'helper@example.com', mandateId: 'm-1' };
const STRANGER: RequestPrincipal = { kind: 'mandate', email: 'other@example.com', mandateId: 'm-2' };

/** An OAuth profile; with `ownSlot` its client secret sits under its own refresh name, which
 *  the boot holds back (`clientSlotOnDerivedName`). */
const shop = (ownSlot = false): ApiProfile => ({
  id: 'my_shop', name: 'shop', base_url: 'https://shop.example/v1', description: 'd',
  auth: { type: 'oauth2', oauth: { token_url: 'https://shop.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'MY_SHOP_CID', client_secret_key: ownSlot ? 'MY_SHOP_REFRESH_TOKEN' : 'MY_SHOP_CSECRET' } },
});

let dir: string;
let db: EngineDb;
let store: ApiStore;
let ledger: GrantLedger;
let restore: Array<() => void>;
// The vault as the fingerprinter reads it (a stand-in for the engine's keyed hash, as in
// grant-fingerprints.test.ts).
const vault = new Map<string, string>();
const fp = (v: string): string => (v === '' ? '' : `k-${tokenFingerprint(v)}`);

const boot = (): void => {
  const conn = new ConnectionStore(db);
  ledger = new GrantLedger(db.getDb());
  store = new ApiStore();
  store.loadFromConnections(conn);
  store.setConnectionStore(conn);
  store.setGrantLedger(ledger);
  store.setAuditLog(new AuditLog(db.getDb()));
  store.setFingerprinter({ keyCheck: 'check-k', ofValue: fp, tokenOfValue: (v) => (v === '' ? '' : `t-${tokenFingerprint(v)}`), read: (name, hash) => hash(vault.get(name) ?? '') });
};

beforeEach(() => {
  vault.clear();
  vault.set('MY_SHOP_CID', 'cid');
  vault.set('MY_SHOP_CSECRET', 'secret');
  dir = mkdtempSync(join(tmpdir(), 'lynox-held-back-grant-'));
  db = new EngineDb(join(dir, 'engine.db'));
  boot();
  restore = [erasure.setProviderErasureForTests(true), erasure.setErasureOnDeleteForTests(true)];
});
afterEach(() => {
  for (const r of restore.reverse()) r();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const grantOf = (): string => store.storedProfile('my_shop')!.oauth_grant!.grant_id!;
const connectAs = (actor: RequestPrincipal, profile: ApiProfile = store.storedProfile('my_shop')!): boolean => {
  const grant = actor.kind === 'mandate'
    ? { connected_by: `mandate:${actor.email}`, connected_mandate_id: actor.mandateId, state: 'connected' as const }
    : { connected_by: 'owner', state: 'connected' as const };
  return store.save({ ...profile, oauth_grant: grant }, undefined, { newConsent: true, actor }).ok;
};
const erasureOf = (grant: string): string | undefined =>
  erasure.erasureRecords(db.getDb(), 'my_shop').filter((r) => r.cause === 'provider_revoked').find((r) => r.revokedGrant === grant)?.historyState;

/** Rewrites the stored row the way `edit` says, then boots again: what the next start reads. */
const editStoredAndBoot = (edit: (cfg: ApiProfile) => void): void => {
  const row = db.getDb().prepare("SELECT config_json FROM connections WHERE id = 'my_shop'").get() as { config_json: string };
  const cfg = JSON.parse(row.config_json) as ApiProfile;
  edit(cfg);
  db.getDb().prepare("UPDATE connections SET config_json = ? WHERE id = 'my_shop'").run(JSON.stringify(cfg));
  boot();
};
/** Boots again with the stored profile held back (its client secret on its own refresh name). */
const holdBack = (): void => {
  editStoredAndBoot((cfg) => { cfg.auth!.oauth!.client_secret_key = 'MY_SHOP_REFRESH_TOKEN'; });
  expect(store.get('my_shop')).toBeUndefined();
  expect(store.storedProfile('my_shop')).toBeDefined();
};

/** A connection `connector` made, which the provider then refused: its erasure is held. */
const refusedConnection = (connector: RequestPrincipal): string => {
  expect(store.save(shop()).ok).toBe(true);
  expect(connectAs(connector)).toBe(true);
  const g1 = grantOf();
  store.markRevokedWithRecord('my_shop', 'fp-refused', T0, true);
  expect(erasureOf(g1)).toBe('pending');
  return g1;
};

describe.each([
  ['registered', false],
  ['held back by the boot', true],
] as const)('a save over a %s profile', (_label, held) => {
  // The save that brings a held-back profile back carries the corrected configuration.
  const repaired = (): ApiProfile => ({ ...store.storedProfile('my_shop')!, auth: shop().auth });

  it('the owner\'s new consent ends the provider\'s erasure still held on the refused grant', () => {
    const g1 = refusedConnection(OWNER_PRINCIPAL);
    if (held) holdBack();
    expect(connectAs(OWNER_PRINCIPAL, repaired())).toBe(true);
    expect(grantOf()).not.toBe(g1);
    expect(erasureOf(g1)).toBe('cancelled');
  });

  it('the mandate that connected the refused grant ends its erasure', () => {
    const g1 = refusedConnection(HELPER);
    if (held) holdBack();
    expect(connectAs(HELPER, repaired())).toBe(true);
    expect(erasureOf(g1)).toBe('cancelled');
  });

  it('counter-case: another mandate\'s consent ends nothing', () => {
    const g1 = refusedConnection(HELPER);
    if (held) holdBack();
    expect(connectAs(STRANGER, repaired())).toBe(true);
    expect(erasureOf(g1)).toBe('pending');
  });

  it('counter-case: a mandate\'s consent does not end the erasure of a grant the owner connected', () => {
    const g1 = refusedConnection(OWNER_PRINCIPAL);
    if (held) holdBack();
    expect(connectAs(HELPER, repaired())).toBe(true);
    expect(erasureOf(g1)).toBe('pending');
  });

  /** Holds `my_shop` back by a cause outside its own configuration: a profile stored before it
   *  under the same slot (`my-shop`), which the save below has removed again. */
  const holdBackByRival = (): void => {
    const rival: ApiProfile = { id: 'my-shop', name: 'rival', base_url: 'https://rival.example/v1', description: 'd', auth: { type: 'bearer', vault_keys: ['RIVAL_KEY'] } };
    new ConnectionStore(db).upsert({ id: 'my-shop', kind: 'api', name: 'rival', subjectId: null, direction: null, configJson: JSON.stringify(rival), vaultKeys: ['RIVAL_KEY'], status: 'active' });
    db.getDb().prepare("UPDATE connections SET created_at = '2000-01-01 00:00:00' WHERE id = 'my-shop'").run();
    boot();
    expect(store.get('my_shop')).toBeUndefined();
    expect(store.remove('my-shop')).toBe(true);
  };

  it('a save with the same credentials, the vault unchanged, keeps the stored grant and its fingerprints', () => {
    expect(store.save(shop()).ok).toBe(true);
    expect(connectAs(OWNER_PRINCIPAL)).toBe(true);
    editStoredAndBoot((cfg) => { cfg.oauth_grant = { ...cfg.oauth_grant, foreign: ['t-held'] }; });
    const before = store.storedProfile('my_shop')!.oauth_grant!;
    expect(before.fingerprints).toBeDefined();
    if (held) holdBackByRival();
    expect(store.save(store.storedProfile('my_shop')!).ok).toBe(true);
    const grant = store.get('my_shop')!.oauth_grant!;
    expect(grant.grant_id).toBe(before.grant_id);
    expect(grant.fingerprints).toEqual(before.fingerprints);
    expect(grant.foreign).toEqual(['t-held']);
  });
});

describe('a save that brings a held-back profile back', () => {
  it('mints where the vault changed while it was held back, as the boot would have', () => {
    expect(store.save(shop()).ok).toBe(true);
    expect(connectAs(OWNER_PRINCIPAL)).toBe(true);
    const g1 = grantOf();
    vault.set('MY_SHOP_CSECRET', 'written-while-held');
    const rival: ApiProfile = { id: 'my-shop', name: 'rival', base_url: 'https://rival.example/v1', description: 'd', auth: { type: 'bearer', vault_keys: ['RIVAL_KEY'] } };
    new ConnectionStore(db).upsert({ id: 'my-shop', kind: 'api', name: 'rival', subjectId: null, direction: null, configJson: JSON.stringify(rival), vaultKeys: ['RIVAL_KEY'], status: 'active' });
    db.getDb().prepare("UPDATE connections SET created_at = '2000-01-01 00:00:00' WHERE id = 'my-shop'").run();
    boot();
    expect(store.remove('my-shop')).toBe(true);
    expect(store.save(store.storedProfile('my_shop')!).ok).toBe(true);
    expect(grantOf()).not.toBe(g1);
    expect(ledger.get(grantOf())?.reason).toBe('secret-changed');
  });

  it.each([
    ['without fingerprints', 'baseline', (cfg: ApiProfile) => { delete cfg.oauth_grant!.fingerprints; }],
    ['with fingerprints taken under another key', 'rekey', (cfg: ApiProfile) => { cfg.oauth_grant = { ...cfg.oauth_grant, fingerprint_check: 'check-old' }; }],
  ] as const)('a kept grant %s mints `%s`, as the boot would have', (_label, reason, carry) => {
    expect(store.save(shop()).ok).toBe(true);
    expect(connectAs(OWNER_PRINCIPAL)).toBe(true);
    const g1 = grantOf();
    editStoredAndBoot(carry);
    const rival: ApiProfile = { id: 'my-shop', name: 'rival', base_url: 'https://rival.example/v1', description: 'd', auth: { type: 'bearer', vault_keys: ['RIVAL_KEY'] } };
    new ConnectionStore(db).upsert({ id: 'my-shop', kind: 'api', name: 'rival', subjectId: null, direction: null, configJson: JSON.stringify(rival), vaultKeys: ['RIVAL_KEY'], status: 'active' });
    db.getDb().prepare("UPDATE connections SET created_at = '2000-01-01 00:00:00' WHERE id = 'my-shop'").run();
    boot();
    expect(store.get('my_shop')).toBeUndefined();
    expect(store.remove('my-shop')).toBe(true);
    expect(store.save(store.storedProfile('my_shop')!).ok).toBe(true);
    expect(grantOf()).not.toBe(g1);
    expect(ledger.get(grantOf())?.reason).toBe(reason);
  });

  // The boot backfills registered profiles only: a held-back one may carry no grant, or one the
  // ledger does not hold for it. Its return then starts the connection's line, so the erasure's
  // epoch has a beginning.
  // A row stored before the ledger, or imported, has no start of its own (`first_grant_id` NULL).
  it.each([
    ['no grant', (cfg: ApiProfile) => { delete cfg.oauth_grant; }],
    ['a grant the ledger does not know', (cfg: ApiProfile) => { cfg.oauth_grant = { ...cfg.oauth_grant, grant_id: '00000000-0000-4000-8000-000000000000' }; }],
    ['another connection\'s grant', (cfg: ApiProfile) => { cfg.oauth_grant = { ...cfg.oauth_grant, grant_id: ledger.mint('elsewhere', 'api', 'new') }; }],
    // Its own, but superseded: the ledger recorded a later grant for this id.
  ] as const)('with %s, mints `new` and gives the connection its epoch', (_label, carry) => {
    expect(store.save(shop()).ok).toBe(true);
    db.getDb().prepare("UPDATE connections SET first_grant_id = NULL WHERE id = 'my_shop'").run();
    editStoredAndBoot((cfg) => { carry(cfg); cfg.auth!.oauth!.client_secret_key = 'MY_SHOP_REFRESH_TOKEN'; });
    expect(store.get('my_shop')).toBeUndefined();
    expect(store.save(shop()).ok).toBe(true);
    const g = grantOf();
    expect(ledger.get(g)?.reason).toBe('new');
    boot();
    expect(coveredGrantSet(db.getDb(), 'my_shop')).toEqual([g]);
  });

  it('with a grant of its own a later one superseded, mints `new`, as the boot would have backfilled it', () => {
    expect(store.save(shop()).ok).toBe(true);
    editStoredAndBoot((cfg) => { ledger.mint('my_shop', 'api', 'consent'); cfg.auth!.oauth!.client_secret_key = 'MY_SHOP_REFRESH_TOKEN'; });
    expect(store.get('my_shop')).toBeUndefined();
    expect(store.save(shop()).ok).toBe(true);
    expect(ledger.get(grantOf())?.reason).toBe('new');
  });
});
