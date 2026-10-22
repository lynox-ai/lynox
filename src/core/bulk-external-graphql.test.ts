/**
 * A bulk run's GraphQL read (`ExternalClient.graphqlRead`, PRD shopify-preset §19.3/§19.4):
 * a POST that is a read — granted only as the exact body the engine built, attached and
 * trailed as a read — and an answer that GraphQL's own errors decide, not the HTTP status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '23.227.38.65', family: 4 }]) },
}));

import { setPinnedTransportForTests } from './network-guard.js';
import { mintStorePass } from './store-pass.js';
import { externalClient, graphqlAnswer, type ExternalClient } from './bulk-external.js';
import { createToolContext } from './tool-context.js';
import { withShopifyRead } from '../tools/permission-guard.js';
import { shopifyProductReadBody } from './shopify-graphql.js';
import type { CapabilityContract } from '../types/capability-contract.js';

const HOST = 'acme.myshopify.com';
const ENDPOINT = `https://${HOST}/admin/api/2026-10/graphql.json`;
const TOKEN = 'shpat_test_value_0002';
const H = 'X-Shopify-Access-Token';
const P1 = 'gid://shopify/Product/101';
const BODY = shopifyProductReadBody(P1)!;
const base: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: [],
  hostPatterns: [HOST], pathPatterns: [], paramConstraints: {},
};

let sent: { url: string; method: string; headers: Record<string, string>; body: string | undefined }[];
let answer: { status: number; body: string; headers?: Record<string, string> };
let restore: () => void;

beforeEach(() => {
  sent = [];
  answer = { status: 200, body: JSON.stringify({ data: { product: { id: P1, title: 'Mug' } } }) };
  restore = setPinnedTransportForTests(async (req) => {
    sent.push({ url: req.url, method: req.method, headers: { ...req.headers }, body: req.body?.toString('utf8') });
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  });
});
afterEach(() => restore());

function client(opts: { contract?: CapabilityContract; methods?: string[]; recordRead?: ((url: string, detail?: string) => boolean) | null } = {}): ExternalClient {
  return externalClient({
    contract: opts.contract ?? withShopifyRead(base, HOST, { phase: 'read', targets: [P1] }),
    hostPolicy: createToolContext({}),
    ackHosts: undefined,
    attach: async (_u, headers, method, out) => {
      opts.methods?.push(method);
      headers[H] = TOKEN;
      if (out !== undefined) out.pass = mintStorePass(`https://${HOST}`, H, TOKEN);
      return { id: 'fixture', grantId: 'grant-1' };
    },
    rateLimit: () => null,
    scan: () => null,
    // A preset profile: the account is connected, where an unmeasured write is refused.
    connectedAccount: () => true,
    recordRead: opts.recordRead ?? null,
  });
}

describe('graphqlRead — the request', () => {
  it('posts the granted body unchanged, attached as a read, on a connected account', async () => {
    const methods: string[] = [];
    const read = await client({ methods }).graphqlRead(ENDPOINT, BODY, `shopify_product_read ${P1}`);
    expect(read).toEqual({ kind: 'ok', value: { product: { id: P1, title: 'Mug' } }, bytes: Buffer.byteLength(answer.body) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: ENDPOINT, method: 'POST', body: BODY });
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(methods).toEqual(['GET']);
  });

  it('sends nothing for a body the contract did not mint, or under a contract without the grant', async () => {
    expect((await client().graphqlRead(ENDPOINT, shopifyProductReadBody('gid://shopify/Product/202')!, 'x')).kind).toBe('not_granted');
    const plain: CapabilityContract = { ...base, httpMethods: ['POST'], pathPatterns: ['/admin/api/2026-10/graphql.json'] };
    expect((await client({ contract: plain }).graphqlRead(ENDPOINT, BODY, 'x')).kind).toBe('not_granted');
    expect(sent).toHaveLength(0);
  });

  it('records the read with its form and bound value before it is sent, and sends nothing unrecorded', async () => {
    const rows: [string, string | undefined][] = [];
    await client({ recordRead: (url, detail) => { rows.push([url, detail]); return true; } }).graphqlRead(ENDPOINT, BODY, `shopify_product_read ${P1}`);
    expect(rows).toEqual([[ENDPOINT, `shopify_product_read ${P1}`]]);
    expect((await client({ recordRead: () => false }).graphqlRead(ENDPOINT, BODY, 'x')).kind).toBe('unrecorded');
    expect(sent).toHaveLength(1);
  });

  it('caps the answer like a GET', async () => {
    answer = { status: 200, body: JSON.stringify({ data: { product: { id: P1, title: 'x'.repeat(2000) } } }) };
    expect((await client().graphqlRead(ENDPOINT, BODY, 'x', undefined, 1000)).kind).toBe('too_large');
  });
});

describe('graphqlRead — the answer (§19.3)', () => {
  const err = (...codes: (string | undefined)[]): string =>
    JSON.stringify({ data: { product: { id: P1, title: null } }, errors: codes.map((code) => ({ message: 'provider text', ...(code ? { extensions: { code } } : {}) })) });

  it.each([
    ['ACCESS_DENIED', 'unauthorized'],
    ['SHOP_INACTIVE', 'shop_inactive'],
    ['MAX_COST_EXCEEDED', 'form_cost'],
    ['INTERNAL_SERVER_ERROR', 'failed'],
    ['SOMETHING_NEW', 'graphql_error'],
    [undefined, 'graphql_error'],
  ])('a 200 with %s is %s, its partial data unused', async (code, kind) => {
    answer = { status: 200, body: err(code) };
    expect(await client().graphqlRead(ENDPOINT, BODY, 'x')).toEqual({ kind });
  });

  it('THROTTLED waits as a 429 does, Retry-After honoured', async () => {
    answer = { status: 200, body: err('THROTTLED'), headers: { 'retry-after': '3' } };
    expect(await client().graphqlRead(ENDPOINT, BODY, 'x')).toEqual({ kind: 'retry_after', ms: 3000 });
  });

  it('several codes: the first of the table decides, not the first in the answer', async () => {
    answer = { status: 200, body: err('SOMETHING_NEW', 'INTERNAL_SERVER_ERROR', 'ACCESS_DENIED', 'THROTTLED') };
    expect((await client().graphqlRead(ENDPOINT, BODY, 'x')).kind).toBe('retry_after');
    answer = { status: 200, body: err('INTERNAL_SERVER_ERROR', 'MAX_COST_EXCEEDED') };
    expect((await client().graphqlRead(ENDPOINT, BODY, 'x')).kind).toBe('form_cost');
  });

  it('HTTP decides before the body, and an empty errors list is no error', async () => {
    answer = { status: 401, body: err('THROTTLED') };
    expect((await client().graphqlRead(ENDPOINT, BODY, 'x')).kind).toBe('unauthorized');
    answer = { status: 200, body: JSON.stringify({ data: { product: null }, errors: [] }) };
    expect(await client().graphqlRead(ENDPOINT, BODY, 'x')).toMatchObject({ kind: 'ok', value: { product: null } });
  });

  it('an answer that is not one object is an error, not data', () => {
    for (const value of [null, [], 'x', 3]) expect(graphqlAnswer({ kind: 'ok', value }, null, 0)).toEqual({ kind: 'graphql_error' });
    expect(graphqlAnswer({ kind: 'ok', value: { errors: 'oops', data: { a: 1 } } }, null, 0)).toEqual({ kind: 'graphql_error' });
  });
});

describe('the worker\'s trail row of a GraphQL read', () => {
  it('names the POST to the endpoint and the form with its bound value; a GET stays as it was', async () => {
    const { bulkReadRecorder } = await import('./worker-loop.js');
    const { httpTarget } = await import('./audit-log.js');
    const rows: string[] = [];
    const recorderOf = (() => (target: string) => { rows.push(target); }) as unknown as Parameters<typeof bulkReadRecorder>[2];
    const record = bulkReadRecorder({ id: 'run-1', delegatedPlanner: { kind: 'mandate', email: 'h@example.invalid', mandateId: 'g-1' } } as Parameters<typeof bulkReadRecorder>[0], null, recorderOf, httpTarget)!;
    expect(record(ENDPOINT, `shopify_product_read ${P1}`)).toBe(true);
    expect(record(`https://${HOST}/admin/api/2026-10/products/1.json`)).toBe(true);
    expect(rows).toEqual([
      `POST ${HOST}/admin/api/2026-10/graphql.json shopify_product_read ${P1}`,
      httpTarget('GET', `https://${HOST}/admin/api/2026-10/products/1.json`),
    ]);
  });
});
