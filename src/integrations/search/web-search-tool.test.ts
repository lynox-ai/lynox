import { describe, it, expect, vi } from 'vitest';
import { createWebSearchTool } from './web-search-tool.js';
import type { SearchProvider, SearchResult } from './search-provider.js';

function mockProvider(results: SearchResult[] = []): SearchProvider {
  return {
    name: 'test',
    search: vi.fn<SearchProvider['search']>().mockResolvedValue(results),
  };
}

describe('createWebSearchTool', () => {
  it('creates tool with correct definition', () => {
    const tool = createWebSearchTool(mockProvider());
    expect(tool.definition.name).toBe('web_research');
    expect(tool.definition.input_schema.required).toEqual(['action']);
  });

  it('includes provider name in description', () => {
    const tool = createWebSearchTool(mockProvider());
    expect(tool.definition.description).toContain('test');
  });
});

describe('search action', () => {
  it('returns formatted results', async () => {
    const provider = mockProvider([
      { title: 'Result 1', url: 'https://a.com', snippet: 'Snippet A' },
      { title: 'Result 2', url: 'https://b.com', snippet: 'Snippet B', publishedDate: '2026-01-01' },
    ]);
    const tool = createWebSearchTool(provider);
    const result = await tool.handler({ action: 'search', query: 'test' }, {} as never);

    expect(result).toContain('1. **Result 1**');
    expect(result).toContain('https://a.com');
    expect(result).toContain('Snippet A');
    expect(result).toContain('2. **Result 2**');
    expect(result).toContain('Published: 2026-01-01');
  });

  it('passes options to provider', async () => {
    const provider = mockProvider();
    const tool = createWebSearchTool(provider);
    await tool.handler({
      action: 'search',
      query: 'test',
      max_results: 10,
      topic: 'news',
      time_range: 'week',
    }, {} as never);

    expect(provider.search).toHaveBeenCalledWith('test', {
      maxResults: 10,
      topic: 'news',
      timeRange: 'week',
    });
  });

  it('returns error when query is missing', async () => {
    const tool = createWebSearchTool(mockProvider());
    const result = await tool.handler({ action: 'search' }, {} as never);
    expect(result).toContain('Error');
    expect(result).toContain('query');
  });

  it('handles search failure gracefully', async () => {
    const provider: SearchProvider = {
      name: 'test',
      search: vi.fn<SearchProvider['search']>().mockRejectedValue(new Error('API down')),
    };
    const tool = createWebSearchTool(provider);
    const result = await tool.handler({ action: 'search', query: 'test' }, {} as never);
    expect(result).toContain('Search failed');
    expect(result).toContain('API down');
  });

  it('returns message for no results', async () => {
    const tool = createWebSearchTool(mockProvider([]));
    const result = await tool.handler({ action: 'search', query: 'obscure' }, {} as never);
    expect(result).toBe('No results found.');
  });
});

describe('read action', () => {
  it('returns error when url is missing', async () => {
    const tool = createWebSearchTool(mockProvider());
    const result = await tool.handler({ action: 'read' }, {} as never);
    expect(result).toContain('Error');
    expect(result).toContain('url');
  });
});

describe('invalid action', () => {
  it('returns error for unknown action', async () => {
    const tool = createWebSearchTool(mockProvider());
    const result = await tool.handler({ action: 'delete' as 'search' }, {} as never);
    expect(result).toContain('Error');
  });
});
