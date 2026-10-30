/**
 * A migration import drops every store connection's tokens and binding (`migration-import.ts`
 * step 5b, `ApiStore.stripStoreConnectionsOnImport`; PRD-SHOPIFY-CONTAINMENT-ERASURE Appendix B,
 * B10, AC11): in both stores, after a vault-only import, for a profile whose base was changed
 * away from its store, and on a self-hosted destination as on a managed one.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore, accessTokenKey, refreshTokenKey, type ApiProfile } from './api-store.js';
import { SecretVault } from './secret-vault.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter, type ImportVerification } from './migration-import.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { MANDATE_TAG_PREFIX } from './request-principal.js';
import { generateEphemeralKeypair, serializePublicKey, deserializePublicKey, deriveTransferKey } from './migration-crypto.js';

const SRC_KEY = 'source-vault-key-store-strip-2026';
const DST_KEY = 'dest-vault-key-store-strip-2026';
const MIGRATION_TOKEN = 'b'.repeat(64);

function storeProfile(id: string, over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id, name: id, base_url: 'https://acme.myshopify.com', description: 'store',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'acme' }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET', refresh_token_key: 'MY_REFRESH' } },
    custom_endpoint_ack: { accepted: true, hosts: ['acme.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
    oauth_grant: { origin: 'callback', state: 'connected', store_binding: 'f'.repeat(64), written: [{ name: accessTokenKey(id), fp: 'abcd' }] },
    ...over,
  } as ApiProfile;
}

const plainProfile: ApiProfile = {
  id: 'crm', name: 'CRM', base_url: 'https://api.crm.example.com', description: 'not a store',
  auth: { type: 'oauth2', oauth: { client_id_key: 'C_CID', client_secret_key: 'C_CSECRET' } },
  oauth_grant: { origin: 'callback', state: 'connected', written: [{ name: accessTokenKey('crm'), fp: 'beef' }] },
} as ApiProfile;

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'lynox-strip-')); dirs.push(d); return d; };

/** `apart`: each profile through a store of its own, for a state a save refuses and only older rows hold. */
function seedEngine(dir: string, key: string, profiles: ApiProfile[], apart = false): void {
  const engine = new EngineDb(join(dir, 'engine.db'), key);
  try {
    const shared = new ApiStore();
    shared.setConnectionStore(new ConnectionStore(engine));
    for (const p of profiles) {
      const store = apart ? new ApiStore() : shared;
      if (apart) store.setConnectionStore(new ConnectionStore(engine));
      const r = store.save(p);
      expect(r.ok, `${p.id}: ${JSON.stringify(r)}`).toBe(true);
    }
  } finally { engine.close(); }
}

function seedVault(dir: string, key: string, secrets: Record<string, string>): void {
  const vault = new SecretVault({ path: join(dir, 'vault.db'), masterKey: key });
  try { for (const [n, v] of Object.entries(secrets)) vault.set(n, v); } finally { vault.close(); }
}

function vaultNames(dir: string): string[] {
  const vault = new SecretVault({ path: join(dir, 'vault.db'), masterKey: DST_KEY });
  try { return vault.list().map((s) => (typeof s === 'string' ? s : s.name)).sort(); } finally { vault.close(); }
}

function readProfile(dir: string, id: string): ApiProfile | undefined {
  const engine = new EngineDb(join(dir, 'engine.db'), DST_KEY);
  try {
    const store = new ApiStore();
    store.loadFromConnections(new ConnectionStore(engine));
    return store.get(id);
  } finally { engine.close(); }
}

function migrate(srcDir: string, dstDir: string): ImportVerification {
  const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY });
  const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_KEY });
  const sh = importer.startHandshake(MIGRATION_TOKEN);
  const kp = generateEphemeralKeypair();
  const transferKey = deriveTransferKey(kp.privateKey, deserializePublicKey(sh.serverPubKey), Buffer.from(sh.challengeNonce, 'hex'));
  importer.completeHandshake(serializePublicKey(kp.publicKey));
  const { manifest, chunks } = exporter.export(transferKey);
  importer.setManifest(manifest);
  for (const c of chunks) importer.receiveChunk(c);
  const v = importer.restore();
  importer.cleanup();
  return v;
}

const SECRETS = {
  [accessTokenKey('shop-acme')]: 'shpat-a', [refreshTokenKey('shop-acme')]: 'shprt-a',
  S_CID: 'cid', S_CSECRET: 'csecret', MY_REFRESH: 'named-refresh',
  [accessTokenKey('ghost')]: 'shpat-orphan',
  [accessTokenKey('crm')]: 'crm-token', C_CID: 'ccid', C_CSECRET: 'ccsecret',
};

beforeEach(() => { vi.stubEnv('LYNOX_BILLING_TIER', ''); vi.stubEnv('LYNOX_MANAGED_MODE', ''); });
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('a migration import drops store connections', () => {
  it('both stores: the derived token slots, the binding and the written record go; the client pair and a named refresh slot stay', () => {
    const src = tmp(); const dst = tmp();
    seedEngine(src, SRC_KEY, [storeProfile('shop-acme'), plainProfile]);
    seedVault(src, SRC_KEY, SECRETS);
    const v = migrate(src, dst);
    expect(v.reconnectStores).toEqual(['shop-acme']);
    const names = vaultNames(dst);
    expect(names).not.toContain(accessTokenKey('shop-acme'));
    expect(names).not.toContain(refreshTokenKey('shop-acme'));
    for (const kept of ['S_CID', 'S_CSECRET', 'MY_REFRESH', accessTokenKey('ghost'), accessTokenKey('crm')]) expect(names).toContain(kept);
    const after = readProfile(dst, 'shop-acme');
    expect(after?.oauth_grant?.store_binding).toBeUndefined();
    expect(after?.oauth_grant?.written).toBeUndefined();
    // Not a store: untouched.
    expect(readProfile(dst, 'crm')?.oauth_grant?.written).toEqual([{ name: accessTokenKey('crm'), fp: 'beef' }]);
  });

  it('a profile whose base was changed away from its store is stripped too (keyed on the preset)', () => {
    const src = tmp(); const dst = tmp();
    seedEngine(src, SRC_KEY, [storeProfile('shop-acme', { base_url: 'https://elsewhere.example.com' })]);
    seedVault(src, SRC_KEY, SECRETS);
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme']);
    expect(vaultNames(dst)).not.toContain(accessTokenKey('shop-acme'));
  });

  it('a vault-only import: the destination\'s store profile loses the imported tokens', () => {
    const src = tmp(); const dst = tmp();
    seedVault(src, SRC_KEY, SECRETS);
    seedEngine(dst, DST_KEY, [storeProfile('shop-acme')]);
    const v = migrate(src, dst);
    expect(v.reconnectStores).toEqual(['shop-acme']);
    expect(vaultNames(dst)).not.toContain(accessTokenKey('shop-acme'));
  });

  it('the flat apis/*.json profiles are stripped as well', () => {
    const src = tmp(); const dst = tmp();
    mkdirSync(join(src, 'apis'));
    writeFileSync(join(src, 'apis', 'shop-acme.json'), JSON.stringify(storeProfile('shop-acme')));
    seedVault(src, SRC_KEY, SECRETS);
    const v = migrate(src, dst);
    expect(v.reconnectStores).toContain('shop-acme');
    const flat = JSON.parse(readFileSync(join(dst, 'apis', 'shop-acme.json'), 'utf-8')) as ApiProfile;
    expect(flat.oauth_grant?.store_binding).toBeUndefined();
    expect(flat.oauth_grant?.written).toBeUndefined();
  });

  it.each([['self-hosted', ''], ['managed', 'starter']])('%s: a flat file that parses to no profile (null, a list, a number) is skipped, and the store beside it is still stripped', (_label, tier) => {
    vi.stubEnv('LYNOX_BILLING_TIER', tier);
    const src = tmp(); const dst = tmp();
    mkdirSync(join(src, 'apis'));
    writeFileSync(join(src, 'apis', 'a-null.json'), 'null');
    writeFileSync(join(src, 'apis', 'a-list.json'), '[]');
    writeFileSync(join(src, 'apis', 'a-number.json'), '5');
    writeFileSync(join(src, 'apis', 'shop-acme.json'), JSON.stringify(storeProfile('shop-acme')));
    seedVault(src, SRC_KEY, SECRETS);
    const v = migrate(src, dst);
    expect(v.reconnectStores).toContain('shop-acme');
    const flat = JSON.parse(readFileSync(join(dst, 'apis', 'shop-acme.json'), 'utf-8')) as ApiProfile;
    expect(flat.oauth_grant?.store_binding).toBeUndefined();
    expect(readFileSync(join(dst, 'apis', 'a-null.json'), 'utf-8')).toBe('null');
  });

  /**
   * A store profile as a damaged file would hold it, and what the strip must still do with it: a
   * `null` grant record is left as it is; with a `null` among what it wrote, the binding and the
   * record still go, and so does a named slot recorded after the `null`.
   */
  const damaged = {
    'a null grant record': {
      profile: (): Record<string, unknown> => ({ ...storeProfile('shop-acme'), oauth_grant: null }),
      check: (_names: string[], grant: unknown): void => { expect(grant).toBeNull(); },
    },
    'a null entry among what it wrote': {
      profile: (): Record<string, unknown> => {
        const p = storeProfile('shop-acme');
        return { ...p, oauth_grant: { ...p.oauth_grant, written: [null, { name: 'MY_REFRESH', fp: tokenFingerprint('named-refresh') }] } };
      },
      check: (names: string[], grant: unknown): void => {
        expect(names, 'the named slot recorded after the null entry').not.toContain('MY_REFRESH');
        const g = grant as ApiProfile['oauth_grant'];
        expect(g?.state).toBe('connected');
        expect(g?.store_binding).toBeUndefined();
        expect(g?.written).toBeUndefined();
      },
    },
  };

  it.each(Object.keys(damaged) as (keyof typeof damaged)[])('a flat store profile with %s is still stripped, and the restore completes', (kind) => {
    const src = tmp(); const dst = tmp();
    mkdirSync(join(src, 'apis'));
    writeFileSync(join(src, 'apis', 'shop-acme.json'), JSON.stringify(damaged[kind].profile()));
    seedVault(src, SRC_KEY, SECRETS);
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme']);
    const names = vaultNames(dst);
    expect(names, 'the vault landed').toContain('S_CID');
    expect(names).not.toContain(accessTokenKey('shop-acme'));
    const flat = JSON.parse(readFileSync(join(dst, 'apis', 'shop-acme.json'), 'utf-8')) as Record<string, unknown>;
    damaged[kind].check(names, flat['oauth_grant']);
  });

  it.each(Object.keys(damaged) as (keyof typeof damaged)[])('an engine.db store row with %s is still stripped, and the restore completes', (kind) => {
    const src = tmp(); const dst = tmp();
    const { id, name, ...rest } = damaged[kind].profile();
    const engine = new EngineDb(join(src, 'engine.db'), SRC_KEY);
    try {
      new ConnectionStore(engine).upsert({ id: String(id), kind: 'api', name: String(name), subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
    } finally { engine.close(); }
    seedVault(src, SRC_KEY, SECRETS);
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme']);
    const names = vaultNames(dst);
    expect(names, 'the vault landed').toContain('S_CID');
    expect(names).not.toContain(accessTokenKey('shop-acme'));
    const after = readProfile(dst, 'shop-acme');
    expect(after, 'the stripped row loads').toBeDefined();
    damaged[kind].check(names, after?.oauth_grant);
  });

  /**
   * A symbolic link in `apis/`, or `apis/` itself one, is never written through: the file it
   * points to, outside the data dir, stays byte for byte. It is still read, as the boot reads it,
   * so a store profile behind it still loses its derived tokens. A bundle cannot carry one; it is
   * on the destination before the restore.
   */
  describe('a symbolic link in apis/', () => {
    function outsideStore(): { target: string; before: string } {
      const outside = tmp();
      const target = join(outside, 'shop-acme.json');
      const before = JSON.stringify(storeProfile('shop-acme'), null, 2);
      writeFileSync(target, before);
      return { target, before };
    }

    it('self-hosted: a profile file that is a link is read but not written through', () => {
      const src = tmp(); const dst = tmp();
      seedVault(src, SRC_KEY, SECRETS);
      const { target, before } = outsideStore();
      mkdirSync(join(dst, 'apis'));
      symlinkSync(target, join(dst, 'apis', 'shop-acme.json'));
      expect(migrate(src, dst).reconnectStores, 'the link was read').toEqual(['shop-acme']);
      expect(readFileSync(target, 'utf-8'), 'the file behind the link').toBe(before);
      const names = vaultNames(dst);
      expect(names, 'the vault landed').toContain('S_CID');
      expect(names).not.toContain(accessTokenKey('shop-acme'));
    });

    it('managed: the step after the strip refuses the link, and the strip has not written through it', () => {
      vi.stubEnv('LYNOX_BILLING_TIER', 'starter');
      const src = tmp(); const dst = tmp();
      seedVault(src, SRC_KEY, SECRETS);
      const { target, before } = outsideStore();
      mkdirSync(join(dst, 'apis'));
      symlinkSync(target, join(dst, 'apis', 'shop-acme.json'));
      expect(() => migrate(src, dst)).toThrow(/apis\/shop-acme\.json is not a regular file/);
      expect(readFileSync(target, 'utf-8'), 'the file behind the link').toBe(before);
    });

    it.each([['self-hosted', ''], ['managed', 'starter']])('%s: apis/ itself a link is read but nothing in it is written', (_label, tier) => {
      vi.stubEnv('LYNOX_BILLING_TIER', tier);
      const src = tmp(); const dst = tmp();
      seedVault(src, SRC_KEY, SECRETS);
      const { target, before } = outsideStore();
      symlinkSync(join(target, '..'), join(dst, 'apis'));
      expect(migrate(src, dst).reconnectStores, 'the linked directory was read').toEqual(['shop-acme']);
      expect(readFileSync(target, 'utf-8'), 'the file in the linked directory').toBe(before);
      const names = vaultNames(dst);
      expect(names, 'the vault landed').toContain('S_CID');
      expect(names).not.toContain(accessTokenKey('shop-acme'));
    });
  });

  it('a managed destination strips the same as a self-hosted one', () => {
    vi.stubEnv('LYNOX_BILLING_TIER', 'starter');
    const src = tmp(); const dst = tmp();
    seedEngine(src, SRC_KEY, [storeProfile('shop-acme')]);
    seedVault(src, SRC_KEY, SECRETS);
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme']);
  });

  it('a slot the stripped record says an exchange wrote goes too, a named refresh slot among them, but only with the value it wrote', () => {
    const src = tmp(); const dst = tmp();
    const written = [
      { name: accessTokenKey('shop-acme'), fp: 'abcd' },
      { name: 'MY_REFRESH', fp: tokenFingerprint('named-refresh') },
      // Written once, replaced by the customer since: not the exchange's to take.
      { name: 'C_CID', fp: tokenFingerprint('an-earlier-value') },
      // A provider key slot is never removed, whatever the record says.
      { name: 'ANTHROPIC_API_KEY', fp: tokenFingerprint('provider-key-value') },
    ];
    seedEngine(src, SRC_KEY, [storeProfile('shop-acme', { oauth_grant: { origin: 'callback', state: 'connected', store_binding: 'f'.repeat(64), written } } as Partial<ApiProfile>)]);
    seedVault(src, SRC_KEY, { ...SECRETS, ANTHROPIC_API_KEY: 'provider-key-value' });
    migrate(src, dst);
    const names = vaultNames(dst);
    expect(names).not.toContain('MY_REFRESH');
    for (const kept of ['S_CID', 'S_CSECRET', 'C_CID', 'ANTHROPIC_API_KEY']) expect(names).toContain(kept);
  });

  it('a slot a kept profile reads stays: a recorded slot it names, and the derived pair of a `-`/`_` partner', () => {
    const src = tmp(); const dst = tmp();
    const shared = 'SHARED_TOKEN';
    const store = storeProfile('shop-acme', { oauth_grant: { origin: 'callback', state: 'connected', store_binding: 'f'.repeat(64), written: [{ name: shared, fp: tokenFingerprint('shared-value') }] } } as Partial<ApiProfile>);
    const user: ApiProfile = { id: 'crm', name: 'CRM', base_url: 'https://api.crm.example.com', description: 'names the slot',
      auth: { type: 'bearer', vault_keys: [shared] } } as ApiProfile;
    const partner: ApiProfile = { id: 'shop_acme', name: 'Partner', base_url: 'https://api.partner.example.com', description: 'shares the derived pair',
      auth: { type: 'oauth2', oauth: { client_id_key: 'P_CID', client_secret_key: 'P_CSECRET' } } } as ApiProfile;
    seedEngine(src, SRC_KEY, [store, user, partner], true);
    seedVault(src, SRC_KEY, { ...SECRETS, [shared]: 'shared-value' });
    expect(accessTokenKey('shop_acme')).toBe(accessTokenKey('shop-acme'));
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme']);
    const names = vaultNames(dst);
    expect(names).toContain(shared);
    expect(names).toContain(accessTokenKey('shop-acme'));
  });

  it('a store a mandate connected loses its slots even where a kept profile names them', () => {
    const src = tmp(); const dst = tmp();
    const shared = 'SHARED_TOKEN';
    const mandateGrant = { origin: 'callback', state: 'connected', store_binding: 'f'.repeat(64), connected_by: `${MANDATE_TAG_PREFIX}m-1`,
      written: [{ name: shared, fp: tokenFingerprint('shared-value') }, { name: accessTokenKey('shop-acme'), fp: tokenFingerprint('shpat-a') }] };
    const store = storeProfile('shop-acme', { oauth_grant: mandateGrant } as Partial<ApiProfile>);
    const user: ApiProfile = { id: 'crm', name: 'CRM', base_url: 'https://api.crm.example.com', description: 'names the slots',
      auth: { type: 'bearer', vault_keys: [shared, accessTokenKey('shop-acme')] } } as ApiProfile;
    seedEngine(src, SRC_KEY, [store, user], true);
    seedVault(src, SRC_KEY, { ...SECRETS, [shared]: 'shared-value' });
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme']);
    const names = vaultNames(dst);
    expect(names).not.toContain(shared);
    expect(names).not.toContain(accessTokenKey('shop-acme'));
  });

  it('against a mandate store, a slot whose value was replaced since stays, and so does one another store recorded', () => {
    const src = tmp(); const dst = tmp();
    const mandate = { origin: 'callback', state: 'connected', store_binding: 'f'.repeat(64), connected_by: `${MANDATE_TAG_PREFIX}m-1` };
    const a = storeProfile('shop-acme', { oauth_grant: { ...mandate, written: [{ name: 'REPLACED', fp: tokenFingerprint('what-the-exchange-wrote') }, { name: 'SHARED_X', fp: tokenFingerprint('a-value') }] } } as Partial<ApiProfile>);
    const b = storeProfile('shop-beta', { base_url: 'https://beta.myshopify.com', auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'beta' }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET' } },
      custom_endpoint_ack: { accepted: true, hosts: ['beta.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
      oauth_grant: { origin: 'callback', state: 'connected', store_binding: 'e'.repeat(64), written: [{ name: 'SHARED_X', fp: tokenFingerprint('b-value') }] } } as Partial<ApiProfile>);
    const user: ApiProfile = { id: 'crm', name: 'CRM', base_url: 'https://api.crm.example.com', description: 'names both',
      auth: { type: 'bearer', vault_keys: ['REPLACED', 'SHARED_X'] } } as ApiProfile;
    seedEngine(src, SRC_KEY, [a, b, user], true);
    seedVault(src, SRC_KEY, { ...SECRETS, REPLACED: 'the-customers-own', SHARED_X: 'b-value' });
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme', 'shop-beta']);
    const names = vaultNames(dst);
    // Forced, but not the value the exchange wrote.
    expect(names).toContain('REPLACED');
    // The value is B's, and B is no mandate store: the kept profile holds it.
    expect(names).toContain('SHARED_X');
  });

  it('a slot both a mandate store and another store recorded goes when its value is the mandate store\'s', () => {
    const src = tmp(); const dst = tmp();
    const a = storeProfile('shop-acme', { oauth_grant: { origin: 'callback', state: 'connected', store_binding: 'f'.repeat(64), connected_by: `${MANDATE_TAG_PREFIX}m-1`,
      written: [{ name: 'SHARED_X', fp: tokenFingerprint('a-value') }] } } as Partial<ApiProfile>);
    const b = storeProfile('shop-beta', { base_url: 'https://beta.myshopify.com', auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'beta' }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET' } },
      custom_endpoint_ack: { accepted: true, hosts: ['beta.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
      oauth_grant: { origin: 'callback', state: 'connected', store_binding: 'e'.repeat(64), written: [{ name: 'SHARED_X', fp: tokenFingerprint('b-value') }] } } as Partial<ApiProfile>);
    const user: ApiProfile = { id: 'crm', name: 'CRM', base_url: 'https://api.crm.example.com', description: 'names it',
      auth: { type: 'bearer', vault_keys: ['SHARED_X'] } } as ApiProfile;
    seedEngine(src, SRC_KEY, [a, b, user], true);
    seedVault(src, SRC_KEY, { ...SECRETS, SHARED_X: 'a-value' });
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme', 'shop-beta']);
    // A's entry is forced and its fingerprint matches; B's entry does not hold it.
    expect(vaultNames(dst)).not.toContain('SHARED_X');
  });

  it('a `-`/`_` partner keeps its derived pair even against a store a mandate connected', () => {
    const src = tmp(); const dst = tmp();
    const store = storeProfile('shop-acme', { oauth_grant: { origin: 'callback', state: 'connected', store_binding: 'f'.repeat(64), connected_by: `${MANDATE_TAG_PREFIX}m-1`,
      written: [{ name: accessTokenKey('shop-acme'), fp: tokenFingerprint('shpat-a') }] } } as Partial<ApiProfile>);
    const partner: ApiProfile = { id: 'shop_acme', name: 'Partner', base_url: 'https://api.partner.example.com', description: 'shares the derived pair',
      auth: { type: 'oauth2', oauth: { client_id_key: 'P_CID', client_secret_key: 'P_CSECRET' } } } as ApiProfile;
    seedEngine(src, SRC_KEY, [store, partner], true);
    seedVault(src, SRC_KEY, SECRETS);
    expect(migrate(src, dst).reconnectStores).toEqual(['shop-acme']);
    expect(vaultNames(dst)).toContain(accessTokenKey('shop-acme'));
  });

  it('an import without a store connection reports none', () => {
    const src = tmp(); const dst = tmp();
    seedEngine(src, SRC_KEY, [plainProfile]);
    seedVault(src, SRC_KEY, SECRETS);
    expect(migrate(src, dst).reconnectStores).toBeUndefined();
  });
});
