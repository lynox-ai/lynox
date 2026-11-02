import { describe, it, expect } from 'vitest';
import { SHOPIFY_PRODUCT_SAVED_FORMS, productTitleOf, shopifySavedForm } from './shopify-saved-form.js';

// The form a Shopify store saves a product's fields in, as measured on a development store
// (m009, m009c). One test per entry of the named list, each under the entry's name.

const TITLE = SHOPIFY_PRODUCT_SAVED_FORMS[0]!;
const SEO_TITLE = SHOPIFY_PRODUCT_SAVED_FORMS[1]!;

describe('SHOPIFY_PRODUCT_SAVED_FORMS', () => {
  it('holds exactly the two measured forms, by name', () => {
    expect(SHOPIFY_PRODUCT_SAVED_FORMS.map((f) => f.name)).toEqual([
      'title without U+200B and without spaces at either end',
      'seo_title null where it equals the title after the write',
    ]);
  });

  it(TITLE.name, () => {
    const value: Record<string, unknown> = { title: '  M009\u200B Rand  ' };
    TITLE.apply(value, null);
    expect(value).toEqual({ title: 'M009 Rand' });
    // The values measured as kept byte for byte (m009): spaces inside, tab and line breaks inside,
    // a no-break space; of the hidden characters only U+200B goes, U+200D and U+FEFF stay.
    for (const kept of ['M009  doppelt   drei', 'M009\tTab\nZeile\r\nCRLF', 'M009\u00A0geschuetzt']) {
      const other: Record<string, unknown> = { title: kept };
      TITLE.apply(other, null);
      expect(other).toEqual({ title: kept });
    }
    const hidden: Record<string, unknown> = { title: 'M009\u200Bnull\u200Dbreit\uFEFF' };
    TITLE.apply(hidden, null);
    expect(hidden).toEqual({ title: 'M009null\u200Dbreit\uFEFF' });
  });

  it(SEO_TITLE.name, () => {
    const equal: Record<string, unknown> = { seo_title: 'Neu' };
    SEO_TITLE.apply(equal, 'Neu');
    expect(equal).toEqual({ seo_title: null });
    // The title as sent decides (m009: both sent as the same untrimmed text). A SEO title that
    // differs from it only at its edges is not measured, so it stays.
    const untrimmed: Record<string, unknown> = { seo_title: '  M009 Rand  ' };
    SEO_TITLE.apply(untrimmed, '  M009 Rand  ');
    expect(untrimmed).toEqual({ seo_title: null });
    const spaced: Record<string, unknown> = { seo_title: 'Neu ' };
    SEO_TITLE.apply(spaced, 'Neu');
    expect(spaced).toEqual({ seo_title: 'Neu ' });
    // Another title, or none known, leaves the SEO title as it is.
    const other: Record<string, unknown> = { seo_title: 'Neu' };
    SEO_TITLE.apply(other, 'Alt');
    expect(other).toEqual({ seo_title: 'Neu' });
    const unknown: Record<string, unknown> = { seo_title: 'Neu' };
    SEO_TITLE.apply(unknown, null);
    expect(unknown).toEqual({ seo_title: 'Neu' });
  });
});

describe('shopifySavedForm', () => {
  it('takes the title after the write from the value itself, else from the title read', () => {
    // A run that sets the title: its own title decides, not the one read.
    expect(shopifySavedForm({ title: 'Neu', seo_title: 'Neu', seo_description: 'D' }, 'Alt'))
      .toEqual({ title: 'Neu', seo_title: null, seo_description: 'D' });
    expect(shopifySavedForm({ title: 'Neu', seo_title: 'Alt', seo_description: 'D' }, 'Alt'))
      .toEqual({ title: 'Neu', seo_title: 'Alt', seo_description: 'D' });
    // A run that sets only the SEO pair: the title read with the product.
    expect(shopifySavedForm({ seo_title: 'T1', seo_description: 'D' }, 'T1')).toEqual({ seo_title: null, seo_description: 'D' });
    expect(shopifySavedForm({ seo_title: 'T1', seo_description: 'D' }, null)).toEqual({ seo_title: 'T1', seo_description: 'D' });
  });

  it('leaves the value it is handed unchanged, and anything that is no object as it is', () => {
    const value = { title: ' Neu ', seo_title: 'Neu' };
    shopifySavedForm(value, null);
    expect(value).toEqual({ title: ' Neu ', seo_title: 'Neu' });
    expect(shopifySavedForm(null, 'T')).toBeNull();
    expect(shopifySavedForm('Neu', 'Neu')).toBe('Neu');
  });
});

describe('productTitleOf', () => {
  it('answers the title of a product read, and null where it holds none', () => {
    expect(productTitleOf({ title: 'T', seo_title: null })).toBe('T');
    expect(productTitleOf({ seo_title: 'T' })).toBeNull();
    expect(productTitleOf({ title: null })).toBeNull();
    expect(productTitleOf(['T'])).toBeNull();
    expect(productTitleOf(null)).toBeNull();
  });
});
