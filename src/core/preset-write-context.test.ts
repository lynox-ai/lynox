import { describe, it, expect } from 'vitest';
import { PRESET_WRITE_CONTEXT, WriteContextRefused, sumOfPositions, type PresetRead } from './preset-write-context.js';

/**
 * What the question before a bexio write shows, from readings of the account: the document,
 * the recipient by name, the amount. A fake account answers the readings; `reads` records
 * every path asked for.
 */

const ACCOUNT: Record<string, Record<string, unknown>> = {
  '/2.0/contact/17': { id: 17, name_1: 'Muster AG', name_2: '' },
  '/3.0/currencies/1': { id: 1, name: 'CHF', round_factor: 0.05 },
  '/2.0/kb_invoice/7': {
    id: 7, document_nr: 'RE-00042', contact_address: 'Muster AG\nMusterstrasse 15\n8640 Rapperswil',
    total: '19.150000', total_remaining_payments: '4.150000', currency_id: 1,
  },
  '/2.0/kb_offer/8': { id: 8, document_nr: 'AN-00008', contact_address: 'Muster AG', total: '250.000000', currency_id: 1 },
};

function account(): { read: PresetRead; reads: string[] } {
  const reads: string[] = [];
  const read: PresetRead = async (path) => {
    reads.push(path);
    const found = ACCOUNT[path];
    if (found === undefined) throw new WriteContextRefused(`reading ${path} answered 404`);
    return found;
  };
  return { read, reads };
}

const bexio = PRESET_WRITE_CONTEXT['bexio']!;
const at = (path: string): URL => new URL(`https://api.bexio.com${path}`);

describe('the question before a bexio write shows what it changes', () => {
  it('a new invoice: the recipient by name, and the sum of its positions with the currency', async () => {
    const { read, reads } = account();
    const body = JSON.stringify({
      contact_id: 17, currency_id: 1, positions: [
        { type: 'KbPositionCustom', amount: '2', unit_price: '500', discount_in_percent: '0' },
        { type: 'KbPositionArticle', amount: '1.000000', unit_price: '250.000000', discount_in_percent: '20' },
        { type: 'KbPositionText', text: 'Thank you' },
      ],
    });
    const text = await bexio.describe('POST', at('/2.0/kb_invoice'), body, read);
    expect(text).toBe('New bexio invoice · recipient: Muster AG (contact 17) · sum of positions: CHF 1200.00 ' +
      "(quantity × unit price less each position's discount; bexio adds tax and rounds)");
    expect(reads).toEqual(['/2.0/contact/17', '/3.0/currencies/1']);
  });

  it.each([
    ['cancel', '/2.0/kb_invoice/7/cancel', 'POST', undefined],
    ['a payment', '/2.0/kb_invoice/7/payment', 'POST', '{"value":"4.15","date":"2026-10-14"}'],
    ['a deleted invoice', '/2.0/kb_invoice/7', 'DELETE', undefined],
    ['a new position', '/2.0/kb_invoice/7/kb_position_discount', 'POST', '{"value":"5","is_percentual":false}'],
  ])('%s: the invoice is read first, with its number, recipient, total and open amount', async (_label, path, method, body) => {
    const { read, reads } = account();
    expect(await bexio.describe(method, at(path), body, read)).toBe(
      'bexio invoice RE-00042 · recipient: Muster AG, Musterstrasse 15, 8640 Rapperswil · total CHF 19.15, open CHF 4.15',
    );
    expect(reads).toEqual(['/2.0/kb_invoice/7', '/3.0/currencies/1']);
  });

  it('a quote is read the same way, without an open amount', async () => {
    const { read } = account();
    expect(await bexio.describe('POST', at('/2.0/kb_offer/8/accept'), undefined, read))
      .toBe('bexio quote AN-00008 · recipient: Muster AG · total CHF 250.00');
  });

  it('matches the path without regard to case or empty segments', async () => {
    const { read, reads } = account();
    expect(await bexio.describe('POST', at('/2.0//KB_INVOICE/7/Cancel'), undefined, read)).toContain('RE-00042');
    expect(reads[0]).toBe('/2.0/kb_invoice/7');
  });

  it('a note names its contact by name', async () => {
    const { read } = account();
    expect(await bexio.describe('POST', at('/2.0/note'), '{"contact_id":"17","subject":"Call back"}', read)).toBe('bexio contact 17: Muster AG');
  });

  it.each([
    ['a changed contact', '/2.0/contact/17', '{"name_1":"Muster AG"}'],
    ['a contact search', '/2.0/contact/search', '[{"field":"name_1","value":"Muster"}]'],
    ['an invoice search', '/2.0/kb_invoice/search', '[{"field":"title","value":"x"}]'],
    ['a path outside 2.0', '/3.0/currencies', '{"name":"EUR","round_factor":0.01}'],
  ])('%s needs no reading and is asked with its body', async (_label, path, body) => {
    const { read, reads } = account();
    expect(await bexio.describe('POST', at(path), body, read)).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe('a bexio write whose question cannot show it is refused, before any reading it cannot trust', () => {
  async function refusal(method: string, path: string, body: string | undefined): Promise<{ message: string; reads: string[] }> {
    const { read, reads } = account();
    const err = await bexio.describe(method, at(path), body, read).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WriteContextRefused);
    return { message: (err as Error).message, reads };
  }

  it('a new document with a discount position, naming the way out word for word', async () => {
    const { message, reads } = await refusal('POST', '/2.0/kb_invoice', JSON.stringify({
      contact_id: 17, currency_id: 1, positions: [{ type: 'KbPositionDiscount', value: '10', is_percentual: true }],
    }));
    expect(message).toContain('Create the document without discount or sub-positions first, then add each of those positions in its own call.');
    expect(reads).toEqual(['/2.0/contact/17']);
  });

  it('a new document with a sub-position, with the same way out', async () => {
    const { message } = await refusal('POST', '/2.0/kb_offer', JSON.stringify({
      contact_id: 17, currency_id: 1, positions: [{ type: 'KbPositionSubposition', text: 'Group' }],
    }));
    expect(message).toContain('Create the document without discount or sub-positions first, then add each of those positions in its own call.');
  });

  it('an article position without a price', async () => {
    const { message } = await refusal('POST', '/2.0/kb_invoice', JSON.stringify({
      contact_id: 17, currency_id: 1, positions: [{ type: 'KbPositionArticle', amount: '1', article_id: 3 }],
    }));
    expect(message).toContain('Name a unit_price on each article position, so the question can show the sum.');
  });

  it.each([['contact_id'], ['currency_id']])('a new invoice that names no %s', async (field) => {
    const fields: Record<string, unknown> = { contact_id: 17, currency_id: 1 };
    delete fields[field];
    const { message } = await refusal('POST', '/2.0/kb_invoice', JSON.stringify(fields));
    expect(message).toContain(`names no ${field}`);
  });

  it.each([
    ['an order', '/2.0/kb_order/3/invoice'],
    ['an order, upper case', '/2.0/KB_ORDER/3'],
    ['an order position', '/2.0/kb_order/3/kb_position_custom'],
    ['a delivery', '/2.0/kb_delivery/4/issue'],
  ])('a write to another bexio document type: %s', async (_label, path) => {
    const { message, reads } = await refusal('POST', path, '{}');
    expect(message).toMatch(/does not write to bexio's kb_(order|delivery) documents/);
    expect(reads).toEqual([]);
  });

  it.each([
    ['a document id that is not digits', 'POST', '/2.0/kb_invoice/7abc/cancel', undefined],
    ['a document id that is a word', 'POST', '/2.0/kb_invoice/copy', '{}'],
    ['a contact id with a path in it', 'POST', '/2.0/note', '{"contact_id":"17/../../kb_invoice/7"}'],
    ['a contact id with a query in it', 'POST', '/2.0/task', '{"contact_id":"17?x=1"}'],
    ['a contact id that is a fraction', 'POST', '/2.0/note', '{"contact_id":17.5}'],
  ])('%s: refused, nothing is read', async (_label, method, path, body) => {
    const { message, reads } = await refusal(method, path, body);
    expect(message).toContain('is not a plain number');
    expect(reads).toEqual([]);
  });

  it('a reading that fails refuses, it does not describe less', async () => {
    const { message } = await refusal('POST', '/2.0/kb_invoice/99/cancel', undefined);
    expect(message).toBe('reading /2.0/kb_invoice/99 answered 404');
  });

  it('a document without a total refuses', async () => {
    ACCOUNT['/2.0/kb_offer/9'] = { document_nr: 'AN-9', contact_address: 'Muster AG', currency_id: 1 };
    const { message } = await refusal('POST', '/2.0/kb_offer/9/accept', undefined);
    expect(message).toContain('no total');
  });
});

describe('the sum of positions', () => {
  it('rounds half away from zero to cents', () => {
    expect(sumOfPositions([{ type: 'KbPositionCustom', amount: '3', unit_price: '0.335' }])).toBe('1.01');
  });

  it('takes the discount per position, in exact decimals', () => {
    expect(sumOfPositions([
      { type: 'KbPositionCustom', amount: '3', unit_price: '0.1', discount_in_percent: '0' },
      { type: 'KbPositionCustom', amount: '1', unit_price: '100', discount_in_percent: '12.5' },
    ])).toBe('87.80');
  });

  it('refuses an amount written as an exponent', () => {
    expect(() => sumOfPositions([{ type: 'KbPositionCustom', amount: 1e21, unit_price: '1' }])).toThrow(WriteContextRefused);
  });

  it('refuses a discount above 100 percent', () => {
    expect(() => sumOfPositions([{ type: 'KbPositionCustom', amount: '1', unit_price: '1', discount_in_percent: '150' }])).toThrow(/outside 0 to 100/);
  });
});
