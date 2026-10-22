/**
 * The GraphQL read documents a bulk run sends to a Shopify store (PRD shopify-preset §19): one
 * that lists product ids, one that reads a product's before-image. Constants of the engine — a
 * model never supplies a document, only the run's ledger supplies the values bound into one.
 *
 * Shopify reads by `POST` (shopify.dev, "GraphQL queries are executed by sending POST HTTP
 * requests"), and `contractGrants` refuses a `POST` to a GraphQL endpoint under every other
 * contract. These bodies are the only ones a contract can let through there, and only byte for
 * byte (`withShopifyRead` in `permission-guard.ts`).
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

/** A store host as the preset derives it: one subdomain label of `myshopify.com`, nothing else. */
const STORE_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Whether `host` is exactly a store host — a bare name, no port, path, query or trailing dot. */
export function isShopifyStoreHostName(host: string): boolean {
  return STORE_HOST.test(host);
}

/** A product's GID, its number a safe integer ≥ 1. */
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/([1-9][0-9]*)$/;

/** The number of a product GID, or null when `gid` is not one. */
export function productGidNumber(gid: string): number | null {
  const m = PRODUCT_GID.exec(gid);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** The store's Admin GraphQL endpoint at the preset's pinned version, or null without a pin or for a host that is not exactly a store's. */
export function shopifyGraphqlEndpoint(host: string): string | null {
  const version = OAUTH_PRESETS.get('shopify')?.adminApiVersion;
  if (version === undefined || !isShopifyStoreHostName(host)) return null;
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

/** One read a bulk run sends: a list page after the last id, or one product's before-image. */
export type ShopifyRead =
  | { readonly form: 'shopify_products_list'; readonly afterId: number }
  | { readonly form: 'shopify_product_read'; readonly gid: string };

/**
 * The body a read sends and the line its actor-trail row names — both built here from the
 * form and the value bound into it, so the row cannot say other than what was sent and no
 * caller's text reaches the trail. Null for a value that does not fit.
 */
export function shopifyReadRequest(read: ShopifyRead): { body: string; detail: string } | null {
  if (read.form === 'shopify_products_list') {
    const body = shopifyListBody(read.afterId);
    return body === null ? null : { body, detail: `${read.form} id:>${String(read.afterId)}` };
  }
  const body = shopifyProductReadBody(read.gid);
  return body === null ? null : { body, detail: `${read.form} ${read.gid}` };
}
