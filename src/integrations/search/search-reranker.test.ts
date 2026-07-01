import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rerankSearchResults, getRerankerCapability } from './search-reranker.js';
import { initLLMProvider } from '../../core/llm-client.js';
import { setOpenAIModelResolver, getActiveOpenAIModelMap, MISTRAL_MODEL_MAP } from '../../types/models.js';
import type { SearchResult } from './search-provider.js';

// `mockCreate` resolves the reranker's stream().finalMessage() call (it now
// uses streaming uniformly so the OpenAIAdapter, which has no `.create`, works
// too). createLLMClient is mocked to return a provider-agnostic fake client
// routing to mockCreate, so we can exercise both the Anthropic and the Mistral
// (openai) paths without a real network client. getActiveProvider/getModelId
// stay real (the real module-global provider switch drives tier selection).
const mockCreate = vi.fn();
const createLLMClientSpy = vi.fn();

const fakeClient = {
  beta: {
    messages: {
      stream: (...args: unknown[]) => ({ finalMessage: () => mockCreate(...args) }),
    },
  },
};

vi.mock('../../core/llm-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/llm-client.js')>('../../core/llm-client.js');
  return {
    ...actual,
    createLLMClient: (opts?: unknown) => {
      createLLMClientSpy(opts);
      return fakeClient;
    },
  };
});

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
    createLLMClientSpy.mockReset();
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

  it('surfaces the pool-key rerank cost (costUsd) from response usage', async () => {
    mockCreate.mockResolvedValueOnce({
      ...(makeScoreResponse([9, 1, 10, 2]) as object),
      usage: { input_tokens: 800, output_tokens: 120 },
    });
    const out = await rerankSearchResults('pytrends github', makeResults(), { enabled: true });
    // Priced on the resolved fast model — positive, finite, well under a cent for
    // a ~920-token call. The call site debits this to the tenant balance.
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.costUsd!).toBeLessThan(0.1);
  });

  it('leaves costUsd undefined when reranking is skipped (no LLM call)', async () => {
    const out = await rerankSearchResults('x', makeResults()); // disabled by default → no call
    expect(mockCreate).not.toHaveBeenCalled();
    expect(out.costUsd).toBeUndefined();
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

  it('runs on the openai (Mistral) provider with a snapshot — fast-tier model, no betas', async () => {
    // Engine bootstrap registers this map in prod; do it here so the fast tier
    // resolves to the real Mistral model rather than the Anthropic-id fallback.
    const priorMap = getActiveOpenAIModelMap();
    setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP });
    try {
      mockCreate.mockResolvedValueOnce(makeScoreResponse([9, 1, 10, 2]));
      const snapshot = {
        provider: 'openai' as const,
        apiKey: 'sk-mistral-RIGHT',
        apiBaseURL: 'https://api.mistral.ai/v1',
        openaiModelId: 'mistral-large-2512',
        openaiAuth: undefined,
      };

      const out = await rerankSearchResults('pytrends github', makeResults(), { enabled: true }, snapshot);

      // Did NOT skip on openai (the pre-fix behaviour was a hard skip).
      expect(out.skipReason).toBeUndefined();
      expect(out.results).toHaveLength(2);
      // The client was built provider-aware from the snapshot, not the env.
      expect(createLLMClientSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          apiKey: 'sk-mistral-RIGHT',
          apiBaseURL: 'https://api.mistral.ai/v1',
          openaiModelId: 'mistral-large-2512',
        }),
      );
      const call = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['model']).toMatch(/ministral-8b/); // the FAST tier specifically, not large/Haiku
      expect(call['betas']).toBeUndefined();         // betas are Anthropic-only
    } finally {
      setOpenAIModelResolver({ map: priorMap }); // restore prior, don't clobber other suites
    }
  });

  it('still skips a custom provider snapshot (unknown model / tool-choice support)', async () => {
    const snapshot = {
      provider: 'custom' as const,
      apiKey: 'k',
      apiBaseURL: 'https://proxy.example',
      openaiModelId: undefined,
      openaiAuth: undefined,
    };

    const out = await rerankSearchResults('x', makeResults(), { enabled: true }, snapshot);

    expect(out.skipReason).toBe('provider-unsupported');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// The capability surface is what `/api/search/reranker/capability` returns
// and is the SSoT for the SearchSettings UI card. Keep these tests aligned
// with the runtime guard in `rerankSearchResults`: anthropic/vertex/openai are
// supported; only opaque 'custom' proxies are not.
describe('getRerankerCapability', () => {
  // Snapshot + restore so tests don't leak state into each other or into
  // the rerankSearchResults suite below.
  let savedProvider: 'anthropic' | 'vertex' | 'custom' | 'openai';

  beforeEach(() => {
    savedProvider = 'anthropic';
    delete process.env['LYNOX_SEARCH_RERANK'];
  });

  afterEach(async () => {
    delete process.env['LYNOX_SEARCH_RERANK'];
    // Reset to anthropic so other suites observe the default.
    await initLLMProvider(savedProvider);
  });

  it('reports supported + disabled when active provider is anthropic and env unset', async () => {
    await initLLMProvider('anthropic');
    const cap = getRerankerCapability();
    expect(cap).toEqual({
      supported: true,
      enabled: false,
      provider: 'anthropic',
      reason: 'disabled-by-env',
    });
  });

  it('reports supported + enabled when LYNOX_SEARCH_RERANK=true on anthropic', async () => {
    await initLLMProvider('anthropic');
    process.env['LYNOX_SEARCH_RERANK'] = 'true';
    const cap = getRerankerCapability();
    expect(cap.supported).toBe(true);
    expect(cap.enabled).toBe(true);
    expect(cap.provider).toBe('anthropic');
    expect(cap.reason).toBeUndefined();
  });

  it('reports supported + enabled on the openai provider (Mistral) when env on', async () => {
    await initLLMProvider('openai');
    process.env['LYNOX_SEARCH_RERANK'] = 'true';
    const cap = getRerankerCapability();
    // openai now reranks on its own fast-tier model — supported, like anthropic.
    expect(cap.supported).toBe(true);
    expect(cap.enabled).toBe(true);
    expect(cap.provider).toBe('openai');
    expect(cap.reason).toBeUndefined();
  });

  it('reports unsupported on custom provider', async () => {
    await initLLMProvider('custom');
    const cap = getRerankerCapability();
    expect(cap.supported).toBe(false);
    expect(cap.reason).toBe('provider-unsupported');
    expect(cap.provider).toBe('custom');
  });
});
