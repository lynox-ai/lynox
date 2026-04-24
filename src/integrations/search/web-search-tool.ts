import type { ToolEntry } from '../../types/index.js';
import type { SearchProvider, SearchResult } from './search-provider.js';
import { extractContent } from './content-extractor.js';
import { getErrorMessage } from '../../core/utils.js';

interface WebSearchInput {
  action: 'search' | 'read';
  query?: string | undefined;
  url?: string | undefined;
  max_results?: number | undefined;
  topic?: 'general' | 'news' | 'finance' | 'science' | undefined;
  time_range?: 'day' | 'week' | 'month' | 'year' | undefined;
}

const ENRICH_TOP_N = 3;
const ENRICH_MAX_CHARS = 4000;

/**
 * Enrich search results that lack full content (e.g. SearXNG snippets)
 * by fetching the top N pages via content extractor.
 */
async function enrichResults(results: SearchResult[]): Promise<SearchResult[]> {
  const toEnrich = results.slice(0, ENRICH_TOP_N).filter(r => !r.content);
  if (toEnrich.length === 0) return results;

  // Race enrichment against a 10s timeout to keep search responsive
  const enrichmentPromise = Promise.allSettled(
    toEnrich.map(async (r) => {
      const extracted = await extractContent(r.url, ENRICH_MAX_CHARS);
      return { url: r.url, content: extracted.content };
    }),
  );
  const timeout = new Promise<PromiseSettledResult<{ url: string; content: string }>[]>(
    resolve => setTimeout(() => resolve([]), 10_000),
  );
  const enriched = await Promise.race([enrichmentPromise, timeout]);

  const contentMap = new Map<string, string>();
  for (const result of enriched) {
    if (result.status === 'fulfilled') {
      contentMap.set(result.value.url, result.value.content);
    }
  }

  return results.map((r) => {
    const content = contentMap.get(r.url);
    return content ? { ...r, content } : r;
  });
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results.map((r, i) => {
    const parts = [`${i + 1}. **${r.title}**`, `   ${r.url}`, `   ${r.snippet}`];
    if (r.publishedDate) parts.push(`   Published: ${r.publishedDate}`);
    if (r.content) parts.push(`\n   ---\n   ${r.content.slice(0, 5000)}`);
    return parts.join('\n');
  }).join('\n\n');
}

export function createWebSearchTool(provider: SearchProvider): ToolEntry<WebSearchInput> {
  return {
    definition: {
      name: 'web_research',
      description: `Search the web or read a URL. Provider: ${provider.name}.

Action "search": query a public search engine. Query formulation matters more than most tools — this feeds Google/Bing/DDG, not a vector store.

QUERY RULES:
- Use 2-4 high-signal terms. Prefer nouns, proper names, product names.
- NO year qualifiers ("2024", "2025") — use time_range if recency matters.
- NO country/region codes ("DACH", "Germany", "EU") — engines treat these as noise.
- NO stacked modifiers ("free tier pricing rate limits"). Pick ONE angle per query; run a follow-up search for the next angle.
- If first results look off-topic or empty, REFORMULATE with fewer/different terms. Do not repeat the same bad query. For broad topics, start generic, then narrow in a follow-up.

Examples:
  Good: "pytrends github"                 Bad: "pytrends Google Trends unofficial API 2024 rate limits DACH Germany"
  Good: "serpapi pricing"                 Bad: "SerpApi Google Trends API pricing free tier 2024"
  Good: "reddit trending api"             Bad: "Reddit trends API free keyword popularity rising topics 2024"

Action "read": extract full text from a specific URL.

Use topic to narrow: "news" for current events, "science" for papers/research. For general research (code, libraries, APIs, company info), omit topic — default engines cover these better than any filter. Top results include full page content.`,
      eager_input_streaming: true,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'read'],
            description: 'Action to perform: "search" to search the web, "read" to extract content from a URL',
          },
          query: {
            type: 'string',
            description: 'Search query (required for action "search"). 2-4 high-signal terms; no year/country qualifiers; one angle per query. See tool description for examples.',
          },
          url: {
            type: 'string',
            description: 'URL to read content from (required for action "read")',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of search results (default: 5, max: 20). Only used with action "search"',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news', 'finance', 'science'],
            description: 'Search topic category. Only used with action "search". Use "news" for current events, "science" for papers/research; omit for code/library/API queries (general engines outperform any filter there).',
          },
          time_range: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year'],
            description: 'Filter results by recency. Only used with action "search"',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input: WebSearchInput): Promise<string> => {
      if (input.action === 'search') {
        if (!input.query) return 'Error: "query" is required for action "search".';
        try {
          let results = await provider.search(input.query, {
            maxResults: input.max_results,
            topic: input.topic,
            timeRange: input.time_range,
          });
          results = await enrichResults(results);
          const formatted = formatSearchResults(results);
          if (results.length === 0) return formatted;
          const { wrapUntrustedData } = await import('../../core/data-boundary.js');
          return wrapUntrustedData(formatted, 'web_search');
        } catch (err: unknown) {
          return `Search failed: ${getErrorMessage(err)}`;
        }
      }

      if (input.action === 'read') {
        if (!input.url) return 'Error: "url" is required for action "read".';
        try {
          const result = await extractContent(input.url);
          const parts = [`# ${result.title}`, `Source: ${result.url}`, `Words: ${result.wordCount}`];
          if (result.truncated) parts.push('(Content truncated)');
          parts.push('', result.content);
          const { wrapUntrustedData } = await import('../../core/data-boundary.js');
          return wrapUntrustedData(parts.join('\n'), 'web_page');
        } catch (err: unknown) {
          return `Failed to read URL: ${getErrorMessage(err)}`;
        }
      }

      return 'Error: action must be "search" or "read".';
    },
  };
}
