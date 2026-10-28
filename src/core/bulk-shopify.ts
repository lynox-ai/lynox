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
import { isPlainObject, type ExternalClient, type ExternalRead, type TargetIo } from './bulk-external.js';
import type { BulkInvalidReason, ListPageItem } from './bulk-ledger.js';
import { SHOPIFY_LIST_PAGE_SIZE, SHOPIFY_MEDIA_LIST_PAGE_SIZE, mediaImageGidNumber, productGidNumber, type ShopifyWriteForm } from './shopify-graphql.js';
import { isFeatureEnabled } from './features.js';

/** Whether this instance reads Shopify stores in bulk runs. Asked when a run is planned and on
 *  every tick of one, so turning it off stops a run that is already under way. */
export function shopifyBulkReadEnabled(): boolean {
  return isFeatureEnabled('shopify-bulk-read');
}

/** The fields of a product's flat before-image, and so of a Shopify run's after-state. */
export const SHOPIFY_PRODUCT_FIELDS = ['title', 'descriptionHtml', 'seo_title', 'seo_description'] as const;

/** The field of an image's before-image, and so of a media run's after-state. */
export const SHOPIFY_MEDIA_FIELDS = ['alt'] as const;

/**
 * The after-state a target is written with: `after`, and when it sets one `seo` field but not the
 * other, the other at its value in the before-image `value`. Shopify clears the `seo` field a write
 * leaves out once the other is sent (PRD shopify-preset §16.8 M10), so the pair is completed from
 * what the product holds and approved as a whole. A partner the product does not hold is added as
 * missing, which the before-image then refuses; `after` itself is returned when nothing is missing.
 */
export function shopifyPairedAfter(after: Readonly<Record<string, unknown>>, value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const hasTitle = Object.hasOwn(after, 'seo_title');
  if (hasTitle === Object.hasOwn(after, 'seo_description')) return after;
  const partner = hasTitle ? 'seo_description' : 'seo_title';
  return { ...after, [partner]: Object.hasOwn(value, partner) ? value[partner] : undefined };
}

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
 * caller's "short page ends the list". On a full page, the unusable nodes after its last product
 * are left out: the next page starts after that product and holds them again, so they are
 * recorded once, from the page where they are not at the end.
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
  if (nodes.length >= SHOPIFY_LIST_PAGE_SIZE) {
    while (items.length > 0 && 'invalid' in items[items.length - 1]!) items.pop();
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

/**
 * How an approved Shopify run reaches a product: its read and its write go to the store's GraphQL
 * endpoint with the engine's documents (`shopify-graphql.ts`), and the run's contract grants each
 * body byte for byte (`withShopifyApply`). A read answers the flat before-image: a product that is
 * gone is `not_found`, and one that is not the target (another id, no product object) answers no
 * object, which the writer reads as changed by someone else — a conflict, never overwritten.
 */
export function shopifyTargetIo(client: ExternalClient, endpoint: string, form: ShopifyWriteForm = 'shopify_product'): TargetIo {
  return {
    async read(key): Promise<ExternalRead> {
      const got = await client.graphqlRead(endpoint, form === 'shopify_media_alt' ? { form: 'shopify_media_read', gid: key } : { form: 'shopify_product_read', gid: key });
      if (got.kind !== 'ok') return got;
      const image = shopifyTargetBeforeImage(form, got.value, key);
      if ('invalid' in image) return image.invalid === 'not_found' ? { kind: 'not_found' } : { kind: 'ok', value: null };
      return { kind: 'ok', value: image.value };
    },
    write: (key, value, onSend, onRefused) =>
      client.graphqlWrite(endpoint, { form, gid: key, after: value }, undefined, onSend, onRefused),
  };
}

/**
 * A page from a `shopify_media_list` answer's `data`, read after `afterId`: the images of the
 * products on it, as targets. The cursor is the product id, held to the order of
 * {@link shopifyListPage}; a node that is not a product with a product GID does not move it.
 * Only media of type `IMAGE` whose id is an image's GID become targets — a video or a 3D model has
 * no `alt` the write document sets, and is left out. A product whose media go past the page
 * (`hasNextPage`) adds one invalid item, so a cut list is counted, not silent. `count` is the
 * number of products the page held, for the caller's "short page ends the list"; on a full page,
 * the invalid items after its last product with an id are left out, as there.
 */
export function shopifyMediaListPage(data: unknown, afterId: number): ShopifyListPage {
  const products = isPlainObject(data) ? data['products'] : undefined;
  const nodes = isPlainObject(products) ? products['nodes'] : undefined;
  if (!Array.isArray(nodes)) return { kind: 'not_a_list' };
  const items: ListPageItem[] = [];
  let last = afterId;
  let lastProductEnd = 0;
  for (const node of nodes) {
    if (!isPlainObject(node)) {
      items.push({ invalid: 'list_item_not_object' });
      continue;
    }
    const id = node['id'];
    const n = typeof id === 'string' ? productGidNumber(id) : null;
    if (n === null) {
      items.push({ invalid: id === undefined ? 'list_item_no_id' : 'list_item_bad_id' });
      continue;
    }
    if (n <= last) return { kind: 'order' };
    last = n;
    const media = node['media'];
    const mediaNodes = isPlainObject(media) ? media['nodes'] : undefined;
    if (!Array.isArray(mediaNodes)) {
      items.push({ invalid: 'list_item_not_object' });
    } else {
      for (const m of mediaNodes) {
        if (!isPlainObject(m)) {
          items.push({ invalid: 'list_item_not_object' });
          continue;
        }
        if (m['mediaContentType'] !== 'IMAGE') continue;
        const mid = m['id'];
        if (typeof mid !== 'string' || mediaImageGidNumber(mid) === null) {
          items.push({ invalid: mid === undefined ? 'list_item_no_id' : 'list_item_bad_id' });
          continue;
        }
        items.push({ key: mid, id: mid });
      }
      const pageInfo = isPlainObject(media) ? media['pageInfo'] : undefined;
      if (!isPlainObject(pageInfo) || pageInfo['hasNextPage'] !== false) items.push({ invalid: 'list_item_truncated' });
    }
    lastProductEnd = items.length;
  }
  if (nodes.length >= SHOPIFY_MEDIA_LIST_PAGE_SIZE) items.length = lastProductEnd;
  return { kind: 'page', items, lastId: last, count: nodes.length };
}

/**
 * The flat before-image of the image `gid` from a `shopify_media_read` answer's `data`, or why
 * there is none: `node: null` is an image that is gone; a `node` without fields (another type —
 * the read's type condition answers `{}` for it, measured, PRD shopify-preset §16.8 M9) or with
 * another id is not the image that was listed. A `null` `alt` is read as `""`: Shopify ignores a
 * written `null` and clears with `""` (M9), so the empty string is what an undo can write back.
 */
export function shopifyMediaBeforeImage(data: unknown, gid: string): { value: Record<string, unknown> } | { invalid: BulkInvalidReason } {
  if (!isPlainObject(data) || !Object.hasOwn(data, 'node')) return { invalid: 'before_not_object' };
  const node = data['node'];
  if (node === null) return { invalid: 'not_found' };
  if (!isPlainObject(node)) return { invalid: 'before_not_object' };
  if (node['id'] !== gid) return { invalid: 'list_item_mismatch' };
  if (!Object.hasOwn(node, 'alt')) return { value: {} };
  const alt = node['alt'];
  return { value: { alt: alt === null ? '' : alt } };
}

/** The before-image of `gid` from a read answer of `form`'s target. */
export function shopifyTargetBeforeImage(form: ShopifyWriteForm, data: unknown, gid: string): { value: Record<string, unknown> } | { invalid: BulkInvalidReason } {
  return form === 'shopify_media_alt' ? shopifyMediaBeforeImage(data, gid) : shopifyBeforeImage(data, gid);
}
