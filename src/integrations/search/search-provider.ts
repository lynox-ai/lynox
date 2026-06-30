import { createHash } from 'node:crypto';
import { channels } from '../../core/observability.js';
import type { ToolContext } from '../../core/tool-context.js';
import { assertEgressAllowed } from './content-extractor.js';

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
  /** Per-engine hit count. For DDG fallback, single synthetic key 'duckduckgo'. */
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
  // ctx threads the session's network policy so deny-all / allow-list also gates
  // the search QUERY (not just the downstream content fetch) — the query string
  // is agent-controllable and would otherwise be an exfil channel past the gate.
  search(query: string, opts?: SearchOptions, ctx?: ToolContext | undefined): Promise<SearchResult[]>;
}

// Tavily backend removed 2026-05-24 — the UI hadn't surfaced it since the
// IA-V2 hotfix, and keeping a dead env-var path (`TAVILY_API_KEY`) was
// misleading users into thinking a Tavily key would still enable search.
// SearXNG (sidecar or `SEARXNG_URL`) is the supported full-quality
// backend; the DuckDuckGo HTML-scrape fallback below is the no-config
// honesty alternative.

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

  async search(query: string, opts?: SearchOptions, ctx?: ToolContext | undefined): Promise<SearchResult[]> {
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
    assertEgressAllowed(url, ctx);
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

// --- DuckDuckGo HTML-scrape fallback ---

/**
 * Best-effort fallback provider that scrapes the DuckDuckGo HTML SERP at
 * https://html.duckduckgo.com/html?q=…. Used ONLY when SearXNG isn't
 * configured — fixes the silent-fabrication failure mode where
 * `web_research` was unregistered and the agent invented citations from
 * training data instead of telling the user search wasn't wired up.
 *
 * Limitations vs. SearXNG — operator should treat as best-effort:
 *  - No JSON API: parses HTML, so DDG layout changes break it.
 *  - Rate-limited / occasionally CAPTCHA-walled when called at volume.
 *  - No `time_range` (DDG HTML SERP doesn't expose the filter cleanly).
 *  - No topic categories — every query goes against the general SERP.
 *
 * The agent gets a `WEB_SEARCH_FALLBACK_PROMPT_SUFFIX` so it knows results
 * are best-effort and surfaces the upgrade path (SearXNG) to the user
 * when high-stakes research comes up.
 */
export class DuckDuckGoProvider implements SearchProvider {
  readonly name = 'duckduckgo-fallback';

  async search(query: string, opts?: SearchOptions, ctx?: ToolContext | undefined): Promise<SearchResult[]> {
    const start = Date.now();
    const maxResults = Math.min(opts?.maxResults ?? 5, 10);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    assertEgressAllowed(url, ctx);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          // DDG HTML SERP is sensitive to default fetch UA — many bot-style
          // UAs get an empty body. A standard browser UA is the minimum the
          // endpoint accepts; treat this as part of the "best-effort"
          // contract documented above.
          'User-Agent': 'Mozilla/5.0 (compatible; lynox/1.0; +https://lynox.ai)',
          'Accept': 'text/html',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `q=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new Error(`DuckDuckGo fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      throw new Error(`DuckDuckGo HTML SERP error ${response.status}`);
    }
    const html = await response.text();
    const { titles, urls, snippets } = parseDdgHtml(html, maxResults);
    const results: SearchResult[] = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      const t = titles[i];
      if (!u || !t) continue;
      results.push({
        title: t,
        url: u,
        snippet: snippets[i] ?? '',
        source: 'duckduckgo-fallback',
      });
    }

    if (channels.webSearch.hasSubscribers) {
      const event: WebSearchEvent = {
        provider: this.name,
        queryHash: hashQuery(query),
        queryLength: query.length,
        resultCount: results.length,
        engines: results.length > 0 ? { duckduckgo: results.length } : {},
        unresponsiveEngines: [],
        durationMs: Date.now() - start,
      };
      channels.webSearch.publish(event);
    }

    return results;
  }
}

/**
 * Parse a DuckDuckGo HTML SERP into parallel title/url/snippet arrays.
 * Split out so the regex layout can be unit-tested without spinning up a
 * live HTTP fetch. The DDG layout has been stable for years, but treat it
 * as brittle — if a future DDG change breaks the parse, the provider
 * returns [] and the agent surfaces "no results" honestly rather than
 * fabricating.
 */
export function parseDdgHtml(
  html: string,
  maxResults: number,
): { titles: string[]; urls: string[]; snippets: string[] } {
  // Pair links with their snippets POSITIONALLY across the page in document
  // order — when a sponsored-ad link is filtered out (returns null from
  // unwrapDdgRedirect), the matching snippet at the same DDG-page index
  // MUST also be skipped. Earlier impl pushed snippets in their own loop
  // bounded only by `>= urls.length`, which silently mis-aligned snippets
  // to the wrong results whenever an ad slot was dropped.
  const linkPattern = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const titles: string[] = [];
  const urls: string[] = [];
  const snippets: string[] = [];
  const linkMatches = [...html.matchAll(linkPattern)];
  const snippetMatches = [...html.matchAll(snippetPattern)];
  for (let i = 0; i < linkMatches.length; i++) {
    if (urls.length >= maxResults) break;
    const linkMatch = linkMatches[i]!;
    const rawUrl = linkMatch[1] ?? '';
    const title = stripHtml(linkMatch[2] ?? '').trim();
    const cleanedUrl = unwrapDdgRedirect(rawUrl);
    if (!cleanedUrl || !title) continue;
    urls.push(cleanedUrl);
    titles.push(title);
    // Snippet at the same page-index — empty string when DDG omitted one
    // for this result, so the consumer can index-align titles/urls/snippets.
    const snippetMatch = snippetMatches[i];
    snippets.push(snippetMatch ? stripHtml(snippetMatch[1] ?? '').trim() : '');
  }
  return { titles, urls, snippets };
}

/** Strip HTML tags + decode the most common HTML entities. Keeps the impl
 *  small (no DOM dep) — sufficient for the DDG SERP which uses a tight
 *  vocabulary of entities (&amp;, &quot;, &#39;, &lt;, &gt;). */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** DDG wraps result URLs in a redirect (/l/?kh=-1&uddg=<encoded-url>)
 *  to track clicks. Unwrap so the agent gets the canonical target URL.
 *  Also drops sponsored-ad results (`y.js?ad_domain=…&ad_provider=…`) so
 *  the agent doesn't get Amazon / Udemy spam in research output. Returns
 *  null when the input doesn't parse as http/https — the agent must
 *  never see a relative or javascript-scheme URL. */
function unwrapDdgRedirect(href: string): string | null {
  let target = href;
  // Relative redirect form: //duckduckgo.com/l/?uddg=…
  if (target.startsWith('//')) target = `https:${target}`;
  if (target.startsWith('/')) target = `https://duckduckgo.com${target}`;
  try {
    const parsed = new URL(target);
    // Drop sponsored-ad results: DDG renders ads as duckduckgo.com/y.js
    // with `ad_domain` / `ad_provider` query params. They poison research
    // because the URL still resolves but lands on Amazon/Udemy/etc., not
    // the page the user thought they were getting.
    if (parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/y.js') {
      return null;
    }
    // Only unwrap the /l/ redirect when it's on DDG's own host. A bare
    // pathname-suffix match would silently follow `https://evil.example.com/foo/l/?uddg=…`
    // and hand the agent whatever attacker-controlled `uddg` payload says.
    if (parsed.hostname === 'duckduckgo.com'
        && (parsed.pathname === '/l/' || parsed.pathname.endsWith('/l/'))) {
      const inner = parsed.searchParams.get('uddg');
      if (inner) target = inner;
    }
    const final = new URL(target);
    if (final.protocol !== 'http:' && final.protocol !== 'https:') return null;
    return final.toString();
  } catch {
    return null;
  }
}

// --- Factory ---

export type SearchProviderType = 'searxng' | 'duckduckgo-fallback';

export function createSearchProvider(type: SearchProviderType, apiKeyOrUrl: string): SearchProvider {
  switch (type) {
    case 'searxng': return new SearXNGProvider(apiKeyOrUrl);
    case 'duckduckgo-fallback': return new DuckDuckGoProvider();
  }
}
