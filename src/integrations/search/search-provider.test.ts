import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TavilyProvider, BraveProvider, createSearchProvider, detectProviderType } from './search-provider.js';

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

describe('BraveProvider', () => {
  it('sends correct request', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    const provider = new BraveProvider('brave-key');
    await provider.search('test query', { maxResults: 3, timeRange: 'week' });

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('api.search.brave.com');
    expect(url).toContain('q=test+query');
    expect(url).toContain('count=3');
    expect(url).toContain('freshness=pw');

    const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('brave-key');
  });

  it('maps results correctly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: 'Brave Result', url: 'https://brave.com', description: 'A description' },
          ],
        },
      }),
    });

    const provider = new BraveProvider('brave-key');
    const results = await provider.search('test');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'Brave Result',
      url: 'https://brave.com',
      snippet: 'A description',
      source: 'brave',
    });
  });

  it('handles missing web results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const provider = new BraveProvider('brave-key');
    const results = await provider.search('test');
    expect(results).toEqual([]);
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    const provider = new BraveProvider('brave-key');
    await expect(provider.search('test')).rejects.toThrow('Brave Search API error 429');
  });
});

describe('createSearchProvider', () => {
  it('creates TavilyProvider', () => {
    const provider = createSearchProvider('tavily', 'tvly-key');
    expect(provider.name).toBe('tavily');
  });

  it('creates BraveProvider', () => {
    const provider = createSearchProvider('brave', 'brave-key');
    expect(provider.name).toBe('brave');
  });
});

describe('detectProviderType', () => {
  it('returns explicit type when provided', () => {
    expect(detectProviderType('any-key', 'brave')).toBe('brave');
    expect(detectProviderType('tvly-key', 'brave')).toBe('brave');
  });

  it('detects tavily from key prefix', () => {
    expect(detectProviderType('tvly-abc123')).toBe('tavily');
  });

  it('defaults to brave for unknown key format', () => {
    expect(detectProviderType('some-random-key')).toBe('brave');
  });
});
