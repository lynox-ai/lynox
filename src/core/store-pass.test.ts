/**
 * The store pass at the send (`store-pass.ts`, `fetchPinned`, `fetchWithPublicRedirects`).
 *
 * Every refusal is asserted at `fetchPinned` with the transport stubbed, so a request that
 * got through would reach the stub and be recorded: "refused" means the stub saw nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '23.227.38.65', family: 4 }]) },
}));

import { fetchPinned, fetchWithPublicRedirects, setPinnedTransportForTests } from './network-guard.js';
import { isStorePass, mintStoreExchangePass, mintStorePass, storePassRefusal, type StorePass } from './store-pass.js';
import { SHOPIFY_UNAVAILABLE } from './shopify-host.js';

const ORIGIN = 'https://acme.myshopify.com';
const TOKEN = 'shpat_test_value_0001';
const H = 'X-Shopify-Access-Token';

let sent: { url: string; headers: Record<string, string>; method: string; body: string | undefined }[];
let respond: (url: string) => { status: number; headers?: Record<string, string> };
let restore: () => void;

beforeEach(() => {
  sent = [];
  respond = () => ({ status: 200 });
  restore = setPinnedTransportForTests(async (req) => {
    sent.push({ url: req.url, headers: { ...req.headers }, method: req.method, body: req.body?.toString('utf8') });
    const r = respond(req.url);
    return new Response(r.status === 200 ? '{}' : null, { status: r.status, headers: r.headers });
  });
});
afterEach(() => restore());

const pass = (): StorePass => mintStorePass(ORIGIN, H, TOKEN);
const send = (url: string, headers: Record<string, string>, p: StorePass | undefined): Promise<Response> =>
  fetchPinned(url, { method: 'GET', headers }, p);

describe('without a pass', () => {
  it('a store host is refused as before, and nothing is sent', async () => {
    await expect(send(`${ORIGIN}/admin/api/2025-01/shop.json`, { [H]: TOKEN }, undefined))
      .rejects.toThrow(SHOPIFY_UNAVAILABLE);
    expect(sent).toHaveLength(0);
  });
});

describe('with a pass', () => {
  it('sends the verified request', async () => {
    const res = await send(`${ORIGIN}/admin/api/2025-01/shop.json`, { [H]: TOKEN }, pass());
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('refuses an object of the pass shape that this process did not mint', async () => {
    const forged = { ...pass() };
    expect(isStorePass(forged)).toBe(false);
    await expect(send(`${ORIGIN}/admin/api/2025-01/shop.json`, { [H]: TOKEN }, forged)).rejects.toThrow(/no store pass/);
    expect(sent).toHaveLength(0);
  });

  it('reaches only its own origin: another store, http, another port', async () => {
    for (const url of [
      'https://other.myshopify.com/admin/api/2025-01/shop.json',
      'http://acme.myshopify.com/admin/api/2025-01/shop.json',
      'https://acme.myshopify.com:8443/admin/api/2025-01/shop.json',
    ]) {
      await expect(send(url, { [H]: TOKEN }, pass()), url).rejects.toThrow(/verified store/);
    }
    expect(sent).toHaveLength(0);
  });

  it('compares the host the way DNS reads it: upper case and a trailing dot are the same store', async () => {
    await send('https://ACME.myshopify.com./admin/api/2025-01/shop.json', { [H]: TOKEN }, pass());
    expect(sent).toHaveLength(1);
  });

  it('refuses a host that is not a store at all', async () => {
    await expect(send('https://example.com/admin/x', { [H]: TOKEN }, pass())).rejects.toThrow(/only its own store/);
    expect(sent).toHaveLength(0);
  });

  it('refuses every path outside /admin/, including one that resolves out of it', async () => {
    for (const url of [
      `${ORIGIN}/apps/evil`,
      `${ORIGIN}/admin`,
      `${ORIGIN}/api/2025-01/graphql.json`,
      `${ORIGIN}/admin/../apps/evil`,
      `${ORIGIN}/admin/%2e%2e/apps/evil`,
      `${ORIGIN}/admin/x%2Fy`,
      `${ORIGIN}/admin/x%5Cy`,
      `${ORIGIN}/admin/..;/apps/evil`,
      `${ORIGIN}/admin/x;y`,
      `${ORIGIN}/admin/%252e%252e/apps/evil`,
      `${ORIGIN}/admin/caf%C3%A9`,
    ]) {
      await expect(send(url, { [H]: TOKEN }, pass()), url).rejects.toThrow(/Admin API|encoded character or a matrix segment/);
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a Host header, whether it names another server or the same one', async () => {
    await expect(send(`${ORIGIN}/admin/x`, { [H]: TOKEN, Host: 'other.myshopify.com' }, pass()))
      .rejects.toThrow(/re-targets/);
    await expect(send(`${ORIGIN}/admin/x`, { [H]: TOKEN, Host: 'acme.myshopify.com' }, pass()))
      .rejects.toThrow(/re-targets/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a header that re-targets the request, on a read as well', async () => {
    for (const name of ['X-Original-URL', 'x-rewrite-url', 'X-Forwarded-Host', 'X-Forwarded-Prefix']) {
      await expect(send(`${ORIGIN}/admin/x`, { [H]: TOKEN, [name]: '/apps/evil' }, pass()), name).rejects.toThrow(/re-targets/);
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a value that is not the verified one', async () => {
    await expect(send(`${ORIGIN}/admin/x`, { [H]: 'shpat_test_value_0002' }, pass())).rejects.toThrow(/not the one that was verified/);
    expect(sent).toHaveLength(0);
  });

  it('refuses no credential, a second credential header, or the value under another credential header', async () => {
    for (const headers of [
      {},
      { [H]: TOKEN, Authorization: 'Bearer x' },
      { [H]: TOKEN, 'x-shopify-access-token': TOKEN },
      { Authorization: TOKEN },
      { [H]: TOKEN, Cookie: 'a=b' },
    ]) {
      await expect(send(`${ORIGIN}/admin/x`, headers, pass()), JSON.stringify(Object.keys(headers)))
        .rejects.toThrow(/exactly the verified credential/);
    }
    expect(sent).toHaveLength(0);
  });

  it('matches the header name in any case', async () => {
    await send(`${ORIGIN}/admin/x`, { 'x-SHOPIFY-access-TOKEN': TOKEN }, pass());
    expect(sent).toHaveLength(1);
  });
});

describe('every redirect hop is checked under the pass', () => {
  it('a same-store redirect out of /admin/ never carries the token there', async () => {
    respond = (url) => (url.includes('/admin/') ? { status: 302, headers: { location: '/apps/evil' } } : { status: 200 });
    await expect(fetchWithPublicRedirects(`${ORIGIN}/admin/x`, { headers: { [H]: TOKEN } }, { pass: pass() }))
      .rejects.toThrow(/Admin API/);
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(['/admin/x']);
  });

  it('a redirect to another store is refused, not just stripped', async () => {
    respond = (url) => (url.startsWith(ORIGIN) ? { status: 302, headers: { location: 'https://other.myshopify.com/admin/x' } } : { status: 200 });
    await expect(fetchWithPublicRedirects(`${ORIGIN}/admin/x`, { headers: { [H]: TOKEN } }, { pass: pass() }))
      .rejects.toThrow(/verified store|exactly the verified credential/);
    expect(sent).toHaveLength(1);
  });

  it('a redirect within /admin/ of the same store goes through', async () => {
    respond = (url) => (url.endsWith('/admin/x') ? { status: 301, headers: { location: '/admin/y' } } : { status: 200 });
    const res = await fetchWithPublicRedirects(`${ORIGIN}/admin/x`, { headers: { [H]: TOKEN } }, { pass: pass() });
    expect(res.status).toBe(200);
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(['/admin/x', '/admin/y']);
  });
});

describe('the tool send (fetchWithValidatedRedirects) carries the pass to every hop', () => {
  it('sends the verified request and refuses a same-store redirect out of /admin/', async () => {
    const { fetchWithValidatedRedirects } = await import('../tools/builtin/http.js');
    const ride = (url: string): ReturnType<typeof fetchWithValidatedRedirects> =>
      fetchWithValidatedRedirects(url, { method: 'GET', headers: { [H]: TOKEN } }, { surface: 'full-control' }, undefined, undefined, undefined, undefined, undefined, pass());
    respond = () => ({ status: 200 });
    expect((await ride(`${ORIGIN}/admin/x`)).response.status).toBe(200);
    respond = (url) => (url.includes('/admin/') ? { status: 302, headers: { location: '/apps/evil' } } : { status: 200 });
    sent = [];
    await expect(ride(`${ORIGIN}/admin/x`)).rejects.toThrow(/Admin API/);
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(['/admin/x']);
  });
});

describe('storePassRefusal on its own', () => {
  it('names nothing for the verified request', () => {
    expect(storePassRefusal(new URL(`${ORIGIN}/admin/x`), { [H]: TOKEN }, pass())).toBeNull();
  });
});

describe('a bulk run\'s send (bulk-external) carries the pass its attach minted', () => {
  it('reads the store under the pass, and the same read without one is refused', async () => {
    const { externalClient, mintBulkContract } = await import('./bulk-external.js');
    const { createToolContext } = await import('./tool-context.js');
    const target = `${ORIGIN}/admin/api/2025-01/products/1.json`;
    const c = (mint: boolean): ReturnType<typeof externalClient> => externalClient({
      contract: mintBulkContract('acme.myshopify.com', [target]),
      hostPolicy: createToolContext({}),
      ackHosts: undefined,
      attach: async (_u, headers, _m, out) => {
        headers[H] = TOKEN;
        if (mint && out !== undefined) out.pass = pass();
        return { id: 'fixture', grantId: 'grant-1' };
      },
      rateLimit: () => null,
      scan: () => null,
      connectedAccount: () => false,
      recordRead: null,
    });
    expect((await c(true).get(target)).kind).toBe('ok');
    expect(sent).toHaveLength(1);
    expect((await c(false).get(target)).kind).not.toBe('ok');
    expect(sent).toHaveLength(1);
  });
});

describe('the token exchange\'s pass (kind exchange)', () => {
  const TOKEN_URL = `${ORIGIN}/admin/oauth/access_token`;
  const BODY = 'client_id=cid&client_secret=csecret&code=c0de';
  const FORM = { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
  const xpass = (): StorePass => mintStoreExchangePass(ORIGIN, BODY);
  const post = (url: string, p: StorePass, init: RequestInit = {}): Promise<Response> =>
    fetchPinned(url, { method: 'POST', headers: FORM, body: BODY, ...init }, p);

  it('sends exactly the exchange it was minted for, once', async () => {
    const res = await post(TOKEN_URL, xpass());
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(BODY);
    expect(sent[0]!.method).toBe('POST');
  });

  it('refuses a second request under the same pass, the same request included', async () => {
    const p = xpass();
    await post(TOKEN_URL, p);
    await expect(post(TOKEN_URL, p)).rejects.toThrow(/sends one request/);
    expect(sent).toHaveLength(1);
  });

  it('refuses another body, the same fields in another order included', async () => {
    for (const body of ['client_id=cid&client_secret=csecret&code=other', 'code=c0de&client_id=cid&client_secret=csecret', '']) {
      await expect(post(TOKEN_URL, xpass(), { body }), body).rejects.toThrow(/not the token exchange that was verified/);
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a body that is not a string', async () => {
    await expect(post(TOKEN_URL, xpass(), { body: Buffer.from(BODY) })).rejects.toThrow(/as a string/);
    await expect(post(TOKEN_URL, xpass(), { body: new Blob([BODY]) })).rejects.toThrow(/as a string/);
    expect(sent).toHaveLength(0);
  });

  it('reaches only the token endpoint: no other path, no query', async () => {
    for (const url of [
      `${ORIGIN}/admin/oauth/access_token/x`,
      `${ORIGIN}/admin/oauth/access_tokens`,
      `${ORIGIN}/admin/api/2025-01/shop.json`,
      `${ORIGIN}/admin/oauth/access_token?x=1`,
      `${ORIGIN}/admin/oauth/access_token?`,
      `${ORIGIN}/admin/oauth/%61ccess_token`,
    ]) {
      await expect(post(url, xpass()), url).rejects.toThrow(/only the store's token endpoint/);
    }
    expect(sent).toHaveLength(0);
  });

  it('reaches only its own store', async () => {
    await expect(post('https://other.myshopify.com/admin/oauth/access_token', xpass())).rejects.toThrow(/verified store/);
    expect(sent).toHaveLength(0);
  });

  it('sends only a POST', async () => {
    await expect(fetchPinned(TOKEN_URL, { method: 'GET', headers: FORM }, xpass())).rejects.toThrow(/only the token exchange/);
    await expect(post(TOKEN_URL, xpass(), { method: 'PUT' })).rejects.toThrow(/only the token exchange/);
    expect(sent).toHaveLength(0);
  });

  it('carries no credential header and no header that re-targets it', async () => {
    await expect(post(TOKEN_URL, xpass(), { headers: { ...FORM, Authorization: 'Basic x' } })).rejects.toThrow(/no credential header/);
    await expect(post(TOKEN_URL, xpass(), { headers: { ...FORM, [H]: TOKEN } })).rejects.toThrow(/no credential header/);
    await expect(post(TOKEN_URL, xpass(), { headers: { ...FORM, 'X-Forwarded-Host': 'evil.example' } })).rejects.toThrow(/re-targets/);
    expect(sent).toHaveLength(0);
  });

  it('a 307 or 308 back to the token endpoint does not send the exchange a second time', async () => {
    const { fetchWithValidatedRedirects } = await import('../tools/builtin/http.js');
    for (const status of [307, 308]) {
      sent = [];
      respond = () => (sent.length === 1 ? { status, headers: { location: '/admin/oauth/access_token' } } : { status: 200 });
      // The redirect loop refuses a hop back to the very target before the pass is asked; the
      // pass's own one request is held above (a second `post`) and below (the public loop).
      await expect(fetchWithValidatedRedirects(TOKEN_URL, { method: 'POST', headers: FORM, body: BODY }, { surface: 'full-control' },
        undefined, undefined, undefined, undefined, undefined, xpass()), String(status)).rejects.toThrow(/would send the same write again/);
      expect(sent, String(status)).toHaveLength(1);
      sent = [];
      await expect(fetchWithPublicRedirects(TOKEN_URL, { method: 'POST', headers: FORM, body: BODY }, { pass: xpass() }), String(status))
        .rejects.toThrow(/sends one request/);
      expect(sent, String(status)).toHaveLength(1);
    }
  });

  it('an exchange pass does not carry an Admin request, and a credential pass does not carry the exchange as it is sent', async () => {
    await expect(fetchPinned(`${ORIGIN}/admin/x`, { method: 'GET', headers: { [H]: TOKEN } }, xpass())).rejects.toThrow(/only the store's token endpoint/);
    await expect(post(TOKEN_URL, pass())).rejects.toThrow(/exactly the verified credential/);
    expect(sent).toHaveLength(0);
  });

  it('refuses an object of its shape that this process did not mint', async () => {
    await expect(post(TOKEN_URL, { ...xpass() })).rejects.toThrow(/no store pass/);
    expect(sent).toHaveLength(0);
  });

  it('storePassRefusal names nothing for the exchange, before its body is read', () => {
    expect(storePassRefusal(new URL(TOKEN_URL), FORM, xpass(), 'POST')).toBeNull();
  });
});
