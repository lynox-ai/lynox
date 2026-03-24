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

// --- Brave ---

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
}

interface BraveResponse {
  web?: { results: BraveWebResult[] } | undefined;
}

export class BraveProvider implements SearchProvider {
  readonly name = 'brave';
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const count = Math.min(opts?.maxResults ?? 5, 20);
    const params = new URLSearchParams({ q: query, count: String(count) });
    if (opts?.timeRange) {
      const freshMap: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
      const freshness = freshMap[opts.timeRange];
      if (freshness) params.set('freshness', freshness);
    }

    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      { headers: { 'X-Subscription-Token': this.apiKey, Accept: 'application/json' } },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Brave Search API error ${response.status}: ${text}`);
    }

    const data = await response.json() as BraveResponse;
    return (data.web?.results ?? []).map((r): SearchResult => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      source: 'brave',
    }));
  }
}

// --- Factory ---

export type SearchProviderType = 'tavily' | 'brave';

export function createSearchProvider(type: SearchProviderType, apiKey: string): SearchProvider {
  switch (type) {
    case 'tavily': return new TavilyProvider(apiKey);
    case 'brave': return new BraveProvider(apiKey);
  }
}

export function detectProviderType(
  apiKey: string,
  explicit?: SearchProviderType | undefined,
): SearchProviderType {
  if (explicit) return explicit;
  // Tavily keys start with "tvly-"
  if (apiKey.startsWith('tvly-')) return 'tavily';
  return 'brave';
}
