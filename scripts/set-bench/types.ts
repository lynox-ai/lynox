/**
 * Set-Bench Phase 2 — Mistral exploration along two axes:
 *
 *   1. **TOOL_CHAIN** (sonnet-tier work): can this model drive a multi-tool
 *      agent loop end-to-end? Bar = Anthropic Sonnet 4.6. Candidates =
 *      Mistral Large family + Magistral (pinned + latest snapshots).
 *
 *   2. **ORCHESTRATION** (haiku-tier work): can this small/cheap model
 *      replace Haiku for high-volume orchestration (spawn sub-agents to
 *      classify a batch of emails)? Bar = Anthropic Haiku 4.5. Candidates =
 *      Mistral Small + Ministral + open-mistral-nemo.
 *
 * Drift is a first-class concern: every Mistral cell ships in two flavours
 * — pinned dated snapshot (what we recommend) and `*-latest` (what an
 * inattentive operator might wire up). The pass-rate gap surfaces whether
 * Mistral's silent model-roll changes behaviour mid-billing-period.
 */

import type { LLMProvider } from '../../src/types/index.js';

/** Which axis of the lynox routing claim this scenario probes. */
export type SetBenchAxis = 'tool-chain' | 'orchestration';

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
   * Base URL for `openai`-provider cells. Omitted for Anthropic-native.
   * Engine reads it from `userConfig.api_base_url`.
   */
  readonly apiBaseURL?: string;
  /** Env var name to source the API key from at run time. */
  readonly apiKeyEnv: string;
  /** Headline pricing per million tokens — used to compute cell cost. */
  readonly pricing: { inputPerMillion: number; outputPerMillion: number };
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
  readonly scenarioId: string;
  readonly pass: boolean;
  readonly reason?: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly iterations: number;
  readonly finalText: string;
  readonly toolCalls: ToolCallTrace[];
  readonly error?: string;
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
    readonly avgCostUsd: number;
    readonly avgDurationMs: number;
    readonly p50DurationMs: number;
    readonly p95DurationMs: number;
    readonly pinned: boolean;
  }>;
}
