import { describe, expect, it } from 'vitest';
import { isOutboundEffectWrite, outboundEffectField } from './outbound-write.js';

const BEXIO = 'https://api.bexio.com';

// Which spellings bexio's router reads as an action is not documented, so a write path counts
// when its segment spells an action in any of them, before or after other text.
describe('isOutboundEffectWrite — spellings of an action', () => {
  it.each([
    ['/2.0/kb_invoice/1/_send', true],
    ['/2.0/kb_invoice/1/x.send', true],
    ['/2.0/kb_invoice/1/mark-as-sent', true],
    ['/2.0/kb_invoice/1/markAsSent', true],
    ['/2.0/kb_invoice/1/mark.as.sent.json', true],
    ['/2.0/kb_invoice/1/kb_reminder/2/mark-as-unsent', true],
    ['/2.0/kb_invoice/1/revert-issue', true],
    ['/4.0/purchase/outgoing_payments', true],
    ['/4.0/purchase/outgoingPayments', true],
    ['/2.0/kb_offer/1/x-accept-y', true],
    // A run of letters and digits is never cut: these spell no action.
    ['/2.0/kb_invoice/1/resend', false],
    ['/2.0/kb_invoice/1/sender', false],
    ['/2.0/kb_invoice/1/mark_as_sentx', false],
    ['/2.0/kb_invoice/1/mark_as', false],
    ['/2.0/kb_invoice/1/as_sent', false],
    ['/4.0/purchase/outgoing', false],
  ] as const)('POST %s → %s', (path, want) => {
    expect(isOutboundEffectWrite(`${BEXIO}${path}`, 'POST')).toBe(want);
  });

  // Spelling every run onward to the segment's end took seconds here (cubic in its length).
  it('reads a long segment of many runs in linear time, and still finds an action at its end', () => {
    const long = 'a.'.repeat(2500);
    const started = performance.now();
    expect(isOutboundEffectWrite(`${BEXIO}/2.0/contact/${long}`, 'POST')).toBe(false);
    expect(isOutboundEffectWrite(`${BEXIO}/2.0/contact/${long}send`, 'POST')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('outboundEffectField — bexio bills and payroll', () => {
  it.each([
    ['/4.0/purchase/bills', 'payment', 'money'],
    ['/4.0/purchase/bills/0b3e5f2a-1c4d-4e8f-9a7b-2c6d8e0f1a3b', 'payment', 'money'],
    ['/4.0/payroll/employees', 'iban', 'money'],
    ['/4.0/payroll/employees/7', 'iban', 'money'],
    ['/4.0/payroll/employees/7', 'email', 'data_to_third_party'],
  ] as const)('%s with %s sets off %s', (path, field, effect) => {
    expect(outboundEffectField(`${BEXIO}${path}`, { [field]: {}, note: 'x' })).toMatchObject({ field, effect });
  });

  it.each([
    ['/4.0/purchase/bills', { title: 'x' }],
    ['/4.0/purchase/bills/7/attachments', { payment: {} }],
    ['/x/4.0/purchase/bills', { payment: {} }],
    ['/4.0/payroll/employees', { firstname: 'x' }],
    ['/4.0/payroll/employees/7/absences', { iban: 'x' }],
    ['/x/4.0/payroll/employees/7', { iban: 'x' }],
    ['/4.0/payroll/employees/7/absences', { email: 'x' }],
    ['/x/4.0/payroll/employees/7', { email: 'x' }],
    // The repetition entry is the order's own path, nothing below it.
    ['/2.0/kb_order/4/repetition/x', { end: '' }],
  ] as const)('%s with %j sets off nothing', (path, body) => {
    expect(outboundEffectField(`${BEXIO}${path}`, body)).toBeNull();
  });

  it('holds the bill and payroll entries to bexio', () => {
    expect(outboundEffectField('https://api.example.com/4.0/purchase/bills', { payment: {} })).toBeNull();
    expect(outboundEffectField('https://api.example.com/4.0/payroll/employees', { iban: 'x' })).toBeNull();
    expect(outboundEffectField('https://api.example.com/4.0/payroll/employees', { email: 'x' })).toBeNull();
  });
});
