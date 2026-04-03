import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TavilyProvider, SearXNGProvider, createSearchProvider } from './search-provider.js';

// Mock global fetch
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TavilyProvider', () => {
  it('sends correct request body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new TavilyProvider('tvly-test-key');
    await provider.search('test query', { maxResults: 3, topic: 'news' });

    expect(mockFetch).toHaveBeenCalledWith('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });

    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      api_key: 'tvly-test-key',
      query: 'test query',
      max_results: 3,
      include_raw_content: 'markdown',
      topic: 'news',
    });
  });

  it('maps results correctly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'Test Result',
            url: 'https://example.com',
            content: 'A snippet',
            raw_content: '# Full content',
            score: 0.95,
            published_date: '2026-01-15',
          },
        ],
      }),
    });

    const provider = new TavilyProvider('tvly-key');
    const results = await provider.search('test');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'Test Result',
      url: 'https://example.com',
      snippet: 'A snippet',
      content: '# Full content',
      publishedDate: '2026-01-15',
      source: 'tavily',
    });
  });

  it('clamps max_results to 20', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const provider = new TavilyProvider('tvly-key');
    await provider.search('test', { maxResults: 50 });

    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body['max_results']).toBe(20);
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Invalid API key',
    });

    const provider = new TavilyProvider('tvly-bad');
    await expect(provider.search('test')).rejects.toThrow('Tavily API error 401');
  });
});

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
});

describe('createSearchProvider', () => {
  it('creates TavilyProvider', () => {
    const provider = createSearchProvider('tavily', 'tvly-key');
    expect(provider.name).toBe('tavily');
  });

  it('creates SearXNGProvider', () => {
    const provider = createSearchProvider('searxng', 'http://localhost:8888');
    expect(provider.name).toBe('searxng');
  });
});
