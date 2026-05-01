import { createHash } from 'node:crypto';
import { channels } from '../../core/observability.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string | undefined;
  publishedDate?: string | undefined;
  source?: string | undefined;
}

/**
 * Event shape emitted on `channels.webSearch` once per provider call.
 * Subscribers (e.g. engine-init.ts) can aggregate retrieval metrics.
 *
 * Privacy: the raw query is NEVER published — it can carry PII or
 * confidential business intent and Bugsink's strip list does not yet
 * cover a `query` field. We publish a short hash + length so subscribers
 * can group repeated queries and correlate without seeing content.
 */
export interface WebSearchEvent {
  provider: string;
  /** sha256(query).slice(0, 16) — stable, opaque, no plaintext. */
  queryHash: string;
  /** Length of the query in characters. Useful for "are users sending one-word vs sentence-length queries?" without leaking content. */
  queryLength: number;
  resultCount: number;
  /** Per-engine hit count. For Tavily, single synthetic key 'tavily'. */
  engines: Record<string, number>;
  /** SearXNG-only: engines that failed to respond for this query. */
  unresponsiveEngines: string[];
  durationMs: number;
}

/** Stable, opaque, GDPR-safe identifier for query grouping. Truncated for compactness. */
function hashQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
}

/** Sentinel for results SearXNG returned without engine attribution. Picked to avoid colliding with any real engine module name. */
const ENGINE_UNATTRIBUTED = '<unattributed>';

export interface SearchOptions {
  maxResults?: number | undefined;
  topic?: 'general' | 'news' | 'finance' | 'science' | 'it' | undefined;
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
    const start = Date.now();
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
    const results = data.results.map((r): SearchResult => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      content: r.raw_content ?? undefined,
      publishedDate: r.published_date ?? undefined,
      source: 'tavily',
    }));

    if (channels.webSearch.hasSubscribers) {
      const event: WebSearchEvent = {
        provider: this.name,
        queryHash: hashQuery(query),
        queryLength: query.length,
        resultCount: results.length,
        // Tavily doesn't attribute results to engines — use a synthetic bucket.
        engines: results.length > 0 ? { tavily: results.length } : {},
        unresponsiveEngines: [],
        durationMs: Date.now() - start,
      };
      channels.webSearch.publish(event);
    }

    return results;
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
  unresponsive_engines?: Array<[string, string]> | undefined;
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
    const start = Date.now();
    const maxResults = Math.min(opts?.maxResults ?? 5, 20);
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: '1',
    });
    if (opts?.maxResults) params.set('number_of_results', String(maxResults));
    if (opts?.timeRange) params.set('time_range', opts.timeRange);
    // Intentionally NO mapping for topic "it" or "general". Verified
    // empirically against the lynox SearXNG config: forcing categories=it
    // narrows queries to code-index engines (github/npm/pypi/stackoverflow)
    // that lack full-text web indices, so research queries like "pytrends
    // rate limits" return 0 results. Same query without the filter returns
    // spot-on pypi.org/github hits via DuckDuckGo. Under default SearXNG
    // settings, categories=it also pulls MDN/Docker Hub that pollute
    // general-intent queries. Let general engines handle IT topics.
    const categoryMap: Record<string, string> = {
      news: 'news',
      science: 'science',
    };
    if (opts?.topic && categoryMap[opts.topic]) {
      params.set('categories', categoryMap[opts.topic]!);
    }

    const url = `${this.baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`SearXNG API error ${response.status}: ${text}`);
    }

    const data = await response.json() as SearXNGResponse;
    const sliced = data.results.slice(0, maxResults);
    const results = sliced.map((r): SearchResult => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      publishedDate: r.publishedDate ?? undefined,
      source: 'searxng',
    }));

    const unresponsive = (data.unresponsive_engines ?? [])
      .map(e => Array.isArray(e) ? e[0] : String(e));

    if (channels.webSearch.hasSubscribers) {
      const engineHits: Record<string, number> = {};
      for (const r of sliced) {
        const name = r.engine ?? ENGINE_UNATTRIBUTED;
        engineHits[name] = (engineHits[name] ?? 0) + 1;
      }
      const event: WebSearchEvent = {
        provider: this.name,
        queryHash: hashQuery(query),
        queryLength: query.length,
        resultCount: results.length,
        engines: engineHits,
        unresponsiveEngines: unresponsive,
        durationMs: Date.now() - start,
      };
      channels.webSearch.publish(event);
    }

    return results;
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
