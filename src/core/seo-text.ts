/**
 * The value check of a bulk run's title and SEO fields (PRD shopify-preset §23).
 *
 * A meta title or description may be written by a model from a rule the agent drafted out of
 * third-party data (keyword data), so the rule text is no longer only the owner's words. No
 * schema can bar a string's content; this check is what keeps a planted link, address or tag out
 * of the store's meta texts. It is a deny list, refused rather than escaped:
 * - `://`, or `//` at the start of the value or after a space or `(` before a letter or digit — a
 *   link, the store's own domain included;
 * - an e-mail address;
 * - `www.`, or a bare domain, unless it is one of the run's own domains; a bare domain is refused
 *   only where the field's before-image does not already hold it (`Node.js` in a title a run
 *   rewrites);
 * - `<`.
 * Each pattern runs over the value as written and again after NFKC, the ideographic full stops
 * read as `.`; a refusal on either counts. Not caught, by design: `hxxp`, `example[.]com`,
 * `info [at] example.ch`, spaces inside `https : //`, phone numbers, a mixed-case TLD
 * (`Evil.Com`), an upper-case TLD outside the list, a non-ASCII TLD.
 *
 * It reads nothing but its arguments and never throws.
 */

import type { BulkListSourceForm } from './bulk-list.js';

export type SeoTextKind = 'link' | 'address' | 'markup';
export type SeoTextResult = { ok: true } | { ok: false; reason: 'seo_text_refused'; kind: SeoTextKind };

// --- Which fields are checked. Only the form knows a field's content type; a key name is no
// evidence. WooCommerce keeps its SEO fields in plugin `meta_data`, not in the list form.

const SEO_FIELDS: Readonly<Record<BulkListSourceForm, readonly string[]>> = Object.freeze({
  // A theme falls back to the product title where the meta title is empty.
  shopify: Object.freeze(['title', 'seo_title', 'seo_description']),
  shopify_media: Object.freeze([]),
  woocommerce: Object.freeze([]),
});

/** The fields of a list form whose values this check reads. Empty for a run without a list form. */
export function seoFieldsOfListForm(form: BulkListSourceForm | null): readonly string[] {
  return form === null ? [] : SEO_FIELDS[form] ?? [];
}

// --- The patterns.

/** A link with a scheme, or a scheme-relative one at a word start (`Rot//Blau` is no link). */
const SCHEME_LINK = /:\/\/|(?:^|[\s(])\/\/[\p{L}\p{N}]/u;
/** A run of non-space characters, `@`, and a run of non-space characters holding a `.`. */
const ADDRESS = /\S@\S*\./u;
/** `www.` and the host it starts. */
const WWW = /www\.[\p{L}\p{N}.-]*/giu;
/**
 * A dotted word whose last label is all lower case, or one of a closed list of upper-case TLDs,
 * with nothing of a word after it: `evil.com` and `EVIL.COM` are domains, `Inkl.MwSt`, `Co.KG`,
 * `Nr.CH-123` and `5.5` are not. A match starts only where a dotted run starts: the leftmost
 * match is that start anyway, and a search from inside the run would only fail again, which
 * makes a long run of short labels cost the square of its length.
 */
const DOMAIN = /(?<![\p{L}\p{N}-]|[\p{L}\p{N}-]\.)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:[a-z]{2,}|COM|NET|ORG|INFO|BIZ|SHOP|STORE|ONLINE|IO|CH|DE|AT|LI|EU)(?![\p{L}\p{N}-])/gu;

/** The value a client may read as a link: NFKC, and the ideographic full stops as `.`. */
function normalised(value: string): string {
  return value.normalize('NFKC').replace(/[。｡]/g, '.');
}

function isOwnDomain(host: string, ownDomains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return ownDomains.some((own) => {
    const o = own.toLowerCase();
    return h === o || h.endsWith(`.${o}`);
  });
}

/** Every bare domain `text` holds, as written. */
function domainsOf(text: string): string[] {
  return Array.from(text.matchAll(DOMAIN), (m) => m[0]);
}

function refusalOf(text: string, held: ReadonlySet<string>, ownDomains: readonly string[]): SeoTextKind | null {
  if (SCHEME_LINK.test(text)) return 'link';
  if (ADDRESS.test(text)) return 'address';
  for (const m of text.matchAll(WWW)) {
    if (!isOwnDomain(m[0].replace(/\.+$/, ''), ownDomains)) return 'link';
  }
  for (const domain of domainsOf(text)) {
    if (!isOwnDomain(domain, ownDomains) && !held.has(domain)) return 'link';
  }
  if (text.includes('<')) return 'markup';
  return null;
}

/**
 * Whether `value`, written to `field` of a target of the list form `form`, may stand in a meta
 * text. `before` is that field's before-image: a bare domain it holds is not new. `ownDomains`
 * are the store's host and the run's start domains, given by the caller.
 */
export function checkSeoText(
  form: BulkListSourceForm | null, field: string, value: unknown, before: string | null, ownDomains: readonly string[],
): SeoTextResult {
  if (typeof value !== 'string' || value === '' || !seoFieldsOfListForm(form).includes(field)) return { ok: true };
  const prior = before ?? '';
  const held = new Set([...domainsOf(prior), ...domainsOf(normalised(prior))]);
  for (const text of [value, normalised(value)]) {
    const kind = refusalOf(text, held, ownDomains);
    if (kind !== null) return { ok: false, reason: 'seo_text_refused', kind };
  }
  return { ok: true };
}

/**
 * The first refusal over the checked fields of an after-state, or `{ ok: true }`. Only what the
 * run writes is checked: a field whose value is not a string, or equals the before-image's, adds
 * nothing (the seo partner a Shopify run fills from the before-image included).
 */
export function checkSeoAfter(
  form: BulkListSourceForm | null,
  after: Readonly<Record<string, unknown>>,
  before: Readonly<Record<string, unknown>>,
  ownDomains: readonly string[],
): SeoTextResult {
  for (const field of seoFieldsOfListForm(form)) {
    if (!Object.hasOwn(after, field)) continue;
    const value = after[field];
    const was = Object.hasOwn(before, field) && typeof before[field] === 'string' ? before[field] as string : null;
    if (typeof value !== 'string' || value === was) continue;
    const checked = checkSeoText(form, field, value, was, ownDomains);
    if (!checked.ok) return checked;
  }
  return { ok: true };
}
