import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearXNGProvider, DuckDuckGoProvider, parseDdgHtml, createSearchProvider } from './search-provider.js';
import type { WebSearchEvent } from './search-provider.js';
import { channels } from '../../core/observability.js';
import { createToolContext, applyNetworkPolicy } from '../../core/tool-context.js';

// Mock global fetch
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// TavilyProvider tests removed 2026-05-24 when the backend was retired —
// see search-provider.ts header comment for context.

describe('SearXNGProvider', () => {
  it('sends correct request', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('test query', { maxResults: 3, topic: 'news', timeRange: 'week' });

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('localhost:8888/search?');
    expect(url).toContain('q=test+query');
    expect(url).toContain('format=json');
    expect(url).toContain('number_of_results=3');
    expect(url).toContain('categories=news');
    expect(url).toContain('time_range=week');
  });

  it('bounds the request with an abort signal (no hang on a stalled SearXNG socket)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('test');
    // Pre-fix the fetch had no `signal`, so a hung socket stalled the run
    // indefinitely (Node fetch has no default timeout).
    const opts = mockFetch.mock.calls[0]![1] as { signal?: unknown };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('strips trailing slash from base URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888/');
    await provider.search('test');

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toMatch(/^http:\/\/localhost:8888\/search\?/);
  });

  it('maps results correctly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'SearXNG Result',
            url: 'https://example.com',
            content: 'A snippet from SearXNG',
            publishedDate: '2026-01-15',
            engine: 'google',
          },
        ],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'SearXNG Result',
      url: 'https://example.com',
      snippet: 'A snippet from SearXNG',
      publishedDate: '2026-01-15',
      source: 'searxng',
    });
  });

  it('clamps results to maxResults', async () => {
    const manyResults = Array.from({ length: 25 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: `Content ${i}`,
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: manyResults }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test', { maxResults: 3 });

    expect(results).toHaveLength(3);
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await expect(provider.search('test')).rejects.toThrow('SearXNG API error 500');
  });

  it('healthCheck returns true when reachable', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const provider = new SearXNGProvider('http://localhost:8888');
    const healthy = await provider.healthCheck();
    expect(healthy).toBe(true);
  });

  it('healthCheck returns false when unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const provider = new SearXNGProvider('http://localhost:8888');
    const healthy = await provider.healthCheck();
    expect(healthy).toBe(false);
  });

  // --- Security: URL validation ---

  it('rejects file:// scheme', () => {
    expect(() => new SearXNGProvider('file:///etc/passwd')).toThrow('http:// or https://');
  });

  it('rejects javascript: scheme', () => {
    expect(() => new SearXNGProvider('javascript:alert(1)')).toThrow();
  });

  it('rejects data: scheme', () => {
    expect(() => new SearXNGProvider('data:text/html,test')).toThrow('http:// or https://');
  });

  it('rejects ftp: scheme', () => {
    expect(() => new SearXNGProvider('ftp://evil.com')).toThrow('http:// or https://');
  });

  it('rejects cloud metadata endpoint 169.254.169.254', () => {
    expect(() => new SearXNGProvider('http://169.254.169.254')).toThrow('cloud metadata');
  });

  it('rejects link-local 169.254.x.x', () => {
    expect(() => new SearXNGProvider('http://169.254.1.1:8080')).toThrow('cloud metadata');
  });

  it('rejects invalid URL', () => {
    expect(() => new SearXNGProvider('not-a-url')).toThrow('Invalid SearXNG URL');
  });

  it('allows http:// localhost (self-hosted)', () => {
    expect(() => new SearXNGProvider('http://localhost:8888')).not.toThrow();
  });

  it('allows http:// private IP (self-hosted)', () => {
    expect(() => new SearXNGProvider('http://192.168.1.100:8888')).not.toThrow();
  });

  it('allows https:// URL', () => {
    expect(() => new SearXNGProvider('https://searxng.example.com')).not.toThrow();
  });

  // --- Edge cases ---

  it('handles empty results array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('no results query');
    expect(results).toEqual([]);
  });

  it('handles missing optional fields in results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'Minimal', url: 'https://example.com', content: 'Just a snippet' }],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test');
    expect(results[0]).toEqual({
      title: 'Minimal',
      url: 'https://example.com',
      snippet: 'Just a snippet',
      publishedDate: undefined,
      source: 'searxng',
    });
  });

  it('defaults to 5 results when maxResults not specified', async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      title: `R${i}`, url: `https://example.com/${i}`, content: `C${i}`,
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: manyResults }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test');
    expect(results).toHaveLength(5);
  });

  it('does not set number_of_results param when maxResults is unset', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('test');

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).not.toContain('number_of_results');
  });

  it('maps science topic to science category', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('quantum computing', { topic: 'science' });

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('categories=science');
  });

  // Reverses 2026-04-24 finding: `topic: "it"` used to set categories=it,
  // but that filters queries to dev-index engines (github/npm/pypi/
  // stackoverflow) which lack full-text web indices — verified to return
  // 0 results for research queries like "pytrends rate limits" against
  // the real lynox SearXNG config. General engines handle IT queries
  // better without any category filter.
  it('does not set categories for it topic (empirically worse than general)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('typescript generics', { topic: 'it' });

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).not.toContain('categories');
  });

  it('does not set categories for finance topic (no SearXNG equivalent)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('AAPL stock', { topic: 'finance' });

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).not.toContain('categories');
  });

  it('does not set categories param for general topic', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('test', { topic: 'general' });

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).not.toContain('categories');
  });

  it('publishes webSearch event with engine attribution + unresponsive list', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'r1', url: 'https://a', content: 's', engine: 'google' },
          { title: 'r2', url: 'https://b', content: 's', engine: 'google' },
          { title: 'r3', url: 'https://c', content: 's', engine: 'duckduckgo' },
        ],
        unresponsive_engines: [['bing', 'timeout'], ['brave', 'HTTP error']],
      }),
    });
    const events: WebSearchEvent[] = [];
    const onMessage = (msg: unknown): void => { events.push(msg as WebSearchEvent); };
    channels.webSearch.subscribe(onMessage);
    try {
      const provider = new SearXNGProvider('http://localhost:8888');
      await provider.search('test query');
    } finally {
      channels.webSearch.unsubscribe(onMessage);
    }

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.provider).toBe('searxng');
    expect(ev.queryHash).toMatch(/^[0-9a-f]{16}$/);
    expect(ev.queryLength).toBe('test query'.length);
    expect(ev).not.toHaveProperty('query'); // no plaintext leak
    expect(ev.resultCount).toBe(3);
    expect(ev.engines).toEqual({ google: 2, duckduckgo: 1 });
    expect(ev.unresponsiveEngines).toEqual(['bing', 'brave']);
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('queryHash is deterministic for the same query and differs across queries', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], unresponsive_engines: [] }),
    });
    const events: WebSearchEvent[] = [];
    const onMessage = (msg: unknown): void => { events.push(msg as WebSearchEvent); };
    channels.webSearch.subscribe(onMessage);
    try {
      const provider = new SearXNGProvider('http://localhost:8888');
      await provider.search('alpha');
      await provider.search('alpha');
      await provider.search('beta');
    } finally {
      channels.webSearch.unsubscribe(onMessage);
    }
    expect(events).toHaveLength(3);
    expect(events[0]!.queryHash).toBe(events[1]!.queryHash);
    expect(events[0]!.queryHash).not.toBe(events[2]!.queryHash);
  });

  it('skips event publication entirely when no subscribers (cost-free observability)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'r', url: 'https://a', content: 's', engine: 'google' }],
        unresponsive_engines: [],
      }),
    });
    // Spy on publish to confirm it isn't called when nobody subscribes.
    const publishSpy = vi.spyOn(channels.webSearch, 'publish');
    try {
      const provider = new SearXNGProvider('http://localhost:8888');
      await provider.search('whoever');
    } finally {
      publishSpy.mockRestore();
    }
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('uses <unattributed> sentinel for results SearXNG returned without engine field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'r1', url: 'https://a', content: 's' },          // no engine
          { title: 'r2', url: 'https://b', content: 's', engine: 'google' },
        ],
        unresponsive_engines: [],
      }),
    });
    const events: WebSearchEvent[] = [];
    const onMessage = (msg: unknown): void => { events.push(msg as WebSearchEvent); };
    channels.webSearch.subscribe(onMessage);
    try {
      const provider = new SearXNGProvider('http://localhost:8888');
      await provider.search('q');
    } finally {
      channels.webSearch.unsubscribe(onMessage);
    }
    expect(events[0]!.engines).toEqual({ '<unattributed>': 1, google: 1 });
  });

  it('publishes webSearch event even when no results and no unresponsive engines', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], unresponsive_engines: [] }),
    });
    const events: WebSearchEvent[] = [];
    const onMessage = (msg: unknown): void => { events.push(msg as WebSearchEvent); };
    channels.webSearch.subscribe(onMessage);
    try {
      const provider = new SearXNGProvider('http://localhost:8888');
      await provider.search('empty');
    } finally {
      channels.webSearch.unsubscribe(onMessage);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.resultCount).toBe(0);
    expect(events[0]!.engines).toEqual({});
    expect(events[0]!.unresponsiveEngines).toEqual([]);
  });

  it('handles network timeout gracefully in healthCheck', async () => {
    mockFetch.mockImplementation(() => new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 10),
    ));

    const provider = new SearXNGProvider('http://localhost:8888');
    const healthy = await provider.healthCheck();
    expect(healthy).toBe(false);
  });

  it('healthCheck returns false on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    const provider = new SearXNGProvider('http://localhost:8888');
    const healthy = await provider.healthCheck();
    expect(healthy).toBe(false);
  });

  // --- Sophisticated edge cases ---

  it('handles Unicode queries (CJK, diacritics, emoji)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ title: '日本語の結果', url: 'https://example.jp', content: 'テスト' }] }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('東京 天気 🌤️ café résumé');

    const url = mockFetch.mock.calls[0]![0] as string;
    // URLSearchParams encodes Unicode properly
    expect(url).toContain('q=');
    expect(results[0]!.snippet).toBe('テスト');
  });

  it('handles very long queries without truncation', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const longQuery = 'a'.repeat(2000);
    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search(longQuery);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain(`q=${'a'.repeat(2000)}`);
  });

  it('handles results with HTML entities in snippets', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          title: 'XSS &amp; Injection <script>alert(1)</script>',
          url: 'https://example.com',
          content: 'Content with &lt;b&gt;HTML&lt;/b&gt; entities &amp; special chars',
        }],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test');
    // Provider passes through as-is — formatting/sanitization is tool-layer responsibility
    expect(results[0]!.title).toContain('<script>');
    expect(results[0]!.snippet).toContain('&lt;b&gt;');
  });

  it('handles results with empty strings for title/content', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: '', url: 'https://example.com', content: '' }],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test');
    expect(results[0]!.title).toBe('');
    expect(results[0]!.snippet).toBe('');
  });

  it('handles SearXNG returning malformed JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await expect(provider.search('test')).rejects.toThrow();
  });

  it('handles SearXNG 429 rate limit response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    await expect(provider.search('test')).rejects.toThrow('SearXNG API error 429');
  });

  it('handles network error (connection refused)', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const provider = new SearXNGProvider('http://localhost:8888');
    await expect(provider.search('test')).rejects.toThrow('ECONNREFUSED');
  });

  it('handles results with extremely long URLs', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(5000);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'Long URL', url: longUrl, content: 'test' }],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test');
    expect(results[0]!.url).toBe(longUrl);
  });

  it('handles results with null values for optional fields', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          title: 'Test',
          url: 'https://example.com',
          content: 'snippet',
          publishedDate: null,
          engine: null,
        }],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test');
    // null ?? undefined = undefined
    expect(results[0]!.publishedDate).toBeUndefined();
  });

  it('handles duplicate results from multiple engines', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'Same Page', url: 'https://example.com/page', content: 'From Google', engine: 'google' },
          { title: 'Same Page', url: 'https://example.com/page', content: 'From Bing', engine: 'bing' },
          { title: 'Different', url: 'https://other.com', content: 'Other', engine: 'duckduckgo' },
        ],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test', { maxResults: 3 });
    // Provider doesn't deduplicate — SearXNG should handle this
    expect(results).toHaveLength(3);
  });

  it('handles all time_range values', async () => {
    const provider = new SearXNGProvider('http://localhost:8888');

    for (const range of ['day', 'week', 'month', 'year'] as const) {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
      await provider.search('test', { timeRange: range });
      const url = mockFetch.mock.calls.at(-1)![0] as string;
      expect(url).toContain(`time_range=${range}`);
    }
  });

  it('combines topic and timeRange correctly', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('breaking news', { topic: 'news', timeRange: 'day', maxResults: 10 });

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('categories=news');
    expect(url).toContain('time_range=day');
    expect(url).toContain('number_of_results=10');
  });

  it('rejects URL with credentials', () => {
    // URLs with user:pass should still be valid (URL constructor allows them)
    // but SearXNG shouldn't be accessed with credentials in URL
    const provider = new SearXNGProvider('http://admin:pass@localhost:8888');
    expect(provider.name).toBe('searxng');
  });

  it('handles port 0 URL', () => {
    // Port 0 is technically valid but unusual
    expect(() => new SearXNGProvider('http://localhost:0')).not.toThrow();
  });

  it('handles IPv6 localhost', () => {
    expect(() => new SearXNGProvider('http://[::1]:8888')).not.toThrow();
  });

  it('maxResults of 0 returns empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'R', url: 'https://example.com', content: 'C' }],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test', { maxResults: 0 });
    expect(results).toHaveLength(0);
  });

  it('negative maxResults clamps to 0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'R', url: 'https://example.com', content: 'C' }],
      }),
    });

    const provider = new SearXNGProvider('http://localhost:8888');
    const results = await provider.search('test', { maxResults: -5 });
    expect(results).toHaveLength(0);
  });
});

describe('createSearchProvider', () => {
  it('creates SearXNGProvider', () => {
    const provider = createSearchProvider('searxng', 'http://localhost:8888');
    expect(provider.name).toBe('searxng');
  });

  it('creates DuckDuckGoProvider', () => {
    const provider = createSearchProvider('duckduckgo-fallback', '');
    expect(provider.name).toBe('duckduckgo-fallback');
  });
});

describe('parseDdgHtml', () => {
  it('extracts title + unwrapped url + snippet from a typical DDG SERP block', () => {
    const html = `
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F2401.12345&rut=foo">Sample Paper Title</a>
        </h2>
        <a class="result__snippet" href="//x">A short snippet of the result text.</a>
      </div>
    `;
    const { titles, urls, snippets } = parseDdgHtml(html, 5);
    expect(urls).toEqual(['https://arxiv.org/abs/2401.12345']);
    expect(titles).toEqual(['Sample Paper Title']);
    expect(snippets).toEqual(['A short snippet of the result text.']);
  });

  it('respects maxResults cap', () => {
    const block = (i: number) => `
      <a class="result__a" href="https://example.com/${i}">Title ${i}</a>
      <a class="result__snippet">Snippet ${i}</a>
    `;
    const html = [0, 1, 2, 3, 4].map(block).join('\n');
    const { urls } = parseDdgHtml(html, 3);
    expect(urls).toHaveLength(3);
  });

  it('decodes HTML entities in title and snippet', () => {
    const html = `
      <a class="result__a" href="https://example.com/x">Rock &amp; Roll &#39;25</a>
      <a class="result__snippet">price &lt; $100 &amp; free shipping</a>
    `;
    const { titles, snippets } = parseDdgHtml(html, 5);
    expect(titles[0]).toBe("Rock & Roll '25");
    expect(snippets[0]).toBe('price < $100 & free shipping');
  });

  it('drops sponsored-ad results (DDG /y.js?ad_domain=…) AND keeps snippets aligned', () => {
    // Live DDG SERP for "typescript handbook" returns Amazon + Udemy ads
    // as the top two hits before the real result. Letting them through
    // landed Amazon URLs in research output during the 2026-05-24 smoke;
    // the agent treats them as real hits and cites them. Drop on parse.
    //
    // Regression guard: earlier impl pushed snippets in a separate loop
    // bounded only by `>= urls.length`, so when an ad slot was dropped,
    // the SPONSORED snippet ended up paired with the real result. Assert
    // both alignment and ad-drop in the same case.
    const html = `
      <a class="result__a" href="//duckduckgo.com/y.js?ad_domain=amazon.de&amp;ad_provider=bingv7aa">Sponsored title</a>
      <a class="result__snippet">Sponsored snippet</a>
      <a class="result__a" href="https://www.typescriptlang.org/docs/handbook/intro.html">The TypeScript Handbook</a>
      <a class="result__snippet">Official TS handbook.</a>
    `;
    const { urls, titles, snippets } = parseDdgHtml(html, 5);
    expect(urls).toEqual(['https://www.typescriptlang.org/docs/handbook/intro.html']);
    expect(titles).toEqual(['The TypeScript Handbook']);
    expect(snippets).toEqual(['Official TS handbook.']);
  });

  it('does not unwrap /l/ paths on non-DDG hosts (SSRF-bypass guard)', () => {
    // A bare pathname-suffix match would silently follow
    // `https://evil.example.com/foo/l/?uddg=…` and hand the agent
    // whatever attacker-controlled `uddg` payload says. Restrict the
    // redirect-unwrap to DDG's own host.
    const html = `
      <a class="result__a" href="https://evil.example.com/foo/l/?uddg=https%3A%2F%2Fattacker.example.com%2Fmalware">Looks normal</a>
      <a class="result__snippet">Innocent snippet</a>
    `;
    const { urls } = parseDdgHtml(html, 5);
    expect(urls).toEqual(['https://evil.example.com/foo/l/?uddg=https%3A%2F%2Fattacker.example.com%2Fmalware']);
  });

  it('drops results with non-http(s) schemes from the unwrap', () => {
    const html = `
      <a class="result__a" href="javascript:alert(1)">Bad</a>
      <a class="result__a" href="https://good.example.com/">Good</a>
    `;
    const { urls, titles } = parseDdgHtml(html, 5);
    expect(urls).toEqual(['https://good.example.com/']);
    expect(titles).toEqual(['Good']);
  });

  it('returns empty arrays for non-DDG HTML', () => {
    const { titles, urls, snippets } = parseDdgHtml('<html><body><p>nothing here</p></body></html>', 5);
    expect(titles).toHaveLength(0);
    expect(urls).toHaveLength(0);
    expect(snippets).toHaveLength(0);
  });
});

describe('DuckDuckGoProvider', () => {
  it('parses SERP results from a successful HTML response', async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com/1">First Result</a>
        <a class="result__snippet">First snippet text.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.com/2">Second Result</a>
        <a class="result__snippet">Second snippet.</a>
      </div>
    `;
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => html,
    });
    const provider = new DuckDuckGoProvider();
    const results = await provider.search('llm agents');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'First Result', url: 'https://example.com/1', snippet: 'First snippet text.' });
    expect(results[1]?.source).toBe('duckduckgo-fallback');
  });

  it('throws when DDG returns a non-OK status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    const provider = new DuckDuckGoProvider();
    await expect(provider.search('anything')).rejects.toThrow(/503/);
  });

  it('returns [] when the HTML has no result blocks (parse drift)', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '<html>empty</html>' });
    const provider = new DuckDuckGoProvider();
    const results = await provider.search('anything');
    expect(results).toEqual([]);
  });
});

describe('network policy gating (search query)', () => {
  const ctxWith = (policy: 'deny-all' | 'allow-list' | 'guarded', hosts?: string[]) => {
    const c = createToolContext({});
    applyNetworkPolicy(c, policy, hosts);
    return c;
  };

  it('SearXNG: deny-all blocks the query before any fetch', async () => {
    const provider = new SearXNGProvider('http://localhost:8888');
    await expect(provider.search('secret data', undefined, ctxWith('deny-all')))
      .rejects.toThrow('Blocked');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('SearXNG: allow-list blocks when the SearXNG host is not listed', async () => {
    const provider = new SearXNGProvider('https://searx.example.org');
    await expect(provider.search('q', undefined, ctxWith('allow-list', ['api.example.com'])))
      .rejects.toThrow('not in network allow-list');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('SearXNG: allow-list permits the query when the host is listed', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    const provider = new SearXNGProvider('https://searx.example.org');
    await provider.search('q', undefined, ctxWith('allow-list', ['searx.example.org']));
    expect(mockFetch).toHaveBeenCalled();
  });

  it('DuckDuckGo: deny-all blocks the query before any fetch', async () => {
    const provider = new DuckDuckGoProvider();
    await expect(provider.search('secret', undefined, ctxWith('deny-all')))
      .rejects.toThrow('Blocked');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('no policy (undefined ctx) leaves the query ungated — default behaviour', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    const provider = new SearXNGProvider('http://localhost:8888');
    await provider.search('q');
    expect(mockFetch).toHaveBeenCalled();
  });

  it('SearXNG: guarded leaves the query open (web_research is a discovery surface)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    const provider = new SearXNGProvider('https://searx.example.org');
    await provider.search('q', undefined, ctxWith('guarded'));
    expect(mockFetch).toHaveBeenCalled();
  });

  it('DuckDuckGo: guarded leaves the query open (POST search on an off-baseline host)', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '<html></html>' });
    const provider = new DuckDuckGoProvider();
    await provider.search('q', undefined, ctxWith('guarded'));
    expect(mockFetch).toHaveBeenCalled();
  });
});
