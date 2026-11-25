import { describe, it, expect } from 'vitest';
import { allowedLines, contractLines, exactApart } from './stamp-contract.js';
import { segments } from './plan-takeover.js';

/** A marked line as the view draws it: lynox's words, and each value in brackets for its box. */
const drawn = (line: string): string => segments(line).map((s) => (s.foreign ? `[${s.text}]` : s.text)).join('');

describe('allowedLines — one line per rule, each value in a box (U-451)', () => {
  it('words each rule, a range in one line and a single bound in its own words', () => {
    expect(allowedLines({ enum: ['May', 'June'], regex: '[a-z]+', min: 1, max: 5 }).map(drawn)).toEqual([
      'erlaubt: [May], [June]',
      'erlaubt: was ganz zum Muster [[a-z]+] passt',
      'erlaubt: [1] bis [5]',
    ]);
    expect(allowedLines({ enum: null, regex: null, min: 2, max: null }).map(drawn)).toEqual(['erlaubt: mindestens [2]']);
    expect(allowedLines({ enum: null, regex: null, min: null, max: 9 }).map(drawn)).toEqual(['erlaubt: höchstens [9]']);
    expect(allowedLines({ enum: [], regex: null, min: null, max: null }).map(drawn)).toEqual(['kein Wert erlaubt']);
    expect(allowedLines({ enum: [true, 0], regex: null, min: null, max: null }).map(drawn)).toEqual(['erlaubt: [true], [0]']);
    expect(allowedLines(null)).toEqual([]);
  });

  it('an empty value still gets its box', () => {
    expect(allowedLines({ enum: [''], regex: null, min: null, max: null }).map(drawn)).toEqual(['erlaubt: []']);
  });
});

describe('exactApart — a value as it is matched', () => {
  it('keeps a single space between two characters and prints every other whitespace', () => {
    expect(drawn(exactApart('a b'))).toBe('[a b]');
    expect(drawn(exactApart('a  b'))).toBe('[a<U+0020><U+0020>b]');
    expect(drawn(exactApart(' x '))).toBe('[<U+0020>x<U+0020>]');
    expect(drawn(exactApart('p\tq\nr'))).toBe('[p<U+0009>q<U+000A>r]');
  });

  it('prints hidden characters, and cannot close its own box', () => {
    expect(drawn(exactApart('y\u202E'))).toBe('[y<U+202E>]');
    const line = drawn(exactApart('a\uE001b\uE000c'));
    expect(line.startsWith('[') && line.endsWith(']')).toBe(true);
    expect(line.slice(1, -1)).not.toMatch(/[\[\]]/u);
  });
});

describe('contractLines — the writes a stored contract grants without asking', () => {
  const GRANT = { grantedTools: ['http_request'], httpMethods: ['GET', 'POST'], hostPatterns: ['h.example'], pathPatterns: ['/a', '/b'] };

  it('lists each host, path and method, the order the stamp preview uses', () => {
    expect(contractLines(GRANT)).toEqual(['GET https://h.example/a', 'POST https://h.example/a', 'GET https://h.example/b', 'POST https://h.example/b']);
  });

  it('lists no other tool the contract names: none is granted', () => {
    expect(contractLines({ ...GRANT, grantedTools: ['http_request', 'bash'] })!.join(' ')).not.toContain('bash');
  });

  it.each([
    ['without the request tool', { ...GRANT, grantedTools: ['bash'] }],
    ['without a path', { ...GRANT, pathPatterns: [] }],
    ['without a host', { ...GRANT, hostPatterns: [] }],
    ['without a method', { ...GRANT, httpMethods: [] }],
    ['whose tools are not a list', { ...GRANT, grantedTools: 'http_request' }],
    ['that is not an object', 'http_request'],
    ['that is a list', [GRANT]],
  ])('a contract %s grants nothing', (_label, contract) => {
    expect(contractLines(contract)).toEqual([]);
  });

  it('a value that is not text is left out, not printed', () => {
    expect(contractLines({ ...GRANT, hostPatterns: ['h.example', 7], pathPatterns: ['/a'], httpMethods: ['POST'] })).toEqual(['POST https://h.example/a']);
  });

  it('without a contract there is nothing to list', () => {
    expect(contractLines(undefined)).toBeNull();
    expect(contractLines(null)).toBeNull();
  });
});
