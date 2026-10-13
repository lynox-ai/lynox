import { describe, it, expect } from 'vitest';
import {
  bodyFieldNames, bodyForQuestion, carriesInlineBinary, effectiveWriteMethod, writeMethodsNamed, retargetingHeader, isOutboundEffectWrite, normalizeWritePath, outboundEffectField, pathForQuestion,
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

// A name counts when some common parser reads it as the override (PHP 8.3 `parse_str` measured,
// Express's `qs` measured, Rack 2 and ASP.NET MVC from their documented parsing), or when it is
// read as one on purpose (`_method[`: cut at the bracket); a name no parser reads as one stays a field.
describe('a query or form name a server may read as the override', () => {
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
  it.each([
    ['.method', 'DELETE'],
    ['%2Emethod', 'DELETE'],
    ['+_method', 'DELETE'],
    ['%20_method', 'DELETE'],
    ['_method%00x', 'DELETE'],
    ['_method[]', 'DELETE'],
    ['_method%5B%5D', 'DELETE'],
    ['_method[x]y', 'DELETE'],
    ['_method[a][b]', 'DELETE'],
    ['_method[', 'DELETE'],
    ['_method]', 'DELETE'],
    ['[_method]', 'DELETE'],
    [']]_method]]', 'DELETE'],
    ['._method', 'DELETE'],
    ['._method.', 'DELETE'],
    ['._method..', 'DELETE'],
    ['X-HTTP-Method-Override', 'DELETE'],
    ['x-method-override', 'DELETE'],
    ['+method', 'POST'],
    ['[method', 'POST'],
    ['_method.', 'POST'],
    ['_method+', 'POST'],
    ['%00_method', 'POST'],
    ['data[_method]', 'POST'],
    ['x[_method]', 'POST'],
    ['payment_method', 'POST'],
    ['_method.x', 'POST'],
    ['.x._method', 'POST'],
  ] as const)('%s=DELETE is gated as %s, in the query and in a form body', (name, want) => {
    expect(effectiveWriteMethod('POST', {}, `${U}?${name}=DELETE`)).toBe(want);
    expect(effectiveWriteMethod('POST', FORM, U, `${name}=DELETE`)).toBe(want);
  });

  it('reads a multipart part name the same way', () => {
    const MULTI = { 'Content-Type': 'multipart/form-data; boundary=b' };
    const part = (name: string) => `--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nDELETE\r\n--b--`;
    expect(effectiveWriteMethod('POST', MULTI, U, part('[_method]'))).toBe('DELETE');
    expect(effectiveWriteMethod('POST', MULTI, U, part('X-HTTP-Method-Override'))).toBe('DELETE');
    expect(effectiveWriteMethod('POST', MULTI, U, part('data[_method]'))).toBe('POST');
  });
});

describe('writeMethodsNamed', () => {
  it.each([
    ['PATCH', {}, U, ['PATCH']],
    [' patch ', {}, U, ['PATCH']],
    ['POST', { 'X-HTTP-Method-Override': 'PATCH' }, U, ['PATCH', 'POST']],
    ['POST', { 'x-method-override': 'patch' }, `${U}?_method=PUT`, ['PATCH', 'POST', 'PUT']],
    ['GET', { 'X-HTTP-Method': 'POST' }, U, ['POST']],
    ['POST', { 'X-HTTP-Method-Override': 'GET' }, U, ['POST']],
    ['GET', {}, U, []],
    ['POST', { 'X-Other': 'DELETE' }, U, ['POST']],
    ['POST', { 'X-HTTP-Method-Override': 'FOO' }, U, ['POST']],
  ] as const)('%s with %j at %s names %j', (method, headers, url, expected) => {
    expect(writeMethodsNamed(method, { ...headers }, url)).toEqual(expected);
  });

  it('names a write the body raises, and none for a GET whose body is not sent', () => {
    const J = { 'content-type': 'application/json' };
    expect(writeMethodsNamed('POST', J, U, '{"_method":"PUT"}')).toEqual(['POST', 'PUT']);
    expect(writeMethodsNamed('POST', { 'content-type': 'application/x-www-form-urlencoded' }, U, '_method=PATCH')).toEqual(['PATCH', 'POST']);
    expect(writeMethodsNamed('POST', J, U, '{"_method":"DELETE",')).toEqual(['DELETE', 'POST']);
    expect(writeMethodsNamed('GET', J, U, '{"_method":"DELETE"}')).toEqual([]);
    expect(writeMethodsNamed('POST', J, U, '{"note":"x"}')).toEqual(['POST']);
  });
});

describe('effectiveWriteMethod reads a top-level `_method` field of the body', () => {
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const JSON_T = { 'content-type': 'application/json; charset=utf-8' };
  const MULTI = { 'Content-Type': 'multipart/form-data; boundary=b' };
  it.each([
    ['form field', FORM, 'name=a&_method=DELETE', 'DELETE'],
    ['form field, percent-encoded name', FORM, '%5Fmethod=delete', 'DELETE'],
    ['form field asking for less', FORM, '_method=GET', 'POST'],
    ['form key nested in brackets', FORM, 'data[_method]=DELETE', 'POST'],
    ['form value that mentions it', FORM, 'note=_method%3DDELETE', 'POST'],
    ['JSON field', JSON_T, '{"_method":"PATCH"}', 'PATCH'],
    ['JSON field, escaped name', JSON_T, '{"_\\u006dethod":"DELETE"}', 'DELETE'],
    ['JSON field nested', JSON_T, '{"item":{"_method":"DELETE"}}', 'POST'],
    ['JSON field that only ends in method', JSON_T, '{"payment_method":"DELETE"}', 'POST'],
    ['JSON array at the top', JSON_T, '[{"_method":"DELETE"}]', 'POST'],
    ['JSON +json media type', { 'Content-Type': 'application/vnd.api+json' }, '{"_method":"DELETE"}', 'DELETE'],
    ['JSON that does not parse and mentions it', JSON_T, '{"_method":"DELETE",', 'DELETE'],
    ['JSON that does not parse and does not mention it', JSON_T, '{"a":1,', 'POST'],
    ['multipart that mentions it', MULTI, '--b\r\nContent-Disposition: form-data; name="_method"\r\n\r\nDELETE\r\n--b--', 'DELETE'],
    ['multipart that does not', MULTI, '--b\r\nContent-Disposition: form-data; name="file"\r\n\r\nx\r\n--b--', 'POST'],
    ['no type, JSON body', {}, '{"_method":"DELETE"}', 'DELETE'],
    ['no type, form body', {}, '_method=DELETE', 'DELETE'],
    ['no type, text that mentions it', {}, 'set _method to DELETE', 'POST'],
    ['empty body', JSON_T, '', 'POST'],
    ['form key PHP reads as _method', FORM, '.method=DELETE', 'DELETE'],
    ['form key with a leading space, which PHP drops', FORM, '+method=DELETE', 'POST'],
    ['form key as an array', FORM, '_method[]=DELETE', 'DELETE'],
    ['form key as an indexed array', FORM, '_method[0]=delete', 'DELETE'],
    ['form key in capitals', FORM, '_METHOD=DELETE', 'DELETE'],
    ['form key with an unclosed bracket, read as _method on purpose (PHP reads _method_x)', FORM, '_method[x=DELETE', 'DELETE'],
    ['JSON with a stray close tag a repair strips before sending', JSON_T, '{"_method":"DELETE"}</body>', 'DELETE'],
    ['JSON-like type a server reads as JSON', { 'Content-Type': 'application/json-seq' }, '{"_method":"DELETE"}</body>', 'DELETE'],
    ['JSON that does not parse, method name escaped', JSON_T, '{"_\\u006dethod":"DELETE"}</body>', 'DELETE'],
    ['no type, JSON that does not parse', {}, '{"_method":"DELETE"', 'DELETE'],
    ['form type whose parameter names JSON', { 'Content-Type': 'application/x-www-form-urlencoded; v=/json' }, '{"_method":"DELETE"}', 'DELETE'],
    ['two types, a JSON string the form read splits', { 'Content-Type': 'application/x-www-form-urlencoded,application/vnd.x+json' }, '"&_method=DELETE&"', 'DELETE'],
    ['two Content-Type headers', { 'content-type': 'text/plain', 'Content-Type': 'application/json' }, '{"_method":"DELETE"', 'DELETE'],
    ['multipart name in RFC 2231 form', MULTI, "--b\r\nContent-Disposition: form-data; name*=utf-8''_%6Dethod\r\n\r\nDELETE\r\n--b--", 'DELETE'],
    ['multipart that mentions it only in a file', MULTI, '--b\r\nContent-Disposition: form-data; name="file"\r\n\r\nuse _method=DELETE\r\n--b--', 'POST'],
    ['no type, a non-method only the other parser finds', {}, '_method=Looks+safe', 'POST'],
    ['multipart name in numbered RFC 2231 pieces', MULTI, '--b\r\nContent-Disposition: form-data; name*0="_me"; name*1="thod"\r\n\r\nDELETE\r\n--b--', 'DELETE'],
    ['multipart header folded onto a second line', MULTI, '--b\r\nContent-Disposition: form-data;\r\n name="_method"\r\n\r\nDELETE\r\n--b--', 'DELETE'],
    ['multipart part with a longer name', MULTI, '--b\r\nContent-Disposition: form-data; name="payment_method"\r\n\r\npm_1\r\n--b--', 'POST'],
    ['multipart name with a backslash escape', MULTI, '--b\r\nContent-Disposition: form-data; name="\\_m\\ethod"\r\n\r\nDELETE\r\n--b--', 'DELETE'],
    ['multipart name pieces out of order', MULTI, '--b\r\nContent-Disposition: form-data; name*1="thod"; name*0="_me"\r\n\r\nDELETE\r\n--b--', 'DELETE'],
    ['form type listed before a multipart type', { 'Content-Type': 'application/x-www-form-urlencoded, multipart/form-data; boundary=b' }, '_method=DELETE', 'DELETE'],
    ['multipart file whose name mentions it', MULTI, '--b\r\nContent-Disposition: form-data; name="file"; filename="methodology.pdf"\r\n\r\nx\r\n--b--', 'POST'],
    ['NDJSON lines that hold a method value', { 'Content-Type': 'application/x-ndjson' }, '{"http.request.method":"DELETE"}\n{"b":1}', 'POST'],
    ['text in quotes that mentions the word', { 'Content-Type': 'text/plain' }, '"Quote" about the scientific method', 'POST'],
    ['JSON object whose string holds a form override', JSON_T, '{"note":"a&_method=DELETE&b"}', 'POST'],
    ['JSON array whose string holds a form override', JSON_T, '["a&_method=DELETE&b"]', 'POST'],
    ['form type first, then JSON: the form reading counts', { 'Content-Type': 'application/x-www-form-urlencoded; v=/json' }, '{"note":"a&_method=DELETE&b"}', 'DELETE'],
  ] as const)('%s', (_k, headers, body, want) => {
    expect(effectiveWriteMethod('POST', { ...headers }, U, body)).toBe(want);
  });

  it('reads no body for a GET or a HEAD, which send none', () => {
    expect(effectiveWriteMethod('GET', { 'content-type': 'application/json' }, U, '{"_method":"DELETE"}')).toBe('GET');
    expect(effectiveWriteMethod('head', { 'content-type': 'application/json' }, U, '{"_method":"DELETE"}')).toBe('HEAD');
  });

  it('refuses a body override that is not a method, a string or not', () => {
    expect(effectiveWriteMethod('POST', { 'content-type': 'application/json' }, U, '{"_method":5}')).toBeNull();
    expect(effectiveWriteMethod('POST', { 'content-type': 'application/json' }, U, '{"_method":"Looks safe"}')).toBeNull();
    expect(effectiveWriteMethod('POST', { 'content-type': 'application/x-www-form-urlencoded' }, U, '_method=my-secret-value')).toBeNull();
    expect(effectiveWriteMethod('POST', { 'Content-Type': 'application/vnd.api+json' }, U, '{"_method":"Looks safe"}'), 'a +json type').toBeNull();
    expect(effectiveWriteMethod('POST', { 'content-type': 'text/plain', 'Content-Type': 'application/json' }, U, '{"_method":"Looks safe"}'), 'the second of two types').toBeNull();
  });
});

describe('the body read as given and as sent', () => {
  const JSON_CT = { 'content-type': 'application/json' };
  it('counts an override that only the repaired reading names', () => {
    const readings = ['{"_method":"PUT"}</parameter>', '{"_method":"PUT"}'];
    expect(writeMethodsNamed('POST', JSON_CT, U, readings[0])).toEqual(['DELETE', 'POST']);
    expect(writeMethodsNamed('POST', JSON_CT, U, readings)).toEqual(['DELETE', 'POST', 'PUT']);
    expect(effectiveWriteMethod('POST', JSON_CT, U, readings)).toBe('DELETE');
    expect(effectiveWriteMethod('POST', JSON_CT, U, ['{"_method":"PATCH"', '{"_method":"PATCH"}'])).toBe('DELETE');
    expect(effectiveWriteMethod('POST', JSON_CT, U, ['{"a":1}', '{"_method":"PATCH"}'])).toBe('PATCH');
  });

  it('refuses when any reading names a value that is not a method, and reads no body on a GET', () => {
    expect(effectiveWriteMethod('POST', JSON_CT, U, ['{"a":1}', '{"_method":"nope"}'])).toBeNull();
    expect(writeMethodsNamed('GET', JSON_CT, U, ['{"_method":"DELETE"}', '{"_method":"PUT"}'])).toEqual([]);
  });
});

describe('retargetingHeader', () => {
  it('finds each header a server or proxy routes on, whatever its case, and no other', () => {
    for (const name of ['HoSt', 'X-Host', 'x-forwarded-host', 'Forwarded', 'X-Original-URL', 'x-rewrite-url']) {
      expect(retargetingHeader({ accept: 'x', [name]: 'y' })).toBe(name);
    }
    expect(retargetingHeader({ 'x-hosting': 'x', 'content-type': 'y' })).toBeUndefined();
  });

  it('finds a member of a routing family it does not name, and leaves the client and API selectors alone', () => {
    for (const name of ['X-Original-Host', 'X-Forwarded-Server', 'X-Forwarded-Prefix', 'x-forwarded-proto', 'X-Original-URI', 'X-Rewrite-Host', ' X-Forwarded-Port ', 'X-Forwarded']) {
      expect(retargetingHeader({ accept: 'x', [name]: 'y' }), name).toBe(name);
    }
    for (const name of ['X-Forwarded-For', 'X-RapidAPI-Host', 'X-Originating-IP', 'X-Originator', 'X-Rewritten', 'Foo-X-Forwarded-Host']) {
      expect(retargetingHeader({ [name]: 'y' }), name).toBeUndefined();
    }
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
    expect(bodyForQuestion(`x=%FF${enc('hunter2secret')}`, vault, FORM)).toEqual({ text: 'x = ***' });
    expect(pathForQuestion(`https://h.example/a/%FF${enc('hunter2secret')}`, vault)).toBe('/a/***');
    // Starred, not masked: the Latin-1 reading holds the secret too, and a piece another
    // reading turns into a secret is shown as `***`.
    expect(bodyFieldNames(`%FF${enc('hunter2secret')}=1`, vault)).toBe('fields "***"');
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

describe('a secret is not shown in any form a server may read it in', () => {
  const enc = (t: string) => [...t].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  const vault = (t: string) => t.replaceAll('hunter2secret', '[s]');
  const twice = enc(enc('hunter2secret'));
  it('encoded twice: the body is not shown, the path segment, query key and field name are starred', () => {
    expect(bodyForQuestion(`x=${twice}`, vault, 'text/plain')).toEqual({ unshowable: 'escaped-secret' });
    expect(bodyForQuestion(JSON.stringify({ a: twice }), vault)).toEqual({ unshowable: 'escaped-secret' });
    expect(pathForQuestion(`https://h.example/a/${twice}/b`, vault)).toBe('/a/***/b');
    expect(pathForQuestion(`https://h.example/a?${twice}=1&b=2`, vault)).toBe('/a?***=…&b=…');
    expect(bodyFieldNames(`${twice}=1&b=2`, vault)).toBe('fields "***", "b"');
    expect(bodyForQuestion(`x=${twice}&b=2`, vault, 'application/x-www-form-urlencoded')).toEqual({ text: 'x = ***\nb = 2' });
    expect(pathForQuestion(`https://h.example/a/${enc(twice)}/b`, vault)).toBe('/a/***/b');
  });
  it('read as Latin-1: a non-ASCII secret is not shown', () => {
    const latin = (t: string) => t.replaceAll('café-secret', '[s]');
    expect(bodyForQuestion('x=caf%E9-secret', latin, 'text/plain')).toEqual({ unshowable: 'escaped-secret' });
    expect(pathForQuestion('https://h.example/a/caf%E9-secret', latin)).toBe('/a/***');
    expect(pathForQuestion('https://h.example/a?caf%E9-secret=1&b=2', latin)).toBe('/a?***=…&b=…');
    expect(bodyFieldNames('caf%E9-secret=1&b=2', latin)).toBe('fields "***", "b"');
    expect(bodyForQuestion('x=caf%E9-secret', latin, 'application/x-www-form-urlencoded')).toEqual({ text: 'x = ***' });
  });
  it('a secret holding `=` or `&`: masked whole before the query or form body is split', () => {
    const sep = (t: string) => t.replaceAll('hunter=2secret', '[s]').replaceAll('hunter&2secret', '[s]');
    expect(bodyFieldNames('hunter=2secret=1&b=2', sep)).toBe('fields "[s]", "b"');
    expect(bodyFieldNames('hunter&2secret=1&b=2', sep)).toBe('fields "[s]", "b"');
    expect(pathForQuestion('https://h.example/a?hunter=2secret=1&b=2', sep)).toBe('/a?[s]=…&b=…');
    expect(pathForQuestion('https://h.example/a?hunter&2secret=1&b=2', sep)).toBe('/a?[s]=…&b=…');
  });
  it('read as ISO-8859-1 and as windows-1252: a byte in 0x80-0x9F is read both ways', () => {
    const c1 = (t: string) => t.replaceAll('a\u0080b-secret', '[s]');
    expect(pathForQuestion('https://h.example/a/a%80b-secret', c1)).toBe('/a/***');
    expect(bodyForQuestion('x=a%80b-secret', c1, 'text/plain')).toEqual({ unshowable: 'escaped-secret' });
    const euro = (t: string) => t.replaceAll('pass€word', '[s]');
    expect(pathForQuestion('https://h.example/a/pass%80word', euro)).toBe('/a/***');
    expect(bodyForQuestion('x=pass%80word', euro, 'text/plain')).toEqual({ unshowable: 'escaped-secret' });
  });
  it('a secret holding a `/`: masked whole before the split, and starred when only a reading across segments holds it', () => {
    const slash = (t: string) => t.replaceAll('hunter/2secret', '[s]');
    expect(pathForQuestion('https://h.example/x/hunter/2secret/y', slash)).toBe('/x/[s]/y');
    expect(pathForQuestion('https://h.example/x/%2568unter/2secret', slash)).toBe('/***');
  });
  it('+ read as a space without percent-decoding: a secret holding a literal %XX is not shown', () => {
    const literal = (t: string) => t.replaceAll('x%41 y', '[s]');
    expect(bodyForQuestion('v=x%41+y', literal, 'text/plain')).toEqual({ unshowable: 'escaped-secret' });
  });
  it('positive control: encoded twice but harmless is shown, decoded once as before', () => {
    const harmless = enc(enc('harmless'));
    expect(pathForQuestion(`https://h.example/a/${harmless}`, vault)).toBe(`/a/${enc('harmless')}`);
    expect(bodyFieldNames(`${harmless}=1`, vault)).toBe(`fields "${enc('harmless')}"`);
    // A secret written plainly is masked, not starred, even beside an escape: it is masked
    // before the further readings are taken, so they do not find it again.
    expect(bodyFieldNames(JSON.stringify({ 'hunter2secret%41': 1, b: 2 }), vault)).toBe('fields "[s]%41", "b"');
    expect(bodyForQuestion(`x=${harmless}`, vault, 'text/plain')).toEqual({ text: `x=${harmless}` });
    expect(bodyForQuestion(`x=${harmless}`, vault, 'application/x-www-form-urlencoded')).toEqual({ text: `x = ${enc('harmless')}` });
    expect(bodyForQuestion('x=caf%E9', (t) => t.replaceAll('café-secret', '[s]'), 'text/plain')).toEqual({ text: 'x=caf%E9' });
    expect(pathForQuestion('https://h.example/x/%2568unter/y', (t) => t.replaceAll('hunter/2secret', '[s]'))).toBe('/x/%68unter/y');
    expect(pathForQuestion('https://h.example/a?&a%20b=1&a+b=2&c', vault)).toBe('/a?a b=…&c=…');
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

describe('outboundEffectField', () => {
  const SHOP = 'https://shop.example.com';
  it.each([
    [`${SHOP}/wp-json/wc/v3/orders/5`, { status: 'completed' }, 'status', 'third_party_mail'],
    [`${SHOP}/wp-json/wc/v4/orders/5`, { status: 'completed' }, 'status', 'third_party_mail'],
    [`${SHOP}/index.php/wp-json/wc/v3/orders/5`, { status: 'completed' }, 'status', 'third_party_mail'],
    [`${SHOP}/api/wc/v2/orders/5`, { status: 'completed' }, 'status', 'third_party_mail'],
    [`${SHOP}/wp-json/wc-analytics/orders/5`, { status: 'completed' }, 'status', 'third_party_mail'],
    [`${SHOP}/WP-JSON/WC/V3/ORDERS/5/`, { Status: 'completed' }, 'status', 'third_party_mail'],
    [`${SHOP}/wp-json/wc/v3/orders/5`, { set_paid: true }, 'set_paid', 'money'],
    [`${SHOP}/wp-json/wc/v3/orders/5`, { note: 'x', customer_id: 7 }, 'customer_id', 'data_to_third_party'],
    [`${SHOP}/wp-json/wc/v3/customers/9`, { password: 'x' }, 'password', 'credential'],
    [`${SHOP}/wp-json/wc/v3/customers/9`, { email: 'a@example.test' }, 'email', 'credential'],
    [`${SHOP}/wp-json/wc/v3/webhooks/3`, { name: 'x' }, null, 'data_to_third_party'],
    ['https://api.bexio.com/4.0/banking/payments/4', { message: 'x' }, null, 'money'],
    ['https://api.bexio.com/2.0/kb_order/4/repetition', { end: '' }, null, 'money'],
    ['https://api.bexio.com/4.0/banking/payments/%2534', { message: 'x' }, null, 'money'],
  ] as const)('%s with %j sets off %s (%s)', (url, body, field, effect) => {
    expect(outboundEffectField(url, body)).toMatchObject({ field, effect });
  });

  it.each([
    [`${SHOP}/wp-json/wc/v3/products/5`, { status: 'draft' }],
    [`${SHOP}/wp-json/wc/v3/orders/5`, { transaction_id: 'x' }],
    [`${SHOP}/wp-json/wc/v3/orders`, { status: 'completed' }],
    [`${SHOP}/wp-json/wc/v3/orders/5/notes`, { status: 'completed' }],
    [`${SHOP}/wp-json/wc/v3/customers/9`, { first_name: 'x' }],
    ['https://api.bexio.com/2.0/contact/4', { name_1: 'x' }],
    ['https://example.com/4.0/banking/payments/4', { message: 'x' }],
    ['https://api.example.com/v1/orders/5', { status: 'completed' }],
    [`${SHOP}/wp-json/wcx/v3/orders/5`, { status: 'completed' }],
  ] as const)('%s with %j sets off nothing', (url, body) => {
    expect(outboundEffectField(url, body)).toBeNull();
  });
});
