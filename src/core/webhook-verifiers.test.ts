import { describe, it, expect } from 'vitest';
import { MAPPED_VALUE_MAX_CHARS, MAPPING_MAX_ENTRIES, extractMappedValues, parseWebhookSpec } from './webhook-verifiers.js';

const spec = (mapping: unknown): string => JSON.stringify({ webhook: { verifier: 'shopify-hmac', mapping } });
const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

// A mapping is read where the verifier is: a malformed one leaves the trigger without a
// verifier, so it accepts no delivery rather than running with fewer values.
describe('parseWebhookSpec reads a mapping', () => {
  it('keeps a well-formed mapping', () => {
    expect(parseWebhookSpec(spec({ email: '/customer/email', first: '/line_items/0/title' }))).toEqual({
      verifier: 'shopify-hmac',
      mapping: { email: '/customer/email', first: '/line_items/0/title' },
    });
  });

  it('CONTROL: a spec without a mapping has none', () => {
    expect(parseWebhookSpec(JSON.stringify({ webhook: { verifier: 'shopify-hmac' } }))).toEqual({ verifier: 'shopify-hmac' });
  });

  it.each([
    ['not an object', '/a'],
    ['an array', ['/a']],
    ['empty', {}],
    ['a name that is not a parameter name', { 'a-b': '/a' }],
    ['a name that starts with a digit', { '1a': '/a' }],
    ['a pointer without a leading slash', { a: 'a/b' }],
    ['the whole document', { a: '' }],
    ['an escape other than ~0 and ~1', { a: '/a~2' }],
    ['a pointer that is not a string', { a: 1 }],
    ['a pointer longer than 256 characters', { a: `/${'x'.repeat(256)}` }],
  ])('refuses a mapping that is %s', (_label, mapping) => {
    expect(parseWebhookSpec(spec(mapping))).toBeNull();
  });

  it(`takes ${String(MAPPING_MAX_ENTRIES)} entries and refuses one more`, () => {
    const entries = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${String(i)}`, `/f${String(i)}`]));
    expect(parseWebhookSpec(spec(entries(MAPPING_MAX_ENTRIES)))?.mapping).toBeDefined();
    expect(parseWebhookSpec(spec(entries(MAPPING_MAX_ENTRIES + 1)))).toBeNull();
  });

  it('keeps the mapping of a shared-token spec too', () => {
    const hash = 'a'.repeat(64);
    expect(parseWebhookSpec(JSON.stringify({ webhook: { verifier: 'shared-token', shared_token_hash: hash, mapping: { id: '/id' } } })))
      .toEqual({ verifier: 'shared-token', sharedTokenHash: hash, mapping: { id: '/id' } });
  });
});

describe('extractMappedValues reads the verified body', () => {
  it('reads strings, numbers and booleans by pointer, through objects and arrays', () => {
    const order = { id: 42, test: false, customer: { email: 'kim@example.com' }, line_items: [{ title: 'Mug' }, { title: 'Tea' }] };
    expect(extractMappedValues(body(order), { id: '/id', test: '/test', email: '/customer/email', second: '/line_items/1/title' })).toEqual({
      values: { id: 42, test: false, email: 'kim@example.com', second: 'Tea' },
      unread: {},
    });
  });

  it('unescapes ~1 as / and ~0 as ~, in that order', () => {
    expect(extractMappedValues(body({ 'a/b': 1, 'c~d': 2, '~1': 3 }), { slash: '/a~1b', tilde: '/c~0d', literal: '/~01' }).values)
      .toEqual({ slash: 1, tilde: 2, literal: 3 });
  });

  it('leaves out what is not a single value, with the reason', () => {
    const out = extractMappedValues(body({ a: null, b: { c: 1 }, d: [1] }), { a: '/a', b: '/b', d: '/d', missing: '/x' });
    expect(out.values).toEqual({});
    expect(out.unread).toEqual({
      a: 'the field is null',
      b: 'the field is not a single value',
      d: 'the field is not a single value',
      missing: 'the event has no field there',
    });
  });

  it(`keeps a string of ${String(MAPPED_VALUE_MAX_CHARS)} characters and leaves out a longer one`, () => {
    const out = extractMappedValues(body({ ok: 'x'.repeat(MAPPED_VALUE_MAX_CHARS), long: 'x'.repeat(MAPPED_VALUE_MAX_CHARS + 1) }), { ok: '/ok', long: '/long' });
    expect(out.values['ok']).toHaveLength(MAPPED_VALUE_MAX_CHARS);
    expect(out.unread).toEqual({ long: `longer than ${String(MAPPED_VALUE_MAX_CHARS)} characters` });
  });

  it('reads an array index only in its canonical form', () => {
    const out = extractMappedValues(body({ a: ['x', 'y'] }), { lead: '/a/01', dash: '/a/-', past: '/a/2', ok: '/a/1' });
    expect(out.values).toEqual({ ok: 'y' });
    expect(Object.keys(out.unread).sort()).toEqual(['dash', 'lead', 'past']);
  });

  it('reads only the event\'s own fields, never an inherited one', () => {
    const raw = Buffer.from('{"__proto__":"own","x":{}}', 'utf8');
    const out = extractMappedValues(raw, { proto: '/__proto__', ctor: '/x/constructor', str: '/x/toString' });
    expect(out.values).toEqual({ proto: 'own' });
    // Not found at all, rather than found and then refused as a function.
    expect(out.unread).toEqual({ ctor: 'the event has no field there', str: 'the event has no field there' });
  });

  it('reads nothing from a body that is not JSON or not UTF-8', () => {
    for (const raw of [Buffer.from('not json', 'utf8'), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
      expect(extractMappedValues(raw, { a: '/a' })).toEqual({ values: {}, unread: { a: 'the body is not JSON' } });
    }
  });
});
