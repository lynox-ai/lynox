import type { EffortLevel, LLMProvider } from '../../src/types/index.js';

export type ScenarioCategory = 'baseline' | 'extraction' | 'analysis' | 'reasoning' | 'summarization' | 'tool-chain';

export interface BenchScenario {
  readonly id: string;
  readonly category: ScenarioCategory;
  readonly description: string;
  readonly prompt: string;
  readonly judgeRubric: readonly string[];
  readonly referenceAnswer: string;
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
  /**
   * Optional deterministic pass-check, invoked AFTER judging. For tool-chain
   * scenarios this is where we verify the agent actually called http_request N
   * times in the right order — a 5/5 judge score on a tool-chain scenario is
   * meaningless if the agent fabricated the answer instead of fetching it.
   * Returns null if it can't decide; the run then falls back to judge score >= 3.
   */
  readonly passCheck?: (run: import('./types.js').BenchRun) => boolean | null;
}

/**
 * Provider tier — drives report grouping, NOT the API path itself. The API
 * path is chosen by `provider` + `apiBaseURL`. The two are intentionally
 * decoupled because OpenRouter routes 4 different model families through the
 * same `openai` provider with the same base URL.
 */
export type ProviderTier =
  | 'anthropic-native'
  | 'mistral-native'
  | 'openrouter';

export interface BenchConfig {
  readonly label: string;
  readonly tier: ProviderTier;
  readonly provider: LLMProvider;
  /** Model ID for native providers (Anthropic); ignored when `openaiModelId` is set. */
  readonly modelId: string;
  /** OpenAI-compat base URL — required for `provider='openai'`. */
  readonly apiBaseURL?: string;
  /** OpenAI-compat model ID — OpenRouter slug or Mistral `mistral-large-latest`. */
  readonly openaiModelId?: string;
  /** Env var holding the auth token for this config. Resolved at run time. */
  readonly apiKeyEnv: 'ANTHROPIC_API_KEY' | 'MISTRAL_API_KEY' | 'OPENROUTER_API_KEY';
  readonly effort: EffortLevel | 'none';
  readonly thinking: 'adaptive' | 'disabled';
  /**
   * Pricing in $/M tokens. Required for non-Anthropic configs because
   * `core/pricing.ts::getPricing` falls back to opus rates for unknown
   * model IDs, which would silently inflate non-Anthropic numbers ~5×.
   * Anthropic-native configs can omit this — the runner reads
   * `getPricing(modelId)` instead.
   */
  readonly pricing?: {
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
  };
  /**
   * Provider-specific request-body extras. Forwarded as-is by the
   * OpenAIAdapter, ignored on Anthropic-native paths. Common entries:
   *   - `parallel_tool_calls: false` (Mistral — stops the verbose loop)
   *   - `reasoning_effort: 'high'` (Mistral adjustable-reasoning models)
   *   - `tool_choice: 'any'` (force the agent to pick a tool)
   */
  readonly providerExtras?: Readonly<Record<string, unknown>>;
}

export interface BenchUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly webSearchRequests: number;
}

export interface BenchRun {
  readonly scenarioId: string;
  readonly configLabel: string;
  readonly iteration: number;
  readonly output: string;
  readonly usage: BenchUsage;
  readonly costUSD: number;
  readonly latencyMs: number;
  readonly toolCallCount: number;
  readonly iterationsUsed: number;
  readonly error?: string;
}

export interface JudgedRun extends BenchRun {
  readonly score: number;
  readonly judgeReasoning: string;
  readonly judgeCostUSD: number;
  /**
   * Pass = (no error) AND (no timeout) AND (iterationsUsed <= maxIterations)
   *        AND (scenario.passCheck?.(run) === true || (passCheck null/absent && score >= 3))
   * The single HN-relevant column — answers "did this model actually complete
   * the task" instead of "did this model do well on average".
   */
  readonly passed: boolean;
}

export interface BenchReport {
  readonly timestamp: string;
  readonly totalRuns: number;
  readonly totalCostUSD: number;
  readonly totalLatencyMs: number;
  readonly runs: readonly JudgedRun[];
}
