import type { EffortLevel } from '../../src/types/index.js';

export type ScenarioCategory = 'baseline' | 'extraction' | 'analysis' | 'reasoning' | 'summarization';

export interface BenchScenario {
  readonly id: string;
  readonly category: ScenarioCategory;
  readonly description: string;
  readonly prompt: string;
  readonly judgeRubric: readonly string[];
  readonly referenceAnswer: string;
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
}

export interface BenchConfig {
  readonly label: string;
  readonly tier: 'haiku' | 'sonnet' | 'opus';
  readonly modelId: string;
  readonly effort: EffortLevel | 'none';
  readonly thinking: 'adaptive' | 'disabled';
}

export interface BenchUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
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
}

export interface BenchReport {
  readonly timestamp: string;
  readonly totalRuns: number;
  readonly totalCostUSD: number;
  readonly totalLatencyMs: number;
  readonly runs: readonly JudgedRun[];
}
