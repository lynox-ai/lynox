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
import type { BulkInvalidReason, BulkRunStatus, ListPageItem } from './bulk-ledger.js';
import type { BulkNotices } from './bulk-notices.js';
import { SHOPIFY_LIST_PAGE_SIZE, SHOPIFY_MEDIA_LIST_PAGE_SIZE, asciiLower, isShopifyFilterValues, mediaImageGidNumber, productGidNumber, shopifyFilterValues, type ShopifyListFilterValue, type ShopifyWriteForm } from './shopify-graphql.js';
import { isFeatureEnabled } from './features.js';
import { presetStoreHost } from './oauth-presets.js';
import type { ApiProfile } from './api-store.js';

/** The Shopify scopes either of which `fileUpdate`, the bulk image form's write, needs (PRD
 *  shopify-preset §16.6). The Shopify preset asks for neither (`oauth-presets.ts`). */
export const SHOPIFY_MEDIA_WRITE_SCOPES: readonly string[] = Object.freeze(['write_files', 'write_themes']);

/**
 * Whether the store connection for `host` may run the bulk image form (`fileUpdate`): the engine's own Shopify
 * connection to that store (`presetStoreHost`, the same profile the write attaches) whose grant,
 * as Shopify answered it, holds `write_files` or `write_themes`. Without a recorded grant nothing
 * is known beyond the ask, and the preset never asks for either, so that counts as no.
 */
export function shopifyMediaWritable(profile: Pick<ApiProfile, 'base_url' | 'auth' | 'oauth_grant'> | undefined, host: string): boolean {
  // Only the Shopify preset derives its API host from the store (`apiOnDerivedHost`), so a match is that preset.
  if (profile === undefined || presetStoreHost(profile) !== host) return false;
  return (profile.oauth_grant?.granted_scope ?? []).some((s) => SHOPIFY_MEDIA_WRITE_SCOPES.includes(s));
}

/** Whether this instance reads Shopify stores in bulk runs. Asked when a run is planned and on
 *  every tick of one, so turning it off stops a run that is already under way. */
export function shopifyBulkReadEnabled(): boolean {
  return isFeatureEnabled('shopify-bulk-read');
}

/** The fields of a product's flat before-image, and so of a Shopify run's after-state. */
export const SHOPIFY_PRODUCT_FIELDS = ['title', 'descriptionHtml', 'seo_title', 'seo_description'] as const;

/**
 * The fields behind a product page's SEO title and SEO description whose text, once the after-state
 * is written, holds an `&` more often than it does now. A theme may escape `page_title` and
 * `page_description` twice, and then the browser tab and a search result show `&amp;` (measured on
 * one theme, not on every one). lynox cannot tell which theme does, so the preview names the target
 * and refuses nothing: "A & B" is a legitimate text. Only `&` is counted, because the owner's note
 * names only `&`; a `<` or `>` a theme shows the same way is not marked.
 *
 * The page's title is the SEO title, or the product's title where the SEO title is empty (measured
 * on a store), so it is that text which is compared, and the field it comes from which is named. The
 * description's own fallback is not followed: a run does not write `descriptionHtml` yet.
 * A product not read yet holds no before-image to compare with, and is not named.
 */
export function shopifySeoEntityFields(prior: unknown, after: unknown): string[] {
  if (!isPlainObject(after) || !isPlainObject(prior)) return [];
  const next: Record<string, unknown> = { ...prior, ...after };
  const text = (image: Record<string, unknown>, field: string): string => {
    const value = image[field];
    return typeof value === 'string' ? value : '';
  };
  const titleField = (image: Record<string, unknown>): string => (text(image, 'seo_title') !== '' ? 'seo_title' : 'title');
  const ampersands = (value: string): number => value.split('&').length - 1;
  const shown: [string, string, string][] = [
    [titleField(next), text(next, titleField(next)), text(prior, titleField(prior))],
    ['seo_description', text(next, 'seo_description'), text(prior, 'seo_description')],
  ];
  return shown.filter(([, now, was]) => ampersands(now) > ampersands(was)).map(([field]) => field);
}

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
 * Whether a product, as the preview's `shopify_product_read` answered it, lies in the list's
 * filters (PRD shopify-preset §22.4, `not_in_filter`): each filter's field of the RAW answer
 * equals its value up to ASCII letter case. Shopify's search folds diacritics, so a search for
 * `Gemuse` lists `Gemüse` too; this check does not, and fails closed — `GEMÜSE` is not in a
 * `Gemüse` group, and an answer without the field, or with another key, is in none. A filter
 * with a list of values holds a product whose field equals any one of them, by the same rule; a
 * list with no value holds none. A list without filters holds every product it lists.
 */
export function shopifyInFilter(data: unknown, filters: Readonly<Record<string, ShopifyListFilterValue>>): boolean {
  const product = isPlainObject(data) && isPlainObject(data['product']) ? data['product'] : {};
  const field: Readonly<Record<string, string>> = { product_type: 'productType', vendor: 'vendor' };
  return Object.entries(filters).every(([key, value]) => {
    const name = Object.hasOwn(field, key) ? field[key]! : null;
    const held = name === null ? undefined : product[name];
    // A value the rule does not take (a stored source no parse built) holds no product.
    if (!isShopifyFilterValues(value)) return false;
    return typeof held === 'string' && shopifyFilterValues(value).some((v) => asciiLower(held) === asciiLower(v));
  });
}

/** Which filters a Shopify list has, for the sentences below; null for a list without filters. */
function filterKind(filters: Readonly<Record<string, ShopifyListFilterValue>>): 'product_type' | 'vendor' | 'both' | null {
  const type = filters['product_type'] !== undefined;
  const vendor = filters['vendor'] !== undefined;
  if (!type && !vendor) return null;
  // With both, each value may match products while the pair matches none: no value is to blame.
  return type && vendor ? 'both' : type ? 'product_type' : 'vendor';
}

/**
 * What a filtered Shopify list that matched no product tells the model and the owner, by the
 * filters it has ({@link BulkNotices.listNoMatch}); null for a list without filters. The value is
 * not repeated: no summary of this code echoes the planner's input, and the model has it in its
 * own plan.
 */
export function shopifyNoMatchSentence(filters: Readonly<Record<string, ShopifyListFilterValue>>, say: BulkNotices): string | null {
  const kind = filterKind(filters);
  return kind === null ? null : say.listNoMatch(kind, Object.values(filters).some((v) => typeof v !== 'string'));
}

/**
 * What a filtered list says when its search listed products and every one fell out as
 * `not_in_filter` (PRD shopify-preset §22.2 item 7, §22.4): products were found, none spelled as
 * the filter ({@link BulkNotices.listNoneLeft}), so neither the model nor the owner reads it as
 * "the store has no such products". Null otherwise: a target left out for another reason (a read
 * that failed) may have matched, and the run does not say that none did.
 */
export function shopifyNoneLeftSentence(
  filters: Readonly<Record<string, ShopifyListFilterValue>>, status: Pick<BulkRunStatus, 'total' | 'invalidReasons'> | null, say: BulkNotices,
): string | null {
  if (status === null || status.invalidReasons.not_in_filter !== status.total) return null;
  const kind = filterKind(filters);
  return kind === null ? null : say.listNoneLeft(kind, Object.values(filters).some((v) => typeof v !== 'string'));
}

/**
 * The context C of a product from the same `shopify_product_read` answer as its before-image
 * (PRD shopify-preset §20.2 item 7): each of `fields` flat, as {@link SHOPIFY_CONTEXT_FIELDS} names
 * them (`seo.title` → `seo_title`), `null` where the answer holds none, and `tags` only as a list
 * of texts. Read only, for the judge: never part of the before-image, so never compared or written.
 * Call it only on an answer {@link shopifyBeforeImage} took as the target.
 */
export function shopifyContextOf(data: unknown, fields: readonly string[]): Record<string, unknown> {
  const product = isPlainObject(data) && isPlainObject(data['product']) ? data['product'] : {};
  const seo = isPlainObject(product['seo']) ? product['seo'] : {};
  const text = (v: unknown): string | null => typeof v === 'string' ? v : null;
  const flat: Record<string, unknown> = {
    title: text(product['title']), descriptionHtml: text(product['descriptionHtml']),
    seo_title: text(seo['title']), seo_description: text(seo['description']),
    productType: text(product['productType']), vendor: text(product['vendor']),
    tags: Array.isArray(product['tags']) && product['tags'].every((t) => typeof t === 'string') ? product['tags'] : null,
  };
  return Object.fromEntries(fields.map((f) => [f, Object.hasOwn(flat, f) ? flat[f] : null]));
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
