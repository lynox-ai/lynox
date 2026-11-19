/**
 * The form a Shopify store saves a product's fields in, so a value it kept in that form is not taken
 * for another one. Apart from the store's reads and writes (`bulk-shopify.ts`) so that the ledger and
 * the apply loop can compare with it without importing them.
 */

/** A product title as Shopify saves it: without U+200B and without spaces (U+0020) at either end.
 *  Each was measured on its own; which comes first for a title that holds both is not. */
function savedTitle(title: string): string {
  return title.replaceAll('\u200B', '').replace(/^ +| +$/g, '');
}

/**
 * What a Shopify store does to a product's fields when it saves them, measured on a development
 * store (m009, m009b and m009c, 2026-10-31), each by the name its test carries. Only these: a value
 * the store keeps in any other form is a difference. Applied to what a run plans, never to what a
 * read answers: a read is what the store holds. `titleAfter` is the title the write leaves, as sent:
 * m009 sent title and SEO title as the same untrimmed text and read the SEO title as null. A SEO
 * title that differs from it only at its edges is not measured and stays as it is, as does every
 * SEO title where the title is not known (null).
 */
export const SHOPIFY_PRODUCT_SAVED_FORMS: ReadonlyArray<{
  readonly name: string;
  readonly apply: (value: Record<string, unknown>, titleAfter: string | null) => void;
}> = Object.freeze([
  {
    name: 'title without U+200B and without spaces at either end',
    apply: (value) => { if (typeof value['title'] === 'string') value['title'] = savedTitle(value['title']); },
  },
  {
    name: 'seo_title null where it equals the title after the write',
    apply: (value, titleAfter) => {
      const seo = value['seo_title'];
      if (typeof seo === 'string' && titleAfter !== null && seo === titleAfter) value['seo_title'] = null;
    },
  },
]);

/**
 * A planned value (an after-state, over the fields a run writes) in the form the store would save
 * it ({@link SHOPIFY_PRODUCT_SAVED_FORMS}). The title after the write is the value's own `title`
 * where it sets one, else `titleNow`: the title the store holds, read with the product.
 */
export function shopifySavedForm(value: unknown, titleNow: string | null): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const own = out['title'];
  const titleAfter = typeof own === 'string' ? own : titleNow;
  for (const form of SHOPIFY_PRODUCT_SAVED_FORMS) form.apply(out, titleAfter);
  return out;
}

/** The title a product read answered (its flat before-image, `shopifyBeforeImage`); null without one. */
export function productTitleOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = (value as Record<string, unknown>)['title'];
  return typeof title === 'string' ? title : null;
}
