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
import { isStorePass, mintStorePass, storePassRefusal, type StorePass } from './store-pass.js';
import { SHOPIFY_UNAVAILABLE } from './shopify-host.js';

const ORIGIN = 'https://acme.myshopify.com';
const TOKEN = 'shpat_test_value_0001';
const H = 'X-Shopify-Access-Token';

let sent: { url: string; headers: Record<string, string> }[];
let respond: (url: string) => { status: number; headers?: Record<string, string> };
let restore: () => void;

beforeEach(() => {
  sent = [];
  respond = () => ({ status: 200 });
  restore = setPinnedTransportForTests(async (req) => {
    sent.push({ url: req.url, headers: { ...req.headers } });
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
    ]) {
      await expect(send(url, { [H]: TOKEN }, pass()), url).rejects.toThrow(/Admin API|encoded separator/);
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a Host header that names another server', async () => {
    await expect(send(`${ORIGIN}/admin/x`, { [H]: TOKEN, Host: 'other.myshopify.com' }, pass()))
      .rejects.toThrow(/Host header/);
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

describe('storePassRefusal on its own', () => {
  it('names nothing for the verified request', () => {
    expect(storePassRefusal(new URL(`${ORIGIN}/admin/x`), { [H]: TOKEN }, pass())).toBeNull();
  });
});
