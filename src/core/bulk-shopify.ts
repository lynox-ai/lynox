/**
 * A Shopify store as the source of a bulk run: its products listed, and each product's
 * before-image read, through the store's GraphQL API with the engine's own read documents
 * (`shopify-graphql.ts`). This module turns what the store answers into what the run records;
 * it sends nothing. What an answer is decides a fixed reason, and nothing of the store's text
 * reaches the model or a log.
 *
 * A list is read by id, not by page number: each page asks for the products after the last id
 * recorded (`id:>N`, ascending), so a read that goes on in a later tick neither repeats nor
 * skips. That holds only while the store answers in id order — a page that does not is refused
 * (`order`), not repaired.
 *
 * The before-image is the product's fields made flat: `title`, `descriptionHtml`, and the SEO
 * title and description as `seo_title` and `seo_description`. These are the only fields a
 * Shopify run's after-state may name.
 */
import { isPlainObject } from './bulk-external.js';
import type { BulkInvalidReason, ListPageItem } from './bulk-ledger.js';
import { productGidNumber } from './shopify-graphql.js';
import { isFeatureEnabled } from './features.js';

/** Whether this instance reads Shopify stores in bulk runs. Asked when a run is planned and on
 *  every tick of one, so turning it off stops a run that is already under way. */
export function shopifyBulkReadEnabled(): boolean {
  return isFeatureEnabled('shopify-bulk-read');
}

/** The fields of a product's flat before-image, and so of a Shopify run's after-state. */
export const SHOPIFY_PRODUCT_FIELDS = ['title', 'descriptionHtml', 'seo_title', 'seo_description'] as const;

/** One page of the product list as read: its items for the ledger and the id the next page starts after. */
export type ShopifyListPage =
  | { readonly kind: 'page'; readonly items: readonly ListPageItem[]; readonly lastId: number; readonly count: number }
  /** `data.products.nodes` is not an array: not a page of the list. */
  | { readonly kind: 'not_a_list' }
  /** An id is not above the one before it, or not above the last id recorded. */
  | { readonly kind: 'order' };

/**
 * A page from a `shopify_products_list` answer's `data`, read after `afterId`. Every node must
 * carry a product GID whose number is above `afterId` and above the node before it; a node
 * whose id is no product GID is an invalid target and does not move the cursor, and a node out
 * of that order refuses the whole page. `count` is how many nodes the page held, for the
 * caller's "short page ends the list".
 */
export function shopifyListPage(data: unknown, afterId: number): ShopifyListPage {
  const products = isPlainObject(data) ? data['products'] : undefined;
  const nodes = isPlainObject(products) ? products['nodes'] : undefined;
  if (!Array.isArray(nodes)) return { kind: 'not_a_list' };
  const items: ListPageItem[] = [];
  let last = afterId;
  for (const node of nodes) {
    if (!isPlainObject(node)) {
      items.push({ invalid: 'list_item_not_object' });
      continue;
    }
    const id = node['id'];
    if (typeof id !== 'string') {
      items.push({ invalid: id === undefined ? 'list_item_no_id' : 'list_item_bad_id' });
      continue;
    }
    const n = productGidNumber(id);
    if (n === null) {
      items.push({ invalid: 'list_item_bad_id' });
      continue;
    }
    if (n <= last) return { kind: 'order' };
    last = n;
    items.push({ key: id, id });
  }
  return { kind: 'page', items, lastId: last, count: nodes.length };
}

/**
 * The flat before-image of `gid` from a `shopify_product_read` answer's `data`, or why there is
 * none: `product: null` is a product that is gone; a product whose `id` is not the target's is
 * not the one that was listed. Only the fields of {@link SHOPIFY_PRODUCT_FIELDS} are taken, and
 * only those the answer holds; a missing one is the caller's `field_missing`.
 */
export function shopifyBeforeImage(data: unknown, gid: string): { value: Record<string, unknown> } | { invalid: BulkInvalidReason } {
  if (!isPlainObject(data) || !Object.hasOwn(data, 'product')) return { invalid: 'before_not_object' };
  const product = data['product'];
  if (product === null) return { invalid: 'not_found' };
  if (!isPlainObject(product)) return { invalid: 'before_not_object' };
  if (product['id'] !== gid) return { invalid: 'list_item_mismatch' };
  const value: Record<string, unknown> = {};
  if (Object.hasOwn(product, 'title')) value['title'] = product['title'];
  if (Object.hasOwn(product, 'descriptionHtml')) value['descriptionHtml'] = product['descriptionHtml'];
  const seo = product['seo'];
  if (isPlainObject(seo)) {
    if (Object.hasOwn(seo, 'title')) value['seo_title'] = seo['title'];
    if (Object.hasOwn(seo, 'description')) value['seo_description'] = seo['description'];
  }
  return { value };
}
