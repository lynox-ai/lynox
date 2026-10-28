/**
 * The GraphQL documents a bulk run sends to a Shopify store: for products, one that lists their
 * ids and one that reads a product's before-image; for product images, one that lists the media
 * of products and one that reads an image's `alt`; and one write document for each. Constants
 * of the engine — a model never supplies a document, only the run's ledger supplies the values
 * bound into one.
 *
 * Shopify reads by `POST` (shopify.dev, "GraphQL queries are executed by sending POST HTTP
 * requests"), and `contractGrants` refuses a `POST` to a GraphQL endpoint under every other
 * contract. These bodies are the only ones a contract can let through there, and only byte for
 * byte (`withShopifyRead` in `permission-guard.ts`).
 */
import { OAUTH_PRESETS } from './oauth-presets.js';

/** The read forms. Closed: a form id that is not one of these mints nothing. */
export type ShopifyReadForm = 'shopify_products_list' | 'shopify_product_read' | 'shopify_media_list' | 'shopify_media_read';

/** Products per list page: Shopify's maximum for `first` ("up to a maximum of 250 resources", shopify.dev pagination, read 2026-10-22). */
export const SHOPIFY_LIST_PAGE_SIZE = 250;

/**
 * Products per page of the media list, each with up to {@link SHOPIFY_MEDIA_PER_PRODUCT} media.
 * The page's requested cost was 100 of the 1,000-point cap on a development store (PRD
 * shopify-preset §16.8, M8), and at most 12,500 media ids keep a page well under the byte cap.
 */
export const SHOPIFY_MEDIA_LIST_PAGE_SIZE = 50;

/** Media read per product: Shopify's maximum for `first`, and as many media as a product holds. */
export const SHOPIFY_MEDIA_PER_PRODUCT = 250;

/**
 * One operation each, no fragment definition, no named spread, no `mutation` or `subscription`
 * anywhere — a test pins it. The image read narrows its one root field with an inline type
 * condition (`... on MediaImage`): a `node` that is not an image then answers no fields
 * (PRD shopify-preset §16.3 item 3). The media list selects each medium's type instead, so it
 * needs none.
 */
export const SHOPIFY_READ_DOCUMENTS: Readonly<Record<ShopifyReadForm, string>> = Object.freeze({
  shopify_products_list: 'query($n: Int!, $q: String!) { products(first: $n, sortKey: ID, query: $q) { nodes { id } } }',
  shopify_product_read: 'query($id: ID!) { product(id: $id) { id title descriptionHtml seo { title description } } }',
  shopify_media_list: 'query($n: Int!, $q: String!, $m: Int!) { products(first: $n, sortKey: ID, query: $q) { nodes { id media(first: $m) { nodes { id mediaContentType } pageInfo { hasNextPage } } } } }',
  shopify_media_read: 'query($id: ID!) { node(id: $id) { ... on MediaImage { id alt } } }',
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

/** An image's GID, its number a safe integer ≥ 1. */
const MEDIA_IMAGE_GID = /^gid:\/\/shopify\/MediaImage\/([1-9][0-9]*)$/;

/** The number of an image's GID, or null when `gid` is not one. */
export function mediaImageGidNumber(gid: string): number | null {
  const m = MEDIA_IMAGE_GID.exec(gid);
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

/** The fields a Shopify list may be narrowed by, in the order `$q` names them (PRD shopify-preset §22). */
export const SHOPIFY_LIST_FILTER_KEYS = ['product_type', 'vendor'] as const;
export type ShopifyListFilterKey = (typeof SHOPIFY_LIST_FILTER_KEYS)[number];
/** A Shopify list's filters: each key at most once, none when the list reads every product. */
export type ShopifyListFilters = Readonly<Partial<Record<ShopifyListFilterKey, string>>>;

/**
 * The punctuation a filter value may hold inside a word, besides `-` (which has a rule of its
 * own). Each is measured literal inside a quoted Shopify search value; `,` is not (PRD §22.4,
 * M-F1), so it is left out. The refusal sentence names this set, and a test holds the two equal.
 */
const FILTER_PUNCTUATION = "_.&'/+";

/** The one sentence every refusal of the value rule gives; the key is filled in, never the value. */
export function shopifyFilterRefusal(key: string): string {
  return `source_list.filters.${key} may hold letters, digits, single spaces and ${[...FILTER_PUNCTUATION].join(' ')} ; every word starts with a letter or digit, - stands only between two letters or digits, and OR, AND, NOT are not allowed as words.`;
}

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const ALLOWED_CODE_POINT = /^[\p{L}\p{M}\p{N} -]$/u;
const MODIFIER_LETTER = /^\p{Lm}$/u;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
/** `OR`, `AND`, `NOT` in any ASCII letter case — spelled out, so no locale and no Unicode folding takes part. */
const SEARCH_WORD = /^(?:[Oo][Rr]|[Aa][Nn][Dd]|[Nn][Oo][Tt])$/;

/**
 * Whether a filter value is one the engine puts between the quotes of a Shopify search as it
 * stands: taken as written or refused, never escaped, trimmed or normalised (PRD shopify-preset
 * §22.2 item 2). Every rule fails closed: a value it refuses is reached by a run over every
 * product instead, while a value it took wrongly could change what the search lists.
 */
export function isShopifyFilterValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const cps = [...value];
  if (cps.length < 1 || cps.length > 255) return false;
  // A fullwidth `ＯＲ` or a decomposed letter would read as another word or match nothing.
  if (value.normalize('NFKC') !== value) return false;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    const allowed = (ALLOWED_CODE_POINT.test(c) || FILTER_PUNCTUATION.includes(c)) && !MODIFIER_LETTER.test(c) && !DEFAULT_IGNORABLE.test(c);
    if (!allowed) return false;
    // Every word starts with a letter or a digit: the value's first code point, and each after a space.
    if ((i === 0 || cps[i - 1] === ' ') && !LETTER_OR_DIGIT.test(c)) return false;
    // No trailing space; a double space is refused above, as a word that starts with a space.
    if (c === ' ' && i === cps.length - 1) return false;
    // `-` opens a negated term in Shopify's search: only between two letters or digits.
    if (c === '-' && !(i > 0 && LETTER_OR_DIGIT.test(cps[i - 1]!) && i < cps.length - 1 && LETTER_OR_DIGIT.test(cps[i + 1]!))) return false;
  }
  // A word is a run of letters, marks and digits; every other allowed character separates words.
  return !value.split(/[^\p{L}\p{M}\p{N}]+/u).some((w) => SEARCH_WORD.test(w));
}

/** Whether `filters` names only known keys, at least one, each with a value the rule takes. */
export function isShopifyListFilters(filters: unknown): filters is ShopifyListFilters {
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) return false;
  const keys = Object.keys(filters);
  return keys.length > 0
    && keys.every((k) => (SHOPIFY_LIST_FILTER_KEYS as readonly string[]).includes(k))
    && keys.every((k) => isShopifyFilterValue((filters as Record<string, unknown>)[k]));
}

/** `$q` of one list page: the products after `afterId`, then each filter as a quoted value. */
function shopifyListQuery(afterId: number, filters: ShopifyListFilters): string {
  let q = `id:>${String(afterId)}`;
  for (const key of SHOPIFY_LIST_FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined) q += ` AND ${key}:"${value}"`;
  }
  return q;
}

/**
 * The body of one list page: the products after `afterId`, by id, within `filters`. `afterId`
 * is the last id the run listed (0 before the first page); a value that is not a safe integer
 * ≥ 0 builds nothing, so the cursor can neither round nor be steered. `filters` is `{}` for a
 * list of every product; filters the value rule refuses build nothing, so neither a grant nor a
 * request can carry them.
 */
export function shopifyListBody(afterId: number, filters: ShopifyListFilters): string | null {
  if (!Number.isSafeInteger(afterId) || afterId < 0) return null;
  if (Object.keys(filters).length > 0 && !isShopifyListFilters(filters)) return null;
  return JSON.stringify({
    query: SHOPIFY_READ_DOCUMENTS.shopify_products_list,
    variables: { n: SHOPIFY_LIST_PAGE_SIZE, q: shopifyListQuery(afterId, filters) },
  });
}

/** The body that reads one product's before-image, or null when `gid` is not a product GID. */
export function shopifyProductReadBody(gid: string): string | null {
  if (productGidNumber(gid) === null) return null;
  return JSON.stringify({ query: SHOPIFY_READ_DOCUMENTS.shopify_product_read, variables: { id: gid } });
}

/** The body of one media list page: the products after `afterId`, by id, each with its media. Null as {@link shopifyListBody}. */
export function shopifyMediaListBody(afterId: number): string | null {
  if (!Number.isSafeInteger(afterId) || afterId < 0) return null;
  return JSON.stringify({
    query: SHOPIFY_READ_DOCUMENTS.shopify_media_list,
    variables: { n: SHOPIFY_MEDIA_LIST_PAGE_SIZE, q: `id:>${String(afterId)}`, m: SHOPIFY_MEDIA_PER_PRODUCT },
  });
}

/** The body that reads one image's `alt`, or null when `gid` is not an image's GID. */
export function shopifyMediaReadBody(gid: string): string | null {
  if (mediaImageGidNumber(gid) === null) return null;
  return JSON.stringify({ query: SHOPIFY_READ_DOCUMENTS.shopify_media_read, variables: { id: gid } });
}

/** The body that reads a target's before-image, by the type its GID names: a product or an image. Null for any other. */
export function shopifyTargetReadBody(gid: string): string | null {
  return shopifyProductReadBody(gid) ?? shopifyMediaReadBody(gid);
}

/** The write forms. Closed, like {@link ShopifyReadForm}. */
export type ShopifyWriteForm = 'shopify_product' | 'shopify_media_alt';

/**
 * One operation each, no fragment; the input object is a literal and only scalars are variables,
 * so no field outside the document can reach the store — a test pins it. `userErrors` is selected,
 * or a refusal could not be told from a success. `descriptionHtml` is not in the document: Shopify
 * stores the HTML it is sent unfiltered, `<script>` included, and rewrites its formatting, so
 * writing it waits for an allowlist the engine enforces and a comparison that normalises (PRD
 * shopify-preset §16.8 M6). A field the document does not name cannot be sent, nor cleared.
 */
export const SHOPIFY_WRITE_DOCUMENTS: Readonly<Record<ShopifyWriteForm, string>> = Object.freeze({
  shopify_product: 'mutation($id: ID!, $title: String, $seoTitle: String, $seoDescription: String) { productUpdate(product: {id: $id, title: $title, seo: {title: $seoTitle, description: $seoDescription}}) { product { id } userErrors { field message } } }',
  // `productUpdateMedia` is deprecated in favour of `fileUpdate` (PRD shopify-preset §16.3 item 3).
  shopify_media_alt: 'mutation($id: ID!, $alt: String) { fileUpdate(files: [{id: $id, alt: $alt}]) { files { id alt } userErrors { field message code } } }',
});

/** A product field of the flat image and the variable that writes it, in the order a body names them. */
const PRODUCT_WRITE_VARIABLES: ReadonlyArray<readonly [field: string, variable: string]> = [
  ['title', 'title'],
  ['seo_title', 'seoTitle'],
  ['seo_description', 'seoDescription'],
];

/** The product fields a Shopify run may set: those the write document names. */
export const SHOPIFY_WRITABLE_FIELDS: readonly string[] = Object.freeze(PRODUCT_WRITE_VARIABLES.map(([field]) => field));

/**
 * The body that writes `after` to the product `gid`, or null when it does not fit: `gid` not a
 * product GID, a field that is not one of the three ({@link SHOPIFY_WRITABLE_FIELDS}), a value that is neither a string nor `null`,
 * no field at all, or one `seo` field without the other. Shopify clears the `seo` field a write
 * leaves out once the other is sent (measured, PRD shopify-preset §16.8 M10), so a body never
 * names only one; the read completes the pair before the run is approved. The variables follow
 * a fixed order, so equal after-states build equal bytes whatever order their keys came in.
 */
export function shopifyProductWriteBody(gid: string, after: Readonly<Record<string, unknown>>): string | null {
  if (productGidNumber(gid) === null) return null;
  const known = new Set(PRODUCT_WRITE_VARIABLES.map(([f]) => f));
  const fields = Object.keys(after);
  if (fields.length === 0 || fields.some((f) => !known.has(f))) return null;
  if (Object.hasOwn(after, 'seo_title') !== Object.hasOwn(after, 'seo_description')) return null;
  const variables: Record<string, string | null> = { id: gid };
  for (const [field, variable] of PRODUCT_WRITE_VARIABLES) {
    if (!Object.hasOwn(after, field)) continue;
    const value = after[field];
    if (value !== null && typeof value !== 'string') return null;
    variables[variable] = value;
  }
  return JSON.stringify({ query: SHOPIFY_WRITE_DOCUMENTS.shopify_product, variables });
}

/** The image fields a media run may set: the one the write document names. */
export const SHOPIFY_MEDIA_WRITABLE_FIELDS: readonly string[] = Object.freeze(['alt']);

/**
 * The longest `alt` Shopify stores: 512 characters (`ALT_VALUE_LIMIT_EXCEEDED`). Counted in code
 * points: measured not to be bytes, but code points and UTF-16 units were not told apart (PRD
 * shopify-preset §16.8, M9). If Shopify counts units, a longer one fails its target, nothing more.
 */
export const SHOPIFY_ALT_MAX_CHARS = 512;

/** Whether `alt` is one Shopify stores: at most {@link SHOPIFY_ALT_MAX_CHARS} characters. */
export function isShopifyAltLength(alt: string): boolean {
  return [...alt].length <= SHOPIFY_ALT_MAX_CHARS;
}

/**
 * The body that writes `after` to the image `gid`, or null when it does not fit: `gid` not an
 * image's GID, a field other than `alt`, or an `alt` that is neither text nor `null` or longer
 * than Shopify stores. `null` is sent as `""`: Shopify ignores an `alt` of `null` and keeps the
 * value, while `""` clears it (measured, PRD shopify-preset §16.8 M9), so a cleared `alt` is
 * always written as the empty string.
 */
export function shopifyMediaAltWriteBody(gid: string, after: Readonly<Record<string, unknown>>): string | null {
  if (mediaImageGidNumber(gid) === null) return null;
  const fields = Object.keys(after);
  if (fields.length !== 1 || fields[0] !== 'alt') return null;
  const value = after['alt'];
  if (value !== null && typeof value !== 'string') return null;
  const alt = value ?? '';
  if (!isShopifyAltLength(alt)) return null;
  return JSON.stringify({ query: SHOPIFY_WRITE_DOCUMENTS.shopify_media_alt, variables: { id: gid, alt } });
}

/**
 * One read a bulk run sends: a list page after the last id, or one target's before-image. A
 * product list page's `filters` is required, `{}` for every product: a caller that forgot them
 * would otherwise send an unfiltered page under a filtered run's grant.
 */
export type ShopifyRead =
  | { readonly form: 'shopify_products_list'; readonly afterId: number; readonly filters: ShopifyListFilters }
  | { readonly form: 'shopify_product_read'; readonly gid: string }
  | { readonly form: 'shopify_media_list'; readonly afterId: number }
  | { readonly form: 'shopify_media_read'; readonly gid: string };

/**
 * The body a read sends and the line its actor-trail row names — both built here from the
 * form and the value bound into it, so the row cannot say other than what was sent and no
 * caller's text reaches the trail. Null for a value that does not fit.
 */
export function shopifyReadRequest(read: ShopifyRead): { body: string; detail: string } | null {
  if (read.form === 'shopify_products_list') {
    const body = shopifyListBody(read.afterId, read.filters);
    return body === null ? null : { body, detail: `${read.form} ${shopifyListQuery(read.afterId, read.filters)}` };
  }
  if (read.form === 'shopify_media_list') {
    const body = shopifyMediaListBody(read.afterId);
    return body === null ? null : { body, detail: `${read.form} id:>${String(read.afterId)}` };
  }
  const body = read.form === 'shopify_product_read' ? shopifyProductReadBody(read.gid) : shopifyMediaReadBody(read.gid);
  return body === null ? null : { body, detail: `${read.form} ${read.gid}` };
}

/** One write a bulk run sends: a product's fields or an image's `alt`, set to its approved after-state. */
export interface ShopifyWrite {
  readonly form: ShopifyWriteForm;
  readonly gid: string;
  readonly after: Readonly<Record<string, unknown>>;
}

/** The body a write sends, built here from the form, the target and its after-state; null when they do not fit. */
export function shopifyWriteRequest(write: ShopifyWrite): string | null {
  return write.form === 'shopify_media_alt'
    ? shopifyMediaAltWriteBody(write.gid, write.after)
    : shopifyProductWriteBody(write.gid, write.after);
}
