/**
 * Set-Bench v4 — lynox-real-world agent axes shipped on lynox.ai/bench
 * 2026-05-23. Each scenario maps to one of the 8 axes the page describes;
 * the harness runs the agent loop (Anthropic SDK / OpenAIAdapter + a
 * deterministic set of mock tools) and checks the final output + tool-call
 * trace against a regex-pinned ground truth.
 *
 * Drift is a first-class concern: every Mistral cell ships in two
 * flavours — pinned dated snapshot (what we recommend) and `*-latest`
 * (what an inattentive operator might wire up). The pass-rate gap
 * surfaces whether Mistral's silent model-roll changes behaviour
 * mid-billing-period.
 *
 * Cache treatment: Anthropic's `cache_read_input_tokens` +
 * `cache_creation_input_tokens` are read from `usage` and used to compute
 * warm-effective cost. Mistral exposes no native cache field; warm cost
 * equals cold cost for those cells (the report flags this explicitly so a
 * reader doesn't misinterpret "0% cache hit" as a model failure).
 */

import type { LLMProvider } from '../../src/types/index.js';

/**
 * The 8 lynox-real-world axes documented on lynox.ai/bench.
 * Each is a multi-turn agent loop with a deterministic pass/fail check.
 */
export type SetBenchAxis =
  | 'multi-turn-loop-completion'
  | 'sub-agent-spawn-orchestration'
  | 'memory-grounded-reasoning'
  | 'workflow-composition'
  | 'long-context-with-tools'
  | 'tool-chain-with-backtrack'
  | 'cron-task-cold-start'
  | 'real-world-grounded-strategy';

export const ALL_AXES: readonly SetBenchAxis[] = [
  'multi-turn-loop-completion',
  'sub-agent-spawn-orchestration',
  'memory-grounded-reasoning',
  'workflow-composition',
  'long-context-with-tools',
  'tool-chain-with-backtrack',
  'cron-task-cold-start',
  'real-world-grounded-strategy',
];

export interface SetBenchScenario {
  readonly id: string;
  readonly axis: SetBenchAxis;
  readonly description: string;
  /** Prompt sent verbatim to the agent. Deterministic — no time-varying data. */
  readonly prompt: string;
  /**
   * Deterministic pass-check on the final agent output. Returns true when
   * the answer matches the scenario's known-good value (extracted by a
   * scenario-specific regex). No LLM-judging — we want regression-grade
   * signal, not a fuzzy "good enough" score.
   */
  readonly passCheck: (finalText: string, toolCalls: ToolCallTrace[]) => PassResult;
  /** Max agent-loop iterations before we time out the run. */
  readonly maxIterations: number;
  /** Per-cell wall-clock budget (ms). */
  readonly timeoutMs: number;
  /**
   * Optional inline-context the harness prepends to the system prompt
   * (e.g. an arXiv paper body for the long-context axis). Kept separate
   * from `prompt` so cache analysis can attribute "cacheable system block"
   * tokens vs "user turn" tokens accurately.
   */
  readonly inlineContext?: string;
  /**
   * Optional pre-prompt hook for seeding mock-tool state (e.g. memory-
   * grounded-reasoning seeds a "thread A already stored X" entry before
   * the agent prompt fires). Called after `resetMockState()`, before the
   * first model turn.
   */
  readonly setup?: () => void;
}

export interface PassResult {
  readonly pass: boolean;
  /** One-line failure reason for the report. */
  readonly reason?: string;
}

export interface ToolCallTrace {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
}

/**
 * A single model under test. Multiple cells often share a `provider` +
 * `apiBaseURL` and differ only in `modelId` / pricing — they're separate
 * cells because the bench measures per-model behaviour, not per-provider.
 */
export interface SetBenchCell {
  readonly label: string;
  readonly axis: SetBenchAxis;
  readonly provider: LLMProvider;
  /** The model id sent in `params.model` to the API. */
  readonly modelId: string;
  /**
   * Base URL for `openai`-provider cells. Omitted for Anthropic-native and
   * Mistral-native (Mistral uses the openai-compat adapter pointed at
   * api.mistral.ai/v1).
   */
  readonly apiBaseURL?: string;
  /** Env var name to source the API key from at run time. */
  readonly apiKeyEnv: string;
  /** Headline pricing per million tokens — used to compute cell cost. */
  readonly pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    /**
     * Optional per-million rates for prompt cache. Defaults: cacheRead =
     * 10% of input, cacheWrite = 125% of input (Anthropic's published
     * multipliers). Cells override when the provider differs.
     */
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
  };
  /**
   * Tag the cell as a `*-latest` alias vs a pinned dated snapshot.
   * Powers the pinned-vs-latest drift report.
   */
  readonly pinned: boolean;
  /** Per-cell provider-extras passed straight through to the API body. */
  readonly providerExtras?: Record<string, unknown>;
}

export interface CellRun {
  readonly cellLabel: string;
  readonly axis: SetBenchAxis;
  readonly scenarioId: string;
  readonly pass: boolean;
  readonly reason?: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /**
   * Anthropic-native: `usage.cache_read_input_tokens` (tokens served from
   * the prompt cache, billed at the cache-read rate). Mistral / openai-
   * compat without cache: 0.
   */
  readonly cacheReadTokens: number;
  /**
   * Anthropic-native: `usage.cache_creation_input_tokens` (tokens written
   * to the prompt cache, billed at the cache-write rate). 0 elsewhere.
   */
  readonly cacheCreationTokens: number;
  /** Cost computed cold (no cache discount applied). */
  readonly costUsdCold: number;
  /** Cost computed warm (cache_read tokens billed at cache-read rate). */
  readonly costUsdWarm: number;
  readonly durationMs: number;
  readonly iterations: number;
  readonly finalText: string;
  readonly toolCalls: ToolCallTrace[];
  readonly error?: string;
  /**
   * True when the run explicitly routed `prompt_cache_key` to the provider
   * (currently: openai-provider cells targeting api.mistral.ai). False for
   * Anthropic-native cells (which use `cache_control` block markers instead)
   * and for cells where cache-key routing is intentionally omitted (e.g.
   * smoke-bucket cells that reject the field). Surfaces the §4.5 mixed-
   * coverage distinction on the bench page.
   */
  readonly routedCacheKey: boolean;
}

export interface BenchReport {
  readonly generatedAt: string;
  readonly cells: readonly CellRun[];
  /**
   * Per-axis × per-cell summary, derived from `cells`. p50/p95 latency
   * surfaces tail behaviour that the average hides — e.g. Mistral cells
   * sometimes burst-throttle the first run and stabilise on retry, which
   * shows up as a small p50 with a much larger p95.
   */
  readonly summary: ReadonlyArray<{
    readonly axis: SetBenchAxis;
    readonly cellLabel: string;
    readonly passRate: number;
    readonly avgCostColdUsd: number;
    readonly avgCostWarmUsd: number;
    readonly avgCacheReadTokens: number;
    readonly cacheHitRate: number;
    readonly avgDurationMs: number;
    readonly p50DurationMs: number;
    readonly p95DurationMs: number;
    readonly pinned: boolean;
  }>;
}
