import type { ToolEntry } from '../../types/index.js';
import type { SearchProvider, SearchResult } from './search-provider.js';
import { extractContent } from './content-extractor.js';
import { getErrorMessage } from '../../core/utils.js';

interface WebSearchInput {
  action: 'search' | 'read';
  query?: string | undefined;
  url?: string | undefined;
  max_results?: number | undefined;
  topic?: 'general' | 'news' | 'finance' | undefined;
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
      description: `Search the web or read content from a URL. Provider: ${provider.name}. Use action "search" with a query to find information online, or action "read" with a URL to extract the main content from a web page.`,
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
            description: 'Search query (required for action "search")',
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
            enum: ['general', 'news', 'finance', 'science', 'it'],
            description: 'Search topic category. Only used with action "search"',
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
