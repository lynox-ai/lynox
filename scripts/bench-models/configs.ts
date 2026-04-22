import type { BenchConfig } from './types.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const OPUS_46 = 'claude-opus-4-6';
const OPUS_47 = 'claude-opus-4-7';

/** Phase 1 config matrix: 3 models × 2 effort levels = 6 configs. */
export const PHASE_1_CONFIGS: readonly BenchConfig[] = [
  { label: 'haiku',           tier: 'haiku',  modelId: HAIKU,   effort: 'none',   thinking: 'disabled' },
  { label: 'sonnet-medium',   tier: 'sonnet', modelId: SONNET,  effort: 'medium', thinking: 'adaptive' },
  { label: 'sonnet-high',     tier: 'sonnet', modelId: SONNET,  effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-medium',     tier: 'opus',   modelId: OPUS_46, effort: 'medium', thinking: 'adaptive' },
  { label: 'opus-high',       tier: 'opus',   modelId: OPUS_46, effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-max',        tier: 'opus',   modelId: OPUS_46, effort: 'max',    thinking: 'adaptive' },
];

/**
 * Phase 2 matrix: Opus 4.7 with xhigh effort, targeting scenarios Phase 1
 * didn't cover (tool use, long context, agent orchestration, creative).
 */
export const PHASE_2_CONFIGS: readonly BenchConfig[] = [
  { label: 'haiku',           tier: 'haiku',  modelId: HAIKU,   effort: 'none',   thinking: 'disabled' },
  { label: 'sonnet-high',     tier: 'sonnet', modelId: SONNET,  effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-47-high',    tier: 'opus',   modelId: OPUS_47, effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-47-xhigh',   tier: 'opus',   modelId: OPUS_47, effort: 'xhigh',  thinking: 'adaptive' },
];

/**
 * Phase 3 matrix: opus-47-high dropped (strictly dominated by xhigh per Phase 2).
 * Focus on the 3 non-dominated configs for the final Managed-Opus decision.
 */
export const PHASE_3_CONFIGS: readonly BenchConfig[] = [
  { label: 'haiku',           tier: 'haiku',  modelId: HAIKU,   effort: 'none',   thinking: 'disabled' },
  { label: 'sonnet-high',     tier: 'sonnet', modelId: SONNET,  effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-47-xhigh',   tier: 'opus',   modelId: OPUS_47, effort: 'xhigh',  thinking: 'adaptive' },
];

/** Smoke-test config: single cheapest run to validate infra. */
export const SMOKE_CONFIG: BenchConfig = PHASE_1_CONFIGS[0]!;

export function getConfig(label: string): BenchConfig | undefined {
  return PHASE_1_CONFIGS.find(c => c.label === label)
      ?? PHASE_2_CONFIGS.find(c => c.label === label)
      ?? PHASE_3_CONFIGS.find(c => c.label === label);
}
