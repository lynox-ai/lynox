import { describe, it, expect } from 'vitest';
import {
  bodyFieldNames, effectiveWriteMethod, retargetingHeader, isOutboundEffectWrite, normalizeWritePath, pathForQuestion,
} from './outbound-write.js';

const U = 'https://h.example/a';

describe('effectiveWriteMethod', () => {
  it.each([
    ['POST', {}, U, 'POST'],
    ['post', {}, U, 'POST'],
    ['POST', { 'X-HTTP-Method-Override': 'delete' }, U, 'DELETE'],
    ['POST', { 'x-http-method': 'PATCH' }, U, 'PATCH'],
    ['POST', { 'X-Method-Override': 'GET' }, U, 'POST'],
    ['DELETE', { 'X-HTTP-Method-Override': 'POST' }, U, 'DELETE'],
    ['GET', { ' X-HTTP-Method-Override ': ' PUT ' }, U, 'PUT'],
    ['GET', {}, 'https://h.example/a?_method=DELETE', 'DELETE'],
    ['GET', {}, 'https://h.example/a?_METHOD=post', 'POST'],
    ['GET', { 'X-Unrelated': 'DELETE' }, U, 'GET'],
    ['GET', { 'X-HTTP-Method-Override': '' }, U, 'GET'],
  ] as const)('%s with %j at %s is gated as %s', (method, headers, url, want) => {
    expect(effectiveWriteMethod(method, { ...headers }, url)).toBe(want);
  });
});

describe('retargetingHeader', () => {
  it('finds each header a server or proxy routes on, whatever its case, and no other', () => {
    for (const name of ['HoSt', 'X-Host', 'x-forwarded-host', 'Forwarded', 'X-Original-URL', 'x-rewrite-url']) {
      expect(retargetingHeader({ accept: 'x', [name]: 'y' })).toBe(name);
    }
    expect(retargetingHeader({ 'x-hosting': 'x', 'content-type': 'y' })).toBeUndefined();
  });
});

describe('effectiveWriteMethod refuses an override that is not a method', () => {
  it.each([
    ['header words', { 'X-HTTP-Method-Override': 'Looks safe: read only' }, 'https://h.example/a'],
    ['query value', {}, 'https://h.example/a?_method=my-secret-value'],
    ['digits', { 'x-method-override': 'DELETE1' }, 'https://h.example/a'],
  ] as const)('%s → null', (_k, headers, url) => {
    expect(effectiveWriteMethod('POST', { ...headers }, url)).toBeNull();
  });
});

describe('normalizeWritePath', () => {
  it.each([
    ['/a/b', '/a/b', false],
    ['/A//B/', '/a/b', false],
    ['/a/%73end', '/a/send', false],
    ['/a%2Fsend', '/a/send', false],
    ['/a/send;x=1/b', '/a/send/b', false],
    // A dot segment reaches this only from an encoded slash (WHATWG resolved the rest).
    ['/a/./b/../send', '/a/send', true],
    ['/a/%2e%2e/send', '/send', true],
    ['/a/1%5Csend', '/a/1/send', false],
    ['/a/send%00', '/a/send\u0000', true],
    ['/a/send%20', '/a/send ', true],
    ['/a/%C5%BFend', '/a/\u017fend', true],
    ['/a/%2573end', '/a/%73end', true],
    ['/a/%E0%A4%A', '/a/%e0%a4%a', true],
  ])('%s → %s (ambiguous %s)', (input, path, ambiguous) => {
    expect(normalizeWritePath(input)).toEqual({ path, ambiguous });
  });
});

describe('isOutboundEffectWrite', () => {
  it.each([
    ['https://api.bexio.com/2.0/kb_invoice/1/send', 'POST', true],
    ['https://api.bexio.com/2.0/kb_invoice/1/issue', 'PUT', true],
    ['https://API.BEXIO.COM./2.0/kb_invoice/1/send', 'POST', true],
    ['https://api.bexio.com/2.0/kb_invoice/1/%2573end', 'POST', true],
    ['https://api.bexio.com/2.0/kb_invoice/1/send.json', 'POST', true],
    ['https://api.bexio.com/2.0/kb_invoice/1/send/x%2F..%2F..', 'POST', true],
    ['https://api.bexio.com/2.0/kb_invoice/1%5Csend', 'POST', true],
    ['https://api.bexio.com/2.0/kb_invoice/1/%C4%B1ssue', 'POST', true],
    ['https://api.bexio.com/2.0/kb_invoice/1/send', 'GET', false],
    ['https://api.bexio.com/2.0/kb_invoice/1/sender', 'POST', false],
    ['https://api.bexio.com/2.0/contact', 'POST', false],
    ['https://other.example/2.0/kb_invoice/1/send', 'POST', false],
    ['https://other.example/%2573end', 'POST', false],
  ])('%s %s → %s', (url, method, want) => {
    expect(isOutboundEffectWrite(url, method)).toBe(want);
  });
});

describe('bodyFieldNames', () => {
  it('names JSON keys, never values', () => {
    const out = bodyFieldNames(JSON.stringify({ email: 'CANARY', amount: 5 }));
    expect(out).toBe('fields "email", "amount"');
  });
  it('names form keys, decoded', () => {
    expect(bodyFieldNames('first+name=CANARY&b=2')).toBe('fields "first name", "b"');
  });
  it('makes a name single-line and clips count and length', () => {
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
    expect(bodyFieldNames(JSON.stringify(many))).toMatch(/"k11" and 3 more$/);
    expect(bodyFieldNames(JSON.stringify({ 'a\nb‮c': 1 }))).toBe('fields "a bc"');
    expect(bodyFieldNames(JSON.stringify({ ['x'.repeat(60)]: 1 }))).toBe(`fields "${'x'.repeat(40)}…"`);
  });
  it('describes any other body by its size', () => {
    expect(bodyFieldNames('[1,2]')).toBe('body of 5 bytes');
    expect(bodyFieldNames('plain text')).toBe('body of 10 bytes');
    expect(bodyFieldNames(undefined)).toBe('no body');
    expect(bodyFieldNames('{}')).toBe('empty object');
  });
});

describe('pathForQuestion', () => {
  it('keeps the query keys, drops their values, and masks before it clips', () => {
    expect(pathForQuestion('https://h.example/v1/SECRET/x?a=1&b=CANARY&a=2', (t) => t.replaceAll('SECRET', '[s]')))
      .toBe('/v1/[s]/x?a=…&b=…');
  });
});

describe('effectiveWriteMethod refuses a method outside the known set', () => {
  it('whatever the schema offered', () => {
    expect(effectiveWriteMethod('Looks safe', {}, 'https://h.example/a')).toBeNull();
    expect(effectiveWriteMethod('propfind', {}, 'https://h.example/a')).toBe('PROPFIND');
  });
});

describe('masking reaches a secret the encoding hides (270, delta D2, D3)', () => {
  const mask = (secret: string) => (t: string) => t.replaceAll(secret, '[s]');
  it('a malformed % elsewhere in the path does not leave a secret encoded and unmasked', () => {
    expect(pathForQuestion('https://h.example/a%20b/%zz', mask('a b'))).toBe('/[s]/%zz');
  });
  it('a form field name is masked before + turns into a space', () => {
    expect(bodyFieldNames('ab+cd=1&x=2', mask('ab+cd'))).toBe('fields "[s]", "x"');
  });
});
