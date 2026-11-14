/**
 * Write forms whose effect on the fields a write does NOT send has been measured on a real
 * provider: a host (or any host, for a path a piece of software fixes itself), a path and a
 * verb. "Measured" means only that: unsent fields stayed as they were. It does not mean that
 * setting a field has no further effect at the provider (a mail, a payment).
 *
 * A run whose every target is a measured form needs one confirmed probe per host, verb and
 * kind of resource, once. A run with any other target is unmeasured: approving it takes an
 * explicit confirmation, and it writes one target first in every run. A Shopify run is judged by
 * {@link MEASURED_SHOPIFY_FORMS} instead; its probe stays its own in every run.
 */

import { SHOPIFY_WRITE_DOCUMENTS, shopifyAdminApiVersion, shopifyProductWriteVariables, type ShopifyWriteForm } from './shopify-graphql.js';

export interface MeasuredWriteForm {
  /** Exact host, or `null` for any host — the path is fixed by software the customer runs on their own host. */
  host: string | null;
  /** Matches the whole target path. */
  path: RegExp;
  methods: readonly string[];
  /** When and how it was measured. */
  measured: string;
}

export const MEASURED_WRITE_FORMS: readonly MeasuredWriteForm[] = [
  {
    // WooCommerce runs on the customer's own host, so a foreign server serving the same path
    // counts as measured too; there is no other way to recognise WooCommerce.
    host: null,
    path: /^\/wp-json\/wc\/v3\/products\/[0-9]+$/,
    methods: ['PUT', 'PATCH', 'POST'],
    measured: '2026-10-01 on a WooCommerce server (PUT, PATCH, POST); 2026-10-13 through lynox',
  },
  {
    host: 'api.bexio.com',
    path: /^\/2\.0\/contact\/[0-9]+$/,
    methods: ['POST'],
    measured: '2026-10-01 in a bexio sandbox, end to end through the bulk ledger',
  },
];

/** Whether one target — host, path, verb — is a measured write form. */
export function isMeasuredWriteForm(host: string, path: string, method: string): boolean {
  return MEASURED_WRITE_FORMS.some((f) =>
    (f.host === null || f.host === host) && f.path.test(path) && f.methods.includes(method));
}

/**
 * A Shopify write form whose effect on unsent fields has been measured. Every product write goes
 * to the one GraphQL path of the store, so the path cannot tell forms apart: a form is the write
 * document itself, the Admin API version it is sent at, and the exact set of variables it sets.
 * It holds on any store host — the form is Shopify's, and what a single store adds (an app or a
 * webhook that reacts to a product update) is outside any measurement and is what the probe of
 * every Shopify run still checks.
 */
export interface MeasuredShopifyForm {
  form: ShopifyWriteForm;
  /** The write document as it was measured, byte for byte. A changed document is not measured. */
  document: string;
  /** The Admin API version it was measured at. Another version is not measured. */
  apiVersion: string;
  /** Each set of variables measured, sorted. Only these exact sets count. */
  variableSets: readonly (readonly string[])[];
  /** When and how it was measured. */
  measured: string;
}

export const MEASURED_SHOPIFY_FORMS: readonly MeasuredShopifyForm[] = [
  {
    form: 'shopify_product',
    document: 'mutation($id: ID!, $title: String, $seoTitle: String, $seoDescription: String) { productUpdate(product: {id: $id, title: $title, seo: {title: $seoTitle, description: $seoDescription}}) { product { id } userErrors { field message } } }',
    apiVersion: '2026-10',
    variableSets: [['seoDescription', 'seoTitle'], ['title'], ['seoDescription', 'seoTitle', 'title']],
    measured: '2026-11-14 on a partner development store, API 2026-10: a raw read of every product field after each write; '
      + 'unsent fields unchanged for each set, with values and with the seo pair cleared (null or ""); an empty title is refused',
  },
];

/**
 * Whether one Shopify write — its form and its approved after-state — is a measured form: the
 * engine's document and API version are the measured ones, and the variables the body sets
 * ({@link shopifyProductWriteVariables}, the same function the body is built from) are exactly a
 * measured set. A title is measured only as text: Shopify refuses an empty one, and clearing it
 * with `null` was not measured.
 */
export function isMeasuredShopifyWrite(form: ShopifyWriteForm, after: Readonly<Record<string, unknown>>): boolean {
  // An image's after-state builds no product variables; the form check below also refuses it.
  const variables = form === 'shopify_product' ? shopifyProductWriteVariables(after) : null;
  return variables !== null && isMeasuredShopifySend(form, variables, SHOPIFY_WRITE_DOCUMENTS[form], shopifyAdminApiVersion());
}

/** {@link isMeasuredShopifyWrite} over what is sent: the variables, the document and the API version. */
export function isMeasuredShopifySend(
  form: ShopifyWriteForm, variables: Readonly<Record<string, string | null>>, document: string, version: string | null,
): boolean {
  if (Object.hasOwn(variables, 'title') && (typeof variables['title'] !== 'string' || variables['title'] === '')) return false;
  const sent = Object.keys(variables).sort();
  return MEASURED_SHOPIFY_FORMS.some((f) => f.form === form
    && f.document === document
    && f.apiVersion === version
    && f.variableSets.some((set) => set.length === sent.length && set.every((v, i) => v === sent[i])));
}

/** `measured` when every path is a measured form; an empty path list is `unmeasured`. */
export function writeFormOf(host: string, paths: readonly string[], method: string | null): 'measured' | 'unmeasured' {
  if (method === null || paths.length === 0) return 'unmeasured';
  return paths.every((p) => isMeasuredWriteForm(host, p, method)) ? 'measured' : 'unmeasured';
}

/** Shown with an unmeasured run wherever it is previewed or approved (customer text, approved 2026-10-13). */
export const BULK_UNMEASURED_NOTE =
  'lynox has not checked this kind of change with this provider. It can trigger something else there, such as ' +
  'emails to your customers, a payment or an invoice. So lynox writes one target first. Check it there before you ' +
  'approve the rest.';

/** The note of an unmeasured run with exactly one target to write: its first two sentences. With
 *  one target the first write is the whole run, so "one target first … the rest" would promise a
 *  step that does not come (customer text, approved 2026-11-06). */
export const BULK_UNMEASURED_NOTE_ONE =
  'lynox has not checked this kind of change with this provider. It can trigger something else there, such as ' +
  'emails to your customers, a payment or an invoice.';

/** What the approver of an unmeasured run confirms (customer text, approved 2026-10-13). */
export const BULK_UNMEASURED_CONFIRMATION = 'I know lynox has not checked this kind of change, and I approve it anyway.';
