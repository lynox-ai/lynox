import { describe, it, expect } from 'vitest';
import { BULK_UNMEASURED_CONFIRMATION, BULK_UNMEASURED_NOTE, MEASURED_SHOPIFY_FORMS, MEASURED_WRITE_FORMS, isMeasuredShopifySend, isMeasuredShopifyWrite, isMeasuredWriteForm, writeFormOf } from './bulk-write-forms.js';
import { SHOPIFY_WRITE_DOCUMENTS, shopifyAdminApiVersion, shopifyProductWriteBody } from './shopify-graphql.js';
import { OUTBOUND_EFFECT_FIELDS, OUTBOUND_EFFECT_PATHS, isOutboundEffectWrite, normalizeWritePath } from './outbound-write.js';

describe('measured write forms', () => {
  it('knows WooCommerce products on any host, with each verb that was measured', () => {
    for (const host of ['shop.example.com', 'another-shop.example']) {
      for (const method of ['PUT', 'PATCH', 'POST']) expect(isMeasuredWriteForm(host, '/wp-json/wc/v3/products/42', method), `${host} ${method}`).toBe(true);
    }
  });

  it('knows bexio contacts on bexio\'s host, written with POST only', () => {
    expect(isMeasuredWriteForm('api.bexio.com', '/2.0/contact/7', 'POST')).toBe(true);
    expect(isMeasuredWriteForm('api.bexio.com', '/2.0/contact/7', 'PUT')).toBe(false);
    expect(isMeasuredWriteForm('api.bexio.com', '/2.0/contact/7', 'PATCH')).toBe(false);
    expect(isMeasuredWriteForm('bexio.example.com', '/2.0/contact/7', 'POST')).toBe(false);
  });

  it('knows nothing else: another resource, a nested one, a prefix, a non-numeric id, another verb', () => {
    const host = 'shop.example.com';
    expect(isMeasuredWriteForm(host, '/wp-json/wc/v3/orders/42', 'PUT')).toBe(false);
    expect(isMeasuredWriteForm(host, '/wp-json/wc/v3/products/42/variations/3', 'PUT')).toBe(false);
    expect(isMeasuredWriteForm(host, '/shop/wp-json/wc/v3/products/42', 'PUT')).toBe(false);
    expect(isMeasuredWriteForm(host, '/wp-json/wc/v3/products/42x', 'PUT')).toBe(false);
    expect(isMeasuredWriteForm(host, '/wp-json/wc/v3/products/', 'PUT')).toBe(false);
    expect(isMeasuredWriteForm(host, '/wp-json/wc/v3/products/42', 'DELETE')).toBe(false);
    expect(isMeasuredWriteForm('api.bexio.com', '/2x0/contact/7', 'POST')).toBe(false);
  });

  it('calls a run measured only when every target is', () => {
    const woo = (i: number): string => `/wp-json/wc/v3/products/${String(i)}`;
    expect(writeFormOf('shop.example.com', [woo(1), woo(2)], 'PATCH')).toBe('measured');
    expect(writeFormOf('shop.example.com', [woo(1), '/wp-json/wc/v3/orders/2'], 'PATCH')).toBe('unmeasured');
    expect(writeFormOf('shop.example.com', ['/wp-json/wc/v3/orders/2', woo(1)], 'PATCH')).toBe('unmeasured');
    expect(writeFormOf('shop.example.com', [], 'PATCH')).toBe('unmeasured');
    expect(writeFormOf('shop.example.com', [woo(1)], null)).toBe('unmeasured');
  });

  // "Measured" frees a form from the notice and the per-run probe, never from the field-effect
  // table (outbound-write.ts): that block holds in the client whatever the form or the approval.
  // No test drives a measured form through approval into that block, because no measured form
  // lies on the table today. This keeps it so until one is written.
  it('lists no form that also lies on the field-effect table', () => {
    expect(MEASURED_WRITE_FORMS.length * OUTBOUND_EFFECT_FIELDS.length * OUTBOUND_EFFECT_PATHS.length).toBeGreaterThan(0);
    for (const form of MEASURED_WRITE_FORMS) {
      // One concrete target of the form, built from its own pattern. The pattern must match the
      // whole path and hold only plain path characters and `[0-9]+`, or a sample would not stand
      // for the paths it matches.
      const source = form.path.source;
      const literal = source.replace(/^\^|\$$/g, '').replace(/\\[/.]/g, '').replace(/\[0-9\]\+/g, '');
      expect(source.startsWith('^') && source.endsWith('$') && /^[A-Za-z0-9_-]*$/.test(literal),
        `cannot build a sample target for ${source}`).toBe(true);
      const sample = source.replace(/^\^|\$$/g, '').replace(/\\([/.])/g, '$1').replace(/\[0-9\]\+/g, '7');
      expect(form.path.test(sample), `cannot build a sample target for ${source}`).toBe(true);
      const advice = 'write a test that drives this form through approval into that block, then allow this overlap here';
      // As the client reads it: `normalizeWritePath` lower-cases and splits as the block does.
      const normalized = normalizeWritePath(sample);
      expect(normalized.ambiguous, `cannot build a sample target for ${source}`).toBe(false);
      const seen = normalized.path;
      for (const entry of OUTBOUND_EFFECT_FIELDS) {
        const sameHost = form.host === null || entry.host === undefined || form.host === entry.host;
        expect(sameHost && entry.path.test(seen),
          `measured form ${form.host ?? 'any host'} ${sample} carries a field of the field-effect table (${entry.says}): ${advice}`).toBe(false);
      }
      for (const entry of OUTBOUND_EFFECT_PATHS) {
        if (form.host !== null && form.host !== entry.host) continue;
        for (const method of form.methods) {
          expect(isOutboundEffectWrite(`https://${entry.host}${sample}`, method),
            `measured form ${form.host ?? 'any host'} ${sample} is a path of the outbound-effect table: ${advice}`).toBe(false);
        }
      }
    }
  });

  it('carries the approved texts word for word', () => {
    expect(BULK_UNMEASURED_NOTE).toBe('lynox has not checked this kind of change with this provider. It can trigger something else there, such as emails to your customers, a payment or an invoice. So lynox writes one target first. Check it there before you approve the rest.');
    expect(BULK_UNMEASURED_CONFIRMATION).toBe('I know lynox has not checked this kind of change, and I approve it anyway.');
  });
});

describe('measured Shopify write forms', () => {
  const doc = SHOPIFY_WRITE_DOCUMENTS.shopify_product;

  it('holds for the document and the API version that were measured, and for nothing else', () => {
    // A changed document or another version is a form nobody measured: it must be measured again.
    expect(MEASURED_SHOPIFY_FORMS.map((f) => [f.form, f.document, f.apiVersion])).toEqual([[
      'shopify_product',
      'mutation($id: ID!, $title: String, $seoTitle: String, $seoDescription: String) { productUpdate(product: {id: $id, title: $title, seo: {title: $seoTitle, description: $seoDescription}}) { product { id } userErrors { field message } } }',
      '2026-10',
    ]]);
    expect(doc).toBe(MEASURED_SHOPIFY_FORMS[0]!.document);
    expect(shopifyAdminApiVersion()).toBe('2026-10');
    const seo = { seoTitle: 'T', seoDescription: 'D' };
    expect(isMeasuredShopifySend('shopify_product', seo, doc, '2026-10')).toBe(true);
    expect(isMeasuredShopifySend('shopify_product', seo, doc.replace('title: $title, ', 'title: $title, handle: $title, '), '2026-10')).toBe(false);
    expect(isMeasuredShopifySend('shopify_product', seo, doc, '2027-01')).toBe(false);
    expect(isMeasuredShopifySend('shopify_product', seo, doc, null)).toBe(false);
    // Only the form that was measured: the same variables under another form are not.
    expect(isMeasuredShopifySend('shopify_media_alt', seo, doc, '2026-10')).toBe(false);
  });

  it('holds for the seo pair, the title, and both, with values and with the pair cleared', () => {
    for (const after of [
      { seo_title: 'T', seo_description: 'D' },
      { seo_title: null, seo_description: 'D' },
      { seo_title: '', seo_description: '' },
      { seo_title: null, seo_description: null },
      { title: 'Neu' },
      { title: 'Neu', seo_title: 'T', seo_description: null },
    ]) expect(isMeasuredShopifyWrite('shopify_product', after), JSON.stringify(after)).toBe(true);
  });

  it('does not hold for a title cleared, a field the document does not name, one seo field alone, or an image', () => {
    for (const after of [
      { title: null },
      { title: '' },
      { title: '', seo_title: 'T', seo_description: 'D' },
      { descriptionHtml: '<p>x</p>' },
      { seo_title: 'T' },
      { vendor: 'X' },
      {},
    ]) expect(isMeasuredShopifyWrite('shopify_product', after), JSON.stringify(after)).toBe(false);
    expect(isMeasuredShopifyWrite('shopify_media_alt', { alt: 'Bild' })).toBe(false);
  });

  it('judges exactly the variables the write body sends', () => {
    // The set comes from the body's own variables, not from what changed: an unchanged seo
    // description is still sent with the pair, so the write is the pair, which was measured.
    const after = { seo_title: 'Neu', seo_description: 'wie bisher' };
    const body = JSON.parse(shopifyProductWriteBody('gid://shopify/Product/1', after)!) as { variables: Record<string, unknown> };
    expect(Object.keys(body.variables).filter((k) => k !== 'id').sort()).toEqual(['seoDescription', 'seoTitle']);
    expect(isMeasuredShopifyWrite('shopify_product', after)).toBe(true);
    // The same field set judged on its own (what a diff against the before-image would see) is not measured.
    expect(isMeasuredShopifySend('shopify_product', { seoTitle: 'Neu' }, doc, '2026-10')).toBe(false);
  });
});
