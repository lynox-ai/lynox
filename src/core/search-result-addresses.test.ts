import { describe, it, expect } from 'vitest';
import { MAX_RESULT_HOSTS, SearchResultAddresses } from './search-result-addresses.js';

describe('result hosts for the shell', () => {
  it('keeps the hosts of a search sent untainted, and none of a search sent after foreign content', () => {
    const s = new SearchResultAddresses();
    s.noteResults('pricing', ['https://Shop.Example/a', 'https://docs.example/b'], true);
    s.noteResults('pricing', ['https://evil.example/c'], false);
    expect(s.cleanHosts()).toEqual(['shop.example', 'docs.example']);
    // The addresses count for the read check either way.
    expect(s.has('https://evil.example/c')).toBe(true);
  });

  it('leaves out the host of an address that carries the query', () => {
    const s = new SearchResultAddresses();
    s.noteResults('secret-data', ['https://collect.example/secret-data', 'https://news.example/x'], true);
    expect(s.cleanHosts()).toEqual(['news.example']);
  });

  it('keeps the newest hosts when full, and a host noted again counts as new', () => {
    const s = new SearchResultAddresses();
    s.noteResults('q', ['https://first.example/'], true);
    for (let i = 0; i < MAX_RESULT_HOSTS - 1; i++) s.noteResults('q', [`https://h${String(i)}.example/`], true);
    s.noteResults('q', ['https://first.example/'], true);
    s.noteResults('q', ['https://last.example/'], true);
    const hosts = s.cleanHosts();
    expect(hosts).toHaveLength(MAX_RESULT_HOSTS);
    expect(hosts).toContain('first.example');
    expect(hosts).not.toContain('h0.example');
    expect(hosts.at(-1)).toBe('last.example');
  });

  it('counts a search as tainted unless told otherwise', () => {
    const s = new SearchResultAddresses();
    s.noteResults('q', ['https://a.example/']);
    expect(s.cleanHosts()).toEqual([]);
  });
});
