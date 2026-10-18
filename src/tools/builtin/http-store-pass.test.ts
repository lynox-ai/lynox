/**
 * The store pass at the attach (`http.ts › storePassPrecheck` and the end of the oauth2 branch),
 * against the real Shopify check: what it takes for a request to a store to get a pass, and that
 * each condition refuses on its own with all the others met (PRD-SHOPIFY-CONTAINMENT-ERASURE
 * Appendix B, AC1, AC3, AC4, AC6).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { accessTokenKey, refreshTokenKey, ApiStore, type ApiProfile } from '../../core/api-store.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { ExactClearance, type ExactMarker } from '../../core/exact-clearance.js';
import { isStorePass, type StorePass } from '../../core/store-pass.js';
import { attachStoredCredential } from './http.js';

const ORIGIN = 'https://acme.myshopify.com';
const URL_OK = `${ORIGIN}/admin/api/2025-10/shop.json`;
const TOKEN = 'shpat-store-value';
const KEY = 'vault-key-of-this-instance';

const bind = (key: string) => (id: string, origin: string, value: string): string | null =>
  createHmac('sha256', key).update(`${id}|${origin}|${value}`).digest('hex');

function shopProfile(over: { id?: string; shop?: string; base?: string; binding?: string | null; oauth?: Record<string, unknown> } = {}): ApiProfile {
  const id = over.id ?? 'shop-acme';
  const base = over.base ?? ORIGIN;
  const binding = over.binding === undefined ? bind(KEY)(id, ORIGIN, TOKEN) : over.binding;
  return {
    id, name: 'Acme', base_url: base, description: 'stub',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: over.shop ?? 'acme' }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET', ...over.oauth } },
    custom_endpoint_ack: { accepted: true, hosts: [new URL(base).hostname], accepted_at: '2026-10-18T00:00:00.000Z' },
    oauth_grant: { origin: 'callback', state: 'connected', ...(binding !== null ? { store_binding: binding } : {}) },
  } as ApiProfile;
}

let cpCalls: number;
let cpAnswer: () => Response;

function clearance(): ExactClearance {
  const marker: ExactMarker = { isSet: () => false, set: () => undefined };
  return new ExactClearance(
    { url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 's' },
    marker,
    { fetch: (async () => { cpCalls++; return cpAnswer(); }) as unknown as typeof fetch },
  );
}

interface Run { attached: boolean; pass: StorePass | undefined; headers: Record<string, string>; read: string[] }

async function attach(url: string, profiles: ApiProfile[], opts: {
  headers?: Record<string, string>;
  vault?: Record<string, string>;
  digest?: ((id: string, origin: string, value: string) => string | null) | null;
  clearance?: ExactClearance | null;
} = {}): Promise<Run> {
  const store = new ApiStore();
  for (const p of profiles) store.register(p);
  const headers = { ...opts.headers };
  const read: string[] = [];
  const vault = opts.vault ?? { [accessTokenKey(profiles[0]?.id ?? 'shop-acme')]: TOKEN };
  const out: { pass?: StorePass | undefined } = {};
  const attached = await attachStoredCredential(url, headers, false, {
    apiStore: store,
    secretStore: { resolve: (n: string) => { read.push(n); return vault[n] ?? null; } } as never,
    principal: OWNER_PRINCIPAL, mandateEnds: null, secretReleases: null,
    exactClearance: opts.clearance === undefined ? clearance() : opts.clearance,
    storeBindingDigest: opts.digest === undefined ? bind(KEY) : opts.digest,
  }, out);
  return { attached, pass: out.pass, headers, read };
}

const ENV = {
  LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.example.invalid',
  LYNOX_MANAGED_INSTANCE_ID: 'inst-1',
  LYNOX_HTTP_SECRET: 's',
  LYNOX_SHELL_EXEC_SOCKET: '/run/lynox/shell.sock',
};

beforeEach(() => {
  cpCalls = 0;
  cpAnswer = () => new Response('{"ok":true}', { status: 200 });
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('a request that meets every condition', () => {
  it('gets a pass for its store, with the token in the provider\'s header', async () => {
    const r = await attach(URL_OK, [shopProfile()]);
    expect(r.attached).toBe(true);
    expect(isStorePass(r.pass)).toBe(true);
    expect(r.pass!.origin).toBe(ORIGIN);
    expect(r.pass!.headerName).toBe('x-shopify-access-token');
    expect(r.headers['X-Shopify-Access-Token']).toBe(TOKEN);
    expect(cpCalls).toBe(1);
  });
});

describe('each condition refuses alone (AC3)', () => {
  it.each([
    ['no control-plane env', 'LYNOX_MANAGED_INSTANCE_ID'],
    ['no sidecar socket', 'LYNOX_SHELL_EXEC_SOCKET'],
  ])('%s', async (_label, unset) => {
    vi.stubEnv(unset, '');
    const r = await attach(URL_OK, [shopProfile()]);
    expect(r.pass).toBeUndefined();
    expect(r.read).toEqual([]);
    expect(cpCalls).toBe(0);
  });

  it('a socket of blanks', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', '   ');
    expect((await attach(URL_OK, [shopProfile()])).pass).toBeUndefined();
  });

  it('a profile on the store host that is not the store preset', async () => {
    const p = shopProfile();
    const plain = { ...p, auth: { type: 'oauth2', oauth: { client_id_key: 'S_CID', client_secret_key: 'S_CSECRET' } } } as ApiProfile;
    const r = await attach(URL_OK, [plain]);
    expect(r.pass).toBeUndefined();
    expect(r.read).toEqual([]);
  });

  it('a store-preset profile whose parameter derives another store', async () => {
    const r = await attach(URL_OK, [shopProfile({ shop: 'other' })]);
    expect(r.pass).toBeUndefined();
    expect(r.read).toEqual([]);
    expect(cpCalls).toBe(0);
  });

  it.each(['access_token', 'api_key', 'Signature', 'x-shopify-session'])('a credential in the query (%s)', async (name) => {
    const r = await attach(`${URL_OK}?${name}=x`, [shopProfile()]);
    expect(r.pass).toBeUndefined();
    expect(r.read).toEqual([]);
  });

  it.each(['X-Shopify-Access-Token', 'x-SHOPIFY-access-token', 'Authorization', 'Cookie', 'X-Api-Key'])('a credential header the model wrote (%s)', async (name) => {
    const r = await attach(URL_OK, [shopProfile()], { headers: { [name]: 'mine' } });
    expect(r.pass).toBeUndefined();
    expect(r.read).toEqual([]);
    expect(cpCalls).toBe(0);
  });

  it('the control plane does not clear', async () => {
    cpAnswer = () => new Response('{"ok":false,"reason":"below_floor"}', { status: 200 });
    const r = await attach(URL_OK, [shopProfile()]);
    expect(r.pass).toBeUndefined();
    expect(r.attached).toBe(false);
  });

  it('a refusal of the control plane that still holds refuses before anything is read (6a)', async () => {
    cpAnswer = () => new Response('{"ok":false,"reason":"busy"}', { status: 409 });
    const c = clearance();
    await attach(URL_OK, [shopProfile()], { clearance: c });
    const r = await attach(URL_OK, [shopProfile()], { clearance: c });
    expect(r.read).toEqual([]);
    expect(cpCalls).toBe(1);
  });

  it('no engine.db (no clearance, no digest)', async () => {
    expect((await attach(URL_OK, [shopProfile()], { clearance: null })).pass).toBeUndefined();
    expect((await attach(URL_OK, [shopProfile()], { digest: null })).pass).toBeUndefined();
  });

  it('no vault key: the digest cannot be computed', async () => {
    const r = await attach(URL_OK, [shopProfile()], { digest: () => null });
    expect(r.pass).toBeUndefined();
    expect(cpCalls).toBe(0);
  });

  it('no store_binding on the profile', async () => {
    const r = await attach(URL_OK, [shopProfile({ binding: null })]);
    expect(r.pass).toBeUndefined();
    expect(cpCalls).toBe(0);
  });
});

describe('refused before the vault and the control plane (A-3, B2 of round 1)', () => {
  it('http to the store reads no token and asks nobody', async () => {
    const r = await attach('http://acme.myshopify.com/admin/api/2025-10/shop.json', [shopProfile()]);
    expect(r.pass).toBeUndefined();
    expect(r.read).not.toContain(accessTokenKey('shop-acme'));
    expect(cpCalls).toBe(0);
  });

  it('a path off the grant (/apps/) reads no token and asks nobody', async () => {
    const r = await attach(`${ORIGIN}/apps/some-app/x`, [shopProfile()]);
    expect(r.pass).toBeUndefined();
    expect(r.read).not.toContain(accessTokenKey('shop-acme'));
    expect(cpCalls).toBe(0);
  });

  it('a binding that does not hold asks nobody, so the control plane records nothing', async () => {
    const r = await attach(URL_OK, [shopProfile()], { vault: { [accessTokenKey('shop-acme')]: 'shpat-written-later' } });
    expect(r.pass).toBeUndefined();
    expect(cpCalls).toBe(0);
  });
});

describe('the binding (AC4)', () => {
  it('(a/b/c) a token in the slot other than the bound one: overwritten, created, or shadowed', async () => {
    const r = await attach(URL_OK, [shopProfile()], { vault: { [accessTokenKey('shop-acme')]: 'shpat-attacker' } });
    expect(r.pass).toBeUndefined();
  });

  it('(d) a forged grant record (origin callback, written) without a binding the vault key made', async () => {
    const forged = shopProfile({ binding: createHmac('sha256', 'guess').update('x').digest('hex') });
    expect((await attach(URL_OK, [forged])).pass).toBeUndefined();
  });

  it('(e) a valid binding copied to a second profile', async () => {
    const copied = shopProfile({ id: 'shop-copy', binding: bind(KEY)('shop-acme', ORIGIN, TOKEN) });
    const r = await attach(URL_OK, [copied], { vault: { [accessTokenKey('shop-copy')]: TOKEN } });
    expect(r.pass).toBeUndefined();
  });

  it('(f) the store parameter changed after the connect: the request to the new store finds no binding for it', async () => {
    const moved = shopProfile({ shop: 'other', base: 'https://other.myshopify.com' });
    const r = await attach('https://other.myshopify.com/admin/api/2025-10/shop.json', [moved]);
    expect(r.pass).toBeUndefined();
  });

  it('(g) a binding made under another vault key', async () => {
    const r = await attach(URL_OK, [shopProfile({ binding: bind('another-vault-key')('shop-acme', ORIGIN, TOKEN) })]);
    expect(r.pass).toBeUndefined();
  });
});

describe('no renewal of a store preset (AC6)', () => {
  it('a due token with a filled refresh slot does not enter the renewal', async () => {
    const p = shopProfile({ oauth: { token_expires_at: Date.now() - 60_000, grant_type: 'refresh_token' } });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let r: Run;
    try {
      r = await attach(URL_OK, [p], { vault: { [accessTokenKey('shop-acme')]: TOKEN, [refreshTokenKey('shop-acme')]: 'shprt-refresh', S_CID: 'cid', S_CSECRET: 'csecret' } });
      // This hand-built agent may not renew unattended, so the reads below cannot tell the skip
      // from a renewal that stopped at that check; the skip's own line can. A refresh_token
      // grant would otherwise pass `oauthProfileMayBeRenewedUnattended` and enter the renewal.
      expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes('oauth token renewal skipped for profile "shop-acme": a store connection is renewed by connecting it again'))).toBe(true);
    } finally {
      log.mockRestore();
    }
    // The renewal reads the client credentials before it posts; it was not entered.
    expect(r.read).not.toContain('S_CSECRET');
    expect(r.read).not.toContain('S_CID');
    expect(isStorePass(r.pass)).toBe(true);
  });
});
