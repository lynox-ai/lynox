import { describe, it, expect } from 'vitest';
import { SearchResultAddresses } from './search-result-addresses.js';

describe('SearchResultAddresses', () => {
  it('lists a result address in the form it is fetched in, never one that carries the query', () => {
    const s = new SearchResultAddresses();
    s.noteResults('secret-data', ['https://Shop.Example/a', 'https://collect.example/secret-data']);
    expect(s.has('https://shop.example/a')).toBe(true);
    expect(s.has('https://collect.example/secret-data')).toBe(false);
  });

  it('keeps no hosts for the shell', () => {
    const s = new SearchResultAddresses();
    s.noteResults('q', ['https://news.example/a']);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(s))).toEqual(['constructor', 'noteResults', 'has']);
  });
});
