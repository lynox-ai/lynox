import { describe, it, expect } from 'vitest';
import { contractGrants, withShopifyRead } from './permission-guard.js';
import { SHOPIFY_READ_DOCUMENTS, shopifyListBody, shopifyProductReadBody } from '../core/shopify-graphql.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// The one exception to "no contract grants a non-GET to a GraphQL
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
const listing = withShopifyRead(base, HOST, { phase: 'list', afterId: 500, filters: {} });
const READ_P1 = shopifyProductReadBody(P1)!;
const LIST_500 = shopifyListBody(500, {})!;
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
    expect(post(listing, shopifyListBody(499, {}))).toBe(false);
    expect(post(listing, JSON.stringify({ query: SHOPIFY_READ_DOCUMENTS.shopify_products_list, variables: { n: 250, q: 'id:>500 OR id:>0' } }))).toBe(false);
  });

  it('holds each form to its phase: the phase is the contract that was minted', () => {
    expect(post(listing, READ_P1)).toBe(false);
    expect(post(preview, LIST_500)).toBe(false);
  });

  // Refused by the byte comparison already; `graphqlWrite`'s word search is a second layer that
  // no body the engine builds can reach.
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
    // Not only for want of a body: the granted body and headers on another verb are refused too.
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH']) expect(contractGrants('http_request', { method, url: ENDPOINT, headers: JSON_TYPE, body: READ_P1 }, preview)).toBe(false);
    expect(post(preview, READ_P1, { headers: { ...JSON_TYPE, 'x-http-method-override': 'DELETE' } })).toBe(false);
  });

  it('refuses another media type and a header a reviewed grant does not allow', () => {
    expect(post(preview, READ_P1, { headers: { 'content-type': 'application/graphql' } })).toBe(false);
    expect(post(preview, READ_P1, { headers: {} })).toBe(false);
    expect(post(preview, READ_P1, { headers: { ...JSON_TYPE, host: 'other.myshopify.com' } })).toBe(false);
  });

  it('decides there finally, even under a contract whose methods name GET and paths name the endpoint', () => {
    const wide: CapabilityContract = { ...base, httpMethods: ['GET'], pathPatterns: ['/admin/api/*/*', '/admin/products'] };
    const graphqlGrant = withShopifyRead(wide, HOST, { phase: 'read', targets: [P1] });
    // The same contract without the grant does let a GET to the endpoint through: the grant is what refuses it.
    expect(contractGrants('http_request', { method: 'GET', url: ENDPOINT }, wide)).toBe(true);
    for (const url of [ENDPOINT, `https://${HOST}/admin/api/2026-10/GraphQL.json`, `https://${HOST}/admin/api/2026-10/graphql`]) {
      expect(contractGrants('http_request', { method: 'GET', url }, graphqlGrant)).toBe(false);
      expect(contractGrants('http_request', { method: 'HEAD', url }, graphqlGrant)).toBe(false);
    }
    expect(contractGrants('http_request', { method: 'POST', url: `https://${HOST}/admin/products`, headers: JSON_TYPE, body: '{}' }, graphqlGrant)).toBe(false);
    // A GET elsewhere on the store stays the contract's own decision.
    expect(contractGrants('http_request', { method: 'GET', url: `https://${HOST}/admin/products` }, graphqlGrant)).toBe(true);
  });

  it('is never minted from a contract that grants a write verb', () => {
    for (const httpMethods of [['GET', 'PATCH'], ['POST'], ['put']]) {
      expect(() => withShopifyRead({ ...base, httpMethods }, HOST, { phase: 'read', targets: [P1] })).toThrow(/no write verb/);
    }
  });

  it('a contract without the grant, a stored copy included, grants none of it', () => {
    expect(post({ ...base, httpMethods: ['POST'], pathPatterns: ['/admin/api/2026-10/graphql.json'] }, READ_P1)).toBe(false);
    expect(post(JSON.parse(JSON.stringify(preview)) as CapabilityContract, READ_P1)).toBe(false);
    expect(post({ ...preview }, READ_P1)).toBe(false);
  });
});

describe('withShopifyRead — what it mints from', () => {
  it('only a reviewed contract, a store host, a safe cursor and product GIDs', () => {
    expect(() => withShopifyRead({ ...base, origin: 'authorship' }, HOST, { phase: 'list', afterId: 0, filters: {} })).toThrow(/reviewed/);
    for (const host of ['shop.example.com', 'evil.example/x?.myshopify.com', 'evil.example#.myshopify.com', 'evil.example:443\\.myshopify.com', 'myshopify.com', 'a.b.myshopify.com', 'my-store.myshopify.com.', 'My-Store.myshopify.com', 'my-store.myshopify.com:443']) {
      expect(() => withShopifyRead(base, host, { phase: 'list', afterId: 0, filters: {} })).toThrow(/store host/);
    }
    expect(() => withShopifyRead(base, HOST, { phase: 'list', afterId: Number.MAX_SAFE_INTEGER + 2, filters: {} })).toThrow(/safe cursor/);
    expect(() => withShopifyRead(base, HOST, { phase: 'list', afterId: -1, filters: {} })).toThrow(/safe cursor/);
    expect(() => withShopifyRead(base, HOST, { phase: 'read', targets: [P1, 'gid://shopify/Collection/1'] })).toThrow(/product or image GIDs/);
    expect(() => withShopifyRead(base, HOST, { phase: 'read', targets: ['gid://shopify/Product/99999999999999999'] })).toThrow(/product or image GIDs/);
  });

  it('only on the contract\'s one host', () => {
    for (const hostPatterns of [['other.myshopify.com'], [HOST, 'other.myshopify.com'], [], ['*.myshopify.com']]) {
      expect(() => withShopifyRead({ ...base, hostPatterns }, HOST, { phase: 'list', afterId: 0, filters: {} }), hostPatterns.join()).toThrow(/one host/);
    }
    expect(() => withShopifyRead({ ...base, hostPatterns: [HOST] }, HOST, { phase: 'list', afterId: 0, filters: {} })).not.toThrow();
  });
});

/**
 * Whether every spread in `doc` is an inline type condition on its one root field: the whole
 * document is `query(…) { root(…) { ... on Type { fields } } }`. A fragment definition and a
 * named spread (`...Name`) are refused: they bring a second, separately written selection into a
 * document that is compared byte for byte (PRD shopify-preset §16.3 item 3).
 */
function spreadsAllowed(doc: string): boolean {
  if (!doc.includes('...')) return true;
  if (/\bfragment\b/.test(doc)) return false;
  return /^query\([^(){}]*\) \{ \w+\([^(){}]*\) \{ \.\.\. on [A-Z]\w* \{ [\w ]+ \} \} \}$/.test(doc);
}

describe('the read documents', () => {
  it('each holds one query operation, no fragment, and no word that writes', () => {
    for (const doc of Object.values(SHOPIFY_READ_DOCUMENTS)) {
      expect(doc.startsWith('query(')).toBe(true);
      expect(doc.match(/\bquery\s*\(/g)).toHaveLength(1);
      expect(doc).not.toMatch(/\b(?:mutation|subscription|fragment)\b/i);
      expect(spreadsAllowed(doc), doc).toBe(true);
    }
  });

  it('allows a spread only as an inline type condition on the one root field', () => {
    expect(spreadsAllowed('query($id: ID!) { node(id: $id) { ... on MediaImage { id alt } } }')).toBe(true);
    expect(spreadsAllowed('query($id: ID!) { node(id: $id) { ...Img } } fragment Img on MediaImage { id alt }')).toBe(false);
    expect(spreadsAllowed('query($id: ID!) { node(id: $id) { ...Img } }')).toBe(false);
    expect(spreadsAllowed('query($id: ID!) { node(id: $id) { id ... on MediaImage { alt } } }')).toBe(false);
    expect(spreadsAllowed('query($id: ID!) { product(id: $id) { media(first: 1) { nodes { ... on MediaImage { id } } } } }')).toBe(false);
  });
});
