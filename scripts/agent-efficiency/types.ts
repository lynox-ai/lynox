/**
 * Shared types for the Agent-Efficiency measurement protocol.
 *
 * Phase 0 of `pro/docs/internal/PRD-AGENT-EFFICIENCY.md` §6 — the
 * staging-`usage` protocol. These shapes are the contract between the
 * scenario definitions, the runner, the artifact writers and the
 * `--compare` gate.
 */

/** A measurement scenario, possibly a single turn of a multi-turn thread. */
export interface Scenario {
  /** Stable id used in artifacts + `--compare` matching. */
  readonly id: string;
  /** Human label for the markdown table. */
  readonly label: string;
  /** PRD §2 evidence row this scenario reproduces. */
  readonly evidenceRow: string;
  /**
   * Threads are grouped by `threadKey`. Scenarios sharing a `threadKey`
   * run sequentially in the SAME engine thread, in array order, so a
   * follow-up turn sees the prior turn's context (and warm/cold cache).
   */
  readonly threadKey: string;
  /** Plain-language task text sent as the `/run` body `task`. */
  readonly prompt: string;
  /** What a good answer looks like — drives the manual quality judgement. */
  readonly qualityRubric: string;
  /**
   * Set when the scenario knowingly reproduces a degraded/broken path
   * (e.g. the broken promote flow, or a tool-heavy turn that cannot be
   * reproduced with full fidelity). Surfaced in both artifacts.
   */
  readonly fidelityCaveat?: string;
  /** Per-turn wall-clock cap. The workflow-build turn needs minutes. */
  readonly timeoutMs: number;
}

/** Per-turn token + cost rollup, read from the engine's `usage` projection. */
export interface TurnUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheWrite: number;
  readonly costUsd: number;
  /** Model tier id stamped by the engine, when available. */
  readonly model?: string;
}

/** Result of one execution of one scenario (one of the n repeats). */
export interface TurnRun {
  readonly scenarioId: string;
  /** 1-based repeat index. */
  readonly iteration: number;
  /** `true` when the turn completed and a usage signal was read. */
  readonly ok: boolean;
  /** Set when `ok === false`. */
  readonly error?: string;
  /** Per-turn usage. Zeroed when `ok === false`. */
  readonly usage: TurnUsage;
  /** Cache-hit ratio = cacheRead / (cacheRead + cacheWrite); 0 when no cache I/O. */
  readonly cacheHitRatio: number;
  /** Wall time for the `/run` SSE stream, ms. */
  readonly wallMs: number;
  /** The assistant's final text — kept for the quality judgement. */
  readonly finalText: string;
}

/** Aggregate of the n repeats of one scenario. */
export interface ScenarioResult {
  readonly scenarioId: string;
  readonly label: string;
  readonly evidenceRow: string;
  readonly fidelityCaveat?: string;
  readonly qualityRubric: string;
  /** Every individual repeat, failures included. */
  readonly runs: readonly TurnRun[];
  /** How many of the n repeats produced a trustworthy signal. */
  readonly okCount: number;
  /** Total repeats attempted. */
  readonly totalCount: number;
  /** Mean + spread across the OK repeats only. Undefined when okCount === 0. */
  readonly stats?: ScenarioStats;
}

/** A scalar's mean + spread across the OK repeats. */
export interface MetricStat {
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  /** Sample standard deviation; 0 for n < 2. */
  readonly stddev: number;
}

/** Per-scenario aggregate metrics across the OK repeats. */
export interface ScenarioStats {
  readonly costUsd: MetricStat;
  readonly tokensIn: MetricStat;
  readonly tokensOut: MetricStat;
  readonly tokensCacheRead: MetricStat;
  readonly tokensCacheWrite: MetricStat;
  readonly cacheHitRatio: MetricStat;
  readonly wallMs: MetricStat;
}

/** The full machine-readable baseline artifact. */
export interface Baseline {
  /** ISO-8601 capture timestamp; also the artifact filename stem. */
  readonly capturedAt: string;
  /** Engine the protocol ran against. */
  readonly target: string;
  /** Engine `build_sha` from `/api/health` — pins the baseline to a build. */
  readonly buildSha: string;
  /** Engine version string. */
  readonly version: string;
  /** Repeats per scenario. */
  readonly iterations: number;
  /** Sum of `costUsd` mean across all scenarios — the headline number. */
  readonly totalMeanCostUsd: number;
  readonly scenarios: readonly ScenarioResult[];
}

/** One row of the `--compare` diff table. */
export interface CompareRow {
  readonly scenarioId: string;
  readonly label: string;
  /** Baseline mean cost. Undefined when the baseline lacked an OK signal. */
  readonly baselineCostUsd?: number;
  /** Current run mean cost. Undefined when the current run lacked an OK signal. */
  readonly currentCostUsd?: number;
  /** (current - baseline) / baseline, fraction; undefined when either side missing. */
  readonly costDeltaPct?: number;
  /** current tokensIn mean minus baseline tokensIn mean; undefined when either side missing. */
  readonly tokenDelta?: number;
  /** Baseline OK-rate = okCount / totalCount. */
  readonly baselinePassRate: number;
  /** Current OK-rate = okCount / totalCount. */
  readonly currentPassRate: number;
  /**
   * D3 gate verdict for this scenario:
   *   pass  — pass-rate >= baseline AND cost < baseline
   *   fail  — gate violated
   *   n/a   — no comparable signal on one side
   */
  readonly verdict: 'pass' | 'fail' | 'n/a';
}
