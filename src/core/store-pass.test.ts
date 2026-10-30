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

  it('does not carry the bound token to the store\'s token endpoint in any spelling a URL keeps', async () => {
    for (const [path, reason] of [
      ['/admin/oauth/access_token', /OAuth endpoints/],
      ['/admin//oauth/access_token', /not for the Admin API/],
      ['/admin/oauth//access_token', /not for the Admin API/],
      ['/admin/OAuth/access_token', /not for the Admin API/],
      ['/ADMIN/oauth/access_token', /not for the Admin API/],
      ['/admin/oauth/access_token.json', /OAuth endpoints/],
      ['/admin/oauth/access_token/', /not for the Admin API/],
      ['/admin/api/2025-01/oauth/access_token', /OAuth endpoints/],
      ['/admin/oauth.json', /OAuth endpoints/],
      ['/admin/oauth/authorize', /OAuth endpoints/],
      ['/admin/./oauth/access_token', /OAuth endpoints/],
      ['/admin/api/../oauth/access_token', /OAuth endpoints/],
      ['/admin\\oauth/access_token', /OAuth endpoints/],
    ] as const) {
      for (const method of ['GET', 'POST']) {
        await expect(fetchPinned(`${ORIGIN}${path}`, { method, headers: { [H]: TOKEN } }, pass()), `${method} ${path}`).rejects.toThrow(reason);
      }
    }
    expect(sent).toHaveLength(0);
  });

  it('reaches the Admin API in the shapes it has, and the read of the token\'s own scopes', async () => {
    const paths = [
      '/admin/oauth/access_scopes.json',
      '/admin/api/2025-10/graphql.json',
      '/admin/api/unstable/graphql.json',
      '/admin/api/2026-01/products/632910392/images.json',
      '/admin/api/2025-10/shopify_payments/balance.json',
      '/admin/products.json',
    ];
    for (const path of paths) await expect(send(`${ORIGIN}${path}`, { [H]: TOKEN }, pass()), path).resolves.toHaveProperty('status', 200);
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(paths);
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

describe('a credential pass does not reach the store\'s access tokens', () => {
  const GRAPHQL = `${ORIGIN}/admin/api/2025-10/graphql.json`;
  const JSON_TYPE = { 'Content-Type': 'application/json' };
  const post = (url: string, body: string, headers: Record<string, string> = JSON_TYPE): Promise<Response> =>
    fetchPinned(url, { method: 'POST', headers: { [H]: TOKEN, ...headers }, body }, pass());
  const query = (document: string): string => JSON.stringify({ query: document });

  it('refuses the REST paths that mint, list or revoke a token, by every method', async () => {
    for (const path of [
      '/admin/api/2025-10/storefront_access_tokens.json',
      '/admin/api/2025-10/storefront_access_tokens/1.json',
      '/admin/storefront_access_tokens.json',
      '/admin/access_tokens/delegate.json',
      '/admin/api/2025-10/access_tokens/delegate.json',
    ]) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        await expect(fetchPinned(`${ORIGIN}${path}`, { method, headers: { [H]: TOKEN } }, pass()), `${method} ${path}`)
          .rejects.toThrow(/does not reach the store's access tokens/);
      }
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a GraphQL document that names a token field, however it is written', async () => {
    const documents: [string, string][] = [
      ['mutation, delegate', query('mutation { delegateAccessTokenCreate(input: { delegateAccessScope: ["read_products"] }) { delegateAccessToken { accessToken } } }')],
      ['mutation, storefront', query('mutation { storefrontAccessTokenCreate(input: { title: "x" }) { storefrontAccessToken { accessToken } } }')],
      ['read', query('{ shop { storefrontAccessTokens(first: 1) { nodes { accessToken } } } }')],
      ['alias', query('query { a: storefrontAccessTokens(first: 1) { nodes { t: id } } }')],
      ['fragment', query('query { shop { ...f } } fragment f on Shop { storefrontAccessTokens(first: 1) { nodes { id } } }')],
      ['node by id', query('query($id: ID!) { node(id: $id) { ... on StorefrontAccessToken { accessToken } } }')],
      ['JSON escape', '{"query":"{ shop { storefront\\u0041ccessTokens(first: 1) { nodes { id } } } }"}'],
      ['nested document, escaped in its string literal',
        '{"query":"mutation{bulkOperationRunQuery(query:\\"{shop{storefront\\\\u0041ccessTokens{edges{node{\\\\u0061ccessToken}}}}}\\"){bulkOperation{id}}}"}'],
      ['nested, escaped in the middle of the word',
        '{"query":"mutation{bulkOperationRunQuery(query:\\"{shop{storefrontAcc\\\\u0065ssTokens{edges{node{id}}}}}\\"){bulkOperation{id}}}"}'],
      ['an escape that writes the backslash of the next one', '{"query":"{ shop { storefront\\\\u005cu0041ccessTokens { nodes { id } } } }"}'],
      ['nested, braced escape', query('mutation { bulkOperationRunQuery(query: "{ shop { storefront\\u{41}ccessTokens { edges { node { id } } } } }") { bulkOperation { id } } }')],
      ['in the variables', JSON.stringify({ query: 'query($q: String!) { shop { name } }', variables: { q: 'access_token' } })],
      ['in a key', '{"query":"{ shop { name } }","variables":{"accessToken":1}}'],
    ];
    for (const [label, body] of documents) {
      await expect(post(GRAPHQL, body), label).rejects.toThrow(/the body contains access_token or accessToken/);
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a GraphQL document in the address', async () => {
    for (const url of [
      `${GRAPHQL}?query=${encodeURIComponent('{ shop { storefrontAccessTokens(first: 1) { nodes { id } } } }')}`,
      `${GRAPHQL}?query=%7Bshop%7Bstorefront%41ccessTokens%7D%7D`,
    ]) {
      await expect(send(url, { [H]: TOKEN }, pass()), url).rejects.toThrow(/the address names an access token/);
    }
    await expect(send(`${GRAPHQL}?extensions=%7B%22persistedQuery%22%3A1%7D`, { [H]: TOKEN }, pass())).rejects.toThrow(/persisted query/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a persisted query, a body that is not JSON, and a body it could not read as sent', async () => {
    await expect(post(GRAPHQL, '{"extensions":{"persistedQuery":{"version":1,"sha256Hash":"ab"}}}')).rejects.toThrow(/persisted query/);
    await expect(post(GRAPHQL, '{"extensions":{"persisted\\u0051uery":{"version":1,"sha256Hash":"ab"}}}')).rejects.toThrow(/persisted query/);
    await expect(post(GRAPHQL, '{/**/"query":"{ shop { storefrontAccessTokens { nodes { id } } } }"}')).rejects.toThrow(/sends its body as JSON/);
    await expect(post(GRAPHQL, query('{ shop { name } }'), { ...JSON_TYPE, 'Content-Encoding': 'gzip' })).rejects.toThrow(/sent encoded/);
    expect(sent).toHaveLength(0);
  });

  it('sends a body only as one Content-Type, application/json', async () => {
    const ONE_JSON = /sends one Content-Type, application\/json/;
    const document = query('{ shop { name } }');
    for (const headers of [
      { 'Content-Type': 'application/graphql' },
      { 'Content-Type': 'application/json; charset=utf-16' },
      { 'Content-Type': 'application/json; charset=utf-8; charset=utf-7' },
      { 'Content-Type': 'application/json; charset*=utf-7\'\'' },
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      { 'Content-Type': 'application/json', 'content-type': 'application/json' },
      { 'Content-Type': ' application/json' },
    ]) {
      await expect(post(GRAPHQL, document, headers), JSON.stringify(headers)).rejects.toThrow(ONE_JSON);
    }
    // A JSON body that a form type would read as a query naming the token.
    await expect(post(GRAPHQL, '{"x":"&query=%7Bshop%7Bstorefront%41ccessTokens%7D%7D&y="}', { 'Content-Type': 'application/x-www-form-urlencoded' }))
      .rejects.toThrow(ONE_JSON);
    // A Content-Type is held to the list on a read as well.
    await expect(send(`${ORIGIN}/admin/api/2025-10/shop.json`, { [H]: TOKEN, 'Content-Type': 'text/plain' }, pass())).rejects.toThrow(ONE_JSON);
    // A body with no Content-Type: Rack reads a POST without one as a form.
    await expect(post(GRAPHQL, document, {})).rejects.toThrow(ONE_JSON);
    expect(sent).toHaveLength(0);
  });

  it('looks for the word in the text as sent too, where resolving an escape eats the letters after it', async () => {
    await expect(post(GRAPHQL, JSON.stringify({ query: '{ shop { name } }', variables: { v: '\\u{0000005c}u\\u{61}accesstoken' } })))
      .rejects.toThrow(/the body contains access_token or accessToken/);
    await expect(send(`${GRAPHQL}?v=${encodeURIComponent('\\u{0000005c}u\\u{61}accesstoken')}`, { [H]: TOKEN }, pass()))
      .rejects.toThrow(/the address names an access token/);
    expect(sent).toHaveLength(0);
  });

  it('reads an escape with leading zeros in braces, and a long run of backslashes in one pass', async () => {
    await expect(post(GRAPHQL, '{"query":"mutation{bulkOperationRunQuery(query:\\"{shop{storefront\\\\u{00000041}ccessTokens{edges{node{id}}}}}\\"){bulkOperation{id}}}"}'))
      .rejects.toThrow(/the body contains access_token or accessToken/);
    const run = JSON.stringify({ query: '{ shop { name } }', variables: { v: '\\'.repeat(200_000) } });
    const started = performance.now();
    await expect(post(GRAPHQL, run)).resolves.toHaveProperty('status', 200);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(sent).toHaveLength(1);
  });

  it('tells the model to stop on a token, and how to send it again on a form it cannot read (ux U-086)', async () => {
    const STOP = /tell the user that lynox does not create or read access tokens through the connected store\. Do not retry it with changed headers or a changed address\.$/;
    const AGAIN = /\. Send it again as JSON text with exactly one Content-Type: application\/json header, no Content-Encoding, and the full query text instead of a persisted query\.$/;
    await expect(send(`${ORIGIN}/admin/api/2025-10/storefront_access_tokens.json`, { [H]: TOKEN }, pass())).rejects.toThrow(STOP);
    await expect(send(`${GRAPHQL}?query=${encodeURIComponent('{ shop { storefrontAccessTokens { nodes { id } } } }')}`, { [H]: TOKEN }, pass())).rejects.toThrow(STOP);
    await expect(post(GRAPHQL, query('{ shop { name } }'), {})).rejects.toThrow(AGAIN);
    await expect(post(GRAPHQL, query('{ shop { name } }'), { ...JSON_TYPE, 'Content-Encoding': 'gzip' })).rejects.toThrow(AGAIN);
    await expect(post(GRAPHQL, '{ shop { name } }')).rejects.toThrow(AGAIN);
    await expect(post(GRAPHQL, '{"extensions":{"persistedQuery":{"version":1}}}')).rejects.toThrow(AGAIN);
    await expect(send(`${GRAPHQL}?extensions=%7B%22persistedQuery%22%3A1%7D`, { [H]: TOKEN }, pass())).rejects.toThrow(AGAIN);
    // The token word in a body is named, with what to do when it is only text.
    await expect(post(GRAPHQL, JSON.stringify({ query: 'mutation { productUpdate(product: { id: "1", descriptionHtml: "accessToken" }) { product { id } } }' })))
      .rejects.toThrow(/If it is only text, tell the user which field contains it; the request cannot be sent while it does\. Do not retry it with changed headers or a changed address\.$/);
    expect(sent).toHaveLength(0);
  });

  it('sends what names no token: a read, a write, a REST call, an empty body, UTF-8 named and identity', async () => {
    const bodies = [
      query('{ shop { name } }'),
      query('mutation { productUpdate(product: { id: "gid://shopify/Product/1", title: "Tokens of access" }) { product { id } } }'),
      JSON.stringify({ query: 'query($id: ID!) { product(id: $id) { id title } }', variables: { id: 'gid://shopify/Product/1' } }),
    ];
    for (const body of bodies) await expect(post(GRAPHQL, body), body).resolves.toHaveProperty('status', 200);
    await expect(post(`${ORIGIN}/admin/api/2025-10/products/1.json`, JSON.stringify({ product: { title: 'x' } }), { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Encoding': 'identity' }))
      .resolves.toHaveProperty('status', 200);
    await expect(fetchPinned(`${ORIGIN}/admin/api/2025-10/products/1.json`, { method: 'DELETE', headers: { [H]: TOKEN }, body: '' }, pass()))
      .resolves.toHaveProperty('status', 200);
    await expect(send(`${ORIGIN}/admin/api/2025-10/products.json?limit=5&fields=id,title`, { [H]: TOKEN }, pass())).resolves.toHaveProperty('status', 200);
    expect(sent).toHaveLength(bodies.length + 3);
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

  it('an exchange the redirect loop refuses comes back to the connect callback as a failed exchange, with the loop\'s reason', async () => {
    const { exchangeToken, vetTokenEndpoint, isTokenEndpointRefused } = await import('./oauth-token-exchange.js');
    const endpoint = vetTokenEndpoint(TOKEN_URL, { accepted: true, hosts: ['acme.myshopify.com'] });
    if (isTokenEndpointRefused(endpoint)) throw new Error('fixture is not vetted');
    respond = () => (sent.length === 1 ? { status: 307, headers: { location: '/admin/oauth/access_token' } } : { status: 200 });
    const result = await exchangeToken(
      { endpoint, params: { client_id: 'cid', client_secret: 'csecret', code: 'c0de' }, bodyFormat: 'form' },
      undefined, undefined, xpass(),
    );
    // This message is what reaches the callback, which does not render it (http-api.test.ts).
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/would send the same write again/);
    expect(sent).toHaveLength(1);
  });

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
    await expect(post(TOKEN_URL, pass())).rejects.toThrow(/does not reach the store's OAuth endpoints/);
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
