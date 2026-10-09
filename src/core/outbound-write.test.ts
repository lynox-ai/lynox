import { describe, it, expect } from 'vitest';
import {
  bodyFieldNames, bodyForQuestion, carriesInlineBinary, effectiveWriteMethod, retargetingHeader, isOutboundEffectWrite, normalizeWritePath, pathForQuestion,
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

describe('bodyForQuestion (N12-4)', () => {
  const none = (t: string) => t;
  it('indents a canonical JSON body', () => {
    expect(bodyForQuestion('{"a":1,"b":[2]}', none)).toEqual({ text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}' });
    expect(bodyForQuestion('{ "a" : 1 }', none)).toEqual({ text: '{\n  "a": 1\n}' });
  });
  it('shows a non-canonical JSON body as it is sent', () => {
    expect(bodyForQuestion('{"a":"\\u0041"}', none)).toEqual({ text: '{"a":"\\u0041"}' });
    expect(bodyForQuestion('{"a":1,"a":2}', none)).toEqual({ text: '{"a":1,"a":2}' });
  });
  it('masks each decoded string of a canonical body, and refuses an escaped secret in another', () => {
    const mask = (t: string) => t.replaceAll('s"x', '[s]');
    expect(bodyForQuestion(JSON.stringify({ k: 's"x' }), mask)).toEqual({ text: '{\n  "k": "[s]"\n}' });
    expect(bodyForQuestion('{"k":"\\u0073\\"x"}', mask)).toEqual({ unshowable: 'escaped-secret' });
  });
  const FORM = 'application/x-www-form-urlencoded; charset=utf-8';
  it('shows a form body one pair per line, masked raw and decoded', () => {
    const mask = (t: string) => t.replaceAll('a+b', '[s]');
    expect(bodyForQuestion('x=a+b&y=%41', mask, FORM)).toEqual({ text: 'x = [s]\ny = A' });
  });
  it('masks a form body WHOLE before cutting it, so a secret holding = or & stays one value', () => {
    const mask = (t: string) => t.replaceAll('k=v&w', '[s]');
    const shown = bodyForQuestion('token=k=v&w&n=1', mask, FORM);
    expect(shown).toEqual({ text: 'token = [s]\nn = 1' });
  });
  it('shows a form-shaped body pair by pair ONLY when it is sent as a form', () => {
    expect(bodyForQuestion('x=a+b', none, 'text/plain')).toEqual({ text: 'x=a+b' });
    expect(bodyForQuestion('x=a+b', none)).toEqual({ text: 'x=a+b' });
  });
  it('shows a line break inside a decoded form value as \\n, so it cannot add a line', () => {
    expect(bodyForQuestion('note=ok%0Aamount+%3D+1', none, FORM)).toEqual({ text: 'note = ok\\namount = 1' });
  });
  it('shows a secret written plainly in a non-canonical body masked, not refused', () => {
    const mask = (t: string) => t.replaceAll('sk-plain', '[s]');
    expect(bodyForQuestion('{"a":"sk-plain","a":"x"}', mask)).toEqual({ text: '{"a":"[s]","a":"x"}' });
    // Non-canonical without a duplicate key (`1.0` is sent, `1` would be re-serialized), so the
    // secret is still in the parsed body and only masking the TEXT first removes it.
    expect(bodyForQuestion('{"a":"sk-plain","n":1.0}', mask)).toEqual({ text: '{"a":"[s]","n":1.0}' });
    expect(bodyForQuestion('{ "a" :"sk-plain" }', mask)).toEqual({ text: '{\n  "a": "[s]"\n}' });
  });
  // The secret below, percent-encoded: the text mask does not see it, the server may decode it.
  const enc = (t: string) => [...t].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
  const vault = (t: string) => t.replaceAll('hunter2secret', '[s]').replaceAll('Key=abcd', '[k]');
  it('refuses a body whose percent-decoded form still holds a secret, sent as any type', () => {
    expect(bodyForQuestion(`x=${enc('hunter2secret')}`, vault)).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion(`x=${enc('hunter2secret')}`, vault, 'text/plain')).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion(`x=${enc('hunter2secret')}`, vault, FORM)).toEqual({ text: 'x = [s]' });
    // Positive control on the same machinery: an encoded value that is no secret is shown.
    expect(bodyForQuestion(`x=${enc('harmless')}`, vault, 'text/plain')).toEqual({ text: `x=${enc('harmless')}` });
  });
  it('refuses a secret whose space is sent as +, a form server reads it decoded', () => {
    const spaced = (t: string) => t.replaceAll('pass word', '[s]');
    expect(bodyForQuestion('x=pass+word', spaced, 'text/plain')).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion('x=pass+port', spaced, 'text/plain')).toEqual({ text: 'x=pass+port' });
  });
  it('refuses a non-canonical JSON body the mask turned into something no longer JSON', () => {
    const across = (t: string) => t.replaceAll('.0,"b', '[s]');
    expect(bodyForQuestion('{"a":1.0,"b":2}', across)).toEqual({ unshowable: 'escaped-secret' });
  });
  it('refuses a form whose masked secret removed its structure while another pair is encoded', () => {
    expect(bodyForQuestion(`Key=abcd&y=${enc('hunter2secret')}`, vault, FORM)).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion('Key=abcd&y=1', vault, FORM)).toEqual({ text: '[k]&y=1' });
  });
  it('refuses an escaped secret under a key a later duplicate shadows', () => {
    expect(bodyForQuestion('{"a":"\\u0068unter2secret","a":"x"}', vault)).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion('{"\\u0068unter2secret":1,"a":1.0}', vault)).toEqual({ unshowable: 'escaped-secret' });
  });
  it('shows pairs only for the form type alone, not for a list of types or a parameter naming it', () => {
    expect(bodyForQuestion('x=1', none, 'Application/X-WWW-Form-Urlencoded ; charset=utf-8')).toEqual({ text: 'x = 1' });
    expect(bodyForQuestion('x=1', none, 'text/plain, application/x-www-form-urlencoded')).toEqual({ text: 'x=1' });
    expect(bodyForQuestion('x=1', none, 'text/plain; x=application/x-www-form-urlencoded')).toEqual({ text: 'x=1' });
  });
  it('makes invisible characters visible as their code point instead of removing them', () => {
    expect(bodyForQuestion('ad\u200bmin\u2028x', none)).toEqual({ text: 'ad⟨U+200B⟩min⟨U+2028⟩x' });
  });
});

describe('percent-decoding as a server reads it (F-A, F-B)', () => {
  const enc = (t: string) => [...t].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
  const vault = (t: string) => t.replaceAll('hunter2secret', '[s]');
  const FORM = 'application/x-www-form-urlencoded';
  it('an invalid byte before an encoded secret does not hide it from the mask', () => {
    expect(bodyForQuestion(`x=%FF${enc('hunter2secret')}`, vault, 'text/plain')).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion(`x=%C3${enc('hunter2secret')}`, vault)).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion(`x=%FF${enc('hunter2secret')}`, vault, FORM)).toEqual({ text: 'x = \uFFFD[s]' });
    expect(pathForQuestion(`https://h.example/a/%FF${enc('hunter2secret')}`, vault)).toBe('/a/\uFFFD[s]');
    expect(bodyFieldNames(`%FF${enc('hunter2secret')}=1`, vault)).toBe('fields "\uFFFD[s]"');
  });
  it('positive control: an invalid byte before harmless text is shown as U+FFFD, nothing refused', () => {
    expect(bodyForQuestion(`x=%FF${enc('harmless')}`, vault, FORM)).toEqual({ text: 'x = \uFFFDharmless' });
    expect(pathForQuestion(`https://h.example/a/%FF${enc('harmless')}`, vault)).toBe('/a/\uFFFDharmless');
  });
  it('keeps a leading byte-order mark instead of dropping it', () => {
    expect(bodyForQuestion('x=%EF%BB%BFa', (t) => t, FORM)).toEqual({ text: 'x = ⟨U+FEFF⟩a' });
  });
  it('a secret percent-encoded inside a JSON string is never shown, canonical or not, value or key', () => {
    expect(bodyForQuestion(JSON.stringify({ a: enc('hunter2secret') }), vault)).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion(JSON.stringify({ [enc('hunter2secret')]: 1 }), vault)).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion(`{"a":"${enc('hunter2secret')}","n":1.0}`, vault)).toEqual({ unshowable: 'escaped-secret' });
  });
  it('positive control: encoded text that is no secret, and a plain secret, are shown in JSON', () => {
    expect(bodyForQuestion(JSON.stringify({ a: '100%25 sure', b: 'hunter2secret' }), vault)).toEqual({ text: '{\n  "a": "100%25 sure",\n  "b": "[s]"\n}' });
    expect(bodyForQuestion('{"a":"100%25 sure","n":1.0}', vault)).toEqual({ text: '{"a":"100%25 sure","n":1.0}' });
  });
});

describe('carriesInlineBinary (N12-4)', () => {
  const b64 = 'QUJD'.repeat(300);
  it.each([
    [b64, true],
    [`data:image/png;base64,${b64}`, true],
    [JSON.stringify({ image: { attachment: b64 } }), true],
    [JSON.stringify({ text: 'word '.repeat(400) }), false],
    ['QUJD'.repeat(10), false],
  ])('%#', (body, want) => {
    expect(carriesInlineBinary(body)).toBe(want);
  });
});
