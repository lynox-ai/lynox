/**
 * The GraphQL read documents a bulk run sends to a Shopify store (PRD shopify-preset §19): one
 * that lists product ids, one that reads a product's before-image. Constants of the engine — a
 * model never supplies a document, only the run's ledger supplies the values bound into one.
 *
 * Shopify reads by `POST` (shopify.dev, "GraphQL queries are executed by sending POST HTTP
 * requests"), and `contractGrants` refuses every non-`GET` to a GraphQL endpoint. These bodies
 * are the only ones a contract can let through there, and only byte for byte
 * (`withShopifyRead` in `permission-guard.ts`).
 */
import { OAUTH_PRESETS } from './oauth-presets.js';

/** The read forms. Closed: a form id that is not one of these mints nothing. */
export type ShopifyReadForm = 'shopify_products_list' | 'shopify_product_read';

/** Products per list page: Shopify's maximum for `first` ("up to a maximum of 250 resources", shopify.dev pagination, read 2026-10-22). */
export const SHOPIFY_LIST_PAGE_SIZE = 250;

/** One operation each, no fragment, no `mutation` or `subscription` anywhere — a test pins it. */
export const SHOPIFY_READ_DOCUMENTS: Readonly<Record<ShopifyReadForm, string>> = Object.freeze({
  shopify_products_list: 'query($n: Int!, $q: String!) { products(first: $n, sortKey: ID, query: $q) { nodes { id } } }',
  shopify_product_read: 'query($id: ID!) { product(id: $id) { id title descriptionHtml seo { title description } } }',
});

/** A product's GID, its number a safe integer ≥ 1. */
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/([1-9][0-9]*)$/;

/** The number of a product GID, or null when `gid` is not one. */
export function productGidNumber(gid: string): number | null {
  const m = PRODUCT_GID.exec(gid);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** The store's Admin GraphQL endpoint at the preset's pinned version, or null without a pin. */
export function shopifyGraphqlEndpoint(host: string): string | null {
  const version = OAUTH_PRESETS.get('shopify')?.adminApiVersion;
  if (version === undefined) return null;
  return `https://${host}/admin/api/${version}/graphql.json`;
}

/**
 * The body of one list page: the products after `afterId`, by id. `afterId` is the last id the
 * run listed (0 before the first page); a value that is not a safe integer ≥ 0 builds nothing,
 * so the cursor can neither round nor be steered.
 */
export function shopifyListBody(afterId: number): string | null {
  if (!Number.isSafeInteger(afterId) || afterId < 0) return null;
  return JSON.stringify({
    query: SHOPIFY_READ_DOCUMENTS.shopify_products_list,
    variables: { n: SHOPIFY_LIST_PAGE_SIZE, q: `id:>${String(afterId)}` },
  });
}

/** The body that reads one product's before-image, or null when `gid` is not a product GID. */
export function shopifyProductReadBody(gid: string): string | null {
  if (productGidNumber(gid) === null) return null;
  return JSON.stringify({ query: SHOPIFY_READ_DOCUMENTS.shopify_product_read, variables: { id: gid } });
}
