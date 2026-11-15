/**
 * The GraphQL read option of a bulk request carries a read body only. A write body the apply
 * grant minted, sent with that option, is not granted and leaves nothing behind: not sent, not
 * attached, not trailed as a read. `graphqlRead` builds its body itself and only from the read
 * documents, so the body is substituted here at that one seam to reach the check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const seam = vi.hoisted(() => ({ body: null as string | null }));

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '23.227.38.65', family: 4 }]) },
}));

vi.mock('./shopify-graphql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shopify-graphql.js')>();
  return {
    ...actual,
    shopifyReadRequest: (...args: Parameters<typeof actual.shopifyReadRequest>) => {
      const request = actual.shopifyReadRequest(...args);
      return seam.body === null || request === null ? request : { ...request, body: seam.body };
    },
  };
});

import { setPinnedTransportForTests } from './network-guard.js';
import { mintStorePass } from './store-pass.js';
import { externalClient, type ExternalClient } from './bulk-external.js';
import { createToolContext } from './tool-context.js';
import { withShopifyApply } from '../tools/permission-guard.js';
import { shopifyWriteRequest, type ShopifyRead, type ShopifyWrite } from './shopify-graphql.js';
import type { CapabilityContract } from '../types/capability-contract.js';

const HOST = 'acme.myshopify.com';
const ENDPOINT = `https://${HOST}/admin/api/2026-10/graphql.json`;
const H = 'X-Shopify-Access-Token';
const TOKEN = 'shpat_test_value_0003';
const P1 = 'gid://shopify/Product/101';
const R1: ShopifyRead = { form: 'shopify_product_read', gid: P1 };
const W1: ShopifyWrite = { form: 'shopify_product', gid: P1, after: { title: 'Neu' } };
const WRITE_BODY = shopifyWriteRequest(W1)!;
const base: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: [],
  hostPatterns: [HOST], pathPatterns: [], paramConstraints: {},
};
const apply = withShopifyApply(base, HOST, { reads: [P1], writes: [W1] });

let sent: { method: string; body: string | undefined }[];
let attached: string[];
let trailed: string[];
let answer: string;
let restore: () => void;

beforeEach(() => {
  sent = []; attached = []; trailed = [];
  seam.body = null;
  answer = JSON.stringify({ data: { product: { id: P1, title: 'Mug' } } });
  restore = setPinnedTransportForTests(async (req) => {
    sent.push({ method: req.method, body: req.body?.toString('utf8') });
    return new Response(answer, { status: 200 });
  });
});
afterEach(() => restore());

function client(): ExternalClient {
  return externalClient({
    contract: apply,
    hostPolicy: createToolContext({}),
    ackHosts: undefined,
    attach: async (_u, headers, method, out) => {
      attached.push(method);
      headers[H] = TOKEN;
      if (out !== undefined) out.pass = mintStorePass(`https://${HOST}`, H, TOKEN);
      return { id: 'fixture', grantId: 'grant-1' };
    },
    rateLimit: () => null,
    scan: () => null,
    connectedAccount: () => true,
    recordRead: (url) => { trailed.push(url); return true; },
  });
}

describe('the GraphQL read option', () => {
  it('sends the minted read body under the same apply grant (the seam passes it unchanged)', async () => {
    expect((await client().graphqlRead(ENDPOINT, R1)).kind).toBe('ok');
    expect(sent).toHaveLength(1);
    expect(attached).toEqual(['GET']);
    expect(trailed).toEqual([ENDPOINT]);
  });

  it('refuses a minted write body sent as a read: nothing sent, attached or trailed', async () => {
    seam.body = WRITE_BODY;
    expect((await client().graphqlRead(ENDPOINT, R1)).kind).toBe('not_granted');
    expect(sent).toHaveLength(0);
    expect(attached).toEqual([]);
    expect(trailed).toEqual([]);
  });

  it('still sends that body as the write it is', async () => {
    answer = JSON.stringify({ data: { productUpdate: { product: { id: P1 }, userErrors: [] } } });
    expect((await client().graphqlWrite(ENDPOINT, W1)).kind).toBe('ok');
    expect(sent).toEqual([{ method: 'POST', body: WRITE_BODY }]);
    expect(attached).toEqual(['POST']);
    expect(trailed).toEqual([]);
  });
});
