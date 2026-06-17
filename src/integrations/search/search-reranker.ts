/**
 * Post-provider relevance reranker.
 *
 * Scores search results against the query intent using Haiku and drops
 * low-relevance hits that slipped past the provider. Catches the residual
 * off-topic pattern where e.g. MDN WebGPU docs appear in a "pytrends"
 * search — the provider's lexical ranking can't tell that the result,
 * though it is about "limits", is irrelevant to the user's intent.
 *
 * Opt-in via LYNOX_SEARCH_RERANK=true (default: off) so teams can roll
 * this out gradually and measure impact. Adds one Haiku call per search
 * (~$0.001, ~500-1500ms). Falls back to pass-through on any failure —
 * never blocks or errors the original search.
 *
 * Provider-agnostic: runs on the active provider's 'fast' tier model
 * (Haiku on Anthropic, ministral-8b on Mistral). Skips on: empty/1-item
 * result sets, 'custom' proxies (unknown model catalogue / tool-choice
 * support), LLM call failure, malformed response, timeout.
 */
import type { SearchResult } from './search-provider.js';
import { createLLMClient, getActiveProvider, clientForTierSnapshot } from '../../core/llm-client.js';
import { resolveTierModel } from '../../core/tier-resolver.js';
import type { LLMProvider } from '../../types/index.js';
import type { ProviderConfigSnapshot } from '../../types/agent.js';

export interface RerankOptions {
  /** Score threshold 0-10 for keeping a result. Default: 4. */
  threshold?: number;
  /** Timeout for the Haiku call in ms. Default: 5000. */
  timeoutMs?: number;
  /** Explicit enable flag. If undefined, reads LYNOX_SEARCH_RERANK env var. */
  enabled?: boolean;
}

export interface RerankOutcome {
  results: SearchResult[];
  droppedCount: number;
  meanScore: number | null;
  skipReason?: 'disabled' | 'too-few-results' | 'provider-unsupported' | 'timeout' | 'llm-error' | 'malformed';
  durationMs: number;
}

const DEFAULT_THRESHOLD = 4;
const DEFAULT_TIMEOUT_MS = 5000;

const SCORE_TOOL = {
  name: 'score_results',
  description: 'Return a relevance score (0-10) for each search result against the query.',
  input_schema: {
    type: 'object' as const,
    properties: {
      scores: {
        type: 'array',
        items: { type: 'number' },
        description: 'One score per result in the same order as the input list. 0=off-topic, 4=tangential, 7=relevant, 10=highly specific match.',
      },
    },
    required: ['scores'],
  },
};

const SYSTEM_PROMPT = `You are a strict search result relevance scorer.

Given a query and a list of search results (title + snippet), score each result 0-10 for how well it matches the query's INTENT, not just topical overlap:
- 0  = totally off-topic or irrelevant (e.g. a WebGPU docs page for a "pytrends rate limits" query)
- 1-3 = same broad topic, but doesn't help answer the query
- 4-6 = tangentially useful
- 7-8 = clearly relevant
- 9-10 = directly answers the query or is the authoritative source

Be strict. Prefer dropping tangential results over keeping noise.`;

function isEnabled(opts: RerankOptions): boolean {
  if (opts.enabled !== undefined) return opts.enabled;
  const envVal = process.env['LYNOX_SEARCH_RERANK'];
  return envVal === 'true' || envVal === '1';
}

/**
 * Why this capability surface exists: the toggle/env-var decision happens
 * server-side at search time. Without this, users who flip
 * LYNOX_SEARCH_RERANK=true on a 'custom' proxy get a silent no-op
 * (skipReason: 'provider-unsupported' in the outcome, but outcomes aren't
 * surfaced in the UI). The capability snapshot is read at request time so it
 * always reflects the live provider — no DB row, no settings flag, no
 * migration needed.
 */
export interface RerankerCapability {
  supported: boolean;
  enabled: boolean;
  provider: LLMProvider;
  /** Stable machine-readable reason. Present when supported=false OR enabled=false. */
  reason?: 'provider-unsupported' | 'disabled-by-env';
}

export function getRerankerCapability(): RerankerCapability {
  const provider = getActiveProvider();
  const envVal = process.env['LYNOX_SEARCH_RERANK'];
  const enabled = envVal === 'true' || envVal === '1';

  // Provider-capability mirror of the runtime guard in rerankSearchResults().
  // Keep these in lockstep. 'openai' (Mistral) is supported — it reranks on its
  // own 'fast' tier model. Only opaque 'custom' proxies stay unsupported.
  if (provider === 'custom') {
    return { supported: false, enabled, provider, reason: 'provider-unsupported' };
  }
  if (!enabled) {
    return { supported: true, enabled: false, provider, reason: 'disabled-by-env' };
  }
  return { supported: true, enabled: true, provider };
}

export async function rerankSearchResults(
  query: string,
  results: SearchResult[],
  opts: RerankOptions = {},
  providerConfig?: ProviderConfigSnapshot,
): Promise<RerankOutcome> {
  const start = Date.now();
  const base = (extra: Partial<RerankOutcome>): RerankOutcome => ({
    results,
    droppedCount: 0,
    meanScore: null,
    durationMs: Date.now() - start,
    ...extra,
  });

  // Effective provider: prefer the per-call snapshot (managed multi-tenant /
  // sub-agent inheritance) and fall back to the process-global active provider.
  const provider = providerConfig?.provider ?? getActiveProvider();

  if (!isEnabled(opts)) return base({ skipReason: 'disabled' });
  if (results.length < 2) return base({ skipReason: 'too-few-results' });
  // 'openai' (Mistral) reranks on its own 'fast' tier model. Only 'custom'
  // proxies — unknown model catalogue and tool-choice support — still skip.
  if (provider === 'custom') return base({ skipReason: 'provider-unsupported' });
  // openai has no global key/baseURL fallback in createLLMClient, so without a
  // provider snapshot we can't authenticate — skip rather than fire a doomed
  // empty-client call. Prod callers (web-search-tool) always thread the agent
  // snapshot, so this only guards bare/partial callers.
  if (provider === 'openai' && !providerConfig) return base({ skipReason: 'provider-unsupported' });

  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const resultList = results
    .map((r, i) => `${i + 1}. "${r.title}" (${r.url}) — ${r.snippet.slice(0, 300)}`)
    .join('\n');

  try {
    // Provider-aware client: on 'openai' (Mistral) createLLMClient has NO
    // global fallback for key/baseURL/model, so we MUST pass the resolved
    // snapshot from the calling agent — otherwise the adapter authenticates
    // with an empty key and 401s. Without a snapshot (callers that don't
    // thread one) we fall back to the env-based Anthropic client.
    const client = providerConfig
      ? createLLMClient({
          provider: providerConfig.provider,
          apiKey: providerConfig.apiKey,
          apiBaseURL: providerConfig.apiBaseURL,
          openaiModelId: providerConfig.openaiModelId,
          openaiAuth: providerConfig.openaiAuth,
        })
      : createLLMClient();
    // The OpenAIAdapter implements only `beta.messages.stream` (not `.create`);
    // stream().finalMessage() works for both the Anthropic SDK and the adapter,
    // so use it uniformly. betas are an Anthropic-only concept — omit on openai.
    const fast = resolveTierModel('fast', provider);
    const fastClient = clientForTierSnapshot(fast, client, provider);
    const callPromise = fastClient.beta.messages.stream({
      model: fast.modelId,
      max_tokens: 512,
      ...(fast.betas ? { betas: fast.betas } : {}),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Query: "${query}"\n\nResults:\n${resultList}` }],
      tools: [SCORE_TOOL],
      tool_choice: { type: 'tool', name: 'score_results' },
    }).finalMessage();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('rerank-timeout')), timeoutMs),
    );
    const response = await Promise.race([callPromise, timeoutPromise]);

    let scores: number[] | null = null;
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'score_results') {
        const input = block.input as { scores?: unknown };
        if (Array.isArray(input.scores) && input.scores.every(s => typeof s === 'number')) {
          scores = input.scores as number[];
          break;
        }
      }
    }

    if (!scores || scores.length !== results.length) {
      return base({ skipReason: 'malformed' });
    }

    const kept = results.filter((_, i) => (scores![i] ?? 0) >= threshold);
    // Sort kept results by Haiku score, highest first.
    const withScores = kept
      .map(r => {
        const origIdx = results.indexOf(r);
        return { r, score: scores![origIdx] ?? 0 };
      })
      .sort((a, b) => b.score - a.score)
      .map(x => x.r);

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

    return {
      results: withScores,
      droppedCount: results.length - withScores.length,
      meanScore: mean,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const reason = err instanceof Error && err.message === 'rerank-timeout'
      ? 'timeout' as const
      : 'llm-error' as const;
    return base({ skipReason: reason });
  }
}
