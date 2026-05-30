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
  | 'real-world-grounded-strategy'
  // Closed reasoning axes with a verifiable unique answer (added 2026-05-29).
  // FINDING: these ALSO ceiling — once chain-of-thought is permitted and the
  // answer is extracted correctly (last-match, not first), every model from
  // ministral-3b up solves both. CoT equalises execution-bound reasoning, so
  // closed puzzles can't separate a `deep` tier. Kept as a documented
  // competence floor; the real discriminator is the judge-scored axes below.
  | 'hard-deductive-reasoning'
  | 'multi-hop-quant-chain'
  // Open-ended, judge-scored "deep" axes (added 2026-05-29). Closed puzzles
  // (the two above) ceiling once CoT is permitted — every model from 3b up
  // solves them. The only signal that separated tiers in the full matrix was
  // graded quality on the open-ended real-world-strategy axis. These two
  // lean into that: no binary right answer, a stringent per-scenario rubric,
  // quality 1–5 is the discriminator (passCheck is a sanity gate only).
  | 'deep-strategy-tradeoff'
  | 'deep-ambiguous-design';

export const ALL_AXES: readonly SetBenchAxis[] = [
  'multi-turn-loop-completion',
  'sub-agent-spawn-orchestration',
  'memory-grounded-reasoning',
  'workflow-composition',
  'long-context-with-tools',
  'tool-chain-with-backtrack',
  'cron-task-cold-start',
  'real-world-grounded-strategy',
  'hard-deductive-reasoning',
  'multi-hop-quant-chain',
  'deep-strategy-tradeoff',
  'deep-ambiguous-design',
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
  /**
   * Optional per-scenario replacement for the harness SYSTEM_PREAMBLE. The
   * default preamble says "never narrate your reasoning; output only the final
   * answer" — correct for the structured-output axes, but it SUPPRESSES
   * chain-of-thought on the reasoning axes, which confounds the signal
   * (a strict instruction-follower like large-2512 obeys it, drops CoT, and
   * then fails arithmetic it could otherwise do). Reasoning scenarios set this
   * to a preamble that explicitly permits step-by-step work, so the axis
   * measures reasoning ability, not narrate-despite-the-ban behaviour.
   */
  readonly systemPreambleOverride?: string;
  /**
   * Optional scenario-specific judge rubric (replaces the generic rubric in
   * judge.ts). Open-ended "deep" axes have no binary right answer — the
   * discriminator is graded quality, so they need a STRINGENT, full-range,
   * criteria-anchored rubric (the generic one clusters every answer at
   * 4.5–5.0 and fails to separate tiers). passCheck on these axes is a mere
   * sanity gate (non-empty, plausible length); qualityScore carries the
   * signal, so these MUST be run with --judge.
   */
  readonly judgeRubric?: string;
  /**
   * When true, NO tools are offered to the model for this scenario. The
   * pure-cognition axes (deductive / quant / open-ended analysis) don't need
   * tools, and offering them causes strict tool-users (e.g. sonnet) to loop on
   * mock tools and exhaust maxIterations without ever producing a final answer
   * — polluting the measurement with harness artefacts rather than capability.
   */
  readonly noTools?: boolean;
  /**
   * Per-scenario output token cap (default 2048). The open-ended analysis axes
   * raise this (4096) so a thorough answer isn't truncated and then judged as
   * incomplete — a fairness guard. See CellRun.truncated.
   */
  readonly maxTokens?: number;
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
   * Graded answer-quality 1–5 from the LLM-as-judge PANEL (judge.ts) — the
   * MEAN of the per-family judges, so it may be fractional (e.g. 4.5). Present
   * only when run with `--judge`; undefined = not scored.
   * Complementary to `pass` — never overrides the deterministic gate.
   */
  readonly qualityScore?: number;
  /**
   * Per-judge score keyed by judge id (e.g. anthropic-opus / mistral-large).
   * Powers the cross-family bias report — the spread between these is the
   * fairness signal that a single judge would have hidden.
   */
  readonly qualityByJudge?: Record<string, number>;
  /** Combined judge rationales, or the failure reason when unscored. */
  readonly qualityReason?: string;
  /** Judge-call token usage summed across the panel (0 when --judge disabled). */
  readonly judgeTokensIn?: number;
  readonly judgeTokensOut?: number;
  /**
   * True when the model hit max_tokens before finishing (stop_reason ===
   * 'max_tokens'). Surfaces truncation so a capped verbose answer isn't
   * silently judged as "incomplete" — a fairness guard for the analysis axes.
   */
  readonly truncated?: boolean;
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
    /**
     * Mean graded-quality 1–5 over the SCORED runs of this cell (undefined
     * when no run was judged). `qualityScoredRuns` is the n it averages over,
     * so the report can flag thin samples (e.g. judge errored on most runs).
     */
    readonly avgQualityScore?: number;
    readonly qualityScoredRuns: number;
    /**
     * Mean score this cell received FROM EACH judge, keyed by judge id. The
     * gap between an Anthropic-family cell's anthropic-opus vs mistral-large
     * score (and vice-versa) is the cross-family bias signal.
     */
    readonly qualityByJudge?: Record<string, number>;
  }>;
}
