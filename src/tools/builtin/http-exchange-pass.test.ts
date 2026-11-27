/**
 * The token exchange's pass (`http.ts › storeExchangePassFor`, PRD-SHOPIFY-CONTAINMENT-ERASURE
 * Appendix B4) and what `exchangeToken` does with it, against the real store check and with the
 * transport stubbed: what it takes for the connect callback's exchange to reach a store, that each
 * condition refuses on its own with all the others met, and that with the switch off the exchange
 * is refused exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '23.227.38.65', family: 4 }]) },
}));

import { ApiStore, type ApiProfile } from '../../core/api-store.js';
import { ExactClearance, type ExactMarker } from '../../core/exact-clearance.js';
import { isStorePass, type StorePass } from '../../core/store-pass.js';
import { setPinnedTransportForTests } from '../../core/network-guard.js';
import { exchangeToken, serializeTokenBody, vetTokenEndpoint, isTokenEndpointRefused } from '../../core/oauth-token-exchange.js';
import { SHOPIFY_FETCH_TOKEN } from '../../core/shopify-host.js';
import type { ToolContext } from '../../core/tool-context.js';
import { storeExchangePassFor } from './http.js';

const ORIGIN = 'https://acme.myshopify.com';
const TOKEN_URL = `${ORIGIN}/admin/oauth/access_token`;
const PARAMS = { client_id: 'cid', client_secret: 'csecret', code: 'c0de' };
const BODY = serializeTokenBody(PARAMS, 'json');
const CALLBACK = { profileId: 'shop-acme', origin: ORIGIN };

function shopProfile(over: { id?: string; shop?: string; preset?: string } = {}): ApiProfile {
  return {
    id: over.id ?? 'shop-acme', name: 'Acme', base_url: ORIGIN, description: 'stub',
    auth: { type: 'oauth2', oauth: { preset_id: over.preset ?? 'shopify', preset_params: { shop: over.shop ?? 'acme' }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET' } },
    custom_endpoint_ack: { accepted: true, hosts: ['acme.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
  } as ApiProfile;
}

let cpCalls: number;
let cpAnswer: () => Response;
let markerSets: number;
let sent: { url: string; body: string | undefined }[];

function clearance(): ExactClearance {
  const marker: ExactMarker = { isSet: () => markerSets > 0, set: () => { markerSets++; } };
  return new ExactClearance(
    { url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 's' },
    marker,
    { fetch: (async () => { cpCalls++; return cpAnswer(); }) as unknown as typeof fetch },
  );
}

function ctx(opts: { profiles?: ApiProfile[]; clearance?: ExactClearance | null; digest?: boolean; local?: boolean } = {}): ToolContext {
  const store = new ApiStore();
  for (const p of opts.profiles ?? [shopProfile()]) store.register(p);
  return {
    apiStore: store,
    exactClearance: opts.clearance === undefined ? clearance() : opts.clearance,
    storeBindingDigest: opts.digest === false ? null : () => 'd',
    // The process's shell mode (`shell-isolation.ts`): a store pass needs the sidecar.
    shellIsolation: opts.local === true ? { kind: 'local' } : { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as never,
  } as unknown as ToolContext;
}

const ENV = {
  LYNOX_SHOPIFY_EXCHANGE: '1',
  LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.example.invalid',
  LYNOX_MANAGED_INSTANCE_ID: 'inst-1',
  LYNOX_HTTP_SECRET: 's',
};

let restore: () => void;
beforeEach(() => {
  cpCalls = 0;
  markerSets = 0;
  sent = [];
  cpAnswer = () => new Response('{"ok":true}', { status: 200 });
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  restore = setPinnedTransportForTests(async (req) => {
    sent.push({ url: req.url, body: req.body?.toString('utf8') });
    return new Response('{"access_token":"shpat_x","scope":"read_products"}', { status: 200 });
  });
});
afterEach(() => { vi.unstubAllEnvs(); restore(); });

const endpoint = (url = TOKEN_URL) => {
  const v = vetTokenEndpoint(url, { accepted: true, hosts: [new URL(url).hostname], accepted_at: '2026-10-18T00:00:00.000Z' });
  if (isTokenEndpointRefused(v)) throw new Error('vetting refused the test endpoint');
  return v;
};
/** The pass for a context where every condition holds; a cause instead fails the test with it. */
const passOf = async (c: ToolContext): Promise<StorePass> => {
  const got = await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, c);
  if (typeof got === 'string') throw new Error(`no pass: ${got}`);
  return got;
};
const exchange = (pass: StorePass | undefined, params: Record<string, string> = PARAMS) =>
  exchangeToken({ endpoint: endpoint(), params, bodyFormat: 'json' }, undefined, undefined, pass);

describe('an exchange that meets every condition', () => {
  it('gets a pass, asks the control plane once, and reaches the store once with its body', async () => {
    const pass = await passOf(ctx());
    expect(isStorePass(pass)).toBe(true);
    expect(pass!.kind).toBe('exchange');
    expect(cpCalls).toBe(1);
    expect(markerSets).toBe(1);
    const r = await exchange(pass);
    expect(r.ok && r.responseOk).toBe(true);
    expect(sent).toEqual([{ url: TOKEN_URL, body: BODY }]);
  });

  it('takes `true` as on, like every other boolean of the env registry', async () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', 'true');
    expect(isStorePass(await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, ctx()))).toBe(true);
  });
});

describe('with the switch off, the exchange is refused as before', () => {
  it.each([['unset', ''], ['yes', 'yes'], ['TRUE', 'TRUE'], ['0', '0'], [' 1', ' 1']])('%s: no pass, no control-plane call, today\'s refusal', async (_l, value) => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', value);
    expect(await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, ctx())).toBe('switched_off');
    expect(cpCalls).toBe(0);
    expect(markerSets).toBe(0);
    const r = await exchange(undefined);
    expect(r).toEqual({ ok: false, message: `token exchange refused: ${SHOPIFY_FETCH_TOKEN}`, unsentForPass: true });
    expect(sent).toHaveLength(0);
  });
});

describe('each condition refuses alone, and names its cause', () => {
  // The cause the exchange gets, and whether the control plane was asked for it.
  const causeOf = async (c: ToolContext, callback = CALLBACK, url = TOKEN_URL): Promise<{ cause: unknown; asked: number }> => {
    const cause = await storeExchangePassFor(callback, url, BODY, c);
    return { cause, asked: cpCalls };
  };

  it.each([
    ['no control-plane env', 'LYNOX_MANAGED_INSTANCE_ID'],
  ])('%s: self-hosted', async (_l, unset) => {
    vi.stubEnv(unset, '');
    expect(await causeOf(ctx())).toEqual({ cause: 'self_hosted', asked: 0 });
  });

  it('no control-plane env and no clearance: self-hosted, not a part missing', async () => {
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', '');
    expect(await causeOf(ctx({ clearance: null, digest: false }))).toEqual({ cause: 'self_hosted', asked: 0 });
  });

  it('a process not in sidecar mode, even with a socket in its env', async () => {
    // The mode is the object built at boot; the env is not asked again here.
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', '/run/lynox/shell.sock');
    expect(await causeOf(ctx({ local: true }))).toEqual({ cause: 'not_set_up', asked: 0 });
  });

  it('no clearance in the tool context', async () => { expect(await causeOf(ctx({ clearance: null }))).toEqual({ cause: 'not_set_up', asked: 0 }); });
  it('no store binding in the tool context', async () => { expect(await causeOf(ctx({ digest: false }))).toEqual({ cause: 'not_set_up', asked: 0 }); });

  it('the profile on the host is another one than the callback\'s', async () => {
    expect(await causeOf(ctx(), { profileId: 'shop-other', origin: ORIGIN })).toEqual({ cause: 'not_this_store', asked: 0 });
  });
  it('no profile on the host', async () => { expect(await causeOf(ctx({ profiles: [] }))).toEqual({ cause: 'not_this_store', asked: 0 }); });
  it('the profile is not the store preset\'s', async () => { expect(await causeOf(ctx({ profiles: [shopProfile({ preset: 'github' })] }))).toEqual({ cause: 'not_this_store', asked: 0 }); });
  it('the profile\'s own parameter derives another store', async () => { expect(await causeOf(ctx({ profiles: [shopProfile({ shop: 'other' })] }))).toEqual({ cause: 'not_this_store', asked: 0 }); });

  it('the callback signed for another store', async () => {
    expect(await causeOf(ctx(), { profileId: 'shop-acme', origin: 'https://other.myshopify.com' })).toEqual({ cause: 'not_this_store', asked: 0 });
  });

  it.each([
    `${ORIGIN}/admin/oauth/access_token?x=1`,
    `${ORIGIN}/admin/oauth/access_token?`,
    `${ORIGIN}/admin/oauth/authorize`,
    `${ORIGIN}/admin/api/2025-10/shop.json`,
    'http://acme.myshopify.com/admin/oauth/access_token',
  ])('the token URL is not the store\'s token endpoint: %s', async (url) => {
    expect(await causeOf(ctx(), CALLBACK, url)).toEqual({ cause: 'not_this_store', asked: 0 });
  });

  it('a refusal of the control plane that still holds (6a): no new call, still a refusal', async () => {
    cpAnswer = () => new Response('{"ok":false,"reason":"below_floor"}', { status: 200 });
    const c = ctx();
    expect(await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, c)).toBe('not_cleared');
    expect(cpCalls).toBe(1);
    expect(await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, c)).toBe('not_cleared');
    expect(cpCalls).toBe(1);
  });

  it('the control plane refuses (6b): no pass and no marker', async () => {
    cpAnswer = () => new Response('{"ok":false,"reason":"below_floor"}', { status: 200 });
    expect(await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, ctx())).toBe('not_cleared');
    expect(cpCalls).toBe(1);
    expect(markerSets).toBe(0);
  });

  // The reason decides, never the time: an unanswered ask backs off for as long as a refusal.
  it('the control plane fails (6b, 5xx): unconfirmed, and still so while its backoff holds (6a)', async () => {
    cpAnswer = () => new Response('', { status: 503 });
    const c = ctx();
    expect(await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, c)).toBe('unconfirmed');
    expect(cpCalls).toBe(1);
    expect(await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, c)).toBe('unconfirmed');
    expect(cpCalls).toBe(1);
    expect(markerSets).toBe(0);
  });

  it('the control plane cannot be reached (6b): unconfirmed', async () => {
    cpAnswer = () => { throw new TypeError('fetch failed'); };
    expect(await storeExchangePassFor(CALLBACK, TOKEN_URL, BODY, ctx())).toBe('unconfirmed');
    expect(markerSets).toBe(0);
  });
});

describe('exchangeToken under the pass', () => {
  it('a credential pass does not open the exchange', async () => {
    const { mintStorePass } = await import('../../core/store-pass.js');
    const r = await exchange(mintStorePass(ORIGIN, 'X-Shopify-Access-Token', 'shpat_x'));
    expect(r).toEqual({ ok: false, message: `token exchange refused: ${SHOPIFY_FETCH_TOKEN}`, unsentForPass: true });
    expect(sent).toHaveLength(0);
  });

  it('a pass minted over one body does not carry another', async () => {
    const pass = await passOf(ctx());
    const r = await exchange(pass, { ...PARAMS, code: 'another' });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('a failed exchange has still set the record: it means "an exchange was sent" (B4)', async () => {
    restore();
    restore = setPinnedTransportForTests(async (req) => {
      sent.push({ url: req.url, body: req.body?.toString('utf8') });
      return new Response('{"error":"invalid_request"}', { status: 400 });
    });
    const pass = await passOf(ctx());
    const r = await exchange(pass);
    expect(r.ok && r.responseOk).toBe(false);
    expect(sent).toHaveLength(1);
    expect(markerSets).toBe(1);
  });

  it('serializes form and JSON as before', () => {
    expect(serializeTokenBody({ a: 'x y', b: '&' }, 'form')).toBe('a=x%20y&b=%26');
    expect(serializeTokenBody({ a: 'x y' }, 'json')).toBe('{"a":"x y"}');
  });
});
