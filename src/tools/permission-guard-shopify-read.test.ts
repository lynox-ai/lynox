import { describe, it, expect } from 'vitest';
import { contractGrants, withShopifyRead } from './permission-guard.js';
import { SHOPIFY_READ_DOCUMENTS, shopifyListBody, shopifyProductReadBody } from '../core/shopify-graphql.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// PRD shopify-preset §19.4: the one exception to "no contract grants a non-GET to a GraphQL
// endpoint", and everything it must still refuse.

const HOST = 'my-store.myshopify.com';
const ENDPOINT = `https://${HOST}/admin/api/2026-10/graphql.json`;
const P1 = 'gid://shopify/Product/101';
const P2 = 'gid://shopify/Product/202';
const base: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: [],
  hostPatterns: [HOST], pathPatterns: [], paramConstraints: {},
};
const JSON_TYPE = { 'content-type': 'application/json' };
const preview = withShopifyRead(base, HOST, { phase: 'read', targets: [P1, P2] });
const listing = withShopifyRead(base, HOST, { phase: 'list', afterId: 500 });
const READ_P1 = shopifyProductReadBody(P1)!;
const LIST_500 = shopifyListBody(500)!;
const post = (contract: CapabilityContract, body: unknown, extra: Record<string, unknown> = {}): boolean =>
  contractGrants('http_request', { method: 'POST', url: ENDPOINT, headers: JSON_TYPE, body, ...extra }, contract);

describe('withShopifyRead — what it grants', () => {
  it('grants the body core builds, byte for byte, in its phase', () => {
    expect(post(preview, READ_P1)).toBe(true);
    expect(post(preview, shopifyProductReadBody(P2))).toBe(true);
    expect(post(listing, LIST_500)).toBe(true);
  });

  it('builds the bodies from its own documents, the variables bound', () => {
    expect(JSON.parse(READ_P1)).toEqual({ query: SHOPIFY_READ_DOCUMENTS.shopify_product_read, variables: { id: P1 } });
    expect(JSON.parse(LIST_500)).toEqual({ query: SHOPIFY_READ_DOCUMENTS.shopify_products_list, variables: { n: 250, q: 'id:>500' } });
  });
});

describe('withShopifyRead — what it refuses', () => {
  it('refuses a call that passes no body: the comparison is never skipped', () => {
    expect(contractGrants('http_request', { method: 'POST', url: ENDPOINT, headers: JSON_TYPE }, preview)).toBe(false);
    expect(contractGrants('http_request', { method: 'POST', url: ENDPOINT }, preview)).toBe(false);
  });

  it('compares the bytes that are sent, not a reading of them', () => {
    expect(post(preview, JSON.parse(READ_P1))).toBe(false);
    expect(post(preview, ` ${READ_P1}`)).toBe(false);
    expect(post(preview, READ_P1.replace('"query":', '"query" :'))).toBe(false);
    expect(post(preview, JSON.stringify({ variables: { id: P1 }, query: SHOPIFY_READ_DOCUMENTS.shopify_product_read }))).toBe(false);
    expect(post(preview, JSON.stringify({ query: SHOPIFY_READ_DOCUMENTS.shopify_product_read, variables: { id: P1 }, operationName: null }))).toBe(false);
    expect(post(preview, JSON.stringify([JSON.parse(READ_P1)]))).toBe(false);
  });

  it('refuses a product outside the targets, and a cursor other than the stored one', () => {
    expect(post(preview, shopifyProductReadBody('gid://shopify/Product/303'))).toBe(false);
    expect(post(listing, shopifyListBody(499))).toBe(false);
    expect(post(listing, JSON.stringify({ query: SHOPIFY_READ_DOCUMENTS.shopify_products_list, variables: { n: 250, q: 'id:>500 OR id:>0' } }))).toBe(false);
  });

  it('holds each form to its phase: the phase is the contract that was minted', () => {
    expect(post(listing, READ_P1)).toBe(false);
    expect(post(preview, LIST_500)).toBe(false);
  });

  it('refuses a document that writes, however the variables match', () => {
    const write = JSON.stringify({ query: 'mutation($id: ID!) { productDelete(input: {id: $id}) { deletedProductId } }', variables: { id: P1 } });
    expect(post(preview, write)).toBe(false);
  });

  it('refuses another address: version, query string, path, host', () => {
    for (const url of [
      `https://${HOST}/admin/api/2025-10/graphql.json`,
      `https://${HOST}/admin/api/unstable/graphql.json`,
      `https://${HOST}/admin/api/graphql.json`,
      `${ENDPOINT}?query=x`,
      `https://other.myshopify.com/admin/api/2026-10/graphql.json`,
    ]) expect(post(preview, READ_P1, { url })).toBe(false);
  });

  it('refuses GET and HEAD on the endpoint, and a method override', () => {
    expect(contractGrants('http_request', { method: 'GET', url: ENDPOINT }, preview)).toBe(false);
    expect(contractGrants('http_request', { method: 'HEAD', url: ENDPOINT }, preview)).toBe(false);
    expect(post(preview, READ_P1, { headers: { ...JSON_TYPE, 'x-http-method-override': 'DELETE' } })).toBe(false);
  });

  it('refuses another media type and a header a reviewed grant does not allow', () => {
    expect(post(preview, READ_P1, { headers: { 'content-type': 'application/graphql' } })).toBe(false);
    expect(post(preview, READ_P1, { headers: {} })).toBe(false);
    expect(post(preview, READ_P1, { headers: { ...JSON_TYPE, host: 'other.myshopify.com' } })).toBe(false);
  });

  it('decides a POST there finally, even under a contract whose methods name POST', () => {
    const withPost = withShopifyRead({ ...base, httpMethods: ['GET', 'POST'], pathPatterns: ['/admin/api/2026-10/graphql.json', '/admin/products'] }, HOST, { phase: 'read', targets: [P1] });
    expect(post(withPost, shopifyProductReadBody(P2))).toBe(false);
    expect(contractGrants('http_request', { method: 'POST', url: `https://${HOST}/admin/products`, headers: JSON_TYPE, body: '{}' }, withPost)).toBe(false);
  });

  it('a contract without the grant, a stored copy included, grants none of it', () => {
    expect(post({ ...base, httpMethods: ['POST'], pathPatterns: ['/admin/api/2026-10/graphql.json'] }, READ_P1)).toBe(false);
    expect(post(JSON.parse(JSON.stringify(preview)) as CapabilityContract, READ_P1)).toBe(false);
    expect(post({ ...preview }, READ_P1)).toBe(false);
  });
});

describe('withShopifyRead — what it mints from', () => {
  it('only a reviewed contract, a store host, a safe cursor and product GIDs', () => {
    expect(() => withShopifyRead({ ...base, origin: 'authorship' }, HOST, { phase: 'list', afterId: 0 })).toThrow(/reviewed/);
    expect(() => withShopifyRead(base, 'shop.example.com', { phase: 'list', afterId: 0 })).toThrow(/store host/);
    expect(() => withShopifyRead(base, HOST, { phase: 'list', afterId: Number.MAX_SAFE_INTEGER + 2 })).toThrow(/safe cursor/);
    expect(() => withShopifyRead(base, HOST, { phase: 'list', afterId: -1 })).toThrow(/safe cursor/);
    expect(() => withShopifyRead(base, HOST, { phase: 'read', targets: [P1, 'gid://shopify/Collection/1'] })).toThrow(/product GIDs/);
    expect(() => withShopifyRead(base, HOST, { phase: 'read', targets: ['gid://shopify/Product/99999999999999999'] })).toThrow(/product GIDs/);
  });
});

describe('the read documents', () => {
  it('each holds one query operation, no fragment, and no word that writes', () => {
    for (const doc of Object.values(SHOPIFY_READ_DOCUMENTS)) {
      expect(doc.startsWith('query(')).toBe(true);
      expect(doc.match(/\bquery\s*\(/g)).toHaveLength(1);
      expect(doc).not.toMatch(/\b(?:mutation|subscription|fragment)\b/i);
      expect(doc).not.toContain('...');
    }
  });
});
