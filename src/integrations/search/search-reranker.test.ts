import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateCost } from '../../core/pricing.js';
import { rerankSearchResults, getRerankerCapability } from './search-reranker.js';
import { initLLMProvider } from '../../core/llm-client.js';
import { setOpenAIModelResolver, getActiveOpenAIModelMap, MISTRAL_MODEL_MAP } from '../../types/models.js';
import type { SearchResult } from './search-provider.js';
import { ForcedToolNotCalledError, forcedToolMissCounts, forcedToolCutOffCounts } from '../../core/llm-wire-rules.js';
import { abortedCallCounts } from '../../core/aborted-call.js';

// `mockCreate` resolves the reranker's stream().finalMessage() call (it now
// uses streaming uniformly so the OpenAIAdapter, which has no `.create`, works
// too). createLLMClient is mocked to return a provider-agnostic fake client
// routing to mockCreate, so we can exercise both the Anthropic and the Mistral
// (openai) paths without a real network client. getActiveProvider/getModelId
// stay real (the real module-global provider switch drives tier selection).
const mockCreate = vi.fn();
const createLLMClientSpy = vi.fn();
const clientForTierSnapshotSpy = vi.fn();
// The partial message the Anthropic SDK's stream holds after its first event; set only by the
// aborted-call tests (the bound reads the provider's prompt count from it).
let mockCurrentMessage: unknown;

const fakeClient = {
  beta: {
    messages: {
      stream: (...args: unknown[]) => ({
        finalMessage: () => mockCreate(...args),
        ...(mockCurrentMessage !== undefined ? { currentMessage: mockCurrentMessage } : {}),
      }),
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
    // Observed, not replaced: the tier swap must not even be consulted for a pinned caller.
    clientForTierSnapshot: (...args: Parameters<typeof actual.clientForTierSnapshot>) => {
      clientForTierSnapshotSpy(...args);
      return actual.clientForTierSnapshot(...args);
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
    clientForTierSnapshotSpy.mockReset();
    mockCurrentMessage = undefined;
    delete process.env['LYNOX_SEARCH_RERANK'];
  });

  afterEach(() => {
    delete process.env['LYNOX_SEARCH_RERANK'];
  });

  it('a profiled caller reranks on its own client with its profile model', async () => {
    mockCreate.mockResolvedValueOnce({ ...(makeScoreResponse([9, 1, 10, 2]) as object), usage: { input_tokens: 800, output_tokens: 120 } });
    const snapshot = {
      provider: 'openai' as const, apiKey: 'test-profile-key', apiBaseURL: 'https://api.mistral.ai/v1',
      openaiModelId: 'ministral-14b-2512', openaiAuth: undefined, modelPinnedByProfile: true,
    };
    const out = await rerankSearchResults('pytrends github', makeResults(), { enabled: true }, snapshot);
    const params = mockCreate.mock.calls[0]![0] as { model: string; betas?: unknown };
    // ONE client — the snapshot's. The fast tier's client swap is not consulted at all.
    expect(createLLMClientSpy).toHaveBeenCalledTimes(1);
    expect(clientForTierSnapshotSpy).not.toHaveBeenCalled();
    // Priced on the model that ran.
    expect(out.costUsd).toBeCloseTo(calculateCost('ministral-14b-2512', { input_tokens: 800, output_tokens: 120 }), 10);
    expect(params.model).toBe('ministral-14b-2512');
    expect(params.betas).toBeUndefined();
    // The client it ran on is the one built from the snapshot.
    expect(createLLMClientSpy).toHaveBeenCalledWith(expect.objectContaining({ apiBaseURL: 'https://api.mistral.ai/v1' }));

    // CONTROL: the same snapshot unpinned reranks on the fast tier, through the swap.
    clientForTierSnapshotSpy.mockClear();
    mockCreate.mockResolvedValueOnce(makeScoreResponse([9, 1, 10, 2]));
    await rerankSearchResults('pytrends github', makeResults(), { enabled: true }, { ...snapshot, modelPinnedByProfile: undefined });
    expect((mockCreate.mock.calls[1]![0] as { model: string }).model).not.toBe('ministral-14b-2512');
    expect(clientForTierSnapshotSpy).toHaveBeenCalledTimes(1);
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

  it('a reply that lost the forced call still surfaces its cost, and is counted by name', async () => {
    // On a model that rejects a forced choice the boundary sends `auto`; a reply without
    // `score_results` arrives as ForcedToolNotCalledError. Its tokens were spent — the cost
    // must reach the call site's debit, not vanish in the catch.
    mockCreate.mockRejectedValueOnce(new ForcedToolNotCalledError(
      'claude-opus-5-5', { type: 'tool', name: 'score_results' },
      { content: [{ type: 'text', text: 'Ranking: 3, 1, 4, 2' }], usage: { input_tokens: 800, output_tokens: 120 } },
    ));
    const before = forcedToolMissCounts()['search-reranker'] ?? 0;
    const out = await rerankSearchResults('pytrends github', makeResults(), { enabled: true });
    expect(out.costUsd).toBeGreaterThan(0);
    expect(forcedToolMissCounts()['search-reranker']).toBe(before + 1);
  });

  // A reply cut off at its output budget carries the forced call with an incomplete
  // input. The miss check counts that as a call, so the cut-off is counted by name —
  // and the skip names it `cut-off`, since its scores are incomplete, not wrong.
  const cutReply = (input: unknown, stopReason: string): unknown => ({
    content: [{ type: 'tool_use', name: 'score_results', input }],
    stop_reason: stopReason,
    usage: { input_tokens: 800, output_tokens: 120 },
  });

  it('a reply cut off at max_tokens still surfaces its cost, and is counted as a cut-off', async () => {
    mockCreate.mockResolvedValueOnce(cutReply({}, 'max_tokens'));
    const before = forcedToolCutOffCounts()['search-reranker'] ?? 0;
    const out = await rerankSearchResults('pytrends github', makeResults(), { enabled: true });
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.skipReason).toBe('cut-off');
    expect(forcedToolCutOffCounts()['search-reranker'] ?? 0).toBe(before + 1);
  });

  it('the same empty reply that stopped on its own is NOT counted as a cut-off', async () => {
    mockCreate.mockResolvedValueOnce(cutReply({}, 'tool_use'));
    const before = forcedToolCutOffCounts()['search-reranker'] ?? 0;
    const out = await rerankSearchResults('pytrends github', makeResults(), { enabled: true });
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.skipReason).toBe('malformed');
    expect(forcedToolCutOffCounts()['search-reranker'] ?? 0).toBe(before);
  });

  it('incomplete scores from a reply cut off at max_tokens skip as `cut-off`', async () => {
    mockCreate.mockResolvedValueOnce(cutReply({ scores: [9, 1] }, 'max_tokens'));
    const results = makeResults();
    const out = await rerankSearchResults('x', results, { enabled: true });
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('cut-off');
  });

  it('the same incomplete scores from a reply that stopped on its own skip as `malformed`', async () => {
    mockCreate.mockResolvedValueOnce(cutReply({ scores: [9, 1] }, 'tool_use'));
    const results = makeResults();
    const out = await rerankSearchResults('x', results, { enabled: true });
    expect(out.results).toEqual(results);
    expect(out.skipReason).toBe('malformed');
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

  // The timeout ABORTS the call now (a race alone left it running and paid for at the
  // provider). The reply never arrives, so there is no `costUsd` for the tenant debit;
  // `abortedCost` carries bounds whose upper one is for the session cap only. Both tests
  // use the same fake stream with the same partial message — only the timeout differs.
  it('a timeout aborts the call and hands back its upper bound, with no billable cost', async () => {
    mockCurrentMessage = { usage: { input_tokens: 600 } };
    mockCreate.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
    const before = abortedCallCounts().notBilled['search-reranker'] ?? 0;
    const results = makeResults();

    const out = await rerankSearchResults('x', results, { enabled: true, timeoutMs: 20 });

    const [params, opt] = mockCreate.mock.calls[0]! as [{ model: string }, { signal?: AbortSignal } | undefined];
    expect(opt?.signal, 'the stream gets a signal').toBeInstanceOf(AbortSignal);
    expect(opt!.signal!.aborted, 'the timeout aborted the request').toBe(true);
    expect(out.skipReason).toBe('timeout');
    expect(out.results).toEqual(results);
    // EXACT: the prompt count from the partial message, the whole output budget.
    expect(out.abortedCost?.upperBoundUsd).toBe(calculateCost(params.model, { input_tokens: 600, output_tokens: 512 }));
    expect(out.abortedCost!.estimateUsd).toBeLessThan(out.abortedCost!.upperBoundUsd);
    expect(out.costUsd, 'nothing for the tenant debit').toBeUndefined();
    expect(abortedCallCounts().notBilled['search-reranker']).toBe(before + 1);
  });

  it('a provider error that is NOT the timeout hands back no aborted cost', async () => {
    mockCurrentMessage = { usage: { input_tokens: 600 } };
    mockCreate.mockRejectedValueOnce(new Error('API down'));
    const before = abortedCallCounts().notBilled['search-reranker'] ?? 0;

    const out = await rerankSearchResults('x', makeResults(), { enabled: true, timeoutMs: 5000 });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(out.skipReason).toBe('llm-error');
    expect(out.abortedCost).toBeUndefined();
    expect(out.costUsd).toBeUndefined();
    expect(abortedCallCounts().notBilled['search-reranker'] ?? 0).toBe(before);
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
