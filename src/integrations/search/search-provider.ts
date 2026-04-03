export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string | undefined;
  publishedDate?: string | undefined;
  source?: string | undefined;
}

export interface SearchOptions {
  maxResults?: number | undefined;
  topic?: 'general' | 'news' | 'finance' | undefined;
  timeRange?: 'day' | 'week' | 'month' | 'year' | undefined;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

// --- Tavily ---

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string | undefined;
  score: number;
  published_date?: string | undefined;
}

interface TavilyResponse {
  results: TavilyResult[];
}

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = Math.min(opts?.maxResults ?? 5, 20);
    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query,
      max_results: maxResults,
      include_raw_content: 'markdown',
    };
    if (opts?.topic) body['topic'] = opts.topic;
    if (opts?.timeRange) body['time_range'] = opts.timeRange;

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Tavily API error ${response.status}: ${text}`);
    }

    const data = await response.json() as TavilyResponse;
    return data.results.map((r): SearchResult => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      content: r.raw_content ?? undefined,
      publishedDate: r.published_date ?? undefined,
      source: 'tavily',
    }));
  }
}

// --- SearXNG ---

interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string | undefined;
  engine?: string | undefined;
}

interface SearXNGResponse {
  results: SearXNGResult[];
}

/** Validate that a URL uses http/https and is not a cloud metadata endpoint. */
function validateSearxngUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid SearXNG URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: SearXNG URL must use http:// or https:// (got ${parsed.protocol})`);
  }
  // Block cloud metadata endpoints (link-local)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '169.254.169.254' || hostname.startsWith('169.254.')) {
    throw new Error('Blocked: cloud metadata endpoint');
  }
}

export class SearXNGProvider implements SearchProvider {
  readonly name = 'searxng';
  constructor(private readonly baseUrl: string) {
    validateSearxngUrl(baseUrl);
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = Math.min(opts?.maxResults ?? 5, 20);
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: '1',
    });
    if (opts?.maxResults) params.set('number_of_results', String(maxResults));
    if (opts?.timeRange) params.set('time_range', opts.timeRange);
    if (opts?.topic === 'news') params.set('categories', 'news');

    const url = `${this.baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`SearXNG API error ${response.status}: ${text}`);
    }

    const data = await response.json() as SearXNGResponse;
    return data.results.slice(0, maxResults).map((r): SearchResult => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      publishedDate: r.publishedDate ?? undefined,
      source: 'searxng',
    }));
  }

  /** Check if the SearXNG instance is reachable. */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// --- Factory ---

export type SearchProviderType = 'tavily' | 'searxng';

export function createSearchProvider(type: SearchProviderType, apiKeyOrUrl: string): SearchProvider {
  switch (type) {
    case 'tavily': return new TavilyProvider(apiKeyOrUrl);
    case 'searxng': return new SearXNGProvider(apiKeyOrUrl);
  }
}
