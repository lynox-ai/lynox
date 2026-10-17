import { describe, it, expect } from 'vitest';
import { BULK_UNMEASURED_CONFIRMATION, BULK_UNMEASURED_NOTE, MEASURED_WRITE_FORMS, isMeasuredWriteForm, writeFormOf } from './bulk-write-forms.js';
import { OUTBOUND_EFFECT_FIELDS } from './outbound-write.js';

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
    for (const form of MEASURED_WRITE_FORMS) {
      // One concrete target of the form, built from its own pattern; it must match that pattern,
      // or the sample says nothing about the form.
      const sample = form.path.source.replace(/^\^|\$$/g, '').replace(/\\([/.])/g, '$1').replace(/\[0-9\]\+/g, '7');
      expect(form.path.test(sample), `cannot build a sample target for ${form.path.source}`).toBe(true);
      for (const entry of OUTBOUND_EFFECT_FIELDS) {
        const sameHost = form.host === null || entry.host === undefined || form.host === entry.host;
        expect(sameHost && entry.path.test(sample),
          `measured form ${form.host ?? 'any host'} ${sample} carries a field of the field-effect table (${entry.says}): `
          + 'write a test that drives this form through approval into that block, then allow this overlap here').toBe(false);
      }
    }
  });

  it('carries the approved texts word for word', () => {
    expect(BULK_UNMEASURED_NOTE).toBe('lynox has not checked this kind of change with this provider. It can trigger something else there, such as emails to your customers, a payment or an invoice. So lynox writes one target first. Check it there before you approve the rest.');
    expect(BULK_UNMEASURED_CONFIRMATION).toBe('I know lynox has not checked this kind of change, and I approve it anyway.');
  });
});
