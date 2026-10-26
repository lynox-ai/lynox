import { describe, it, expect } from 'vitest';
import { contractGrants, withShopifyApply, withShopifyRead } from './permission-guard.js';
import { SHOPIFY_WRITE_DOCUMENTS, shopifyProductReadBody, shopifyProductWriteBody } from '../core/shopify-graphql.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// What an approved Shopify run's apply may send: each target's read, and each target's one write
// of the after-state its ledger row holds — and everything else it must still refuse.

const HOST = 'my-store.myshopify.com';
const ENDPOINT = `https://${HOST}/admin/api/2026-10/graphql.json`;
const P1 = 'gid://shopify/Product/101';
const P2 = 'gid://shopify/Product/202';
const base: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: [],
  hostPatterns: [HOST], pathPatterns: [], paramConstraints: {},
};
const JSON_TYPE = { 'content-type': 'application/json' };
const AFTER_P1 = { title: 'Neu', seo_title: 'SEO neu', seo_description: 'alt bleibt' };
const apply = withShopifyApply(base, HOST, { reads: [P1, P2], writes: [{ form: 'shopify_product', gid: P1, after: AFTER_P1 }] });
const WRITE_P1 = shopifyProductWriteBody(P1, AFTER_P1)!;
const post = (contract: CapabilityContract, body: unknown, extra: Record<string, unknown> = {}): boolean =>
  contractGrants('http_request', { method: 'POST', url: ENDPOINT, headers: JSON_TYPE, body, ...extra }, contract);

describe('withShopifyApply — what it grants', () => {
  it('grants each target\'s read and the one write of its after-state, byte for byte', () => {
    expect(post(apply, shopifyProductReadBody(P1))).toBe(true);
    expect(post(apply, shopifyProductReadBody(P2))).toBe(true);
    expect(post(apply, WRITE_P1)).toBe(true);
  });

  it('builds the write from the form\'s document, the after-state as its variables', () => {
    expect(JSON.parse(WRITE_P1)).toEqual({
      query: SHOPIFY_WRITE_DOCUMENTS.shopify_product,
      variables: { id: P1, title: 'Neu', seoTitle: 'SEO neu', seoDescription: 'alt bleibt' },
    });
  });
});

describe('withShopifyApply — what it refuses', () => {
  it('binds the write to its target and its value: another product, or another value, is another body', () => {
    expect(post(apply, shopifyProductWriteBody(P2, AFTER_P1))).toBe(false);
    expect(post(apply, shopifyProductWriteBody(P1, { ...AFTER_P1, title: 'Anders' }))).toBe(false);
    expect(post(apply, shopifyProductWriteBody(P1, { title: 'Neu' }))).toBe(false);
  });

  it('compares the bytes that are sent, not a reading of them', () => {
    expect(post(apply, JSON.parse(WRITE_P1))).toBe(false);
    expect(post(apply, ` ${WRITE_P1}`)).toBe(false);
    const parsed = JSON.parse(WRITE_P1) as { query: string; variables: Record<string, unknown> };
    expect(post(apply, JSON.stringify({ ...parsed, operationName: null }))).toBe(false);
    expect(post(apply, JSON.stringify({ query: parsed.query, variables: { ...parsed.variables, handle: 'x' } }))).toBe(false);
    expect(post(apply, JSON.stringify({ query: parsed.query.replace('title: $title, ', 'title: $title, status: ACTIVE, '), variables: parsed.variables }))).toBe(false);
    expect(post(apply, JSON.stringify([parsed]))).toBe(false);
  });

  it('refuses a call that passes no body, another address, another verb, another media type', () => {
    expect(contractGrants('http_request', { method: 'POST', url: ENDPOINT, headers: JSON_TYPE }, apply)).toBe(false);
    expect(post(apply, WRITE_P1, { url: `https://${HOST}/admin/api/unstable/graphql.json` })).toBe(false);
    expect(post(apply, WRITE_P1, { url: `${ENDPOINT}?x=1` })).toBe(false);
    for (const method of ['GET', 'PUT', 'PATCH']) expect(contractGrants('http_request', { method, url: ENDPOINT, headers: JSON_TYPE, body: WRITE_P1 }, apply)).toBe(false);
    expect(post(apply, WRITE_P1, { headers: { 'content-type': 'application/graphql' } })).toBe(false);
  });

  it('a read grant admits no write, and an apply grant no list page', () => {
    const preview = withShopifyRead(base, HOST, { phase: 'read', targets: [P1] });
    expect(post(preview, WRITE_P1)).toBe(false);
    expect(post(apply, JSON.stringify({ query: 'query($n: Int!, $q: String!) { products(first: $n, sortKey: ID, query: $q) { nodes { id } } }', variables: { n: 250, q: 'id:>0' } }))).toBe(false);
  });

  it('a stored or copied contract carries none of it', () => {
    expect(post(JSON.parse(JSON.stringify(apply)) as CapabilityContract, WRITE_P1)).toBe(false);
    expect(post({ ...apply }, WRITE_P1)).toBe(false);
  });

  it('is never minted for a write its form cannot make, nor from a contract that grants a write verb', () => {
    for (const after of [{ seo_title: 'nur eins' }, { handle: 'x' }, { title: 3 }, {}]) {
      expect(() => withShopifyApply(base, HOST, { reads: [P1], writes: [{ form: 'shopify_product', gid: P1, after }] }), JSON.stringify(after)).toThrow(/can write/);
    }
    expect(() => withShopifyApply(base, HOST, { reads: [P1], writes: [{ form: 'shopify_product', gid: 'gid://shopify/MediaImage/1', after: { title: 'x' } }] })).toThrow(/can write/);
    expect(() => withShopifyApply({ ...base, httpMethods: ['GET', 'POST'] }, HOST, { reads: [P1], writes: [] })).toThrow(/no write verb/);
    expect(() => withShopifyApply({ ...base, origin: 'authorship' }, HOST, { reads: [P1], writes: [] })).toThrow(/reviewed/);
  });
});

describe('shopifyProductWriteBody', () => {
  it('names the variables in one fixed order, whatever order the after-state\'s keys came in', () => {
    const a = shopifyProductWriteBody(P1, { seo_description: 'd', title: 't', seo_title: 's', descriptionHtml: '<p>x</p>' });
    const b = shopifyProductWriteBody(P1, { title: 't', descriptionHtml: '<p>x</p>', seo_title: 's', seo_description: 'd' });
    expect(a).toBe(b);
    expect(Object.keys((JSON.parse(a!) as { variables: object }).variables)).toEqual(['id', 'title', 'descriptionHtml', 'seoTitle', 'seoDescription']);
  });

  it('sends an empty field as null, and never one seo field without the other', () => {
    expect(JSON.parse(shopifyProductWriteBody(P1, { seo_title: null, seo_description: null })!)).toMatchObject({ variables: { id: P1, seoTitle: null, seoDescription: null } });
    expect(shopifyProductWriteBody(P1, { seo_title: 'x' })).toBeNull();
    expect(shopifyProductWriteBody(P1, { title: 'x', seo_description: 'y' })).toBeNull();
    expect(shopifyProductWriteBody(P1, { title: 'x' })).not.toBeNull();
  });

  it('builds nothing for a field outside the form, a value that is not a string or null, or no field', () => {
    for (const after of [{ status: 'ACTIVE' }, { title: 1 }, { title: true }, {}]) expect(shopifyProductWriteBody(P1, after)).toBeNull();
    expect(shopifyProductWriteBody('gid://shopify/Product/0', { title: 'x' })).toBeNull();
  });
});

describe('the write documents', () => {
  it('each holds one mutation, no fragment, and only scalar variables', () => {
    for (const doc of Object.values(SHOPIFY_WRITE_DOCUMENTS)) {
      expect(doc.startsWith('mutation(')).toBe(true);
      expect(doc.match(/\b(?:query|mutation|subscription)\s*\(/g)).toHaveLength(1);
      expect(doc).not.toMatch(/\bfragment\b/);
      expect(doc).not.toContain('...');
      const declared = /^mutation\(([^)]*)\)/.exec(doc)![1]!;
      for (const decl of declared.split(',')) expect(decl.trim()).toMatch(/^\$\w+: (?:ID!|String)$/);
      expect(doc).toContain('userErrors {');
    }
  });
});
