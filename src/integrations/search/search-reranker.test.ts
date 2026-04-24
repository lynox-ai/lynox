import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rerankSearchResults } from './search-reranker.js';
import type { SearchResult } from './search-provider.js';

// Match the pattern used by process-capture.test.ts: a hoisted mock for
// the Anthropic SDK constructor, with per-test configuration of the
// messages.create return value.
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    beta = {
      messages: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    };
    constructor(..._args: unknown[]) { /* accept any */ }
  },
}));

function makeResults(): SearchResult[] {
  return [
    { title: 'Pytrends on PyPI', url: 'https://pypi.org/project/pytrends/', snippet: 'Unofficial Google Trends API wrapper for Python.' },
    { title: 'GPUSupportedLimits', url: 'https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits', snippet: 'WebGPU limits interface.' },
    { title: 'pytrends on GitHub', url: 'https://github.com/GeneralMills/pytrends', snippet: 'Pseudo-API for Google Trends. Download reports.' },
    { title: 'HN discussion', url: 'https://news.ycombinator.com/item?id=1', snippet: 'Random comment thread about data.' },
  ];
}

function makeScoreResponse(scores: number[]): unknown {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'score_results',
        input: { scores },
      },
    ],
  };
}

describe('rerankSearchResults', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env['LYNOX_SEARCH_RERANK'];
  });

  afterEach(() => {
    delete process.env['LYNOX_SEARCH_RERANK'];
  });

  it('passes through unchanged when disabled (default)', async () => {
    const results = makeResults();
    const out = await rerankSearchResults('pytrends github', results);
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('disabled');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('passes through when fewer than 2 results', async () => {
    const results = makeResults().slice(0, 1);
    const out = await rerankSearchResults('x', results, { enabled: true });
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('too-few-results');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('filters results below threshold and sorts by score desc', async () => {
    // Results: [pypi=9, webgpu=1, github=10, hn=2] → threshold 4 → keep pypi+github
    mockCreate.mockResolvedValueOnce(makeScoreResponse([9, 1, 10, 2]));
    const results = makeResults();
    const out = await rerankSearchResults('pytrends github', results, { enabled: true });

    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.url).toContain('github.com');
    expect(out.results[1]!.url).toContain('pypi.org');
    expect(out.droppedCount).toBe(2);
    expect(out.meanScore).toBeCloseTo(5.5);
  });

  it('custom threshold respected', async () => {
    mockCreate.mockResolvedValueOnce(makeScoreResponse([9, 1, 10, 2]));
    const out = await rerankSearchResults('x', makeResults(), { enabled: true, threshold: 8 });
    // Only pypi=9 and github=10 pass
    expect(out.results).toHaveLength(2);
    expect(out.droppedCount).toBe(2);
  });

  it('reads LYNOX_SEARCH_RERANK=true env var when enabled is unset', async () => {
    process.env['LYNOX_SEARCH_RERANK'] = 'true';
    mockCreate.mockResolvedValueOnce(makeScoreResponse([9, 9, 9, 9]));
    const out = await rerankSearchResults('x', makeResults());
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(out.skipReason).toBeUndefined();
  });

  it('reads LYNOX_SEARCH_RERANK=1 env var', async () => {
    process.env['LYNOX_SEARCH_RERANK'] = '1';
    mockCreate.mockResolvedValueOnce(makeScoreResponse([9, 9]));
    const out = await rerankSearchResults('x', makeResults().slice(0, 2));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(out.skipReason).toBeUndefined();
  });

  it('falls through safely on malformed LLM response (wrong length)', async () => {
    // 4 input results but only 2 scores returned
    mockCreate.mockResolvedValueOnce(makeScoreResponse([9, 1]));
    const results = makeResults();
    const out = await rerankSearchResults('x', results, { enabled: true });
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('malformed');
    expect(out.droppedCount).toBe(0);
  });

  it('falls through safely on LLM error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API down'));
    const results = makeResults();
    const out = await rerankSearchResults('x', results, { enabled: true });
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('llm-error');
    expect(out.droppedCount).toBe(0);
  });

  it('falls through safely on timeout', async () => {
    mockCreate.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
    const results = makeResults();
    const out = await rerankSearchResults('x', results, { enabled: true, timeoutMs: 20 });
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('timeout');
  });

  it('includes durationMs in all outcomes', async () => {
    const out = await rerankSearchResults('x', makeResults(), { enabled: false });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles response with no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'lol' }] });
    const results = makeResults();
    const out = await rerankSearchResults('x', results, { enabled: true });
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('malformed');
  });

  it('handles response with non-numeric scores', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        name: 'score_results',
        input: { scores: ['nine', 'one', 'ten', 'two'] },
      }],
    });
    const results = makeResults();
    const out = await rerankSearchResults('x', results, { enabled: true });
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('malformed');
  });

  it('sends system prompt and tool schema to Haiku', async () => {
    mockCreate.mockResolvedValueOnce(makeScoreResponse([9, 1, 10, 2]));
    await rerankSearchResults('pytrends github', makeResults(), { enabled: true });

    const call = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(call['model']).toMatch(/haiku/i);
    expect(call['tool_choice']).toEqual({ type: 'tool', name: 'score_results' });
    expect((call['system'] as string)).toMatch(/relevance scorer/i);
    expect(Array.isArray(call['tools'])).toBe(true);
  });
});
