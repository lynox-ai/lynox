import { describe, it, expect } from 'vitest';
import { BULK_UNMEASURED_CONFIRMATION, BULK_UNMEASURED_NOTE, isMeasuredWriteForm, writeFormOf } from './bulk-write-forms.js';

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

  it('carries the approved texts word for word', () => {
    expect(BULK_UNMEASURED_NOTE).toBe('lynox has not checked this kind of change with this provider. It can trigger something else there, such as emails to your customers, a payment or an invoice. So lynox writes one target first. Check it there before you approve the rest.');
    expect(BULK_UNMEASURED_CONFIRMATION).toBe('I know lynox has not checked this kind of change, and I approve it anyway.');
  });
});
