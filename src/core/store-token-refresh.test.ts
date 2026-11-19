/**
 * The refresh of a store connection whose token expires (`store-token-refresh.ts`): what it takes
 * for the refresh to be sent, what it stores, and each way it ends the connection instead. The
 * stores are real (an engine.db with its grant ledger); only the store's token endpoint is stood
 * in for, by the exchange this module calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorePass } from './store-pass.js';
import type { TokenExchangeRequest, TokenExchangeResult } from './oauth-token-exchange.js';

const hold = vi.hoisted(() => ({
  dir: '',
  answer: null as null | ((req: TokenExchangeRequest, pass: StorePass | undefined) => Promise<TokenExchangeResult>),
  calls: [] as { req: TokenExchangeRequest; pass: StorePass | undefined }[],
}));

vi.mock('./oauth-token-exchange.js', async (orig) => {
  const real = await orig<typeof import('./oauth-token-exchange.js')>();
  return {
    ...real,
    exchangeToken: async (req: TokenExchangeRequest, _tc: unknown, _sent: unknown, pass?: StorePass): Promise<TokenExchangeResult> => {
      hold.calls.push({ req, pass });
      return hold.answer!(req, pass);
    },
  };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), getLynoxDir: () => hold.dir }));

import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, accessTokenKey, refreshTokenKey, type ApiProfile } from './api-store.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { isStorePass, storePassBodyRefusal } from './store-pass.js';
import { serializeTokenBody } from './oauth-token-exchange.js';
import {
  beginStoreConnect, endStoreConnect, refreshStoreToken, renewStoreAfterUnauthorized, resetStoreRefreshForTests,
  STORE_REFRESH_WINDOW_MS, storeRefreshPassFor, type StoreRefreshContext,
} from './store-token-refresh.js';

const ID = 'shop-acme';
const ORIGIN = 'https://acme.myshopify.com';
const KEY = 'vault-key-of-this-instance';
const SCOPE = 'read_products,write_products';
const bind = (id: string, origin: string, value: string): string | null =>
  createHmac('sha256', KEY).update(`${id}|${origin}|${value}`).digest('hex');

const ENV = {
  LYNOX_SHOPIFY_EXCHANGE: '1',
  LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.example.invalid',
  LYNOX_MANAGED_INSTANCE_ID: 'inst-1',
  LYNOX_HTTP_SECRET: 's',
};

const answer = (body: Record<string, unknown>, status = 200): TokenExchangeResult =>
  ({ ok: true, status, responseOk: status >= 200 && status < 300, text: JSON.stringify(body) });
const RENEWED = { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, refresh_token_expires_in: 7_776_000, scope: SCOPE };

describe('the refresh of an expiring store connection', () => {
  let db: EngineDb;
  let store: ApiStore;
  const vault = new Map<string, string>();
  let savedEnv: Record<string, string | undefined>;
  let clearanceAsked: number;
  let stderr: ReturnType<typeof vi.spyOn>;

  const ctx = (): StoreRefreshContext => ({
    toolContext: {
      apiStore: store,
      exactClearance: { ensure: async () => { clearanceAsked++; return { ok: true }; }, blockedNow: () => false, heldRefusal: () => null, reassert: async () => undefined } as never,
      storeBindingDigest: bind,
      shellIsolation: { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as never,
    },
    secretStore: { resolve: (n: string) => vault.get(n) ?? null, set: (n: string, v: string) => { vault.set(n, v); } } as never,
    principal: OWNER_PRINCIPAL,
  });
  const profile = (): ApiProfile => store.get(ID)!;
  const lines = (): string[] => stderr.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    hold.dir = mkdtempSync(join(tmpdir(), 'lynox-store-refresh-'));
    savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    db = new EngineDb(join(hold.dir, 'engine.db'));
    const conn = new ConnectionStore(db);
    store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(new GrantLedger(db.getDb()));
    store.setFingerprinter({
      keyCheck: 'check-k', ofValue: (v) => (v === '' ? '' : `k-${tokenFingerprint(v)}`), tokenOfValue: (v) => (v === '' ? '' : `t-${tokenFingerprint(v)}`),
      read: (name, hash) => hash(vault.get(name) ?? ''),
    });
    vault.clear();
    vault.set('SHOPIFY_CLIENT_ID', 'cid');
    vault.set('SHOPIFY_CLIENT_SECRET', 'csecret');
    vault.set(accessTokenKey(ID), 'at-old');
    vault.set(refreshTokenKey(ID), 'rt-old');
    const base: ApiProfile = {
      id: ID, name: 'Acme', base_url: ORIGIN, description: 'Acme store',
      auth: { type: 'oauth2', vault_keys: [], oauth: { preset_id: 'shopify', preset_params: { shop: 'acme' }, client_id_key: 'SHOPIFY_CLIENT_ID', client_secret_key: 'SHOPIFY_CLIENT_SECRET', token_expires_at: Date.now() - 60_000 } },
      custom_endpoint_ack: { accepted: true, hosts: ['acme.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
    } as ApiProfile;
    expect(store.save(base).ok).toBe(true);
    // The callback's consent: the tokens stored, then the grant with its binding over the access token.
    const written = [{ name: accessTokenKey(ID), fp: tokenFingerprint('at-old') }, { name: refreshTokenKey(ID), fp: tokenFingerprint('rt-old') }];
    expect(store.save({
      ...store.get(ID)!,
      oauth_grant: { origin: 'callback', state: 'connected', granted_scope: SCOPE.split(','), written, store_binding: bind(ID, ORIGIN, 'at-old')!, minted_by: tokenFingerprint('cid'), minted_for: tokenFingerprint('rt-old') },
    }, undefined, { newConsent: true, consentRefresh: 'rt-old' }).ok).toBe(true);
    expect(typeof profile().oauth_grant?.grant_id).toBe('string');
    hold.calls = [];
    hold.answer = async () => answer(RENEWED);
    clearanceAsked = 0;
    resetStoreRefreshForTests();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    db.close();
    rmSync(hold.dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('renews: stores both new tokens, binds the new one, keeps the grant, and records both expiries', async () => {
    const grantBefore = profile().oauth_grant?.grant_id;
    const before = Date.now();
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('renewed');
    expect(vault.get(accessTokenKey(ID))).toBe('at-new');
    expect(vault.get(refreshTokenKey(ID))).toBe('rt-new');
    const p = profile();
    expect(p.oauth_grant?.store_binding).toBe(bind(ID, ORIGIN, 'at-new'));
    expect(p.oauth_grant?.grant_id).toBe(grantBefore);
    // The grant records the new values as its own, so a later save does not read them as foreign.
    expect(p.oauth_grant?.fingerprints?.[accessTokenKey(ID)]).toBe(`k-${tokenFingerprint('at-new')}`);
    expect(p.oauth_grant?.fingerprints?.[refreshTokenKey(ID)]).toBe(`k-${tokenFingerprint('rt-new')}`);
    expect(p.oauth_grant?.minted_for).toBe(tokenFingerprint('rt-new'));
    expect(p.auth?.oauth?.token_expires_at).toBeGreaterThanOrEqual(before + 3_600_000 - 1000);
    expect(p.oauth_grant?.refresh_expires_at).toBeGreaterThanOrEqual(before + 7_776_000_000 - 1000);
    expect(p.oauth_grant?.written?.find((w) => w.name === accessTokenKey(ID))?.fp).toBe(tokenFingerprint('at-new'));
    expect(p.oauth_grant?.written?.find((w) => w.name === refreshTokenKey(ID))?.fp).toBe(tokenFingerprint('rt-new'));
    expect(clearanceAsked).toBe(1);
  });

  it('sends the refresh grant built from the vault, to the store\'s own token endpoint, under a pass over exactly that body', async () => {
    await refreshStoreToken(ID, 'due', ctx());
    expect(hold.calls).toHaveLength(1);
    const { req, pass } = hold.calls[0]!;
    expect(req.params).toEqual({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rt-old' });
    expect(req.endpoint.url).toBe(`${ORIGIN}/admin/oauth/access_token`);
    expect(isStorePass(pass)).toBe(true);
    expect(pass).toMatchObject({ kind: 'exchange', origin: ORIGIN });
    expect(storePassBodyRefusal(pass!, Buffer.from(serializeTokenBody(req.params, req.bodyFormat)), {})).toBeNull();
  });

  it('a body other than the one built from the vault is refused under its pass: a foreign refresh token, another grant', async () => {
    const plan = await storeRefreshPassFor(ID, ctx());
    expect(plan).toBeDefined();
    const sent = (params: Record<string, string>): string | null => storePassBodyRefusal(plan!.pass, Buffer.from(serializeTokenBody(params, plan!.bodyFormat)), {});
    // The foreign bodies first: a body the pass covers spends it, and a spent pass refuses anything.
    const foreign = 'the body sent is not the token exchange that was verified';
    expect(sent({ ...plan!.params, refresh_token: 'rt-someone-else' })).toBe(foreign);
    expect(sent({ ...plan!.params, grant_type: 'client_credentials' })).toBe(foreign);
    expect(sent({ ...plan!.params, grant_type: 'authorization_code', code: 'c' })).toBe(foreign);
    expect(sent({ ...plan!.params })).toBeNull();
  });

  it('mints no pass when the binding does not hold over the access token in the vault, and sends nothing', async () => {
    vault.set(accessTokenKey(ID), 'at-put-there-by-someone-else');
    expect(await storeRefreshPassFor(ID, ctx())).toBeUndefined();
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('not-run');
    expect(hold.calls).toHaveLength(0);
    expect(clearanceAsked).toBe(0);
    expect(vault.get(refreshTokenKey(ID))).toBe('rt-old');
  });

  it('mints no pass for a client the preset does not name', async () => {
    const p = profile();
    expect(store.save({ ...p, auth: { ...p.auth, oauth: { ...p.auth!.oauth, client_secret_key: 'OTHER_SECRET' } } } as ApiProfile).ok).toBe(true);
    vault.set('OTHER_SECRET', 'another-providers-key');
    expect(await storeRefreshPassFor(ID, ctx())).toBeUndefined();
  });

  it('mints no pass with the store exchange switched off', async () => {
    delete process.env['LYNOX_SHOPIFY_EXCHANGE'];
    expect(await storeRefreshPassFor(ID, ctx())).toBeUndefined();
  });

  it('an answer for another scope is not stored: the binding is taken away and the connection has to be made again', async () => {
    hold.answer = async () => answer({ ...RENEWED, scope: `${SCOPE},read_customers` });
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('dead');
    expect(vault.get(accessTokenKey(ID))).toBe('at-old');
    expect(vault.get(refreshTokenKey(ID))).toBe('rt-old');
    expect(profile().oauth_grant?.store_binding).toBeUndefined();
    expect(lines().some((l) => l.includes('another scope than the one granted'))).toBe(true);
  });

  it('an answer that names no scope is not stored either', async () => {
    const { scope: _s, ...noScope } = RENEWED;
    hold.answer = async () => answer(noScope);
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('dead');
    expect(vault.get(accessTokenKey(ID))).toBe('at-old');
  });

  it('stores nothing when the vault changed while the refresh ran, and ends the connection (compare-and-swap)', async () => {
    hold.answer = async () => { vault.set(refreshTokenKey(ID), 'rt-written-meanwhile'); return answer(RENEWED); };
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('dead');
    expect(vault.get(accessTokenKey(ID))).toBe('at-old');
    expect(vault.get(refreshTokenKey(ID))).toBe('rt-written-meanwhile');
    expect(profile().oauth_grant?.store_binding).toBeUndefined();
    // Nothing tried again with the spent refresh token.
    expect(hold.calls).toHaveLength(1);
  });

  it('the access slot changing meanwhile ends it the same way', async () => {
    hold.answer = async () => { vault.set(accessTokenKey(ID), 'at-written-meanwhile'); return answer(RENEWED); };
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('dead');
    expect(vault.get(accessTokenKey(ID))).toBe('at-written-meanwhile');
  });

  it('a refusal by the store ends the connection and leaves the vault as it was', async () => {
    hold.answer = async () => answer({ error: 'invalid_grant', error_description: 'secret-looking provider text rt-old' }, 400);
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('dead');
    expect(vault.get(accessTokenKey(ID))).toBe('at-old');
    expect(profile().oauth_grant?.store_binding).toBeUndefined();
    // The answer's body reaches no log line.
    expect(lines().some((l) => l.includes('invalid_grant') || l.includes('rt-old'))).toBe(false);
  });

  it('no answer at all leaves the connection as it was', async () => {
    hold.answer = async () => ({ ok: false, message: 'socket hang up' });
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('not-run');
    expect(profile().oauth_grant?.store_binding).toBe(bind(ID, ORIGIN, 'at-old'));
    expect(vault.get(accessTokenKey(ID))).toBe('at-old');
  });

  it('runs at most once a minute per store: a second 401 right after sends nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await refreshStoreToken(ID, 'unauthorized', ctx())).toBe('renewed');
    expect(await refreshStoreToken(ID, 'unauthorized', ctx())).toBe('not-run');
    expect(hold.calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + STORE_REFRESH_WINDOW_MS - 1000);
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('not-run');
    expect(hold.calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2000);
    hold.answer = async () => answer({ ...RENEWED, access_token: 'at-newer', refresh_token: 'rt-newer' });
    expect(await refreshStoreToken(ID, 'unauthorized', ctx())).toBe('renewed');
    expect(hold.calls).toHaveLength(2);
    expect(hold.calls[1]!.req.params['refresh_token']).toBe('rt-new');
  });

  it('two requests that find the token due share one refresh', async () => {
    const [a, b] = await Promise.all([refreshStoreToken(ID, 'due', ctx()), refreshStoreToken(ID, 'due', ctx())]);
    expect([a, b]).toEqual(['renewed', 'renewed']);
    expect(hold.calls).toHaveLength(1);
  });

  it('does not start while a connect of the same store is completing', async () => {
    expect(beginStoreConnect(ID)).toBe(true);
    try {
      expect(await refreshStoreToken(ID, 'due', ctx())).toBe('not-run');
      expect(hold.calls).toHaveLength(0);
    } finally {
      endStoreConnect(ID);
    }
    expect(await refreshStoreToken(ID, 'due', ctx())).toBe('renewed');
  });

  it('a connect is refused while a refresh of the same store runs, and allowed again after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    hold.answer = async () => { await gate; return answer(RENEWED); };
    const running = refreshStoreToken(ID, 'due', ctx());
    await vi.waitFor(() => { expect(hold.calls).toHaveLength(1); });
    expect(beginStoreConnect(ID)).toBe(false);
    expect(beginStoreConnect('another-shop')).toBe(true);
    endStoreConnect('another-shop');
    release();
    expect(await running).toBe('renewed');
    expect(beginStoreConnect(ID)).toBe(true);
    endStoreConnect(ID);
  });

  it('a request to the store with the token due renews it first, and goes out with the new token', async () => {
    const { attachStoredCredential } = await import('../tools/builtin/http.js');
    const { bindingsAsMigrated } = await import('../../tests/helpers/vault-bindings.js');
    const headers: Record<string, string> = {};
    const out: { pass?: StorePass | undefined } = {};
    const c = ctx();
    const attached = await attachStoredCredential(`${ORIGIN}/admin/api/2025-10/shop.json`, headers, false, {
      apiStore: store,
      secretStore: c.secretStore,
      principal: OWNER_PRINCIPAL, mandateEnds: null, secretReleases: null,
      exactClearance: c.toolContext.exactClearance,
      storeBindingDigest: bind,
      containment: { contain: () => undefined, holds: () => true, isContained: () => false } as never,
      vaultNameBindings: bindingsAsMigrated(store),
      shellIsolation: c.toolContext.shellIsolation,
    }, { bulkRunId: 'run-1' }, out);
    expect(attached?.id).toBe(ID);
    expect(hold.calls).toHaveLength(1);
    const sent = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-shopify-access-token')?.[1];
    expect(sent).toBe('at-new');
    expect(isStorePass(out.pass)).toBe(true);
  });

  it('a request with the token not yet due sends no refresh', async () => {
    const p = profile();
    expect(store.save({ ...p, auth: { ...p.auth, oauth: { ...p.auth!.oauth, token_expires_at: Date.now() + 3_600_000 } } } as ApiProfile).ok).toBe(true);
    const { attachStoredCredential } = await import('../tools/builtin/http.js');
    const { bindingsAsMigrated } = await import('../../tests/helpers/vault-bindings.js');
    const headers: Record<string, string> = {};
    const c = ctx();
    await attachStoredCredential(`${ORIGIN}/admin/api/2025-10/shop.json`, headers, false, {
      apiStore: store, secretStore: c.secretStore, principal: OWNER_PRINCIPAL, mandateEnds: null, secretReleases: null,
      exactClearance: c.toolContext.exactClearance, storeBindingDigest: bind,
      containment: { contain: () => undefined, holds: () => true, isContained: () => false } as never,
      vaultNameBindings: bindingsAsMigrated(store), shellIsolation: c.toolContext.shellIsolation,
    }, { bulkRunId: 'run-1' }, {});
    expect(hold.calls).toHaveLength(0);
    expect(Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-shopify-access-token')?.[1]).toBe('at-old');
  });

  it('after a 401 renews only the connection of the store the request went to', async () => {
    expect(await renewStoreAfterUnauthorized('https://other.myshopify.com/admin/api/2025-10/graphql.json', ctx())).toBe(false);
    expect(hold.calls).toHaveLength(0);
    expect(await renewStoreAfterUnauthorized(`${ORIGIN}/admin/api/2025-10/graphql.json`, ctx())).toBe(true);
    expect(vault.get(accessTokenKey(ID))).toBe('at-new');
  });
});
